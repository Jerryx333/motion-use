#!/usr/bin/env node
// WebGL parity, speed and determinism for motion-render (ANGLE backend).
//
// 1. drama-use docu-muzang ep01 (read only): composition/engine.html, a WebGL2 raymarched terrain
//    drawn into a 2D canvas, frames 0–131. Reference: drama-use's own GPU engine (headless Chrome on
//    Metal). Chrome software GL (SwiftShader) is ~1 s/frame or worse, so only every --cpu-step-th frame.
// 2. fixtures/webgl-probe (asserts the WebGL surface in setupFilm) and the three.js examples
//    (openai-yarn-film, motion-use-promo): the built index.html at one time per
//    shot; references: HyperFrames snapshot (software GL, what `motion-use still` uses) and the
//    same with --browser-gpu (Metal).
// motion-render runs twice: MOTION_RENDER_GL=metal (default on macOS) and swiftshader.
// Determinism: sha256 of raw RGBA, two single-thread runs and one with --workers.
//
//   node native/bench/webgl.mjs [--ep <ep01 dir>] [--only drama,probe,yarn,promo] [--cpu-step 11]
//                               [--workers 4] [--work <dir>] [--json out.json]
// Needs: npm ci, ffmpeg, ANGLE (native/scripts/fetch-angle.sh), cargo build --release, and the
// three.js examples built (cd examples/<x> && npm i && npm run build && npm run audio).
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ssim, diff } from "./ssim.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const BIN = process.env.MOTION_RENDER || path.join(ROOT, "native/target/release/motion-render");
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const only = opt("--only", "drama,probe,yarn,promo").split(",");
const EP = path.resolve(opt("--ep", "/Users/leo/github.com/drama-use/docu-muzang/ep01"));
const cpuStep = +opt("--cpu-step", 11);
const workers = +opt("--workers", 4);
const work = path.resolve(opt("--work", path.join(os.tmpdir(), "motion-render-webgl")));
const jsonOut = opt("--json", null);
fs.mkdirSync(work, { recursive: true });

