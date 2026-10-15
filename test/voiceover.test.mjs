import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validateBrief } from "../src/brief.mjs";
import { parseSize } from "../src/cli.mjs";
import { MANIFEST, generateVoiceover, pickEngine, runEdgeTts, spokenText, ssml } from "../src/voiceover.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "motion-use-vo-"));
fs.mkdirSync(path.join(tmp, "vo", "en"), { recursive: true });
const brief = (over = {}) => {
  const r = validateBrief({ version: 1, name: "t", languages: ["en"], voiceover: { dir: "vo" }, scenes: [{ id: "a", type: "title", title: "A", narration: "Hello there." }], ...over }, tmp);
  assert.deepEqual(r.errors, []);
  return r.brief;
};

test("narration, voices and rates are validated", () => {
  const bad = validateBrief({ version: 1, languages: ["en"], voiceover: { dir: "vo", engine: "say", voices: { en: "<x>" }, rate: "fast" }, scenes: [{ type: "title", title: "A" }] }, tmp).errors.map((e) => e.path);
  assert.ok(bad.includes("$.voiceover.engine"));
  assert.ok(bad.includes("$.voiceover.voices.en"));
  assert.ok(bad.includes("$.voiceover.rate"));
  const ok = brief({ voiceover: { dir: "vo", voices: { en: "en-US-AndrewMultilingualNeural" }, rate: { en: "+5%" } } });
  assert.equal(ok.voiceover.rates.en, "+5%");
  assert.equal(ok.scenes[0].narration.en, "Hello there.");
  assert.equal(ok.voiceover.required,true);
  assert.equal(brief({voiceover:{dir:"vo",required:false}}).voiceover.required,false);
});

test("SSML keeps narration as text", () => {
  const x = ssml(`a < b & "c" </voice><voice name='evil'>`, "en-US-AndrewMultilingualNeural", "+5%");
  assert.equal((x.match(/<voice /g) ?? []).length, 1);
  assert.ok(x.includes("a &lt; b &amp; &quot;c&quot; &lt;/voice&gt;"));
  assert.ok(x.includes('xml:lang="en-US"'));
});

test("say validates string mappings and replaces longer keys first", () => {
  const say = { "数": "错", "有数": "有树", "Hello": "Hi" };
  const b = brief({ voiceover: { dir: "vo", say } });
  assert.deepEqual(b.voiceover.say, say);
  assert.equal(b.scenes[0].narration.en, "Hello there.");
  assert.equal(b.scenes[0].title.en, "A");
  assert.equal(spokenText("抬头就有数，数。", say), "抬头就有树，错。");
  assert.equal(spokenText("a.a", { "a.": "$&" }), "$&a");
  assert.deepEqual(brief({ voiceover: { dir: "vo", say: { a: "" } } }).voiceover.say, { a: "" });
  for (const say of [null, [], "有树", 1, { "": "有树" }, { "有数": 1 }, { "有数": null }]) {
    const r = validateBrief({ version: 1, languages: ["en"], voiceover: { say }, scenes: [{ type: "title", title: "A" }] }, tmp);
    assert.ok(r.errors.some((e) => e.path === "$.voiceover.say"), JSON.stringify(say));
  }
});

test("spoken text controls TTS requests, the manifest and cache reuse", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mu-say-"));
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(options.body);
    return { ok: true, arrayBuffer: async () => Buffer.from("mock audio") };
  });
  const saved = { key: process.env.AZURE_SPEECH_KEY, region: process.env.AZURE_SPEECH_REGION };
  t.after(() => {
    if (saved.key === undefined) delete process.env.AZURE_SPEECH_KEY; else process.env.AZURE_SPEECH_KEY = saved.key;
    if (saved.region === undefined) delete process.env.AZURE_SPEECH_REGION; else process.env.AZURE_SPEECH_REGION = saved.region;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.env.AZURE_SPEECH_KEY = "test";
  process.env.AZURE_SPEECH_REGION = "test";
  const b = brief({ voiceover: { dir: "vo", say: { Hello: "Hi" } } });
  b.voiceover.dir = dir;
  const generate = () => generateVoiceover(b, { engine: "azure" });
  assert.equal((await generate()).rows[0].status, "generated");
  assert.ok(requests[0].includes("Hi there."));
  const manifest = () => JSON.parse(fs.readFileSync(path.join(dir, MANIFEST)))[path.join("en", "a.mp3")];
  assert.equal(manifest().text, "Hi there.");
  assert.equal((await generate()).rows[0].status, "unchanged");
  b.voiceover.say.Hello = "Greetings";
  assert.equal((await generate()).rows[0].status, "generated");
  assert.ok(requests[1].includes("Greetings there."));
  assert.equal(manifest().text, "Greetings there.");
  b.voiceover.say.unused = "ignored";
  assert.equal((await generate()).rows[0].status, "unchanged");
  assert.equal(requests.length, 2);
  assert.equal(b.scenes[0].narration.en, "Hello there.");
});

