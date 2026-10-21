import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { storagePreflight, planCacheCleanup, applyCacheCleanup, validateCacheCleanup } from "../src/storage.mjs";
import { acquireOutputLock } from "../src/output-lock.mjs";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mu-storage-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const out = path.join(root, "out"), cacheHome = path.join(root, "cache");
  const sampleDir = path.join(cacheHome, "motion-use", "samples");
  const engine = path.join(out, ".build", "lesson-zh-landscape-engine");
  fs.mkdirSync(path.join(engine, "frames"), { recursive: true });
  fs.mkdirSync(sampleDir, { recursive: true });
  fs.writeFileSync(path.join(engine, ".motion-use-build"), "created by motion-use; safe to delete\n");
  const sample = path.join(sampleDir, `${"a".repeat(40)}.f32`), frame = path.join(engine, "frames", "00001.png");
  fs.writeFileSync(sample, "rebuild decoded sample"); fs.writeFileSync(frame, "rebuild frame");
  return { root, out, cacheHome, engine, sampleDir, sample, frame };
}

test("storage preview is read-only and apply preserves original, review and final files", (t) => {
  const f = fixture(t);
  const protectedFiles = [path.join(f.out, "final.mp4"), path.join(f.out, "review.json"), path.join(f.engine, "frames", "source.png"), path.join(f.sampleDir, "original.wav")];
  for (const file of protectedFiles) fs.writeFileSync(file, "keep");
  const p = planCacheCleanup(f);
  assert.equal(p.files.length, 2);
  assert.ok(fs.existsSync(f.frame)); assert.ok(fs.existsSync(f.sample));
  assert.ok(p.logical_bytes > 0);
  const r = applyCacheCleanup(p, f);
  assert.equal(r.ok, true); assert.equal(r.removed.length, 2);
  assert.equal(r.deleted_logical_bytes, p.logical_bytes);
  assert.equal(r.observations.length, 2);
  assert.ok(r.observations.every((o) => Number.isFinite(o.available_delta_bytes)));
  for (const file of protectedFiles) assert.equal(fs.readFileSync(file, "utf8"), "keep");
  assert.ok(fs.existsSync(path.join(f.engine, ".motion-use-build")));
});

test("one changed cache entry aborts the entire frozen plan before deletion", (t) => {
  const f = fixture(t), p = planCacheCleanup(f);
  fs.writeFileSync(f.frame, "changed while reviewing");
  assert.throws(() => applyCacheCleanup(p, f), /changed since plan/);
  assert.ok(fs.existsSync(f.sample)); assert.ok(fs.existsSync(f.frame));
  assert.equal(fs.existsSync(path.join(f.out, ".motion-use.lock")), false);
});

test("plan tampering, changed roots, missing ownership and active output lock block cleanup", (t) => {
  const f = fixture(t), p = planCacheCleanup(f);
  assert.throws(() => applyCacheCleanup({ ...p, files: [] }, f), /hash\/schema/);
  assert.throws(() => applyCacheCleanup(p, { ...f, out: f.root }), /roots differ/);
  const release = acquireOutputLock(f.out);
  assert.throws(() => applyCacheCleanup(p, f), /another job owns/); release();
  fs.writeFileSync(path.join(f.engine, ".motion-use-build"), "not owned");
  assert.throws(() => applyCacheCleanup(p, f), /not an owned/);
  assert.ok(fs.existsSync(f.sample));
});

test("symlink or hardlink substitutions are never followed or removed", (t) => {
  const f = fixture(t), p = planCacheCleanup(f);
  const source = path.join(f.root, "original.wav"); fs.writeFileSync(source, "precious");
  fs.unlinkSync(f.sample); fs.symlinkSync(source, f.sample);
  assert.throws(() => applyCacheCleanup(p, f), /symlink/);
  const q = planCacheCleanup(f);
  assert.equal(q.files.length, 1); assert.match(q.skipped[0].reason, /symlink/);
  fs.unlinkSync(f.sample); fs.linkSync(source, f.sample);
  const r = planCacheCleanup(f);
  assert.equal(r.files.length, 1); assert.match(r.skipped[0].reason, /single-link/);
  assert.equal(fs.readFileSync(source, "utf8"), "precious");
});

