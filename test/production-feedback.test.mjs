import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  initFilm,
  validateFilm,
  buildFilm,
  filmCaptions,
  filmWords,
} from "../src/film.mjs";
import { generateFilmNarration } from "../src/film-voiceover.mjs";
import { groupCaptions } from "../src/caption-plan.mjs";
import { projectRoot, projectTarget, listProjects } from "../src/projects.mjs";
import { measureMotion, shotMotion } from "../src/motion-check.mjs";
import {
  probeWindows,
  transitionTimes,
  probeText,
} from "../src/text-probe.mjs";
import { retimeFilm } from "../src/retime.mjs";
import {
  filmInputs,
  createSnapshot,
  restoreSnapshot,
} from "../src/snapshot.mjs";
import { exportHandoff, checkHandoff } from "../src/handoff.mjs";
import { findRenderer, nativeStills } from "../src/native.mjs";
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mu-feedback-"));
const sha = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const fixture = () => {
  const dir = temp();
  initFilm({ lang: "en", format: "square" }, dir);
  const data = JSON.parse(fs.readFileSync(path.join(dir, "film.json")));
  Object.assign(data, {
    duration: 4,
    music: "none",
    voiceover: false,
    motionBlur: { samples: 1, shutter: 0 },
    shots: [
      { id: "a", start: 0, end: 2, purpose: "test", action: "test" },
      { id: "b", start: 2, end: 4, purpose: "test", action: "test" },
    ],
  });
  return { dir, data };
};
const save = ({ dir, data }) =>
  fs.writeFileSync(path.join(dir, "film.json"), JSON.stringify(data));
const ff = (args) =>
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], {
    stdio: ["ignore", "ignore", "pipe"],
  });
const check = (p) => validateFilm(p.data, p.dir);
const cli = (args, env = {}) =>
  spawnSync(process.execPath, ["bin/motion-use.mjs", ...args], {
    encoding: "utf8",
    maxBuffer: 16 << 20,
    env: { ...process.env, MOTION_USE_NO_UPDATE_CHECK: "1", ...env },
  });

function sequence(p) {
  fs.mkdirSync(path.join(p.dir, "capture"));
  ff([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=16x16:rate=2:duration=1.5",
    "-frames:v",
    "3",
    "-threads",
    "1",
    "-start_number",
    "0",
    path.join(p.dir, "capture", "%05d.png"),
  ]);
  p.data.videos = {
    ui: { frames: "capture/%05d.png", fps: 2, shot: "b", hold: "last" },
  };
}

test("#64 init creates a nonempty script scaffold and preserves authored script on re-init", () => {
  const p = fixture(),
    file = path.join(p.dir, "SCRIPT.md");
  assert.ok(fs.statSync(file).size > 0);
  assert.ok(fs.existsSync(path.join(p.dir, "reviews")));
  fs.writeFileSync(file, "User-authored script");
  assert.throws(() => initFilm({}, p.dir), /already exists/);
  assert.equal(fs.readFileSync(file, "utf8"), "User-authored script");
});

test("#65 footage overflow explains output seconds, playback rate, source duration and maximum", () => {
  const p = fixture();
  ff([
    "-f",
    "lavfi",
    "-i",
    "color=red:size=16x16:duration=1",
    path.join(p.dir, "clip.mp4"),
  ]);
  p.data.videos = { ui: { file: "clip.mp4", at: 0, length: 0.9, rate: 1.16 } };
  const errors = check(p).errors;
  assert.ok(
    errors.some((e) => /length 0.900 s of film × rate 1.16/.test(e.message)),
    JSON.stringify(errors),
  );
  assert.match(errors.at(-1).message, /max length 0.862 s/);
  p.data.videos.ui.length = 0.8;
  assert.deepEqual(check(p).errors, []);
});

test("#66 two-sample blur warns conservatively; eight samples are accepted", () => {
  const p = fixture();
  p.data.motionBlur = { samples: 2, shutter: 0.5 };
  assert.ok(check(p).warnings.some((e) => /ghost images/.test(e.message)));
  p.data.motionBlur.samples = 8;
  assert.deepEqual(check(p).errors, []);
  assert.equal(
    check(p).warnings.some((e) => /ghost images/.test(e.message)),
    false,
  );
});

