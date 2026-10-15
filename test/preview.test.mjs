import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { initFilm, safeBox, FILM_FORMATS } from "../src/film.mjs";
import { createPreview, inputStamp, previewPage, startPreview } from "../src/preview.mjs";

function fixture(t, music = "none") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mu-preview-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  initFilm({ lang: "en", format: "vertical,landscape" }, dir);
  const file = path.join(dir, "film.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  Object.assign(data, { voiceover: false, music });
  fs.writeFileSync(file, JSON.stringify(data));
  return { dir, file, data };
}
const bump = file => { const stat = fs.statSync(file); fs.utimesSync(file, stat.atime, new Date(stat.mtimeMs + 2000)); };
const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();

function fakeBuilder(counter, withAudio = false) {
  return async (film, lang, format, dir) => {
    counter.builds++;
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><canvas></canvas>");
    return { total: film.duration, mix: withAudio ? [{ file: film.source, rel: "clip.wav", start: 0, duration: 1, volume: 1 }] : [] };
  };
}

test("page escapes authored values, localizes storyboard and exposes portrait controls", () => {
  const attack = '</script><script>evil()</script>"&';
  const film = { name: attack, duration: 3, fps: 30, shots: [{ id: attack, start: 0, end: 3, action: { en: attack, zh: "动作" }, text: { en: "words", zh: "文字" }, narration: { en: "spoken", zh: "旁白" } }] };
  const page = previewPage(film, "en", "vertical", true);
  assert.match(page, /&lt;\/script&gt;&lt;script&gt;evil\(\)&lt;\/script&gt;&quot;&amp;/);
  assert.ok(!page.includes(attack));
  assert.match(page, /<h2>Storyboard<\/h2>/);
  assert.match(page, /<td>words<\/td><td>spoken<\/td>/);
  assert.match(page, /data-start="0" data-end="3"/);
  assert.match(page, /id="platform-guides"/);
  for (const side of ["top", "bottom", "left", "right"]) assert.ok(page.includes(`class="mask ${side}"`));
  const [w, h] = FILM_FORMATS.vertical, safe = safeBox(w, h);
  const pct = (value, total) => Number((value / total * 100).toFixed(6));
  assert.ok(page.includes(`.top{top:0;height:${pct(safe.y, h)}%}`));
  assert.ok(page.includes(`.bottom{bottom:0;height:${pct(h - safe.y - safe.h, h)}%}`));
  assert.ok(page.includes(`.left{left:0;width:${pct(safe.x, w)}%}`));
  assert.ok(page.includes(`.right{right:0;width:${pct(w - safe.x - safe.w, w)}%}`));
  assert.match(page, /<iframe src="\/build\/index.html"/);
  assert.match(page, /id="clock"/);
  const script = page.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.ok(!script.includes("evil()"));
  new vm.Script(script);
  const landscape = previewPage(film, "zh", "landscape");
  assert.match(landscape, /<td>动作<\/td><td>文字<\/td><td>旁白<\/td>/);
  assert.doesNotMatch(landscape, /id="platform-guides"|id="clock"/);
});

test("mtime snapshots detect edits, additions and removals in composition", t => {
  const { dir, file } = fixture(t);
  const source = path.join(dir, "composition", "draw.js");
  const inputs = [file, path.dirname(source)];
  const initial = inputStamp(inputs);
  assert.equal(inputStamp(inputs), initial);
  bump(source); assert.notEqual(inputStamp(inputs), initial);
  const edited = inputStamp(inputs), extra = path.join(dir, "composition", "extra.js");
  fs.writeFileSync(extra, "// helper"); assert.notEqual(inputStamp(inputs), edited);
  const added = inputStamp(inputs); fs.unlinkSync(extra); assert.notEqual(inputStamp(inputs), added);
});

test("refresh rebuilds changed film/composition and retains mix until audio inputs change", async t => {
  const { dir, file, data } = fixture(t, { builtin: "pulse", volume: 0.3 });
  const counter = { builds: 0, mixes: 0 };
  const preview = createPreview(dir, {}, {
    buildFilm: fakeBuilder(counter, true),
    mixAudio: (_tracks, _total, out) => { counter.mixes++; fs.writeFileSync(out, "mix"); },
  });
  await Promise.all([preview.refresh(), preview.refresh()]);
  assert.deepEqual(counter, { builds: 1, mixes: 1 });
  await preview.refresh(); assert.equal(counter.builds, 1);
  bump(path.join(dir, "composition", "draw.js"));
  const state = await preview.refresh();
  assert.deepEqual(counter, { builds: 2, mixes: 1 });
  assert.equal(fs.readFileSync(path.join(state.dir, "preview.wav"), "utf8"), "mix");
  data.shots[0].action = "A wheel turns"; fs.writeFileSync(file, JSON.stringify(data));
  await preview.refresh(); assert.deepEqual(counter, { builds: 3, mixes: 1 });
  data.music.volume = 0.5; fs.writeFileSync(file, JSON.stringify(data));
  await preview.refresh(); assert.deepEqual(counter, { builds: 4, mixes: 2 });
});

