#!/usr/bin/env node
// Chrome reference frames exactly as `motion-use still` takes them: HyperFrames' snapshot of the
// built page (headless Chrome, software GL unless --gpu). Prints {ms, files}.
//   node native/bench/chrome-snapshot.mjs <page dir> <t,t,...> <out dir> [--gpu]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { hyperframesBin, HF_ENV } from "../../src/hf.mjs";

const [dir, at, out, gpu] = process.argv.slice(2);
fs.rmSync(out, { recursive: true, force: true });
const { bin } = hyperframesBin();
const t0 = performance.now();
const r = spawnSync(process.execPath, [bin, "snapshot", dir, "--at", at, "--no-end", "--output", out, gpu === "--gpu" ? "--browser-gpu" : "--no-browser-gpu"], {
  env: { ...process.env, ...HF_ENV, FORCE_COLOR: "0", NO_COLOR: "1" },
  encoding: "utf8",
});
const ms = performance.now() - t0;
const files = fs.existsSync(out)
  ? fs.readdirSync(out).filter((f) => f.endsWith(".png")).sort((a, b) => a.localeCompare(b, "en", { numeric: true })).map((f) => path.join(out, f))
  : [];
if (r.status !== 0 || !files.length) {
  console.error((r.stdout || "") + (r.stderr || ""));
  process.exit(1);
}
console.log(JSON.stringify({ ms, files }));
