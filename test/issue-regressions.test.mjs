import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { initFilm, validateFilm, checkFilm, buildFilm } from "../src/film.mjs";
import { compareNarration, mathSignature, checkNarration } from "../src/narration-check.mjs";
import { estimateCues } from "../src/voiceover.mjs";
import { groupCaptions } from "../src/caption-plan.mjs";
import { retimeFilm } from "../src/retime.mjs";
import { lintCustomHtml } from "../src/brief.mjs";
import { runBatch } from "../src/batch.mjs";
import { acquireOutputLock, releaseCancelledOutputLock } from "../src/output-lock.mjs";
import { runScore } from "../src/score.mjs";
import { findRenderer, nativeStills, nativeProbe } from "../src/native.mjs";
import { collisionRuns, distinctBoxes } from "../src/text-probe.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const native = findRenderer();
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "motion-issues-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  initFilm({ lang: "en", format: "landscape" }, dir);
  const file = path.join(dir, "film.json"), data = JSON.parse(fs.readFileSync(file));
  Object.assign(data, { duration: 4, voiceover: false, music: "none", shots: [
    { id: "a", start: 0, end: 2, purpose: "test picture", action: "a square moves" },
    { id: "b", start: 2, end: 4, purpose: "test picture", action: "a square stops" },
  ] });
  delete data.brief;
  const save = () => fs.writeFileSync(file, JSON.stringify(data));
  save();
  return { dir, data, file, save };
}
const kit = (film) => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "src/film-kit.js"), "utf8"), context);
  return context.window.__filmKit({ width: 1920, height: 1080 }, film);
};
const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, "bin/motion-use.mjs"), ...args, "--json"], { encoding: "utf8", env: { ...process.env, MOTION_USE_NO_UPDATE_CHECK: "1" }, maxBuffer: 32 << 20 });

test("#80 equivalent Chinese decimals pass; actual values, signs, operators and negation remain protected", () => {
  for (const [a, b] of [["一点一三", "1.13"], ["一点一二", "1.12"], ["零点零五", "0.05"], ["一百零二点零三", "102.03"], ["两百六十八", "268"], ["一百二十三。", "123."]]) {
    assert.deepEqual(mathSignature(a, "zh"), mathSignature(b, "zh"));
    assert.equal(compareNarration(`增长系数${a}`, `增长系数${b}`, "zh").flagged, false, `${a}/${b}`);
    assert.equal(compareNarration(`增长系数${b}`, `增长系数${a}`, "zh").flagged, false, `${b}/${a}`);
  }
  for (const [a, b] of [["一点一三", "1.31"], ["负一点一三", "1.13"], ["一点一三加二", "1.13减2"], ["不是一点一三", "是1.13"], ["3-1", "3+1"]])
    assert.ok(compareNarration(a, b, "zh").changes.some((c) => c.kind === "math" && c.flag), `${a}/${b}`);
});

test("#92 a numeral substituted inside a name remains lexical; quantity errors still fail math", () => {
  for (const [a, b] of [["后羿回到家，不见了嫦娥。", "后一回到家,不见了嫦娥。"], ["后羿射下九个太阳", "后一射下九个太阳"]]) {
    const compared = compareNarration(a, b, "zh");
    assert.equal(compared.changes.some((c) => c.kind === "math"), false);
    assert.equal(compared.flagged, true, "a name mismatch still needs phonetic evidence or listening");
  }
  for (const [a, b] of [["三个太阳", "四个太阳"], ["射下九个", "射下十个"], ["后羿不回家", "后一回家"]])
    assert.ok(compareNarration(a, b, "zh").changes.some((c) => c.kind === "math" && c.flag));
});

test("#92 proper-name hints are passed to ASR and participate in cache identity, without waiving errors", (t) => {
  const { dir } = fixture(t), file = path.join(dir, "voice.wav");
  fs.writeFileSync(file, "fixture audio");
  const item = { file, id: "a", lang: "zh", text: "后羿射下九个" };
  let calls = 0;
  const run = (request) => { calls++; assert.deepEqual(request.terms, calls === 1 ? ["后羿"] : ["后羿", "嫦娥"]); return { items: [{ file, text: "后羿射下十个" }] }; };
  for (const terms of [["后羿"], ["后羿"], ["后羿", "嫦娥"]])
    assert.equal(checkNarration([item], { dir, terms, run }).status, "FAIL");
  assert.equal(calls, 2);
});

