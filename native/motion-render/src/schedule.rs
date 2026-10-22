//! Frames to workers on demand, back in order. A worker (a thread, or a process serving frame
//! indices on stdin) takes the next frame when it is free, so a fast core draws more frames than a
//! slow one (Apple silicon mixes both) and no worker holds the others up. The main thread keeps a
//! small reorder window and, from the machine's performance-core count, grows the worker count
//! while the measured frame rate still rises, so each machine and film settles on its own count,
//! at most --workers.
use crate::js::Engine;
use crate::{write_png, Plan, Sink, Timing};
use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use std::collections::VecDeque;
use std::io::{BufRead, Read, Write};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::Instant;

/// A drawn frame from worker `.0`: frame index, width, height, RGBA (empty when not wanted).
pub type Done = Result<(usize, usize, i32, i32, Vec<u8>)>;

struct DState {
    next: usize,
    /// frames below this index may be handed out (the reorder window)
    limit: usize,
    /// workers with an id below this keep taking frames
    allowed: usize,
    stop: bool,
}

/// Hands out frame indices 0..len.
pub struct Dispenser {
    len: usize,
    st: Mutex<DState>,
    cv: Condvar,
}

impl Dispenser {
    pub fn new(len: usize, limit: usize, allowed: usize) -> Dispenser {
        Dispenser { len, st: Mutex::new(DState { next: 0, limit, allowed, stop: false }), cv: Condvar::new() }
    }

    /// The next frame for worker `id`, waiting for the window to move; None when there are no
    /// more frames for it (all handed out, the run stopped, or the worker was retired).
    pub fn take(&self, id: usize) -> Option<usize> {
        let mut s = self.st.lock().unwrap();
        loop {
            if s.stop || id >= s.allowed || s.next >= self.len {
                return None;
            }
            if s.next < s.limit {
                s.next += 1;
                return Some(s.next - 1);
            }
            s = self.cv.wait(s).unwrap();
        }
    }

    /// Like take, without waiting: Err(()) when the window is full for now.
    pub fn try_take(&self, id: usize) -> std::result::Result<Option<usize>, ()> {
        let mut s = self.st.lock().unwrap();
        if s.stop || id >= s.allowed || s.next >= self.len {
            return Ok(None);
        }
        if s.next < s.limit {
            s.next += 1;
            return Ok(Some(s.next - 1));
        }
        Err(())
    }

    fn set(&self, f: impl FnOnce(&mut DState)) {
        f(&mut self.st.lock().unwrap());
        self.cv.notify_all();
    }
    pub fn set_limit(&self, limit: usize) {
        self.set(|s| s.limit = s.limit.max(limit));
    }
    pub fn set_allowed(&self, allowed: usize) {
        self.set(|s| s.allowed = allowed);
    }
    pub fn stop(&self) {
        self.set(|s| s.stop = true);
    }
}

/// Grows the worker count while it pays. After the newest worker's first frame, the frame rate
/// over a window of frames is compared with the rate before it joined: 5% faster keeps it and
/// tries one more; otherwise it is retired and the count stays.
pub struct Climb {
    pub active: usize,
    max: usize,
    settled: bool,
    /// settled by measuring (worth remembering), not by a limit
    pub found: bool,
    best: Option<f64>,
    /// the window: started when the newest worker drew its first frame
    mark: Option<(Instant, usize)>,
    waiting_for: Option<usize>,
}

pub enum Step {
    Keep,
    Add,
    Retire,
}

impl Climb {
    pub fn new(start: usize, max: usize, adapt: bool) -> Climb {
        let active = start.clamp(1, max.max(1));
        Climb { active, max, settled: !adapt || active >= max, found: false, best: None, mark: None, waiting_for: Some(active - 1) }
    }

    /// The newest worker could not start: settle on the ones before it, without remembering.
    pub fn give_up(&mut self) {
        self.active -= 1;
        self.settled = true;
        self.found = false;
    }

