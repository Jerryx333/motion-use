import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { parseSrt, estimateCues } from "../src/voiceover.mjs";
import { initFilm, validateFilm, filmCaptions } from "../src/film.mjs";
import { demoSimilarity } from "../src/motion-check.mjs";

// A canvas stand-in that accepts every call; enough to run helpers headless.
const stubCanvas = () => {
  const calls = [];
  const ctx = new Proxy(
    { calls, measureText: (s) => ({ width: String(s).length * 10 }), createPattern: () => ({}), createRadialGradient: () => ({ addColorStop() {} }) },
    { get: (o, k) => (k in o ? o[k] : (...a) => calls.push([k, ...a])), set: (o, k, v) => ((o[k] = v), true) },
  );
  return ctx;
};
const kit = (film = {}) => {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(new URL("../src/film-kit.js", import.meta.url), "utf8"), ctx);
  return ctx.window.__filmKit({ width: 1920, height: 1080 }, film);
};

test("subtitle cues come from the voice service's SRT, or are estimated per sentence", () => {
  const cues = parseSrt("1\n00:00:00,050 --> 00:00:02,175\nTwo things.\n\n2\n00:00:02,175 --> 00:00:03,662\nOne action.\n");
  assert.deepEqual(cues, [
    { text: "Two things.", start: 0.05, end: 2.175 },
    { text: "One action.", start: 2.175, end: 3.662 },
  ]);
  const est = estimateCues("两个东西，隔着一道缝。一个动作，跨过去。", 1, 5);
  assert.equal(est.length, 2);
  assert.equal(est[0].start, 1);
  assert.equal(est.at(-1).end, 5);
  assert.ok(est.every((c) => c.estimated));
  // Long sentences break at commas so a subtitle stays readable.
  assert.ok(estimateCues("This is a deliberately long sentence, with a clause, and another clause after it.", 0, 4).length > 1);
});

test("film captions use stored cues only while the clip still matches its script", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mu-cap-"));
  const vo = path.join(dir, "voiceover"),
    file = path.join(vo, "en", "a.mp3");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "audio");
  const film = { narrationConfig: { dir: vo }, narrationPlans: [{ id: "a", narration: { en: "Hello there. Bye." } }] };
  const track = { id: "a", file, start: 2, length: 3 };
  const write = (text) =>
    fs.writeFileSync(path.join(vo, ".motion-use-voiceover.json"), JSON.stringify({ [path.join("en", "a.mp3")]: { text, sha: crypto.createHash("sha256").update("audio").digest("hex"), cues: [{ text: "Hello there. Bye.", start: 0.1, end: 2.5 }] } }));
  write("Hello there. Bye.");
  assert.deepEqual(filmCaptions(film, "en", [track]), [{ text: "Hello there. Bye.", start: 2.1, end: 4.5 }]);
  write("An older script.");
  const est = filmCaptions(film, "en", [track]);
  assert.ok(est.length === 2 && est.every((c) => c.estimated) && est[0].start === 2 && est[1].end === 5);
});

test("footage clips are validated against their source and the film", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mu-video-"));
  initFilm({ lang: "en", format: "landscape" }, d);
  const data = JSON.parse(fs.readFileSync(path.join(d, "film.json"), "utf8"));
  data.voiceover = false;
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=320x180:r=30:d=4", "-pix_fmt", "yuv420p", path.join(d, "clip.mp4")]);
  data.videos = { clip: { file: "clip.mp4", at: 2, from: 1, rate: 1.5 } };
  const ok = validateFilm(data, d);
  assert.deepEqual(ok.errors, []);
  assert.equal(+ok.film.videos.clip.length.toFixed(3), 2, "(4 − 1) s of source at 1.5× is 2 film seconds");
  data.videos.clip.volume = 0.5;
  assert.ok(validateFilm(data, d).errors.some((e) => /rate 1/.test(e.message)));
  data.videos = { clip: { file: "clip.mp4", at: 17, length: 3 } };
  assert.ok(validateFilm(data, d).errors.some((e) => e.path === "$.videos.clip"));
  data.videos = { clip: { file: "missing.mp4" } };
  assert.ok(validateFilm(data, d).errors.some((e) => e.path === "$.videos.clip.file"));
});

