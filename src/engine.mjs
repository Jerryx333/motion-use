// External engines: a local command (Blender, Unity, Godot, a native renderer…) draws the picture
// as a PNG sequence; motion-use keeps everything around it — sound, captions overlay, encoding,
// delivery checks, snapshots and release masters. The contract is a job file per process:
// render frames `from`…`to` (inclusive, frame k shows film time k/fps) into `out` as `pattern`.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { claimDir } from "./build.mjs";
import { safeBox } from "./film.mjs";

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
export function engineJob(film, proj, frames, out) {
  const { w, h } = proj.fmt,
    c = proj.config;
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
  };
}

function runOne(engine, jobFile, log) {
  const [cmd, ...args] = engine.command;
  return new Promise((resolve) => {
    let tail = "";
    const child = spawn(cmd, [...args, "--job", jobFile], {
      cwd: engine.cwd,
      env: { ...process.env, ...engine.env, MOTION_USE_JOB: jobFile },
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
export async function runEngine(film, proj, chunks, { workers = 1, work, log } = {}) {
  claimDir(work);
  const frames = path.join(work, "frames");
  fs.mkdirSync(frames);
  const queue = chunks.map((frames, i) => ({ frames, i }));
  const failed = [];
  const next = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const jobFile = path.join(work, `job-${item.i}.json`);
      fs.writeFileSync(jobFile, JSON.stringify(engineJob(film, proj, item.frames, frames), null, 2) + "\n");
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

// x264 settings per --quality; a release renders near-lossless first, like the browser path.
const X264 = { draft: ["veryfast", "23"], looks: ["medium", "16"], delivery: ["slow", "14"] };

/**
 * Engine frames, alpha flattened on black, with the browser layer (a transparent MOV that also
 * carries the film's mix) on top, encoded as the MP4 the rest of the pipeline checks.
 */
export function compositeVideo({ frames, range, layer, fps, w, h, quality = "looks", crf, out }) {
  const [preset, q] = X264[quality] ?? X264.looks;
  const count = range.to - range.from + 1;
  ffmpeg([
    "-f", "lavfi", "-i", `color=c=black:s=${w}x${h}:r=${fps}`,
    "-framerate", String(fps), "-start_number", String(range.from), "-i", path.join(frames, PATTERN),
    "-i", layer,
    "-filter_complex", `[0:v][1:v]overlay=shortest=1[b];[b][2:v]overlay=eof_action=pass,scale=out_color_matrix=bt709,format=yuv420p[v]`,
    "-map", "[v]", "-map", "2:a?", "-frames:v", String(count), "-r", String(fps),
    "-c:v", "libx264", "-preset", preset, "-crf", String(crf ?? q),
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", out,
  ]);
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