test("#67 spoken copy reaches narration/ASR and displayed copy reaches captions and font subsetting", async () => {
  const p = fixture();
  p.data.voiceover = { dir: "voiceover" };
  p.data.languages = ["zh"];
  p.data.copy = { zh: {} };
  for (const shot of p.data.shots)
    shot.narration = { zh: { say: "这是玛哟伊。", text: "这是 Mayoi。" } };
  const vo = path.join(p.dir, "voiceover", "zh");
  fs.mkdirSync(vo, { recursive: true });
  for (const id of ["a", "b"])
    ff(["-f", "lavfi", "-i", "sine=duration=0.5", path.join(vo, `${id}.wav`)]);
  const c = check(p);
  assert.deepEqual(c.errors, []);
  assert.equal(c.film.narrationPlans[0].narration.zh, "这是玛哟伊。");
  const tracks = c.film.tracks.filter((x) => x.role === "voiceover");
  const captions = filmCaptions(c.film, "zh", tracks);
  assert.equal(captions[0].text, "这是 Mayoi。");
  assert.equal(captions[0].estimated, true);
  assert.deepEqual(filmWords(c.film, "zh", tracks), []);
  const built = await buildFilm(
    c.film,
    "zh",
    "square",
    path.join(p.dir, "build"),
  );
  assert.equal(built.config.captions[0].text, "这是 Mayoi。");
  p.data.shots[0].narration.zh = { say: "读音" };
  assert.ok(check(p).errors.some((e) => e.path.includes("narration")));
});

test("#67 display-only edits reuse speech generated from say without contacting a provider", async () => {
  const p = fixture();
  p.data.voiceover = { dir: "voiceover", engine: "azure" };
  p.data.shots[0].narration = {
    en: { say: "Say alias", text: "Product name" },
  };
  const dir = path.join(p.dir, "voiceover", "en");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "a.mp3");
  fs.writeFileSync(file, "synthetic cached audio");
  fs.writeFileSync(
    path.join(p.dir, "voiceover", ".motion-use-voiceover.json"),
    JSON.stringify({
      "en/a.mp3": {
        text: "Say alias",
        engine: "azure",
        voice: "en-US-AndrewMultilingualNeural",
        rate: "+0%",
        sha: sha(file),
      },
    }),
  );
  const saved = process.env.AZURE_SPEECH_KEY;
  delete process.env.AZURE_SPEECH_KEY;
  try {
    for (const display of ["Product name", "Revised product name"]) {
      p.data.shots[0].narration.en.text = display;
      const c = validateFilm(p.data, p.dir, { skipGeneratedVoiceover: true });
      assert.deepEqual(c.errors, []);
      const r = await generateFilmNarration(c.film, { engine: "azure" });
      assert.equal(r.rows[0].status, "unchanged");
    }
  } finally {
    if (saved !== undefined) process.env.AZURE_SPEECH_KEY = saved;
  }
});

test("#68 sentence and shot grouping preserve cue windows; cue opt-in preserves raw segments", () => {
  const cues = [
    { text: "暂存、", start: 0, end: 0.7 },
    { text: "提交、", start: 0.7, end: 1.4 },
    { text: "看提交图，都不用离开窗口。", start: 1.4, end: 4 },
  ];
  assert.deepEqual(groupCaptions(cues), [
    { text: "暂存、提交、看提交图，都不用离开窗口。", start: 0, end: 4 },
  ]);
  assert.equal(groupCaptions(cues, "cue").length, 3);
  const p = fixture();
  p.data.captionStyle = { split: "shot" };
  assert.deepEqual(check(p).errors, []);
  p.data.captionStyle.split = "word";
  assert.ok(check(p).errors.some((e) => e.path === "$.captionStyle.split"));
});

