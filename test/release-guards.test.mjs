import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { compareNarration, checkNarration, describeNarration, tokenize } from "../src/narration-check.mjs";
import { collisionRuns, overflowRuns, probeText, transitionTimes } from "../src/text-probe.mjs";
import { createSnapshot, findSnapshot, restoreSnapshot } from "../src/snapshot.mjs";
import { checkAgainstManifest, encodeMaster, encodeUnder, probeMedia, releaseEntry, writeReleaseManifest } from "../src/release.mjs";
import { initFilm, checkFilm, buildFilm } from "../src/film.mjs";
import { runHyperframes } from "../src/hf.mjs";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mu-guards-"));

// Readings and dictionary words as pypinyin reports them, for the characters these lines use.
const LEXICON = {
  chars: { 重: ["chong", "tong", "zhong"], 视: ["shi"], 试: ["shi"], 是: ["shi", "ti"], 他: ["ta", "tuo"], 它: ["ta", "tuo", "yi"], 都: ["dou", "du"], 再: ["zai"] },
  phrases: ["重视", "不能"],
};

test("narration check: the two misreadings of the iphone-use promo are flagged", () => {
  // edge-tts read 重试 as zhòng shì; whisper wrote 重视. Plain ASR spelling (它 → 他) is not flagged.
  const zh = compareNarration("点不到或没等到，它都直说，还告诉你能不能重试。", "点不到或没等到,他都直说,还告诉你能不能重视。", "zh", LEXICON);
  assert.equal(zh.flagged, true);
  assert.deepEqual(
    zh.changes.map((c) => [c.expected, c.heard, c.kind, c.flag]),
    [
      ["它", "他", "homophone", false],
      ["试", "视", "polyphone", true],
    ],
  );
  // "AI" spoken as "A-A-I", in Chinese and in English.
  const ai = compareNarration("让 AI 直接操作你的真 iPhone，任何 App 都行。", "让AAI直接操作你的真iPhone,任何App都行。", "zh", LEXICON);
  assert.equal(ai.flagged, true);
  assert.equal(ai.changes[0].kind, "acronym");
  const en = compareNarration("Let AI drive your real iPhone. Any app, no API needed.", "Let A-A-I drive your real iPhone. Any app, no API needed.", "en");
  assert.equal(en.flagged, true);
  assert.deepEqual(en.changes.map((c) => [c.expected, c.heard]), [["ai", "aai"]]);
});

test("narration check: the fixed lines pass, and spelled acronyms or ASR word noise are not flagged", () => {
  assert.equal(compareNarration("让 A I 直接操作你的真 iPhone，任何 App 都行。", "让AI直接操作你的真iPhone,任何App都行。", "zh", LEXICON).flagged, false);
  assert.equal(compareNarration("还告诉你能不能再试。", "还告诉你能不能再是。", "zh", LEXICON).flagged, false);
  assert.equal(compareNarration("Saved flows need no API.", "Saved flows need no A P I.", "en").similarity, 1);
  assert.equal(compareNarration("Saved flows replay in one call, with no tokens.", "Save flows replay in one call with no tokens.", "en").flagged, false);
  assert.equal(compareNarration("Two things and a gap.", "Something else was said entirely.", "en").flagged, true);
  assert.deepEqual(tokenize("A-A-I and A.I.", "en").map((t) => t.t), ["aai", "and", "ai"]);
});

test("narration check caches transcripts by clip hash and skips cleanly without a recognizer", () => {
  const dir = temp();
  fs.mkdirSync(path.join(dir, "zh"));
  const file = path.join(dir, "zh", "honest.mp3");
  fs.writeFileSync(file, "clip");
  const items = [{ id: "honest", lang: "zh", text: "还告诉你能不能重试。", file }];
  let calls = 0;
  const run = () => (calls++, { items: [{ file, text: "还告诉你能不能重视。" }], ...LEXICON });
  const first = checkNarration(items, { dir, run, model: "small" });
  assert.equal(first.ok, false);
  assert.match(describeNarration(first)[0], /重试 → 再试/);
  checkNarration(items, { dir, run, model: "small" });
  assert.equal(calls, 1, "an unchanged clip is not transcribed again");
  fs.writeFileSync(file, "new clip");
  checkNarration(items, { dir, run, model: "small" });
  assert.equal(calls, 2);
  const skipped = checkNarration([{ ...items[0], file: path.join(dir, "zh", "x.mp3") }].map((i) => (fs.writeFileSync(i.file, "x"), i)), { dir, run: () => ({ skipped: "uv is not installed" }) });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, "uv is not installed");
});

