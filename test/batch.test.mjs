import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runBatch, planBatch, hashBatchPath, readBatchStatus } from "../src/batch.mjs";
import { createJournal, aggregateJournal } from "../src/journal.mjs";

function fixture(t, tasks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "motion-batch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "tasks.json");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, tasks }));
  return { dir, file };
}
const task = (id, source, extra = {}) => ({ id, executable: process.execPath, command: ["-e", source], inputs: [fileURLToPath(new URL("../package.json", import.meta.url))], outputs: [`${id}.txt`], ...extra });
const write = id => `require('fs').writeFileSync('${id}.txt', '${id}')`;
const options = { allowExec: true };

test("batch refuses omitted or empty inputs before execution or state creation", async t => {
  const withoutInputs = task("a", write("a"));
  delete withoutInputs.inputs;
  for (const invalid of [withoutInputs, task("a", write("a"), { inputs: [] })]) {
    const p = fixture(t, [invalid]);
    assert.throws(() => planBatch(p.file, options), /declare at least one input/);
    await assert.rejects(runBatch(p.file, options), /declare at least one input/);
    assert.equal(fs.existsSync(path.join(p.dir, ".motion-use")), false);
    assert.equal(fs.existsSync(path.join(p.dir, "a.txt")), false);
  }
});

test("batch validates trust boundary, cycles, aliases, and overlapping outputs before writes", async t => {
  const p = fixture(t, [task("a", write("a"))]);
  await assert.rejects(runBatch(p.file), /allowExec/);
  assert.equal(fs.existsSync(path.join(p.dir, ".motion-use")), false);
  fs.writeFileSync(p.file, JSON.stringify({ schemaVersion: 1, tasks: [task("a", write("a"), { dependsOn: ["b"] }), task("b", write("b"), { dependsOn: ["a"] })] }));
  assert.throws(() => planBatch(p.file, options), /cycle/);
  fs.writeFileSync(p.file, JSON.stringify({ schemaVersion: 1, tasks: [task("a", write("a"), { outputs: ["shared"] }), task("b", write("b"), { outputs: ["shared/b.txt"] })] }));
  assert.throws(() => planBatch(p.file, options), /overlapping/);
});

