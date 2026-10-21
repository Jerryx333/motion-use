import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashBatchPath, runBatch, planBatch } from "../src/batch.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mu-batch-asr-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "voiceover"));
  fs.writeFileSync(path.join(dir, "voiceover", "a.wav"), "owned-audio");
  fs.writeFileSync(path.join(dir, "voiceover", ".motion-use-voiceover.json"), JSON.stringify({ script: "一加五是六" }));
  return dir;
}
const inputHash = dir => hashBatchPath(dir, [], { ignoreOperational: true }).hash;

test("ASR caches/locks/temp files and default journals are derived; audio and narration bindings remain inputs", t => {
  const dir = fixture(t), voice = path.join(dir, "voiceover"), before = inputHash(dir), voiceBefore = inputHash(voice);
  for (const file of [".motion-use-asr.json", ".motion-use-asr.json.lock", ".motion-use-asr.json.11111111-1111-1111-1111-111111111111.tmp", ".motion-use-asr.json.tmp"]) fs.writeFileSync(path.join(voice, file), "derived");
  fs.mkdirSync(path.join(dir, ".motion-use"));
  fs.writeFileSync(path.join(dir, ".motion-use", "events.jsonl"), "derived\n");
  assert.equal(inputHash(dir), before);
  assert.equal(inputHash(voice), voiceBefore);
  // Output hashing remains strict; only source fingerprints ignore metadata.
  assert.notEqual(hashBatchPath(voice).hash, voiceBefore);
  fs.writeFileSync(path.join(voice, "a.wav"), "changed-audio");
  assert.notEqual(inputHash(dir), before);
  fs.writeFileSync(path.join(voice, "a.wav"), "owned-audio");
  fs.writeFileSync(path.join(voice, ".motion-use-voiceover.json"), JSON.stringify({ script: "一加五是七" }));
  assert.notEqual(inputHash(dir), before);
  fs.writeFileSync(path.join(voice, ".motion-use-voiceover.json"), JSON.stringify({ script: "一加五是六" }));
  assert.equal(inputHash(dir), before);
  fs.writeFileSync(path.join(dir, ".motion-use", "authored-config.json"), "keep");
  assert.notEqual(inputHash(dir), before, "unrecognized metadata remains a dependency");
  fs.rmSync(path.join(dir, ".motion-use", "authored-config.json"));
  fs.writeFileSync(path.join(voice, ".motion-use-asr.json.authored-note"), "keep");
  assert.notEqual(inputHash(dir), before, "ASR exclusions do not hide arbitrary matching prefixes");
});

for (const inputs of [["."], ["voiceover"]]) test(`first ASR cache creation does not fail a batch with inputs ${inputs}`, async t => {
  const dir = fixture(t), manifest = path.join(dir, "tasks.json");
  const module = new URL("../src/narration-check.mjs", import.meta.url).href;
  const source = `import fs from 'node:fs';import path from 'node:path';import{checkNarration}from ${JSON.stringify(module)};const file=path.resolve('voiceover/a.wav');const r=checkNarration([{id:'a',file,lang:'zh',text:'一加五是六'}],{dir:path.resolve('voiceover'),run:()=>({items:[{file,text:'1加5是6'}]})});if(!r.ok)throw new Error('check failed');fs.writeFileSync('output.json',JSON.stringify(r));`;
  fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, tasks: [{ id: "review", executable: process.execPath, command: ["--input-type=module", "-e", source], inputs, outputs: ["output.json"] }] }));
  const result = await runBatch(manifest, { allowExec: true });
  assert.equal(result.ok, true, result.tasks.review.error);
  assert.equal(fs.existsSync(path.join(dir, "voiceover", ".motion-use-asr.json")), true);
  assert.equal(planBatch(manifest, { allowExec: true }).tasks[0].status, "cached");
  fs.writeFileSync(path.join(dir, "voiceover", "a.wav"), "changed-audio");
  assert.equal(planBatch(manifest, { allowExec: true }).tasks[0].status, "pending");
});
