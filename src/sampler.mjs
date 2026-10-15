// Plays a score (src/score.mjs) with real recorded instruments from the instrument pack and a few
// synthesized voices, through a stereo reverb, into a WAV of exactly the film's length.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const SR = 44100;
const hz = (m) => 440 * 2 ** ((m - 69) / 12);

export const PACK_VERSION = "1.0.0";
export const packRoot = () =>
  process.env.MOTION_USE_INSTRUMENTS || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "motion-use", "instruments");
export const packDir = () => path.join(packRoot(), PACK_VERSION);

// —— synthesized voices: always available, for electronic and abstract films ——
function envelope(n, attack, release, hold) {
  const e = new Float32Array(n), a = Math.max(1, Math.floor(attack * SR)), r = Math.max(1, Math.floor(release * SR)), h = Math.min(n, Math.floor(hold * SR));
  for (let i = 0; i < n; i++) {
    let v = i < a ? i / a : 1;
    if (i >= h) v *= Math.max(0, 1 - (i - h) / r);
    e[i] = v;
  }
  return e;
}
function onePole(x, k) {
  let y = 0;
  for (let i = 0; i < x.length; i++) x[i] = y += k * (x[i] - y);
  return x;
}
const SYNTH = {
  pad: { family: "pad", sustain: true, range: [24, 96], release: 1.2, gain: 0.5, render(m, dur, vel) {
    const f = hz(m), n = Math.floor((dur + 1.2) * SR), x = new Float32Array(n);
    for (let i = 0; i < n; i++) { const t = i / SR; x[i] = ((t * f * 0.996) % 1) + ((t * f * 1.004 + 0.3) % 1) + ((t * f * 0.5) % 1) * 0.5 - 1.25; }
    onePole(x, 0.04); onePole(x, 0.04);
    const e = envelope(n, Math.min(0.8, dur / 2), 1.2, dur);
    for (let i = 0; i < n; i++) x[i] *= e[i] * vel;
    return x;
  } },
  drone: { family: "pad", sustain: true, range: [24, 72], release: 2, gain: 0.6, render(m, dur, vel) {
    const f = hz(m), n = Math.floor((dur + 2) * SR), x = new Float32Array(n);
    for (let i = 0; i < n; i++) { const t = i / SR; x[i] = Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(3 * Math.PI * f * t + 0.4 * Math.sin(t * 0.3)) + 0.25 * Math.sin(4 * Math.PI * f * t); }
    const e = envelope(n, Math.min(2, dur / 2), 2, dur);
    for (let i = 0; i < n; i++) x[i] *= e[i] * vel * 0.5;
    return x;
  } },
  bass: { family: "bass", sustain: true, range: [24, 60], release: 0.15, gain: 0.8, render(m, dur, vel) {
    const f = hz(m), n = Math.floor((dur + 0.15) * SR), x = new Float32Array(n);
    for (let i = 0; i < n; i++) { const t = i / SR; x[i] = Math.sin(2 * Math.PI * f * t) * 0.85 + (2 * ((t * f) % 1) - 1) * 0.12; }
    const e = envelope(n, 0.01, 0.15, dur);
    for (let i = 0; i < n; i++) x[i] *= e[i] * vel;
    return x;
  } },
  "string-pluck": { family: "pluck", sustain: false, range: [36, 96], release: 0.1, gain: 0.9, render(m, dur, vel) {
    const f = hz(m), n = Math.floor(Math.max(1.2, dur) * SR), x = new Float32Array(n), amps = [1, 0.55, 0.32, 0.2, 0.12, 0.07];
    for (let k = 1; k <= amps.length; k++) {
      const fk = f * k * Math.sqrt(1 + 0.0004 * k * k);
      if (fk > 16000) break;
      const decay = 3 * (1 + 0.6 * (k - 1)), attack = Math.min(0.035, 0.01 * (1 + 0.6 * (k - 1)));
      for (let i = 0; i < n; i++) { const t = i / SR; x[i] += amps[k - 1] * Math.sin(2 * Math.PI * fk * t) * Math.exp(-t * decay) * Math.min(1, t / attack); }
    }
    for (let i = 0; i < n; i++) x[i] *= vel * 0.5;
    return x;
  } },
  "synth-pluck": { family: "pluck", sustain: false, range: [36, 100], release: 0.05, gain: 0.7, render(m, dur, vel) {
    const f = hz(m), n = Math.floor(0.7 * SR), x = new Float32Array(n);
    for (let i = 0; i < n; i++) { const t = i / SR; x[i] = (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t)) * Math.exp(-t * 6) * vel; }
    return x;
  } },
  square: { family: "keys", sustain: false, range: [36, 100], release: 0.05, gain: 0.35, render(m, dur, vel) {
    const f = hz(m), n = Math.floor(Math.max(0.15, dur) * SR), x = new Float32Array(n);
    for (let i = 0; i < n; i++) { const t = i / SR; x[i] = ((t * f) % 1 < 0.5 ? 1 : -1) * Math.exp(-t * 3) * vel * 0.5; }
    return x;
  } },
  // Struck metal from inharmonic partials: a bronze bell (编钟-like with low m), a chime higher up.
  bell: { family: "bell", sustain: false, range: [36, 96], release: 0.3, gain: 0.7, render(m, dur, vel) {
    const f = hz(m), n = Math.floor(6 * SR), x = new Float32Array(n);
    const parts = [[0.5, 0.35, 0.6], [1, 1, 0.9], [1.19, 0.5, 1.3], [1.56, 0.4, 1.6], [2, 0.45, 1.8], [2.51, 0.25, 2.4], [2.66, 0.2, 2.6], [3.01, 0.15, 3]];
    for (const [r, a, d] of parts) {
      const fk = f * r;
      if (fk > 15000) continue;
      for (let i = 0; i < n; i++) { const t = i / SR; x[i] += a * Math.sin(2 * Math.PI * fk * t) * Math.exp(-t * d) * Math.min(1, t / 0.002); }
    }
    for (let i = 0; i < n; i++) x[i] *= vel * 0.35;
    return x;
  } },
  kick: { family: "drum", pitched: false, sustain: false, release: 0.05, gain: 0.9, hits: { soft: 0.5, hard: 1 }, render(hit, dur, vel) {
    const n = Math.floor(0.45 * SR), x = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) { const t = i / SR; ph += (110 * Math.exp(-t * 18) + 45) / SR; x[i] = Math.sin(2 * Math.PI * ph) * Math.exp(-t * 8) * vel * SYNTH.kick.hits[hit]; }
    return x;
  } },
  hat: { family: "metal", pitched: false, sustain: false, release: 0.02, gain: 0.25, hits: { closed: 40, open: 9 }, render(hit, dur, vel, rng) {
    const n = Math.floor((hit === "open" ? 0.4 : 0.08) * SR), x = new Float32Array(n);
    let prev = 0;
    for (let i = 0; i < n; i++) { const w = rng() * 2 - 1; x[i] = (w - prev) * Math.exp((-i / SR) * SYNTH.hat.hits[hit]) * vel; prev = w; }
    return x;
  } },
  riser: { family: "fx", pitched: false, sustain: true, release: 0.1, gain: 0.3, hits: { up: 1 }, render(hit, dur, vel, rng) {
    const n = Math.floor(dur * SR), x = new Float32Array(n);
    let y = 0;
    for (let i = 0; i < n; i++) { const p = i / n, k = 0.01 + 0.4 * p * p; y += k * ((rng() * 2 - 1) - y); x[i] = y * p * p * vel * 2; }
    return x;
  } },
};
for (const s of Object.values(SYNTH)) {
  s.synth = true;
  s.pitched ??= true;
}

