#!/usr/bin/env node
// Parity + speed: every bundled 2D example rendered at the same times by Chrome (HyperFrames
// snapshot of motion-use's built page, what `motion-use still` does) and by motion-render, from the
// same index.html. Reports SSIM per frame and ms/frame for both.
//
//   node native/bench/parity.mjs [--only kinetic,whiteboard] [--per-shot 3] [--work <dir>] [--gpu] [--json out.json]
//
// Needs: npm ci (hyperframes), ffmpeg, cargo build --release in native/.
import { spawnSync } from "node:child_process";
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
const only = opt("--only", null)?.split(",");
const perShot = +opt("--per-shot", 3);
const work = path.resolve(opt("--work", path.join(os.tmpdir(), "motion-render-parity")));
const gpu = args.includes("--gpu");
const jsonOut = opt("--json", null);

// 2D examples and the language/format pairs to check (CJK and portrait included).
const EXAMPLES = [
  { name: "kinetic", configs: [["en", "landscape"], ["zh", "vertical"]] },
  { name: "data-story", configs: [["en", "landscape"], ["zh", "vertical"]] },
  { name: "whiteboard", configs: [["en", "landscape"], ["zh", "vertical"]] },
  { name: "ocs-film", configs: [["zh", "landscape"], ["en", "vertical"]] },
  { name: "motion-use-film", configs: [["zh", "landscape"]], footage: true },
];
// three.js / WebGL films are measured by webgl.mjs (they need the examples built and ANGLE).
const SKIPPED = { "motion-use-promo": "three.js (WebGL): see webgl.mjs", "openai-yarn-film": "three.js (WebGL): see webgl.mjs" };

const run = (cmd, argv, o = {}) => {
  const r = spawnSync(cmd, argv, { encoding: "utf8", maxBuffer: 64 << 20, ...o });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(" ")}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};

// motion-use-film's footage is rebuilt from other renders and not committed: give a scratch copy
// synthetic clips of the declared lengths (both renderers then draw the same JPEG frames).
function filmDir(ex) {
  const src = path.join(ROOT, "examples", ex.name);
  if (!ex.footage) return src;
  const dst = path.join(work, "src", ex.name);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true, filter: (f) => !f.includes(`${path.sep}out`) });
  const film = JSON.parse(fs.readFileSync(path.join(dst, "film.json"), "utf8"));
  for (const v of Object.values(film.videos ?? {})) {
    const f = path.join(dst, v.file);
    if (fs.existsSync(f)) continue;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const len = v.from + v.length * (v.rate ?? 1) + 1;
    run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=1920x1080:r=60:d=${len}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", f]);
  }
  return dst;
}

function timesFor(shots, total, fps) {
  const out = [];
  for (const [, s, e] of shots) {
    const d = e - s;
    const picks = perShot >= 3 ? [s + Math.min(0.25, d / 4), (s + e) / 2, Math.max(s, e - 1 / fps)] : [(s + e) / 2];
    out.push(...picks);
  }
  // snap to frame times, as a render would
  return [...new Set(out.map((t) => Math.min(total - 1 / fps, Math.round(t * fps) / fps)))].map((t) => +t.toFixed(4));
}

const rows = [];
fs.mkdirSync(work, { recursive: true });
for (const ex of EXAMPLES) {
  if (only && !only.includes(ex.name)) continue;
  const dir = filmDir(ex);
  for (const [lang, format] of ex.configs) {
    const id = `${ex.name}-${lang}-${format}`;
    const pageDir = path.join(work, "pages", id);
    const info = JSON.parse(run(process.execPath, [path.join(HERE, "build-page.mjs"), dir, lang, format, pageDir], { cwd: ROOT }));
    const times = timesFor(info.shots, info.total, info.fps);
    const at = times.join(",");
    // Chrome: N frames, and 1 frame to subtract the browser start and page load.
    const chromeDir = path.join(work, "chrome", id);
    const c = JSON.parse(run(process.execPath, [path.join(HERE, "chrome-snapshot.mjs"), pageDir, at, chromeDir, ...(gpu ? ["--gpu"] : [])]));
    const c1 = JSON.parse(run(process.execPath, [path.join(HERE, "chrome-snapshot.mjs"), pageDir, String(times[0]), chromeDir + "-one", ...(gpu ? ["--gpu"] : [])]));
    const chromeMs = (c.ms - c1.ms) / Math.max(1, times.length - 1);
    // motion-render: same times, PNG out for comparison; stats give draw time per frame.
    const mrDir = path.join(work, "mr", id);
    fs.rmSync(mrDir, { recursive: true, force: true });
    const st = JSON.parse(run(BIN, ["render", path.join(pageDir, "index.html"), "--at", at, "--out", mrDir, "--stats"]).trim().split("\n").at(-1));
    const frames = times.map((t, i) => {
      const a = c.files[i], b = path.join(mrDir, `${String(i).padStart(5, "0")}.png`);
      const s = ssim(a, b);
      if (s < 0.98) diff(a, b, path.join(work, "mr", `${id}-diff-${i}.png`));
      return { t, ssim: s };
    });
    const row = { id, w: info.w, h: info.h, frames, min: Math.min(...frames.map((f) => f.ssim)), mean: frames.reduce((a, f) => a + f.ssim, 0) / frames.length, chrome_ms: chromeMs, chrome_total_ms: c.ms, mr_draw_ms: st.draw_ms_per_frame, mr_setup_ms: st.setup_ms };
    rows.push(row);
    console.log(`${id.padEnd(32)} ${frames.length} frames  SSIM min ${row.min.toFixed(4)} mean ${row.mean.toFixed(4)}  chrome ${chromeMs.toFixed(0)} ms/frame  motion-render ${row.mr_draw_ms.toFixed(1)} ms/frame`);
    for (const f of frames) if (f.ssim < 0.98) console.log(`    t=${f.t}  SSIM ${f.ssim.toFixed(4)}`);
  }
}
for (const [k, why] of Object.entries(SKIPPED)) console.log(`${k.padEnd(32)} skipped: ${why}`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ rows, skipped: SKIPPED, gpu }, null, 2));
