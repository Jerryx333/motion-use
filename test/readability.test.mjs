import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { contrastRuns, describeText, probeText, readingRuns, readingSeconds } from "../src/text-probe.mjs";
import { measureMotion, gradeMotion } from "../src/motion-check.mjs";
import { initFilm, checkFilm, buildFilm, validateFilm } from "../src/film.mjs";
import { runHyperframes } from "../src/hf.mjs";
import { findRenderer, nativeProbe } from "../src/native.mjs";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mu-read-"));
const box = (text, x0, y0, x1, y1, extra = {}) => ({ text, x0, y0, x1, y1, alpha: 1, ...extra });
const every = (to, f, step = 0.1) => Array.from({ length: Math.round(to / step) + 1 }, (_, i) => +(i * step).toFixed(2)).map((t) => ({ t, boxes: f(t).filter(Boolean) }));

test("reading time: 0.3 s per word, 0.15 s per CJK character, plus 0.5 s", () => {
  assert.equal(readingSeconds("Two things, one gap."), 1.7);
  assert.equal(readingSeconds("任何 App，不需要 API"), 1.85);
  assert.equal(readingSeconds("对面有了回应。"), 1.55);
});

test("reading check: a callout gone after 1 s is flagged with its time and required seconds", () => {
  const line = "scan with an iPhone: no address";
  const runs = readingRuns(every(4, (t) => [t >= 1 && t < 2 && box(line, 100, 100, 900, 140), box("held to the end", 100, 900, 600, 960)]), { width: 1920, height: 1080 });
  assert.deepEqual(runs.map((r) => [r.kind, r.text, r.from, r.to, r.seconds, r.required]), [["reading", line, 1, 2, 1, 2.3]]);
  assert.match(describeText({ runs })[0], /1–2s for 1s, needs 2.3s to read \(0.3 s per word \+ 0.15 s per CJK character \+ 0.5 s\)/);
});

test("reading check: a line held long enough, words arriving one by one and a rolling counter pass", () => {
  const words = ["Hold", "the", "line"];
  const runs = readingRuns(
    every(5, (t) => [
      t >= 0.5 && t < 3 && box("scan with an iPhone: no address", 100, 100, 900, 140),
      // M.words: each word is its own string; the line counts from its first word
      ...words.map((w, k) => t >= 3 + k * 0.3 && t < 4.6 && box(w, 100 + k * 200, 500, 250 + k * 200, 560)),
      // M.count: a different number every sample, next to its label
      t < 4 && box(`${Math.round(t * 997)} users`, 1000, 800, 1400, 860),
    ]),
    { width: 1920, height: 1080 },
  );
  assert.deepEqual(runs, []);
});

