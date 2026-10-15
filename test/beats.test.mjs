import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { synthMusic } from "../src/music.mjs";
import { analyzeBeats, decodeMono, peakTime, alignDrop } from "../src/beats.mjs";
import { initFilm, validateFilm } from "../src/film.mjs";
import { measureLoopSeam } from "../src/verify.mjs";
import { main } from "../src/cli.mjs";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mu-beats-"));

test("drop alignment lists film bars, rejects early or missing drops and caps the grid", () => {
  const dir = temp(), file = path.join(dir, "song.wav");
  fs.writeFileSync(file, synthMusic("promo", 30, { bpm: 80 }));
  const song = analyzeBeats(decodeMono(file));
  const aligned = alignDrop(song, 5.5);
  assert.equal(aligned.from, Math.round((song.drop.start - 5.5) * 1000) / 1000);
  assert.ok(aligned.film_bars.includes(5.5));
  assert.ok(aligned.film_bars.every((t) => t >= 0 && t < song.seconds - aligned.from));
  assert.ok(aligned.film_bars.at(-1) >= song.bars.at(-1).start - aligned.from);
  assert.equal(alignDrop(song, song.drop.start).from, 0);
  assert.throws(() => alignDrop(song, song.drop.start + 0.001), /too early.*at most/);
  const silence = analyzeBeats(new Float32Array(22050 * 8));
  assert.throws(() => alignDrop(silence, 0), /no drop detected/);
  for (const invalid of [-1, NaN, Infinity]) assert.throws(() => alignDrop(song, invalid), /finite, non-negative/);
  const long = { ...song, seconds: 1000, bars: Array.from({ length: 400 }, (_, i) => ({ start: i * 2 })) };
  assert.equal(alignDrop(long, song.drop.start).film_bars.length, 64);
});

test("beats CLI reports drop-aligned music and bar lines in human and JSON output", async () => {
  const dir = temp(), file = path.join(dir, "song.wav");
  fs.writeFileSync(file, synthMusic("promo", 20, { bpm: 80 }));
  const savedLog = console.log, savedError = console.error;
  const savedUpdate = process.env.MOTION_USE_NO_UPDATE_CHECK;
  process.env.MOTION_USE_NO_UPDATE_CHECK = "1";
  let output = "", errors = "";
  console.log = (s) => { output += s; };
  console.error = (s) => { errors += s; };
  try {
    assert.equal(await main(["beats", file, "--drop-at", "5.5", "--json"]), 0);
    const json = JSON.parse(output);
    assert.equal(json.music.from, Math.round((json.drop.start - 5.5) * 1000) / 1000);
    assert.ok(json.film_bars.includes(5.5));
    output = "";
    assert.equal(await main(["beats", file, "--drop-at", "5.5"]), 0);
    assert.ok(output.includes(`"music": ${JSON.stringify(json.music)}`));
    assert.ok(output.includes(`bar lines (film seconds): ${json.film_bars.join(" ")}`));
    const padded = path.join(dir, "padded.wav");
    execFileSync("ffmpeg", ["-v", "error", "-i", file, "-af", "adelay=3000:all=1", padded]);
    output = "";
    assert.equal(await main(["beats", padded, "--from", "1", "--to", "22", "--drop-at", "5.5", "--json"]), 0);
    const range = JSON.parse(output);
    assert.equal(range.music.from, Math.round((range.drop.start - 5.5) * 1000) / 1000);
    assert.ok(range.film_bars.includes(5.5));
    assert.ok(range.film_bars.every((t) => t < 22 - range.music.from));
    output = "";
    assert.equal(await main(["beats", file, "--drop-at", "100", "--json"]), 1);
    assert.match(JSON.parse(output).error, /too early.*at most/);
    fs.writeFileSync(file, synthMusic("ambient", 8, {}));
    output = "";
    assert.equal(await main(["beats", file, "--drop-at", "0", "--json"]), 1);
    assert.match(JSON.parse(output).error, /no drop detected/);
    assert.equal(errors, "");
  } finally {
    console.log = savedLog;
    console.error = savedError;
    if (savedUpdate === undefined) delete process.env.MOTION_USE_NO_UPDATE_CHECK;
    else process.env.MOTION_USE_NO_UPDATE_CHECK = savedUpdate;
  }
});

