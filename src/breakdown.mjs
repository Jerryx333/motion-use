// Reference-video breakdown: cuts, beat grid, contact sheets, motion heatmaps, palette.
// Method ported from alchaincyf/huashu-art-motion scripts/analyze/breakdown.py (MIT).
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { claimDir } from "./build.mjs";
import { analyzeAudio, audioText } from "./breakdown-audio.mjs";

const CUT_DIFF = 5; // mean |diff| on 0-255 gray that marks a transition
const DEBOUNCE = 12; // frames
const MOTION_THRESH = 25;
const r3 = (x) => Math.round(x * 1000) / 1000;
const pad2 = (n) => String(n).padStart(2, "0");

function ff(args, input) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { input, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(r.error.code === "ENOENT" ? "ffmpeg not found; install ffmpeg" : r.error.message);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.toString().trim().slice(-1500)}`);
  return r.stdout;
}

export function probeMeta(file) {
  let out;
  try {
    out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate:format=duration", "-of", "json", file], { encoding: "utf8" });
  } catch (e) {
    throw new Error(e.code === "ENOENT" ? "ffprobe not found; install ffmpeg" : `cannot read ${file}: ${e.stderr || e.message}`);
  }
  const j = JSON.parse(out);
  const v = j.streams?.[0];
  if (!v?.width) throw new Error(`${file}: no video stream`);
  const rate = (s) => {
    const [a, b] = String(s).split("/").map(Number);
    return a > 0 && b > 0 ? a / b : NaN;
  };
  const fps = Number.isFinite(rate(v.avg_frame_rate)) ? rate(v.avg_frame_rate) : rate(v.r_frame_rate);
  const duration = Number.parseFloat(j.format?.duration);
  if (!Number.isFinite(fps) || !Number.isFinite(duration)) throw new Error(`${file}: cannot read fps/duration`);
  return { duration, width: v.width, height: v.height, fps };
}

// Stream raw frames from ffmpeg to cb(frame, index) without holding the whole video.
function eachFrame(args, size, cb) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-v", "error", ...args, "-f", "rawvideo", "-"], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = Buffer.alloc(0);
    let n = 0;
    let err = "";
    p.stdout.on("data", (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      let off = 0;
      while (buf.length - off >= size) {
        cb(buf.subarray(off, off + size), n++);
        off += size;
      }
      buf = Buffer.from(buf.subarray(off));
    });
    p.stderr.on("data", (c) => (err += c));
    p.on("error", (e) => reject(new Error(e.code === "ENOENT" ? "ffmpeg not found; install ffmpeg" : e.message)));
    p.on("close", (code) => (code === 0 ? resolve(n) : reject(new Error(`ffmpeg failed: ${err.trim().slice(-1500)}`))));
  });
}

/** Mean absolute frame difference per frame (d[0] = 0) at 192×108 gray. */
async function frameDiffs(file, fps) {
  const size = 192 * 108;
  const d = [];
  let prev = null;
  await eachFrame(["-i", file, "-vf", `fps=${fps},scale=192:108,format=gray`, "-pix_fmt", "gray"], size, (f) => {
    let s = 0;
    if (prev) for (let i = 0; i < size; i++) s += Math.abs(f[i] - prev[i]);
    d.push(prev ? s / size : 0);
    prev = Buffer.from(f);
  });
  return d;
}

export function detectStarts(d) {
  const starts = [];
  for (let i = 1; i < d.length; i++) {
    if (d[i] > CUT_DIFF && d[i - 1] <= CUT_DIFF && (!starts.length || i - starts.at(-1) >= DEBOUNCE)) starts.push(i);
  }
  return starts;
}

/** Fit starts (frames) to t0 + k*step; largest step with ≥80% inliers within 1.5 frames. */
export function fitBeatGrid(S, fps) {
  if (S.length < 4) return null;
  let maxGap = 0;
  for (let i = 1; i < S.length; i++) maxGap = Math.max(maxGap, S[i] - S[i - 1]);
  const hi = Math.min(maxGap, 4 * fps);
  const need = Math.ceil(0.8 * S.length);
  // Descend from the largest step; small steps fit anything, so the first hit wins.
  for (let c = Math.floor(hi * 100); c >= 400; c--) {
    const step = c / 100;
    for (let j = 0; j < Math.min(3, S.length); j++) {
      const t0 = S[j];
      let inl = 0;
      for (let i = 0; i < S.length && inl + S.length - i >= need; i++) {
        const k = Math.round((S[i] - t0) / step);
        if (Math.abs(S[i] - t0 - k * step) <= 1.5) inl++;
      }
      if (inl < need) continue;
      // Refine t0 by the mean inlier residual, then least-squares step on inliers.
      const pts = [];
      let rs = 0;
      for (const s of S) {
        const k = Math.round((s - t0) / step);
        const r = s - t0 - k * step;
        if (Math.abs(r) <= 1.5) pts.push([k, s]), (rs += r);
      }
      // Candidates: raw, t0 shifted by the mean inlier residual, least squares on inliers.
      // Keep the latest one that loses no inliers.
      const count = (a, b) => S.filter((x) => Math.abs(x - b - Math.round((x - b) / a) * a) <= 1.5).length;
      const cands = [[step, t0], [step, t0 + rs / pts.length]];
      const n = pts.length;
      const mk = pts.reduce((a, p) => a + p[0], 0) / n;
      const ms = pts.reduce((a, p) => a + p[1], 0) / n;
      const vk = pts.reduce((a, p) => a + (p[0] - mk) ** 2, 0);
      if (vk > 0) {
        const ls = pts.reduce((a, p) => a + (p[0] - mk) * (p[1] - ms), 0) / vk;
        if (Math.abs(ls - step) < 0.5) cands.push([ls, ms - ls * mk]);
      }
      let [st, t] = cands[0];
      let best = count(st, t);
      for (const [a, b] of cands.slice(1)) {
        const c = count(a, b);
        if (c >= best) (best = c), (st = a), (t = b);
      }
      let maxRes = 0;
      const outliers = [];
      let inliers = 0;
      for (const s of S) {
        const r = s - t - Math.round((s - t) / st) * st;
        if (Math.abs(r) <= 1.5) inliers++, (maxRes = Math.max(maxRes, Math.abs(r)));
        else outliers.push(r3(s / fps));
      }
      return {
        step_frames: Math.round(st * 100) / 100,
        step_seconds: r3(st / fps),
        t0_seconds: r3(t / fps),
        inliers,
        of: S.length,
        max_residual_frames: Math.round(maxRes * 100) / 100,
        bpm_if_eighth: Math.round(((60 * fps) / st / 2) * 10) / 10,
        bpm_if_quarter: Math.round(((60 * fps) / st) * 10) / 10,
        outliers,
        chance_inlier_rate: r3(Math.min(1, 3 / st)), // what random cuts would score; near 0.8 means weak evidence
      };
    }
  }
  return null;
}

function contactSheets(file, outDir, duration) {
  const dir = path.join(outDir, "sheets");
  fs.mkdirSync(dir);
  // No drawtext (often built without fonts): times live in the JSON instead.
  ff(["-i", file, "-vf", "fps=4,scale=480:-2,tile=6x5", "-q:v", "4", "-start_number", "1", path.join(dir, "sheet%02d.jpg")]);
  const total = Math.max(1, Math.ceil(duration * 4));
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .map((f, s) => ({
      file: `sheets/${f}`,
      columns: 6,
      times: Array.from({ length: Math.max(0, Math.min(30, total - s * 30)) }, (_, j) => r3((s * 30 + j) / 4)),
    }));
}

// Batched in chunks: ffmpeg startup is slow enough to dominate short clips.
function ffBatch(jobs, chunk = 16) {
  for (let i = 0; i < jobs.length; i += chunk) {
    const part = jobs.slice(i, i + chunk);
    ff([...part.flatMap((j) => j.input), ...part.flatMap((j, k) => [...(j.filter ? ["-filter_complex", `[${k}:v]${j.filter}[o${k}]`, "-map", `[o${k}]`] : ["-map", `${k}:v:0`]), "-frames:v", "1", ...(j.args ?? []), j.out])]);
  }
}

function transitionStrips(file, outDir, starts, fps, nativeFps) {
  const vf = [nativeFps > fps + 0.01 ? `fps=${fps}` : null, "select='not(mod(n\\,2))'", "scale=384:216:force_original_aspect_ratio=decrease", "pad=384:216:(ow-iw)/2:(oh-ih)/2", "tile=5x3"].filter(Boolean).join(",");
  ffBatch(starts.map((f, i) => ({ input: ["-ss", String(Math.max(0, f - 2) / fps), "-i", file], filter: vf, args: ["-q:v", "4"], out: path.join(outDir, `transitions/T${pad2(i + 1)}.jpg`) })));
}

/** One pass at w×h gray: per-window max |diff| and the frame nearest each window's mid time. */
async function motionMaps(file, windows, fps, w, h) {
  const size = w * h;
  const st = windows.map(() => ({ m: null, prev: -1, prevBuf: null, mid: null, midDist: Infinity }));
  let j = 0;
  await eachFrame(["-i", file, "-vf", `fps=${fps},scale=${w}:${h},format=gray`, "-pix_fmt", "gray"], size, (f, n) => {
    const t = n / fps;
    while (j < windows.length && t > windows[j].to + 1e-6) j++;
    for (let k = j; k < windows.length && windows[k].from <= t + 1e-6; k++) {
      const wd = windows[k];
      const s = st[k];
      if (t < wd.from - 1e-6 || t > wd.to + 1e-6) continue;
      if (Math.abs(t - wd.mid) < s.midDist) (s.midDist = Math.abs(t - wd.mid)), (s.mid = Buffer.from(f));
      if (s.prevBuf && s.prev === n - 1) {
        s.m ??= new Uint8Array(size);
        for (let i = 0; i < size; i++) {
          const v = Math.abs(f[i] - s.prevBuf[i]);
          if (v > s.m[i]) s.m[i] = v;
        }
      }
      s.prev = n;
      s.prevBuf = Buffer.from(f);
    }
  });
  return st.map((s) => {
    if (!s.m) return null;
    let moving = 0;
    for (let i = 0; i < size; i++) if (s.m[i] > MOTION_THRESH) moving++;
    // Red overlay on the dimmed gray mid frame, stronger where motion is larger.
    const rgb = Buffer.alloc(size * 3);
    for (let i = 0; i < size; i++) {
      const g = s.mid[i] * 0.6;
      const a = s.m[i] > MOTION_THRESH ? Math.min(1, s.m[i] / 100) * 0.8 : 0;
      rgb[i * 3] = g * (1 - a) + 255 * a;
      rgb[i * 3 + 1] = rgb[i * 3 + 2] = g * (1 - a);
    }
    return { area: r3(moving / size), rgb };
  });
}

// Deterministic PRNG for k-means seeding.
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export function kmeans(px, k, iters = 20) {
  const n = px.length / 3;
  const rand = lcg(42);
  const cent = [];
  // k-means++ init
  let i0 = Math.floor(rand() * n);
  cent.push([px[i0 * 3], px[i0 * 3 + 1], px[i0 * 3 + 2]]);
  const dist = new Float64Array(n).fill(Infinity);
  while (cent.length < k) {
    const c = cent.at(-1);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const dd = (px[i * 3] - c[0]) ** 2 + (px[i * 3 + 1] - c[1]) ** 2 + (px[i * 3 + 2] - c[2]) ** 2;
      if (dd < dist[i]) dist[i] = dd;
      sum += dist[i];
    }
    if (sum === 0) break;
    let r = rand() * sum;
    let pick = n - 1;
    for (let i = 0; i < n; i++) if ((r -= dist[i]) <= 0) { pick = i; break; }
    cent.push([px[pick * 3], px[pick * 3 + 1], px[pick * 3 + 2]]);
  }
  const lab = new Uint8Array(n);
  for (let it = 0; it < iters; it++) {
    const acc = cent.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < cent.length; c++) {
        const dd = (px[i * 3] - cent[c][0]) ** 2 + (px[i * 3 + 1] - cent[c][1]) ** 2 + (px[i * 3 + 2] - cent[c][2]) ** 2;
        if (dd < bd) (bd = dd), (best = c);
      }
      lab[i] = best;
      const a = acc[best];
      a[0] += px[i * 3], a[1] += px[i * 3 + 1], a[2] += px[i * 3 + 2], a[3]++;
    }
    acc.forEach((a, c) => a[3] && (cent[c] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]));
  }
  const counts = cent.map(() => 0);
  for (let i = 0; i < n; i++) counts[lab[i]]++;
  const hex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  return cent.map((c, i) => ({ hex: hex(c), share: r3(counts[i] / n) })).filter((c) => c.share > 0).sort((a, b) => b.share - a.share);
}

function isBluePurple(r, g, b) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const v = mx / 255;
  if (v < 0.06 || v > 0.9 || mx === 0) return false;
  const s = (mx - mn) / mx;
  if (s < 0.3) return false;
  const dlt = mx - mn;
  let hue = mx === r ? ((g - b) / dlt) % 6 : mx === g ? (b - r) / dlt + 2 : (r - g) / dlt + 4;
  hue = (hue * 60 + 360) % 360;
  return hue >= 225 && hue <= 300;
}

async function palette(file, duration, W, H) {
  const w = 160;
  const h = Math.max(2, Math.round((160 * H) / W / 2) * 2);
  const size = w * h * 3;
  const sample = [];
  let frames = 0;
  let bpFrames = 0;
  let bpPixels = 0;
  await eachFrame(["-i", file, "-vf", `fps=${24 / Math.max(duration, 0.1)},scale=${w}:${h},format=rgb24`, "-pix_fmt", "rgb24", "-frames:v", "24"], size, (f) => {
    frames++;
    let bp = 0;
    for (let i = 0; i < size; i += 3) {
      if (isBluePurple(f[i], f[i + 1], f[i + 2])) bp++;
      if ((i / 3) % 4 === 0) sample.push(f[i], f[i + 1], f[i + 2]);
    }
    bpPixels += bp;
    if (bp >= 0.3 * (size / 3)) bpFrames++;
  });
  if (!frames) return { colors: [], blue_purple: null };
  return {
    colors: kmeans(Uint8Array.from(sample), 6),
    blue_purple: { frames: bpFrames, of: frames, frame_share: r3(bpFrames / frames), pixel_share: r3(bpPixels / (frames * (size / 3))), flagged: bpFrames / frames >= 0.3 },
  };
}

function markdown(s) {
  const L = [`# Breakdown: ${path.basename(s.source)}`, "", `${s.width}×${s.height}, ${s.fps.toFixed(2)} fps, ${s.duration.toFixed(2)} s, ${s.transitions.length} transitions, ${s.segments.length} segments.`, ""];
  L.push("## Cut list", "", "| seg | start | end | seconds | motion area | ref | heatmap |", "|---|---|---|---|---|---|---|");
  for (const g of s.segments) L.push(`| ${pad2(g.index)} | ${g.start.toFixed(3)} | ${g.end.toFixed(3)} | ${g.seconds.toFixed(3)} | ${g.motion_area ?? "-"} | ${g.ref ?? "-"} | ${g.heatmap ?? "-"} |`);
  L.push("", "## Beat grid", "");
  const b = s.beat_grid;
  if (!b) L.push(s.transitions.length < 4 ? "Fewer than 4 transitions; no grid fitted." : "No regular grid: cuts do not sit on a beat (≥80% within 1.5 frames).");
  else {
    L.push(`Step ${b.step_frames} frames (${b.step_seconds} s), ${b.inliers}/${b.of} cuts on grid, max residual ${b.max_residual_frames} frames.`);
    // Many candidate steps are searched, so a handful of cuts fits some grid by chance.
    if (b.of < 8) L.push(`Weak: only ${b.of} cuts; treat this tempo as a guess and confirm it against the music.`);
    if (b.chance_inlier_rate > 0.5) L.push(`Weak: random cuts would land on a ${b.step_frames}-frame grid ${Math.round(b.chance_inlier_rate * 100)}% of the time.`);
    L.push(`If each step is an eighth note: ${b.bpm_if_eighth} BPM; if a quarter: ${b.bpm_if_quarter} BPM.`);
    if (b.outliers.length) L.push(`Off-grid cuts at: ${b.outliers.join(", ")} s.`);
  }
  L.push("", "## Palette", "");
  for (const c of s.palette.colors) L.push(`- ${c.hex} ${(c.share * 100).toFixed(1)}%`);
  const bp = s.palette.blue_purple;
  if (bp) L.push("", `Blue-purple frames: ${bp.frames}/${bp.of}${bp.flagged ? " (dominant blue-purple look)" : ""}.`);
  L.push("", "## Where to look", "");
  L.push("- `sheets/` contact sheets at 4 fps, 6 columns; times per cell are in breakdown.json `contact_sheets[].times`.");
  L.push("- `transitions/Tnn.jpg` 15 cells, every 2nd frame from 2 frames before each cut: how each transition is built.");
  L.push("- `heatmaps/segNN.png` red = where pixels move inside a segment; `motion_area` is the moving fraction.");
  L.push("- `ref/segNN.png` last clean frame of each segment at full resolution: the composition to match.");
  L.push("", "## Audio", "", audioText(s.audio));
  return L.join("\n") + "\n";
}

