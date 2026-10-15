// motion-render, the native renderer (native/, Rust + Skia + V8): draws the same built page
// (index.html, runtime, kit, fonts) the browser draws, frames go straight into one ffmpeg as raw
// RGBA, the sound is mixed by ffmpeg (src/mix.mjs). Chrome stays the fallback and the reference.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeArgs } from "./engine.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const EXE = process.platform === "win32" ? "motion-render.exe" : "motion-render";
export const RENDERERS = ["auto", "native", "chrome"];

/** Where a motion-render binary may be, in the order motion-use looks. */
export function rendererCandidates(env = process.env) {
  const home = env.MOTION_USE_HOME || path.join(os.homedir(), ".local", "share", "motion-use");
  const out = [];
  if (env.MOTION_RENDER) out.push({ file: env.MOTION_RENDER, from: "MOTION_RENDER" });
  // install.sh puts the binary of the same release next to this version, and links the latest
  out.push({ file: path.join(ROOT, "native", "bin", EXE), from: "install" });
  out.push({ file: path.join(home, "bin", EXE), from: "install" });
  // a checkout that built it (cargo build --release --manifest-path native/Cargo.toml)
  out.push({ file: path.join(ROOT, "native", "target", "release", EXE), from: "checkout" });
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) out.push({ file: path.join(dir, EXE), from: "PATH" });
  return out;
}

let cached = null;
/**
 * The motion-render to use: { bin, version, caps, from } or { missing: why }. A binary that is too
 * old for this motion-use (no raw stream or text probe) is skipped with the reason.
 */
