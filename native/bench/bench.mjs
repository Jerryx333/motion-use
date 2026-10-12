#!/usr/bin/env node
// Speed: Chrome (HyperFrames render, motion-use's browser path; and Chrome drawing alone, CPU and
// GPU) vs motion-render on the same built pages, plus determinism (sha256 of raw RGBA across runs
// and worker counts).
//
//   node native/bench/bench.mjs [--only kinetic] [--seconds 8] [--workers 8] [--no-gpu] [--json out.json]
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hyperframesBin, HF_ENV } from "../../src/hf.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const BIN = process.env.MOTION_RENDER || path.join(ROOT, "native/target/release/motion-render");
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const only = opt("--only", null)?.split(",");
const LONG = +opt("--seconds", 8);
const WORKERS = +opt("--workers", Math.min(8, os.availableParallelism()));
const gpu = !args.includes("--no-gpu");
const work = path.resolve(opt("--work", path.join(os.tmpdir(), "motion-render-bench")));
const jsonOut = opt("--json", null);

const FILMS = [
  { name: "kinetic", lang: "en", format: "landscape", from: 2.6 },
  { name: "ocs-film", lang: "zh", format: "landscape", from: 1 },
  { name: "motion-use-film", lang: "zh", format: "landscape", from: 14, footage: true },
];

const sh = (cmd, argv, o = {}) => {
  const t0 = performance.now();
  const r = spawnSync(cmd, argv, { encoding: "utf8", maxBuffer: 64 << 20, ...o });
  const ms = performance.now() - t0;
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(" ")}\n${r.stdout}\n${r.stderr}`);
  return { ms, out: r.stdout };
};

function filmDir(f) {
  const src = path.join(ROOT, "examples", f.name);
  if (!f.footage) return src;
  // the parity script makes the same synthetic footage; reuse its builder
  const dst = path.join(work, "src", f.name);
  if (!fs.existsSync(dst)) {
    fs.cpSync(src, dst, { recursive: true, filter: (p) => !p.includes(`${path.sep}out`) });
    const film = JSON.parse(fs.readFileSync(path.join(dst, "film.json"), "utf8"));
    for (const v of Object.values(film.videos ?? {})) {
      const file = path.join(dst, v.file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      sh("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=1920x1080:r=60:d=${v.from + v.length * (v.rate ?? 1) + 1}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", file]);
    }
  }
  return dst;
}

function page(f, seconds) {
  const dir = path.join(work, "pages", `${f.name}-${seconds}`);
  const info = JSON.parse(sh(process.execPath, [path.join(HERE, "build-page.mjs"), filmDir(f), f.lang, f.format, dir, String(f.from), String(f.from + seconds)], { cwd: ROOT }).out);
  return { dir, frames: Math.round(seconds * info.fps), fps: info.fps };
}

function chrome(p, useGpu) {
  // HyperFrames render of the page, as `motion-use render --from --to` runs it
  const { bin } = hyperframesBin();
  const out = path.join(work, `chrome-${path.basename(p.dir)}-${useGpu ? "gpu" : "cpu"}.mp4`);
  return sh(process.execPath, [bin, "render", p.dir, "--output", out, "--fps", String(p.fps), "--quality", "draft", "--quiet", useGpu ? "--browser-gpu" : "--no-browser-gpu"], { env: { ...process.env, ...HF_ENV, HF_CAPTURE_PARALLEL_STREAM: "true" } }).ms;
}

function mr(p, extra) {
  const r = sh(BIN, ["render", path.join(p.dir, "index.html"), "--frames", `0-${p.frames - 1}`, "--stats", ...extra]);
  return { ms: r.ms, stats: JSON.parse(r.out.trim().split("\n").at(-1)) };
}

const sha = (dir) => {
  const h = crypto.createHash("sha256");
  for (const f of fs.readdirSync(dir).sort()) h.update(fs.readFileSync(path.join(dir, f)));
  return h.digest("hex").slice(0, 16);
};

const rows = [];
fs.mkdirSync(work, { recursive: true });
for (const f of FILMS) {
  if (only && !only.includes(f.name)) continue;
  const long = page(f, LONG);
  const per = (ms) => ms / long.frames;
  const row = { film: `${f.name}-${f.lang}-${f.format}`, fps: long.fps, frames: long.frames };
  // Wall time per frame for the whole window, start-up included, as a user waits for it.
  // motion-use's browser path: HyperFrames render (capture + x264), software GL, auto workers.
  row.chrome_render_cpu = per(chrome(long, false));
  // Chrome drawing only, one page (hf-seek + full-canvas readback), software GL and Metal.
  // HyperFrames' own --browser-gpu render fails on these pages (drawElement worker blocked by CSP).
  const raw = (g) => {
    const r = JSON.parse(sh(process.execPath, [path.join(HERE, "chrome-raw.mjs"), long.dir, String(Math.min(long.frames, 90)), ...(g ? ["--gpu"] : [])]).out);
    return r.draw_ms + r.readback_ms;
  };
  row.chrome_draw_cpu = raw(false);
  if (gpu) row.chrome_draw_gpu = raw(true);
  // motion-render, single thread: draw + readback per frame (its own stats)
  row.mr_draw = mr(long, ["--workers", "1"]).stats.draw_ms_per_frame;
  for (const [key, w] of [["w1", 1], [`w${WORKERS}`, WORKERS]]) {
    const ws = ["--workers", String(w)];
    const out = path.join(work, "out");
    row[`mr_raw_${key}`] = per(mr(long, ws).ms);
    fs.rmSync(out, { recursive: true, force: true });
    row[`mr_png_${key}`] = per(mr(long, [...ws, "--out", out, "--format", "png"]).ms);
    row[`mr_ffmpeg_${key}`] = per(mr(long, [...ws, "--ffmpeg", path.join(work, "l.mp4"), "--quality", "draft"]).ms);
  }
  // determinism: raw RGBA, twice with 1 worker and once with N workers
  const d = (w, name) => {
    const dir = path.join(work, "det", name);
    fs.rmSync(dir, { recursive: true, force: true });
    mr(long, ["--workers", String(w), "--out", dir, "--format", "rgba"]);
    return sha(dir);
  };
  const h1 = d(1, "a"), h2 = d(1, "b"), hn = d(WORKERS, "c");
  row.deterministic = h1 === h2 && h1 === hn;
  row.hash = h1;
  rows.push(row);
  console.log(JSON.stringify(row));
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ rows, workers: WORKERS, seconds: LONG, machine: `${os.cpus()[0].model}, ${os.cpus().length} cores` }, null, 2));
