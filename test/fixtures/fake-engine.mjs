#!/usr/bin/env node
// A stand-in external engine for tests: reads the motion-use job, records it, and writes the
// requested frames as PNGs — a teal field with a test pattern that moves with the frame number,
// so frame k is the same picture whichever process or range draws it.
// FAKE_ENGINE_LOG: a file to append each job to. FAKE_ENGINE_DROP=n: leave out the last n frames.
// FAKE_ENGINE_SIZE=WxH: draw at the wrong size. FAKE_ENGINE_FAIL=1: exit with an error.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const at = process.argv.indexOf("--job");
const jobFile = process.env.MOTION_USE_JOB;
if (!jobFile || at < 0 || process.argv[at + 1] !== jobFile) {
  console.error("fake engine: MOTION_USE_JOB and --job must name the same file");
  process.exit(2);
}
const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
if (process.env.FAKE_ENGINE_LOG) fs.appendFileSync(process.env.FAKE_ENGINE_LOG, JSON.stringify(job) + "\n");
if (process.env.FAKE_ENGINE_FAIL) {
  console.error("fake engine: scene failed to load");
  process.exit(3);
}
const { from, to } = job.frames;
const [w, h] = (process.env.FAKE_ENGINE_SIZE ?? `${job.width}x${job.height}`).split("x").map(Number);
const last = to - Number(process.env.FAKE_ENGINE_DROP ?? 0);
if (last >= from)
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", `color=c=0x2a9d8f:s=${w}x${h}:r=${job.fps}`,
    "-f", "lavfi", "-i", `testsrc2=s=320x180:r=${job.fps}`,
    "-filter_complex", `[0:v][1:v]overlay=x='mod(n*37,${w - 320})':y=${Math.round(h / 2)},select='between(n,${from},${last})'`,
    "-frames:v", String(last - from + 1), "-fps_mode", "passthrough", "-start_number", String(from),
    path.join(job.out, job.pattern),
  ]);
