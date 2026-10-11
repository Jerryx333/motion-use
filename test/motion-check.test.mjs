import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { measureMotion, gradeMotion } from "../src/motion-check.mjs";
import { validateFilm, initFilm, bluePurpleHex, textUnits } from "../src/film.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mu-motion-test-"));
const make = (name, filter, seconds = 6) => {
  const file = path.join(dir, name);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", filter, "-t", String(seconds), "-pix_fmt", "yuv420p", file]);
  return file;
};

test("a static picture reads as a slideshow; continuous fast movement does not", () => {
  const still = measureMotion(make("still.mp4", "smptebars=s=640x360:r=30"));
  assert.equal(still.fast_ratio, 0);
  assert.ok(still.still_ratio > 0.9);
  assert.equal(still.blank_run_s, 0, "colour bars have edges; they are not an empty frame");
  const moving = measureMotion(make("moving.mp4", "smptebars=s=640x360:r=30,scroll=h=0.04"));
  assert.ok(moving.fast_ratio > 0.5, `fast_ratio ${moving.fast_ratio}`);
  // A short film is never failed on pacing alone; a long one is, unless the reason is recorded.
  assert.equal(gradeMotion({ ...still, seconds: 6 }).rows.find((r) => r.metric === "fast_ratio").level, "yellow");
  assert.equal(gradeMotion({ ...still, seconds: 45 }).level, "red");
  const allowed = gradeMotion({ ...still, seconds: 45 }, { allowStatic: "a calm product tour" });
  assert.equal(allowed.level, "yellow");
  assert.match(allowed.rows.find((r) => r.metric === "fast_ratio").note, /calm product tour/);
});

test("an empty mid-film frame and a blue-purple palette are found and timed", () => {
  const blank = measureMotion(make("blank.mp4", "color=c=0xf3ede2:s=640x360:r=30", 3));
  assert.ok(blank.blank_run_s >= 1.5, `blank ${blank.blank_run_s}`);
  assert.equal(gradeMotion(blank).rows.find((r) => r.metric === "blank_run_s").level, "red");
  const purple = measureMotion(make("purple.mp4", "color=c=0x5b3fd1:s=640x360:r=30", 3));
  assert.equal(purple.blue_purple_share, 1);
  assert.equal(gradeMotion(purple).rows.find((r) => r.metric === "blue_purple_share").level, "red");
  const navy = measureMotion(make("navy.mp4", "color=c=0x0d1b2a:s=640x360:r=30", 3));
  assert.equal(navy.blue_purple_share, 0, "navy (~210°) is not the AI blue-purple");
  const allowed = gradeMotion(purple, { allowBluePurple: "Starry Night study" }).rows.find((r) => r.metric === "blue_purple_share");
  assert.equal(allowed.level, "yellow");
  assert.match(allowed.note, /Starry Night/);
});

test("a hard cut is a transition, not motion", () => {
  const cut = make("cut.mp4", "smptebars=s=640x360:r=30,hflip", 2);
  const base = make("base.mp4", "testsrc=s=640x360:r=30,format=gray,lutyuv=y=val/2", 2);
  const list = path.join(dir, "list.txt");
  fs.writeFileSync(list, `file '${base}'\nfile '${cut}'\nfile '${base}'\n`);
  const joined = path.join(dir, "joined.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined]);
  const m = measureMotion(joined);
  assert.equal(m.cuts.length, 2, JSON.stringify(m.cuts));
  assert.ok(Math.abs(m.cuts[0] - 2) < 0.2 && Math.abs(m.cuts[1] - 4) < 0.2);
});

test("look, camera and on-screen text checks map storyboard rules onto film.json", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mu-look-"));
  initFilm({ lang: "zh,en", format: "landscape" }, d);
  const data = JSON.parse(fs.readFileSync(path.join(d, "film.json"), "utf8"));
  data.voiceover = false;
  assert.deepEqual(validateFilm(data, d).errors, []);
  const starter = validateFilm(data, d).warnings;
  // The only notes on a fresh starter are the brief fields the user has not filled yet.
  assert.deepEqual(starter.filter((w) => !w.path.startsWith("$.brief.")), [], "the starter itself passes its own checks");
  assert.deepEqual(starter.map((w) => w.path), ["$.brief.subject", "$.brief.purpose", "$.brief.audience", "$.brief.tone"]);
  const warn = (f) => {
    const x = structuredClone(data);
    f(x);
    return validateFilm(x, d);
  };
  assert.ok(warn((x) => delete x.look).warnings.some((w) => w.path === "$.look"));
  assert.ok(warn((x) => (x.look.palette = ["#f3ede2", "#5b3fd1", "#111111"])).errors.some((e) => /blue-purple/.test(e.message)));
  assert.deepEqual(warn((x) => ((x.look.palette = ["#f3ede2", "#5b3fd1", "#111111"]), (x.look.allowBluePurple = "night sky"))).errors, []);
  assert.ok(warn((x) => (x.look.palette = "neon")).errors.some((e) => e.path === "$.look.palette"));
  assert.ok(warn((x) => (x.shots[1].action = "Three bullet points appear one by one")).warnings.some((w) => w.path === "$.shots[1].action"));
  assert.ok(warn((x) => (x.shots[0].text = { zh: "今天我们来讲一个非常重要的问题", en: "x" })).warnings.some((w) => /opening shot/.test(w.message)));
  assert.ok(warn((x) => x.shots.slice(0, 3).forEach((s) => (s.camera = "hold"))).warnings.some((w) => /three "hold"/.test(w.message)));
  assert.ok(warn((x) => x.shots.forEach((s) => (s.camera = "hold"))).warnings.some((w) => /no push/.test(w.message)));
  assert.ok(warn((x) => (x.shots[0].camera = "zoomy")).errors.some((e) => e.path === "$.shots[0].camera"));
  assert.equal(bluePurpleHex("#0D1B2A"), false);
  assert.equal(textUnits("三天前还没有"), 6);
  assert.equal(textUnits("Send 3 messages"), 3);
});