test("Edge 403 retries uvx once with identical TTS arguments", () => {
  const args = ["--voice", "zh-CN-XiaoxiaoNeural", "--rate=+0%", "--text", "有树", "--write-media", "test.mp3"];
  const calls = [];
  const run = (cmd, argv) => {
    calls.push([cmd, argv]);
    return cmd === "python" ? { status: 1, stdout: "HTTP 403", stderr: "last line" } : { status: 0 };
  };
  runEdgeTts(args, { run, command: ["python", ["edge-tts.py", ...args]] });
  assert.deepEqual(calls, [["python", ["edge-tts.py", ...args]], ["which", ["uvx"]], ["uvx", ["--quiet", "--from", "edge-tts", "edge-tts", ...args]]]);
  for (const available of [false, true]) {
    let retries = 0;
    assert.throws(() => runEdgeTts(args, {
      command: ["edge-tts", args],
      run: (cmd) => {
        if (cmd === "which") return { status: available ? 0 : 1 };
        if (cmd === "uvx") retries++;
        return { status: 1, stderr: cmd === "uvx" ? "retry failed" : "403" };
      },
    }), /edge-tts was rejected \(403\); upgrade it: uv tool upgrade edge-tts, or pip install -U edge-tts/);
    assert.equal(retries, available ? 1 : 0);
  }
  let attempts = 0;
  assert.throws(() => runEdgeTts(args, { command: ["edge-tts", args], run: () => { attempts++; return { status: 1, stderr: "other failure" }; } }), /other failure/);
  assert.equal(attempts, 1);
});

test("a recording motion-use did not make is never replaced without --force", async () => {
  const f = path.join(tmp, "vo", "en", "a.mp3");
  fs.writeFileSync(f, "my own recording");
  const res = await generateVoiceover(brief(), { engine: "edge" });
  assert.equal(res.rows[0].status, "kept");
  assert.equal(fs.readFileSync(f, "utf8"), "my own recording");
  fs.rmSync(f);
});

test("generated audio whose text did not change is left alone", async () => {
  const f = path.join(tmp, "vo", "en", "a.mp3");
  fs.writeFileSync(f, "generated earlier");
  const sha = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  const rec = { text: "Hello there.", engine: "edge", voice: "en-US-AndrewMultilingualNeural", rate: "+0%", sha };
  fs.writeFileSync(path.join(tmp, "vo", MANIFEST), JSON.stringify({ [path.join("en", "a.mp3")]: rec }));
  const res = await generateVoiceover(brief(), { engine: "edge" });
  assert.equal(res.rows[0].status, "unchanged");
});

test("azure is picked only when it is configured", () => {
  const saved = { k: process.env.AZURE_SPEECH_KEY, r: process.env.AZURE_SPEECH_REGION };
  delete process.env.AZURE_SPEECH_KEY;
  assert.equal(pickEngine(), "edge");
  process.env.AZURE_SPEECH_KEY = "k";
  process.env.AZURE_SPEECH_REGION = "eastus";
  assert.equal(pickEngine(), "azure");
  assert.equal(pickEngine("edge"), "edge");
  if (saved.k === undefined) delete process.env.AZURE_SPEECH_KEY; else process.env.AZURE_SPEECH_KEY = saved.k;
  if (saved.r === undefined) delete process.env.AZURE_SPEECH_REGION; else process.env.AZURE_SPEECH_REGION = saved.r;
});

test("sizes parse in decimal megabytes", () => {
  assert.equal(parseSize("9MB"), 9e6);
  assert.equal(parseSize("9.5M"), 9.5e6);
  assert.equal(parseSize("9000000"), 9e6);
  assert.equal(parseSize(null), null);
  assert.equal(parseSize("abc"), undefined);
  assert.equal(parseSize("1kb"), undefined); // below 100 KB is never a sensible video limit
});
