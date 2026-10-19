import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { initFilm } from "../src/film.mjs";

const entry = fileURLToPath(new URL("../bin/motion-use.mjs", import.meta.url));
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mu-operations-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  initFilm({ lang: "zh", format: "landscape" }, dir);
  const file = path.join(dir, "film.json"), data = JSON.parse(fs.readFileSync(file));
  Object.assign(data, { duration: 2, fps: 30, music: "none", voiceover: false, shots: [{ id: "a", start: 0, end: 2, purpose: "count", action: "move dots" }] });
  fs.writeFileSync(file, JSON.stringify(data));
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [entry, ...args, "--json"], {
      cwd: dir, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, MOTION_USE_NO_UPDATE_CHECK: "1", MOTION_USE_ASR: "off", MOTION_USE_JOURNAL_FILE: "", MOTION_USE_JOURNAL_PARENT_RUN: "" },
    });
    assert.ifError(r.error);
    let json;
    try { json = JSON.parse(r.stdout); } catch { assert.fail(`CLI must emit one JSON document: ${r.stdout}\n${r.stderr}`); }
    return { ...r, json };
  };
  return { dir, file, data, cli, save: () => fs.writeFileSync(file, JSON.stringify(data)) };
}

test("CLI preflight observes the target filesystem and marks render space as estimated", t => {
  const { dir, cli } = fixture(t), out = path.join(dir, "out", "not-created");
  const r = cli("preflight", dir, "--out", out, "--renderer", "chrome");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(out), false, "preflight must not create render outputs");
  assert.equal(r.json.estimates.length, 1);
  const { disk, estimate } = r.json.estimates[0];
  assert.equal(disk.path, out);
  assert.ok(Number.isFinite(Date.parse(disk.measured_at)));
  assert.ok(disk.total_bytes > 0 && disk.available_bytes >= 0 && disk.available_bytes <= disk.total_bytes);
  const live = fs.statfsSync(dir);
  assert.equal(disk.total_bytes, live.blocks * live.bsize);
  assert.ok(Math.abs(disk.available_bytes - live.bavail * live.bsize) < 256 * 1024 ** 2, "allow concurrent filesystem activity");
  assert.equal(estimate.estimated, true);
  assert.equal(estimate.frames, 60);
  assert.equal(estimate.streaming, false);
  assert.ok(estimate.required_available_bytes > estimate.intermediate_bytes);
  assert.ok(estimate.assumptions.length > 0);
});

test("CLI frozen cleanup preview, dry-run and rejected stale/tampered plans never delete source or cache bytes", t => {
  const { dir, cli } = fixture(t), out = path.join(dir, "out"), cache = path.join(dir, "cache");
  const frames = path.join(out, ".build", "lesson-engine", "frames");
  const samples = path.join(cache, "motion-use", "samples");
  fs.mkdirSync(frames, { recursive: true }); fs.mkdirSync(samples, { recursive: true });
  fs.writeFileSync(path.join(frames, "..", ".motion-use-build"), "created by motion-use; safe to delete\n");
  const frame = path.join(frames, "00001.png"), sample = path.join(samples, `${"a".repeat(40)}.f32`), source = path.join(out, "final.mp4");
  fs.writeFileSync(frame, "frame cache"); fs.writeFileSync(sample, "sample cache"); fs.writeFileSync(source, "final output");
  const manifest = path.join(dir, "cleanup-plan.json"), roots = ["--out", out, "--cache-home", cache];
  const planned = cli("clean", "plan", dir, ...roots, "--manifest", manifest);
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  assert.equal(planned.json.files.length, 2);
  assert.equal(fs.readFileSync(frame, "utf8"), "frame cache");
  const bytes = fs.readFileSync(manifest), dry = cli("clean", "apply", manifest, ...roots, "--dry-run");
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  assert.equal(dry.json.status, "VALIDATED");
  assert.equal(dry.json.applied, false);
  assert.equal(dry.json.deleted_logical_bytes, 0);
  assert.deepEqual(dry.json.removed, []);
  assert.equal(fs.readFileSync(sample, "utf8"), "sample cache");
  const tampered = JSON.parse(bytes); tampered.files = [];
  fs.writeFileSync(manifest, JSON.stringify(tampered));
  const invalid = cli("clean", "apply", manifest, ...roots, "--dry-run");
  assert.equal(invalid.status, 1); assert.match(invalid.json.error, /hash|schema/);
  fs.writeFileSync(manifest, bytes);
  fs.writeFileSync(frame, "changed since plan");
  const stale = cli("clean", "apply", manifest, ...roots, "--dry-run");
  assert.equal(stale.status, 1); assert.match(stale.json.error, /changed since plan/);
  assert.equal(fs.readFileSync(frame, "utf8"), "changed since plan");
  assert.equal(fs.readFileSync(sample, "utf8"), "sample cache");
  assert.equal(fs.readFileSync(source, "utf8"), "final output");
  assert.equal(fs.existsSync(path.join(out, ".motion-use.lock")), false);
});