test("source audio mtime changes trigger build and remix using the formal mix descriptor", { skip: !hasFfmpeg && "ffmpeg not installed" }, async t => {
  const { dir, file, data } = fixture(t);
  const source = path.join(dir, "sound.wav");
  fs.copyFileSync(new URL("../assets/sfx/click.wav", import.meta.url), source);
  data.audio = [{ file: "sound.wav", role: "sfx", start: 1, volume: 0.4 }];
  fs.writeFileSync(file, JSON.stringify(data));
  let mixes = 0;
  const preview = createPreview(dir, {}, { mixAudio: (tracks, total, out) => {
    mixes++;
    assert.equal(tracks[0].volume, 0.4); assert.equal(tracks[0].fadeIn, 0.015); assert.equal(tracks[0].fadeOut, 0.03);
    assert.equal(tracks[0].start, 1); assert.equal(total, data.duration);
    fs.writeFileSync(out, "mix");
  } });
  await preview.refresh(); assert.equal(mixes, 1);
  bump(source); await preview.refresh(); assert.equal(mixes, 2);
});

test("real premix writes a WAV and picture-only rebuild preserves it", { skip: !hasFfmpeg && "ffmpeg not installed" }, async t => {
  const { dir } = fixture(t, { builtin: "pulse", volume: 0.2, duck: false });
  const preview = createPreview(dir);
  const first = await preview.refresh();
  const wav = fs.readFileSync(path.join(first.dir, "preview.wav"));
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  bump(path.join(dir, "composition", "draw.js"));
  await preview.refresh(); assert.deepEqual(fs.readFileSync(path.join(first.dir, "preview.wav")), wav);
});

test("briefs, external engines and invalid options produce clear errors", async t => {
  const { dir, file, data } = fixture(t);
  const brief = path.join(dir, "brief.json"); fs.writeFileSync(brief, '{}');
  await assert.rejects(createPreview(brief).refresh(), /brief.json is not supported/);
  await assert.rejects(startPreview(dir, { port: "invalid" }), /--port/);
  await assert.rejects(createPreview(dir, { lang: "en,en" }).refresh(), /one --lang/);
  data.engine = { type: "command", command: ["echo", "unused"] };
  fs.writeFileSync(file, JSON.stringify(data));
  await assert.rejects(createPreview(dir).refresh(), /external command engines/);
});

test("loopback HTTP serves the review and built index, rebuilds on refresh and confines paths", async t => {
  const { dir } = fixture(t);
  const counter = { builds: 0 };
  const { server, url } = await startPreview(dir, { port: 0 }, { buildFilm: fakeBuilder(counter) });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  assert.equal(server.address().address, "127.0.0.1");
  const review = await fetch(url);
  assert.equal(review.status, 200); assert.match(await review.text(), /<iframe[\s\S]*Storyboard/);
  const index = await fetch(new URL("build/index.html", url));
  assert.equal(index.status, 200); assert.match(await index.text(), /canvas/);
  assert.equal(counter.builds, 1);
  bump(path.join(dir, "composition", "draw.js"));
  assert.equal((await fetch(url)).status, 200); assert.equal(counter.builds, 2);
  assert.equal((await fetch(new URL("film.json", url))).status, 404);
  assert.equal((await fetch(new URL("build/%2fetc%2fpasswd", url))).status, 404);
  fs.symlinkSync(path.join(dir, "film.json"), path.join(dir, "out", ".build", fs.readdirSync(path.join(dir, "out", ".build"))[0], "escape.json"));
  assert.equal((await fetch(new URL("build/escape.json", url))).status, 404);
  assert.equal((await fetch(url, { method: "POST" })).status, 405);
});

// Exercise a symlinked build root on every OS, including macOS's /var -> /private/var case.
test("HTTP serves builds through a directory alias", async t => {
  const { dir } = fixture(t);
  const alias = `${dir}-alias`;
  fs.symlinkSync(dir, alias, "dir");
  t.after(() => fs.unlinkSync(alias));
  const { server, url } = await startPreview(alias, {}, { buildFilm: fakeBuilder({ builds: 0 }) });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  assert.equal((await fetch(new URL("build/index.html", url))).status, 200);
});

test("footage builds JPEG assets and serves a review page without capturing film frames", { skip: !hasFfmpeg && "ffmpeg not installed" }, async t => {
  const { dir, file, data } = fixture(t);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=30:d=1", "-c:v", "mpeg4", path.join(dir, "clip.mp4")]);
  data.videos = { demo: { file: "clip.mp4", at: 0, length: 1, volume: 0 } };
  fs.writeFileSync(file, JSON.stringify(data));
  const { server, url } = await startPreview(dir, { format: "vertical" });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const review = await fetch(url);
  assert.equal(review.status, 200);
  assert.match(await review.text(), /<iframe[\s\S]*Storyboard/);
  const index = await fetch(new URL("build/index.html", url));
  assert.equal(index.status, 200);
  const config = JSON.parse((await index.text()).match(/<script id="film-config" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(config.safe, safeBox(...FILM_FORMATS.vertical));
  assert.equal(config.videos.demo.frames, data.fps);
  const jpeg = await fetch(new URL(`build/${config.videos.demo.dir}/00000.jpg`, url));
  assert.equal(jpeg.status, 200);
  assert.equal(jpeg.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await jpeg.arrayBuffer()).subarray(0, 2), Buffer.from([0xff, 0xd8]));
});