    /// A frame came back from `worker`; `done` frames so far.
    pub fn frame(&mut self, worker: usize, done: usize) -> Step {
        if self.settled {
            return Step::Keep;
        }
        if self.waiting_for == Some(worker) {
            self.waiting_for = None;
            self.mark = Some((Instant::now(), done));
            return Step::Keep;
        }
        let Some((t, d)) = self.mark else { return Step::Keep };
        let frames = done - d;
        let secs = t.elapsed().as_secs_f64();
        if frames < (3 * self.active).max(12) || secs < 0.4 {
            return Step::Keep;
        }
        let rate = frames as f64 / secs;
        match self.best {
            Some(b) if rate < b * 1.05 => {
                self.settled = true;
                self.found = true;
                self.active -= 1;
                Step::Retire
            }
            _ => {
                self.best = Some(rate);
                if self.active >= self.max {
                    self.settled = true;
                    self.found = true;
                    return Step::Keep;
                }
                self.active += 1;
                self.mark = None;
                self.waiting_for = Some(self.active - 1);
                Step::Add
            }
        }
    }
}

/// Where the climb starts: the machine's performance cores (Apple silicon: hw.perflevel0, the
/// big cores; elsewhere half the logical CPUs, one per core with SMT), at least 2.
pub fn start_workers() -> usize {
    let logical = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    perf_cores().unwrap_or(logical / 2).max(2)
}

#[cfg(target_os = "macos")]
fn perf_cores() -> Option<usize> {
    extern "C" {
        fn sysctlbyname(name: *const std::ffi::c_char, old: *mut std::ffi::c_void, oldlen: *mut usize, new: *mut std::ffi::c_void, newlen: usize) -> i32;
    }
    let (mut v, mut len) = (0i32, std::mem::size_of::<i32>());
    let ok = unsafe { sysctlbyname(c"hw.perflevel0.physicalcpu".as_ptr(), &mut v as *mut i32 as *mut _, &mut len, std::ptr::null_mut(), 0) } == 0;
    (ok && v > 0).then_some(v as usize)
}

#[cfg(not(target_os = "macos"))]
fn perf_cores() -> Option<usize> {
    None
}

/// The worker counts found per film page and worker kind on this machine
/// (~/.cache/motion-render/workers.json): a film rendered again starts at its count, no climb.
fn cache_file() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(std::path::PathBuf::from(home).join(".cache/motion-render/workers.json"))
}

pub fn remembered(key: &str) -> Option<usize> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(cache_file()?).ok()?).ok()?;
    v[key].as_u64().map(|n| n as usize).filter(|&n| n > 0)
}

pub fn remember(key: &str, workers: usize) {
    let Some(f) = cache_file() else { return };
    let mut v: Value = std::fs::read_to_string(&f).ok().and_then(|s| serde_json::from_str(&s).ok()).filter(Value::is_object).unwrap_or_else(|| serde_json::json!({}));
    v[key] = serde_json::json!(workers);
    // another render may write at the same time: whole file, then rename
    let tmp = f.with_extension(format!("{}.tmp", std::process::id()));
    if f.parent().map(std::fs::create_dir_all).transpose().is_ok() && std::fs::write(&tmp, v.to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, &f);
    }
}