test("#69 bare names initialize under the configurable project root; list reports saved release paths", () => {
  const root = temp(),
    env = { MOTION_USE_PROJECTS: root };
  assert.equal(projectTarget("demo", env), path.join(root, "demo"));
  assert.equal(projectTarget("./demo", env), path.resolve("demo"));
  const r = cli(["init", "demo", "--lang", "en", "--json"], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).film, path.join(root, "demo", "film.json"));
  for (const input of ["demo", "demo/film.json"]) {
    const validated = cli(["validate", input, "--json"], env);
    assert.equal(validated.status, 0, validated.stderr + validated.stdout);
    assert.equal(
      JSON.parse(validated.stdout).brief,
      path.join(root, "demo", "film.json"),
    );
  }
  const local = temp();
  initFilm({ lang: "en" }, path.join(local, "demo"));
  const localRead = spawnSync(
    process.execPath,
    [path.resolve("bin/motion-use.mjs"), "validate", "demo", "--json"],
    {
      cwd: local,
      encoding: "utf8",
      env: { ...process.env, ...env, MOTION_USE_NO_UPDATE_CHECK: "1" },
    },
  );
  assert.equal(
    fs.realpathSync(JSON.parse(localRead.stdout).brief),
    fs.realpathSync(path.join(local, "demo", "film.json")),
  );
  const release = path.join(root, "demo", "out", "release");
  fs.mkdirSync(release, { recursive: true });
  fs.writeFileSync(
    path.join(release, "release-manifest.json"),
    JSON.stringify({
      created: "2026-10-15T00:00:00Z",
      files: [{ kind: "master", file: "demo.mp4" }],
    }),
  );
  const listed = cli(["list", "--json"], env);
  assert.equal(listed.status, 0);
  const data = JSON.parse(listed.stdout);
  assert.equal(data.projects[0].name, "demo");
  assert.equal(data.projects[0].release.file, path.join(release, "demo.mp4"));
  assert.equal(data.projects[0].release.exists, false);
  assert.equal(
    listProjects({ MOTION_USE_PROJECTS: path.join(root, "missing") }).projects
      .length,
    0,
  );
  assert.equal(projectRoot(env), root);
});

test("#70 image sequence is copied losslessly and included in snapshots and editable handoff", async () => {
  const p = fixture();
  sequence(p);
  save(p);
  const c = check(p);
  assert.deepEqual(c.errors, []);
  const built = await buildFilm(
    c.film,
    "en",
    "square",
    path.join(p.dir, "build"),
  );
  const v = built.config.videos.ui;
  assert.equal(v.ext, "png");
  assert.equal(v.frames, 3);
  assert.equal(
    sha(path.join(p.dir, "capture", "00000.png")),
    sha(path.join(built.dir, v.dir, "00000.png")),
  );
  assert.equal(
    sha(path.join(p.dir, "capture", "00002.png")),
    sha(path.join(built.dir, v.dir, "00002.png")),
  );
  assert.equal(
    filmInputs(c.film, path.join(p.dir, "film.json")).filter(
      (x) => x.role === "footage",
    ).length,
    3,
  );
  const shot = createSnapshot(
    c.film,
    path.join(p.dir, "film.json"),
    path.join(p.dir, "out"),
    { version: "test" },
  );
  const restored = restoreSnapshot({
    record: shot,
    store: path.join(p.dir, "out", ".snapshots"),
  });
  assert.ok(
    fs.existsSync(path.join(path.dirname(restored), "capture", "00002.png")),
  );
  const handoff = path.join(temp(), "handoff");
  exportHandoff(p.dir, { out: handoff });
  assert.equal(checkHandoff(handoff).ok, true);
  const timeline = JSON.parse(
    fs.readFileSync(path.join(handoff, "timeline.json")),
  );
  assert.equal(timeline.videos.ui.sequence.length, 3);
  assert.ok(
    timeline.videos.ui.sequence.every(
      (f) => typeof f === "string" && !path.isAbsolute(f),
    ),
  );
  fs.renameSync(
    path.join(p.dir, "capture", "00001.png"),
    path.join(p.dir, "capture", "00004.png"),
  );
  assert.ok(check(p).errors.some((e) => /gap/.test(e.message)));
});

test("#70 image sequences reject mismatched dimensions and escaping frame symlinks", () => {
  const p = fixture();
  sequence(p);
  ff([
    "-f",
    "lavfi",
    "-i",
    "color=red:size=32x16",
    "-frames:v",
    "1",
    "-threads",
    "1",
    path.join(p.dir, "capture", "00001.png"),
  ]);
  assert.ok(check(p).errors.some((e) => /dimensions differ/.test(e.message)));
  fs.rmSync(path.join(p.dir, "capture", "00001.png"));
  const outside = path.join(temp(), "outside.png");
  fs.copyFileSync(path.join(p.dir, "capture", "00000.png"), outside);
  fs.symlinkSync(outside, path.join(p.dir, "capture", "00001.png"));
  assert.ok(check(p).errors.some((e) => /escaping symlinks/.test(e.message)));
});