test("new files after the preview remain untouched", (t) => {
  const f = fixture(t), p = planCacheCleanup(f);
  const newer = path.join(f.engine, "frames", "00002.png"); fs.writeFileSync(newer, "new");
  applyCacheCleanup(p, f);
  assert.equal(fs.readFileSync(newer, "utf8"), "new");
});

test("streaming budget, concurrent reservations and inadequate space are explicit estimates", (t) => {
  const f = fixture(t), options = { path: f.out, duration: 60, width: 1920, height: 1080, fps: 30 };
  const stream = storagePreflight(options), sequence = storagePreflight({ ...options, streaming: false });
  assert.equal(stream.estimate.estimated, true);
  assert.equal(stream.estimate.intermediate_bytes, 0);
  assert.ok(sequence.estimate.intermediate_bytes > 1920 * 1080 * 4 * 1800);
  const concurrent = storagePreflight({ ...options, concurrency: 2, reservedBytes: 123 });
  assert.equal(concurrent.estimate.reserved_other_jobs_bytes, 123);
  assert.ok(concurrent.estimate.required_available_bytes > stream.estimate.required_available_bytes);
  assert.equal(storagePreflight({ ...options, reservedBytes: stream.disk.total_bytes * 2 }).status, "WARN");
  assert.throws(() => storagePreflight({ ...options, fps: -1 }), /positive/);
});

test("cleanup dry-run fully validates without deleting files and releases the output lock", (t) => {
  const f = fixture(t), p = planCacheCleanup(f);
  const bytes = p.files.map(e => fs.readFileSync(e.file));
  const r = validateCacheCleanup(p, f);
  assert.equal(r.ok, true); assert.equal(r.status, "VALIDATED");
  assert.equal(r.applied, false); assert.equal(r.dry_run, true);
  assert.equal(r.checked, p.files.length); assert.deepEqual(r.removed, []);
  assert.equal(r.deleted_logical_bytes, 0);
  p.files.forEach((e,i) => assert.deepEqual(fs.readFileSync(e.file), bytes[i]));
  assert.equal(fs.existsSync(path.join(f.out,".motion-use.lock")),false);
  assert.equal(applyCacheCleanup(p, {...f,dryRun:true}).status,"VALIDATED");
});

test("cleanup dry-run rejects invalid, stale, changed-root and actively locked plans", (t) => {
  const f = fixture(t), p = planCacheCleanup(f);
  assert.throws(() => validateCacheCleanup({}, f), /hash\/schema/);
  assert.throws(() => validateCacheCleanup({...p,files:[]}, f), /hash\/schema/);
  assert.throws(() => validateCacheCleanup(p, {...f,out:f.root}), /roots differ/);
  const release = acquireOutputLock(f.out);
  assert.throws(() => validateCacheCleanup(p,f), /another job owns/);
  release();
  fs.writeFileSync(f.sample,"changed after preview");
  assert.throws(() => validateCacheCleanup(p,f), /changed since plan/);
  assert.ok(fs.existsSync(f.frame)); assert.ok(fs.existsSync(f.sample));
  assert.equal(fs.existsSync(path.join(f.out,".motion-use.lock")),false);
});

test("cleanup dry-run rejects lost ownership and symlink substitution", (t) => {
  const f = fixture(t), p = planCacheCleanup(f);
  fs.writeFileSync(path.join(f.engine,".motion-use-build"),"not owned");
  assert.throws(() => validateCacheCleanup(p,f), /not an owned/);
  fs.writeFileSync(path.join(f.engine,".motion-use-build"),"created by motion-use; safe to delete\n");
  const original = path.join(f.root,"original.wav"); fs.writeFileSync(original,"keep");
  fs.unlinkSync(f.sample); fs.symlinkSync(original,f.sample);
  assert.throws(() => validateCacheCleanup(p,f), /symlink/);
  assert.equal(fs.readFileSync(original,"utf8"),"keep");
  assert.ok(fs.existsSync(f.frame));
});
