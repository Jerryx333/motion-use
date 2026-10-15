// Approximate reference-audio analysis, not speech recognition or source separation.
import { execFileSync } from "node:child_process";
import { decodeMono, fft } from "./beats.mjs";

const RATE = 2000;
export const MATCH_THRESHOLD = 0.5;
const round = (v) => Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
const quantile = (xs, q) => xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * q)] : null;
const db = (p) => p > 1e-12 ? 10 * Math.log10(p) : null;

function prefix(x) {
  const sum = new Float64Array(x.length + 1), power = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) { sum[i + 1] = sum[i] + x[i]; power[i + 1] = power[i] + x[i] ** 2; }
  return { sum, power };
}

// Linear FFT correlation. Prefix sums normalize every lag over its actual overlap.
export function matchMusic(ref, song) {
  let n = 1;
  while (n < ref.length + song.length) n *= 2;
  const a = new Float64Array(n), ai = new Float64Array(n), b = new Float64Array(n), bi = new Float64Array(n);
  a.set(ref); b.set(song);
  fft(a, ai); fft(b, bi);
  for (let i = 0; i < n; i++) {
    const re = b[i] * a[i] + bi[i] * ai[i];
    bi[i] = -(bi[i] * a[i] - b[i] * ai[i]); b[i] = re;
  }
  fft(b, bi);
  const rp = prefix(ref), sp = prefix(song);
  const minimum = Math.min(ref.length, song.length, Math.max(2 * RATE, ref.length * 0.5));
  let best = { offset: 0, ncc: 0, overlap_seconds: 0 };
  for (let lag = -ref.length + Math.ceil(minimum); lag <= song.length - minimum; lag++) {
    const start = Math.max(0, -lag), end = Math.min(ref.length, song.length - lag), count = end - start;
    const rs = rp.sum[end] - rp.sum[start], ss = sp.sum[end + lag] - sp.sum[start + lag];
    const re = rp.power[end] - rp.power[start] - rs * rs / count;
    const se = sp.power[end + lag] - sp.power[start + lag] - ss * ss / count;
    const cross = b[(lag + n) % n] / n - rs * ss / count;
    const score = cross / Math.sqrt(Math.max(1e-24, re * se));
    if (score > best.ncc) best = { offset: lag / RATE, ncc: score, overlap_seconds: count / RATE };
  }
  // Speech lowers whole-clip NCC. Report the upper quartile of short-window NCC
  // at the best lag, allowing pauses to establish a match under louder narration.
  const lag = Math.round(best.offset * RATE), scores = [];
  for (let i = Math.max(0, -lag); i + 400 <= Math.min(ref.length, song.length - lag); i += 400) {
    let xy = 0, xx = 0, yy = 0;
    for (let j = i; j < i + 400; j++) { xy += ref[j] * song[j + lag]; xx += ref[j] ** 2; yy += song[j + lag] ** 2; }
    if (xx > 1e-10 && yy > 1e-10) scores.push(xy / Math.sqrt(xx * yy));
  }
  return { offset_seconds: round(best.offset), ncc: round(quantile(scores, 0.75) ?? best.ncc), whole_clip_ncc: round(best.ncc), overlap_seconds: round(best.overlap_seconds) };
}

function pitch(x, start, end) {
  let energy = 0, crossings = 0;
  for (let i = start; i < end; i++) { energy += x[i] ** 2; if (i > start && x[i] * x[i - 1] < 0) crossings++; }
  let best = 0, lagBest = 0;
  const correlations = [];
  for (let lag = 5; lag <= 28; lag++) {
    let xy = 0, xx = 0, yy = 0;
    for (let i = start; i + lag < end; i++) { xy += x[i] * x[i + lag]; xx += x[i] ** 2; yy += x[i + lag] ** 2; }
    correlations[lag] = xy / Math.sqrt(Math.max(1e-24, xx * yy));
  }
  // First strong local peak avoids octave/subharmonic choices on near-periodic tones.
  for (let lag = 6; lag < 28; lag++) {
    const c = correlations[lag];
    if (c > 0.65 && c >= correlations[lag - 1] && c > correlations[lag + 1] && c > best) {
      best = c; lagBest = lag;
      if (c > 0.9) break;
    }
  }
  return { power: energy / (end - start), pitch: lagBest ? RATE / lagBest : null, periodicity: best, zcr: crossings / (end - start) };
}

