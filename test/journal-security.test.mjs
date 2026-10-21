import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createJournal } from "../src/journal.mjs";
import { planBatch, runBatch } from "../src/batch.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mu-journal-safe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const external = path.join(dir, "authored.txt");
  fs.writeFileSync(external, "preserve me");
  return { dir, external };
}

test("an authored input nested in an output cannot be silently excluded from its fingerprint", t => {
  const { dir } = fixture(t), file = path.join(dir, "tasks.json");
  fs.mkdirSync(path.join(dir, "tree"));
  fs.writeFileSync(path.join(dir, "tree", "source.txt"), "original");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, tasks: [{ id: "safe", command: ["render"], inputs: ["tree/source.txt"], outputs: ["tree"] }] }));
  assert.throws(() => planBatch(file), /input cannot.*inside its output/);
});

for (const kind of ["symlink", "hardlink"]) {
  const link = (source, target) => kind === "symlink" ? fs.symlinkSync(source, target) : fs.linkSync(source, target);
  test(`journal refuses ${kind} targets before appending`, t => {
    const { dir, external } = fixture(t), journal = path.join(dir, "events.jsonl");
    link(external, journal);
    assert.throws(() => createJournal(journal)("command", "started"), /ELOOP|single-link|symbolic link/i);
    assert.equal(fs.readFileSync(external, "utf8"), "preserve me");
  });

  test(`batch log refuses ${kind} targets before truncation`, async t => {
    const { dir, external } = fixture(t), file = path.join(dir, "tasks.json");
    const source = "require('fs').writeFileSync('output.txt','ok')";
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, tasks: [{ id: "safe", executable: process.execPath, command: ["-e", source], inputs: ["authored.txt"], outputs: ["output.txt"] }] }));
    const stateFile = planBatch(file, { allowExec: true }).stateFile;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    link(external, path.join(path.dirname(stateFile), "safe.log"));
    const result = await runBatch(file, { allowExec: true });
    assert.equal(result.ok, false);
    assert.equal(result.tasks.safe.status, "failed");
    assert.equal(fs.readFileSync(external, "utf8"), "preserve me");
    assert.equal(fs.existsSync(path.join(dir, "output.txt")), false);
  });
}