test("composed helpers accept compact camera tuples and read numbers from film.data", () => {
  const k = kit({ data: { riders: 4200 }, look: { palette: "ink" } });
  const c = stubCanvas();
  const cam = k.shoot(c, 5, [[1, "push", [400, 300], 0.25], [2, "slam"]], () => {});
  assert.ok(Math.abs(cam.z - 1.25) < 1e-9 && cam.x === 400);
  assert.deepEqual(c.calls.map((x) => x[0]).slice(0, 2), ["save", "translate"]);
  const c2 = stubCanvas();
  k.counter(c2, 9, [960, 540], { value: "riders", at: 1 });
  assert.ok(c2.calls.some((x) => x[0] === "fillText" && x[1] === "4,200"));
  const c3 = stubCanvas();
  k.counter(c3, 0.5, [960, 540], { value: "riders", at: 1 });
  assert.equal(c3.calls.length, 0, "nothing before its time");
  for (const draw of [
    (c) => k.chart(c, 2, { data: [{ label: "A", value: 3 }, { label: "B", value: 5 }], highlight: "B" }),
    (c) => k.callout(c, 2, [100, 100], "Peak", { at: 1, sub: "Thu" }),
    (c) => k.words(c, 2, "Change one number", [960, 540], { at: 1, emphasis: ["number"] }),
    (c) => k.stamp(c, 2, "LIVE", [960, 540], { at: 1.9 }),
    (c) => k.spotlight(c, 2, [10, 10, 100, 100], { at: 1 }),
    (c) => k.cursor(c, 2, [[0, 0, 0], [3, 100, 100]], { clicks: [1.95] }),
    (c) => k.captions(c, 2, [["Title", 1, 3]]),
    (c) => k.vignette(c),
  ]) {
    const s = stubCanvas();
    assert.doesNotThrow(() => draw(s));
    assert.ok(s.calls.length > 0);
  }
  assert.throws(() => k.cover(stubCanvas(), "nope"), /declare it under film.json assets/);
});

test("a film that is not the demo does not match the demo signatures", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mu-sim-"));
  const file = path.join(d, "bars.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "smptebars=s=640x360:r=30:d=3", "-pix_fmt", "yuv420p", file]);
  const demos = JSON.parse(fs.readFileSync(new URL("../assets/demo-signatures.json", import.meta.url), "utf8"));
  assert.ok(demos.some((x) => x.name === "starter" && x.orientation === "landscape"));
  assert.equal(demoSimilarity(file, demos).share, 0);
});

test("following a demo in order is flagged even re-coloured; a static look-alike is not", async () => {
  const { frameSignatures } = await import("../src/motion-check.mjs");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mu-sim2-"));
  const make = (name, filter) => {
    const f = path.join(d, name);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", filter, "-t", "8", "-pix_fmt", "yuv420p", f]);
    return f;
  };
  const demo = make("demo.mp4", "testsrc2=s=640x360:r=30,scroll=h=0.02");
  const demos = [{ name: "demo", ...frameSignatures(demo) }];
  assert.equal(demoSimilarity(demo, demos).share, 1);
  assert.equal(demoSimilarity(make("inverted.mp4", "testsrc2=s=640x360:r=30,scroll=h=0.02,negate"), demos).share, 1, "a re-skin with inverted brightness is still the same layout");
  assert.equal(demoSimilarity(make("still.mp4", "testsrc2=s=640x360:r=30,trim=end_frame=1,loop=-1:1,setpts=N/30/TB"), demos).share, 0, "one frame repeated never advances through the demo");
});

test("portrait subtitles default to the bottom of the platform-safe area", () => {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(new URL("../src/film-kit.js", import.meta.url), "utf8"), ctx);
  const view = { width: 1080, height: 1920, vertical: true, safe: { x: 64.8, y: 192, w: 864, h: 1267.2 } };
  const k = ctx.window.__filmKit(view, { captions: [{ text: "字幕", start: 0, end: 2 }] });
  const c = stubCanvas();
  k.captions(c, 1);
  const ys = c.calls.filter((x) => x[0] === "fillText").map((x) => x[3]);
  assert.ok(ys.length && ys.every((y) => y > 192 && y < 192 + 1267.2), `subtitle y ${ys} inside the safe area`);
  const xs = c.calls.filter((x) => x[0] === "fillText").map((x) => x[2]);
  assert.ok(xs.every((x) => Math.abs(x - (64.8 + 864 / 2)) < 1), `subtitle centred on the safe area, got ${xs}`);
  const runtime = fs.readFileSync(new URL("../src/film-runtime.js", import.meta.url), "utf8");
  assert.match(runtime, /view\.safe = view\.vertical/);
  assert.match(fs.readFileSync(new URL("../src/cli.mjs", import.meta.url), "utf8"), /o\._render = true/);
});

test("long subtitles wrap into two balanced lines instead of shrinking", () => {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(new URL("../src/film-kit.js", import.meta.url), "utf8"), ctx);
  const view = { width: 1080, height: 1920, vertical: true, safe: { x: 64.8, y: 192, w: 864, h: 1267.2 } };
  const text = "People can take over from a browser: click the live picture to open Date and Time, then go back.";
  const k = ctx.window.__filmKit(view, { captions: [{ text, start: 0, end: 3 }] });
  const c = stubCanvas();
  k.captions(c, 1);
  const rows = c.calls.filter((x) => x[0] === "fillText");
  assert.equal(rows.length, 2, JSON.stringify(rows.map((r) => r[1])));
  assert.equal(rows.map((r) => r[1]).join(" "), text);
  assert.ok(rows[1][3] > rows[0][3], "second line below the first");
  assert.ok(rows.every((r) => r[3] < 192 + 1267.2), "both lines inside the safe area");
});