test("batch runs independent tasks after failure and blocks only descendants", async t => {
  const p = fixture(t, [task("bad", "process.exit(2)"), task("child", write("child"), { dependsOn: ["bad"] }), task("good", write("good"))]);
  const result = await runBatch(p.file, { ...options, concurrency: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.tasks.bad.status, "failed");
  assert.equal(result.tasks.child.status, "blocked");
  assert.equal(result.tasks.good.status, "success");
  assert.equal(fs.readFileSync(path.join(p.dir, "good.txt"), "utf8"), "good");
  assert.equal(fs.existsSync(path.join(p.dir, "child.txt")), false);
});

test("resume hashes inputs and output content and propagates dependency invalidation", async t => {
  const p = fixture(t, [
    task("a", "const fs=require('fs'); fs.writeFileSync('a.txt', fs.readFileSync('input.txt'))", { inputs: ["input.txt"] }),
    task("b", "const fs=require('fs'); fs.writeFileSync('b.txt', fs.readFileSync('a.txt'))", { dependsOn: ["a"], inputs: ["a.txt"] }),
    task("c", write("c")),
  ]);
  fs.writeFileSync(path.join(p.dir, "input.txt"), "first");
  const result = await runBatch(p.file, options);
  assert.equal(result.ok, true);
  assert.ok(planBatch(p.file, options).tasks.every(r => r.status === "cached"));
  const cached = await runBatch(p.file, options);
  assert.deepEqual(Object.values(cached.tasks).map(r => r.attempt), [1, 1, 1]);
  fs.writeFileSync(path.join(p.dir, "input.txt"), "second");
  assert.deepEqual(planBatch(p.file, options).tasks.map(r => r.status), ["pending", "pending", "cached"]);
  const changed = await runBatch(p.file, options);
  assert.equal(changed.tasks.a.attempt, 2);
  assert.equal(changed.tasks.b.attempt, 2);
  assert.equal(changed.tasks.c.attempt, 1);
  fs.writeFileSync(path.join(p.dir, "a.txt"), "corrupted");
  assert.equal(readBatchStatus(p.file, options).ok, false);
  const repaired = await runBatch(p.file, options);
  assert.equal(repaired.tasks.a.attempt, 3);
  assert.equal(fs.readFileSync(path.join(p.dir, "a.txt"), "utf8"), "second");
  assert.equal(readBatchStatus(p.file, options).ok, true);
});

test("preexisting files and exit zero without declared artifacts never imply success", async t => {
  const p = fixture(t, [task("a", "process.exit(5)"), task("missing", "process.exit(0)")]);
  fs.writeFileSync(path.join(p.dir, "a.txt"), "stale");
  const result = await runBatch(p.file, options);
  assert.equal(result.tasks.a.status, "failed");
  assert.equal(result.tasks.missing.status, "failed");
  assert.match(result.tasks.missing.error, /ENOENT/);
});

test("dry run is read only; live lock prevents concurrent schedulers", async t => {
  const p = fixture(t, [task("slow", "setTimeout(()=>require('fs').writeFileSync('slow.txt','ok'), 200)")]);
  const plan = await runBatch(p.file, { ...options, dryRun: true });
  assert.equal(plan.tasks[0].status, "pending");
  assert.equal(fs.existsSync(path.join(p.dir, ".motion-use")), false);
  const active = runBatch(p.file, options);
  await assert.rejects(runBatch(p.file, options), /owns this output/);
  assert.equal((await active).ok, true);
});

test("input mutation during processing fails the task and cancels descendants", async t => {
  const p = fixture(t, [task("a", "const fs=require('fs'); fs.writeFileSync('input.txt','changed'); fs.writeFileSync('a.txt','ok')", { inputs: ["input.txt"] }), task("b", write("b"), { dependsOn: ["a"] })]);
  fs.writeFileSync(path.join(p.dir, "input.txt"), "original");
  const result = await runBatch(p.file, options);
  assert.equal(result.ok, false);
  assert.match(result.tasks.a.error, /inputs changed/);
  assert.equal(result.tasks.b.status, "blocked");
});

test("estimated disk reservations prevent oversubscription before spawning", async t => {
  const p = fixture(t, [task("a", write("a"), { estimatedBytes: Number.MAX_SAFE_INTEGER })]);
  const result = await runBatch(p.file, options);
  assert.match(result.tasks.a.error, /disk space/);
  assert.equal(fs.existsSync(path.join(p.dir, "a.txt")), false);
});

test("aborted runs persist cancelled state and do not launch pending work", async t => {
  const p = fixture(t, [task("a", "setTimeout(()=>{},5000)"), task("b", write("b"))]);
  const controller = new AbortController();
  const active = runBatch(p.file, { ...options, signal: controller.signal });
  setTimeout(() => controller.abort(), 40);
  const result = await active;
  assert.equal(result.ok, false);
  assert.equal(result.tasks.a.status, "cancelled");
  assert.equal(result.tasks.b.status, "cancelled");
});

test("directory hash is stable across mtimes and changes with bytes; symlinks are refused", t => {
  const p = fixture(t, [task("a", write("a"))]);
  const target = path.join(p.dir, "input");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "a"), "one");
  const before = hashBatchPath(target).hash;
  fs.utimesSync(path.join(target, "a"), new Date(0), new Date(0));
  assert.equal(hashBatchPath(target).hash, before);
  fs.writeFileSync(path.join(target, "a"), "two");
  assert.notEqual(hashBatchPath(target).hash, before);
  fs.symlinkSync("a", path.join(target, "link"));
  assert.throws(() => hashBatchPath(target), /symlinks/);
});

test("journal persists bounded metadata and reports overlap and unknown measurements honestly", t => {
  const p = fixture(t, [task("a", write("a"))]);
  const file = path.join(p.dir, "events.jsonl");
  let now = 1000;
  const emit = createJournal(file, { run: "test" }, () => now);
  emit("batch", "started", { script: "must not persist" });
  now = 2000;
  emit("render", "finished", { duration_s: 2, status: "success", output_seconds: 10 });
  emit("asr", "finished", { duration_s: 2, status: "success" });
  now = 3000;
  emit("render", "cached", { cache_hit: true });
  fs.appendFileSync(file, "{incomplete");
  const result = aggregateJournal(file);
  assert.equal(result.wall_elapsed_s, 2);
  assert.equal(result.active_processing_s, 2);
  assert.equal(result.processing_sum_s, 4);
  assert.equal(result.phase_seconds.render, 2);
  assert.equal(result.waiting_s, null);
  assert.equal(result.cost, null);
  assert.equal(result.output_video_seconds, 10);
  assert.equal(result.cache_hits, 1);
  assert.equal(result.warnings.length, 1);
  assert.ok(!fs.readFileSync(file, "utf8").includes("must not persist"));
});

