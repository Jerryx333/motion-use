// Beat analysis for imported music, and transient peaks for sound effects.
// Spectral-flux onsets, a joint tempo/phase comb search, the downbeat from low-band
// (kick) onsets, per-bar loudness and the biggest lift ("the drop"). Assumes 4/4.
import { spawnSync } from "node:child_process";

const SR = 22050;
const FRAME = 1024;
const HOP = 256;
const r3 = (x) => Math.round(x * 1000) / 1000;

/** Align a detected drop and the 4/4 bar grid to film time. Analysis uses song seconds. */
export function alignDrop(analysis, dropAt) {
  if (!Number.isFinite(dropAt) || dropAt < 0) throw new Error("--drop-at takes a finite, non-negative film second");
  if (!analysis.drop) throw new Error("cannot align --drop-at: no drop detected in the song");
  const offset = analysis.drop.start - dropAt;
  if (offset < 0) throw new Error(`the song's drop is too early: it can land at film second ${analysis.drop.start} at most`);
  const from = r3(offset), bar = 240 / analysis.bpm;
  const starts = analysis.bars.map((b) => b.start);
  // Loudness bars contain only complete bars; include the final partial bar line too.
  const tail = r3(starts.at(-1) + bar);
  if (tail < analysis.seconds) starts.push(tail);
  const film_bars = starts.filter((t) => t >= from && t < analysis.seconds).slice(0, 64).map((t) => r3(t - from));
  return { from, film_bars };
}

/** Decode an audio (or video) file to mono float samples. */
export function decodeMono(file, { rate = SR, from = 0, length } = {}) {
  const args = ["-v", "error", ...(from > 0 ? ["-ss", String(from)] : []), "-i", file];
  if (length) args.push("-t", String(length));
  args.push("-vn", "-ac", "1", "-ar", String(rate), "-f", "f32le", "-");
  const r = spawnSync("ffmpeg", args, { maxBuffer: 1024 * 1024 * 1024 });
  if (r.error) throw new Error(r.error.code === "ENOENT" ? "ffmpeg not found; install ffmpeg" : r.error.message);
  if (r.status !== 0) throw new Error(`cannot decode ${file}: ${r.stderr.toString().trim().slice(-600)}`);
  const b = r.stdout;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength - (b.byteLength % 4)));
}

// In-place radix-2 FFT on real/imag arrays of length n (a power of two).
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const p = i + k, q = p + len / 2;
        const tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr;
        re[q] = re[p] - tr; im[q] = im[p] - ti;
        re[p] += tr; im[p] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Onset envelopes (full band and low band below ~150 Hz), one value per hop.
 *  Flux is taken per log-spaced band and averaged, so hi-hats do not outweigh the kick. */
export function onsets(samples, rate = SR) {
  const n = Math.max(0, Math.floor((samples.length - FRAME) / HOP) + 1);
  const bins = FRAME / 2, NB = 36, lo = 30, hi = Math.min(10000, rate / 2);
  const edges = Array.from({ length: NB + 1 }, (_, i) => Math.max(1, Math.round((lo * (hi / lo) ** (i / NB) * FRAME) / rate)));
  const bands = [];
  for (let i = 0; i < NB; i++) if (edges[i + 1] > edges[i] || !bands.length || edges[i] > bands.at(-1)[0]) bands.push([edges[i], Math.max(edges[i] + 1, edges[i + 1])]);
  const lowBands = bands.filter(([a]) => (a * rate) / FRAME < 150).length || 1;
  const win = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME));
  const full = new Float64Array(n), bass = new Float64Array(n);
  let prev = new Float64Array(bands.length);
  const re = new Float64Array(FRAME), im = new Float64Array(FRAME), pow = new Float64Array(bins);
  for (let f = 0; f < n; f++) {
    for (let i = 0; i < FRAME; i++) { re[i] = samples[f * HOP + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let b = 0; b < bins; b++) pow[b] = re[b] * re[b] + im[b] * im[b];
    const cur = new Float64Array(bands.length);
    let s = 0, sl = 0;
    bands.forEach(([a, z], k) => {
      let e = 0;
      for (let b = a; b < z && b < bins; b++) e += pow[b];
      cur[k] = Math.log10(1e-10 + e / (z - a));
      const d = cur[k] - prev[k];
      if (d > 0) { s += d; if (k < lowBands) sl += d; }
    });
    full[f] = s / bands.length; bass[f] = sl / lowBands;
    prev = cur;
  }
  return { full: normalize(full), bass: normalize(bass), fps: rate / HOP };
}