const sh = (cmd, argv, o = {}) => {
  const t0 = performance.now();
  const r = spawnSync(cmd, argv, { encoding: "utf8", maxBuffer: 64 << 20, ...o });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(" ")}\n${r.stdout}\n${r.stderr}`);
  return { ms: performance.now() - t0, out: r.stdout };
};
const mr = (gl, argv, o = {}) => sh(BIN, argv, { ...o, env: { ...process.env, MOTION_RENDER_GL: gl } });
const lastJson = (s) => JSON.parse(s.trim().split("\n").at(-1));
const stats = (v) => ({ n: v.length, min: Math.min(...v), mean: v.reduce((a, b) => a + b, 0) / v.length });
const pad = (k) => String(k).padStart(5, "0");
const sha = (dir) => {
  const h = crypto.createHash("sha256");
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".rgba")).sort()) h.update(fs.readFileSync(path.join(dir, f)));
  return h.digest("hex");
};
function compare(pairs, diffDir) {
  const v = [];
  for (const [a, b, name] of pairs) {
    const s = ssim(a, b);
    if (s < 0.97 && diffDir) diff(a, b, path.join(diffDir, `diff-${name}.png`));
    v.push(s);
  }
  return stats(v);
}
// identical pixels? (ffmpeg: max |a-b| over RGB)
function maxDiff(a, b) {
  const r = spawnSync("ffmpeg", ["-v", "info", "-i", a, "-i", b, "-lavfi", "[0:v]format=rgb24[x];[1:v]format=rgb24[y];[x][y]blend=all_mode=difference,format=gray,signalstats,metadata=print:key=lavfi.signalstats.YMAX", "-f", "null", "-"], { encoding: "utf8" });
  const m = /YMAX=(\d+)/.exec(r.stderr);
  return m ? +m[1] : -1;
}

const result = { machine: `${os.cpus()[0].model}, ${os.cpus().length} cores`, drama: null, three: [], determinism: [] };

// ---------------------------------------------------------------------- drama terrain
if (only.includes("drama") && fs.existsSync(path.join(EP, "composition/engine.html"))) {
  const film = JSON.parse(fs.readFileSync(path.join(EP, "film.json"), "utf8"));
  const [W, H, fps] = [1920, 1080, film.fps];
  const from = 0, to = 131;
  const job = (out, a = from, b = to) => {
    const f = path.join(work, `job-${path.basename(out)}.json`);
    fs.writeFileSync(f, JSON.stringify({
      version: 1,
      film: { name: film.name, dir: EP, duration: film.duration, fps, lang: "zh", format: "landscape", copy: film.copy.zh, data: film.data ?? {}, look: film.look, shots: film.shots, captions: [], files: {}, assets: {} },
      lang: "zh", format: "landscape", width: W, height: H, fps, duration: film.duration,
      frames: { from: a, to: b }, out, pattern: "%05d.png",
      safe: { x: W * 0.05, y: H * 0.06, w: W * 0.9, h: H * 0.88 },
    }));
    return f;
  };
  const d = (n) => {
    const p = path.join(work, "drama", n);
    fs.rmSync(p, { recursive: true, force: true });
    return p;
  };
  const n = to - from + 1;
  const page = path.join(EP, "composition/engine.html");
  const ref = d("chrome-gpu"), ms1 = d("mr-metal-w1"), msN = d(`mr-metal-w${workers}`);
  const chromeGpu = sh(process.execPath, [path.resolve(EP, "../../scripts/gpu-engine.mjs"), "composition/engine.html", "--job", job(ref)], { cwd: EP });
  const chromeGpuDraw = lastJson(sh(process.execPath, [path.join(HERE, "chrome-engine.mjs"), "composition/engine.html", "--job", job(d("t-gpu")), "--gpu", "--time"], { cwd: EP }).out);
  const m1 = mr("metal", ["composition/engine.html", "--job", job(ms1), "--workers", "1"], { cwd: EP });
  const mN = mr("metal", ["composition/engine.html", "--job", job(msN), "--workers", String(workers)], { cwd: EP });
  const drawStats = lastJson(mr("metal", ["render", page, "--engine", "--job", job(d("t-mr")), "--frames", `${from}-${to}`, "--workers", "1", "--stats"]).out);
  const metalVsGpu = compare(Array.from({ length: n }, (_, i) => [path.join(ref, `${pad(from + i)}.png`), path.join(ms1, `${pad(from + i)}.png`), `metal-${from + i}`]), path.join(work, "drama"));
  // software GL samples: Chrome (SwiftShader) vs motion-render SwiftShader and Metal
  const picks = [];
  for (let k = from; k <= to; k += cpuStep) picks.push(k);
  const cpuRef = d("chrome-cpu"), ss = d("mr-swiftshader");
  let chromeCpuMs = 0, ssMs = 0;
  for (const k of picks) {
    chromeCpuMs += sh(process.execPath, [path.join(HERE, "chrome-engine.mjs"), "composition/engine.html", "--job", job(cpuRef, k, k)], { cwd: EP }).ms;
  }
  const chromeCpuDraw = lastJson(sh(process.execPath, [path.join(HERE, "chrome-engine.mjs"), "composition/engine.html", "--job", job(d("t-cpu"), 40, 45), "--time"], { cwd: EP }).out);
  const ssStats = lastJson(mr("swiftshader", ["render", page, "--engine", "--job", job(ss), "--at", picks.map((k) => k / fps).join(","), "--out", ss, "--workers", "1", "--stats"]).out);
  ssMs = ssStats.draw_ms_per_frame;
  const ssPairs = picks.map((k, i) => [path.join(cpuRef, `${pad(k)}.png`), path.join(ss, `${pad(i)}.png`), `ss-${k}`]);
  const ssVsCpu = compare(ssPairs, path.join(work, "drama"));
  const ssIdentical = ssPairs.filter(([a, b]) => maxDiff(a, b) === 0).length;
  const metalVsCpu = compare(picks.map((k) => [path.join(cpuRef, `${pad(k)}.png`), path.join(ms1, `${pad(k)}.png`), `metal-cpu-${k}`]), null);
  const gpuVsCpu = compare(picks.map((k) => [path.join(cpuRef, `${pad(k)}.png`), path.join(ref, `${pad(k)}.png`), `gpu-cpu-${k}`]), null);
  result.drama = {
    frames: n,
    ssim: { metal_vs_chrome_gpu: metalVsGpu, swiftshader_vs_chrome_cpu: { ...ssVsCpu, identical: ssIdentical }, metal_vs_chrome_cpu: metalVsCpu, chrome_gpu_vs_chrome_cpu: gpuVsCpu },
    ms_per_frame: {
      chrome_gpu_engine_png: chromeGpu.ms / n,
      chrome_gpu_draw: chromeGpuDraw.draw_ms,
      chrome_cpu_draw: chromeCpuDraw.draw_ms,
      chrome_cpu_engine_png_incl_launch: chromeCpuMs / picks.length,
      mr_metal_draw: drawStats.draw_ms_per_frame,
      mr_metal_job_png_w1: m1.ms / n,
      [`mr_metal_job_png_w${workers}`]: mN.ms / n,
      mr_swiftshader_draw: ssMs,
    },
  };
  console.log("drama", JSON.stringify(result.drama, null, 1));
  // determinism: 12 frames, raw RGBA
  const det = (gl, w, tag) => {
    const out = d(`det-${gl}-${tag}`);
    mr(gl, ["render", page, "--engine", "--job", job(out), "--frames", "40-51", "--format", "rgba", "--out", out, "--workers", String(w)]);
    return sha(out);
  };
  for (const gl of ["metal", "swiftshader"]) {
    const h = [det(gl, 1, "a"), det(gl, 1, "b"), det(gl, workers, "w")];
    result.determinism.push({ film: "drama terrain 40–51", gl, identical: h.every((x) => x === h[0]), sha256: h.map((x) => x.slice(0, 12)) });
  }
}

// ---------------------------------------------------------------------- three.js examples
const THREE = [
  { key: "probe", name: "webgl-probe", dir: path.join(HERE, "fixtures/webgl-probe"), lang: "en" },
  { key: "yarn", name: "openai-yarn-film" },
  { key: "promo", name: "motion-use-promo" },
];
for (const ex of THREE) {
  if (!only.includes(ex.key)) continue;
  const dir = ex.dir ?? path.join(ROOT, "examples", ex.name);
  if (!ex.dir && (!fs.existsSync(path.join(dir, "vendor/scene.js")) || !fs.existsSync(path.join(dir, "audio/score.wav")))) {
    console.log(`${ex.name}: not built (cd examples/${ex.name} && npm i && npm run build && npm run audio); skipped`);
    continue;
  }
  const pageDir = path.join(work, "pages", ex.key);
  const info = JSON.parse(sh(process.execPath, [path.join(HERE, "build-page.mjs"), dir, ex.lang ?? "zh", "landscape", pageDir], { cwd: ROOT }).out);
  // one frame-snapped time per shot, a third of the way in
  const times = info.shots.map(([, s, e]) => +(Math.round((s + (e - s) / 3) * info.fps) / info.fps).toFixed(4));
  const at = times.join(",");
  const out = (n) => {
    const p = path.join(work, ex.key, n);
    fs.rmSync(p, { recursive: true, force: true });
    return p;
  };
  const cpu = JSON.parse(sh(process.execPath, [path.join(HERE, "chrome-snapshot.mjs"), pageDir, at, out("chrome-cpu")]).out);
  const gpu = JSON.parse(sh(process.execPath, [path.join(HERE, "chrome-snapshot.mjs"), pageDir, at, out("chrome-gpu"), "--gpu"]).out);
  const metal = out("mr-metal"), ss = out("mr-swiftshader");
  mr("metal", ["render", path.join(pageDir, "index.html"), "--at", at, "--out", metal]);
  mr("swiftshader", ["render", path.join(pageDir, "index.html"), "--at", at, "--out", ss]);
  const pairs = (ref, mine) => times.map((t, i) => [ref.files[i], path.join(mine, `${pad(i)}.png`), `${i}`]);
  const ssPairs = pairs(cpu, ss);
  const row = {
    example: ex.name,
    times,
    ssim: {
      metal_vs_chrome_cpu: compare(pairs(cpu, metal), path.join(work, ex.key)),
      metal_vs_chrome_gpu: compare(pairs(gpu, metal), null),
      swiftshader_vs_chrome_cpu: { ...compare(ssPairs, null), identical: ssPairs.filter(([a, b]) => maxDiff(a, b) === 0).length },
      chrome_gpu_vs_chrome_cpu: compare(times.map((t, i) => [cpu.files[i], gpu.files[i], `g${i}`]), null),
      per_frame_metal_vs_cpu: pairs(cpu, metal).map(([a, b]) => +ssim(a, b).toFixed(4)),
    },
  };
  // speed: 60 consecutive frames from the middle of the film, drawing only (plus RGBA readback)
  const mid = Math.round(info.total / 4);
  const range = `${mid * info.fps}-${mid * info.fps + 59}`;
  const chromeCpu = lastJson(sh(process.execPath, [path.join(HERE, "chrome-raw.mjs"), pageDir, "20", "--from", String(mid)]).out);
  const chromeGpu = lastJson(sh(process.execPath, [path.join(HERE, "chrome-raw.mjs"), pageDir, "60", "--gpu", "--from", String(mid)]).out);
  const m1 = lastJson(mr("metal", ["render", path.join(pageDir, "index.html"), "--frames", range, "--stats", "--workers", "1"]).out);
  const mN = lastJson(mr("metal", ["render", path.join(pageDir, "index.html"), "--frames", range, "--stats", "--workers", String(workers)]).out);
  const s1 = lastJson(mr("swiftshader", ["render", path.join(pageDir, "index.html"), "--frames", `${mid * info.fps}-${mid * info.fps + 9}`, "--stats", "--workers", "1"]).out);
  row.ms_per_frame = {
    chrome_cpu_draw: chromeCpu.draw_ms + chromeCpu.readback_ms,
    chrome_gpu_draw: chromeGpu.draw_ms + chromeGpu.readback_ms,
    mr_metal_w1: m1.draw_ms_per_frame,
    [`mr_metal_w${workers}_wall`]: mN.wall_ms_per_frame,
    mr_swiftshader_w1: s1.draw_ms_per_frame,
    mr_setup_ms: m1.setup_ms,
  };
  result.three.push(row);
  console.log(ex.name, JSON.stringify(row, null, 1));
  const det = (gl, w, tag) => {
    const o = out(`det-${gl}-${tag}`);
    mr(gl, ["render", path.join(pageDir, "index.html"), "--frames", `${mid * info.fps}-${mid * info.fps + 11}`, "--format", "rgba", "--out", o, "--workers", String(w)]);
    return sha(o);
  };
  for (const gl of ["metal", "swiftshader"]) {
    const h = [det(gl, 1, "a"), det(gl, 1, "b"), det(gl, workers, "w")];
    result.determinism.push({ film: `${ex.name} 12 frames at ${mid}s`, gl, identical: h.every((x) => x === h[0]), sha256: h.map((x) => x.slice(0, 12)) });
  }
}
console.log("determinism", JSON.stringify(result.determinism, null, 1));
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(result, null, 2));