test("journal command wrappers do not double count nested phases or overlapping runs", t => {
  const p = fixture(t, [task("a", write("a"))]);
  const file = path.join(p.dir, "journal.jsonl");
  let now = 10000;
  const a = createJournal(file, { run: "a" }, () => now);
  const b = createJournal(file, { run: "b" }, () => now);
  a("command", "started");
  a("tts", "started");
  now = 11000;
  b("command", "started");
  now = 12000;
  a("tts", "finished");
  now = 13000;
  a("command", "finished");
  b("command", "finished");
  const result = aggregateJournal(file);
  assert.equal(result.wall_elapsed_s, 3);
  assert.equal(result.active_processing_s, 3);
  assert.equal(result.processing_sum_s, 5);
  assert.equal(result.phase_seconds.tts, 2);
});

test("same-filesystem estimates queue safely", async t => {
  const source = id => `const fs=require('fs'); if(fs.existsSync('running')) process.exit(2); fs.writeFileSync('running','1'); setTimeout(()=>{fs.unlinkSync('running');fs.writeFileSync('${id}.txt','ok')},50)`;
  const p = fixture(t, [task("a", source("a"), { estimatedBytes: 60 }), task("b", source("b"), { estimatedBytes: 60 })]);
  const result = await runBatch(p.file, { ...options, concurrency: 2, space: () => ({ available_bytes: 100, filesystem: "shared" }) });
  assert.equal(result.ok, true);
  const plan = planBatch(p.file, options);
  assert.equal(plan.tasks[0].storage.status, "estimated");
  const unknown = fixture(t, [task("a", write("a"))]);
  assert.equal(planBatch(unknown.file, options).tasks[0].storage.status, "unknown");
});

test("different filesystem reservations do not serialize independent tasks", async t => {
  const source = (id, other) => `const fs=require('fs');fs.writeFileSync('ready','1');let tries=0;const timer=setInterval(()=>{if(fs.existsSync('../${other}/ready')){clearInterval(timer);fs.writeFileSync('${id}.txt','ok')}else if(++tries>50){clearInterval(timer);process.exit(2)}},10)`;
  const p = fixture(t, [task("a", source("a", "right"), { cwd: "left", estimatedBytes: 60 }), task("b", source("b", "left"), { cwd: "right", estimatedBytes: 60 })]);
  fs.mkdirSync(path.join(p.dir, "left"));
  fs.mkdirSync(path.join(p.dir, "right"));
  const result = await runBatch(p.file, { ...options, concurrency: 2, space: target => ({ available_bytes: 100, filesystem: path.basename(target) }) });
  assert.equal(result.ok, true);
});

test("render storage estimates expose assumptions without pretending to be measured peaks", t => {
  const p = fixture(t, [task("a", write("a"), { storage: { width: 100, height: 100, fps: 2, duration: 2, streaming: false, reserveBytes: 0 } })]);
  const storage = planBatch(p.file, options).tasks[0].storage;
  assert.equal(storage.status, "estimated");
  assert.ok(storage.estimate.intermediate_bytes > 0);
  assert.equal(storage.requiredBytes, storage.estimate.required_available_bytes);
});

test("batch subprocess journaling is outside declared source inputs and linked to its parent run", async t => {
  const journalModule = new URL("../src/journal.mjs", import.meta.url).href;
  const source = `import fs from 'node:fs';import {createJournal} from ${JSON.stringify(journalModule)};const emit=createJournal(process.env.MOTION_USE_JOURNAL_FILE);emit('command','started');fs.writeFileSync('a.txt','ok');emit('command','finished');`;
  const p = fixture(t, [task("a", source, { command: ["--input-type=module", "-e", source], inputs: ["."] })]);
  const result = await runBatch(p.file, options);
  assert.equal(result.ok, true);
  assert.equal(planBatch(p.file, options).tasks[0].status, "cached");
  const file = path.join(path.dirname(result.stateFile), "events.jsonl");
  const summary = aggregateJournal(file);
  assert.equal(summary.processing_sum_s, result.tasks.a.duration_s);
  const rows = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(rows.find(r => r.phase === "command").parent_run);
});
