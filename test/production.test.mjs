import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { CARDS, initStudy, writeGallery } from "../src/catalog.mjs";
import {
  checkFilm,
  validateFilm,
  buildFilm,
  filmCaptions,
  filmWords,
} from "../src/film.mjs";
import { exportHandoff, checkHandoff } from "../src/handoff.mjs";
import { toSrt } from "../src/timing.mjs";
import { compileGeo, exportGeo } from "../src/geo.mjs";
import { retimeFilm } from "../src/retime.mjs";
import { concatParts } from "../src/concat.mjs";
import { checkAgainstManifest } from "../src/release.mjs";
import crypto from "node:crypto";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mu-production-"));
const project = () => {
  const dir = path.join(temp(), "film");
  initStudy("whiteboard", dir);
  const file = path.join(dir, "film.json");
  return { dir, file, data: JSON.parse(fs.readFileSync(file, "utf8")) };
};
const save = ({ file, data }) => fs.writeFileSync(file, JSON.stringify(data));
const canvas = () => {
  const calls = [];
  return new Proxy(
    { calls, measureText: (s) => ({ width: String(s).length * 10 }) },
    {
      get: (o, k) => (k in o ? o[k] : (...args) => calls.push([k, ...args])),
      set: (o, k, v) => {
        o[k] = v;
        return true;
      },
    },
  );
};
const kit = (film = {}) => {
  const scope = { window: {} };
  vm.runInNewContext(
    fs.readFileSync(new URL("../src/film-kit.js", import.meta.url), "utf8"),
    scope,
  );
  return scope.window.__filmKit({ width: 1920, height: 1080 }, film);
};
const wav = (file, seconds = 1, frequency = 400) =>
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:duration=${seconds}`,
      "-c:a",
      "pcm_s16le",
      file,
    ],
    { stdio: "pipe" },
  );

test("all catalog studies validate, seek deterministically, and gallery export preserves existing work", () => {
  assert.equal(new Set(CARDS.map((c) => c.id)).size, 12);
  const scope = { window: {} };
  vm.runInNewContext(
    fs.readFileSync(
      new URL("../src/catalog-study.js", import.meta.url),
      "utf8",
    ),
    scope,
  );
  for (const card of CARDS) {
    const dir = path.join(temp(), card.id);
    initStudy(card.id, dir);
    assert.deepEqual(checkFilm(dir).report.errors, [], card.id);
    const a = canvas(),
      b = canvas();
    scope.window.motionStudy(a, 3, 960, 540, card.id);
    scope.window.motionStudy(canvas(), 5, 960, 540, card.id);
    scope.window.motionStudy(b, 3, 960, 540, card.id);
    assert.deepEqual(a.calls, b.calls, card.id);
  }
  const dir = path.join(temp(), "gallery"),
    r = writeGallery(dir);
  assert.equal(r.cards, 12);
  assert.match(fs.readFileSync(r.gallery, "utf8"), /prefers-reduced-motion/);
  assert.throws(() => writeGallery(dir), /already exists/);
});

test("external subtitles and keyword timing validate; missing/ambiguous words fail explicitly", () => {
  const { dir, data } = project();
  data.captions = {
    en: [{ text: "Hello", start: 1, end: 2, estimated: false }],
  };
  data.cues = { en: { result: { time: 2.4, estimated: true } } };
  assert.deepEqual(validateFilm(data, dir).errors, []);
  assert.deepEqual(filmCaptions(data, "en", []), data.captions.en);
  assert.match(toSrt(data.captions.en), /00:00:01,000 --> 00:00:02,000/);
  const m = kit({
    cues: data.cues.en,
    words: [
      { text: "Hello", start: 1, id: "a" },
      { text: "Hello", start: 3, id: "b" },
    ],
  });
  assert.equal(m.cue("result"), 2.4);
  assert.equal(m.hasCue("unknown"), false);
  assert.throws(() => m.cue("unknown"), /Unknown/);
  assert.throws(() => m.at("Hello"), /Ambiguous/);
  assert.equal(m.at("Hello", { shot: "b" }), 3);
  assert.throws(() => m.at("missing"), /No measured/);
  data.captions.en.push({ text: "overlap", start: 1.5, end: 3 });
  assert.ok(
    validateFilm(data, dir).errors.some((e) => e.path.startsWith("$.captions")),
  );
  data.cues.en.result.time = 99;
  assert.ok(
    validateFilm(data, dir).errors.some((e) => e.path.startsWith("$.cues")),
  );
});

test("word timing only uses cache-matched audio and scripts", () => {
  const { dir } = project(),
    vo = path.join(dir, "voiceover"),
    audio = path.join(vo, "en", "a.mp3");
  fs.mkdirSync(path.dirname(audio), { recursive: true });
  fs.writeFileSync(audio, "fixture");
  const sha = crypto.createHash("sha256").update("fixture").digest("hex");
  fs.writeFileSync(
    path.join(vo, ".motion-use-voiceover.json"),
    JSON.stringify({
      "en/a.mp3": {
        text: "Hello",
        sha,
        words: [{ text: "Hello", start: 0.1, end: 0.8 }],
      },
    }),
  );
  const f = {
      narrationConfig: { dir: vo },
      narrationPlans: [{ id: "a", narration: { en: "Hello" } }],
    },
    tracks = [{ file: audio, id: "a", start: 2, length: 1 }];
  assert.equal(filmWords(f, "en", tracks)[0].start, 2.1);
  f.narrationPlans[0].narration.en = "Changed";
  assert.deepEqual(filmWords(f, "en", tracks), []);
});

test("subtitle/music variants preserve the source and include custom font subsets and licenses", async () => {
  const p = project();
  fs.copyFileSync(
    new URL("../assets/fonts/JetBrainsMono[wght].ttf", import.meta.url),
    path.join(p.dir, "title.ttf"),
  );
  fs.copyFileSync(
    new URL("../assets/fonts/OFL-JetBrainsMono.txt", import.meta.url),
    path.join(p.dir, "license.txt"),
  );
  p.data.fonts = { Title: { file: "title.ttf", license: "license.txt" } };
  p.data.music = { builtin: "ambient" };
  p.data.captions = { en: [{ text: "Hello", start: 1, end: 2 }] };
  p.data.captionStyle = { plate: "#101010", size: 52 };
  save(p);
  const c = checkFilm(p.file);
  assert.equal(c.ok, true, JSON.stringify(c.report.errors));
  const normal = await buildFilm(
    c.film,
    "en",
    "landscape",
    path.join(p.dir, "normal"),
  );
  const variant = await buildFilm(
    c.film,
    "en",
    "landscape",
    path.join(p.dir, "variant"),
    { noCaptions: true, noBgm: true },
  );
  assert.equal(normal.config.captions.length, 1);
  assert.equal(normal.mix.length, 1);
  assert.deepEqual(variant.config.captions, []);
  assert.equal(variant.mix.length, 0);
  assert.equal(variant.config.noCaptions, true);
  assert.match(
    fs.readFileSync(path.join(variant.dir, "index.html"), "utf8"),
    /font-family:"Title"/,
  );
  assert.ok(
    fs.existsSync(path.join(variant.dir, "assets/fonts/brand-Title.woff2")),
  );
  assert.ok(
    fs.existsSync(
      path.join(variant.dir, "assets/fonts/LICENSE-brand-Title.txt"),
    ),
  );
  const ctx = canvas();
  kit({ noCaptions: true }).captions(ctx, 1, [["hidden", 0, 2]]);
  assert.equal(ctx.calls.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(p.file)).music.builtin, "ambient");
});

test("handoff packages declared inputs only, records resolved sources, and detects edits and escapes", () => {
  const p = project();
  wav(path.join(p.dir, "sfx.wav"), 0.2);
  fs.writeFileSync(path.join(p.dir, "secret.txt"), "must not be swept");
  p.data.audio = [{ file: "sfx.wav", role: "sfx", start: 1 }];
  p.data.captions = {
    en: [{ text: "Checked subtitle", start: 1, end: 2, estimated: true }],
  };
  p.data.provenance = {
    "sfx.wav": {
      sourceUrl: null,
      license: "MIT",
      useBasis: "Original synthetic test fixture",
    },
  };
  save(p);
  const out = path.join(temp(), "handoff"),
    r = exportHandoff(p.file, { out });
  assert.equal(r.ok, true);
  assert.equal(r.estimatedCaptions, 1);
  const manifest = JSON.parse(fs.readFileSync(r.manifest));
  assert.ok(!manifest.files.some((f) => f.path.includes("secret")));
  const timeline = JSON.parse(fs.readFileSync(path.join(out, "timeline.json")));
  assert.equal(timeline.audio[0].file, "project/sfx.wav");
  assert.equal(checkHandoff(out).ok, true);
  fs.appendFileSync(path.join(out, "subtitles/en.srt"), "changed");
  assert.equal(checkHandoff(out).ok, false);
  assert.throws(() => exportHandoff(p.file, { out }), /already exists/);
  manifest.files = [{ path: "../secret", sha256: "x" }];
  fs.writeFileSync(r.manifest, JSON.stringify(manifest));
  assert.equal(checkHandoff(out).ok, false);
});

const square = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "one",
      properties: { name: "One" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
          ],
        ],
      },
    },
  ],
};
test("geo compiler fits polygons, preserves IDs, converts topology arcs, and rejects bad inputs", () => {
  const m = compileGeo(square, { width: 800, height: 600 });
  assert.equal(m.regions[0].id, "one");
  for (const [x, y] of m.regions[0].polygons[0][0])
    assert.ok(x >= 0 && x <= 800 && y >= 0 && y <= 600);
  const topology = {
    type: "Topology",
    transform: { scale: [1, 1], translate: [0, 0] },
    objects: { land: { type: "Polygon", id: "land", arcs: [[0]] } },
    arcs: [
      [
        [0, 0],
        [10, 0],
        [0, 10],
        [-10, 0],
        [0, -10],
      ],
    ],
  };
  assert.equal(compileGeo(topology).regions[0].id, "land");
  assert.throws(() => compileGeo(square, { width: "NaN" }), /width/);
  assert.throws(
    () =>
      compileGeo({
        ...square,
        features: [...square.features, ...square.features],
      }),
    /duplicate/,
  );
  const world = JSON.parse(
    fs.readFileSync(
      new URL("../assets/geo/world.geojson", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(compileGeo(world).regions.length, 177);
});

test("camera anchors the chosen world point; updating legends do not overlap replacement text", () => {
  const m = kit(),
    cam = m.camera(2, [
      { at: 0, kind: "to", x: 300, y: 200, z: 2, anchor: [1200, 540] },
    ]);
  assert.deepEqual(Array.from(m.toScreen(cam, 300, 200)), [1200, 540]);
  const events = [
    [0, ["same", "old"]],
    [2, ["same", "new"]],
  ];
  for (const t of [2.05, 2.18, 2.3, 2.6]) {
    const c = canvas();
    m.list(c, t, events, {});
    const labels = c.calls.filter((v) => v[0] === "fillText").map((v) => v[1]);
    assert.equal(labels.filter((v) => v === "same").length, 1);
    assert.ok(!(labels.includes("old") && labels.includes("new")));
  }
});

test("retime reads the actual recording extension and aligns every boundary to whole frames", () => {
  const p = project();
  p.data.voiceover = { dir: "voiceover" };
  p.data.shots[0].narration = { en: "Test recording" };
  p.data.shots[0].duration = "narration";
  p.data.shots[0].tail = 0.4;
  save(p);
  const vo = path.join(p.dir, "voiceover", "en");
  fs.mkdirSync(vo, { recursive: true });
  wav(path.join(vo, "study.wav"), 1.25);
  assert.throws(() => retimeFilm(p.file), /unverified recording/);
  fs.writeFileSync(path.join(p.dir, "voiceover", ".motion-use-voiceover.json"), JSON.stringify({
    "en/study.wav": { text: "Test recording", engine: "edge", voice: "en-US-AndrewMultilingualNeural", rate: "+0%", sha: crypto.createHash("sha256").update(fs.readFileSync(path.join(vo, "study.wav"))).digest("hex") }
  }));
  const r = retimeFilm(p.file);
  assert.equal(r.duration, Math.ceil((1.25 + 0.56) * 30) / 30);
  assert.equal(JSON.parse(fs.readFileSync(p.file)).duration, 6);
  assert.equal(JSON.parse(fs.readFileSync(r.film)).brief.length, 6);
  const second = retimeFilm(p.file);
  assert.notEqual(second.film, r.film);
  assert.throws(() => retimeFilm(p.file, { out: r.film }), /already exists/);
});

test("concat verifies the whole joined cut and writes a master whose manifest verifies by hash", () => {
  const dir = temp();
  for (let i = 0; i < 2; i++)
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=320x180:r=24:d=1",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${400 + i * 200}:duration=1`,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        path.join(dir, `part${i}.mp4`),
      ],
      { stdio: "pipe" },
    );
  const config = path.join(dir, "parts.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      name: "joined",
      parts: [{ file: "part0.mp4" }, { file: "part1.mp4" }],
    }),
  );
  const r = concatParts(config, {
    out: path.join(dir, "joined"),
    release: true,
    "allow-static": "Synthetic integration fixture",
    "allow-blue-purple": "Synthetic test pattern",
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.joins.length, 1);
  assert.equal(r.parts.length, 2);
  assert.equal(checkAgainstManifest(r.release_manifest, r.file).ok, true);
  const manifest = JSON.parse(fs.readFileSync(r.release_manifest));
  assert.equal(manifest.parts[0].sha256.length, 64);
  const silent = path.join(dir, "silent.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", path.join(dir, "part0.mp4"), "-an", "-c:v", "copy", silent]);
  fs.writeFileSync(config, JSON.stringify({ name: "silent", parts: [{ file: "silent.mp4" }, { file: "silent.mp4" }] }));
  const joinedSilent = concatParts(config, { out: path.join(dir, "silent-joined") });
  assert.equal(joinedSilent.ok, true);
  assert.equal(joinedSilent.joins[0].beforeMeanDb, null);
});

