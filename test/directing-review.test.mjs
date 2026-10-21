import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { initFilm, checkFilm, validateFilm, buildFilm } from "../src/film.mjs";
import { validateRhythm, rhythmPlan } from "../src/rhythm.mjs";
import { CARDS, recommendCatalog, writeGallery } from "../src/catalog.mjs";
import { addReview, listReview, updateReview, writeFrameReviewPage, reviewContext } from "../src/review.mjs";
import { retimeFilm } from "../src/retime.mjs";
import { runScore } from "../src/score.mjs";
import { runHyperframes } from "../src/hf.mjs";
import { hashBatchPath } from "../src/batch.mjs";
import { findRenderer, nativeStills } from "../src/native.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "motion-directing-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  initFilm({ lang: "en", format: "square" }, dir);
  const file = path.join(dir, "film.json"), data = JSON.parse(fs.readFileSync(file));
  Object.assign(data, { duration: 4, bpm: 120, voiceover: false, music: "none", motionBlur: { samples: 1, shutter: 0 }, copy: { en: { title: "Test" } }, shots: [
    { id: "a", start: 0, end: 2, purpose: "test", action: "an object moves" },
    { id: "b", start: 2, end: 4, purpose: "test", action: "an object stops" },
  ] });
  delete data.brief;
  const save = () => fs.writeFileSync(file, JSON.stringify(data)); save();
  return { dir, file, data, save };
}
const plan = () => ({ route: "continuous", bpm: 120, phases: [
  { id: "opening", type: "hook", from: 0, to: 2, energy: 7, action: "A signal travels" },
  { id: "ending", type: "resolve", from: 2, to: 4, energy: 3, action: "The result stays readable" },
], events: [{ id: "arrival", at: 1, kind: "reveal", shot: "a" }, { id: "reply", at: 2, kind: "sound", shot: "b" }] });
function png(p, colour = "0x38bd91") {
  const file = path.join(p.dir, "frame.png");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=640x360`, "-frames:v", "1", file]);
  return file;
}
const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, "bin/motion-use.mjs"), ...args, "--json"], { encoding: "utf8", env: { ...process.env, MOTION_USE_NO_UPDATE_CHECK: "1" }, maxBuffer: 32 << 20 });

test("rhythm distinguishes declared plan, unplanned films and actual review acceptance", (t) => {
  const p = fixture(t);
  assert.equal(rhythmPlan(p.data).status, "UNPLANNED");
  p.data.rhythm = plan();
  const result = rhythmPlan(p.data);
  assert.equal(result.status, "PLANNED");
  assert.equal(result.visualReview, "UNREVIEWED");
  assert.equal(result.listeningReview, "UNREVIEWED");
  assert.equal(result.evidence, "author-declared-plan");
  assert.deepEqual(result.phases.map((p) => p.events.map((e) => e.id)), [["arrival"], ["reply"]]);
  assert.equal(result.phases[0].declaredEventsPerBar, 1);
  const unspecified = plan(); delete unspecified.events; delete unspecified.bpm;
  const missing = rhythmPlan({ ...p.data, rhythm: unspecified });
  assert.equal(missing.eventsDeclared, false);
  assert.equal(missing.phases[0].declaredEventCount, null);
  assert.equal(missing.phases[0].declaredEventsPerBar, null);
  assert.deepEqual(validateFilm(p.data, p.dir).errors, []);
  p.save();
  const r = cli("rhythm", p.dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).evidence, "author-declared-plan");
});

test("rhythm rejects gaps, overlaps, bad anchors and invalid phases without imposing a genre template", (t) => {
  const p = fixture(t);
  for (const mutate of [
    (r) => { r.phases[1].from = 2.1; }, (r) => { r.phases[1].from = 1.9; },
    (r) => { r.phases[1].to = 3; }, (r) => { r.phases[0].energy = 11; },
    (r) => { r.phases[0].shots = ["missing"]; }, (r) => { r.events[0].at = 4; },
    (r) => { r.events[0].shot = "b"; }, (r) => { r.phases[0].type = "stop"; },
    (r) => { r.route = "slideshow"; }, (r) => { r.phases[0] = null; },
  ]) {
    const r = plan(); mutate(r);
    assert.ok(validateRhythm(r, p.data).errors.length, JSON.stringify(r));
  }
  const quiet = plan(); quiet.phases[0].energy = 3;
  const checked = validateRhythm(quiet, p.data);
  assert.equal(checked.errors.length, 0);
  assert.ok(checked.warnings.some((w) => /contrast/.test(w.message)));
});

test("rhythm survives shot-boundary retime, refusing ambiguous or overflowing event placements", (t) => {
  const p = fixture(t); p.data.rhythm = plan(); p.data.pace = 1.25; p.save();
  const source = fs.readFileSync(p.file);
  const result = retimeFilm(p.dir), data = JSON.parse(fs.readFileSync(result.film));
  assert.equal(data.rhythm.phases[1].from, 1.6);
  assert.equal(data.rhythm.phases[1].to, 3.2);
  assert.equal(data.rhythm.events[1].at, 1.6);
  assert.deepEqual(fs.readFileSync(p.file), source);
  p.data.rhythm.phases[0].to = 1; p.data.rhythm.phases[1].from = 1; p.save();
  assert.throws(() => retimeFilm(p.dir), /inside a shot/);
  p.data.rhythm = plan(); p.data.rhythm.events[0].at = 1.9; p.save();
  assert.throws(() => retimeFilm(p.dir), /exceeds its retimed shot/);
  assert.equal(fs.existsSync(path.join(p.dir, "film.retimed-2.json")), false);
  const unspecified = fixture(t); unspecified.data.rhythm = plan(); delete unspecified.data.rhythm.events; unspecified.save();
  const unchanged = JSON.parse(fs.readFileSync(retimeFilm(unspecified.dir).film));
  assert.equal(Object.hasOwn(unchanged.rhythm, "events"), false);
});

test("one rhythm event drives the drawing kit, score and built film configuration", async (t) => {
  const p = fixture(t); p.data.rhythm = plan(); p.save();
  const scope = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "src/film-kit.js"), "utf8"), scope);
  const M = scope.window.__filmKit({ width: 1440, height: 1440 }, p.data);
  assert.equal(M.rhythmEvent("arrival"), 1);
  assert.equal(M.rhythmPhase("ending").from, 2);
  M.rhythmPhase("ending").from = 99;
  assert.equal(M.rhythmPhase("ending").from, 2, "reading a phase does not expose mutable timeline state");
  assert.throws(() => M.rhythmEvent("unknown"), /no declared event/);
  const score = path.join(p.dir, "composition/score.js");
  fs.writeFileSync(score, 'window.scoreFilm=(film,S)=>{if(film.rhythm.route!=="continuous")throw Error("missing plan"); S.note("test",S.rhythmEvent("arrival"),60); S.note("test",S.rhythmPhase("ending").from,62);};');
  const result = runScore(score, p.data, {});
  assert.deepEqual(result.events.map((e) => e.t), [1, 2]);
  const checked = checkFilm(p.dir);
  const built = await buildFilm(checked.film, "en", "square", path.join(p.dir, "build"));
  assert.deepEqual(built.config.rhythm, p.data.rhythm);
});

test("catalog explains selection by explicit product/material fit and reports no-match without invented scores", (t) => {
  const p = fixture(t);
  assert.ok(CARDS.every((c) => c.fit.chooseWhen && c.fit.evidence === "authored-guidance" && c.fit.study.actualProductProof === false));
  const result = recommendCatalog({ productType: "data-explainer", material: "data" });
  assert.equal(result.ranked, false);
  assert.deepEqual(result.cards.map((c) => c.id), ["data-story", "before-after", "chart-reveal"]);
  assert.ok(result.cards.every((c) => c.reasons.length === 3 && c.score === undefined));
  assert.equal(recommendCatalog({ productType: "brand", material: "document" }).status, "NO_MATCH");
  assert.throws(() => recommendCatalog({ productType: "anything" }), /product-type/);
  const out = path.join(p.dir, "gallery");
  const r = cli("catalog", "recommend", "--product-type", "data-explainer", "--material", "data", "--out", out);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const json = JSON.parse(r.stdout);
  assert.equal(json.cards.length, 3);
  assert.equal(json.exportedCards, 3);
  assert.match(fs.readFileSync(json.gallery, "utf8"), /authored guidance/);
  assert.throws(() => writeGallery(out), /already exists/);
});

test("review captures immutable frames, detects later source changes and preserves reopening history", (t) => {
  const p = fixture(t), frame = png(p);
  const sourceHash = hash(fs.readFileSync(frame));
  const inputFingerprint = hashBatchPath(p.dir, [], { ignoreOperational: true }).hash;
  const added = addReview(p.dir, { at: 1, frame, note: "Make this readable", x: 100, y: 50, object: "value" });
  assert.equal(hashBatchPath(p.dir, [], { ignoreOperational: true }).hash, inputFingerprint, "feedback metadata does not invalidate render resume");
  assert.equal(added.acceptance, "UNREVIEWED");
  assert.equal(added.entry.frame.sha256, sourceHash);
  assert.equal(added.entry.frame.timeEvidence, "author-declared");
  assert.equal(listReview(p.dir).notes[0].stale, false);
  p.data.copy.en.title = "Changed copy"; p.save();
  let current = listReview(p.dir);
  assert.equal(current.notes[0].stale, true);
  png(p, "0xe04020");
  assert.equal(hash(fs.readFileSync(path.join(p.dir, ".motion-use/review", added.entry.frame.file))), sourceHash);
  assert.throws(() => updateReview(p.dir, added.entry.id, "done", { revision: added.revision, frame, note: "Changed" }), /revision/);
  const done = updateReview(p.dir, added.entry.id, "done", { revision: current.revision, frame, note: "Enlarged the number" });
  assert.equal(done.entry.status, "addressed");
  assert.equal(done.acceptance, "UNREVIEWED");
  assert.equal(listReview(p.dir).notes[0].stale, false);
  assert.throws(() => updateReview(p.dir, added.entry.id, "done", { revision: current.revision, frame, note: "Again" }), /only pending/);
  current = updateReview(p.dir, added.entry.id, "reopen", { revision: current.revision, note: "Still too small" });
  assert.equal(current.entry.status, "pending");
  assert.deepEqual(current.entry.history.map((e) => e.action), ["done", "reopen"]);
});

test("review rejects stale page imports, invalid frame points and metadata symlinks before writing notes", (t) => {
  const p = fixture(t), frame = png(p), page = path.join(p.dir, "review.html");
  writeFrameReviewPage(p.dir, { at: 1, frame, out: page });
  const html = fs.readFileSync(page, "utf8"), data = JSON.parse(/<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.throws(() => writeFrameReviewPage(p.dir, { at: 1, frame, out: page }), /EEXIST/);
  assert.throws(() => addReview(p.dir, { at: 1, frame, note: "bad", x: 640, y: 0 }), /coordinates/);
  assert.throws(() => addReview(p.dir, { at: 4, frame, note: "bad" }), /inside the film/);
  assert.throws(() => addReview(p.dir, { at: 1, frameData: "bm90LXBuZw==", note: "bad" }), /PNG/);
  assert.throws(() => addReview(p.dir, { at: 1, frameData: fs.readFileSync(frame).subarray(0, 33).toString("base64"), note: "truncated" }), /decode PNG/);
  p.data.copy.en.title = "New revision"; p.save();
  const file = path.join(p.dir, "comment.json"); fs.writeFileSync(file, JSON.stringify({ ...data, note: "Old view" }));
  const r = cli("review", "add", p.dir, "--input", file);
  assert.equal(r.status, 1); assert.match(r.stdout, /source revision changed/);
  assert.equal(fs.existsSync(path.join(p.dir, ".motion-use/review/notes.json")), false);
  fs.mkdirSync(path.join(p.dir, ".motion-use"), { recursive: true });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "motion-review-outside-")); t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(p.dir, ".motion-use/review"));
  assert.throws(() => listReview(p.dir), /real directory/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("offline frame page exports real click coordinates and imports the browser-produced comment", { timeout: 60000 }, async (t) => {
  const browserPath = await runHyperframes(["browser", "path"], {});
  const executablePath = browserPath.out.trim().split("\n").pop();
  if (browserPath.code !== 0 || !fs.existsSync(executablePath)) {
    if (process.env.MOTION_USE_REQUIRE_REVIEW_BROWSER) throw new Error("review browser acceptance requires isolated headless Chrome");
    return t.skip("no isolated headless Chrome");
  }
  const require = createRequire(createRequire(import.meta.url).resolve("hyperframes/package.json"));
  const browser = await require("puppeteer-core").launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  t.after(() => browser.close());
  const p = fixture(t), frame = png(p), file = path.join(p.dir, "review.html");
  writeFrameReviewPage(p.dir, { at: 1, frame, out: file });
  const page = await browser.newPage(); await page.setViewport({ width: 480, height: 900 });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  const network = []; page.on("request", (r) => { if (/^https?:/.test(r.url())) network.push(r.url()); });
  await page.evaluateOnNewDocument(() => {
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { window.__reviewDownload = blob; return create(blob); };
    HTMLAnchorElement.prototype.click = function () { window.__reviewFilename = this.download; };
  });
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction(() => document.querySelector("#frame").naturalWidth === 640);
  assert.equal(await page.$eval("#download", (e) => e.disabled), true);
  await page.focus("#frame"); await page.keyboard.press("Enter");
  assert.equal(await page.$eval("#pin", (e) => e.hidden), false, "keyboard can place a pin");
  const box = await page.$eval("#frame", (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.type("#note", "Please enlarge this value");
  await page.click("#download");
  const exported = await page.evaluate(async () => JSON.parse(await window.__reviewDownload.text()));
  assert.ok(Math.abs(exported.x - 320) <= 1 && Math.abs(exported.y - 180) <= 1);
  assert.equal(hash(Buffer.from(exported.frameData, "base64")), hash(fs.readFileSync(frame)));
  assert.equal(await page.evaluate(() => window.__reviewFilename), "frame-comment.json");
  const comment = path.join(p.dir, "comment.json"); fs.writeFileSync(comment, JSON.stringify(exported));
  const r = cli("review", "add", p.dir, "--input", comment);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const added = JSON.parse(r.stdout);
  assert.equal(added.entry.note, "Please enlarge this value");
  assert.equal(added.entry.shot, "a");
  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (process.env.MOTION_USE_REVIEW_SCREENSHOT) await page.screenshot({ path: process.env.MOTION_USE_REVIEW_SCREENSHOT + "-mobile.png", fullPage: true });
  await page.setViewport({ width: 1280, height: 800 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (process.env.MOTION_USE_REVIEW_SCREENSHOT) await page.screenshot({ path: process.env.MOTION_USE_REVIEW_SCREENSHOT + "-desktop.png", fullPage: true });
});

test("native rendering seeks a shared rhythm event on the correct side of its boundary", { timeout: 60000 }, async (t) => {
  const renderer = findRenderer(); if (renderer.missing) return t.skip("no native renderer");
  const p = fixture(t); p.data.rhythm = plan(); p.save();
  fs.writeFileSync(path.join(p.dir, "composition/draw.js"), 'window.drawFrame=(c,t,f,v,M)=>{c.fillStyle=t<M.rhythmEvent("arrival")?"#e04020":"#38bd91";c.fillRect(0,0,v.width,v.height);};');
  const checked = checkFilm(p.dir), built = await buildFilm(checked.film, "en", "square", path.join(p.dir, "build"));
  const dir = path.join(p.dir, "frames"); fs.mkdirSync(dir);
  const r = await nativeStills({ bin: renderer.bin, proj: built, times: [0.99, 1], dir });
  assert.equal(r.code, 0, r.out);
  const frames = fs.readdirSync(dir).filter((n) => n.endsWith(".png")).sort();
  const pixel = (file) => execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", "crop=1:1:0:0,format=rgb24", "-f", "rawvideo", "-"]);
  assert.deepEqual([...pixel(path.join(dir, frames[0]))], [224, 64, 32]);
  assert.deepEqual([...pixel(path.join(dir, frames[1]))], [56, 189, 145]);
});