/** Synthesized voices plus every instrument of the installed pack: {name: definition}. */
export function loadInstruments(dir = packDir()) {
  const out = {};
  for (const [k, v] of Object.entries(SYNTH)) out[k] = { ...v, label: `${k} (synthesized)` };
  const manifest = path.join(dir, "manifest.json");
  if (fs.existsSync(manifest)) {
    const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
    for (const [k, v] of Object.entries(m.instruments ?? {})) out[k] = { ...v, dir, pack: m.version };
  }
  return out;
}
export const packInstalled = (dir = packDir()) => fs.existsSync(path.join(dir, "manifest.json"));

// —— decoded samples, cached by file content ——
const decoded = new Map();
function decode(file) {
  if (decoded.has(file)) return decoded.get(file);
  const st = fs.statSync(file);
  const key = crypto.createHash("sha1").update(`${file}:${st.size}:${st.mtimeMs}`).digest("hex");
  const cacheDir = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "motion-use", "samples");
  const cached = path.join(cacheDir, `${key}.f32`);
  let buf;
  if (fs.existsSync(cached)) buf = fs.readFileSync(cached);
  else {
    buf = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "f32le", "-ac", "2", "-ar", String(SR), "-"], { maxBuffer: 1 << 28 });
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cached, buf);
  }
  const f = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  decoded.set(file, f);
  return f;
}