export function findRenderer({ env = process.env, refresh = false } = {}) {
  if (cached && !refresh && env === process.env) return cached;
  if (env.MOTION_RENDER === "0") return { missing: "turned off (MOTION_RENDER=0)" };
  const notes = [];
  let found = null;
  for (const c of rendererCandidates(env)) {
    if (!fs.existsSync(c.file)) {
      if (c.from === "MOTION_RENDER") notes.push(`MOTION_RENDER=${c.file} does not exist`);
      continue;
    }
    try {
      const caps = JSON.parse(execFileSync(c.file, ["--capabilities"], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").at(-1));
      if (!caps.stream || !caps.probe) {
        notes.push(`${c.file} (${caps.version ?? "old"}) has no raw stream or text probe; update it`);
        continue;
      }
      found = { bin: c.file, version: caps.version, caps, from: c.from };
      // The page, runtime, kit and fonts come from this motion-use; a different binary version
      // still draws them, but say so.
      if (caps.version && caps.version.split(".").slice(0, 2).join(".") !== VERSION.split(".").slice(0, 2).join("."))
        found.note = `motion-render ${caps.version} with motion-use ${VERSION}; update with install.sh if frames look wrong`;
      break;
    } catch (e) {
      notes.push(`${c.file} did not run: ${e.code === "EACCES" ? "not executable" : (e.message ?? "").split("\n")[0]}`);
    }
  }
  const r = found ?? { missing: notes.length ? notes.join("; ") : "motion-render is not installed (install.sh downloads it; or cargo build --release --manifest-path native/Cargo.toml)" };
  if (env === process.env) cached = r;
  return r;
}

// WebGL / WebGPU contexts, as written in a drawing or a library bundle. three.js asks with a
// variable, so its bundles are caught by their own names; a miss is caught at render time.
const GL = /getContext\(\s*["'`](?:webgl2?|experimental-webgl|webgpu)["'`]|["'`]webgl2["'`]|\bWebGLRenderer\b|\bTHREE\.REVISION\b|navigator\.gpu\b/;

/** Does the film's drawing (composition + libraries) use WebGL or WebGPU? Returns the file or null. */
export function webglUse(film) {
  for (const f of [film.source, ...(film.libraries ?? [])].filter(Boolean)) {
    try {
      if (GL.test(fs.readFileSync(f, "utf8"))) return f;
    } catch {}
  }
  return null;
}

/**
 * motion-render failed because the page asked for a context it cannot make: WebGPU, or WebGL on a
 * machine where ANGLE did not load (`getContext("webgl2"): <why>`), or an older binary (2D only).
 */
export const unsupportedContext = (text) => /getContext\("(?:webgl2?|experimental-webgl|webgpu|bitmaprenderer)"\)(?: is not supported|: )|2D canvas only/.test(text ?? "");

/**
 * Which renderer draws this film's picture: { renderer: "native"|"chrome", bin, note }.
 * --renderer beats film.json "renderer"; auto takes native when the binary is there and the film
 * has no WebGL it cannot draw. --gpu means Chrome's GPU path.
 */
export function chooseRenderer(film, o = {}, find = findRenderer) {
  const asked = o.renderer ?? film.renderer ?? "auto";
  if (!RENDERERS.includes(asked)) return { error: `--renderer must be ${RENDERERS.join(", ")}` };
  if (asked === "chrome") return { renderer: "chrome", reason: o.renderer ? "--renderer chrome" : 'film.json "renderer": "chrome"' };
  if (o.gpu) {
    if (asked === "native") return { error: "--gpu renders in Chrome; drop --gpu or --renderer native" };
    return { renderer: "chrome", reason: "--gpu renders in Chrome" };
  }
  const r = find();
  if (r.missing) {
    if (asked === "native") return { error: `--renderer native: ${r.missing}` };
    return { renderer: "chrome", reason: r.missing, quiet: true };
  }
  const gl = webglUse(film);
  if (gl && !r.caps.webgl) {
    const why = `${path.basename(gl)} uses WebGL, which motion-render ${r.version} does not draw yet`;
    if (asked === "native") return { error: `--renderer native: ${why}` };
    return { renderer: "chrome", reason: why, note: `rendering in Chrome: ${why}` };
  }
  return { renderer: "native", bin: r.bin, version: r.version, note: r.note };
}

/** Default render threads: --workers, else the cores (at most 8). */
export const nativeWorkers = (o) => Number(o.workers ?? Math.max(1, Math.min(8, os.availableParallelism?.() ?? os.cpus().length)));

const ENV = () => ({ ...process.env, MOTION_USE_ROOT: ROOT });

function collect(child, cap = 8000) {
  let out = "";
  child.stderr?.on("data", (d) => (out = (out + d).slice(-cap)));
  return () => out;
}

/**
 * Draw frames 0…n-1 of a built page and encode them, with the mixed sound when `audio` is given,
 * into `file`: motion-render's raw RGBA goes through a pipe into one ffmpeg with the browser
 * path's encoder settings. Resolves { code, out, ms } like runHyperframes.
 */
export function streamRender({ bin, proj, file, audio = null, quality = "looks", crf, workers, frames, onProgress }) {
  const fps = proj.fps,
    { w, h } = proj.fmt,
    count = frames ?? Math.round(proj.total * fps);
  const t0 = performance.now();
  return new Promise((resolve) => {
    const mr = spawn(bin, ["render", path.join(proj.dir, "index.html"), "--frames", `0-${count - 1}`, "--fps", String(fps), "--stream", "-", "--workers", String(workers)], {
      env: ENV(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ffArgs = [
      "-v", "error", "-y", ...(onProgress ? ["-progress", "pipe:2", "-stats_period", "1"] : []),
      "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-framerate", String(fps), "-i", "pipe:0",
      ...(audio ? ["-i", audio] : []),
      "-map", "0:v:0", ...(audio ? ["-map", "1:a:0"] : []),
      ...encodeArgs({ quality, crf, fps, raw: true }),
      "-frames:v", String(count),
      ...(audio ? ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"] : []),
      "-movflags", "+faststart", file,
    ];
    // ffmpeg reads motion-render's stdout directly; node never touches the frames.
    const ff = spawn("ffmpeg", ffArgs, { stdio: [mr.stdout, "ignore", "pipe"] });
    if (onProgress) {
      let pending = "";
      ff.stderr.on("data", (chunk) => {
        pending += chunk;
        const lines = pending.split("\n"); pending = lines.pop();
        for (const line of lines) {
          const match = /^frame=(\d+)/.exec(line);
          if (match) onProgress(Math.min(count, Number(match[1])), count);
        }
      });
    }
    mr.stdout.destroy();
    pair(mr, ff, (r) => resolve({ ...r, ms: performance.now() - t0 }));
  });
}

/**
 * Wait for a producer and the ffmpeg reading from it. Either side failing stops the other, so a
 * broken page never leaves ffmpeg waiting on a pipe (or the other way round).
 */
export function pair(producer, ff, resolve, name = "motion-render") {
  const pErr = collect(producer),
    fErr = collect(ff),
    codes = new Map(),
    notes = new Map();
  const finish = (child, code, note) => {
    if (codes.has(child)) return;
    codes.set(child, code);
    if (note) notes.set(child, note);
    const other = child === producer ? ff : producer;
    if (code !== 0 && !codes.has(other)) other.kill("SIGKILL");
    if (codes.size < 2) return;
    const ok = codes.get(producer) === 0 && codes.get(ff) === 0;
    resolve({
      code: ok ? 0 : 1,
      out: ok
        ? ""
        : [
            codes.get(producer) !== 0 ? `${name}: ${notes.get(producer) ?? (pErr().trim() || `exited with ${codes.get(producer)}`)}` : "",
            codes.get(ff) !== 0 ? `ffmpeg: ${notes.get(ff) ?? (fErr().trim() || `exited with ${codes.get(ff)}`)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
    });
  };
  producer.on("error", (e) => finish(producer, -1, e.code === "ENOENT" ? "not found" : e.message));
  ff.on("error", (e) => finish(ff, -1, e.code === "ENOENT" ? "ffmpeg not found" : e.message));
  producer.on("close", (code) => finish(producer, code ?? 1));
  ff.on("close", (code) => finish(ff, code ?? 1));
}

/** Run motion-render to completion. Resolves { code, out, stdout }. */
function run(bin, args, { cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env: ENV(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      err = "";
    // Decode as a stream: a CJK character split across two pipe chunks must not become U+FFFD
    // (the text check reported "北洋���府" when the probe's JSON crossed a 64 KB boundary).
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (err = (err + d).slice(-8000)));
    child.on("error", (e) => resolve({ code: -1, out: e.message, stdout }));
    child.on("close", (code) => resolve({ code, out: err, stdout }));
  });
}

const stillName = (i, t) => `frame-${String(i).padStart(2, "0")}-at-${+t.toFixed(3)}s.png`;

/**
 * Stills of a built page at `times` (seconds), named like the browser snapshots, into `dir`.
 * One thread, in the order given: a probe time drawn again at the end really is drawn after the
 * others in the same page, as the purity check needs. Resolves { code, out }.
 */
export async function nativeStills({ bin, proj, times, dir }) {
  const tmp = path.join(dir, ".native");
  fs.rmSync(tmp, { recursive: true, force: true });
  const r = await run(bin, ["render", path.join(proj.dir, "index.html"), "--at", times.map(String).join(","), "--out", tmp, "--format", "png", "--workers", "1"]);
  if (r.code !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { code: 1, out: r.out };
  }
  times.forEach((t, i) => fs.renameSync(path.join(tmp, `${String(i).padStart(5, "0")}.png`), path.join(dir, stillName(i, t))));
  fs.rmSync(tmp, { recursive: true, force: true });
  return { code: 0, out: "" };
}

/** motion-use's text probe run in motion-render's V8 over `times`; same result shape as in Chrome. */
export async function nativeProbe({ bin, projDir, times, work }) {
  fs.mkdirSync(work, { recursive: true });
  const file = path.join(work, `probe-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(times));
  try {
    const r = await run(bin, ["probe", path.join(projDir, "index.html"), "--times", file]);
    if (r.code !== 0) throw new Error(r.out.trim().split("\n").slice(-3).join(" ") || `motion-render exited with ${r.code}`);
    return JSON.parse(r.stdout.trim().split("\n").at(-1));
  } finally {
    fs.rmSync(file, { force: true });
  }
}