test("#82 decimal/version punctuation stays inside estimated and service-grouped captions", () => {
  for (const text of ["我们读了 MemT-1.0 的论文。", "评测平均 50.6 分。", "Use v1.0 now. Then continue."]) {
    const cues = estimateCues(text, 0, 6);
    assert.equal(cues.map((c) => c.text).join(" ").replace(/\s/g, ""), text.replace(/\s/g, ""));
    assert.ok(!cues.some((c) => /\d\.$/.test(c.text)));
  }
  const cues = groupCaptions([{ text: "MemT-1.", start: 0, end: 1 }, { text: "0 的论文。", start: 1, end: 2 }]);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "MemT-1.0 的论文。");
});

test("#83 keep-captions shifts within its owner shot; crossing or overflowing captions fail without a proposal", (t) => {
  const p = fixture(t);
  p.data.shots[0].end = 2.01; p.data.shots[1].start = 2.01;
  p.data.captions = { en: [{ text: "Checked copy", start: 2.1, end: 3.5, estimated: false }] };
  p.save();
  assert.throws(() => retimeFilm(p.dir), /keep-captions/);
  const result = retimeFilm(p.dir, { keepCaptions: true });
  const output = JSON.parse(fs.readFileSync(result.film));
  assert.ok(Math.abs(output.captions.en[0].start - (output.shots[1].start + 2.1 - 2.01)) < 1e-6);
  assert.equal(output.captions.en[0].estimated, false);
  p.data.captions.en[0].start = 1.8; p.save();
  assert.throws(() => retimeFilm(p.dir, { keepCaptions: true }), /spans shot/);
  p.data.captions.en[0].start = 2.1; p.data.captions.en[0].end = 4;
  p.data.pace = 2; p.save();
  assert.throws(() => retimeFilm(p.dir, { keepCaptions: true }), /exceeds the retimed/);
  assert.equal(fs.existsSync(path.join(p.dir, "film.retimed-2.json")), false);
});

test("#84 pace preserves authored clocks across repeated retime; score offsets and TTS rates follow pace", (t) => {
  const p = fixture(t);
  p.data.pace = 1.25; p.save();
  const r = retimeFilm(p.dir), d = JSON.parse(fs.readFileSync(r.film));
  assert.equal(d.duration, 3.2);
  assert.equal(d.shots[0].authoredDuration, 2);
  assert.ok(Math.abs(kit(d).shotTime(2.4, "b") - 1) < 1e-6);
  const repeated = JSON.parse(fs.readFileSync(retimeFilm(r.film).film));
  assert.equal(repeated.duration, d.duration);
  const score = path.join(p.dir, "composition/score.js");
  fs.writeFileSync(score, 'window.scoreFilm = (film, S) => { if (!S.has("b") || S.has("missing")) throw Error("has"); S.note("test", S.at("b", 1), 60); S.note("test", S.end("b", -1), 60); };');
  assert.ok(runScore(score, d, {}).events.every((e) => Math.abs(e.t - 2.4) < 1e-6));
  p.data.voiceover = {}; p.data.shots.forEach((s) => { s.narration = { en: "A measured voice" }; });
  const checked = validateFilm(p.data, p.dir, { phase: "narration" });
  assert.deepEqual(checked.errors, []);
  assert.equal(checked.film.narrationConfig.rates.en, "+25%");
});

test("#86 decorative scope is nested and restores after exceptions", () => {
  const M = kit({}), c = {};
  assert.throws(() => M.texture(c, () => {
    assert.equal(c.__motionUseTexture, true);
    M.texture(c, () => assert.equal(c.__motionUseTexture, true));
    assert.equal(c.__motionUseTexture, true);
    throw Error("drawing failed");
  }), /drawing failed/);
  assert.equal(c.__motionUseTexture, undefined);
});

test("#87 display strings/comments with URLs pass; real network calls, imports and image sinks fail", () => {
  const lint = (s) => lintCustomHtml(s, { javascript: true });
  for (const s of ['c.fillText("curl https://raw.githubusercontent.com/x", 0, 0);', '// https://example.com\nc.fillText("fetch",0,0);', 'const label = `https://example.com`;', `c.fillText('image.src="https://example.com"',0,0);`, 'const x=1; // image.src = "https://example.com"'])
    assert.deepEqual(lint(s), [], s);
  for (const s of ['fetch("https://example.com")', 'new WebSocket("wss://example.com")', 'import("https://example.com/x.js")', 'new Image().src = "https://example.com/x.png"', 'const s = `${fetch("/x")}`;'])
    assert.ok(lint(s).some((r) => r.rule === "network"), s);
});