function chooseSample(ins, midi, vel) {
  const v = Math.min(1, vel);
  const layer = ins.samples.filter((s) => v >= s.vel[0] && v <= s.vel[1] + 1e-9);
  const pool = layer.length ? layer : ins.samples;
  return pool.reduce((best, s) => (Math.abs(s.root - midi) < Math.abs(best.root - midi) ? s : best), pool[0]);
}

// Freeverb (Jezar's public-domain design): eight combs and four allpasses per side.
function reverb(inL, inR, { size = 0.7, damp = 0.5 } = {}) {
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], alls = [556, 441, 341, 225], spread = 23;
  const fb = 0.7 + 0.28 * Math.min(1, Math.max(0, size)), d = 0.4 * Math.min(1, Math.max(0, damp));
  const run = (x, off) => {
    const out = new Float32Array(x.length);
    for (const len0 of combs) {
      const len = len0 + off, buf = new Float32Array(len);
      let idx = 0, store = 0;
      for (let i = 0; i < x.length; i++) {
        const y = buf[idx];
        store = y * (1 - d) + store * d;
        buf[idx] = x[i] * 0.015 + store * fb;
        out[i] += y;
        if (++idx >= len) idx = 0;
      }
    }
    for (const len0 of alls) {
      const len = len0 + off, buf = new Float32Array(len);
      let idx = 0;
      for (let i = 0; i < out.length; i++) {
        const b = buf[idx], o = -out[i] + b;
        buf[idx] = out[i] + b * 0.5;
        out[i] = o;
        if (++idx >= len) idx = 0;
      }
    }
    return out;
  };
  return [run(inL, 0), run(inR, spread)];
}

const SEND = { pad: 0.35, pluck: 0.35, keys: 0.25, mallet: 0.35, bell: 0.5, drum: 0.18, metal: 0.4, wood: 0.15, strings: 0.35, winds: 0.3, brass: 0.25, bass: 0.05, fx: 0.3 };

