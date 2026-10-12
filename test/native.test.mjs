// The native renderer as motion-use's default: renderer choice and fallbacks, the ffmpeg mix
// against HyperFrames' mix, native vs Chrome deliveries of the 2D examples, the raw-stream engine
// contract. Tests that need motion-render or Chrome skip when they are missing.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { initFilm, checkFilm, buildFilm, validateFilm } from "../src/film.mjs";
import { chooseRenderer, findRenderer, webglUse, unsupportedContext } from "../src/native.mjs";
import { envelope, mixAudio } from "../src/mix.mjs";
import { runHyperframes } from "../src/hf.mjs";
import { compareRenders, loudness, pcm, renderWith, rmsWindows } from "../native/bench/e2e.mjs";

process.env.MOTION_USE_NO_UPDATE_CHECK = "1";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "motion-use.mjs");
const FAKE = path.join(ROOT, "test", "fixtures", "fake-engine.mjs");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mu-native-"));
const native = findRenderer();
const chrome = async () => {
  const r = await runHyperframes(["browser", "path"], {});
  const p = r.out.trim().split("\n").pop();
  return r.code === 0 && p && fs.existsSync(p);
};
const cli = (args, env = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", maxBuffer: 64 << 20, env: { ...process.env, ...env } });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {}
  return { code: r.status, json, out: r.stdout, err: r.stderr };
};

/** A short square film: built-in music, two effects (one aligned on its peak), a mono voice clip. */
function soundFilm({ draw, duration = 4 } = {}) {
  const dir = temp();
  initFilm({ lang: "en", format: "square" }, dir);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.2", "-ac", "1", path.join(dir, "voice.wav")]);
  const file = path.join(dir, "film.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  Object.assign(d, {
    duration,
    voiceover: false,
    music: { builtin: "pulse", volume: 0.6 },
    shots: [{ id: "a", start: 0, end: duration, purpose: "mix and picture check", action: "Two objects move" }],
    audio: [
      { effect: "click", start: 0.5 },
      { effect: "whoosh", start: +(duration * 0.55).toFixed(2), align: "peak", volume: 0.8 },
      { file: "voice.wav", lang: "en", role: "voiceover", start: 1, volume: 1 },
    ],
  });
  delete d.brief;
  if (draw) fs.writeFileSync(path.join(dir, "composition", "draw.js"), draw);
  fs.writeFileSync(file, JSON.stringify(d, null, 2));
  return dir;
}

test("renderer choice: auto takes native when installed, chrome when asked, missing or --gpu", () => {
  const dir = soundFilm();
  const { film } = checkFilm(dir, {});
  const have = () => ({ bin: "/x/motion-render", version: "0.11.0", caps: { stream: true, probe: true, webgl: false } });
  const none = () => ({ missing: "not installed" });
  assert.equal(chooseRenderer(film, {}, have).renderer, "native");
  assert.equal(chooseRenderer(film, { renderer: "chrome" }, have).renderer, "chrome");
  assert.equal(chooseRenderer({ ...film, renderer: "chrome" }, {}, have).renderer, "chrome");
  assert.equal(chooseRenderer({ ...film, renderer: "chrome" }, { renderer: "native" }, have).renderer, "native");
  assert.equal(chooseRenderer(film, { gpu: true }, have).renderer, "chrome");
  assert.match(chooseRenderer(film, { gpu: true, renderer: "native" }, have).error, /--gpu/);
  // without the binary: auto falls back quietly, an explicit native is an error
  assert.equal(chooseRenderer(film, {}, none).renderer, "chrome");
  assert.match(chooseRenderer(film, { renderer: "native" }, none).error, /not installed/);
  assert.deepEqual(validateFilm({ ...JSON.parse(fs.readFileSync(path.join(dir, "film.json"))), renderer: "gpu" }, dir).errors.map((e) => e.path), ["$.renderer"]);
  assert.equal(findRenderer({ env: { ...process.env, MOTION_RENDER: "0" } }).missing, "turned off (MOTION_RENDER=0)");
});

