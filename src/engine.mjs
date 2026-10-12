// External engines: a local command (Blender, Unity, Godot, a native renderer…) draws the picture
// as a PNG sequence; motion-use keeps everything around it — sound, captions overlay, encoding,
// delivery checks, snapshots and release masters. The contract is a job file per process:
// render frames `from`…`to` (inclusive, frame k shows film time k/fps) into `out` as `pattern`.
// An engine that declares "stream": true is offered a FIFO instead ("formats": ["png",
// "rgba-stream"], "stream": <path>): frames in order as raw straight RGBA, w×h×4 bytes each, which
// motion-use encodes as they arrive. "parallel": true gets one process for the whole range and
// motion-use's --workers as "workers".
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claimDir } from "./build.mjs";
import { safeBox } from "./film.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PATTERN = "%05d.png";
const frameName = (k) => `${String(k).padStart(5, "0")}.png`;

/** Frames of a film window: `from` and `to` in seconds → inclusive frame indices. */
export function frameRange(fps, from, to) {
  return { from: Math.round(from * fps), to: Math.max(Math.round(from * fps), Math.round(to * fps) - 1) };
}

/** Split an inclusive frame range into at most n contiguous chunks. */
export function splitFrames({ from, to }, n) {
  const count = to - from + 1,
    parts = Math.max(1, Math.min(n, count)),
    out = [];
  for (let i = 0; i < parts; i++) {
    const a = from + Math.floor((count * i) / parts),
      b = from + Math.floor((count * (i + 1)) / parts) - 1;
    out.push({ from: a, to: b });
  }
  return out;
}

/** What the engine is told: the resolved film for this language and format, and what to draw. */
export function engineJob(film, proj, frames, out, extra = {}) {
  const { w, h } = proj.fmt,
    c = proj.config;
  // footage frames motion-use extracted for this cut, by absolute folder
  const videos = Object.fromEntries(Object.entries(c.videos ?? {}).map(([k, v]) => [k, { ...v, dir: path.join(proj.dir, v.dir) }]));
  return {
    version: 1,
    film: {
      name: film.name,
      dir: film.dir,
      duration: film.duration,
      fps: film.fps,
      bpm: film.bpm,
      lang: proj.lang,
      format: proj.format,
      copy: c.copy,
      data: c.data,
      look: c.look,
      shots: c.shots,
      captions: c.captions,
      files: { ...film.files },
      assets: { ...film.fileAssets },
      videos,
    },
    lang: proj.lang,
    format: proj.format,
    width: w,
    height: h,
    fps: film.fps,
    duration: film.duration,
    frames,
    out,
    pattern: PATTERN,
    safe: safeBox(w, h),
    ...extra,
  };
}

// MOTION_USE_ROOT: motion-render (as an engine) loads this motion-use's runtime, kit and fonts.
const engineEnv = (engine, jobFile) => ({ ...process.env, MOTION_USE_ROOT: ROOT, ...engine.env, MOTION_USE_JOB: jobFile });

/**
 * Start a streaming engine over one range: its job asks for raw RGBA into `fifo`. Returns the
 * child; stdout and stderr are piped for the caller to read.
 */
export function startStreamingEngine(film, proj, frames, { work, fifo, workers }) {
  const jobFile = path.join(work, "job-0.json");
  const extra = { formats: ["png", "rgba-stream"], stream: fifo, ...(film.engine.parallel ? { workers } : {}) };
  fs.writeFileSync(jobFile, JSON.stringify(engineJob(film, proj, frames, path.join(work, "frames"), extra), null, 2) + "\n");
  const [cmd, ...args] = film.engine.command;
  return spawn(cmd, [...args, "--job", jobFile], { cwd: film.engine.cwd, env: engineEnv(film.engine, jobFile), stdio: ["ignore", "pipe", "pipe"] });
}