/// Worker thread `id`: its own V8 isolate and canvases, frames from `disp`.
pub fn spawn_thread(plan: &Plan, page: Arc<crate::page::Page>, times: Arc<Vec<f64>>, id: usize, want_frames: bool, disp: Arc<Dispenser>, tx: mpsc::Sender<Done>) -> Result<std::thread::JoinHandle<Result<Timing>>> {
    let (sink, job, mode, size) = (plan.sink.clone(), plan.job.clone(), plan.mode, plan.size);
    Ok(std::thread::Builder::new().name(format!("render-{}", id)).stack_size(16 << 20).spawn(move || -> Result<Timing> {
        let mut tm = Timing::default();
        let s0 = Instant::now();
        let mut engine = match Engine::new(&page, mode, size).and_then(|mut e| e.setup(job.as_deref()).map(|_| e)) {
            Ok(e) => e,
            Err(e) => {
                let msg = format!("{:#}", e);
                let _ = tx.send(Err(anyhow!("{}", msg)));
                return Err(anyhow!("{}", msg));
            }
        };
        tm.setup_ms = s0.elapsed().as_secs_f64() * 1000.0;
        let mut buf = Vec::new();
        while let Some(i) = disp.take(id) {
            let d0 = Instant::now();
            let (w, h) = match engine.render(times[i], &mut buf) {
                Ok(v) => v,
                Err(e) => {
                    let msg = format!("{:#}", e);
                    let _ = tx.send(Err(anyhow!("{}", msg)));
                    return Err(anyhow!("{}", msg));
                }
            };
            tm.draw_ms += d0.elapsed().as_secs_f64() * 1000.0;
            let w0 = Instant::now();
            write_sink(&sink, i, w, h, &buf)?;
            tm.write_ms += w0.elapsed().as_secs_f64() * 1000.0;
            tm.frames += 1;
            let frame = if want_frames { std::mem::take(&mut buf) } else { vec![] };
            if tx.send(Ok((id, i, w, h, frame))).is_err() {
                break;
            }
        }
        Ok(tm)
    })?)
}

fn write_sink(sink: &Sink, i: usize, w: i32, h: i32, buf: &[u8]) -> Result<()> {
    match sink {
        Sink::Png { dir, names } => write_png(&dir.join(&names[i]), w, h, buf),
        Sink::Rgba { dir, names } => std::fs::write(dir.join(&names[i]), buf).map_err(Into::into),
        Sink::None => Ok(()),
    }
}

/// The command line for a worker process: this one with one thread, serving frame indices from
/// stdin (--serve), frames back on stdout when the caller wants them, else into the same --out.
pub fn serve_args(argv: &[String], want_frames: bool) -> Vec<String> {
    let mut out = vec![];
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--workers" | "--ffmpeg" | "--quality" | "--stream" => i += 2,
            "--stats" | "--serve" => i += 1,
            a => {
                out.push(a.to_string());
                i += 1;
            }
        }
    }
    out.extend(["--workers".into(), "1".into(), "--serve".into(), "--stats".into()]);
    if want_frames {
        out.extend(["--stream".into(), "-".into()]);
    }
    out
}

