import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { acquireOutputLock, releaseCancelledOutputLock } from "./output-lock.mjs";
import { createJournal } from "./journal.mjs";
import { diskSpace, storagePreflight } from "./storage.mjs";

const cli = fileURLToPath(new URL("../bin/motion-use.mjs", import.meta.url));
const sourceDir = fileURLToPath(new URL("./", import.meta.url));
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const contains = (a, b) => a === b || b.startsWith(a + path.sep);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
function physicalPath(file) {
  const missing = [];
  let existing = path.resolve(file);
  while (!fs.existsSync(existing)) { missing.unshift(path.basename(existing)); existing = path.dirname(existing); }
  // Preserve a declared symlink leaf so the hashing/validation code rejects it.
  if (fs.lstatSync(existing).isSymbolicLink()) return path.join(fs.realpathSync(path.dirname(existing)), path.basename(existing), ...missing);
  return path.join(fs.realpathSync(existing), ...missing);
}

// Hash content and relative names, never mtimes. Refuse symlinks rather than hide
// dependencies outside the declared input tree or recurse through link cycles.
export function hashBatchPath(target, excludes = [], { ignoreOperational = false } = {}) {
  const hash = crypto.createHash("sha256");
  let files = 0;
  const operational = file => {
    if (!ignoreOperational) return false;
    const name = path.basename(file), parent = path.basename(path.dirname(file));
    // Recognition evidence is derived from declared audio/script inputs. Keep
    // .motion-use-voiceover.json: it binds audio to the authored narration.
    if (/^\.motion-use-asr\.json(?:\.lock|\.tmp|\.[0-9a-f-]{36}\.tmp)?$/i.test(name)) return true;
    return parent === ".motion-use" && ["events.jsonl", "batch", "review"].includes(name);
  };
  function walk(file, relative) {
    if (excludes.some(ex => contains(ex, file)) || operational(file)) return;
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`batch paths must not contain symlinks: ${file}`);
    // Creating the default journal must not introduce an otherwise empty
    // metadata directory into a source fingerprint.
    if (ignoreOperational && stat.isDirectory() && path.basename(file) === ".motion-use" && fs.readdirSync(file).every(name => operational(path.join(file, name)) || excludes.some(ex => contains(ex, path.join(file, name))))) return;
    hash.update(JSON.stringify([relative, stat.isDirectory() ? "directory" : "file"]));
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) walk(path.join(file, name), path.join(relative, name));
    else if (stat.isFile()) {
      files++;
      const fd = fs.openSync(file, "r"), buf = Buffer.alloc(1024 * 1024);
      try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null))) hash.update(buf.subarray(0, n)); }
      finally { fs.closeSync(fd); }
      hash.update(`\0size:${stat.size}\0`);
    } else throw new Error(`unsupported batch path: ${file}`);
  }
  walk(path.resolve(target), "");
  return { hash: hash.digest("hex"), files };
}