test("a long portrait subtitle wraps into three lines rather than shrinking", () => {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(new URL("../src/film-kit.js", import.meta.url), "utf8"), ctx);
  const view = { width: 1080, height: 1920, vertical: true, safe: { x: 64.8, y: 192, w: 864, h: 1267.2 } };
  // The stub measures 10 px per character, so this needs more than two 864 px lines.
  const text = "People can take over from a browser: click the live picture to open Date and Time, then go back. Agents and people share one phone without stepping on each other, and either can hand it back.";
  const k = ctx.window.__filmKit(view, { captions: [{ text, start: 0, end: 3 }] });
  const c = stubCanvas();
  k.captions(c, 1);
  const rows = c.calls.filter((x) => x[0] === "fillText");
  assert.equal(rows.length, 3, JSON.stringify(rows.map((r) => r[1])));
  assert.equal(rows.map((r) => r[1]).join(" "), text);
});

test("renders stream frames to the encoder unless the user chose otherwise", () => {
  const src = fs.readFileSync(new URL("../src/hf.mjs", import.meta.url), "utf8");
  assert.match(src, /HF_CAPTURE_PARALLEL_STREAM: process\.env\.HF_CAPTURE_PARALLEL_STREAM \?\? "true"/);
});

test("a subtitle too long for three lines shrinks to fit three, not one", () => {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(new URL("../src/film-kit.js", import.meta.url), "utf8"), ctx);
  const view = { width: 1080, height: 1920, vertical: true, safe: { x: 64.8, y: 192, w: 864, h: 1267.2 } };
  // A canvas whose text width scales with the font size (≈0.5 em per character).
  const calls = [];
  let px = 50;
  const c = new Proxy(
    { calls, measureText: (s) => ({ width: String(s).length * px * 0.5 }), set font(f) { px = parseFloat(String(f).split(" ")[1]); }, get font() { return ""; } },
    { get: (o, k) => (k in o ? o[k] : (...a) => calls.push([k, ...a])), set: (o, k, v) => ((k === "font" ? (px = parseFloat(String(v).split(" ")[1])) : (o[k] = v)), true) },
  );
  const text = "Remote control, too: click the live picture in a browser, even from outside your network, or pair the iPhone app and drive several phones from one place.";
  ctx.window.__filmKit(view, { captions: [{ text, start: 0, end: 3 }] }).captions(c, 1);
  const rows = calls.filter((x) => x[0] === "fillText");
  assert.equal(rows.length, 3, JSON.stringify(rows.map((r) => r[1])));
  assert.equal(rows.map((r) => r[1]).join(" "), text);
});

test("springZeta: closed-form progress by damping ratio; zeta 1 never overshoots, 0.5 bounces", () => {
  const M = kit();
  const peak = (zeta, hz = 2) => Math.max(...Array.from({ length: 4000 }, (_, i) => M.springZeta(i / 1000, zeta, hz)));
  assert.equal(M.springZeta(0, 0.5), 0);
  assert.equal(M.springZeta(-1, 0.5), 0);
  assert.ok(peak(1) <= 1 + 1e-12, `zeta 1 peaks at ${peak(1)}`);
  assert.ok(peak(1.6) <= 1 + 1e-12, "overdamped never overshoots");
  // overshoot of a second-order step: e^(−πζ/√(1−ζ²)) → 16.3% at 0.5, 4.6% at 0.7, 0.6% at 0.85
  assert.ok(Math.abs(peak(0.5) - 1.163) < 0.002, `zeta 0.5 peaks at ${peak(0.5)}`);
  assert.ok(peak(0.85) < 1.01, "the premium band barely settles");
  for (const z of [0.2, 0.5, 0.7, 1, 2]) assert.ok(Math.abs(M.springZeta(6, z, 2) - 1) < 1e-3, `zeta ${z} converges`);
  // a pure function of t: the same frame twice is the same value, whatever came before
  assert.equal(M.springZeta(0.37, 0.6, 3), M.springZeta(0.37, 0.6, 3));
  // continuous across the critical point
  assert.ok(Math.abs(M.springZeta(0.3, 1) - M.springZeta(0.3, 0.999999)) < 1e-4);
  assert.ok(Math.abs(M.springZeta(0.3, 1) - M.springZeta(0.3, 1.000001)) < 1e-4);
});
