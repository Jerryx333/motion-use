//! motion-render: renders motion-use films natively. The film's drawing code (a JS `drawFrame` on a
//! Canvas 2D) runs in V8; the canvas is Skia on the CPU, so the same input gives the same pixels on
//! every run. Frames leave as raw RGBA: straight into ffmpeg, as .rgba files, or as fast PNGs for
//! motion-use's external-engine job contract.
mod canvas;
mod js;
mod page;
mod shape;
mod style;
mod text;

use anyhow::{anyhow, bail, Context, Result};
use js::{Engine, Mode};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Instant;

const USAGE: &str = "motion-render — native renderer for motion-use films (Skia + V8)

As a motion-use external engine (film.json):
  \"engine\": {\"type\": \"command\", \"command\": [\"motion-render\", \"composition/draw.js\"]}
  motion-render [<draw.js> | <engine.html>] --job <job.json>   (or MOTION_USE_JOB=<job.json>)
    writes frames.from..frames.to as PNG into job.out (drop `composition` from film.json when the
    drawing runs here, or motion-use draws it again as an overlay)

Render a built page directly (motion-use's out/.build/<id>/index.html, or an engine page):
  motion-render render <index.html> [--engine --job <job.json>]
      (--at <t,t,...> | --frames <a-b>) [--fps <n>]
      [--out <dir> --format png|rgba] [--ffmpeg <out.mp4> --quality draft|looks|delivery]
      [--workers <n>] [--stats]

Options:
  --workers <n>   render on n threads, each with its own V8 isolate and Skia canvases
  --format        png (fast zlib level, default) or rgba (raw straight RGBA, w*h*4 bytes per frame)
  --ffmpeg <mp4>  pipe raw RGBA into ffmpeg (libx264, yuv420p, bt709, motion-use's settings)
  --stats         print timing JSON on stdout
";

#[derive(Clone)]
enum Sink {
    None,
    Png { dir: PathBuf, names: Arc<Vec<String>> },
    Rgba { dir: PathBuf, names: Arc<Vec<String>> },
}

struct Plan {
    page: page::Page,
    mode: Mode,
    job: Option<String>,
    size: Option<(i32, i32)>,
    times: Vec<f64>,
    sink: Sink,
    ffmpeg: Option<(PathBuf, String, f64)>,
    workers: usize,
    stats: bool,
}

#[derive(Default, Clone, Copy)]
struct Timing {
    setup_ms: f64,
    draw_ms: f64,
    write_ms: f64,
    frames: usize,
}

fn write_png(path: &Path, w: i32, h: i32, rgba: &[u8]) -> Result<()> {
    let f = std::fs::File::create(path).with_context(|| format!("writing {}", path.display()))?;
    let mut enc = png::Encoder::new(std::io::BufWriter::with_capacity(1 << 20, f), w as u32, h as u32);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.set_compression(png::Compression::Fast);
    enc.set_filter(png::FilterType::Sub);
    enc.set_adaptive_filter(png::AdaptiveFilterType::NonAdaptive);
    let mut wr = enc.write_header()?;
    wr.write_image_data(rgba)?;
    wr.finish()?;
    Ok(())
}

fn x264(quality: &str) -> (&'static str, &'static str) {
    match quality {
        "draft" => ("veryfast", "23"),
        "delivery" => ("slow", "14"),
        _ => ("medium", "16"),
    }
}

/// Render `times` across workers. Worker k takes frames k, k+n, k+2n…; with ffmpeg the main
/// thread pulls them back in order through one small queue per worker.
fn run(plan: Plan) -> Result<Value> {
    let n = plan.workers.max(1).min(plan.times.len().max(1));
    let t0 = Instant::now();
    let page = Arc::new(plan.page);
    let times = Arc::new(plan.times);
    let want_frames = plan.ffmpeg.is_some();
    let mut handles = vec![];
    let mut receivers = vec![];
    for k in 0..n {
        let (tx, rx) = mpsc::sync_channel::<Result<(usize, i32, i32, Vec<u8>)>>(3);
        receivers.push(rx);
        let page = page.clone();
        let times = times.clone();
        let sink = plan.sink.clone();
        let job = plan.job.clone();
        let mode = plan.mode;
        let size = plan.size;
        handles.push(
            std::thread::Builder::new()
                .name(format!("render-{}", k))
                .stack_size(16 << 20)
                .spawn(move || -> Result<Timing> {
                    let mut tm = Timing::default();
                    let s0 = Instant::now();
                    let setup = (|| -> Result<Engine> {
                        let mut e = Engine::new(&page, mode, size)?;
                        e.setup(job.as_deref())?;
                        Ok(e)
                    })();
                    let mut engine = match setup {
                        Ok(e) => e,
                        Err(e) => {
                            let msg = format!("{:#}", e);
                            let _ = tx.send(Err(anyhow!("{}", msg)));
                            bail!("{}", msg);
                        }
                    };
                    tm.setup_ms = s0.elapsed().as_secs_f64() * 1000.0;
                    let mut buf = Vec::new();
                    let mut i = k;
                    while i < times.len() {
                        let d0 = Instant::now();
                        let (w, h) = match engine.render(times[i], &mut buf) {
                            Ok(v) => v,
                            Err(e) => {
                                let msg = format!("{:#}", e);
                                let _ = tx.send(Err(anyhow!("{}", msg)));
                                bail!("{}", msg);
                            }
                        };
                        tm.draw_ms += d0.elapsed().as_secs_f64() * 1000.0;
                        let w0 = Instant::now();
                        match &sink {
                            Sink::Png { dir, names } => write_png(&dir.join(&names[i]), w, h, &buf)?,
                            Sink::Rgba { dir, names } => std::fs::write(dir.join(&names[i]), &buf)?,
                            Sink::None => {}
                        }
                        tm.write_ms += w0.elapsed().as_secs_f64() * 1000.0;
                        tm.frames += 1;
                        if want_frames {
                            let frame = std::mem::take(&mut buf);
                            if tx.send(Ok((i, w, h, frame))).is_err() {
                                break;
                            }
                        }
                        i += n;
                    }
                    Ok(tm)
                })?,
        );
    }
    let mut encode_ms = 0.0;
    let mut ff_error = None;
    if let Some((out, quality, fps)) = &plan.ffmpeg {
        let mut child: Option<std::process::Child> = None;
        for i in 0..times.len() {
            let msg = receivers[i % n].recv();
            let (_, w, h, frame) = match msg {
                Ok(Ok(v)) => v,
                Ok(Err(e)) => {
                    ff_error = Some(e);
                    break;
                }
                Err(_) => {
                    ff_error = Some(anyhow!("a render worker stopped"));
                    break;
                }
            };
            if child.is_none() {
                let (preset, crf) = x264(quality);
                child = Some(
                    std::process::Command::new("ffmpeg")
                        .args(["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", &format!("{}x{}", w, h), "-framerate", &fps.to_string(), "-i", "-"])
                        .args(["-vf", "scale=out_color_matrix=bt709,format=yuv420p", "-c:v", "libx264", "-preset", preset, "-crf", crf])
                        .args(["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-movflags", "+faststart"])
                        .arg(out)
                        .stdin(std::process::Stdio::piped())
                        .spawn()
                        .context("starting ffmpeg")?,
                );
            }
            let e0 = Instant::now();
            child.as_mut().unwrap().stdin.as_mut().unwrap().write_all(&frame).context("writing to ffmpeg")?;
            encode_ms += e0.elapsed().as_secs_f64() * 1000.0;
        }
        if let Some(mut c) = child {
            drop(c.stdin.take());
            let e0 = Instant::now();
            let st = c.wait()?;
            encode_ms += e0.elapsed().as_secs_f64() * 1000.0;
            if !st.success() && ff_error.is_none() {
                ff_error = Some(anyhow!("ffmpeg exited with {}", st));
            }
        }
    } else {
        // drain errors
        for rx in &receivers {
            if let Ok(Err(e)) = rx.try_recv() {
                ff_error = Some(e);
            }
        }
    }
    drop(receivers);
    let mut timings = vec![];
    for h in handles {
        match h.join() {
            Ok(Ok(t)) => timings.push(t),
            Ok(Err(e)) => {
                if ff_error.is_none() {
                    ff_error = Some(e);
                }
            }
            Err(_) => {
                if ff_error.is_none() {
                    ff_error = Some(anyhow!("a render worker panicked"));
                }
            }
        }
    }
    if let Some(e) = ff_error {
        return Err(e);
    }
    let wall = t0.elapsed().as_secs_f64() * 1000.0;
    let frames: usize = timings.iter().map(|t| t.frames).sum();
    let draw: f64 = timings.iter().map(|t| t.draw_ms).sum();
    let write: f64 = timings.iter().map(|t| t.write_ms).sum();
    let setup = timings.iter().map(|t| t.setup_ms).fold(0.0, f64::max);
    Ok(json!({
        "frames": frames,
        "workers": n,
        "wall_ms": wall,
        "setup_ms": setup,
        "draw_ms_per_frame": if frames > 0 { draw / frames as f64 } else { 0.0 },
        "write_ms_per_frame": if frames > 0 { write / frames as f64 } else { 0.0 },
        "wall_ms_per_frame": if frames > 0 { (wall - setup) / frames as f64 } else { 0.0 },
        "encode_wait_ms": encode_ms,
    }))
}

fn parse_range(s: &str) -> Result<(i64, i64)> {
    let (a, b) = s.split_once('-').ok_or_else(|| anyhow!("--frames takes a-b"))?;
    Ok((a.trim().parse()?, b.trim().parse()?))
}

/// The film config a page carries (#film-config), for fps.
fn page_fps(page: &page::Page) -> Option<f64> {
    let cfg = page.elements.iter().find(|e| e.id == "film-config")?;
    let v: Value = serde_json::from_str(&cfg.text).ok()?;
    v["fps"].as_f64()
}

fn main() {
    if let Err(e) = real_main() {
        eprintln!("motion-render: {:#}", e);
        std::process::exit(1);
    }
}

fn real_main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "-h" || a == "--help") || args.is_empty() && std::env::var("MOTION_USE_JOB").is_err() {
        print!("{}", USAGE);
        return Ok(());
    }
    if args.iter().any(|a| a == "--version") {
        println!("motion-render {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let mut opts: std::collections::HashMap<String, String> = Default::default();
    let mut flags: std::collections::HashSet<String> = Default::default();
    let mut pos: Vec<String> = vec![];
    let mut i = 0;
    let valued = ["--job", "--at", "--frames", "--fps", "--out", "--format", "--ffmpeg", "--quality", "--workers", "--size"];
    while i < args.len() {
        let a = &args[i];
        if valued.contains(&a.as_str()) {
            let v = args.get(i + 1).ok_or_else(|| anyhow!("{} needs a value", a))?;
            opts.insert(a.clone(), v.clone());
            i += 2;
        } else if a.starts_with("--") {
            flags.insert(a.clone());
            i += 1;
        } else {
            pos.push(a.clone());
            i += 1;
        }
    }
    let workers: usize = opts.get("--workers").map(|w| w.parse()).transpose()?.unwrap_or(1);
    let stats = flags.contains("--stats");
    let job_path = opts.get("--job").cloned().or_else(|| std::env::var("MOTION_USE_JOB").ok());

    if pos.first().map(|s| s.as_str()) == Some("render") {
        let html = PathBuf::from(pos.get(1).ok_or_else(|| anyhow!("render needs a page (index.html)"))?);
        let engine = flags.contains("--engine");
        let page = page::load_html(&html)?;
        let job: Option<Value> = job_path.as_ref().map(|p| -> Result<Value> { Ok(serde_json::from_str(&std::fs::read_to_string(p)?)?) }).transpose()?;
        let fps = opts.get("--fps").map(|f| f.parse::<f64>()).transpose()?.or_else(|| page_fps(&page)).or_else(|| job.as_ref().and_then(|j| j["fps"].as_f64())).unwrap_or(30.0);
        let (times, names): (Vec<f64>, Vec<String>) = if let Some(at) = opts.get("--at") {
            let ts: Vec<f64> = at.split(',').map(|t| t.trim().parse::<f64>()).collect::<std::result::Result<_, _>>()?;
            let names = (0..ts.len()).map(|i| format!("{:05}", i)).collect();
            (ts, names)
        } else if let Some(r) = opts.get("--frames") {
            let (a, b) = parse_range(r)?;
            ((a..=b).map(|k| k as f64 / fps).collect(), (a..=b).map(|k| format!("{:05}", k)).collect())
        } else {
            bail!("render needs --at or --frames");
        };
        let format = opts.get("--format").map(|s| s.as_str()).unwrap_or("png");
        let sink = match opts.get("--out") {
            Some(dir) => {
                std::fs::create_dir_all(dir)?;
                let ext = if format == "rgba" { "rgba" } else { "png" };
                let names = Arc::new(names.iter().map(|n| format!("{}.{}", n, ext)).collect());
                if format == "rgba" {
                    Sink::Rgba { dir: dir.into(), names }
                } else {
                    Sink::Png { dir: dir.into(), names }
                }
            }
            None => Sink::None,
        };
        let size = job.as_ref().and_then(|j| Some((j["width"].as_i64()? as i32, j["height"].as_i64()? as i32)));
        let plan = Plan {
            page,
            mode: if engine { Mode::Engine } else { Mode::Film },
            job: job.as_ref().map(|j| j.to_string()),
            size,
            times,
            sink,
            ffmpeg: opts.get("--ffmpeg").map(|o| (PathBuf::from(o), opts.get("--quality").cloned().unwrap_or("looks".into()), fps)),
            workers,
            stats,
        };
        let stats_on = plan.stats;
        let r = run(plan)?;
        if stats_on {
            println!("{}", r);
        }
        return Ok(());
    }

    // ------------------------------------------------------------ external-engine job contract
    let job_path = job_path.ok_or_else(|| anyhow!("no job: pass --job <job.json> or set MOTION_USE_JOB"))?;
    let job: Value = serde_json::from_str(&std::fs::read_to_string(&job_path).with_context(|| format!("reading {}", job_path))?)?;
    let fps = job["fps"].as_f64().ok_or_else(|| anyhow!("job.fps missing"))?;
    let from = job["frames"]["from"].as_i64().ok_or_else(|| anyhow!("job.frames.from missing"))?;
    let to = job["frames"]["to"].as_i64().ok_or_else(|| anyhow!("job.frames.to missing"))?;
    let out = PathBuf::from(job["out"].as_str().ok_or_else(|| anyhow!("job.out missing"))?);
    std::fs::create_dir_all(&out)?;
    let pattern = job["pattern"].as_str().unwrap_or("%05d.png");
    if pattern != "%05d.png" {
        bail!("unsupported job pattern {} (expected %05d.png)", pattern);
    }
    let src = pos.first().ok_or_else(|| anyhow!("name the drawing: motion-render composition/draw.js --job <job.json> (or an engine .html page)"))?;
    let src_path = {
        let p = PathBuf::from(src);
        if p.is_absolute() {
            p
        } else {
            PathBuf::from(job["film"]["dir"].as_str().unwrap_or(".")).join(p)
        }
    };
    let (page, mode) = if src.ends_with(".html") { (page::load_html(&src_path)?, Mode::Engine) } else { (page::from_job(&job, &src_path)?, Mode::Film) };
    let names = Arc::new((from..=to).map(|k| format!("{:05}.png", k)).collect::<Vec<_>>());
    let format = opts.get("--format").map(|s| s.as_str()).unwrap_or("png");
    let sink = if format == "rgba" {
        Sink::Rgba { dir: out.clone(), names: Arc::new(names.iter().map(|n| n.replace(".png", ".rgba")).collect()) }
    } else {
        Sink::Png { dir: out.clone(), names }
    };
    let size = Some((job["width"].as_i64().unwrap_or(1920) as i32, job["height"].as_i64().unwrap_or(1080) as i32));
    let plan = Plan {
        page,
        mode,
        job: Some(job.to_string()),
        size,
        times: (from..=to).map(|k| k as f64 / fps).collect(),
        sink,
        ffmpeg: None,
        workers: if opts.contains_key("--workers") { workers } else { std::thread::available_parallelism().map(|n| n.get().min(8)).unwrap_or(4) },
        stats,
    };
    let r = run(plan)?;
    eprintln!("motion-render: {} frames ({}–{}) in {:.0} ms, {:.1} ms/frame wall, {} workers", r["frames"], from, to, r["wall_ms"].as_f64().unwrap_or(0.0), r["wall_ms_per_frame"].as_f64().unwrap_or(0.0), r["workers"]);
    if stats {
        println!("{}", r);
    }
    Ok(())
}
