#!/usr/bin/env node
// Extra benchmark on a real film outside this repo (read only): drama-use's docu-muzang ep01, the
// 2D "section" shot, frames 172–239, through its frame-engine page (composition/engine.html with a
// tiny M shim; window.setupEngine(job) / window.renderFrame(t)). Chrome reference: drama-use's own
// GPU engine (headless Chrome on Metal, toDataURL PNG per frame). Both run the same job file.
//   node native/bench/drama.mjs [<ep01 dir>] [--work <dir>] [--workers 8]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ssim } from "./ssim.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.MOTION_RENDER || path.join(HERE, "../target/release/motion-render");
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const ep = path.resolve(args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--work" && args[args.indexOf(a) - 1] !== "--workers") ?? "/Users/leo/github.com/drama-use/docu-muzang/ep01");
const work = path.resolve(opt("--work", path.join(os.tmpdir(), "motion-render-drama")));
const workers = opt("--workers", String(Math.min(8, os.availableParallelism())));
const film = JSON.parse(fs.readFileSync(path.join(ep, "film.json"), "utf8"));
const [W, H, fps] = [1920, 1080, film.fps];
const frames = { from: 172, to: 239 };
const job = (out) => ({
  version: 1,
  film: { name: film.name, dir: ep, duration: film.duration, fps, lang: "zh", format: "landscape", copy: film.copy.zh, data: film.data ?? {}, look: film.look, shots: film.shots, captions: [], files: {}, assets: {} },
  lang: "zh", format: "landscape", width: W, height: H, fps, duration: film.duration,
  frames, out, pattern: "%05d.png",
  safe: { x: W * 0.05, y: H * 0.06, w: W * 0.9, h: H * 0.88 },
});
fs.mkdirSync(work, { recursive: true });
const run = (cmd, argv, o) => {
  const t0 = performance.now();
  const r = spawnSync(cmd, argv, { encoding: "utf8", ...o });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(" ")}\n${r.stdout}\n${r.stderr}`);
  return performance.now() - t0;
};
const n = frames.to - frames.from + 1;
const chromeOut = path.join(work, "chrome"), cpuOut = path.join(work, "chrome-cpu"), mrOut = path.join(work, "mr"), mr1Out = path.join(work, "mr1");
for (const d of [chromeOut, cpuOut, mrOut, mr1Out]) fs.rmSync(d, { recursive: true, force: true });
fs.writeFileSync(path.join(work, "job-chrome.json"), JSON.stringify(job(chromeOut)));
fs.writeFileSync(path.join(work, "job-mr.json"), JSON.stringify(job(mrOut)));
fs.writeFileSync(path.join(work, "job-cpu.json"), JSON.stringify(job(cpuOut)));
fs.writeFileSync(path.join(work, "job-mr1.json"), JSON.stringify(job(mr1Out)));
const engine = path.resolve(ep, "../../scripts/gpu-engine.mjs");
const chromeMs = run(process.execPath, [engine, "composition/engine.html", "--job", path.join(work, "job-chrome.json")], { cwd: ep });
// the same page in Chrome with software GL (motion-use's default browser mode)
const cpuMs = run(process.execPath, [path.join(HERE, "chrome-engine.mjs"), "composition/engine.html", "--job", path.join(work, "job-cpu.json")], { cwd: ep });
const mr1Ms = run(BIN, ["composition/engine.html", "--job", path.join(work, "job-mr1.json"), "--workers", "1"], { cwd: ep });
const mrMs = run(BIN, ["composition/engine.html", "--job", path.join(work, "job-mr.json"), "--workers", workers], { cwd: ep });
const raw = spawnSync(BIN, ["render", path.join(ep, "composition/engine.html"), "--engine", "--job", path.join(work, "job-mr.json"), "--frames", `${frames.from}-${frames.to}`, "--workers", "1", "--stats"], { encoding: "utf8" });
const stats = JSON.parse(raw.stdout.trim().split("\n").at(-1));
const scores = [], cpuScores = [];
for (let k = frames.from; k <= frames.to; k++) {
  const f = `${String(k).padStart(5, "0")}.png`;
  scores.push(ssim(path.join(chromeOut, f), path.join(mrOut, f)));
  cpuScores.push(ssim(path.join(cpuOut, f), path.join(mrOut, f)));
}
const out = {
  frames: n,
  ssim_vs_chrome_gpu_min: Math.min(...scores),
  ssim_vs_chrome_gpu_mean: scores.reduce((a, b) => a + b, 0) / n,
  ssim_vs_chrome_cpu_min: Math.min(...cpuScores),
  ssim_vs_chrome_cpu_mean: cpuScores.reduce((a, b) => a + b, 0) / n,
  chrome_gpu_engine_ms_per_frame: chromeMs / n,
  chrome_cpu_engine_ms_per_frame: cpuMs / n,
  mr_job_png_w1_ms_per_frame: mr1Ms / n,
  [`mr_job_png_w${workers}_ms_per_frame`]: mrMs / n,
  mr_draw_ms_per_frame: stats.draw_ms_per_frame,
  worst: scores.map((s, i) => [s, frames.from + i]).sort((a, b) => a[0] - b[0]).slice(0, 3),
};
console.log(JSON.stringify(out, null, 2));