test("text runs: sustained clipping is reported, a whip through the edge and parked text are not", () => {
  const W = 1920,
    H = 1080;
  const samples = [];
  for (let i = 0; i <= 60; i++) {
    const t = +(i * 0.1).toFixed(1);
    const boxes = [];
    // the round-7 callout: its second line ends 100 px past the right edge from 1.0 to 2.5 s
    if (t >= 1 && t <= 2.5) boxes.push({ text: "scan with an iPhone: no address, no password", x0: 1466, y0: 630, x1: 2020, y1: 656 });
    // a whip carries a title through the left edge for 0.1 s
    if (t === 3) boxes.push({ text: "Remote control", x0: -300, y0: 100, x1: 200, y1: 160 });
    // text parked entirely off-frame
    boxes.push({ text: "offstage", x0: 2100, y0: 10, x1: 2400, y1: 40 });
    samples.push({ t, boxes });
  }
  const runs = overflowRuns(samples, { width: W, height: H });
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].kind, runs[0].from, runs[0].to, runs[0].overflow_px, runs[0].sides], ["frame", 1, 2.5, 100, ["right"]]);
  // portrait: inside the frame but under the action column
  const safe = { x: 64.8, y: 192, w: 864, h: 1267.2 };
  const portrait = overflowRuns(
    [0, 0.1, 0.2, 0.3].map((t) => ({ t, boxes: [{ text: "subtitle", x0: 120, y0: 1300, x1: 1000, y1: 1350 }] })),
    { width: 1080, height: 1920, safe, vertical: true },
  );
  assert.deepEqual(portrait.map((r) => [r.kind, r.sides]), [["safe", ["right"]]]);
});

const chrome = async () => {
  const r = await runHyperframes(["browser", "path"], {});
  const p = r.out.trim().split("\n").pop();
  return r.code === 0 && p && fs.existsSync(p);
};