/// Worker process `id`: a thread here feeds it frame indices from `disp`, two ahead, and reads its
/// frames back. Returns the process's timing (its stats line on stderr) or its error.
pub fn spawn_process(argv: &[String], id: usize, want_frames: bool, disp: Arc<Dispenser>, tx: mpsc::Sender<Done>) -> Result<std::thread::JoinHandle<Result<Timing>>> {
    let exe = std::env::current_exe().context("finding motion-render for its worker processes")?;
    let mut child = std::process::Command::new(exe)
        .args(serve_args(argv, want_frames))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("starting a render process")?;
    let mut stdin = Some(child.stdin.take().unwrap());
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    // the last stderr line is the stats JSON; the rest is passed on once the process ends, or
    // becomes this run's error
    let errs = std::thread::spawn(move || {
        let (mut text, mut stats) = (String::new(), None);
        for line in std::io::BufReader::new(stderr).lines().map_while(|l| l.ok()) {
            match serde_json::from_str::<Value>(&line) {
                Ok(v) if v.is_object() => stats = Some(v),
                _ => {
                    text.push_str(line.trim_start_matches("motion-render: "));
                    text.push('\n');
                }
            }
        }
        (text, stats)
    });
    Ok(std::thread::Builder::new().name(format!("render-proc-{}", id)).spawn(move || -> Result<Timing> {
        let mut rd = std::io::BufReader::with_capacity(1 << 20, stdout);
        let mut inflight: VecDeque<usize> = VecDeque::new();
        let mut broken = false;
        loop {
            // keep two frames queued in the process; wait for the window only with none queued,
            // since the frame it waits for may be the one queued here
            while inflight.len() < 2 && stdin.is_some() {
                let next = if inflight.is_empty() { disp.take(id) } else { disp.try_take(id).unwrap_or(None) };
                match next {
                    Some(i) => {
                        let s = stdin.as_mut().unwrap();
                        if writeln!(s, "{}", i).and_then(|_| s.flush()).is_err() {
                            broken = true;
                            break;
                        }
                        inflight.push_back(i);
                    }
                    None => {
                        if inflight.is_empty() {
                            stdin = None;
                        }
                        break;
                    }
                }
            }
            let Some(&want) = inflight.front() else { break };
            if broken {
                break;
            }
            let mut head = [0u8; 12];
            if rd.read_exact(&mut head).is_err() {
                broken = true;
                break;
            }
            let num = |k: usize| u32::from_le_bytes(head[k..k + 4].try_into().unwrap());
            let (i, w, h) = (num(0) as usize, num(4) as i32, num(8) as i32);
            let mut frame = vec![];
            if want_frames {
                frame = vec![0u8; (w as usize) * (h as usize) * 4];
                if rd.read_exact(&mut frame).is_err() {
                    broken = true;
                    break;
                }
            }
            if i != want {
                let _ = child.kill();
                let e = anyhow!("render process {} sent frame {} for {}", id + 1, i, want);
                let _ = tx.send(Err(anyhow!("{:#}", e)));
                return Err(e);
            }
            inflight.pop_front();
            if tx.send(Ok((id, i, w, h, frame))).is_err() {
                // the caller stopped (its encoder failed)
                let _ = child.kill();
                break;
            }
        }
        drop(stdin);
        let st = child.wait()?;
        let (text, stats) = errs.join().unwrap_or_default();
        if !st.success() || broken {
            let _ = child.kill();
            let why = if text.trim().is_empty() { format!("exited with {}", st) } else { text.trim().to_string() };
            let e = anyhow!("render process {}: {}", id + 1, why);
            let _ = tx.send(Err(anyhow!("{:#}", e)));
            return Err(e);
        }
        if !text.is_empty() {
            eprint!("{}", text);
        }
        let s = stats.unwrap_or_default();
        let f = |key: &str| s[key].as_f64().unwrap_or(0.0);
        let frames = s["frames"].as_u64().unwrap_or(0) as usize;
        Ok(Timing { setup_ms: f("setup_ms"), draw_ms: f("draw_ms_per_frame") * frames as f64, write_ms: f("write_ms_per_frame") * frames as f64, frames })
    })?)
}

