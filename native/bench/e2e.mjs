#!/usr/bin/env node
// End to end through motion-use: `motion-use render` of the same film with --renderer native and
// --renderer chrome, wall time of each, and how close the delivered files are (duration, frames,
// size, loudness, per-100 ms RMS, motion lights, text-check runs, SSIM of sample frames).
//
//   node native/bench/e2e.mjs <film dir> [--lang zh] [--format landscape] [--quality draft]
//        [--no-normalize] [--work dir] [--json out.json] [--skip-chrome]
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ssim } from "./ssim.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const CLI = path.join(ROOT, "bin", "motion-use.mjs");

/** Render `film` with one renderer; { ms, result } (the --json output's first output). */
export function renderWith(film, renderer, { lang, format, quality = "draft", out, extra = [] }) {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [CLI, "render", film, "--lang", lang, "--format", format, "--quality", quality, "--allow-code", "--no-asr", "--force", "--renderer", renderer, "--out", out, "--json", ...extra], {
    encoding: "utf8",
    maxBuffer: 256 << 20,
    env: { ...process.env, MOTION_USE_NO_UPDATE_CHECK: "1" },
  });
  const ms = performance.now() - t0;
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {}
  if (r.status !== 0 || !json?.ok) throw new Error(`${renderer} render failed (${r.status}): ${json ? JSON.stringify(json.outputs?.[0]?.error ?? json.error) : r.stdout.slice(-2000)}\n${r.stderr.slice(-2000)}`);
  return { ms, result: json.outputs[0] };
}

const probe = (file) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_packets", "-show_entries", "format=duration,size:stream=codec_type,nb_read_packets,width,height,r_frame_rate", "-of", "json", file], { encoding: "utf8" }));

/** Integrated loudness (LUFS), loudness range and true peak (dBTP) of a file's audio. */
export function loudness(file) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" });
  const tail = r.stderr.slice(r.stderr.lastIndexOf("Summary:"));
  const num = (re) => Number(re.exec(tail)?.[1]);
  return { lufs: num(/I:\s+(-?[\d.]+) LUFS/), lra: num(/LRA:\s+(-?[\d.]+) LU/), peak: num(/Peak:\s+(-?[\d.]+) dBFS/) };
}

/** Mono float samples at 48 kHz. */
export function pcm(file) {
  const b = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a:0", "-f", "f32le", "-ac", "1", "-ar", "48000", "-"], { maxBuffer: 1 << 30 });
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
}

/** Per-window RMS difference in dB between two signals, over windows louder than -50 dB in either. */
export function rmsWindows(a, b, { win = 4800 } = {}) {
  const rows = [];
  for (let i = 0; i + win <= Math.min(a.length, b.length); i += win) {
    let sa = 0,
      sb = 0;
    for (let k = i; k < i + win; k++) ((sa += a[k] * a[k]), (sb += b[k] * b[k]));
    const da = 10 * Math.log10(sa / win + 1e-12),
      db = 10 * Math.log10(sb / win + 1e-12);
    if (Math.max(da, db) > -50) rows.push({ t: i / 48000, a: da, b: db, diff: db - da });
  }
  const abs = rows.map((r) => Math.abs(r.diff)).sort((x, y) => x - y);
  return { windows: rows.length, max_db: +(abs.at(-1) ?? 0).toFixed(2), p95_db: +(abs[Math.floor(abs.length * 0.95)] ?? 0).toFixed(2), mean_db: +(abs.reduce((s, x) => s + x, 0) / (abs.length || 1)).toFixed(3), worst: rows.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff)).slice(0, 3).map((r) => ({ t: +r.t.toFixed(1), diff: +r.diff.toFixed(2) })) };
}

function frameAt(file, t, out) {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", file, "-frames:v", "1", out]);
  return out;
}

/** Compare two delivered renders of the same cut. */
export function compareRenders(a, b, { times, work }) {
  const pa = probe(a.file),
    pb = probe(b.file);
  const va = pa.streams.find((s) => s.codec_type === "video"),
    vb = pb.streams.find((s) => s.codec_type === "video");
  const hasAudio = pa.streams.some((s) => s.codec_type === "audio") && pb.streams.some((s) => s.codec_type === "audio");
  fs.mkdirSync(work, { recursive: true });
  const ssims = times.map((t) => ssim(frameAt(a.file, t, path.join(work, `a-${t}.png`)), frameAt(b.file, t, path.join(work, `b-${t}.png`))));
  const runs = (r) => (r.verification.text_check?.runs ?? []).map((x) => `${x.kind}:${x.text}${x.other ? "×" + x.other : ""}`).sort();
  const ra = runs(a),
    rb = runs(b);
  return {
    duration: [+Number(pa.format.duration).toFixed(3), +Number(pb.format.duration).toFixed(3)],
    frames: [Number(va.nb_read_packets), Number(vb.nb_read_packets)],
    size: [`${va.width}x${va.height}`, `${vb.width}x${vb.height}`],
    bytes: [Number(pa.format.size), Number(pb.format.size)],
    audio: hasAudio ? { a: loudness(a.file), b: loudness(b.file), rms: rmsWindows(pcm(a.file), pcm(b.file)) } : null,
    motion: [a.verification.motion?.level, b.verification.motion?.level],
    motion_values: [a.verification.motion, b.verification.motion],
    text_runs: { a: ra.length, b: rb.length, only_a: ra.filter((x) => !rb.includes(x)), only_b: rb.filter((x) => !ra.includes(x)) },
    ssim: { min: +Math.min(...ssims).toFixed(4), mean: +(ssims.reduce((s, x) => s + x, 0) / ssims.length).toFixed(4), times },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const film = path.resolve(args[0]);
  const lang = opt("--lang", "zh"),
    format = opt("--format", "landscape"),
    quality = opt("--quality", "draft");
  const work = path.resolve(opt("--work", path.join(os.tmpdir(), "motion-use-e2e", path.basename(film))));
  const extra = args.includes("--no-normalize") ? ["--no-normalize"] : [];
  const n = renderWith(film, "native", { lang, format, quality, out: path.join(work, "native"), extra });
  console.error(`native ${(n.ms / 1000).toFixed(1)} s`);
  let report = { film: path.basename(film), lang, format, quality, native_s: +(n.ms / 1000).toFixed(2) };
  if (!args.includes("--skip-chrome")) {
    const c = renderWith(film, "chrome", { lang, format, quality, out: path.join(work, "chrome"), extra });
    console.error(`chrome ${(c.ms / 1000).toFixed(1)} s`);
    const dur = n.result.seconds;
    const times = [0.25, dur * 0.25, dur * 0.5, dur * 0.75, Math.max(0, dur - 0.1)].map((t) => +t.toFixed(3));
    const cmp = compareRenders(c.result, n.result, { times, work: path.join(work, "frames") });
    const frames = cmp.frames[1];
    report = { ...report, chrome_s: +(c.ms / 1000).toFixed(2), speedup: +(c.ms / n.ms).toFixed(2), native_ms_per_frame: +(n.ms / frames).toFixed(1), chrome_ms_per_frame: +(c.ms / frames).toFixed(1), ...cmp };
  }
  console.log(JSON.stringify(report, null, 2));
  const jsonOut = opt("--json", null);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2) + "\n");
}