test("#88 long films validate, enter narration phase, and retime without manually splitting", (t) => {
  const p = fixture(t);
  p.data.duration = 211; p.data.shots[1].end = 211; p.save();
  for (const phase of ["complete", "narration"]) assert.deepEqual(validateFilm(p.data, p.dir, { phase }).errors, []);
  assert.equal(retimeFilm(p.dir).duration, 211);
});

test("#87 declaring local files permits local fetch but still rejects a remote fetch URL", (t) => {
  const p = fixture(t);
  fs.writeFileSync(path.join(p.dir, "config.json"), "{}");
  p.data.files = { cfg: "config.json" };
  const drawing = path.join(p.dir, "composition/draw.js");
  fs.writeFileSync(drawing, 'window.setupFilm=()=>fetch(window.filmFiles.cfg); window.drawFrame=()=>{};');
  assert.deepEqual(validateFilm(p.data, p.dir).errors, []);
  fs.writeFileSync(drawing, 'window.setupFilm=()=>fetch("https://example.com/config.json"); window.drawFrame=()=>{};');
  assert.ok(validateFilm(p.data, p.dir).errors.some((e) => e.path === "$.composition" && /network/.test(e.message)));
});

test("#91 asset-name error identifies naming and accessor separately from extension", (t) => {
  const p = fixture(t);
  fs.writeFileSync(path.join(p.dir, "image.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  p.data.assets = { bg_b02: "image.svg" };
  const errors = validateFilm(p.data, p.dir).errors;
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /hyphens.*filmAssets\["bg-b02"\]/);
  p.data.assets = { bg: "image.txt" };
  assert.ok(validateFilm(p.data, p.dir).errors.some((e) => /image path/.test(e.message)));
});

test("#85 real probe recognizes only geometrically aligned colour repaint; #86 texture excludes decoration", { timeout: 60000 }, async (t) => {
  if (native.missing) return t.skip("native renderer not available");
  const p = fixture(t);
  fs.writeFileSync(path.join(p.dir, "composition/draw.js"), `window.drawFrame = (c,t,f,v,M) => {
    c.fillStyle="#111111"; c.fillRect(0,0,v.width,v.height);
    c.font='30px "Film Mono"'; c.textAlign="left"; c.textBaseline="alphabetic";
    c.fillStyle="#ffffff"; c.fillText("pushed 8a814e1 nas",100,100);
    c.fillStyle="#00ff00"; c.fillText("8a814e1",100+c.measureText("pushed ").width,100);
    c.fillText("pushed",100,100); // exact prefix
    c.fillText("8a814e1",110+c.measureText("pushed ").width,100); // wrong offset must collide
    M.texture(c,ctx=>{ctx.fillText("decorative texture",-5,5);ctx.fillText("texture again",-5,5);});
    c.fillText("ordinary clipping",v.width-5,200);
  };`);
  const checked = checkFilm(p.dir, {}); assert.equal(checked.ok, true, JSON.stringify(checked.report));
  const proj = await buildFilm(checked.film, "en", "landscape", path.join(p.dir, "build"));
  const probe = await nativeProbe({ bin: native.bin, projDir: proj.dir, times: [0, 0.1, 0.2], work: path.join(p.dir, "probe") });
  const boxes = probe.samples[0].boxes;
  assert.equal(boxes.some((b) => b.text.includes("texture")), false);
  assert.ok(boxes.find((b) => b.text === "ordinary clipping").x1 > probe.width);
  const highlights = boxes.filter((b) => b.repaintOf?.length);
  assert.equal(highlights.length, 2);
  assert.equal(distinctBoxes(boxes).filter((b) => b.text === "8a814e1").length, 1);
  assert.ok(collisionRuns(probe.samples).some((r) => r.text === "pushed 8a814e1 nas" && r.other === "8a814e1"), "wrong offset still collides");
});

test("#89 a static red draft exits zero, while high and explicit gate still fail", { timeout: 180000 }, (t) => {
  if (native.missing) return t.skip("native renderer not available");
  const p = fixture(t);
  fs.writeFileSync(path.join(p.dir, "composition/draw.js"), 'window.drawFrame=(c,t,f,v)=>{c.fillStyle="#5555dd";c.fillRect(0,0,v.width,v.height);c.fillStyle="#ffffff";c.fillRect(50,50,300,300);};');
  for (const [quality, gate, expected] of [["draft", false, 0], ["draft", true, 1], ["high", false, 1]]) {
    const r = cli("render", p.dir, "--allow-code", "--quality", quality, "--no-asr", "--no-text-check", "--out", path.join(p.dir, `out-${quality}-${gate}`), ...(gate ? ["--gate"] : []));
    assert.equal(r.status, expected, r.stdout + r.stderr);
    const result = JSON.parse(r.stdout);
    if (!expected) {
      assert.equal(result.outputs[0].verification.motion.level, "red");
      assert.equal(result.outputs[0].verification.ok, true);
      assert.ok(fs.existsSync(result.outputs[0].file));
    }
  }
});

test("#81 cancelling actual built-in still/render children releases only witnessed dead-owner locks", { timeout: 60000 }, async (t) => {
  if (process.platform === "win32") return t.skip("process group acceptance is POSIX");
  const p = fixture(t), fake = path.join(p.dir, "renderer.mjs"), ready = path.join(p.dir, "ready");
  fs.writeFileSync(fake, `#!/usr/bin/env node\nimport fs from 'node:fs'; if(process.argv.includes('--capabilities')) { console.log(JSON.stringify({version:'0.17.0',stream:true,probe:true})); } else {fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);}`);
  fs.chmodSync(fake, 0o755);
  const old = process.env.MOTION_RENDER; process.env.MOTION_RENDER = fake;
  t.after(() => { if (old === undefined) delete process.env.MOTION_RENDER; else process.env.MOTION_RENDER = old; });
  for (const command of ["still", "render"]) {
    fs.rmSync(ready, { force: true });
    const manifest = path.join(p.dir, `${command}.tasks.json`);
    fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, tasks: [{ id: command, command: [command, ".", "--allow-code", "--no-asr", "--no-text-check", "--renderer", "native", "--json"], inputs: ["film.json", "composition"], outputs: ["out"] }] }));
    const controller = new AbortController();
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, 20000);
    const interval = setInterval(() => { if (fs.existsSync(ready)) controller.abort(); }, 25);
    let result;
    try { result = await runBatch(manifest, { signal: controller.signal }); }
    finally { clearTimeout(deadline); clearInterval(interval); }
    assert.equal(timedOut, false, command + " reached native capture");
    assert.equal(result.status, "cancelled");
    assert.equal(result.tasks[command].status, "cancelled");
    assert.equal(fs.existsSync(path.join(p.dir, "out/.motion-use.lock")), false, command);
  }
});