test("snapshots distinguish editing variants without changing baseline input identity", async () => {
  const { createSnapshot } = await import("../src/snapshot.mjs");
  const p = project(),
    film = checkFilm(p.file).film,
    out = path.join(temp(), "out");
  const base = createSnapshot(film, p.file, out, { version: "test" });
  const same = createSnapshot(film, p.file, out, {
    version: "test",
    renderOptions: { noCaptions: false, noBgm: false },
  });
  const variant = createSnapshot(film, p.file, out, {
    version: "test",
    renderOptions: { noCaptions: true, noBgm: true },
  });
  assert.equal(base.id, same.id);
  assert.notEqual(base.id, variant.id);
  assert.deepEqual(variant.renderOptions, { noCaptions: true, noBgm: true });
});

test("Azure adapter converts service word ticks without a real service or credentials", () => {
  const out = path.join(temp(), "synthetic.mp3");
  const script = new URL("../scripts/azure-word-timing.py", import.meta.url)
    .pathname;
  const code = `
import importlib.util, types, datetime, json, os
spec=importlib.util.spec_from_file_location('adapter',${JSON.stringify(script)});m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Config:
 def __init__(self,**kw): pass
 def set_speech_synthesis_output_format(self,x): pass
class Synth:
 def __init__(self,**kw): self.synthesis_word_boundary=types.SimpleNamespace(connect=lambda cb:setattr(self,'cb',cb))
 def speak_ssml_async(self,ssml):
  self.cb(types.SimpleNamespace(boundary_type='Word',duration=datetime.timedelta(seconds=.3),audio_offset=2500000,text='Hello'))
  return types.SimpleNamespace(get=lambda:types.SimpleNamespace(reason=1,audio_data=b'synthetic'))
sdk=types.SimpleNamespace(SpeechConfig=Config,SpeechSynthesizer=Synth,SpeechSynthesisOutputFormat=types.SimpleNamespace(Audio24Khz96KBitRateMonoMp3=1),ResultReason=types.SimpleNamespace(SynthesizingAudioCompleted=1))
print(json.dumps(m.synthesize({'ssml':'<synthetic/>','out':${JSON.stringify(out)}},sdk)))
`;
  const result = JSON.parse(
    execFileSync("python3", ["-c", code], {
      encoding: "utf8",
      env: {
        ...process.env,
        AZURE_SPEECH_KEY: "synthetic",
        AZURE_SPEECH_REGION: "synthetic",
        PYTHONDONTWRITEBYTECODE: "1",
      },
    }),
  );
  assert.deepEqual(result.words, [
    { text: "Hello", start: 0.25, end: 0.55, estimated: false },
  ]);
  assert.equal(fs.readFileSync(out, "utf8"), "synthetic");
});

