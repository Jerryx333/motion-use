import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  initFilm,
  validateFilm,
  checkFilm,
  buildFilm,
  resolveProject,
  coverArgs,
  coverWarning,
} from "../src/film.mjs";
import { main } from "../src/cli.mjs";
import {
  compareDelivery,
  reviewTimes,
  verifyVideo,
  normalizeAudio,
} from "../src/verify.mjs";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import { isBlankFrame } from "../src/motion-check.mjs";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mu-film-test-"));
const project = () => {
  const dir = temp();
  initFilm({ lang: "zh", format: "landscape" }, dir);
  const file = path.join(dir, "film.json");
  const data=JSON.parse(fs.readFileSync(file,"utf8")); data.voiceover=false; fs.writeFileSync(file,JSON.stringify(data));
  return { dir, file, data };
};
test("film cover time is validated and used in output seek arguments", () => {
  const { dir, data } = project();
  for (const at of [0, 6.6, data.duration - 0.001]) {
    const checked = validateFilm({ ...data, cover: { at } }, dir);
    assert.deepEqual(checked.errors, []);
    const args = coverArgs("film.mp4", "cover.png", checked.film);
    assert.equal(args[args.indexOf("-ss") + 1], String(Math.floor(at * data.fps) / data.fps));
    assert.ok(args.indexOf("-ss") > args.indexOf("-i"));
    assert.equal(args.at(-1), "cover.png");
  }
  for (const cover of [null, [], "first-scene", {}, { at: -1 }, { at: data.duration }, { at: Infinity }, { at: NaN }, { at: "6.6" }])
    assert.ok(validateFilm({ ...data, cover }, dir).errors.some((e) => e.path === "$.cover.at"));
  assert.equal(coverArgs("film.mp4", "cover.png", data)[6], "0");
});

