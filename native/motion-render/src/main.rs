//! motion-render: renders motion-use films natively. The film's drawing code (a JS `drawFrame` on a
//! Canvas 2D) runs in V8; the canvas is Skia on the CPU, so the same input gives the same pixels on
//! every run. Frames leave as raw RGBA: straight into ffmpeg, as .rgba files, or as fast PNGs for
//! motion-use's external-engine job contract.
mod canvas;
mod js;
mod page;
mod schedule;
mod shape;
mod style;
mod text;
mod webgl;

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
      [--stream <path|->] [--workers <n>] [--stats]

Text check (motion-use's probe, run in this page's V8):
  motion-render probe <index.html> --times <t,t,...|times.json>   prints the probe's JSON

Options:
  --workers <n>   at most n workers, each with its own V8 isolate and Skia canvases. It starts at
                  the performance cores, adds one while the frame rate rises 5%, and remembers the
                  count per page (~/.cache/motion-render/workers.json); MOTION_RENDER_ADAPT=0 uses
                  exactly n. Processes when the page asks for WebGL on the GPU (ANGLE's GPU
                  backends do not scale across the threads of one process), else threads;
                  MOTION_RENDER_PROCESSES=0|1 overrides
  --format        png (fast zlib level, default) or rgba (raw straight RGBA, w*h*4 bytes per frame)
  --ffmpeg <mp4>  pipe raw RGBA into ffmpeg (libx264, yuv420p, bt709, motion-use's settings)
  --stream <path> write raw straight RGBA frames in order to a file or FIFO (- is stdout), for an
                  encoder the caller runs (motion-use); a job does the same with
                  \"formats\": [\"rgba-stream\"], \"stream\": <path>
  --stats         print timing JSON on stdout (stderr when frames go to stdout)
  --gl <backend>  WebGL backend: auto (default: the GPU, else SwiftShader), gpu, metal, vulkan,
                  swiftshader (CPU, same pixels as Chrome's software GL), d3d11, off; same as
                  MOTION_RENDER_GL. WebGL runs on ANGLE, found next to this binary, in
                  MOTION_RENDER_ANGLE_DIR or ~/.cache/motion-render/angle (native/scripts/fetch-angle.sh)
  --capabilities  print what this build can do as JSON (motion-use checks it); \"webgl\" says
                  whether ANGLE loaded and made a context on this machine
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
    stream: Option<String>,
    workers: usize,
    stats: bool,
    /// The command line, for worker processes
    argv: Vec<String>,
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

/// Whether `workers` run as processes (MOTION_RENDER_GL `gl`, MOTION_RENDER_PROCESSES `force`,
/// `webgl`: the page asks for a WebGL context). ANGLE's GPU backends do not scale across the
/// threads of one process (Apple M5 Pro, Metal: a three.js film 45 ms/frame on 1 thread, 318 on
/// 2; a raymarched WebGL2 terrain 115 and 227), while processes, one display each, do (14 and
/// 47 ms/frame on 8). A 2D page stays on threads, which skip the pipe (1.3 against 1.6 ms/frame),
/// and so do SwiftShader and no WebGL.
fn use_processes(gl: Option<&str>, force: Option<&str>, webgl: bool, workers: usize) -> bool {
    match force.map(str::trim) {
        Some("0") => return false,
        Some("1") => return workers > 1,
        _ => {}
    }
    let gl = gl.unwrap_or_default().trim().to_ascii_lowercase();
    workers > 1 && webgl && !matches!(gl.as_str(), "swiftshader" | "cpu" | "software" | "off" | "none")
}

/// Whether a script names a WebGL context type as a string ("webgl2", 'webgl', three.js's
/// `let D="webgl2"`), the way getContext is asked for one.
fn asks_for_webgl(code: &str) -> bool {
    ["webgl", "webgl2", "experimental-webgl"].iter().any(|n| ['"', '\'', '`'].iter().any(|q| code.contains(&format!("{q}{n}{q}"))))
}

/// Render `times` on up to `plan.workers` workers (schedule.rs): threads, or processes when WebGL
/// may run on the GPU (use_processes). Frames come back in order to ffmpeg or the stream.
fn run(plan: Plan) -> Result<Value> {
    let len = plan.times.len();
    let max = plan.workers.max(1).min(len.max(1));
    let webgl = plan.page.scripts.iter().any(|s| asks_for_webgl(&s.code));
    let procs = use_processes(std::env::var("MOTION_RENDER_GL").ok().as_deref(), std::env::var("MOTION_RENDER_PROCESSES").ok().as_deref(), webgl, max);
    // MOTION_RENDER_ADAPT=0: exactly --workers, no climbing
    let adapt = std::env::var("MOTION_RENDER_ADAPT").map(|v| v.trim() != "0").unwrap_or(true);
    let t0 = Instant::now();
    let want_frames = plan.ffmpeg.is_some() || plan.stream.is_some();
    // frames in flight past the next one out: a slow worker's frame can trail this far
    let window = 4 * max + 4;
    let disp = Arc::new(schedule::Dispenser::new(len, if want_frames { window } else { len }, max));
    // a film rendered here before starts at the count its climb found (per version: a new
    // renderer measures again)
    let key = format!("{}|{}|{}", env!("CARGO_PKG_VERSION"), plan.page.base.display(), if procs { "processes" } else { "threads" });
    let known = if adapt { schedule::remembered(&key) } else { None };
    let mut climb = match known {
        Some(n) => schedule::Climb::new(n.min(max), max, false),
        None => schedule::Climb::new(if adapt { schedule::start_workers() } else { max }, max, adapt),
    };
    let (tx, rx) = mpsc::channel::<schedule::Done>();
    let page = Arc::new(plan.page.clone());
    let times = Arc::new(plan.times.clone());
    let spawn = |id: usize| {
        if procs {
            schedule::spawn_process(&plan.argv, id, want_frames, disp.clone(), tx.clone())
        } else {
            schedule::spawn_thread(&plan, page.clone(), times.clone(), id, want_frames, disp.clone(), tx.clone())
        }
    };
    let mut handles = vec![];
    for id in 0..climb.active {
        handles.push(spawn(id)?);
    }
    let mut out = Output::new(&plan);
    let mut pending: std::collections::BTreeMap<usize, (i32, i32, Vec<u8>)> = Default::default();
    let (mut next_out, mut done) = (0usize, 0usize);
    let mut error = None;
    while done < len {
        let (id, i, w, h, frame) = match rx.recv() {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => {
                error = Some(e);
                break;
            }
            Err(_) => {
                error = Some(anyhow!("the render workers stopped"));
                break;
            }
        };
        done += 1;
        match climb.frame(id, done) {
            schedule::Step::Add => match spawn(climb.active - 1) {
                Ok(h) => handles.push(h),
                Err(e) => {
                    // no more workers here: keep rendering on the ones running
                    eprintln!("motion-render: staying at {} workers: {:#}", climb.active - 1, e);
                    climb.give_up();
                    disp.set_allowed(climb.active);
                }
            },
            schedule::Step::Retire => disp.set_allowed(climb.active),
            schedule::Step::Keep => {}
        }
        if !want_frames {
            continue;
        }
        pending.insert(i, (w, h, frame));
        while let Some((w, h, frame)) = pending.remove(&next_out) {
            if let Err(e) = out.write(next_out, w, h, &frame) {
                error = Some(e);
                break;
            }
            next_out += 1;
        }
        if error.is_some() {
            break;
        }
        disp.set_limit(next_out + window);
    }
    if error.is_some() {
        disp.stop();
    }
    drop(tx);
    drop(rx);
    let encode_ms = out.encode_ms;
    if let Err(e) = out.finish() {
        error.get_or_insert(e);
    }
    let mut timings = vec![];
    for h in handles {
        match h.join() {
            Ok(Ok(t)) => timings.push(t),
            Ok(Err(e)) => {
                error.get_or_insert(e);
            }
            Err(_) => {
                error.get_or_insert(anyhow!("a render worker panicked"));
            }
        }
    }
    if let Some(e) = error {
        return Err(e);
    }
    // a short range is too few frames to trust (and the machine may have been busy)
    if climb.found && done >= 300 {
        schedule::remember(&key, climb.active);
    }
    let wall = t0.elapsed().as_secs_f64() * 1000.0;
    let frames: usize = timings.iter().map(|t| t.frames).sum();
    let draw: f64 = timings.iter().map(|t| t.draw_ms).sum();
    let write: f64 = timings.iter().map(|t| t.write_ms).sum();
    let setup = timings.iter().map(|t| t.setup_ms).fold(0.0, f64::max);
    Ok(json!({
        "frames": frames,
        "workers": climb.active,
        "workers_max": max,
        "workers_started": timings.len(),
        "workers_remembered": known.is_some(),
        "processes": procs,
        "wall_ms": wall,
        "setup_ms": setup,
        "draw_ms_per_frame": if frames > 0 { draw / frames as f64 } else { 0.0 },
        "write_ms_per_frame": if frames > 0 { write / frames as f64 } else { 0.0 },
        "wall_ms_per_frame": if frames > 0 { (wall - setup) / frames as f64 } else { 0.0 },
        "encode_wait_ms": encode_ms,
    }))
}

/// Where frames go in order: the --stream target (a file, FIFO or stdout) or ffmpeg, opened on
/// the first frame: a FIFO's open blocks until its reader (the caller's encoder) is there.
struct Output {
    stream: Option<String>,
    ffmpeg: Option<(PathBuf, String, f64)>,
    sink: Option<Box<dyn Write>>,
    child: Option<std::process::Child>,
    encode_ms: f64,
}

impl Output {
    fn new(plan: &Plan) -> Output {
        Output { stream: plan.stream.clone(), ffmpeg: plan.ffmpeg.clone(), sink: None, child: None, encode_ms: 0.0 }
    }

    fn write(&mut self, i: usize, w: i32, h: i32, frame: &[u8]) -> Result<()> {
        if let Some(target) = &self.stream {
            if self.sink.is_none() {
                self.sink = Some(if target == "-" {
                    schedule::raw_stdout()
                } else {
                    Box::new(std::fs::OpenOptions::new().write(true).open(target).with_context(|| format!("opening stream {}", target))?)
                });
            }
            let e0 = Instant::now();
            self.sink.as_mut().unwrap().write_all(frame).map_err(|e| anyhow!("writing frame {} to the stream: {} (did the encoder stop?)", i, e))?;
            self.encode_ms += e0.elapsed().as_secs_f64() * 1000.0;
        } else if let Some((out, quality, fps)) = &self.ffmpeg {
            if self.child.is_none() {
                let (preset, crf) = x264(quality);
                self.child = Some(
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
            self.child.as_mut().unwrap().stdin.as_mut().unwrap().write_all(frame).context("writing to ffmpeg")?;
            self.encode_ms += e0.elapsed().as_secs_f64() * 1000.0;
        }
        Ok(())
    }

    fn finish(mut self) -> Result<()> {
        if let Some(mut s) = self.sink.take() {
            s.flush().map_err(|e| anyhow!("flushing the stream: {}", e))?;
        }
        if let Some(mut c) = self.child.take() {
            drop(c.stdin.take());
            let st = c.wait()?;
            if !st.success() {
                bail!("ffmpeg exited with {}", st);
            }
        }
        Ok(())
    }
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
    // --gl <backend> is MOTION_RENDER_GL (auto, gpu, metal, vulkan, swiftshader, d3d11, off), set
    // before any thread starts
    if let Some(k) = args.iter().position(|a| a == "--gl") {
        let v = args.get(k + 1).ok_or_else(|| anyhow!("--gl needs a value"))?;
        std::env::set_var("MOTION_RENDER_GL", v);
    }
    if args.iter().any(|a| a == "--capabilities") {
        // webgl: whether ANGLE loads and makes a context here (motion-use routes WebGL films by it)
        let gl = webgl::probe();
        let mut caps = json!({"version": env!("CARGO_PKG_VERSION"), "canvas2d": true, "webgl": gl.is_ok(), "stream": true, "probe": true, "job_stream": true, "footage": true});
        match gl {
            Ok((backend, dir)) => caps["gl"] = json!({"backend": backend, "angle": dir}),
            Err(e) => caps["webgl_error"] = json!(e),
        }
        println!("{}", caps);
        return Ok(());
    }
    let mut opts: std::collections::HashMap<String, String> = Default::default();
    let mut flags: std::collections::HashSet<String> = Default::default();
    let mut pos: Vec<String> = vec![];
    let mut i = 0;
    let valued = ["--gl", "--job", "--at", "--frames", "--fps", "--out", "--format", "--ffmpeg", "--quality", "--workers", "--size", "--stream", "--times"];
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
    // --serve: a worker process of another motion-render (schedule.rs)
    let serve = flags.contains("--serve");
    let job_path = opts.get("--job").cloned().or_else(|| std::env::var("MOTION_USE_JOB").ok());

    if pos.first().map(|s| s.as_str()) == Some("probe") {
        let html = PathBuf::from(pos.get(1).ok_or_else(|| anyhow!("probe needs a page (index.html)"))?);
        let spec = opts.get("--times").ok_or_else(|| anyhow!("probe needs --times <t,t,...|times.json>"))?;
        let times: Vec<f64> = if spec.ends_with(".json") {
            serde_json::from_str(&std::fs::read_to_string(spec).with_context(|| format!("reading {}", spec))?)?
        } else {
            spec.split(',').filter(|t| !t.trim().is_empty()).map(|t| t.trim().parse::<f64>()).collect::<std::result::Result<_, _>>()?
        };
        let page = page::load_html(&html)?;
        let mut engine = Engine::new(&page, Mode::Film, None)?;
        engine.setup(None)?;
        let out = engine.text_probe(&serde_json::to_string(&times)?)?;
        println!("{}", out);
        return Ok(());
    }

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
            stream: opts.get("--stream").cloned(),
            workers,
            stats,
            argv: args.clone(),
        };
        if serve {
            // stdout carries the frames; the parent reads the stats from stderr
            eprintln!("{}", schedule::serve(plan)?);
            return Ok(());
        }
        let stats_on = plan.stats;
        let to_stdout = plan.stream.as_deref() == Some("-");
        let r = run(plan)?;
        if stats_on {
            if to_stdout {
                eprintln!("{}", r);
            } else {
                println!("{}", r);
            }
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
    // motion-use offers a raw stream (a FIFO it encodes from) next to the PNG sequence.
    let job_stream = job["stream"].as_str().filter(|_| job["formats"].as_array().map(|f| f.iter().any(|x| x == "rgba-stream")).unwrap_or(false)).map(String::from);
    let format = opts.get("--format").map(|s| s.as_str()).unwrap_or("png");
    let sink = if job_stream.is_some() {
        Sink::None
    } else if format == "rgba" {
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
        stream: job_stream,
        // --workers, else the job's (a parallel engine gets motion-use's --workers), else the cores
        workers: if opts.contains_key("--workers") {
            workers
        } else if let Some(w) = job["workers"].as_u64() {
            w.max(1) as usize
        } else {
            std::thread::available_parallelism().map(|n| n.get().min(8)).unwrap_or(4)
        },
        stats,
        argv: args.clone(),
    };
    if serve {
        // a worker process: frames to its parent on stdout (not job.stream, the parent's FIFO),
        // stats on stderr
        let to_parent = plan.stream.is_some();
        let plan = Plan { stream: to_parent.then(|| "-".to_string()), ..plan };
        eprintln!("{}", schedule::serve(plan)?);
        return Ok(());
    }
    let r = run(plan)?;
    eprintln!("motion-render: {} frames ({}–{}) in {:.0} ms, {:.1} ms/frame wall, {} workers", r["frames"], from, to, r["wall_ms"].as_f64().unwrap_or(0.0), r["wall_ms_per_frame"].as_f64().unwrap_or(0.0), r["workers"]);
    if stats {
        println!("{}", r);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{asks_for_webgl, use_processes};

    #[test]
    fn webgl_on_the_gpu_uses_processes() {
        for gl in [None, Some(""), Some(" Auto "), Some("gpu"), Some("metal"), Some("vulkan"), Some("d3d11")] {
            assert!(use_processes(gl, None, true, 8), "{gl:?}");
            assert!(!use_processes(gl, None, true, 1), "{gl:?}");
            assert!(!use_processes(gl, None, false, 8), "{gl:?}");
        }
        for gl in ["swiftshader", "cpu", "software", "off", "none"] {
            assert!(!use_processes(Some(gl), None, true, 8), "{gl}");
        }
        assert!(!use_processes(None, Some("0"), true, 8));
        assert!(use_processes(Some("swiftshader"), Some("1"), false, 8));
        assert!(!use_processes(Some("swiftshader"), Some("1"), false, 1));
    }

    #[test]
    fn webgl_pages_are_recognised() {
        assert!(asks_for_webgl(r#"c.getContext("webgl2", {antialias: false})"#));
        assert!(asks_for_webgl("N===null){let D=\"webgl2\";if(N=We(D"));
        assert!(asks_for_webgl("getContext('experimental-webgl')"));
        assert!(!asks_for_webgl("// A WebGL author can draw its offscreen renderer into ctx"));
        assert!(!asks_for_webgl(r#"c.getContext("2d")"#));
    }
}