test("CLI teaching binds sampled frames to authored inputs and rejects missing frame evidence", t => {
  const { dir, data, save, cli } = fixture(t);
  data.teaching = { assertions: [{ id: "removed", type: "state", from: 1, to: 2, object: "dot", expected: { removed: true } }] };
  save();
  const planned = cli("teaching", dir, "--plan");
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  assert.equal(planned.json.status, "UNREVIEWED");
  assert.ok(planned.json.sample_plan.includes(29 / 30), "plan includes the pre-transition frame");
  const stateFile = path.join(dir, "states.json");
  const rows = planned.json.sample_plan.map(time => ({ time, objects: [{ id: "dot", visible: true, state: { removed: time >= 1 } }] }));
  const write = samples => fs.writeFileSync(stateFile, JSON.stringify({ inputs: planned.json.inputs, samples }));
  write(rows);
  const passed = cli("teaching", dir, "--states", "states.json");
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.equal(passed.json.status, "PASS");
  assert.equal(passed.json.evidence, "author-declared-state");
  assert.equal(passed.json.visualReview, "UNREVIEWED");
  write(rows.filter(row => row.time !== 29 / 30));
  const missing = cli("teaching", dir, "--states", "states.json");
  assert.equal(missing.status, 1, missing.stdout + missing.stderr);
  assert.equal(missing.json.status, "FAIL");
  assert.equal(missing.json.sampleCompleteness.status, "FAIL");
  write(rows);
  fs.appendFileSync(path.join(dir, "composition", "draw.js"), "\n// drawing changed after sampling\n");
  const changed = cli("teaching", dir, "--states", "states.json");
  assert.equal(changed.status, 1); assert.match(changed.json.error, /binding missing or stale/);
});

test("CLI validate and voiceover checks persist measured command timing without inventing waiting, cost or output", t => {
  const { dir, cli } = fixture(t);
  const validated = cli("validate", dir);
  assert.equal(validated.status, 0, validated.stdout + validated.stderr);
  const checked = cli("voiceover", "check", dir);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.equal(checked.json.status, "SKIPPED", "fixture has no narration; it must not claim ASR passed");
  const journal = path.join(dir, ".motion-use", "events.jsonl");
  const rows = fs.readFileSync(journal, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.filter(row => row.phase === "command" && row.event === "finished").length, 2);
  assert.equal(new Set(rows.map(row => row.run)).size, 2);
  const stats = cli("stats", dir);
  assert.equal(stats.status, 0, stats.stdout + stats.stderr);
  assert.ok(stats.json.wall_elapsed_s > 0);
  assert.ok(stats.json.active_processing_s > 0);
  assert.ok(stats.json.processing_sum_s >= stats.json.active_processing_s - .002);
  assert.ok(stats.json.wall_elapsed_s >= stats.json.active_processing_s - .002);
  assert.ok(Number.isFinite(stats.json.phase_seconds.asr));
  assert.equal(stats.json.waiting_s, null);
  assert.equal(stats.json.cost, null);
  assert.equal(stats.json.output_video_seconds, null);
  assert.deepEqual(stats.json.warnings, []);
  assert.equal(rows.some(row => "argv" in row || "script" in row), false);
});

test("CLI delivery --check without a package path fails with usage", t => {
  const { cli } = fixture(t);
  const r = cli("delivery", "--check");
  assert.equal(r.status, 1);
  assert.equal(r.json.ok, false);
  assert.match(r.json.error, /delivery --check --out/);
});

test("CLI stats locates a batch journal without executing tasks or hashing removed outputs", t => {
  const {dir,cli}=fixture(t);
  fs.writeFileSync(path.join(dir,'input.txt'),'source');
  fs.writeFileSync(path.join(dir,'tasks.json'),JSON.stringify({schemaVersion:1,tasks:[{id:'prepare',executable:process.execPath,command:['-e',"require('fs').writeFileSync('output.txt','generated')"],inputs:['input.txt'],outputs:['output.txt']}]}));
  const run=cli('batch','run','tasks.json','--allow-exec'); assert.equal(run.status,0,run.stdout+run.stderr);
  fs.unlinkSync(path.join(dir,'output.txt'));
  const stats=cli('stats','tasks.json'); assert.equal(stats.status,0,stats.stdout+stats.stderr);
  assert.match(stats.json.file,/events.jsonl$/);
  assert.ok(stats.json.active_processing_s>=0);
  assert.equal(stats.json.waiting_s,null); assert.equal(stats.json.cost,null);
  assert.equal(fs.existsSync(path.join(dir,'output.txt')),false,'stats must not re-execute a missing-output task');
});