function load(manifestPath, options = {}) {
  const file = fs.realpathSync(path.resolve(manifestPath)), base = path.dirname(file);
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.tasks) || !manifest.tasks.length) throw new Error("batch manifest requires schemaVersion: 1 and nonempty tasks");
  const stateFile = physicalPath(options.stateFile ?? path.join(base, ".motion-use", "batch", `${path.basename(file)}-${sha(file).slice(0, 12)}`, "state.json"));
  if (fs.existsSync(stateFile) && fs.lstatSync(stateFile).isSymbolicLink()) throw new Error("batch state must not be a symlink");
  const tasks = manifest.tasks.map(task => {
    if (!task || typeof task !== "object" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(task.id ?? "")) throw new Error("each batch task requires a safe unique id");
    if (!Array.isArray(task.command) || !task.command.length || !task.command.every(x => typeof x === "string")) throw new Error(`task ${task.id}: command must be a nonempty argv array`);
    if (task.executable !== undefined && (typeof task.executable !== "string" || !task.executable || !options.allowExec)) throw new Error(`task ${task.id}: executable requires explicit allowExec authorization`);
    for (const key of ["inputs", "outputs", "dependsOn"]) if (task[key] !== undefined && (!Array.isArray(task[key]) || !task[key].every(x => typeof x === "string" && x.length))) throw new Error(`task ${task.id}: ${key} must be an array of nonempty strings`);
    if (!task.inputs?.length) throw new Error(`task ${task.id}: declare at least one input; include all project source, audio and configuration dependencies for verified resume`);
    if (!task.outputs?.length) throw new Error(`task ${task.id}: declare at least one output for verified resume`);
    const cwd = fs.realpathSync(path.resolve(base, task.cwd ?? "."));
    if (!fs.statSync(cwd).isDirectory()) throw new Error(`task ${task.id}: cwd must be a directory`);
    const result = { ...task, cwd, dependsOn: task.dependsOn ?? [], inputs: task.inputs.map(p => physicalPath(path.resolve(cwd, p))), outputs: task.outputs.map(p => physicalPath(path.resolve(cwd, p))) };
    if (result.outputs.some(p => fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink())) throw new Error(`task ${task.id}: output must not be a symlink`);
    if (result.outputs.some(p => contains(p, stateFile) || contains(path.dirname(stateFile), p))) throw new Error(`task ${task.id}: output overlaps batch state`);
    if (result.inputs.some(input => result.outputs.some(output => contains(output, input)))) throw new Error(`task ${task.id}: input cannot be the same path as or inside its output`);
    if (task.estimatedBytes !== undefined && (!Number.isSafeInteger(task.estimatedBytes) || task.estimatedBytes < 0)) throw new Error(`task ${task.id}: estimatedBytes must be a nonnegative safe integer`);
    if (task.storage !== undefined && (!task.storage || typeof task.storage !== "object" || Array.isArray(task.storage))) throw new Error(`task ${task.id}: storage must be an object`);
    if (task.storage && task.estimatedBytes !== undefined) throw new Error(`task ${task.id}: use storage or estimatedBytes, not both`);
    if (task.phase !== undefined && (typeof task.phase !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(task.phase))) throw new Error(`task ${task.id}: phase must be a short operational identifier`);
    return result;
  });
  const byId = new Map(tasks.map(t => [t.id, t]));
  if (byId.size !== tasks.length) throw new Error("duplicate batch task id");
  const done = new Set(), visiting = new Set(), ordered = [];
  function visit(t) {
    if (visiting.has(t.id)) throw new Error(`batch dependency cycle: ${t.id}`);
    if (done.has(t.id)) return;
    visiting.add(t.id);
    for (const id of t.dependsOn) { if (!byId.has(id)) throw new Error(`unknown dependency ${id}`); visit(byId.get(id)); }
    visiting.delete(t.id); done.add(t.id); ordered.push(t);
  }
  tasks.forEach(visit);
  const all = tasks.flatMap(t => t.outputs.map(output => ({ id: t.id, output })));
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++)
    if (contains(all[i].output, all[j].output) || contains(all[j].output, all[i].output)) throw new Error(`overlapping batch outputs: ${all[i].id} and ${all[j].id}`);
  // Consuming another task's output requires an explicit dependency path.
  const ancestors = id => { const result = new Set(); const walk = x => { for (const dep of byId.get(x).dependsOn) if (!result.has(dep)) { result.add(dep); walk(dep); } }; walk(id); return result; };
  for (const t of tasks) for (const input of t.inputs) for (const output of all)
    if (output.id !== t.id && (contains(input, output.output) || contains(output.output, input)) && !ancestors(t.id).has(output.id)) throw new Error(`task ${t.id}: input overlaps ${output.id} output without dependency`);
  const runtimeFingerprint = sha(JSON.stringify([hashBatchPath(cli).hash, hashBatchPath(sourceDir).hash, hashBatchPath(path.join(sourceDir, "../package.json")).hash]));
  return { file, stateFile, tasks: ordered, manifest, runtimeFingerprint };
}

function storageBudget(task, options) {
  if (!task.storage && task.estimatedBytes === undefined) return { status: "unknown", requiredBytes: null };
  const target = path.resolve(task.cwd, task.storage?.path ?? ".");
  let existing = target;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const disk = (options.space ?? diskSpace)(target);
  const preflight = task.storage ? storagePreflight({ ...task.storage, path: target, concurrency: 1, reservedBytes: 0 }) : null;
  return {
    status: "estimated", estimated: true,
    requiredBytes: preflight?.estimate.required_available_bytes ?? task.estimatedBytes,
    availableBytes: disk.available_bytes,
    filesystem: disk.filesystem ?? fs.statSync(existing).dev,
    estimate: preflight?.estimate ?? { estimated: true, source: "manifest estimatedBytes" },
  };
}