/// Standard output for raw frames. Rust's stdout is line-buffered: every 8 MB frame was scanned
/// backwards for a newline and copied again (memrchr + memmove on the thread that writes frames
/// out in order). On Unix this writes to descriptor 1 directly.
pub fn raw_stdout() -> Box<dyn Write> {
    #[cfg(unix)]
    {
        use std::os::fd::FromRawFd;
        struct Fd1(std::mem::ManuallyDrop<std::fs::File>);
        impl Write for Fd1 {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.write(b)
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        // ManuallyDrop: descriptor 1 stays open for the rest of the process
        Box::new(Fd1(std::mem::ManuallyDrop::new(unsafe { std::fs::File::from_raw_fd(1) })))
    }
    #[cfg(not(unix))]
    {
        Box::new(std::io::BufWriter::with_capacity(1 << 20, std::io::stdout().lock()))
    }
}

/// A worker process's loop (--serve): frame indices in on stdin, one per line; per frame, out on
/// stdout `[index, width, height]` as little-endian u32 and the RGBA when frames go to the caller.
pub fn serve(plan: Plan) -> Result<Value> {
    let want_frames = plan.stream.is_some();
    let mut tm = Timing::default();
    let s0 = Instant::now();
    let mut engine = Engine::new(&plan.page, plan.mode, plan.size)?;
    engine.setup(plan.job.as_deref())?;
    tm.setup_ms = s0.elapsed().as_secs_f64() * 1000.0;
    let mut out = raw_stdout();
    let mut buf = Vec::new();
    for line in std::io::stdin().lock().lines() {
        let line = line?;
        let i: usize = line.trim().parse().with_context(|| format!("frame index {:?}", line))?;
        let t = *plan.times.get(i).ok_or_else(|| anyhow!("no frame {}", i))?;
        let d0 = Instant::now();
        let (w, h) = engine.render(t, &mut buf)?;
        tm.draw_ms += d0.elapsed().as_secs_f64() * 1000.0;
        let w0 = Instant::now();
        write_sink(&plan.sink, i, w, h, &buf)?;
        tm.write_ms += w0.elapsed().as_secs_f64() * 1000.0;
        tm.frames += 1;
        out.write_all(&[(i as u32).to_le_bytes(), (w as u32).to_le_bytes(), (h as u32).to_le_bytes()].concat())?;
        if want_frames {
            out.write_all(&buf)?;
        }
        out.flush()?;
    }
    let f = tm.frames.max(1) as f64;
    Ok(serde_json::json!({ "frames": tm.frames, "setup_ms": tm.setup_ms, "draw_ms_per_frame": tm.draw_ms / f, "write_ms_per_frame": tm.write_ms / f }))
}

#[cfg(test)]
mod tests {
    use super::{serve_args, Climb, Dispenser, Step};

    #[test]
    fn a_worker_process_serves_on_one_thread() {
        let argv: Vec<String> = ["render", "p.html", "--frames", "0-9", "--workers", "4", "--ffmpeg", "o.mp4", "--quality", "looks", "--stats", "--gl", "metal"].map(String::from).into();
        assert_eq!(serve_args(&argv, true), ["render", "p.html", "--frames", "0-9", "--gl", "metal", "--workers", "1", "--serve", "--stats", "--stream", "-"]);
        let argv: Vec<String> = ["render", "p.html", "--frames", "0-9", "--out", "d", "--workers", "4"].map(String::from).into();
        assert_eq!(serve_args(&argv, false), ["render", "p.html", "--frames", "0-9", "--out", "d", "--workers", "1", "--serve", "--stats"]);
    }

    #[test]
    fn the_dispenser_keeps_to_the_window_and_the_workers_allowed() {
        let d = Dispenser::new(5, 2, 2);
        assert_eq!(d.take(0), Some(0));
        assert_eq!(d.take(1), Some(1));
        assert_eq!(d.try_take(0), Err(()));
        d.set_limit(4);
        assert_eq!(d.try_take(0), Ok(Some(2)));
        assert_eq!(d.take(2), None);
        d.set_allowed(1);
        assert_eq!(d.take(1), None);
        assert_eq!(d.take(0), Some(3));
        d.set_limit(10);
        assert_eq!(d.take(0), Some(4));
        assert_eq!(d.take(0), None);
    }

    #[test]
    fn climbing_stops_where_a_worker_no_longer_pays() {
        let mut c = Climb::new(1, 4, true);
        assert!(matches!(c.frame(0, 1), Step::Keep));
        std::thread::sleep(std::time::Duration::from_millis(420));
        // first window: a rate to beat, so one more worker
        assert!(matches!(c.frame(0, 101), Step::Add));
        assert_eq!(c.active, 2);
        assert!(matches!(c.frame(1, 102), Step::Keep));
        std::thread::sleep(std::time::Duration::from_millis(420));
        // no faster with it: retired
        assert!(matches!(c.frame(0, 103), Step::Keep));
        assert!(matches!(c.frame(0, 120), Step::Retire));
        assert_eq!(c.active, 1);
        assert!(!matches!(Climb::new(4, 4, true).frame(3, 1), Step::Add));
    }
}