test("the drawing kit is deterministic and only adds helpers", () => {
  const source = fs.readFileSync(new URL("../src/film-kit.js", import.meta.url), "utf8");
  const ctx = { window: {} };
  vm.runInNewContext(source, ctx);
  const kit = ctx.window.__filmKit({ width: 1920, height: 1080 }, { look: { palette: "wood" } });
  assert.equal(kit.palette().bg, "#EDE3D1");
  assert.deepEqual(kit.palette(["#111111", "#eeeeee", "#c4552d"]).accent, "#c4552d");
  // Pulse camera: still before the event, a 25% push complete after 0.28 s, untouched by later reads.
  const ev = [{ at: 1, kind: "push", x: 400, y: 300 }];
  assert.equal(kit.camera(0.5, ev).z, 1);
  const after = kit.camera(1.3, ev);
  assert.ok(Math.abs(after.z - 1.25) < 1e-9 && after.x === 400 && !after.moving);
  assert.ok(kit.camera(1.1, ev).moving);
  assert.deepEqual(kit.camera(1.3, ev), after);
  // Slam: 1.55 → 0.94 → 1.0 over 0.17 s.
  assert.equal(kit.slam(2, 2), 1.55);
  assert.ok(Math.abs(kit.slam(2 + 0.6 * 0.17, 2) - 0.94) < 1e-9);
  assert.equal(kit.slam(3, 2), 1);
  assert.equal(kit.easings.backOut(1), 1);
  assert.ok(Math.abs(kit.easings.appleOut(0.5) - kit.easings.appleOut(0.5)) === 0);
  const a = kit.rng(42),
    b = kit.rng(42);
  assert.equal(a(), b());
  assert.equal(kit.noise(1.3, 2.7), kit.noise(1.3, 2.7));
  assert.equal(kit.step(0.124), 1 / 12);
  assert.equal(kit.count(5, 0, 1, 0, 1200), "1,200");
});

test("built-in music moods are deterministic, accept accents and validate", async () => {
  const { synthMusic, MOOD_NAMES } = await import("../src/music.mjs");
  for (const mood of MOOD_NAMES) {
    const a = synthMusic(mood, 3, { hits: [1.5] });
    assert.ok(a.equals(synthMusic(mood, 3, { hits: [1.5] })), `${mood} is reproducible`);
    assert.ok(!a.equals(synthMusic(mood, 3)), `${mood} hit changes the audio`);
  }
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mu-music-"));
  initFilm({ lang: "en", format: "landscape" }, d);
  const data = JSON.parse(fs.readFileSync(path.join(d, "film.json"), "utf8"));
  data.voiceover = false;
  delete data.bpm;
  data.music = { builtin: "pulse", hits: [4.62, 14.52] };
  const ok = validateFilm(data, d);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.film.bpm, 96, "the beat grid follows the mood's tempo");
  data.music = { builtin: "disco", hits: [99] };
  const bad = validateFilm(data, d).errors.map((e) => e.path);
  assert.ok(bad.includes("$.music.builtin") && bad.includes("$.music.hits"));
});

test("a rate-limited GitHub API falls back to the releases page redirect", async () => {
  const { latestRelease } = await import("../src/update.mjs");
  const real = globalThis.fetch;
  globalThis.fetch = async (url) =>
    String(url).includes("api.github.com")
      ? new Response("{}", { status: 403 })
      : new Response(null, { status: 302, headers: { location: "https://github.com/leeguooooo/motion-use/releases/tag/v9.8.7" } });
  try {
    assert.equal(await latestRelease(), "9.8.7");
  } finally {
    globalThis.fetch = real;
  }
});
