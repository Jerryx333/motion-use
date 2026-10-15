import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { midiOf, runScore, checkScore } from "../src/score.mjs";
import { renderScore, loadInstruments } from "../src/sampler.mjs";
import { recordRelease } from "../src/music-index.mjs";
import { validateFilm, initFilm } from "../src/film.mjs";
import { isStarterScore } from "../src/compose.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mu-score-"));
const film = { name: "test-film", duration: 8, shots: [{ id: "a", start: 0, end: 4 }, { id: "b", start: 4, end: 8 }], voice: [{ start: 1, end: 3 }] };
const instruments = loadInstruments(path.join(os.tmpdir(), "no-pack-here"));
const score = (dir, body) => {
  const f = path.join(dir, "score.js");
  fs.writeFileSync(f, `window.scoreFilm = function (film, S) {\n${body}\n};`);
  return f;
};

test("note names, five-tone modes and motif transforms", () => {
  assert.equal(midiOf("D4"), 62);
  assert.equal(midiOf("F#3"), 54);
  assert.equal(midiOf("Bb2"), 46);
  const dir = tmp();
  const r = runScore(score(dir, `S.why("five-tone test score");
    const sc = S.scale("D", "shang", 4);
    const m = S.motif([0, 1, 2, 5], [1, 1, 1, 1]);
    S.phrase("string-pluck", 0, m, sc, { humanize: false });
    S.phrase("string-pluck", 4, m.invert().transpose(-1), sc, { humanize: false });`), film, instruments);
  // 商调式 on D: D E G A C, then the next octave's D
  assert.deepEqual(r.events.slice(0, 4).map((e) => e.pitch), [62, 64, 67, 74]);
  // inverted around 0 and lowered by one degree: 0,-1,-2,-5 → -1,-2,-3,-6 (C4 A3 G3 C3)
  assert.deepEqual(r.events.slice(4).map((e) => e.pitch), [60, 57, 55, 48]);
  assert.equal(r.key, "D shang");
});

test("a score is deterministic: seeded random, no clock", () => {
  const dir = tmp();
  const f = score(dir, `S.why("random but repeatable notes");
    for (let i = 0; i < 20; i++) S.note("synth-pluck", Math.random() * 7, 60 + Math.floor(Math.random() * 12));
    if (typeof Date !== "undefined") throw new Error("the score saw a clock");`);
  const a = runScore(f, film, instruments), b = runScore(f, film, instruments);
  assert.deepEqual(a.events, b.events);
  const c = runScore(f, { ...film, name: "another-film" }, instruments);
  assert.notDeepEqual(a.events, c.events, "the seed follows the film");
});

test("score checks: reason, instruments, ranges and busy lines under narration", () => {
  const dir = tmp();
  const bad = runScore(score(dir, `S.note("erhu", 1, 60); S.note("bass", 1, 100);`), film, instruments);
  const msgs = checkScore(bad, film, instruments, "install it").map((p) => `${p.level}: ${p.message}`).join("\n");
  assert.match(msgs, /error: the score must say why/);
  assert.match(msgs, /error: instrument "erhu" is not available \(install it\)/);
  assert.match(msgs, /error: 1 note\(s\) outside their instrument's range, e\.g\. bass 100/);
  const busy = runScore(score(dir, `S.why("a busy line over the voice");
    for (let t = 1; t < 3; t += 0.1) S.note("string-pluck", t, 62);
    for (let t = 1; t < 3; t += 0.1) S.note("kick", t, "soft");`), film, instruments);
  const w = checkScore(busy, film, instruments).filter((p) => p.level === "warning");
  assert.equal(w.length, 1);
  assert.match(w[0].message, /^20 notes in 2\.0 s of narration/, "drums do not count, the pluck does");
});

test("synthesized voices render to the exact length without clipping", () => {
  const dir = tmp();
  const r = runScore(score(dir, `S.why("pad and bell length test");
    S.chord("pad", 0, [50, 57, 62], { dur: 6 });
    S.note("bell", 2, 74, { vel: 1 });
    S.note("kick", 4, "hard");`), film, instruments);
  const { wav, report } = renderScore(r, film.duration, instruments);
  assert.equal(wav.length - 44, Math.ceil(8 * 44100) * 4);
  assert.equal(report.notes, 5);
  let peak = 0;
  for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
  assert.ok(peak > 20000 && peak <= 32767 * 0.9, `peak ${peak}`);
});

test("films must choose their music: a built-in bed needs a reason, a score is accepted", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "composition"));
  fs.writeFileSync(path.join(dir, "composition", "draw.js"), "window.drawFrame=function(){}");
  fs.writeFileSync(path.join(dir, "composition", "score.js"), "window.scoreFilm=function(f,S){S.why('x film');S.note('pad',0,60)}");
  const base = { version: 1, kind: "film", name: "f", duration: 4, fps: 30, languages: ["en"], formats: ["landscape"], composition: "composition/draw.js", copy: { en: {} }, look: { style: "s", palette: "paper", character: "none" }, shots: [{ id: "a", start: 0, end: 4, purpose: "p", action: "a ball rolls across", camera: "push" }], voiceover: false };
  const bed = validateFilm({ ...base, music: { builtin: "pulse" } }, dir, {});
  assert.ok(bed.warnings.some((w) => w.path === "$.music.builtin" && /same bed in every film/.test(w.message)));
  const why = validateFilm({ ...base, music: { builtin: "pulse", why: "a deliberately generic bed for an internal test clip" } }, dir, {});
  assert.ok(!why.warnings.some((w) => w.path.startsWith("$.music")));
  const scored = validateFilm({ ...base, music: { score: "composition/score.js", volume: 0.5 } }, dir, {});
  assert.deepEqual(scored.errors, []);
  assert.equal(scored.film.scoreFile, path.join(dir, "composition", "score.js"));
});

test("init starts every film with a score to replace, and knows when it was not", () => {
  const dir = path.join(tmp(), "film");
  const r = initFilm({}, dir);
  const f = path.join(path.dirname(r.composition), "score.js");
  assert.ok(isStarterScore(f));
  assert.equal(JSON.parse(fs.readFileSync(r.film, "utf8")).music.score, "composition/score.js");
  fs.appendFileSync(f, "\n// edited\n");
  assert.ok(!isStarterScore(f));
});

test("a release that sounds like an earlier film is reported", () => {
  const data = tmp();
  process.env.XDG_DATA_HOME = data;
  try {
    const dir = tmp();
    const f = score(dir, "S.why('x')");
    const mk = (name, tempo, instruments) => [{ name, scoreFile: f }, { tempo, key: "D shang", events: instruments.map((instrument) => ({ instrument })) }];
    assert.deepEqual(recordRelease(path.join(dir, "a.json"), ...mk("a", 66, ["zither", "gong", "cellos"])), []);
    const w = recordRelease(path.join(dir, "b.json"), ...mk("b", 68, ["zither", "gong", "cellos"]));
    assert.equal(w.length, 1);
    assert.match(w[0], /sounds like the release of a/);
    const bed = recordRelease(path.join(dir, "c.json"), { name: "c", music: { builtin: "pulse" } }, null);
    assert.deepEqual(bed, []);
    assert.match(recordRelease(path.join(dir, "d.json"), { name: "d", music: { builtin: "pulse" } }, null)[0], /same built-in "pulse" bed as the release of c/);
  } finally {
    delete process.env.XDG_DATA_HOME;
  }
});
