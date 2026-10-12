import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { initFilm, validateFilm, checkFilm, buildFilm } from "../src/film.mjs";
import { filmInputs } from "../src/snapshot.mjs";
import { checkFrames, engineArgv, frameRange, splitFrames } from "../src/engine.mjs";
import { runHyperframes } from "../src/hf.mjs";
import { main } from "../src/cli.mjs";

process.env.MOTION_USE_NO_UPDATE_CHECK = "1";
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-engine.mjs");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mu-engine-"));

/** A 2 s, 30 fps landscape film; `engine` and `draw` (overlay code, or null for none) vary. */
function project({ engine = { type: "command", command: [process.execPath, FAKE] }, draw = null, edit } = {}) {
  const dir = temp();
  initFilm({ lang: "en", format: "landscape" }, dir);
  const file = path.join(dir, "film.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  Object.assign(data, {
    voiceover: false,
    music: { builtin: "pulse", volume: 0.5 },
    duration: 2,
    fps: 30,
    shots: [{ id: "only", start: 0, end: 2, purpose: "probe the engine", action: "a test pattern slides along a teal floor" }],
  });
  delete data.brief;
  if (engine) data.engine = engine;
  if (draw === null) delete data.composition;
  else fs.writeFileSync(path.join(dir, "composition", "draw.js"), draw);
  edit?.(data, dir);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return { dir, file, data };
}

async function run(args) {
  const out = [],
    err = [];
  const [log, error] = [console.log, console.error];
  console.log = (...a) => out.push(a.join(" "));
  console.error = (...a) => err.push(a.join(" "));
  try {
    const code = await main(args);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    [console.log, console.error] = [log, error];
  }
}

