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

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mu-film-test-"));
const project = () => {
  const dir = temp();
  initFilm({ lang: "zh", format: "landscape" }, dir);
  const file = path.join(dir, "film.json");
  const data=JSON.parse(fs.readFileSync(file,"utf8")); data.voiceover=false; fs.writeFileSync(file,JSON.stringify(data));
  return { dir, file, data };
};
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
