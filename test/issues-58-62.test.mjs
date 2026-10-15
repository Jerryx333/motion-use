import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { acquireOutputLock } from "../src/output-lock.mjs";
import { createProgress } from "../src/progress.mjs";
import { retrySpeech, sanitizeSpeechError, generateVoiceover, MANIFEST } from "../src/voiceover.mjs";
import { initFilm, checkFilm } from "../src/film.mjs";
import { retimeFilm } from "../src/retime.mjs";
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mu-issues-"));
const cli = (...args) => spawnSync(process.execPath, ["bin/motion-use.mjs", ...args], { encoding: "utf8", env: { ...process.env, MOTION_USE_NO_UPDATE_CHECK: "1" } });

test("#58 subcommand help exits zero without opening a project; literal -- ends options", () => {
  for (const command of ["init", "render", "still", "voiceover"]) {
    const r = cli(command, "--help");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`motion-use ${command}`));
  }
  assert.notEqual(cli("render", "--", "--help").status, 0);
});

test("#59 lock excludes another process and path aliases; owner releases on command error", () => {
  const dir = temp(), out = path.join(dir, "out"), alias = path.join(dir, "alias");
  const unlock = acquireOutputLock(out);
  fs.symlinkSync(out, alias);
  assert.throws(() => acquireOutputLock(alias), /another job owns this output/);
  const child = cli("still", dir, "--out", alias, "--json");
  assert.equal(child.status, 1);
  assert.match(child.stdout, /another job owns/);
  unlock();
  const failed = cli("still", dir, "--out", out, "--json");
  assert.equal(failed.status, 1);
  assert.equal(fs.existsSync(path.join(out, ".motion-use.lock")), false);
  const release = acquireOutputLock(alias); release();
  fs.writeFileSync(path.join(out, ".motion-use.lock"), "incomplete lock");
  assert.throws(() => acquireOutputLock(out), /PID unknown/);
});

test("#60 retry only rate limits with bounded backoff and redact service URLs", async () => {
  let attempts = 0; const sleeps = [];
  await assert.rejects(retrySpeech(() => { attempts++; throw Error("HTTP 429"); }, { sleep: async (n) => sleeps.push(n) }), /429/);
  assert.equal(attempts, 3); assert.deepEqual(sleeps, [1000, 2000]);
  attempts = 0;
  await assert.rejects(retrySpeech(() => { attempts++; throw Error("HTTP 403"); }), /403/);
  assert.equal(attempts, 1);
  assert.equal(sanitizeSpeechError("HTTP 429 wss://example.com/a?token=private").includes("private"), false);
});

test("#60 failed generation preserves bytes, reports stale/error, and blocks retime", async () => {
  const dir = temp(); initFilm({ lang: "en", format: "square" }, dir);
  const file = path.join(dir, "film.json"), data = JSON.parse(fs.readFileSync(file));
  data.duration = 2; data.music = "none";
  data.voiceover = { dir: "voiceover", engine: "azure" };
  data.shots = [{ id: "a", start: 0, end: 2, duration: "narration", narration: { en: "Script B" }, purpose: "test", action: "test" }];
  fs.writeFileSync(file, JSON.stringify(data));
  const vo = path.join(dir, "voiceover"), folder = path.join(vo, "en"); fs.mkdirSync(folder, { recursive: true });
  const clip = path.join(folder, "a.mp3");
  spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=duration=0.5", clip]);
  const bytes = fs.readFileSync(clip);
  const rec = { text: "Script A", sha: crypto.createHash("sha256").update(bytes).digest("hex"), voice: "en-US-AndrewMultilingualNeural", rate: "+0%", engine: "azure" };
  fs.writeFileSync(path.join(vo, MANIFEST), JSON.stringify({ "en/a.mp3": rec }));
  const c = checkFilm(dir, { skipGeneratedVoiceover: true }); assert.equal(c.ok, true);
  // Empty key guarantees a local failure; never contacts a speech service.
  const failed = spawnSync(process.execPath, ["bin/motion-use.mjs", "voiceover", dir, "--engine", "azure", "--json"], { encoding: "utf8", env: { ...process.env, AZURE_SPEECH_KEY: "", MOTION_USE_NO_UPDATE_CHECK: "1" } });
  const result = JSON.parse(failed.stdout);
  assert.equal(result.ok, false); assert.ok(result.errors.length);
  assert.equal(result.files[0].stale, true); assert.equal(result.files[0].fits, undefined);
  const saved = process.env.AZURE_SPEECH_KEY; delete process.env.AZURE_SPEECH_KEY;
  let generated;
  try { generated = await generateVoiceover({ languages: ["en"], voiceover: c.film.narrationConfig, scenes: [{ id: "a", narration: { en: "Script B" } }] }, { engine: "azure" }); }
  finally { if (saved !== undefined) process.env.AZURE_SPEECH_KEY = saved; }
  assert.equal(generated.rows[0].status, "error"); assert.equal(generated.rows[0].stale, true);
  assert.deepEqual(fs.readFileSync(clip), bytes);
  assert.throws(() => retimeFilm(dir), /stale narration/);
  rec.text = "Script B"; fs.writeFileSync(path.join(vo, MANIFEST), JSON.stringify({ "en/a.mp3": rec }));
  assert.equal(retimeFilm(dir).ok, true);
  fs.rmSync(path.join(dir, "film.retimed.json"));
  fs.appendFileSync(clip, "tampered"); assert.throws(() => retimeFilm(dir), /stale narration/);
});

