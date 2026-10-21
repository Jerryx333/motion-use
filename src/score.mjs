// A film's own music: composition/score.js, written for this film the way draw.js is, turned into
// plain note events. The score runs in a separate context with a seeded random and no clock, so
// the same film always gives the same music; src/sampler.mjs plays the events.
import fs from "node:fs";
import vm from "node:vm";

const NAMES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "D4" → 62, "F#3" → 54, "Bb2" → 46; a number passes through. */
export function midiOf(p) {
  if (typeof p === "number") return p;
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(String(p).trim());
  if (!m) return NaN;
  return 12 * (Number(m[3]) + 1) + NAMES[m[1].toUpperCase()] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
}

export const MODES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  "harmonic-minor": [0, 2, 3, 5, 7, 8, 11],
  // 五声调式：宫商角徵羽，各以本音为主音
  gong: [0, 2, 4, 7, 9],
  shang: [0, 2, 5, 7, 10],
  jue: [0, 3, 5, 8, 10],
  zhi: [0, 2, 5, 7, 9],
  yu: [0, 3, 5, 7, 10],
  hirajoshi: [0, 2, 3, 7, 8],
  in: [0, 1, 5, 7, 8],
  blues: [0, 3, 5, 6, 7, 10],
  "whole-tone": [0, 2, 4, 6, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hashString = (s) => {
  let h = 2166136261;
  for (const ch of String(s)) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return h >>> 0;
};

class Motif {
  constructor(deg, dur) {
    this.deg = [...deg];
    this.dur = dur ? [...dur] : deg.map(() => 1);
    if (this.dur.length !== this.deg.length) throw new Error("motif: degrees and durations must have the same length");
  }
  transpose(n) { return new Motif(this.deg.map((d) => (d === null ? null : d + n)), this.dur); }
  invert(axis = this.deg.find((d) => d !== null) ?? 0) { return new Motif(this.deg.map((d) => (d === null ? null : 2 * axis - d)), this.dur); }
  retro() { return new Motif([...this.deg].reverse(), [...this.dur].reverse()); }
  augment(k) { return new Motif(this.deg, this.dur.map((d) => d * k)); }
  then(other) { return new Motif([...this.deg, ...other.deg], [...this.dur, ...other.dur]); }
  get beats() { return this.dur.reduce((a, b) => a + b, 0); }
}

/** The helper object `S` a score is written against. */
function makeHelpers(film, instruments) {
  const events = [], tracks = {}, notes = [];
  const shots = Object.fromEntries(film.shots.map((s) => [s.id, s]));
  const state = { why: null, tempo: 90, meter: 4, key: null, arc: null, room: { size: 0.7, damp: 0.5, wet: 1 } };
  const rng = mulberry32(hashString(film.name || "film"));
  const shot = (id) => {
    const s = shots[id];
    if (!s) throw new Error(`score: no shot "${id}" (shots: ${Object.keys(shots).join(", ")})`);
    return { start: s.start, end: s.end, dur: s.end - s.start, authoredDuration: s.authoredDuration };
  };
  const level = (t) => {
    const a = state.arc;
    if (!a?.length) return 1;
    if (t <= a[0][0]) return a[0][1];
    for (let i = 1; i < a.length; i++)
      if (t <= a[i][0]) {
        const [t0, v0] = a[i - 1], [t1, v1] = a[i];
        const e = (t - t0) / Math.max(1e-6, t1 - t0);
        return v0 + (v1 - v0) * (e * e * (3 - 2 * e));
      }
    return a.at(-1)[1];
  };
  const S = {
    duration: film.duration,
    shots: film.shots.map((s) => ({ id: s.id, start: s.start, end: s.end })),
    instruments: Object.fromEntries(Object.entries(instruments).map(([k, v]) => [k, { family: v.family, pitched: v.pitched, sustain: v.sustain, range: v.range, hits: v.hits ? Object.keys(v.hits) : undefined, maxDur: v.maxDur ?? null, label: v.label }])),
    why(text) { state.why = String(text); },
    tempo(bpm) { state.tempo = bpm; },
    meter(n) { state.meter = n; },
    room(o) { Object.assign(state.room, o); },
    beats: (n = 1) => (n * 60) / state.tempo,
    bars: (n = 1) => (n * state.meter * 60) / state.tempo,
    shot,
    has: (id) => Object.hasOwn(shots, id),
    rhythmPhase: (id) => {
      const phase = film.rhythm?.phases?.find((p) => p.id === id);
      if (!phase) throw new Error(`score: no rhythm phase "${id}"`);
      return { ...phase, ...(phase.shots ? { shots: [...phase.shots] } : {}) };
    },
    rhythmEvent: (id) => {
      const event = film.rhythm?.events?.find((e) => e.id === id);
      if (!event) throw new Error(`score: no rhythm event "${id}"`);
      return event.at;
    },
    at: (id, offset = 0) => { const s = shot(id); return s.start + offset * (s.authoredDuration ? s.dur / s.authoredDuration : 1); },
    end: (id, offset = 0) => { const s = shot(id); return s.end + offset * (s.authoredDuration ? s.dur / s.authoredDuration : 1); },
    /** Narration windows [{start, end}] in film seconds: leave them room. */
    voice: film.voice ?? [],
    speaking: (t) => (film.voice ?? []).some((w) => t >= w.start && t < w.end),
    rng,
    humanize: (t, amount = 0.012) => t + (rng() * 2 - 1) * amount,
    pick: (list) => list[Math.floor(rng() * list.length)],
    /** A scale as a function: deg(0) is the tonic at `octave`; negative and large degrees wrap octaves. */
    scale(root, mode = "major", octave = 4) {
      const steps = Array.isArray(mode) ? mode : MODES[mode];
      if (!steps) throw new Error(`score: unknown mode "${mode}" (${Object.keys(MODES).join(", ")})`);
      const base = midiOf(typeof root === "number" ? root : `${root}${octave}`);
      if (!Number.isFinite(base)) throw new Error(`score: unknown root "${root}"`);
      if (!state.key) state.key = `${typeof root === "number" ? root : root} ${Array.isArray(mode) ? "custom" : mode}`;
      const fn = (deg, oct = 0) => {
        const n = steps.length, o = Math.floor(deg / n);
        return base + 12 * (o + oct) + steps[((deg % n) + n) % n];
      };
      fn.steps = steps;
      fn.root = base;
      return fn;
    },
    /** Stack every other scale degree from `deg`: a triad (size 3) or a seventh (size 4). */
    chordOf: (scale, deg, size = 3, oct = 0) => Array.from({ length: size }, (_, i) => scale(deg + 2 * i, oct)),
    motif: (deg, dur) => new Motif(deg, dur),
    /** Times from `from` to `to` every `step` beats (plus `offset` beats). */
    grid(from, to, step = 1, offset = 0) {
      const out = [], dt = S.beats(step);
      for (let t = from + S.beats(offset); t < to - 1e-6; t += dt) out.push(t);
      return out;
    },
    /** Dynamics over the film: [[seconds or shot id, level 0–1], …]; note velocities follow it. */
    arc(points) {
      state.arc = points.map(([at, v]) => [typeof at === "string" ? shot(at).start : at, v]).sort((a, b) => a[0] - b[0]);
    },
    level,
    track(instrument, o = {}) { tracks[instrument] = { ...(tracks[instrument] ?? {}), ...o }; },
    /** One note. pitch: midi number, "D4", or a hit name for unpitched instruments. */
    note(instrument, t, pitch, o = {}) {
      const vel = (o.vel ?? 0.7) * (o.raw ? 1 : level(t));
      events.push({ instrument, t, pitch: typeof pitch === "string" && /^[A-Ga-g][#b]?-?\d$/.test(pitch) ? midiOf(pitch) : pitch, dur: o.dur ?? S.beats(1), vel, pan: o.pan, ring: o.ring });
    },
    chord(instrument, t, pitches, o = {}) {
      pitches.forEach((p, i) => S.note(instrument, t + i * (o.strum ?? 0), p, o));
    },
    /** Play a motif from `t` in `scale`; returns the time it ends. */
    phrase(instrument, t, motif, scale, o = {}) {
      let at = t;
      motif.deg.forEach((d, i) => {
        const len = S.beats(motif.dur[i]);
        if (d !== null) S.note(instrument, o.humanize === false ? at : S.humanize(at), scale(d + (o.transpose ?? 0), o.oct ?? 0), { ...o, dur: o.legato ? len * o.legato : len });
        at += len;
      });
      return at;
    },
  };
  return { S, state, events, tracks };
}

/** Run composition/score.js for `film` ({name, duration, shots, voice, copy, brief, look}). */
export function runScore(file, film, instruments) {
  const source = fs.readFileSync(file, "utf8");
  const { S, state, events, tracks } = makeHelpers(film, instruments);
  const context = vm.createContext({ window: {}, console: { log: () => {} }, __rng: S.rng });
  // The context's own intrinsics: a seeded Math.random, and no clock to make a score vary by run.
  vm.runInContext("Math.random = __rng; delete globalThis.__rng; delete globalThis.Date; delete globalThis.performance; Object.freeze(Math);", context);
  vm.runInContext(source, context, { filename: file, timeout: 5000 });
  const fn = context.window.scoreFilm;
  if (typeof fn !== "function") throw new Error(`${file} must define window.scoreFilm = function (film, S) { … }`);
  const view = JSON.parse(JSON.stringify({ name: film.name, duration: film.duration, shots: film.shots.map((s) => ({ id: s.id, start: s.start, end: s.end, purpose: s.purpose, action: s.action, camera: s.camera })), voice: film.voice ?? [], copy: film.copy ?? {}, brief: film.brief ?? {}, look: film.look ?? {}, rhythm: film.rhythm ?? null }));
  fn.call(null, view, S);
  return { why: state.why, tempo: state.tempo, meter: state.meter, key: state.key, room: state.room, tracks, events };
}

// Families that carry a line and compete with a voice; drums, bass and pads sit under it.
const MELODIC = new Set(["pluck", "keys", "mallet", "bell", "strings", "winds", "brass"]);

/** Problems a score can have before it is played: [{level: "error"|"warning", message}]. */
export function checkScore(score, film, instruments, installHint) {
  const out = [];
  const err = (message) => out.push({ level: "error", message });
  const warn = (message) => out.push({ level: "warning", message });
  if (!score.why || score.why.trim().length < 8)
    err('the score must say why this music fits this film: S.why("…instruments, mode, where it peaks and why…")');
  if (!score.events.length) err("the score plays no notes");
  const missing = new Set();
  let late = 0, ranged = 0;
  for (const e of score.events) {
    const ins = instruments[e.instrument];
    if (!ins) { missing.add(e.instrument); continue; }
    if (!(e.t >= 0) || e.t >= film.duration) late++;
    if (!(e.vel >= 0)) err(`${e.instrument} at ${e.t?.toFixed?.(2)} s: velocity must be a number ≥ 0`);
    if (ins.pitched) {
      if (!Number.isFinite(e.pitch)) err(`${e.instrument} at ${e.t.toFixed(2)} s: pitch ${JSON.stringify(e.pitch)} is not a note`);
      else if (e.pitch < ins.range[0] || e.pitch > ins.range[1]) ranged++;
    } else if (!ins.hits?.[e.pitch]) err(`${e.instrument} at ${e.t.toFixed(2)} s: hit "${e.pitch}" — this instrument plays ${Object.keys(ins.hits ?? {}).join(", ")}`);
  }
  for (const m of missing)
    err(`instrument "${m}" is not available${installHint ? ` (${installHint})` : ""}; available: ${Object.keys(instruments).join(", ")}`);
  if (late) warn(`${late} note(s) start outside the film (0–${film.duration.toFixed(2)} s) and are dropped`);
  if (ranged) {
    const ex = score.events.find((e) => instruments[e.instrument]?.pitched && (e.pitch < instruments[e.instrument].range[0] || e.pitch > instruments[e.instrument].range[1]));
    err(`${ranged} note(s) outside their instrument's range, e.g. ${ex.instrument} ${ex.pitch} at ${ex.t.toFixed(2)} s (range ${ex.instrument}: ${instruments[ex.instrument].range.join("–")})`);
  }
  // Busy melody under narration fights the voice.
  for (const w of film.voice ?? []) {
    const busy = score.events.filter((e) => e.t >= w.start && e.t < w.end && MELODIC.has(instruments[e.instrument]?.family));
    const rate = busy.length / Math.max(0.5, w.end - w.start);
    if (rate > 4) warn(`${busy.length} notes in ${(w.end - w.start).toFixed(1)} s of narration from ${w.start.toFixed(2)} s: thin the melody under speech (S.speaking(t))`);
  }
  return out;
}