test("text check measures a real film: a callout off the right edge from 1 to 2 s", { timeout: 180000 }, async (t) => {
  if (!(await chrome())) return t.skip("no Chrome for rendering");
  const dir = temp();
  initFilm({ lang: "en", format: "landscape" }, dir);
  const file = path.join(dir, "film.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  Object.assign(data, { voiceover: false, music: "none", duration: 3, shots: [{ id: "only", start: 0, end: 3, purpose: "probe", action: "a callout slides out" }] });
  fs.writeFileSync(file, JSON.stringify(data));
  fs.writeFileSync(
    path.join(dir, "composition", "draw.js"),
    `window.drawFrame = function (c, t, film, view, M) {
      c.fillStyle = "#101010"; c.fillRect(0, 0, view.width, view.height);
      M.text(c, "Title stays inside", view.width / 2, 200, 80, "#fff", 700, "center");
      if (t >= 1 && t < 2) M.text(c, "scan with an iPhone: no address, no password", 1500, 640, 40, "#fff", 600, "left");
    };`,
  );
  const c = checkFilm(file, {});
  assert.deepEqual(c.report.errors, []);
  const proj = await buildFilm(c.film, "en", "landscape", path.join(dir, "out", ".build", "probe"));
  const r = await probeText(proj.dir, proj.total);
  assert.equal(r.skipped, undefined, r.skipped);
  // the 1 s callout is also too short to read; that note is checked in readability.test.mjs
  const off = r.runs.filter((x) => x.kind === "frame");
  assert.equal(off.length, 1, JSON.stringify(r.runs));
  assert.equal(off[0].text, "scan with an iPhone: no address, no password");
  assert.ok(off[0].from >= 0.95 && off[0].from <= 1.05 && off[0].to >= 1.85 && off[0].to < 2, JSON.stringify(off[0]));
});

test("collision check: a cross-fade of two strings in one spot is a run; plates, dimmed text and one paragraph are not", () => {
  const box = (text, x0, y0, x1, y1, alpha = 1, order = 0) => ({ text, x0, y0, x1, y1, alpha, order });
  const old = (t) => box("任何 App，不需要 API", 800, 500, 1300, 570, t < 2.88 ? 1 - (t - 2.7) * 2 : 0, 0);
  const neu = (t) => box("一步写入 278 字", 850, 495, 1250, 575, t >= 2.8 ? 1 : 0, 1);
  const samples = [];
  for (let f = 0; f <= 18; f++) {
    const t = 2.7 + f / 60;
    samples.push({ t, boxes: [old(t), neu(t)].filter((b) => b.alpha > 0.05), plates: [] });
  }
  const runs = collisionRuns(samples, { minDur: 2 / 60 });
  assert.equal(runs.length, 1, JSON.stringify(runs));
  assert.equal(runs[0].kind, "collision");
  assert.ok(runs[0].from >= 2.79 && runs[0].to <= 2.88, JSON.stringify(runs[0]));
  // a subtitle on an opaque plate over a background word; a word dimmed to 0.15; two lines of one paragraph
  const quiet = [0, 0.1, 0.2].map((t) => ({
    t,
    boxes: [box("background word", 100, 900, 700, 980, 1, 0), box("subtitle line", 150, 910, 650, 970, 1, 2), box("faint", 100, 100, 400, 160, 0.15, 3), box("big title", 120, 110, 380, 170, 1, 4), box("line one of a paragraph", 100, 300, 900, 352, 1, 5), box("line two of a paragraph", 100, 346, 900, 398, 1, 6)],
    plates: [{ x0: 120, y0: 895, x1: 680, y1: 985, order: 1 }],
  }));
  assert.deepEqual(collisionRuns(quiet), []);
  // the 0.1 s pass misses the overlap, so the frames between a change of visible strings are re-drawn
  const coarse = [2.7, 2.8, 2.9].map((t) => ({ t, boxes: [old(t), neu(t)].filter((b) => b.alpha >= 0.25) }));
  const fine = transitionTimes(coarse, 60);
  assert.ok(fine.filter((t) => t > 2.8 && t < 2.9).length >= 5 && fine.every((t) => t > 2.7 && t < 2.9), JSON.stringify(fine));
});

test("text check measures a real film: two stamps cross-fading in one spot collide, a plated subtitle does not", { timeout: 180000 }, async (t) => {
  if (!(await chrome())) return t.skip("no Chrome for rendering");
  const dir = temp();
  initFilm({ lang: "zh", format: "landscape" }, dir);
  const file = path.join(dir, "film.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  Object.assign(data, { voiceover: false, music: "none", duration: 3, shots: [{ id: "only", start: 0, end: 3, purpose: "probe", action: "one stamp hands over to the next" }] });
  fs.writeFileSync(file, JSON.stringify(data));
  // the iphone-use promo opening, at 0.5–2.7 s and from 2.8 s, moved earlier
  fs.writeFileSync(
    path.join(dir, "composition", "draw.js"),
    `window.drawFrame = function (c, t, film, view, M) {
      c.fillStyle = "#101010"; c.fillRect(0, 0, view.width, view.height);
      const at = [view.width * 0.62, view.height * 0.45];
      M.stamp(c, t, "任何 App，不需要 API", at, { at: 0.2, until: 1.2, size: 64, color: "#fff", rotate: 0, box: false });
      M.stamp(c, t, "一步写入 278 字", at, { at: 1.3, until: 2.6, size: 64, color: "#30D158", rotate: 0, box: false });
      M.text(c, "背景上的一行字", view.width / 2, 960, 44, "#fff", 700, "center");
      M.captions(c, t, [["字幕在自己的底板上", 0, 3]]);
    };`,
  );
  const c = checkFilm(file, {});
  assert.deepEqual(c.report.errors, []);
  const proj = await buildFilm(c.film, "zh", "landscape", path.join(dir, "out", ".build", "probe"));
  const r = await probeText(proj.dir, proj.total);
  assert.equal(r.skipped, undefined, r.skipped);
  const hits = r.runs.filter((x) => x.kind === "collision");
  assert.equal(hits.length, 1, JSON.stringify(r.runs));
  assert.deepEqual([hits[0].text, hits[0].other].sort(), ["一步写入 278 字", "任何 App，不需要 API"].sort());
  assert.ok(hits[0].from >= 1.29 && hits[0].to <= 1.39, JSON.stringify(hits[0]));
});

test("snapshots keep the exact voiceover a render used and restore it after it was regenerated", () => {
  const dir = temp(),
    out = path.join(dir, "out");
  fs.mkdirSync(path.join(dir, "composition"));
  fs.mkdirSync(path.join(dir, "voiceover", "zh"), { recursive: true });
  const filmFile = path.join(dir, "film.json"),
    draw = path.join(dir, "composition", "draw.js"),
    clip = path.join(dir, "voiceover", "zh", "honest.mp3");
  fs.writeFileSync(filmFile, JSON.stringify({ name: "x", shots: [{ id: "honest", narration: { zh: "重试" } }] }));
  fs.writeFileSync(draw, "window.drawFrame = () => {};");
  fs.writeFileSync(clip, "the voice that was published");
  const film = { dir, source: draw, libraries: [], fileAssets: {}, videos: {}, tracks: [{ role: "voiceover", file: clip, lang: "zh", id: "honest" }], narrationConfig: { dir: path.join(dir, "voiceover") } };
  const snap = createSnapshot(film, filmFile, out, { version: "test" });
  assert.equal(createSnapshot(film, filmFile, out, { version: "test" }).id, snap.id, "same inputs, same snapshot");
  // the narration is regenerated in place and the script edited, as happened in the promo
  fs.writeFileSync(clip, "a newer voice");
  fs.writeFileSync(filmFile, JSON.stringify({ name: "x", shots: [{ id: "honest", narration: { zh: "再试" } }] }));
  const restored = restoreSnapshot(findSnapshot(snap.id.slice(0, 6), out));
  const rdir = path.dirname(restored);
  assert.equal(fs.readFileSync(path.join(rdir, "voiceover", "zh", "honest.mp3"), "utf8"), "the voice that was published");
  assert.match(fs.readFileSync(restored, "utf8"), /重试/);
  assert.equal(fs.readdirSync(path.join(out, ".snapshots", "blobs")).length, 3, "blobs are shared by hash");
});

test("release masters are recorded by hash; a stale cut does not pass the manifest", { timeout: 120000 }, () => {
  const dir = temp(),
    src = path.join(dir, "render.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", "-c:v", "libx264", "-crf", "8", "-c:a", "aac", src]);
  const rel = path.join(dir, "release");
  fs.mkdirSync(rel);
  encodeMaster(src, path.join(rel, "film-en-landscape.mp4"));
  const m = probeMedia(path.join(rel, "film-en-landscape.mp4"));
  assert.equal(m.video_codec, "h264");
  assert.equal(m.audio.sample_rate, 48000);
  assert.ok(Math.abs(m.duration - 2) < 0.1);
  encodeUnder(src, path.join(rel, "film-en-landscape-x.mp4"), 600e3, 2, dir);
  assert.ok(fs.statSync(path.join(rel, "film-en-landscape-x.mp4")).size <= 600e3);
  writeReleaseManifest(rel, { entries: [releaseEntry(rel, "film-en-landscape.mp4", { kind: "master", lang: "en", format: "landscape" })], snapshot: "abc", version: "test", film: null });
  const manifest = path.join(rel, "release-manifest.json");
  assert.equal(checkAgainstManifest(manifest, path.join(rel, "film-en-landscape.mp4")).ok, true);
  // a copy taken before the last fix: same name, other bytes
  const stale = path.join(dir, "film-en-landscape.mp4");
  fs.copyFileSync(src, stale);
  const r = checkAgainstManifest(manifest, stale);
  assert.equal(r.ok, false);
  assert.match(r.reason, /stale or edited cut/);
});