test("#61 progress emits only allowlisted metadata on stderr, stdout remains one JSON", () => {
  const rows = []; let time = 0;
  const progress = createProgress("json", (s) => rows.push(JSON.parse(s)), () => time);
  progress("capture_encode", "start", { lang: "en", format: "square", script: "private" });
  time = 2000; progress("capture_encode", "progress", { frames: 30, total: 60 });
  assert.equal(rows[1].elapsed_s, 2); assert.equal(rows[1].frames, 30); assert.equal(rows[0].script, undefined);
  const dir = temp(); initFilm({ lang: "en", format: "square" }, dir);
  const r = cli("render", dir, "--json", "--progress", "json", "--allow-code", "--quality", "invalid");
  assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).ok, false);
  assert.equal(r.stderr.trim().split("\n").map((s) => JSON.parse(s))[0].phase, "command");
});

test("#62 blur never draws the previous shot at frame 4310/60, including range offsets", async () => {
  for (const offset of [0, 4308 / 60]) {
    const events = {}, samples = [], ctx = { resetTransform() {}, clearRect() {}, save() {}, restore() {}, drawImage() {} };
    const canvas = { width: 16, height: 16, getContext: () => ctx };
    const boundary = 4310 / 60;
    const config = { duration: 73, fps: 60, offset, assets: {}, motionBlur: { samples: 2, shutter: 0.5 }, shots: [{ id: "red", start: 0, end: boundary }, { id: "green", start: boundary, end: 73 }] };
    const window = { addEventListener: (n, f) => events[n] = f, drawFrame: (c, t, film, view, M) => samples.push({ color: t < boundary ? "red" : "green", frame: view.frame, shot: M.activeShot(t)?.id }) };
    const document = { getElementById: (id) => id === "film-config" ? { textContent: JSON.stringify(config) } : canvas, createElement: () => canvas, fonts: { load: async () => {}, check: () => true } };
    vm.runInNewContext(fs.readFileSync("src/film-runtime.js", "utf8"), { window, document, Image: class {} });
    await window.__hf.buildReady["motion-use-film"];
    for (const frame of [4309, 4310, 4311]) {
      samples.length = 0;
      events["hf-seek"]({ detail: { time: frame / 60 - offset } });
      assert.equal(samples.length, 2);
      for (const sample of samples) assert.equal(sample.color, frame < 4310 ? "red" : "green");
      assert.equal(samples[0].frame, frame);
      assert.equal(samples[0].shot, frame < 4310 ? "red" : "green");
    }
  }
});

test("#62 native encoded boundary fixture decodes red/green/green at frames 4309–4311", async (t) => {
  const { findRenderer } = await import("../src/native.mjs");
  const native = findRenderer(); if (!native.bin) return t.skip("motion-render not installed");
  const dir = temp(), boundary = 4310 / 60;
  const config = { duration: 73, fps: 60, assets: {}, motionBlur: { samples: 2, shutter: 0.5 }, shots: [{ id: "a", start: 0, end: boundary }, { id: "b", start: boundary, end: 73 }] };
  fs.copyFileSync("src/film-runtime.js", path.join(dir, "runtime.js"));
  fs.writeFileSync(path.join(dir, "draw.js"), `window.drawFrame = (c,t) => { c.fillStyle = t < ${boundary} ? '#ff0000' : '#00ff00'; c.fillRect(0,0,16,16); };`);
  fs.copyFileSync("assets/fonts/NotoSansSC[wght].ttf", path.join(dir, "sans.ttf"));
  const html = path.join(dir, "index.html");
  fs.writeFileSync(html, `<style>@font-face{font-family:Film Sans;src:url(sans.ttf);font-weight:100 900}</style><div data-width="16" data-height="16" data-duration="73"><canvas id="film-canvas" width="16" height="16"></canvas></div><script id="film-config" type="application/json">${JSON.stringify(config)}</script><script src="draw.js"></script><script src="runtime.js"></script>`);
  const rendered = spawnSync(native.bin, ["render", html, "--frames", "4309-4311", "--fps", "60", "--workers", "1", "--stream", "-"], { env: { ...process.env, MOTION_USE_ROOT: process.cwd() } });
  assert.equal(rendered.status, 0, rendered.stderr.toString());
  assert.equal(rendered.stdout.length, 16 * 16 * 4 * 3);
  const mp4 = path.join(dir, "boundary.mp4");
  const encoded = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "16x16", "-framerate", "60", "-i", "pipe:0", "-c:v", "libx264", "-crf", "0", mp4], { input: rendered.stdout });
  assert.equal(encoded.status, 0, encoded.stderr.toString());
  const { streamRender } = await import("../src/native.mjs");
  config.offset = 4309 / 60;
  fs.writeFileSync(html, fs.readFileSync(html, "utf8").replace(/<script id="film-config" type="application\/json">.*?<\/script>/, `<script id="film-config" type="application/json">${JSON.stringify(config)}</script>`));
  const progress = [];
  const streamed = await streamRender({ bin: native.bin, proj: { dir, fps: 60, total: 3 / 60, fmt: { w: 16, h: 16 } }, file: path.join(dir, "stream.mp4"), workers: 1, onProgress: (frames, total) => progress.push({ frames, total }) });
  assert.equal(streamed.code, 0, streamed.out);
  assert.equal(progress.at(-1).frames, 3); assert.equal(progress.at(-1).total, 3);
  const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", mp4, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  assert.equal(decoded.status, 0);
  for (let k = 0; k < 3; k++) {
    const pixel = decoded.stdout.subarray(k * 16 * 16 * 3, k * 16 * 16 * 3 + 3);
    assert.ok(k === 0 ? pixel[0] > 240 && pixel[1] < 15 : pixel[1] > 240 && pixel[0] < 15, `frame ${4309 + k}: ${[...pixel]}`);
  }
});