// Remove the slow trend (0.5 s moving mean), keep the rises, scale to unit max.
function normalize(x) {
  const w = 43, out = new Float64Array(x.length);
  let acc = 0;
  for (let i = 0; i < x.length; i++) {
    acc += x[i];
    if (i >= w) acc -= x[i - w];
    out[i] = Math.max(0, x[i] - acc / Math.min(i + 1, w));
  }
  const m = Math.max(1e-9, ...out);
  return out.map((v) => v / m);
}

// Envelope value at time t; frame f is centred at (f·HOP + FRAME/2) / rate.
const at = (env, fps, t) => {
  const x = Math.max(0, t * fps - FRAME / (2 * HOP)), i = Math.floor(x);
  if (i + 1 >= env.length) return 0;
  return env[i] + (env[i + 1] - env[i]) * (x - i);
};

// Mean envelope over a beat grid; a ±1 hop window forgives small timing jitter.
function comb(env, fps, period, phase, end) {
  let s = 0, k = 0;
  for (let t = phase; t < end; t += period, k++)
    s += Math.max(at(env, fps, t - 1 / fps), at(env, fps, t), at(env, fps, t + 1 / fps));
  return k ? s / k : 0;
}

/** Tempo, beat grid, downbeat, per-bar loudness and the drop from mono samples. */
export function analyzeBeats(samples, rate = SR, { minBpm = 60, maxBpm = 200 } = {}) {
  const seconds = samples.length / rate;
  if (seconds < 4) throw new Error("need at least 4 seconds of audio to find a beat");
  const { full, bass, fps } = onsets(samples, rate);
  // Coarse tempo: autocorrelation weighted toward 120 BPM to settle octave doubts.
  const ac = (lag) => {
    let s = 0;
    for (let i = lag; i < full.length; i++) s += full[i] * full[i - lag];
    return s / (full.length - lag);
  };
  const cands = [];
  for (let lag = Math.floor((60 * fps) / maxBpm); lag <= Math.ceil((60 * fps) / minBpm); lag++) {
    const bpm = (60 * fps) / lag;
    const w = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    cands.push({ lag, score: ac(lag) * w });
  }
  cands.sort((a, b) => b.score - a.score);
  // Fine joint search over tempo and phase around the best lags and their octaves,
  // keeping the tempo prior (a grid at half speed always fits at least as well).
  const prior = (bpm) => Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
  const centers = [...new Set(cands.slice(0, 3).flatMap((c) => [0.5, 1, 2].map((m) => Math.round(((60 * fps) / c.lag) * m * 10) / 10)))]
    .filter((b) => b >= minBpm && b <= maxBpm);
  let best = { score: -1 };
  for (const center of centers) {
    for (let bpm = center * 0.97; bpm <= center * 1.03; bpm += 0.05) {
      const period = 60 / bpm;
      for (let ph = 0; ph < period; ph += 1 / fps) {
        const raw = comb(full, fps, period, ph, seconds), s = raw * prior(bpm);
        if (s > best.score) best = { score: s, raw, bpm, period, phase: ph };
      }
    }
  }
  // Refine the phase to a millisecond.
  for (let ph = best.phase - 2 / fps; ph <= best.phase + 2 / fps; ph += 0.001) {
    const raw = comb(full, fps, best.period, ph, seconds);
    if (ph >= 0 && raw > best.raw) best = { ...best, raw, phase: ph };
  }
  const { period } = best;
  // The grid starts at the first sound, not inside a silent intro.
  let peakAmp = 0, firstSound = 0;
  for (let i = 0; i < samples.length; i++) peakAmp = Math.max(peakAmp, Math.abs(samples[i]));
  while (firstSound < samples.length - 1 && Math.abs(samples[firstSound]) < peakAmp * 0.001) firstSound++;
  // 40 ms of slack: a beat a few ms before the first sound (or before zero) is that sound.
  const soundAt = firstSound / rate - 0.04;
  const beats = [];
  for (let t = best.phase + Math.ceil((soundAt - best.phase) / period) * period; t < seconds; t += period) beats.push(Math.max(0, t));
  // Confidence: the grid against the best grid 7% off tempo. A steady beat drifts off its onsets
  // within a few bars when detuned; speech or rubato scores about the same either way (~1).
  let detuned = 0;
  for (const m of [1.07, 1 / 1.07])
    for (let ph = 0; ph < period * m; ph += 1 / fps) detuned = Math.max(detuned, comb(full, fps, period * m, ph, seconds));
  const mean = detuned;
  // Downbeat: of the four positions in a bar, the one whose beats carry the most kick.
  const pos = [0, 1, 2, 3].map((j) => {
    let s = 0, k = 0;
    for (let i = j; i < beats.length; i += 4, k++) s += at(bass, fps, beats[i]) + 0.25 * at(full, fps, beats[i]);
    return k ? s / k : 0;
  });
  const j = pos.indexOf(Math.max(...pos));
  const sortedPos = [...pos].sort((a, b) => b - a);
  // The earliest downbeat: step back whole bars from the one found (a song may open on beat one).
  const bar = 4 * period;
  const downbeat = Math.max(0, beats[j] - Math.max(0, Math.floor((beats[j] - soundAt) / bar)) * bar);
  // Per-bar loudness from the first downbeat; the drop is the biggest lift over the 4 bars before.
  const bars = [];
  for (let t = downbeat; t + bar <= seconds + 1e-6; t += bar) {
    const i0 = Math.floor(t * rate), i1 = Math.min(samples.length, Math.floor((t + bar) * rate));
    let s = 0;
    for (let i = i0; i < i1; i++) s += samples[i] * samples[i];
    bars.push({ start: r3(t), db: Math.round(10 * Math.log10(s / Math.max(1, i1 - i0) + 1e-12) * 10) / 10 });
  }
  let drop = null;
  for (let i = 2; i < bars.length; i++) {
    const before = bars.slice(Math.max(0, i - 4), i);
    const lift = bars[i].db - before.reduce((a, b) => a + b.db, 0) / before.length;
    if (lift >= 3 && (!drop || lift > drop.lift_db)) drop = { start: bars[i].start, bar: i, lift_db: Math.round(lift * 10) / 10 };
  }
  return {
    seconds: r3(seconds),
    bpm: Math.round(best.bpm * 10) / 10,
    beat_seconds: r3(period),
    first_beat: r3(beats[0]),
    downbeat: r3(downbeat),
    // Grid score over the best detuned grid: ~1 is no steady beat.
    confidence: Math.round((best.raw / Math.max(1e-9, mean)) * 10) / 10,
    downbeat_confidence: Math.round((sortedPos[0] / Math.max(1e-9, sortedPos[1])) * 100) / 100,
    beats: beats.map(r3),
    bars,
    drop,
  };
}

/** Seconds from `offset` to the loudest sample of a clip: where a sound effect actually hits. */
export function peakTime(file, { offset = 0, length } = {}) {
  const rate = 48000;
  const s = decodeMono(file, { rate, from: offset, length });
  let k = 0, m = -1;
  for (let i = 0; i < s.length; i++) {
    const v = Math.abs(s[i]);
    if (v > m) { m = v; k = i; }
  }
  return k / rate;
}