test("#81 cleanup refuses a live owner, a changed run, another host and a symlink", (t) => {
  const p = fixture(t), out = path.join(p.dir, "out"), lock = path.join(out, ".motion-use.lock");
  const unlock = acquireOutputLock(out), live = JSON.parse(fs.readFileSync(lock));
  assert.equal(releaseCancelledOutputLock(lock, live), false);
  unlock();
  const child = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  const owner = { ...live, pid: child.pid };
  fs.writeFileSync(lock, JSON.stringify(owner));
  assert.equal(releaseCancelledOutputLock(lock, { ...owner, run: "another-run" }), false);
  assert.equal(releaseCancelledOutputLock(lock, { ...owner, host: "another-host" }), false);
  const target = path.join(p.dir, "target.json"); fs.renameSync(lock, target); fs.symlinkSync(target, lock);
  assert.equal(releaseCancelledOutputLock(lock, owner), false);
  fs.unlinkSync(lock); fs.renameSync(target, lock);
  assert.equal(releaseCancelledOutputLock(lock, owner), true);
  assert.equal(fs.existsSync(lock), false);
});

test("#81 cancelling an explicitly authorized external executable keeps its lock evidence", { timeout: 15000 }, async (t) => {
  const p = fixture(t), manifest = path.join(p.dir, "external.tasks.json"), lock = path.join(p.dir, "out/.motion-use.lock");
  const module = new URL("../src/output-lock.mjs", import.meta.url).href;
  fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, tasks: [{ id: "external", executable: process.execPath, command: ["--input-type=module", "-e", `import {acquireOutputLock} from ${JSON.stringify(module)}; acquireOutputLock('out'); setInterval(()=>{},1000);`], inputs: ["film.json"], outputs: ["out"] }] }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  const polling = setInterval(() => { if (fs.existsSync(lock)) controller.abort(); }, 25);
  let result;
  try { result = await runBatch(manifest, { signal: controller.signal, allowExec: true }); }
  finally { clearTimeout(timer); clearInterval(polling); }
  assert.equal(result.status, "cancelled");
  assert.equal(fs.existsSync(lock), true);
});