test("word anchors respect complete service-word boundaries and never join across shots", () => {
  const m = kit({ words: [{text:"rain",start:1,id:"a"},{text:"bow",start:5,id:"b"},{text:"Hello",start:7,id:"c"},{text:"world",start:8,id:"c"}] });
  assert.throws(() => m.at("rainbow"), /No measured/);
  assert.throws(() => m.at("ain"), /No measured/);
  assert.throws(() => m.at("rai"), /No measured/);
  assert.equal(m.at("Hello world"), 7);
  assert.equal(m.at("rain"), 1);
  assert.throws(() => m.at("rain", {occurrence:-1}), /non-negative/);
});

test("explicit geographic ID fields override duplicate native IDs; blank defaults fall back", () => {
  const duplicate = {type:"FeatureCollection", features:[{...square.features[0], id:"036",properties:{name:"Australia"}},{...square.features[0],id:"036",properties:{name:"Ashmore and Cartier Is."}}]};
  assert.throws(() => compileGeo(duplicate), /duplicate region ID/);
  assert.deepEqual(compileGeo(duplicate,{idField:"name"}).regions.map(r=>r.id), ["Australia","Ashmore and Cartier Is."]);
  const unnamed = {type:"FeatureCollection",features:[{...square.features[0],id:"",properties:{name:""}}]};
  assert.equal(compileGeo(unnamed).regions[0].id,"0");
  assert.throws(()=>compileGeo(unnamed,{idField:"name"}), /missing or empty/);
});

test("China ADM1 builtin has 34 distinct regions and preserves its year and attribution", () => {
 const out=path.join(temp(),"china.json"),result=exportGeo("china-provinces",{out});
 const map=JSON.parse(fs.readFileSync(out,"utf8"));
 assert.equal(result.regions,34);assert.equal(new Set(map.regions.map(r=>r.id)).size,34);
 assert.ok(map.regions.every(r=>r.id && r.name && r.polygons.length));
 assert.equal(map.source.year,"2019");assert.match(map.source.licenseUrl,/creativecommons.org/);assert.ok(map.source.modifications.length);assert.equal(map.source.license,"CC-BY-4.0");
 assert.match(result.attribution,/www.geoboundaries.org/);assert.match(map.notice,/2019/);
 assert.ok(fs.readFileSync(new URL("../assets/geo/LICENSE-geoboundaries.txt",import.meta.url),"utf8").includes("Attribution 4.0 International"));
});