function readState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (state.schemaVersion !== 1 || !state.tasks) throw new Error("unsupported batch state");
    return state;
  } catch (e) { if (e.code === "ENOENT") return { schemaVersion: 1, tasks: {} }; throw e; }
}
function save(file, state) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
function outputs(task) {
  return Object.fromEntries(task.outputs.map(file => {
    const result = hashBatchPath(file);
    if (!result.files) throw new Error(`task ${task.id}: output directory is empty: ${file}`);
    if (fs.statSync(file).isFile() && fs.statSync(file).size === 0) throw new Error(`task ${task.id}: output is empty: ${file}`);
    return [file, result.hash];
  }));
}
function fingerprint(task, state, stateFile, runtimeFingerprint) {
  const inputs = Object.fromEntries(task.inputs.map(file => [file, hashBatchPath(file, [...task.outputs, path.dirname(stateFile)], { ignoreOperational: true }).hash]));
  const dependencies = task.dependsOn.map(id => [id, state.tasks[id]?.fingerprint, state.tasks[id]?.outputs]);
  return sha(JSON.stringify(canonical({ task, inputs, dependencies, node: process.version, runtimeFingerprint })));
}
function reusable(task, state, stateFile, runtimeFingerprint) {
  const previous = state.tasks[task.id];
  if (previous?.status !== "success") return false;
  try { return previous.fingerprint === fingerprint(task, state, stateFile, runtimeFingerprint) && JSON.stringify(canonical(previous.outputs)) === JSON.stringify(canonical(outputs(task))); }
  catch { return false; }
}

export function planBatch(manifestPath, options = {}) {
  const config = load(manifestPath, options), state = readState(config.stateFile), valid = new Set();
  const tasks = config.tasks.map(task => {
    const cached = options.resume !== false && task.dependsOn.every(id => valid.has(id)) && reusable(task, state, config.stateFile, config.runtimeFingerprint);
    if (cached) valid.add(task.id);
    return { id: task.id, dependsOn: task.dependsOn, status: cached ? "cached" : "pending", storage: storageBudget(task, options) };
  });
  return { schemaVersion: 1, manifest: config.file, stateFile: config.stateFile, tasks };
}
export function readBatchStatus(manifestPath, options = {}) {
  const config = load(manifestPath, options);
  const state = readState(config.stateFile), plan = planBatch(manifestPath, options);
  return { ...state, lastRunOk: state.ok ?? null, ok: plan.tasks.every(task => task.status === "cached"), plan };
}