function runOne(engine, jobFile, log) {
  const [cmd, ...args] = engine.command;
  return new Promise((resolve) => {
    let tail = "";
    const child = spawn(cmd, [...args, "--job", jobFile], {
      cwd: engine.cwd,
      env: engineEnv(engine, jobFile),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const take = (d) => {
      tail = (tail + d).slice(-4000);
      log?.(String(d));
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (e) => resolve({ code: -1, tail: e.code === "ENOENT" ? `${cmd} not found` : e.message }));
    child.on("close", (code) => resolve({ code, tail }));
  });
}

/**
 * Run the engine over `chunks` (inclusive frame ranges), at most `workers` processes at a time,
 * into a fresh work folder. Resolves { ok, frames: <dir>, error }.
 */
export async function runEngine(film, proj, chunks, { workers = 1, work, log, extra = {} } = {}) {
  claimDir(work);
  const frames = path.join(work, "frames");
  fs.mkdirSync(frames);
  const queue = chunks.map((frames, i) => ({ frames, i }));
  const failed = [];
  const next = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const jobFile = path.join(work, `job-${item.i}.json`);
      fs.writeFileSync(jobFile, JSON.stringify(engineJob(film, proj, item.frames, frames, extra), null, 2) + "\n");
      const r = await runOne(film.engine, jobFile, log);
      if (r.code !== 0) failed.push(`frames ${item.frames.from}–${item.frames.to} exited with ${r.code}: ${r.tail.trim().split("\n").slice(-10).join("\n")}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, chunks.length)) }, next));
  if (failed.length) return { ok: false, frames, error: `external engine failed: ${failed.join("; ")}` };
  for (const c of chunks) {
    const bad = checkFrames(frames, c, proj.fmt.w, proj.fmt.h);
    if (bad) return { ok: false, frames, error: `external engine: ${bad}` };
  }
  return { ok: true, frames };
}

/** Every frame of the range present as a PNG of exactly w×h (read from its header). Returns an error or null. */
export function checkFrames(dir, { from, to }, w, h) {
  const missing = [];
  for (let k = from; k <= to; k++) {
    const f = path.join(dir, frameName(k));
    if (!fs.existsSync(f)) {
      missing.push(frameName(k));
      continue;
    }
    const head = Buffer.alloc(24),
      fd = fs.openSync(f, "r");
    try {
      fs.readSync(fd, head, 0, 24, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (head.readUInt32BE(0) !== 0x89504e47 || head.toString("latin1", 12, 16) !== "IHDR")
      return `${frameName(k)} is not a PNG`;
    const fw = head.readUInt32BE(16),
      fh = head.readUInt32BE(20);
    if (fw !== w || fh !== h) return `${frameName(k)} is ${fw}×${fh}, expected ${w}×${h}`;
  }
  if (missing.length)
    return `wrote ${to - from + 1 - missing.length} of ${to - from + 1} frames (${from}–${to}) into ${dir}; missing ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""}`;
  return null;
}

function ffmpeg(args) {
  try {
    execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    throw new Error(`ffmpeg failed: ${e.code === "ENOENT" ? "ffmpeg not found" : e.stderr?.toString().trim().split("\n").slice(-3).join(" ")}`);
  }
}

// x264 settings per --quality, as HyperFrames encodes the browser path (hyperframes 0.8.123:
// draft = ultrafast 28, looks = medium 16, delivery = slow 15; a release passes CRF 10 and the
// platform masters are encoded from that). Every renderer uses this one table.
export const X264 = { draft: ["ultrafast", 28], looks: ["medium", 16], delivery: ["slow", 15] };
const BT709 = "scale=out_color_matrix=bt709:out_range=tv:flags=neighbor";

/**
 * Encoder arguments for one video stream: HyperFrames' raw-frame encode (same preset, CRF,
 * x264 params, BT.709 conversion and tags), so the native and browser files match. `vf` replaces
 * the colour conversion when a filter graph already ends in it.
 */
export function encodeArgs({ quality = "looks", crf, fps, raw = true, vf = true }) {
  const [preset, q] = X264[quality] ?? X264.looks;
  const color = "colorprim=bt709:transfer=bt709:colormatrix=bt709";
  return [
    "-r", String(fps),
    "-c:v", "libx264", "-preset", preset, "-crf", String(crf ?? q), "-bf", "0",
    "-x264-params", preset === "ultrafast" ? `aq-mode=3:${color}` : `aq-mode=3:aq-strength=0.8:deblock=1,1:${color}`,
    "-colorspace:v", "bt709", "-color_primaries:v", "bt709", "-color_trc:v", "bt709", "-color_range", "tv",
    ...(vf ? ["-vf", raw ? BT709 : `${BT709},format=yuv420p`] : []),
    "-video_track_timescale", "90000", "-pix_fmt", "yuv420p",
  ];
}

/**
 * Engine frames (a PNG sequence, or a raw RGBA stream from a FIFO), alpha flattened on black,
 * with an overlay on top (a transparent MOV from the browser, or motion-render's raw RGBA on
 * stdin) and the film's mix (a WAV, or the MOV's own sound), encoded as the MP4 the rest of the
 * pipeline checks. Returns the ffmpeg arguments; compositeVideo runs them.
 */
export function compositeArgs({ frames, stream, range, layer, overlayRaw, audio, fps, w, h, quality = "looks", crf, out }) {
  const count = range.to - range.from + 1;
  const inputs = [
    "-f", "lavfi", "-i", `color=c=black:s=${w}x${h}:r=${fps}`,
    ...(stream
      ? ["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-framerate", String(fps), "-i", stream]
      : ["-framerate", String(fps), "-start_number", String(range.from), "-i", path.join(frames, PATTERN)]),
  ];
  let n = 2,
    graph = "[0:v][1:v]overlay=shortest=1[b]",
    last = "b",
    sound = null;
  if (overlayRaw) {
    inputs.push("-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-framerate", String(fps), "-i", "pipe:0");
    graph += `;[b][${n}:v]overlay=eof_action=pass[o]`;
    ((last = "o"), n++);
  } else if (layer) {
    inputs.push("-i", layer);
    graph += `;[b][${n}:v]overlay=eof_action=pass[o]`;
    sound = `${n}:a?`;
    ((last = "o"), n++);
  }
  if (audio) {
    inputs.push("-i", audio);
    sound = `${n}:a:0`;
    n++;
  }
  graph += `;[${last}]${BT709},format=yuv420p[v]`;
  return [
    ...inputs,
    "-filter_complex", graph,
    "-map", "[v]", ...(sound ? ["-map", sound] : []), "-frames:v", String(count),
    ...encodeArgs({ quality, crf, fps, vf: false }),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", out,
  ];
}

export function compositeVideo(o) {
  ffmpeg(compositeArgs(o));
}

/** One still: the engine frame on black with the browser layer's PNG (if any) on top. */
export function compositeStill({ frame, layer, w, h, out }) {
  ffmpeg([
    "-f", "lavfi", "-i", `color=c=black:s=${w}x${h}`, "-i", frame, ...(layer ? ["-i", layer] : []),
    "-filter_complex", layer ? "[0:v][1:v]overlay[b];[b][2:v]overlay" : "[0:v][1:v]overlay",
    "-frames:v", "1", out,
  ]);
}

export { frameName };
