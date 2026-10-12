#!/usr/bin/env node
// One built page, some times: Chrome vs motion-render, SSIM per frame, and diff pictures.
//   node native/bench/compare-page.mjs <page dir> <t,t,...> <out dir> [--gpu]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ssim, diff } from "./ssim.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.MOTION_RENDER || path.join(HERE, "../target/release/motion-render");
const [page, at, out, gpu] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const c = spawnSync(process.execPath, [path.join(HERE, "chrome-snapshot.mjs"), page, at, path.join(out, "chrome"), ...(gpu ? ["--gpu"] : [])], { encoding: "utf8" });
if (c.status) throw new Error(c.stderr);
const chrome = JSON.parse(c.stdout);
const m = spawnSync(BIN, ["render", path.join(page, "index.html"), "--at", at, "--out", path.join(out, "mr"), "--stats"], { encoding: "utf8" });
if (m.status) throw new Error(m.stderr);
at.split(",").forEach((t, i) => {
  const a = chrome.files[i], b = path.join(out, "mr", `${String(i).padStart(5, "0")}.png`);
  diff(a, b, path.join(out, `diff-${i}.png`));
  console.log(`t=${t} SSIM ${ssim(a, b).toFixed(4)}  chrome ${a}  mr ${b}`);
});
console.log(m.stdout.trim());