/** RGB of one pixel of a PNG, or of an MP4 at `at` seconds. */
const pixel = (file, x, y, at) =>
  [...execFileSync("ffmpeg", ["-v", "error", ...(at === undefined ? [] : ["-ss", String(at)]), "-i", file, "-frames:v", "1", "-vf", `crop=2:2:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])].slice(0, 3);
const near = (a, b, tol = 24) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const TEAL = [0x2a, 0x9d, 0x8f];

const chrome = async () => {
  const r = await runHyperframes(["browser", "path"], {});
  const p = r.out.trim().split("\n").pop();
  return r.code === 0 && p && fs.existsSync(p);
};

test("engine validation: argv array of strings, composition optional, warns about --allow-code", () => {
  const { dir, data } = project();
  fs.writeFileSync(path.join(dir, "scene.py"), "# scene\n");
  data.engine.command = ["blender", "-b", "-P", "scene.py", "--"];
  const ok = validateFilm(data, dir);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.film.source, null);
  // a file argument inside the film folder is passed as an absolute path; "blender" stays a PATH lookup
  assert.deepEqual(ok.film.engine.command, ["blender", "-b", "-P", path.join(dir, "scene.py"), "--"]);
  assert.ok(ok.warnings.some((w) => w.path === "$.engine" && /--allow-code/.test(w.message)));
  // the command is recorded in film.json; the files it names are snapshot inputs
  assert.ok(filmInputs(ok.film, path.join(dir, "film.json")).some((x) => x.role === "engine" && x.file === path.join(dir, "scene.py")));
  for (const bad of ["blender -b", [], ["blender", 3], [""]]) {
    data.engine.command = bad;
    assert.ok(validateFilm(data, dir).errors.some((e) => e.path === "$.engine.command"), JSON.stringify(bad));
  }
  data.engine = { type: "command", command: ["x"], env: { A: 1 } };
  assert.ok(validateFilm(data, dir).errors.some((e) => e.path === "$.engine.env"));
  data.engine = { type: "browser" };
  fs.rmSync(path.join(dir, "composition", "draw.js"));
  assert.ok(validateFilm(data, dir).errors.some((e) => e.path === "$.composition"), "a browser film still needs its drawing");
  data.engine = { type: "unity" };
  assert.ok(validateFilm(data, dir).errors.some((e) => e.path === "$.engine"));
});

test("frame ranges: --from/--to map to inclusive frames, workers split them into contiguous chunks", () => {
  assert.deepEqual(frameRange(30, 0, 2), { from: 0, to: 59 });
  assert.deepEqual(frameRange(30, 1, 2), { from: 30, to: 59 });
  assert.deepEqual(splitFrames({ from: 30, to: 59 }, 2), [{ from: 30, to: 44 }, { from: 45, to: 59 }]);
  assert.deepEqual(splitFrames({ from: 0, to: 1 }, 4), [{ from: 0, to: 0 }, { from: 1, to: 1 }]);
  const dir = temp();
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x36", "-frames:v", "1", path.join(dir, "00003.png")]);
  assert.equal(checkFrames(dir, { from: 3, to: 3 }, 64, 36), null);
  assert.match(checkFrames(dir, { from: 3, to: 4 }, 64, 36), /wrote 1 of 2 frames .*missing 00004\.png/);
  assert.match(checkFrames(dir, { from: 3, to: 3 }, 1920, 1080), /00003\.png is 64×36, expected 1920×1080/);
});

test("files: any local file is copied, exposed as window.filmFiles and film.files, and must exist", async () => {
  const { dir, data } = project({
    engine: null,
    draw: "window.drawFrame = function (c, t, film, view) { c.fillStyle = '#222'; c.fillRect(0, 0, view.width, view.height); };",
  });
  fs.mkdirSync(path.join(dir, "models"));
  fs.writeFileSync(path.join(dir, "models", "alice.vrm"), Buffer.alloc(1234, 7));
  data.files = { alice: "models/alice.vrm" };
  const c = validateFilm(data, dir);
  assert.deepEqual(c.errors, []);
  assert.equal(c.film.files.alice, path.join(dir, "models", "alice.vrm"));
  assert.ok(filmInputs(c.film, path.join(dir, "film.json")).some((x) => x.role === "file"));
  const proj = await buildFilm(c.film, "en", "landscape", path.join(dir, "out", ".build", "x"));
  assert.equal(fs.statSync(path.join(proj.dir, "assets", "files", "alice.vrm")).size, 1234);
  assert.deepEqual(proj.config.files, { alice: "assets/files/alice.vrm" });
  assert.match(fs.readFileSync(path.join(proj.dir, "index.html"), "utf8"), /connect-src 'self'/);
  data.files = { gone: "models/missing.glb" };
  assert.ok(validateFilm(data, dir).errors.some((e) => e.path === "$.files.gone"));
  data.files = { out: "../secret.bin" };
  assert.ok(validateFilm(data, dir).errors.some((e) => e.path === "$.files.out"));
});

test("files: the drawing code fetches a declared file in the real renderer", { timeout: 180000 }, async (t) => {
  if (!(await chrome())) return t.skip("no Chrome for rendering");
  const { dir } = project({
    engine: null,
    draw: `window.setupFilm = async function () {
      const r = await fetch(window.filmFiles.blob);
      window.blobBytes = (await r.arrayBuffer()).byteLength;
    };
    window.drawFrame = function (c, t, film, view) {
      c.fillStyle = window.blobBytes === 1234 && film.files.blob === window.filmFiles.blob ? "#20c040" : "#e02020";
      c.fillRect(0, 0, view.width, view.height);
    };`,
    edit: (data, dir) => {
      fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.alloc(1234, 1));
      data.files = { blob: "blob.bin" };
    },
  });
  const r = await run(["still", dir, "--allow-code", "--at", "0.5", "--no-text-check", "--json"]);
  assert.equal(r.code, 0, r.out + r.err);
  const frame = JSON.parse(r.out).outputs[0].frames[0];
  assert.ok(near(pixel(frame, 960, 540), [0x20, 0xc0, 0x40]), `fetch failed: ${pixel(frame, 960, 540)}`);
});

test("external engine: render, release master and manifest; text check skipped without an overlay", { timeout: 300000 }, async (t) => {
  if (!(await chrome())) return t.skip("no Chrome for rendering");
  const { dir } = project();
  const log = path.join(dir, "jobs.ndjson");
  const data = JSON.parse(fs.readFileSync(path.join(dir, "film.json"), "utf8"));
  data.engine.env = { FAKE_ENGINE_LOG: log };
  fs.writeFileSync(path.join(dir, "film.json"), JSON.stringify(data));
  const r = await run(["render", dir, "--allow-code", "--release", "--no-asr", "--json"]);
  assert.equal(r.code, 0, r.out + r.err);
  const res = JSON.parse(r.out),
    o = res.outputs[0];
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,nb_frames", "-of", "json", o.file], { encoding: "utf8" }));
  const v = probe.streams.find((s) => s.codec_type === "video");
  assert.deepEqual([v.width, v.height, Number(v.nb_frames)], [1920, 1080, 60]);
  assert.ok(probe.streams.some((s) => s.codec_type === "audio"), "the mix rides along with the browser layer");
  assert.ok(Math.abs(Number(probe.format.duration) - 2) < 0.05);
  assert.ok(near(pixel(o.file, 10, 10, 1), TEAL));
  assert.deepEqual(o.verification.text_check.skipped, "external engine");
  const report = JSON.parse(fs.readFileSync(o.verification.report, "utf8"));
  assert.equal(report.text_check.skipped, "external engine");
  const manifest = JSON.parse(fs.readFileSync(res.release_manifest, "utf8"));
  assert.ok(manifest.files.some((e) => e.kind === "master" && e.file === "my-film-en-landscape.mp4"), JSON.stringify(manifest.files));
  // one job for the whole film, with the resolved film and the safe box
  const jobs = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(jobs.map((j) => j.frames), [{ from: 0, to: 59 }]);
  const j = jobs[0];
  assert.deepEqual([j.lang, j.format, j.width, j.height, j.fps, j.duration, j.pattern], ["en", "landscape", 1920, 1080, 30, 2, "%05d.png"]);
  assert.ok(Object.keys(j.film.copy).length > 0 && Array.isArray(j.film.captions) && j.film.dir === dir);
  assert.deepEqual(j.safe, { x: 96, y: 64.8, w: 1728, h: 950.4 });
  // the snapshot keeps the command line in film.json
  const snap = JSON.parse(fs.readFileSync(path.join(dir, "out", ".snapshots", `${res.snapshot}.json`), "utf8"));
  assert.deepEqual(snap.engine.command, [process.execPath, FAKE]);
});

test("external engine: a --from/--to preview asks only for those frames, split across --workers", { timeout: 180000 }, async (t) => {
  if (!(await chrome())) return t.skip("no Chrome for rendering");
  const { dir } = project();
  const log = path.join(dir, "jobs.ndjson");
  const data = JSON.parse(fs.readFileSync(path.join(dir, "film.json"), "utf8"));
  data.engine.env = { FAKE_ENGINE_LOG: log };
  fs.writeFileSync(path.join(dir, "film.json"), JSON.stringify(data));
  const r = await run(["render", dir, "--allow-code", "--from", "1", "--to", "2", "--workers", "2", "--json"]);
  assert.equal(r.code, 0, r.out + r.err);
  const jobs = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(jobs.map((j) => j.frames).sort((a, b) => a.from - b.from), [{ from: 30, to: 44 }, { from: 45, to: 59 }]);
  const file = JSON.parse(r.out).outputs[0].file;
  const frames = execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file], { encoding: "utf8" });
  assert.equal(Number(frames), 30);
});

test("external engine: a short or wrong-size frame sequence, or a failing command, fails the render clearly", { timeout: 180000 }, async (t) => {
  if (!(await chrome())) return t.skip("no Chrome for rendering");
  for (const [env, expected] of [
    [{ FAKE_ENGINE_DROP: "3" }, /wrote 27 of 30 frames .*missing 00057\.png/],
    [{ FAKE_ENGINE_SIZE: "640x360" }, /00030\.png is 640×360, expected 1920×1080/],
    [{ FAKE_ENGINE_FAIL: "1" }, /exited with 3: fake engine: scene failed to load/],
  ]) {
    const { dir } = project();
    const data = JSON.parse(fs.readFileSync(path.join(dir, "film.json"), "utf8"));
    data.engine.env = env;
    fs.writeFileSync(path.join(dir, "film.json"), JSON.stringify(data));
    const r = await run(["render", dir, "--allow-code", "--from", "1", "--to", "2", "--json"]);
    assert.equal(r.code, 1);
    assert.match(JSON.parse(r.out).outputs[0].error, expected);
  }
  // without --allow-code nothing runs
  const { dir } = project();
  assert.equal((await run(["render", dir, "--from", "1", "--to", "2"])).code, 1);
  assert.equal(fs.existsSync(path.join(dir, "out")), false);
});

test("external engine with a composition: subtitles drawn as a transparent overlay, measured by the text check", { timeout: 300000 }, async (t) => {
  if (!(await chrome())) return t.skip("no Chrome for rendering");
  const { dir } = project({
    draw: `window.drawFrame = function (c, t, film, view, M) {
      c.fillStyle = "#ffffff"; c.fillRect(100, 100, 400, 200);
      M.text(c, "Subtitle over the engine", view.width / 2, 900, 56, "#ffffff", 700, "center");
    };`,
  });
  const r = await run(["render", dir, "--allow-code", "--quality", "draft", "--no-asr", "--json"]);
  assert.equal(r.code, 0, r.out + r.err);
  const o = JSON.parse(r.out).outputs[0];
  assert.ok(near(pixel(o.file, 300, 200, 1), [255, 255, 255]), `overlay: ${pixel(o.file, 300, 200, 1)}`);
  assert.ok(near(pixel(o.file, 1800, 40, 1), TEAL), `engine: ${pixel(o.file, 1800, 40, 1)}`);
  assert.equal(o.verification.text_check.skipped, undefined);
  assert.ok(Array.isArray(o.verification.text_check.runs));
  // stills: the engine frame for that time with the overlay snapshot on top
  const s = await run(["still", dir, "--allow-code", "--at", "0.5,1.5", "--no-text-check", "--json"]);
  assert.equal(s.code, 0, s.out + s.err);
  const still = JSON.parse(s.out).outputs[0];
  assert.equal(still.frames.length, 2);
  assert.ok(near(pixel(still.frames[0], 300, 200), [255, 255, 255]));
  assert.ok(near(pixel(still.frames[0], 1800, 40), TEAL));
  assert.ok(fs.existsSync(still.sheet));
});

test("a bare motion-render engine command runs the renderer motion-use found", () => {
  const found = () => ({ bin: "/opt/mu/native/bin/motion-render", caps: {} });
  assert.deepEqual(engineArgv({ command: ["motion-render", "/f/composition/engine.html"] }, found), ["/opt/mu/native/bin/motion-render", "/f/composition/engine.html"]);
  // not installed: left to PATH; other commands untouched
  assert.deepEqual(engineArgv({ command: ["motion-render", "x.html"] }, () => ({ missing: "no" })), ["motion-render", "x.html"]);
  assert.deepEqual(engineArgv({ command: ["blender", "-b"] }, found), ["blender", "-b"]);
  assert.deepEqual(engineArgv({ command: ["/usr/local/bin/motion-render", "a"] }, found), ["/usr/local/bin/motion-render", "a"]);
});
