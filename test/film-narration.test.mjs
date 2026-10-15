import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { initFilm, checkFilm, buildFilm, filmCaptions } from "../src/film.mjs";
import { MANIFEST } from "../src/voiceover.mjs";
import { narrationItems, checkNarration } from "../src/narration-check.mjs";
import {
  buildNarrationStem,
  verifyNarration,
  verifyVideo,
} from "../src/verify.mjs";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mu-narration-test-"));
const tone = (file, freq, seconds = 1) =>
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${freq}:duration=${seconds}`,
    file,
  ]);

test("film say validation, original captions and substituted narration checks", () => {
  const dir = temp();
  initFilm({ lang: "zh", format: "square" }, dir);
  const file = path.join(dir, "film.json");
  const data = JSON.parse(fs.readFileSync(file));
  data.narration = { zh: "抬头就有数。" };
  data.voiceover = { say: { "有数": "有树" } };
  fs.writeFileSync(file, JSON.stringify(data));
  let c = checkFilm(dir);
  assert.equal(c.ok, true);
  assert.deepEqual(c.film.narrationConfig.say, data.voiceover.say);
  const voDir = c.film.narrationConfig.dir;
  fs.mkdirSync(path.join(voDir, "zh"), { recursive: true });
  const audio = path.join(voDir, "zh", "narration.mp3");
  fs.writeFileSync(audio, "mock audio");
  const sha = crypto.createHash("sha256").update(fs.readFileSync(audio)).digest("hex");
  const manifest = { [path.join("zh", "narration.mp3")]: { text: "抬头就有树。", sha, cues: [{ text: "抬头就有树。", start: 0, end: 1 }] } };
  fs.writeFileSync(path.join(voDir, MANIFEST), JSON.stringify(manifest));
  const tracks = [{ id: "narration", file: audio, start: 0.1, length: 1 }];
  const captions = filmCaptions(c.film, "zh", tracks);
  assert.equal(captions.map((cue) => cue.text).join(""), "抬头就有数。");
  assert.ok(captions.every((cue) => cue.estimated));
  for (const project of [c.film, { voiceover: c.film.narrationConfig, scenes: c.film.narrationPlans }]) {
    const items = narrationItems(project);
    assert.equal(items[0].text, "抬头就有树。");
    const result = checkNarration(items, { run: ({ texts }) => {
      assert.deepEqual(texts, ["抬头就有树。"]);
      return { items: [{ file: audio, text: "抬头就有树。" }], chars: {}, phrases: [] };
    } });
    assert.equal(result.ok, true);
    assert.equal(result.lines[0].similarity, 1);
  }
  fs.rmSync(audio);
  for (const say of [null, [], "有树", { "": "树" }, { "有数": 1 }]) {
    data.voiceover.say = say;
    fs.writeFileSync(file, JSON.stringify(data));
    c = checkFilm(dir);
    assert.ok(c.report.errors.some((e) => e.path === "$.voiceover.say"));
  }
});

test("new films default to narration; a soundtrack alone never satisfies delivery", () => {
  const dir = temp();
  initFilm({ lang: "en", format: "square" }, dir);
  const c = checkFilm(dir);
  assert.equal(c.ok, true);
  assert.ok(c.film.narrationConfig);
  assert.ok(c.film.narrationPlans.length);
  const delivery = checkFilm(dir, { requireNarration: true });
  assert.equal(delivery.ok, false);
  assert.ok(
    delivery.report.errors.some((e) => e.message.includes("missing narration")),
  );
  const file = path.join(dir, "film.json"),
    d = JSON.parse(fs.readFileSync(file));
  for (const s of d.shots) delete s.narration;
  fs.writeFileSync(file, JSON.stringify(d));
  assert.equal(checkFilm(dir).ok, false);
  d.voiceover = false;
  fs.writeFileSync(file, JSON.stringify(d));
  assert.equal(checkFilm(dir, { requireNarration: true }).ok, true);
});

test("language-specific voices are isolated and speech cannot overrun its authored window", async () => {
  const dir = temp();
  initFilm({ lang: "zh,en", format: "landscape" }, dir);
  const file = path.join(dir, "film.json"),
    d = JSON.parse(fs.readFileSync(file));
  d.narration = { zh: "你好", en: "Hello" };
  for (const lang of ["zh", "en"]) {
    const p = path.join(dir, "voiceover", lang);
    fs.mkdirSync(p, { recursive: true });
    tone(path.join(p, "narration.wav"), lang === "zh" ? 700 : 1100);
  }
  fs.writeFileSync(file, JSON.stringify(d));
  const c = checkFilm(dir, { requireNarration: true });
  assert.equal(c.ok, true);
  const zh = await buildFilm(
    c.film,
    "zh",
    "landscape",
    path.join(dir, "out", "zh"),
  );
  assert.equal(zh.narrationTracks.length, 1);
  assert.equal(zh.narrationTracks[0].lang, "zh");
  assert.ok(fs.existsSync(zh.narrationStem));
  const en = await buildFilm(
    c.film,
    "en",
    "landscape",
    path.join(dir, "out", "en"),
  );
  assert.equal(en.narrationTracks[0].lang, "en");
  d.duration = 1;
  d.shots = [
    {
      id: "short",
      start: 0,
      end: 1,
      purpose: "Test timing",
      action: "A short action",
    },
  ];
  fs.writeFileSync(file, JSON.stringify(d));
  assert.ok(
    checkFilm(dir).report.errors.some((e) =>
      e.message.includes("never truncate speech"),
    ),
  );
});

test("a voice-stem check rejects music-only output and passes a delivered narration mix", () => {
  const dir = temp(),
    voice = path.join(dir, "voice.wav"),
    music = path.join(dir, "music.wav"),
    stem = path.join(dir, "stem.wav");
  tone(voice, 880);
  tone(music, 440, 2);
  const tracks = [
    {
      id: "line",
      file: voice,
      start: 0.2,
      offset: 0,
      length: 1,
      volume: 1,
      lang: "en",
    },
  ];
  buildNarrationStem(tracks, 2, stem);
  assert.equal(verifyNarration(music, stem, tracks).ok, false);
  const mix = path.join(dir, "mix.wav");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    stem,
    "-i",
    music,
    "-filter_complex",
    "[1:a]volume=0.15[bed];[0:a][bed]amix=inputs=2:normalize=0[a]",
    "-map",
    "[a]",
    mix,
  ]);
  assert.equal(verifyNarration(mix, stem, tracks).ok, true);
  const mp4 = path.join(dir, "music-only.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=white:size=160x90:rate=24:duration=2",
    "-i",
    music,
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-shortest",
    mp4,
  ]);
  const r = verifyVideo(mp4, path.join(dir, "review"), {
    expected: { narration: true },
    narrationStem: stem,
    narrationTracks: tracks,
  });
  assert.equal(r.ok, false);
  assert.equal(r.narration.ok, false);
  assert.ok(r.observed.audio);
});