test("WebGL films go to Chrome: found in the drawing or a library, or reported by motion-render", () => {
  const dir = soundFilm({ draw: `window.drawFrame = function (c) { const gl = document.createElement("canvas").getContext("webgl2"); };` });
  const { film } = checkFilm(dir, {});
  assert.equal(path.basename(webglUse(film)), "draw.js");
  const r = chooseRenderer(film, {}, () => ({ bin: "x", version: "0.11.0", caps: { stream: true, probe: true, webgl: false } }));
  assert.equal(r.renderer, "chrome");
  assert.match(r.note, /WebGL/);
  // once motion-render draws WebGL (capabilities.webgl), the same film renders natively
  assert.equal(chooseRenderer(film, {}, () => ({ bin: "x", version: "0.12.0", caps: { stream: true, probe: true, webgl: true } })).renderer, "native");
  assert.ok(unsupportedContext('motion-render: film setup: getContext("webgl") is not supported by motion-render yet (2D canvas only)'));
  assert.ok(!unsupportedContext("motion-render: frame at 1.0000s: ReferenceError: x is not defined"));
});

test("mix envelope: absolute points, held at both ends, replacing the clip volume", () => {
  assert.deepEqual(envelope([{ t: 1, v: 0.6 }, { t: 1.5, v: 0.15 }], 4, 0.6), [
    { t: 0, v: 0.6 },
    { t: 1, v: 0.6 },
    { t: 1.5, v: 0.15 },
    { t: 4, v: 0.15 },
  ]);
});

test("without motion-render a film renders in Chrome, and says so in the result", { timeout: 300000 }, async (t) => {
  if (!(await chrome())) return t.skip("no Chrome for rendering");
  const dir = soundFilm({ duration: 3 });
  const r = cli(["still", dir, "--allow-code", "--at", "0.5", "--no-text-check", "--json"], { MOTION_RENDER: "0" });
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.json.outputs[0].renderer, "chrome");
  const n = cli(["still", dir, "--allow-code", "--at", "0.5", "--renderer", "native", "--json"], { MOTION_RENDER: "0" });
  assert.equal(n.code, 1);
  assert.match(n.json.error, /--renderer native: turned off/);
});