/** Render a score to a stereo 16-bit WAV of exactly `seconds`. Returns {wav, report}. */
export function renderScore(score, seconds, instruments, seed = 1) {
  const N = Math.ceil(seconds * SR);
  const L = new Float32Array(N), R = new Float32Array(N), sendL = new Float32Array(N), sendR = new Float32Array(N);
  let s = seed >>> 0;
  const rng = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const report = { notes: 0, dropped: 0, clamped: 0, instruments: {} };
  for (const e of score.events) {
    const ins = instruments[e.instrument];
    if (!ins || !(e.t >= 0) || e.t >= seconds || !(e.vel > 0)) { report.dropped++; continue; }
    const tr = score.tracks[e.instrument] ?? {};
    const gain = (tr.gain ?? 1) * (ins.gain ?? 1);
    const pan = Math.max(-1, Math.min(1, e.pan ?? tr.pan ?? 0));
    const gl = Math.cos(((pan + 1) * Math.PI) / 4), gr = Math.sin(((pan + 1) * Math.PI) / 4);
    const send = tr.reverb ?? SEND[ins.family] ?? 0.25;
    const i0 = Math.floor(e.t * SR);
    let dur = e.dur;
    if (ins.sustain && ins.maxDur && dur > ins.maxDur) { dur = ins.maxDur; report.clamped++; }
    const amp = Math.pow(Math.min(1.5, e.vel), 1.5) * gain;
    const add = (l, r, k) => {
      const j = i0 + k;
      if (j >= N) return false;
      L[j] += l * gl; R[j] += r * gr; sendL[j] += l * gl * send; sendR[j] += r * gr * send;
      return true;
    };
    if (ins.synth) {
      const x = ins.render(e.pitch, dur, 1, rng);
      for (let k = 0; k < x.length; k++) if (!add(x[k] * amp, x[k] * amp, k)) break;
    } else if (ins.pitched) {
      const smp = chooseSample(ins, e.pitch, e.vel);
      const data = decode(path.join(ins.dir, smp.file));
      const frames = data.length / 2, rate = 2 ** ((e.pitch - smp.root) / 12 - (smp.cents ?? 0) / 1200);
      const natural = frames / rate, rel = Math.floor((ins.release ?? 0.2) * SR);
      const hold = ins.sustain ? Math.floor(dur * SR) : Math.floor((e.ring ?? Infinity) * SR);
      const len = Math.min(Math.floor(natural), hold + rel);
      const atk = Math.floor(0.003 * SR);
      for (let k = 0; k < len; k++) {
        const p = k * rate, q = Math.floor(p), fr = p - q, a = 2 * q;
        if (a + 3 >= data.length) break;
        let g = amp * (k < atk ? k / atk : 1);
        if (k > hold) g *= Math.max(0, 1 - (k - hold) / rel);
        if (!add((data[a] + (data[a + 2] - data[a]) * fr) * g, (data[a + 1] + (data[a + 3] - data[a + 1]) * fr) * g, k)) break;
      }
    } else {
      // Unpitched hit: a variant of this velocity layer, round-robin by the seeded random.
      const variants = ins.hits[e.pitch], v = Math.min(1, e.vel);
      const layer = variants.filter((x) => v >= x.vel[0] && v <= x.vel[1] + 1e-9);
      const pool = layer.length ? layer : variants;
      const data = decode(path.join(ins.dir, pool[Math.floor(rng() * pool.length)].file));
      const len = data.length / 2, atk = Math.floor(0.002 * SR);
      for (let k = 0; k < len; k++) { const g = amp * (k < atk ? k / atk : 1); if (!add(data[2 * k] * g, data[2 * k + 1] * g, k)) break; }
    }
    report.notes++;
    report.instruments[e.instrument] = (report.instruments[e.instrument] ?? 0) + 1;
  }
  const room = score.room ?? {};
  const [wl, wr] = reverb(sendL, sendR, room);
  const wet = room.wet ?? 1;
  let peak = 1e-9;
  const fi = Math.floor(0.02 * SR), fo = Math.floor(0.05 * SR);
  for (let i = 0; i < N; i++) {
    let g = 1;
    if (i < fi) g = i / fi;
    if (i > N - fo) g *= (N - i) / fo;
    L[i] = Math.tanh((L[i] + wl[i] * wet) * g);
    R[i] = Math.tanh((R[i] + wr[i] * wet) * g);
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  const norm = 0.89 / peak;
  const pcm = Buffer.alloc(N * 4);
  for (let i = 0; i < N; i++) {
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * norm)) * 32767), i * 4);
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * norm)) * 32767), i * 4 + 2);
  }
  report.peakBeforeNormalize = peak;
  return { wav: wav(pcm), report };
}

function wav(pcm) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