test("cover blank detection reuses Sobel thresholds and only warns for automatic film covers", () => {
  const w = 320, h = 180, frame = new Uint8Array(w * h);
  for (const gray of [0, 128, 255]) {
    frame.fill(gray);
    assert.equal(isBlankFrame(frame, w, h), true);
    assert.match(coverWarning({ kind: "film" }, frame, w, h), /set cover.at/);
    assert.equal(coverWarning({ kind: "film", cover: { at: 0 } }, frame, w, h), null);
    assert.equal(coverWarning({}, frame, w, h), null);
  }
  frame.fill(0);
  frame[w * 90 + 160] = 255;
  assert.equal(isBlankFrame(frame, w, h), true);
  // A vertical step has Sobel magnitude 4 * contrast; 24 itself is excluded.
  for (const contrast of [6, 7]) {
    for (let y = 0; y < h; y++) frame.fill(contrast, y * w + w / 2, (y + 1) * w);
    assert.equal(isBlankFrame(frame, w, h), contrast === 6);
    frame.fill(0);
  }
  for (let y = 40; y < 140; y++) frame.fill(255, y * w + 60, y * w + 260);
  assert.equal(isBlankFrame(frame, w, h), false);
  assert.equal(coverWarning({ kind: "film" }, frame, w, h), null);
});
test("default init creates an authored film and never replaces its code on re-init", async () => {
  const { dir, file } = project();
  fs.writeFileSync(
    path.join(dir, "composition", "draw.js"),
    "my authored work",
  );
  assert.throws(() => initFilm({ force: true }, dir), /already exists/);
  assert.equal(
    fs.readFileSync(path.join(dir, "composition", "draw.js"), "utf8"),
    "my authored work",
  );
  assert.equal(resolveProject(dir), file);
});
test("init reports its source record and refuses an existing one before writing project files", (t) => {
  const dir = temp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sources = path.join(dir, "SOURCES.md");
  fs.writeFileSync(sources, "Selected files and licences from an existing project");
  assert.throws(() => initFilm({}, dir), /SOURCES\.md already exists/);
  assert.equal(fs.readFileSync(sources, "utf8"), "Selected files and licences from an existing project");
  assert.deepEqual(fs.readdirSync(dir), ["SOURCES.md"]);
  fs.unlinkSync(sources);
  const result = initFilm({}, dir);
  assert.equal(result.sources, sources);
  assert.ok(fs.statSync(result.sources).size > 0);
  assert.ok(fs.existsSync(result.film));
});
test("film windows cover exact authored time; invalid values cannot be silently stretched", () => {
  const { dir, data } = project();
  assert.deepEqual(validateFilm(data, dir).errors, []);
  data.shots[1].start = 3.3;
  assert.ok(
    validateFilm(data, dir).errors.some((e) => e.message.includes("gaps")),
  );
  data.shots[1].start = 3;
  data.shots.at(-1).end = 17;
  assert.ok(validateFilm(data, dir).errors.some((e) => e.path === "$.shots"));
  data.fps = NaN;
  assert.ok(validateFilm(data, dir).errors.some((e) => e.path === "$.fps"));
});
test("audio must fit both its source range and the film; voiceover is never cut off implicitly", () => {
  const { dir, data } = project();
  fs.writeFileSync(path.join(dir, "voice.wav"), "fixture");
  data.audio = [{ file: "voice.wav", start: 16, role: "voiceover" }];
  assert.ok(
    validateFilm(data, dir, { probe: () => 3 }).errors.some((e) =>
      e.message.includes("cut off"),
    ),
  );
  data.audio[0].start = 15;
  assert.deepEqual(validateFilm(data, dir, { probe: () => 3 }).errors, []);
  data.audio[0].offset = 2;
  data.audio[0].length = 2;
  assert.ok(validateFilm(data, dir, { probe: () => 3 }).errors.length);
});
test("bundled effects are allowlisted and cannot resolve arbitrary package paths",()=>{
  const {dir,data}=project();data.audio=[{effect:"click",start:3.6,role:"sfx",volume:.5}];
  assert.deepEqual(validateFilm(data,dir).errors,[]);
  data.audio[0].effect="../../secret";assert.ok(validateFilm(data,dir).errors.some(e=>e.path==="$.audio[0].effect"));
});
test("music duck accepts only booleans for built-in and imported music", () => {
  const { dir, data } = project();
  fs.writeFileSync(path.join(dir, "song.wav"), "fixture");
  for (const source of [{ builtin: "pulse" }, { file: "song.wav" }]) {
    for (const duck of [undefined, true, false]) {
      data.music = { ...source, duck };
      assert.deepEqual(validateFilm(data, dir).errors, []);
    }
    for (const duck of ["no", null, 0, [], {}]) {
      data.music = { ...source, duck };
      assert.ok(validateFilm(data, dir).errors.some((e) =>
        e.path === "$.music.duck" && e.message.includes("boolean"),
      ));
    }
  }
});
test("music ducks by default; duck false removes browser and native automation", async () => {
  const { dir, data } = project();
  fs.copyFileSync(new URL("../assets/sfx/click.wav", import.meta.url), path.join(dir, "song.wav"));
  data.audio = [{ effect: "click", role: "voiceover", start: 1 }];
  for (const source of [{ builtin: "pulse", hits: [4.6] }, { file: "song.wav", bpm: 120 }]) {
    for (const duck of [undefined, false]) {
      data.music = { ...source, volume: 0.6, duck };
      const { film, errors } = validateFilm(data, dir);
      assert.deepEqual(errors, []);
      const build = await buildFilm(film, "zh", "landscape", path.join(dir, "out", "build"));
      const music = build.mix[0];
      const html = fs.readFileSync(path.join(build.dir, "index.html"), "utf8");
      const tag = html.match(/<audio id="film-music"[^>]*>/)[0];
      assert.equal(music.volume, 0.6);
      assert.equal(music.fadeOut, 0.3);
      assert.match(tag, /data-volume="0.6"/);
      assert.match(tag, /data-fade-out="0.3"/);
      if (duck === false) {
        assert.equal(music.automation, null);
        assert.doesNotMatch(tag, /data-automation/);
      } else {
        assert.ok(music.automation.some((p) => p.v === 0.15));
        assert.match(tag, /data-automation=/);
      }
    }
  }
});
test("only explicitly named project assets are copied; escaping symlinks and clocks are rejected", async () => {
  const { dir, data } = project(),
    outside = temp();
  fs.writeFileSync(
    path.join(outside, "secret.js"),
    "window.drawFrame = ()=>{}",
  );
  fs.symlinkSync(
    path.join(outside, "secret.js"),
    path.join(dir, "composition", "escape.js"),
  );
  data.composition = "composition/escape.js";
  assert.ok(
    validateFilm(data, dir).errors.some((e) => e.message.includes("symlink")),
  );
  data.composition = "composition/draw.js";
  fs.appendFileSync(path.join(dir, data.composition), "\nDate.now();");
  assert.ok(
    validateFilm(data, dir).errors.some((e) =>
      e.message.includes("nondeterministic"),
    ),
  );
});
test("untrusted text cannot close the config script; unrelated secrets never enter a build", async () => {
  const { dir, data } = project();
  data.copy.zh.problem = "</script><script>evil()</script>";
  fs.writeFileSync(path.join(dir, "composition", ".env"), "secret");
  fs.writeFileSync(path.join(dir, "film.json"), JSON.stringify(data));
  const c = checkFilm(dir),
    build = await buildFilm(
      c.film,
      "zh",
      "landscape",
      path.join(dir, "out", "build"),
    );
  const html = fs.readFileSync(path.join(build.dir, "index.html"), "utf8");
  assert.ok(!html.includes("</script><script>evil"));
  assert.ok(html.includes("\\u003c/script>"));
  assert.equal(
    fs.existsSync(path.join(build.dir, "composition", ".env")),
    false,
  );
});
test("authored code is never executed without the explicit trust flag", async () => {
  const { dir } = project();
  const original = console.error;
  let message = "";
  console.error = (x) => (message += x);
  process.env.MOTION_USE_NO_UPDATE_CHECK = "1";
  try {
    assert.equal(await main(["render", dir]), 1);
  } finally {
    console.error = original;
  }
  assert.match(message, /--allow-code/);
  assert.equal(fs.existsSync(path.join(dir, "out")), false);
});
test("the drawing adapter seeks backward reproducibly and propagates pose failures", async () => {
  const events = {},
    samples = [],
    ctx = {
      resetTransform() {},
      clearRect() {},
      save() {},
      restore() {},
      drawImage() {},
    };
  const canvas = { width: 160, height: 90, getContext: () => ctx };
  const config = {
    duration: 12,
    fps: 60,
    bpm: 100,
    motionBlur: { samples: 4, shutter: 0.5 },
    assets: {},
  };
  const window = {
    addEventListener: (name, fn) => (events[name] = fn),
    drawFrame: (_ctx, t) => samples.push(t),
  };
  const document = {
    getElementById: (id) =>
      id === "film-config" ? { textContent: JSON.stringify(config) } : canvas,
    createElement: () => ({ ...canvas }),
    fonts: { load: async () => {}, check: () => true },
  };
  vm.runInNewContext(
    fs.readFileSync(new URL("../src/film-runtime.js", import.meta.url), "utf8"),
    { window, document, Image: class {} },
  );
  await window.__hf.buildReady["motion-use-film"];
  const pose = (t) => {
    samples.length = 0;
    events["hf-seek"]({ detail: { time: t } });
    return [...samples];
  };
  const first = pose(7);
  pose(1);
  assert.deepEqual(pose(7), first);
  assert.equal(first.length, 4);
  assert.ok(pose(0).every((t) => t === 0));
  window.drawFrame = () => {
    throw new Error("broken pose");
  };
  let rejected;
  events["hf-seek"]({
    detail: {
      time: 3,
      waitUntil: (p) => {
        rejected = p;
      },
    },
  });
  await assert.rejects(rejected, /broken pose/);
});
test("delivery compares real metadata and samples both sides of cuts", () => {
  assert.ok(
    compareDelivery(
      { seconds: 18, width: 960, height: 540, fps: 30, audio: false },
      { duration: 20, width: 1920, height: 1080, fps: 60, audio: true },
    ).length === 4,
  );
  const t = reviewTimes(18, 60, [
    { start: 0, end: 7.2 },
    { start: 7.2, end: 18 },
  ]);
  assert.ok(t.includes(7.2));
  assert.ok(t.some((x) => Math.abs(x - (7.2 - 1 / 60)) < 1e-5));
  assert.ok(t.every((x) => x >= 0 && x < 18));
});
test("operational failures preserve the CLI JSON contract",async()=>{
  const saved=console.log;let output="";console.log=x=>output+=x;process.env.MOTION_USE_NO_UPDATE_CHECK="1";
  try {assert.equal(await main(["verify",path.join(temp(),"missing.mp4"),"--json"]),1);} finally {console.log=saved;}
  const r=JSON.parse(output);assert.equal(r.ok,false);assert.equal(typeof r.error,"string");
});
test("verification decodes a real MP4 and reports missing sound without pretending visual approval", () => {
  const dir = temp(),
    file = path.join(dir, "clip.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=24:duration=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
  assert.equal(normalizeAudio(file, path.join(dir, "norm.mp4")).applied, false);
  const r = verifyVideo(file, path.join(dir, "review"), {
    expected: { duration: 1, fps: 24, width: 160, height: 90, audio: true },
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes("expected audio is missing"));
  assert.equal(r.visual_review, "pending");
  assert.ok(fs.existsSync(r.sheet));
});

// The exact same wrapper source executes in the browser page and native V8.
const strictSource = fs.readFileSync(new URL("../src/strict-canvas.js", import.meta.url), "utf8");
const strictCheck = () => {
  const sandbox = vm.createContext({});
  vm.runInContext(strictSource, sandbox);
  return sandbox.__motionUseStrictCanvas();
};

test("strict Canvas wrapper: exact frame windows, aggregation and legal overloads", () => {
  const check = strictCheck();
  const gradient = { addColorStop() {} };
  const target = new Proxy({ globalAlpha: 1 }, { get: (o, k) => k in o ? o[k] : () => k.startsWith("create") ? gradient : undefined });
  const c = check.wrap(target);
  for (let frame = 0; frame < 90; frame++) {
    const t = frame / 30;
    check.at(frame, t);
    if (t >= 2.03 && t < 2.06) c.scale(1.35);
    if (t >= 2.13 && t < 2.2) { c.globalAlpha = NaN; c.globalAlpha = Infinity; }
    c.setTransform({ a: 1, d: 1 }); c.setTransform(1, 0, 0, 1, 0, 0); c.setTransform();
    c.roundRect(0, 0, 10, 10); c.fillText("ok", 0, 0);
    c.drawImage({}, 0, 0); c.drawImage({}, 0, 0, 10, 10); c.drawImage({}, 0, 0, 10, 10, 0, 0, 10, 10);
  }
  const r = check.result();
  assert.equal(r.error_count, 2);
  assert.deepEqual(Array.from(r.errors, (e) => [e.name, e.kind, e.time, e.frame, e.frames]), [
    ["scale", "arguments", 2.03, 61, 1], ["globalAlpha", "non-finite", 2.13, 64, 2],
  ]);
  const valid = strictCheck(), ctx = valid.wrap(target);
  valid.at(0, 0); ctx.scale(1, 1); ctx.globalAlpha = 0.5;
  const paint = ctx.createLinearGradient(0, 0, 1, 1);
  paint.addColorStop(0, "red");
  ctx.fillStyle = paint;
  assert.equal(target.fillStyle, gradient);
  assert.equal(valid.result().error_count, 0);
});

test("strict Canvas wrapper: numeric arguments, sequences, matrices, gradient stops and exceptions", () => {
  const check = strictCheck();
  const c = check.wrap(new Proxy({}, { get: () => () => ({ addColorStop() {} }) }));
  check.at(5, 5 / 60);
  c.arc(0, NaN, 1, 0, 1); c.setLineDash([1, Infinity]);
  c.setTransform({ a: Infinity }); c.setTransform(1, 0);
  c.createRadialGradient(0, 0, 1, 2, 2, 3).addColorStop(NaN, "red");
  check.exception(new Error("author failure"));
  const r = check.result();
  assert.equal(r.error_count, 6);
  assert.equal(r.errors.at(-1).message, "author failure");
  assert.ok(r.errors.every((e) => e.frame === 5 && e.time === 0.08));
  for (let i = 0; i < 20; i++) check.exception(new Error(`error ${i}`));
  assert.equal(check.result().errors.length, 15);
  assert.equal(check.result().error_count, 26);
});

test("strict Canvas full-film pass and CLI gate on native and Chrome", { timeout: 180000 }, async (t) => {
  const { findRenderer } = await import("../src/native.mjs");
  const { probeCanvas } = await import("../src/text-probe.mjs");
  const { runHyperframes } = await import("../src/hf.mjs");
  const { spawnSync } = await import("node:child_process");
  const native = findRenderer();
  const browser = await runHyperframes(["browser", "path"], {});
  const chromePath = browser.out.trim().split("\n").pop();
  const renderers = [];
  if (native.bin) renderers.push(["native", native]);
  if (browser.code === 0 && chromePath && fs.existsSync(chromePath)) renderers.push(["chrome", null]);
  if (!renderers.length) return t.skip("no motion-render or Chrome for rendering");
  const { dir, file } = project();
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  Object.assign(data, { duration: 3, fps: 30, music: "none", shots: [{ id: "only", start: 0, end: 3, purpose: "strict check", action: "short error windows" }] });
  fs.writeFileSync(file, JSON.stringify(data));
  fs.writeFileSync(path.join(dir, "composition", "draw.js"), `window.drawFrame = (c, t) => {
    if (t >= 2.03 && t < 2.06) c.scale(1.35);
    if (t >= 2.13 && t < 2.16) c.globalAlpha = NaN;
  };`);
  const proj = await buildFilm(checkFilm(file, {}).film, "zh", "landscape", path.join(dir, "out", ".build", "strict"));
  for (const [renderer, picked] of renderers) {
    await t.test(renderer, async () => {
      const r = await probeCanvas(proj.dir, { native: picked });
      assert.equal(r.samples, 90);
      assert.equal(r.error_count, 2);
      assert.deepEqual(r.errors.map((e) => [e.name, e.time, e.frame, e.frames]), [["scale", 2.03, 61, 1], ["globalAlpha", 2.13, 64, 1]]);
      for (const [command, extra] of [["still", ["--at", "0"]], ["render", []], ["render", ["--from", "0", "--to", "1"]]]) {
        const cli = spawnSync(process.execPath, [path.resolve("bin/motion-use.mjs"), command, dir, "--allow-code", "--json", "--no-text-check", "--renderer", renderer, ...extra], { encoding: "utf8", env: { ...process.env, MOTION_USE_NO_UPDATE_CHECK: "1" } });
        assert.equal(cli.status, 1, cli.stderr + cli.stdout);
        const json = JSON.parse(cli.stdout);
        assert.equal(json.outputs[0].canvas_check.error_count, 2, cli.stdout);
        assert.match(json.outputs[0].error, /2\.03s, frame 61/);
      }
      for (const [command, extra] of [["still", ["--at", "0"]], ["render", ["--from", "0", "--to", "1"]]]) {
        const cli = spawnSync(process.execPath, [path.resolve("bin/motion-use.mjs"), command, dir, "--allow-code", "--json", "--no-text-check", "--no-canvas-check", "--renderer", renderer, ...extra], { encoding: "utf8", env: { ...process.env, MOTION_USE_NO_UPDATE_CHECK: "1" } });
        assert.equal(cli.status, 0, cli.stderr + cli.stdout);
        const json = JSON.parse(cli.stdout);
        assert.equal(json.outputs[0].ok, true, cli.stdout);
        assert.equal(json.outputs[0].canvas_check, undefined);
      }
      const source = path.join(proj.dir, "composition", "draw.js");
      const bad = fs.readFileSync(source, "utf8");
      fs.writeFileSync(source, 'window.drawFrame = (c) => { c.scale(1, 1); c.globalAlpha = 0.5; c.fillRect(0, 0, 10, 10); };');
      try {
        assert.equal((await probeCanvas(proj.dir, { native: picked })).error_count, 0);
        fs.writeFileSync(source, 'window.drawFrame = () => { throw new Error("failed pose"); };');
        const thrown = await probeCanvas(proj.dir, { native: picked });
        assert.equal(thrown.error_count, 1);
        assert.deepEqual(thrown.errors.map((e) => [e.name, e.kind, e.message, e.frame, e.frames]), [["drawFrame", "exception", "failed pose", 0, 90]]);
      }
      finally { fs.writeFileSync(source, bad); }
    });
  }
});