/** Break a reference video into cuts, beat grid, sheets, strips, heatmaps, refs and palette. */
export async function breakdownVideo(file, outDir, { fps, music = [] } = {}) {
  if (!fs.existsSync(file)) throw new Error(`${file} not found`);
  const meta = probeMeta(file);
  const rate = Math.min(fps || meta.fps, 60);
  claimDir(outDir);
  for (const d of ["transitions", "heatmaps", "ref"]) fs.mkdirSync(path.join(outDir, d));

  const d = await frameDiffs(file, rate);
  const S = detectStarts(d);
  const beat = fitBeatGrid(S, rate);
  const contact = contactSheets(file, outDir, meta.duration);

  transitionStrips(file, outDir, S, rate, meta.fps);
  const transitions = S.map((f, i) => ({ index: i + 1, time: r3(f / rate), frame: f, diff: Math.round(d[f] * 10) / 10, strip: `transitions/T${pad2(i + 1)}.jpg` }));

  const hw = 480;
  const hh = Math.max(2, Math.round((480 * meta.height) / meta.width / 2) * 2);
  const bounds = [0, ...S.map((f) => f / rate), meta.duration];
  const segments = [];
  const windows = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const [start, end] = [bounds[i], bounds[i + 1]];
    if (end - start <= 0) continue;
    segments.push({ index: i + 1, start: r3(start), end: r3(end), seconds: r3(end - start), motion_area: null, heatmap: null, ref: `ref/seg${pad2(i + 1)}.png` });
    // Skip the transition itself: from start + 0.35 s to 2 frames before the next cut.
    windows.push({ from: start + 0.35, to: end - 2 / rate, mid: (start + end) / 2 });
  }
  const maps = await motionMaps(file, windows, rate, hw, hh);
  const raws = [];
  maps.forEach((mp, k) => {
    if (!mp) return;
    const g = segments[k];
    g.motion_area = mp.area;
    g.heatmap = `heatmaps/seg${pad2(g.index)}.png`;
    const raw = path.join(outDir, "heatmaps", `.seg${pad2(g.index)}.rgb`);
    fs.writeFileSync(raw, mp.rgb);
    raws.push({ input: ["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${hw}x${hh}`, "-i", raw], out: path.join(outDir, g.heatmap) });
  });
  ffBatch(raws);
  for (const r of raws) fs.rmSync(r.input.at(-1));
  // Last clean frame: 3 frames before the next cut, full resolution.
  ffBatch(segments.map((g) => ({ input: ["-ss", String(Math.max(g.start, g.end - 3 / rate)), "-i", file], out: path.join(outDir, g.ref) })));

  const summary = {
    source: path.resolve(file),
    duration: r3(meta.duration),
    width: meta.width,
    height: meta.height,
    fps: r3(meta.fps),
    analysis_fps: r3(rate),
    transitions,
    segments,
    beat_grid: beat,
    contact_sheets: contact,
    palette: await palette(file, meta.duration, meta.width, meta.height),
    audio: analyzeAudio(file, music),
  };
  fs.writeFileSync(path.join(outDir, "breakdown.json"), JSON.stringify(summary, null, 2) + "\n");
  fs.writeFileSync(path.join(outDir, "breakdown.md"), markdown(summary));
  return summary;
}