test("#72 anchored video and audio follow shot changes; retime accepts anchored inputs and rejects absolute ones", () => {
  const p = fixture();
  sequence(p);
  p.data.audio = [{ effect: "click", shot: "b", delay: 0.1 }];
  let c = check(p);
  assert.deepEqual(c.errors, []);
  assert.equal(c.film.videos.ui.at, 2);
  assert.equal(c.film.tracks[0].start, 2.1);
  p.data.shots[0].end = 1;
  p.data.shots[1].start = 1;
  c = check(p);
  assert.equal(c.film.videos.ui.at, 1);
  assert.equal(c.film.tracks[0].start, 1.1);
  save(p);
  assert.equal(retimeFilm(p.dir).ok, true);
  fs.rmSync(path.join(p.dir, "film.retimed.json"));
  p.data.audio[0].start = 1;
  save(p);
  assert.throws(() => retimeFilm(p.dir), /not start together with shot/);
  delete p.data.audio[0].shot;
  delete p.data.audio[0].delay;
  save(p);
  assert.throws(() => retimeFilm(p.dir), /Retime before placing/);
  p.data.videos.ui.shot = "missing";
  assert.ok(check(p).errors.some((e) => /unknown shot/.test(e.message)));
  const narrated = fixture();
  sequence(narrated);
  narrated.data.voiceover = { dir: "voiceover" };
  narrated.data.audio = [{ effect: "click", shot: "b", delay: 0.1 }];
  narrated.data.shots[0].duration = "narration";
  narrated.data.shots[0].narration = {
    en: { say: "Spoken test", text: "Display test" },
  };
  const vo = path.join(narrated.dir, "voiceover", "en");
  fs.mkdirSync(vo, { recursive: true });
  const clip = path.join(vo, "a.wav");
  ff(["-f", "lavfi", "-i", "sine=duration=0.5", clip]);
  fs.writeFileSync(
    path.join(narrated.dir, "voiceover", ".motion-use-voiceover.json"),
    JSON.stringify({
      "en/a.wav": {
        text: "Spoken test",
        engine: "edge",
        voice: "en-US-AndrewMultilingualNeural",
        rate: "+0%",
        sha: sha(clip),
      },
    }),
  );
  save(narrated);
  const proposal = retimeFilm(narrated.dir);
  const retimed = JSON.parse(fs.readFileSync(proposal.film));
  const validated = validateFilm(retimed, narrated.dir);
  assert.deepEqual(validated.errors, []);
  assert.ok(retimed.shots[1].start < 2);
  assert.equal(validated.film.videos.ui.at, retimed.shots[1].start);
  assert.equal(
    validated.film.tracks.find((x) => !x.generated).start,
    retimed.shots[1].start + 0.1,
  );
});

test("#73 per-shot diagnostics exclude cuts and identify a static versus active region in a real MP4", () => {
  const rows = shotMotion(
    [0, 0, 20, 20, 20, 20],
    [false, false, true, false, false, false],
    [
      { id: "quiet", start: 0, end: 0.25 },
      { id: "active", start: 0.25, end: 0.6 },
    ],
    12,
  );
  assert.equal(rows[0].fast_frames, 0);
  assert.equal(rows[0].level, "red");
  assert.ok(rows[1].fast_frames > 0);
  const file = path.join(temp(), "motion.mp4");
  ff([
    "-f",
    "lavfi",
    "-i",
    "color=gray:size=160x90:rate=24:duration=4",
    "-vf",
    "noise=alls=100:allf=t+u:enable='gte(t,2)'",
    file,
  ]);
  const m = measureMotion(file, {
    cuts: [2],
    shots: [
      { id: "quiet", start: 0, end: 2 },
      { id: "active", start: 2, end: 4 },
    ],
  });
  assert.equal(m.shots[0].fast_ratio, 0);
  assert.ok(m.shots[1].fast_ratio > 0.2, JSON.stringify(m.shots));
});

test("#74 selected probe windows stay bounded; refinement never fills gaps between selected windows", () => {
  assert.deepEqual(
    probeWindows(50, [
      [3, 4],
      [3.5, 5],
      [-1, 0.5],
      [49, 52],
    ]),
    [
      [0, 0.5],
      [3, 5],
      [49, 50],
    ],
  );
  assert.deepEqual(
    transitionTimes(
      [
        { t: 1, boxes: [] },
        { t: 40, boxes: [{ text: "later" }] },
      ],
      30,
      { maxGap: 0.15 },
    ),
    [],
  );
});

