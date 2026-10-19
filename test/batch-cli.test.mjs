import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(new URL("../bin/motion-use.mjs", import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`batch CLI ${signal} persists cancellation and stops detached task writes`, { skip: process.platform === "win32", timeout: 15000 }, async t => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mu-batch-cli-")));
    const ready = path.join(dir, "ready.json"), late = path.join(dir, "late.txt");
    let workerPid, scheduler;
    t.after(() => {
      if (scheduler && scheduler.exitCode === null && scheduler.signalCode === null) scheduler.kill("SIGKILL");
      if (workerPid) { try { process.kill(-workerPid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; } }
      fs.rmSync(dir, { recursive: true, force: true });
    });
    fs.writeFileSync(path.join(dir, "source.txt"), "unchanged project input");
    const source = "const fs=require('fs'); fs.writeFileSync('ready.json',JSON.stringify({pid:process.pid})); setTimeout(()=>fs.writeFileSync('late.txt','orphan task still running'),1500)";
    const manifest = path.join(dir, "tasks.json");
    fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, tasks: [{ id: "slow", executable: process.execPath, command: ["-e", source], inputs: ["source.txt"], outputs: ["late.txt"] }] }));
    scheduler = spawn(process.execPath, [cli, "batch", "run", manifest, "--allow-exec", "--json"], {
      cwd: dir, env: { ...process.env, MOTION_USE_NO_UPDATE_CHECK: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    scheduler.stdout.on("data", b => { stdout += b; }); scheduler.stderr.on("data", b => { stderr += b; });
    const closed = new Promise((resolve, reject) => { scheduler.once("error", reject); scheduler.once("close", (code, termination) => resolve({ code, termination })); });
    const deadline = Date.now() + 6000;
    while (!fs.existsSync(ready) && Date.now() < deadline && scheduler.exitCode === null && scheduler.signalCode === null) await delay(25);
    assert.ok(fs.existsSync(ready), `task did not start: ${stdout}\n${stderr}`);
    workerPid = JSON.parse(fs.readFileSync(ready, "utf8")).pid;
    assert.ok(Number.isInteger(workerPid) && workerPid > 0);
    scheduler.kill(signal);
    const exit = await closed;
    assert.notEqual(exit.code, 0, `${signal} must not report success`);
    assert.equal(exit.termination, null, "CLI must handle the signal and persist cancellation");
    const report = JSON.parse(stdout);
    assert.equal(report.ok, false);
    assert.equal(report.status, "cancelled");
    assert.equal(report.tasks.slow.status, "cancelled");
    const state = JSON.parse(fs.readFileSync(report.stateFile, "utf8"));
    assert.equal(state.status, "cancelled");
    assert.equal(state.tasks.slow.status, "cancelled");
    assert.equal(fs.existsSync(path.join(path.dirname(report.stateFile), ".motion-use.lock")), false);
    await delay(1700);
    assert.equal(fs.existsSync(late), false, "cancelled detached child must not finish after the scheduler exits");
    assert.equal(fs.readFileSync(path.join(dir, "source.txt"), "utf8"), "unchanged project input");
  });
}