function execute(task, logFile, signal, journalFile, parentRun) {
  return new Promise((resolve, reject) => {
    const fd = fs.openSync(logFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("task log must be a single-link regular file");
      fs.ftruncateSync(fd, 0);
    } catch (e) { fs.closeSync(fd); throw e; }
    const group = process.platform !== "win32";
    const token = crypto.randomUUID(), locks = [];
    const child = spawn(task.executable ?? process.execPath, task.executable ? task.command : [cli, ...task.command], { cwd: task.cwd, shell: false, detached: group, stdio: ["ignore", fd, fd, ...(!task.executable ? ["ipc"] : [])], env: { ...process.env, MOTION_USE_NO_UPDATE_CHECK: "1", MOTION_USE_JOURNAL_FILE: journalFile, MOTION_USE_JOURNAL_PARENT_RUN: parentRun, MOTION_USE_BATCH_LOCK_TOKEN: task.executable ? "" : token } });
    if (!task.executable) child.on("message", (m) => {
      if (m?.type === "motion-use-output-lock" && m.token === token && m.owner?.pid === child.pid && typeof m.file === "string") locks.push(m);
    });
    fs.closeSync(fd);
    let timer, forced = false;
    const kill = sig => { try { if (group && child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch (e) { if (e.code !== "ESRCH") reject(e); } };
    const abort = () => { kill("SIGTERM"); timer = setTimeout(() => { forced = true; kill("SIGKILL"); }, 2000); timer.unref(); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.on("error", reject);
    child.on("close", async (code, terminationSignal) => {
      signal.removeEventListener("abort", abort);
      clearTimeout(timer);
      if (signal.aborted && group) {
        // Closing stdio can precede a descendant's exit. Never release while a
        // renderer still owns the process group, or after force-killing it.
        const alive = () => { try { process.kill(-child.pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };
        const until = Date.now() + 2000;
        while (alive() && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
        if (alive()) { forced = true; kill("SIGKILL"); }
        if (!forced && terminationSignal === "SIGTERM") {
          try { for (const lock of locks) releaseCancelledOutputLock(lock.file, lock.owner); }
          catch (e) { return reject(e); }
        }
      }
      code === 0 && !signal.aborted ? resolve() : reject(new Error(`task ${task.id} exited ${code ?? terminationSignal}; see ${logFile}`));
    });
  });
}

export async function runBatch(manifestPath, options = {}) {
  if (options.dryRun) return planBatch(manifestPath, options);
  const config = load(manifestPath, options);
  const concurrency = options.concurrency ?? config.manifest.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new Error("batch concurrency must be an integer from 1 to 64");
  const stateDir = path.dirname(config.stateFile), unlock = acquireOutputLock(stateDir);
  const journalFile = path.join(stateDir, "events.jsonl"), journal = createJournal(journalFile);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  let state;
  const active = new Map();
  try {
    state = readState(config.stateFile);
    state.manifest = config.file;
    state.ok = false;
    state.status = "running";
    const pending = new Map(config.tasks.map(task => [task.id, task])), reservations = new Map(), completed = new Set();
    // A killed run never counts as success; its task is retried only after hashing inputs.
    journal("batch", "started");
    const persist = () => { state.updatedAt = new Date().toISOString(); save(config.stateFile, state); };
    async function run(task) {
      const old = state.tasks[task.id], started = performance.now();
      const attempt = (old?.attempt ?? 0) + 1;
      try {
        const inputHash = fingerprint(task, state, config.stateFile, config.runtimeFingerprint);
        state.tasks[task.id] = { status: "running", fingerprint: inputHash, attempt, startedAt: new Date().toISOString() };
        persist(); journal(task.phase ?? "task", "started", { task: task.id, attempt });
        const logFile = path.join(stateDir, `${task.id}.log`);
        await execute(task, logFile, controller.signal, journalFile, journal.runId);
        const result = outputs(task);
        if (inputHash !== fingerprint(task, state, config.stateFile, config.runtimeFingerprint)) throw new Error(`task ${task.id}: inputs changed during execution`);
        state.tasks[task.id] = { ...state.tasks[task.id], status: "success", outputs: result, logFile };
      } catch (error) {
        state.tasks[task.id] = { ...state.tasks[task.id], status: controller.signal.aborted ? "cancelled" : "failed", attempt, error: error.message };
      }
      state.tasks[task.id].duration_s = (performance.now() - started) / 1000;
      state.tasks[task.id].finishedAt = new Date().toISOString();
      persist();
      journal(task.phase ?? "task", "finished", { task: task.id, status: state.tasks[task.id].status, duration_s: state.tasks[task.id].duration_s, attempt });
      options.onEvent?.({ task: task.id, ...state.tasks[task.id] });
    }
    while (pending.size || active.size) {
      let progressed = false;
      for (const [id, task] of pending) {
        if (!task.dependsOn.every(dep => completed.has(dep))) continue;
        if (task.dependsOn.some(dep => state.tasks[dep].status !== "success") || controller.signal.aborted) {
          state.tasks[id] = { status: controller.signal.aborted ? "cancelled" : "blocked", reason: controller.signal.aborted ? "run cancelled" : "dependency failed" };
          pending.delete(id); completed.add(id); persist(); progressed = true; continue;
        }
        if (active.size >= concurrency) continue;
        if (options.resume !== false && reusable(task, state, config.stateFile, config.runtimeFingerprint)) {
          journal(task.phase ?? "task", "cached", { task: id, cache_hit: true });
          pending.delete(id); completed.add(id); progressed = true; continue;
        }
        // Shared reservation prevents concurrent launches from each assuming the
        // entire free disk is available. Values are author estimates, not promises.
        const storage = storageBudget(task, options);
        const sameDisk = [...reservations.values()].filter(r => r.filesystem === storage.filesystem);
        const reserved = sameDisk.reduce((sum, r) => sum + r.requiredBytes, 0);
        if (storage.requiredBytes !== null && storage.requiredBytes + reserved > storage.availableBytes) {
          if (sameDisk.length) continue;
          state.tasks[id] = { status: "failed", reason_code: "insufficient_disk_space", error: "insufficient disk space for estimated task storage", storage: { ...storage, reservedBytes: reserved } };
          pending.delete(id); completed.add(id); persist(); progressed = true; continue;
        }
        pending.delete(id); progressed = true;
        if (storage.requiredBytes !== null) reservations.set(id, storage);
        const promise = run(task).finally(() => { active.delete(id); reservations.delete(id); completed.add(id); });
        active.set(id, promise);
      }
      if (active.size) await Promise.race(active.values());
      else if (pending.size && !progressed) throw new Error("batch scheduler could not make progress");
    }
    state.ok = config.tasks.every(t => state.tasks[t.id]?.status === "success");
    state.status = state.ok ? "success" : controller.signal.aborted ? "cancelled" : "failed";
    persist(); journal("batch", "finished", { status: state.ok ? "success" : "failed" });
    return { ...state, stateFile: config.stateFile };
  } finally {
    controller.abort();
    await Promise.allSettled([...active.values()]);
    options.signal?.removeEventListener("abort", abort);
    unlock();
  }
}

/** Locate a batch journal without executing commands or rehashing completed outputs. */
export function batchJournalPath(manifestPath, options = {}) {
  return path.join(path.dirname(load(manifestPath, { ...options, allowExec: true }).stateFile), "events.jsonl");
}