test("beats finds tempo, the first downbeat and the drop of a song with a known grid", () => {
  const dir = temp();
  for (const [mood, bpm] of [["chiptune", 120], ["pulse", 96], ["promo", 128], ["pentatonic", 80]]) {
    const file = path.join(dir, `${mood}.wav`);
    fs.writeFileSync(file, synthMusic(mood, 16, { bpm }));
    // Shift the song by 0.37 s of silence so beat one is not at sample zero.
    const raw = decodeMono(file), pad = Math.round(0.37 * 22050), s = new Float32Array(pad + raw.length);
    s.set(raw, pad);
    const r = analyzeBeats(s);
    assert.ok(Math.abs(r.bpm - bpm) <= 0.5, `${mood}: ${r.bpm} vs ${bpm}`);
    assert.ok(Math.abs(r.downbeat - 0.37) <= 0.02, `${mood}: downbeat ${r.downbeat}`);
    // Short drumless excerpts sit near the "confirm by ear" line; a kick makes the grid unmistakable.
    if (mood === "chiptune" || mood === "promo") assert.ok(r.confidence >= 2.5, `${mood}: confidence ${r.confidence}`);
  }
  // Clicks at random moments have no steady beat, and say so.
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const noise = new Float32Array(22050 * 16);
  for (let t = 0.2; t < 15.5; t += 0.15 + rnd() * 0.6)
    for (let i = 0; i < 600; i++) noise[Math.floor(t * 22050) + i] = (rnd() * 2 - 1) * Math.exp(-i / 120);
  assert.ok(analyzeBeats(noise).confidence < 2);
  // Drums enter on bar 3 of the promo mood: the biggest lift.
  fs.writeFileSync(path.join(dir, "long.wav"), synthMusic("promo", 30, {}));
  const promo = analyzeBeats(decodeMono(path.join(dir, "long.wav")));
  assert.equal(promo.drop?.bar, 2);
});

test("follow is a pure function of time that eases to each new target with a small overshoot", () => {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(new URL("../src/film-kit.js", import.meta.url), "utf8"), ctx);
  const M = ctx.window.__filmKit({ width: 1920, height: 1080 }, {});
  const keys = [[0, 100], [1, 300], [1.2, 50]];
  assert.equal(M.follow(0.5, keys), 100);
  assert.ok(Math.abs(M.follow(5, keys) - 50) < 1e-6);
  // Retargeted mid-flight: continuous, no jump at the second change.
  assert.ok(Math.abs(M.follow(1.2 + 1e-4, keys) - M.follow(1.2 - 1e-4, keys)) < 0.5);
  // Starts with zero velocity, overshoots by under 10%.
  assert.ok(M.follow(1.01, [[0, 0], [1, 1]]) < 0.03);
  const peak = Math.max(...Array.from({ length: 200 }, (_, i) => M.follow(1 + i / 100, [[0, 0], [1, 1]])));
  assert.ok(peak > 1 && peak < 1.1, String(peak));
  assert.deepEqual(Array.from(M.follow(9, [[0, [0, 0]], [1, [10, 20]]]), Math.round), [10, 20]);
});

test("a sound effect aligned by its peak hits on start; imported music can start mid-song", () => {
  const dir = temp();
  initFilm({ lang: "en", format: "landscape" }, dir);
  const file = path.join(dir, "film.json"), data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.voiceover = false;
  const hit = peakTime(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "assets", "sfx", "whoosh.wav"));
  assert.ok(hit > 0.02, `whoosh peaks ${hit}s in`);
  fs.writeFileSync(path.join(dir, "song.wav"), synthMusic("promo", 20, {}));
  Object.assign(data, {
    music: { file: "song.wav", bpm: 100, from: 2.4 },
    loop: true,
    audio: [{ effect: "whoosh", role: "sfx", start: 3, align: "peak" }, { effect: "whoosh", role: "sfx", start: 0, align: "peak" }],
  });
  const v = validateFilm(data, dir);
  assert.deepEqual(v.errors, []);
  const [late, early] = v.film.tracks;
  assert.ok(Math.abs(late.start + late.peak - 3) < 1e-3);
  // Too early to back up: the clip is trimmed instead, so its peak still lands at 0.
  assert.equal(early.start, 0);
  assert.ok(Math.abs(early.offset - early.peak) < 1e-3);
  // A start past the song's end is caught, not rendered as silence; running out early is a warning.
  assert.ok(validateFilm({ ...data, music: { file: "song.wav", from: 1000 } }, dir).errors.some((e) => e.path === "$.music.from"));
  assert.ok(validateFilm({ ...data, music: { file: "song.wav", from: 15 } }, dir).warnings.some((w) => w.path === "$.music.from"));
  const bad = validateFilm({ ...data, loop: "yes", audio: [{ effect: "ding", align: "middle" }], music: { file: "song.wav", from: -1 } }, dir).errors.map((e) => e.path ?? e);
  for (const p of ["$.loop", "$.audio[0].align", "$.music.from"]) assert.ok(bad.some((e) => String(e).includes(p)), p);
});

test("the loop check tells a seamless loop from one that jumps back", () => {
  const dir = temp(), make = (name, expr) => {
    const f = path.join(dir, name);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=gray:s=320x180:r=30:d=2,geq=lum='${expr}':cb=128:cr=128`, "-pix_fmt", "yuv420p", f]);
    return f;
  };
  // A bar sweeping across once per 2 s comes back to where it started; a fade to white does not.
  const loop = measureLoopSeam(make("loop.mp4", "if(lt(mod(X-T*160+320\\,320)\\,40)\\,235\\,30)"));
  const jump = measureLoopSeam(make("jump.mp4", "30+T*100"));
  assert.ok(loop.ok, JSON.stringify(loop));
  assert.ok(!jump.ok, JSON.stringify(jump));
});