test("a page that asks for WebGL at run time falls back to Chrome", { timeout: 300000 }, async (t) => {
  if (native.missing) return t.skip("motion-render is not built");
  if (!(await chrome())) return t.skip("no Chrome for rendering");
  // the context name is computed, as three.js does, so only the render itself finds it
  const dir = soundFilm({
    duration: 3,
    draw: `window.setupFilm = function () { window.gl = document.createElement("canvas").getContext(["web", "gl"].join("")); };
      window.drawFrame = function (c, t, film, view) { c.fillStyle = window.gl ? "#20c040" : "#e02020"; c.fillRect(0, 0, view.width, view.height); };`,
  });
  const r = cli(["still", dir, "--allow-code", "--at", "0.5", "--no-text-check", "--json"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.json.outputs[0].renderer, "chrome");
  const said = cli(["still", dir, "--allow-code", "--at", "0.5", "--no-text-check", "--force"]);
  assert.equal(said.code, 0, said.err);
  assert.match(said.err, /motion-render cannot draw this film .*webgl.*rendering in Chrome/i);
});

test("the ffmpeg mix matches HyperFrames' mix: music, effects on their peak, a ducked voice", { timeout: 300000 }, async (t) => {
  if (!(await chrome())) return t.skip("no Chrome for rendering");
  const dir = soundFilm();
  const { film } = checkFilm(dir, {});
  const proj = await buildFilm(film, "en", "square", path.join(dir, "out", ".build", "mix"));
  assert.equal(proj.mix.length, 4);
  assert.ok(proj.mix[0].automation, "the music is ducked under the voice");
  const hf = await runHyperframes(["render", proj.dir, "--output", path.join(dir, "chrome.mp4"), "--fps", "30", "--quality", "draft", "--quiet", "--no-browser-gpu"], {});
  assert.equal(hf.code, 0, hf.out);
  mixAudio(proj.mix, proj.total, path.join(dir, "native.wav"));
  const a = loudness(path.join(dir, "chrome.mp4")),
    b = loudness(path.join(dir, "native.wav"));
  assert.ok(Math.abs(a.lufs - b.lufs) <= 0.5, `integrated loudness ${a.lufs} vs ${b.lufs} LUFS`);
  assert.ok(Math.abs(a.peak - b.peak) <= 1, `peak ${a.peak} vs ${b.peak} dBFS`);
  const rms = rmsWindows(pcm(path.join(dir, "chrome.mp4")), pcm(path.join(dir, "native.wav")));
  assert.ok(rms.windows >= 30, JSON.stringify(rms));
  assert.ok(rms.p95_db <= 0.5 && rms.max_db <= 1.5, `per-100 ms RMS: ${JSON.stringify(rms)}`);
});

// The 2D examples (narration off: generated voices are not in the repository), native vs Chrome.
// whiteboard's full-frame paper texture is scaled up 2×; Skia's bilinear filter rounds where
// Chrome's truncates, one level on every pixel (PR #33: 0.996 before encoding, ~0.985 after x264).
const EXAMPLES = [
  ["ocs-film", "zh", "landscape", 0.99],
  ["kinetic", "en", "landscape", 0.99],
  ["data-story", "zh", "vertical", 0.99],
  ["whiteboard", "en", "landscape", 0.98],
];
for (const [name, lang, format, minSsim] of EXAMPLES)
  test(`${name} ${lang} ${format}: native and Chrome deliver the same film`, { timeout: 600000 }, async (t) => {
    if (native.missing) return t.skip("motion-render is not built");
    if (!(await chrome())) return t.skip("no Chrome for rendering");
    const dir = path.join(temp(), name);
    fs.cpSync(path.join(ROOT, "examples", name), dir, { recursive: true, filter: (p) => !/[/\\](out|voiceover)$/.test(p) });
    const file = path.join(dir, "film.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), voiceover: false }, null, 2));
    const work = path.join(path.dirname(dir), "out");
    const n = renderWith(dir, "native", { lang, format, quality: "standard", out: path.join(work, "native") });
    const c = renderWith(dir, "chrome", { lang, format, quality: "standard", out: path.join(work, "chrome") });
    assert.equal(n.result.renderer, "native");
    assert.equal(c.result.renderer, "chrome");
    const d = n.result.seconds;
    const cmp = compareRenders(c.result, n.result, { times: [0.3, d * 0.3, d * 0.55, d * 0.8, d - 0.1].map((x) => +x.toFixed(2)), work: path.join(work, "frames") });
    t.diagnostic(`${name}: native ${(n.ms / 1000).toFixed(1)} s, chrome ${(c.ms / 1000).toFixed(1)} s; ${JSON.stringify({ ssim: cmp.ssim, audio: cmp.audio, text: cmp.text_runs })}`);
    assert.deepEqual(cmp.frames[0], cmp.frames[1]);
    assert.ok(Math.abs(cmp.duration[0] - cmp.duration[1]) < 0.05, JSON.stringify(cmp.duration));
    assert.equal(cmp.size[0], cmp.size[1]);
    assert.deepEqual(cmp.motion[0], cmp.motion[1]);
    assert.deepEqual([cmp.text_runs.only_a, cmp.text_runs.only_b], [[], []], "the text check finds the same runs");
    assert.ok(cmp.ssim.min >= minSsim, `SSIM ${JSON.stringify(cmp.ssim)}`);
    if (cmp.audio) {
      assert.ok(Math.abs(cmp.audio.a.lufs - cmp.audio.b.lufs) <= 0.5, JSON.stringify(cmp.audio));
      assert.ok(cmp.audio.rms.p95_db <= 0.5 && cmp.audio.rms.max_db <= 1.5, JSON.stringify(cmp.audio.rms));
    }
  });

test("native stills: contact sheet, purity check, --onion and --guides", { timeout: 300000 }, async (t) => {
  if (native.missing) return t.skip("motion-render is not built");
  const dir = soundFilm({ duration: 3 });
  // a drawing that keeps state between frames is caught by drawing the first time again last
  const impure = "let n = 0; window.drawFrame = function (c, t, film, view) { n++; c.fillStyle = \"rgb(\" + ((n * 40) % 256) + \", 90, 90)\"; c.fillRect(0, 0, view.width, view.height); };";
  const r = cli(["still", dir, "--allow-code", "--at", "0.5,1.5,2.5", "--json"]);
  assert.equal(r.code, 0, r.out + r.err);
  const o = r.json.outputs[0];
  assert.equal(o.renderer, "native");
  assert.equal(o.frames.length, 3);
  assert.match(path.basename(o.frames[1]), /^frame-01-at-1\.5s\.png$/);
  assert.ok(fs.existsSync(o.sheet));
  assert.equal(o.pure, true);
  assert.equal(o.text_check.skipped, undefined, JSON.stringify(o.text_check));
  assert.equal(o.text_check.renderer, undefined, "the compact result keeps only the runs");
  // --guides tints what platform UI covers: the corner loses green and blue
  const green = (f) => [...execFileSync("ffmpeg", ["-v", "error", "-i", f, "-vf", "crop=2:2:4:4", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])][1];
  const plain = green(o.frames[0]);
  const gd = cli(["still", dir, "--allow-code", "--at", "0.5", "--guides", "--no-text-check", "--json", "--force"]);
  assert.equal(gd.code, 0, gd.out + gd.err);
  assert.ok(green(gd.json.outputs[0].frames[0]) < plain - 20, "guides tint the edge red");
  fs.writeFileSync(path.join(dir, "composition", "draw.js"), impure);
  const p = cli(["still", dir, "--allow-code", "--at", "0.5,1.5", "--no-text-check", "--json", "--force"]);
  assert.equal(p.json.outputs[0].pure, false);
  const g = cli(["still", dir, "--allow-code", "--onion", "0.5-1.5:4", "--json", "--force"]);
  assert.equal(g.code, 0, g.out + g.err);
  assert.ok(fs.existsSync(g.json.outputs[0].onion));
});

test("external engine with \"stream\": raw RGBA through a FIFO, one process, no overlay capture", { timeout: 300000 }, async (t) => {
  if (process.platform === "win32") return t.skip("FIFOs");
  const dir = temp();
  initFilm({ lang: "en", format: "landscape" }, dir);
  const file = path.join(dir, "film.json");
  const log = path.join(dir, "jobs.ndjson");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  Object.assign(d, {
    voiceover: false,
    music: { builtin: "pulse", volume: 0.5 },
    duration: 2,
    fps: 30,
    shots: [{ id: "only", start: 0, end: 2, purpose: "probe the engine", action: "a test pattern slides along a teal floor" }],
    engine: { type: "command", command: [process.execPath, FAKE], stream: true, parallel: true, env: { FAKE_ENGINE_LOG: log } },
  });
  delete d.brief;
  delete d.composition;
  fs.writeFileSync(file, JSON.stringify(d, null, 2));
  const r = cli(["render", dir, "--allow-code", "--quality", "draft", "--no-asr", "--workers", "3", "--json"]);
  assert.equal(r.code, 0, r.out + r.err);
  const o = r.json.outputs[0];
  assert.equal(o.renderer, "engine");
  const jobs = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(jobs.length, 1);
  assert.deepEqual([jobs[0].frames, jobs[0].formats, jobs[0].workers], [{ from: 0, to: 59 }, ["png", "rgba-stream"], 3]);
  const frames = execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", o.file], { encoding: "utf8" });
  assert.equal(Number(frames), 60);
  assert.ok(JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", o.file], { encoding: "utf8" })).streams.some((s) => s.codec_type === "audio"), "the ffmpeg mix rides along");
  // no transparent capture of an empty overlay
  assert.equal(fs.existsSync(path.join(dir, "out", ".build", "my-film-en-landscape-engine", "layer.mov")), false);
  // a streaming engine that stops early fails the render
  d.engine.env = { FAKE_ENGINE_DROP: "5" };
  fs.writeFileSync(file, JSON.stringify(d, null, 2));
  const bad = cli(["render", dir, "--allow-code", "--quality", "draft", "--no-asr", "--force", "--json"]);
  assert.equal(bad.code, 1);
  assert.match(bad.json.outputs[0].error, /streamed 55 of 60 frames/);
});