test("shot text that cannot be read inside its shot window is a validate warning", () => {
  const d = temp();
  initFilm({ lang: "en", format: "landscape" }, d);
  const data = JSON.parse(fs.readFileSync(path.join(d, "film.json"), "utf8"));
  data.voiceover = false;
  const shot = data.shots[1];
  const seconds = shot.end - shot.start;
  shot.text = "one two three four five six seven eight";
  const slow = validateFilm(data, d).warnings.filter((w) => w.path === "$.shots[1].text" && /needs/.test(w.message));
  assert.equal(slow.length, seconds < 2.9 ? 1 : 0, JSON.stringify(slow));
  shot.end = shot.start + 0.9;
  data.shots[2].start = shot.end;
  shot.text = "Short words here";
  const w = validateFilm(data, d).warnings.find((x) => x.path === "$.shots[1].text" && /needs/.test(x.message));
  assert.match(w.message, /0\.9s on screen; reading it needs 1\.4s \(0\.3 s per word/);
  shot.text = "Go";
  assert.equal(validateFilm(data, d).warnings.filter((x) => x.path === "$.shots[1].text" && /needs/.test(x.message)).length, 0);
});

test("contrast check: low contrast held while fully shown is flagged; fades, large text at 3:1 and brief dips pass", () => {
  const low = (t) => box("grey on grey", 100, 100, 500, 140, { contrast: 1.18, large: true, color: "#777777", backdrop: "#888888" });
  const runs = contrastRuns(every(2, (t) => [t >= 0.5 && t <= 1.5 && low(t)]));
  assert.deepEqual(runs.map((r) => [r.kind, r.text, r.from, r.to, r.contrast, r.need]), [["contrast", "grey on grey", 0.5, 1.5, 1.18, 3]]);
  assert.match(describeText({ runs })[0], /low contrast 1.18:1 0.5–1.5s, #777777 on #888888 \(WCAG 3:1 for large text/);
  // small text needs 4.5:1, so 4.0 fails and large text passes at 3.2
  assert.equal(contrastRuns(every(1, () => [box("caption", 0, 0, 10, 10, { contrast: 4, large: false })])).length, 1);
  const pass = contrastRuns(
    every(2, (t) => [
      box("large enough", 0, 0, 10, 10, { contrast: 3.2, large: true }),
      box("fading in", 0, 20, 10, 30, { contrast: 1.2, large: true, alpha: 0.6 }),
      t === 1 && box("one frame", 0, 40, 10, 50, { contrast: 1.2, large: true }),
      box("white on black", 0, 60, 10, 70, { contrast: 18.1, large: false }),
    ]),
  );
  assert.deepEqual(pass, []);
});

test("contrast check: offset extrusion layers use only the last draw of the same size and string", () => {
  const layer = (text, dx, color, contrast, size = 60) => box(text, 100 + dx, 100 + dx, 500 + dx, 160 + dx, { size, color, contrast, large: true, backdrop: "#55aa66" });
  const shadow = (dx) => layer("Impact", dx, "#1a1612", 1.66);
  const face = layer("Impact", 0, "#ffffff", 4.2);
  assert.deepEqual(contrastRuns(every(1, () => [shadow(9), shadow(6), shadow(3), face])), []);
  // A low-contrast top face must be reported instead of the lower layers.
  const low = contrastRuns(every(1, () => [shadow(9), shadow(6), shadow(3), { ...face, contrast: 2.5 }]));
  assert.deepEqual(low.map((r) => [r.color, r.contrast]), [["#ffffff", 2.5]]);
  for (const separate of [layer("Other", 0, "#ffffff", 4.2), { ...face, x0: 116, x1: 516 }, layer("Impact", 0, "#ffffff", 4.2, 61)]) {
    const runs = contrastRuns(every(1, () => [shadow(0), separate]));
    assert.deepEqual(runs.map((r) => [r.text, r.color]), [["Impact", "#1a1612"]]);
  }
  const both = contrastRuns(every(1, () => [shadow(0), layer("Other", 0, "#333333", 2)]));
  assert.deepEqual(both.map((r) => r.text), ["Impact", "Other"]);
});

const make = (dir, name, filter, seconds = 4) => {
  const file = path.join(dir, name);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", filter, "-t", String(seconds), "-pix_fmt", "yuv420p", file]);
  return file;
};
// A full-frame square wave between black and white, hz full cycles a second.
const strobe = (hz) => `color=black:s=640x360:r=30,format=yuv420p,geq=lum='if(lt(mod(T*${2 * hz}\\,2)\\,1)\\,235\\,16)':cb=128:cr=128`;

test("flash check: a 5 Hz full-frame strobe is red with its window; one flash a second and moving bars are green", () => {
  const dir = temp();
  const bad = measureMotion(make(dir, "strobe.mp4", strobe(5)));
  assert.equal(bad.flashes_per_s, 5);
  assert.ok(bad.flash_windows.length === 1 && bad.flash_windows[0].start < 0.2 && bad.flash_windows[0].end > 3.5, JSON.stringify(bad.flash_windows));
  assert.equal(gradeMotion(bad).rows.find((r) => r.metric === "flashes_per_s").level, "red");
  for (const [name, filter] of [["slow.mp4", strobe(1)], ["bars.mp4", "smptebars=s=640x360:r=30,scroll=h=0.04"]]) {
    const ok = measureMotion(make(dir, name, filter));
    assert.ok(ok.flashes_per_s <= 1, `${name}: ${ok.flashes_per_s}`);
    assert.deepEqual(ok.flash_windows, []);
    assert.equal(gradeMotion(ok).rows.find((r) => r.metric === "flashes_per_s").level, "green");
  }
});

const chrome = async () => {
  const r = await runHyperframes(["browser", "path"], {});
  const p = r.out.trim().split("\n").pop();
  return r.code === 0 && p && fs.existsSync(p);
};

test("text check on a real film: grey on grey and a 1 s callout are flagged; white on near-black is not", { timeout: 180000 }, async (t) => {
  const renderers = [];
  if (await chrome()) renderers.push(["chrome", null]);
  if (process.env.MOTION_RENDER && process.env.MOTION_RENDER !== "0") {
    const native = findRenderer();
    assert.ok(native.bin, native.missing);
    renderers.push(["native", native]);
  }
  if (!renderers.length) return t.skip("no Chrome or requested motion-render for rendering");
  const dir = temp();
  initFilm({ lang: "en", format: "landscape" }, dir);
  const file = path.join(dir, "film.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  Object.assign(data, { voiceover: false, music: "none", duration: 3, shots: [{ id: "only", start: 0, end: 3, purpose: "probe", action: "two labels and a callout" }] });
  fs.writeFileSync(file, JSON.stringify(data));
  fs.writeFileSync(
    path.join(dir, "composition", "draw.js"),
    `window.drawFrame = function (c, t, film, view, M) {
      c.fillStyle = "#101010"; c.fillRect(0, 0, view.width, view.height);
      M.text(c, "White on near black", view.width / 2, 200, 80, "#ffffff", 700, "center");
      c.fillStyle = "#888888"; c.fillRect(200, 400, 900, 160);
      if (t >= 0.4 && t < 2.6) M.text(c, "grey on grey", 260, 480, 60, "#777777", 700, "left");
      M.punch(c, t, "Extruded white text", 0, 3, { y: 0.62, size: 60, fill: "#30683e", dark: "#1a1612" });
      if (t >= 1 && t < 2) M.text(c, "scan with an iPhone: no address", 300, 800, 40, "#ffffff", 600, "left");
    };`,
  );
  const c = checkFilm(file, {});
  assert.deepEqual(c.report.errors, []);
  const proj = await buildFilm(c.film, "en", "landscape", path.join(dir, "out", ".build", "probe"));
  const results = [];
  for (const [renderer, native] of renderers) await t.test(renderer, async () => {
    if (native) {
      const raw = await nativeProbe({ bin: native.bin, projDir: proj.dir, times: [1], work: path.join(proj.dir, ".probe") });
      const layers = raw.samples[0].boxes.filter((b) => b.text === "Extruded white text");
      assert.ok(layers.length > 1);
      assert.ok(layers.every((b) => b.size > 0 && b.size === layers[0].size), JSON.stringify(layers));
      assert.equal(layers.at(-1).color, "#ffffff");
    }
    const r = await probeText(proj.dir, proj.total, { native });
    assert.equal(r.skipped, undefined, r.skipped);
    assert.equal(r.renderer, renderer);
    const low = r.runs.filter((x) => x.kind === "contrast");
    assert.deepEqual(low.map((x) => [x.text, x.color, x.backdrop, x.need]), [["grey on grey", "#777777", "#888888", 3]], JSON.stringify(r.runs));
    assert.ok(low[0].contrast < 1.3 && low[0].from <= 0.5 && low[0].to >= 2.4, JSON.stringify(low[0]));
    const slow = r.runs.filter((x) => x.kind === "reading");
    assert.deepEqual(slow.map((x) => x.text), ["scan with an iPhone: no address"], JSON.stringify(r.runs));
    assert.ok(Math.abs(slow[0].seconds - 1) < 0.05 && slow[0].required === 2.3, JSON.stringify(slow[0]));
    results.push(r.runs);
  });
  if (results.length === 2) assert.deepEqual(results[0], results[1], "Chrome and native text checks agree");
});