test("#90 native draws valid PNGs containing large C2PA chunks identically, preserving original bytes", { timeout: 60000 }, async (t) => {
  if (native.missing) return t.skip("native renderer not available");
  const p = fixture(t), original = path.join(p.dir, "original.png"), tagged = path.join(p.dir, "tagged.png");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x38bd91:s=16x16", "-frames:v", "1", original]);
  const crc32 = (data) => {
    let crc = 0xffffffff;
    for (const value of data) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const bytes = fs.readFileSync(original), payload = Buffer.alloc(23654, 0x61), chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length); chunk.write("caBX", 4); payload.copy(chunk, 8); chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  fs.writeFileSync(tagged, Buffer.concat([bytes.subarray(0, 33), chunk, bytes.subarray(33)]));
  const sourceHash = crypto.createHash("sha256").update(fs.readFileSync(tagged)).digest("hex");
  fs.writeFileSync(path.join(p.dir, "composition/draw.js"), 'window.drawFrame=(c,t,f,v)=>c.drawImage(window.filmAssets.bg,0,0,v.width,v.height);');
  const rendered = [];
  for (const file of ["original.png", "tagged.png"]) {
    p.data.assets = { bg: file }; p.save();
    const checked = checkFilm(p.dir, {}); assert.equal(checked.ok, true, JSON.stringify(checked.report));
    const proj = await buildFilm(checked.film, "en", "landscape", path.join(p.dir, `build-${file}`));
    const out = path.join(p.dir, `frames-${file}`); fs.mkdirSync(out);
    const result = await nativeStills({ bin: native.bin, proj, times: [0], dir: out });
    assert.equal(result.code, 0, result.out);
    rendered.push(fs.readFileSync(path.join(out, fs.readdirSync(out).find((n) => n.endsWith(".png")))));
  }
  assert.deepEqual(rendered[1], rendered[0]);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(tagged)).digest("hex"), sourceHash);
});

test("#88 actual 211-second native CLI render has a continuous soundtrack and complete frame count", { timeout: 300000 }, (t) => {
  if (!process.env.MOTION_USE_LONG_TEST || native.missing) return t.skip("set MOTION_USE_LONG_TEST=1 with native renderer for long delivery acceptance");
  const p = fixture(t);
  p.data.duration = 211; p.data.shots[1].end = 211; p.data.fps = 24;
  p.data.music = { builtin: "pulse", volume: 0.6 }; p.save();
  fs.writeFileSync(path.join(p.dir, "composition/draw.js"), 'window.drawFrame=(c,t,f,v)=>{c.fillStyle="#202020";c.fillRect(0,0,v.width,v.height);c.fillStyle="#38bd91";c.fillRect(20+(t%4)*50,50,100,100);};');
  const r = cli("render", p.dir, "--allow-code", "--quality", "draft", "--renderer", "native", "--workers", "2", "--no-asr", "--no-text-check");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const result = JSON.parse(r.stdout), file = result.outputs[0].file;
  const observed = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,nb_frames", "-of", "json", file]));
  assert.equal(Number(observed.streams.find((s) => s.codec_type === "video").nb_frames), 211 * 24);
  assert.ok(observed.streams.some((s) => s.codec_type === "audio"));
  assert.ok(Math.abs(Number(observed.format.duration) - 211) < 0.1);
  // The old limit was 180 s. Measure non-silent audio on both sides of it.
  for (const from of [179.5, 180]) {
    const pcm = execFileSync("ffmpeg", ["-v", "error", "-ss", String(from), "-t", "0.5", "-i", file, "-f", "f32le", "-ac", "1", "-ar", "8000", "-"]);
    let energy = 0; for (let i = 0; i < pcm.length; i += 4) energy += pcm.readFloatLE(i) ** 2;
    assert.ok(Math.sqrt(energy / (pcm.length / 4)) > 0.001, `audio at ${from}s`);
  }
});