test("#70/#71/#74 native draws PNG footage with first/last holds and probes only selected ranges", async (t) => {
  const native = findRenderer();
  if (!native.bin) return t.skip("motion-render not installed");
  const p = fixture();
  sequence(p);
  p.data.videos.ui.length = 2;
  fs.writeFileSync(
    path.join(p.dir, "composition", "draw.js"),
    `window.drawFrame=(c,t,f,v,M)=>{c.fillStyle='#ff0000';c.fillRect(0,0,v.width,v.height);const im=M.video('ui',t);if(im)c.drawImage(im,0,0,v.width,v.height);if(t>3.5){c.fillText('late',10,30);c.fillText('collision',10,30);}};`,
  );
  const c = check(p);
  assert.deepEqual(c.errors, []);
  const built = await buildFilm(
    c.film,
    "en",
    "square",
    path.join(p.dir, "build"),
  );
  const out = path.join(p.dir, "stills");
  fs.mkdirSync(out);
  const r = await nativeStills({
    bin: native.bin,
    proj: built,
    times: [2, 3.6, 3.8, 4],
    dir: out,
  });
  assert.equal(r.code, 0, r.out);
  const pngs = fs
    .readdirSync(out)
    .filter((f) => f.endsWith(".png"))
    .sort();
  assert.equal(pngs.length, 4);
  const hash = (file) =>
    crypto
      .createHash("sha256")
      .update(
        execFileSync(
          "ffmpeg",
          [
            "-v",
            "error",
            "-i",
            file,
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
          ],
          { maxBuffer: 16 << 20 },
        ),
      )
      .digest("hex");
  const hashes = pngs.map((f) => hash(path.join(out, f)));
  assert.equal(hashes[1], hashes[2]);
  assert.notEqual(hashes[0], hashes[1]);
  assert.notEqual(hashes[2], hashes[3]);
  const all = await probeText(built.dir, 4, { native });
  assert.ok(all.runs.some((r) => r.kind === "collision" && r.from > 3.5));
  save(p);
  const selected = cli([
    "still",
    p.dir,
    "--shot",
    "a",
    "--allow-code",
    "--renderer",
    "native",
    "--json",
  ]);
  assert.equal(selected.status, 0, selected.stdout + selected.stderr);
  const preview = cli([
    "render",
    p.dir,
    "--from",
    "2",
    "--to",
    "3",
    "--allow-code",
    "--renderer",
    "native",
    "--json",
  ]);
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  const previewOutput = JSON.parse(preview.stdout).outputs[0];
  assert.equal(previewOutput.motion.shots[0].id, "b");
  assert.equal(previewOutput.motion.shots[0].start, 0);
  assert.ok(fs.existsSync(previewOutput.report));
  const scoped = JSON.parse(selected.stdout).outputs[0].text_check;
  assert.ok(scoped.scope[0][1] <= 2.3);
  assert.equal(
    scoped.runs.some((r) => r.from > 3.5),
    false,
  );
  const text = await probeText(built.dir, 4, { native, ranges: [[0.2, 0.8]] });
  assert.equal(text.skipped, undefined);
  assert.ok(text.samples < 20);
  assert.equal(
    text.runs.some((r) => r.from > 3),
    false,
  );
  p.data.videos.ui = {
    frames: "capture/%05d.png",
    fps: 2,
    shot: "b",
    offset: 0.5,
    hold: "first",
  };
  const first = check(p);
  assert.deepEqual(first.errors, []);
  const firstBuild = await buildFilm(
    first.film,
    "en",
    "square",
    path.join(p.dir, "first"),
  );
  assert.equal(firstBuild.config.videos.ui.holdFrom, 2);
  const held = path.join(p.dir, "held");
  fs.mkdirSync(held);
  const heldResult = await nativeStills({
    bin: native.bin,
    proj: firstBuild,
    times: [2.1, 2.5, 3.7],
    dir: held,
  });
  assert.equal(heldResult.code, 0, heldResult.out);
  const heldFrames = fs
    .readdirSync(held)
    .filter((f) => f.endsWith(".png"))
    .sort();
  assert.equal(
    hash(path.join(held, heldFrames[0])),
    hash(path.join(held, heldFrames[1])),
  );
  assert.notEqual(
    hash(path.join(held, heldFrames[1])),
    hash(path.join(held, heldFrames[2])),
  );
});