export function analyzeAudio(file, music = []) {
  const streams = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "json", file], { encoding: "utf8" }));
  if (!streams.streams?.length) return { available: false, matches: [], notes: ["No audio stream; audio analysis skipped."], film_music: null };
  const ref = decodeMono(file, { rate: RATE });
  const candidates = music.map((file) => {
    const samples = decodeMono(file, { rate: RATE });
    const result = matchMusic(ref, samples);
    return { samples, result: { file, ...result, matched: result.ncc >= MATCH_THRESHOLD } };
  });
  const matched = candidates.filter((c) => c.result.matched).sort((a, b) => b.result.ncc - a.result.ncc)[0];
  const residual = new Float32Array(ref), frames = [], hop = 200;
  const lag = matched ? Math.round(matched.result.offset_seconds * RATE) : 0;
  for (let start = 0; start < ref.length; start += hop) {
    const end = Math.min(ref.length, start + hop);
    let xy = 0, xx = 0, covered = 0;
    if (matched) for (let i = start; i < end; i++) {
      const x = matched.samples[i + lag];
      if (x !== undefined) { xy += x * ref[i]; xx += x * x; covered++; }
    }
    const gain = xx > 1e-12 ? Math.max(0, xy / xx) : 0;
    for (let i = start; i < end; i++) residual[i] = ref[i] - gain * (matched?.samples[i + lag] ?? 0);
    frames.push({ start, end, gain, musicPower: gain * gain * xx / (end - start), covered: covered === end - start, ...pitch(residual, start, end) });
  }
  const peak = quantile(frames.map((f) => f.power), 0.9) ?? 0;
  for (const f of frames) f.speech = f.power > Math.max(1e-8, peak * 0.12) && f.pitch !== null && f.periodicity > 0.65 && f.zcr < 0.45;
  const windows = (speech) => {
    const out = [];
    for (const f of frames.filter((f) => f.speech === speech)) {
      const start = round(f.start / RATE), end = round(f.end / RATE);
      if (out.at(-1)?.end === start) out.at(-1).end = end;
      else out.push({ start, end });
    }
    return out;
  };
  const speech = frames.filter((f) => f.speech), notes = ["Estimates only: energy, periodicity and zero-crossing spectral proxy; tonal music can resemble speech. Pitch is a hint, not a voice identity."];
  let levels = null, filmMusic = null;
  if (matched) {
    const talk = speech.filter((f) => f.covered), pause = frames.filter((f) => !f.speech && f.covered);
    const mean = (xs, key) => xs.length ? xs.reduce((s, f) => s + f[key], 0) / xs.length : 0;
    const voiceDb = db(mean(talk, "power")), talkDb = db(mean(talk, "musicPower")), pauseDb = db(mean(pause, "musicPower"));
    // Expose fitted gains to help distinguish source-song dynamics from ducking.
    const talkGain = quantile(talk.map((f) => f.gain), 0.5), pauseGain = quantile(pause.map((f) => f.gain), 0.5);
    const reduction = talkDb !== null && pauseDb !== null ? pauseDb - talkDb : null;
    levels = { voice_dbfs: round(voiceDb), music_speech_dbfs: round(talkDb), music_pause_dbfs: round(pauseDb), music_below_voice_db: round(voiceDb !== null && talkDb !== null ? voiceDb - talkDb : null), pause_music_below_voice_db: round(voiceDb !== null && pauseDb !== null ? voiceDb - pauseDb : null), speech_reduction_db: round(reduction), ducked: reduction === null ? null : reduction >= 3, speech_gain: round(talkGain), pause_gain: round(pauseGain) };
    if (voiceDb !== null && talkDb !== null && matched.result.offset_seconds >= 0) {
      filmMusic = { file: matched.result.file, from: matched.result.offset_seconds, volume: round(10 ** ((talkDb - voiceDb) / 20)), ...(levels.ducked === null ? {} : { duck: levels.ducked }) };
      notes.push("Suggested volume is a music/voice RMS ratio for similarly normalized assets; calibrate against your own narration. Ducking ramps/depth are not reconstructed.");
    }
    if (matched.result.offset_seconds < 0) notes.push("Negative offset means music enters after the head; film.json music.from only accepts nonnegative values, so no directly usable music line is emitted.");
    if (!talk.length || !pause.length) notes.push("Insufficient covered speech or pause windows; missing levels/ducking remain null.");
  } else notes.push(music.length ? "No matched original song; music/voice levels skipped." : "No --music original song supplied; music/voice levels skipped.");
  return { available: true, estimated: true, sample_rate: RATE, match_threshold: MATCH_THRESHOLD, matches: candidates.map((c) => c.result), selected_music: matched?.result.file ?? null, speech_windows: windows(true), pause_windows: windows(false), pitch_median_hz: round(quantile(speech.map((f) => f.pitch), 0.5)), levels, film_music: filmMusic, notes };
}

export function audioText(a) {
  const lines = ["Audio (estimated)"];
  for (const m of a.matches) lines.push(`${m.file}: ${m.matched ? "matched" : "unmatched"}, offset ${m.offset_seconds}s, NCC ${m.ncc} (whole clip ${m.whole_clip_ncc}).`);
  if (a.available) lines.push(`Speech/pause windows: ${a.speech_windows.length}/${a.pause_windows.length}; speech pitch median: ${a.pitch_median_hz ?? "unavailable"} Hz (hint only).`);
  if (a.levels) lines.push(`Music below voice: speech ${a.levels.music_below_voice_db ?? "unavailable"} dB, pauses ${a.levels.pause_music_below_voice_db ?? "unavailable"} dB; speech reduction ${a.levels.speech_reduction_db ?? "unavailable"} dB; ducked: ${a.levels.ducked ?? "unknown"}.`);
  lines.push(...a.notes);
  if (a.film_music) lines.push(`film.json music: ${JSON.stringify(a.film_music)}`);
  return lines.join("\n");
}
