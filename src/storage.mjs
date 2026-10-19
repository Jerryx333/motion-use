import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { acquireOutputLock } from "./output-lock.mjs";

const MARK = ".motion-use-build";
const MARK_TEXT = "created by motion-use; safe to delete\n";
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const cacheDefault = () => process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
const rootsFor = ({ out, cacheHome = cacheDefault() } = {}) => ({ out: out ? path.resolve(out) : null, cache: path.resolve(cacheHome, "motion-use", "samples") });

// Do not follow symlinks, even in an ancestor. Existing ancestors of a future output
// are checked too, so a plan cannot quietly switch physical destinations.
function noLinks(file) {
  const abs = path.resolve(file);
  const parts = abs.slice(path.parse(abs).root.length).split(path.sep).filter(Boolean);
  let cur = path.parse(abs).root;
  for (const part of parts) {
    cur = path.join(cur, part);
    let st;
    try { st = fs.lstatSync(cur); } catch (e) { if (e.code === "ENOENT") return; throw e; }
    if (st.isSymbolicLink()) throw new Error(`refusing symlink: ${cur}`);
  }
}

/** Filesystem observation, not a promise of reclaimable bytes (APFS/snapshots may retain blocks). */
export function diskSpace(target = process.cwd()) {
  let existing = path.resolve(target);
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error(`no existing filesystem for ${target}`);
    existing = parent;
  }
  const s = fs.statfsSync(existing);
  return { path: path.resolve(target), measured_at: new Date().toISOString(), available_bytes: s.bavail * s.bsize, total_bytes: s.blocks * s.bsize };
}

/** Advisory render budget. Independent concurrent callers must pass aggregate reservations. */
export function storagePreflight({ path: target = process.cwd(), width = 1920, height = 1080, fps = 30, duration = 0, streaming = true, concurrency = 1, reservedBytes = 0, reserveBytes = 512 * 1024 ** 2, outputBitrate = 12_000_000 } = {}) {
  for (const [name, n] of Object.entries({ width, height, fps, concurrency, outputBitrate }))
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be positive`);
  for (const [name, n] of Object.entries({ duration, reservedBytes, reserveBytes }))
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be nonnegative`);
  const frames = Math.round(duration * fps);
  const raw = frames * width * height * 4;
  // PNG compression is content dependent; use raw RGBA plus PNG overhead as a
  // deliberately conservative planning allowance, not a prediction of actual PNG size.
  const intermediate = streaming ? 0 : Math.ceil(raw * 1.02 + frames * 4096);
  const output = Math.ceil(duration * outputBitrate / 8);
  const audio = Math.ceil(duration * 48000 * 2 * 4);
  const needed = Math.ceil((intermediate + output * 2 + audio) * concurrency + reserveBytes + reservedBytes);
  const disk = diskSpace(target);
  return { ok: disk.available_bytes >= needed, status: disk.available_bytes >= needed ? "PASS" : "WARN", disk, estimate: { estimated: true, frames, streaming, concurrency, raw_frame_bytes: raw, intermediate_bytes: intermediate, encoded_output_bytes: output, audio_bytes: audio, reserved_other_jobs_bytes: reservedBytes, headroom_bytes: reserveBytes, required_available_bytes: needed, assumptions: ["PNG sequence allowance: raw RGBA + 2% + 4096 bytes/frame; streaming retains no frame sequence", `Encoded output allowance: ${outputBitrate} bits/s with two output copies`, "48 kHz stereo float audio; source copies, footage extraction, browser cache and other tools are not included", "Advisory estimate; filesystem use can change after this observation"] } };
}

function snapshot(file) {
  noLinks(file);
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.nlink !== 1) throw new Error(`not a single-link regular cache file: ${file}`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd);
    const digest = sha(fs.readFileSync(fd));
    const after = fs.fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== st.ino || before.dev !== st.dev) throw new Error(`cache changed during inspection: ${file}`);
    return { bytes: st.size, sha256: digest, dev: st.dev, ino: st.ino, mtime_ms: st.mtimeMs };
  } finally { fs.closeSync(fd); }
}

function permitted(entry, roots) {
  if (!entry || typeof entry.file !== "string") throw new Error("invalid cleanup entry");
  const file = path.resolve(entry.file);
  if (file !== entry.file) throw new Error("cleanup paths must be absolute and normalized");
  noLinks(file);
  if (entry.category === "decoded-sample" && path.dirname(file) === roots.cache && /^[a-f0-9]{40}\.f32$/.test(path.basename(file))) return;
  if (entry.category === "engine-frame" && roots.out) {
    const rel = path.relative(roots.out, file).split(path.sep);
    if (rel.length === 4 && rel[0] === ".build" && /^[^/\\]+-engine$/.test(rel[1]) && rel[2] === "frames" && /^\d{5,}\.png$/.test(rel[3])) {
      const marker = path.join(roots.out, ".build", rel[1], MARK);
      noLinks(marker);
      const st = fs.lstatSync(marker);
      if (st.isFile() && st.nlink === 1 && fs.readFileSync(marker, "utf8") === MARK_TEXT) return;
    }
  }
  throw new Error(`not an owned rebuildable cache file: ${file}`);
}

const planHash = (plan) => sha(JSON.stringify({ version: plan.version, roots: plan.roots, created_at: plan.created_at, files: plan.files, logical_bytes: plan.logical_bytes }));

/** Read-only preview; never scans global uv/ASR caches, sources, builds or final deliverables. */
export function planCacheCleanup(options = {}) {
  const roots = rootsFor(options), files = [], skipped = [];
  for (const root of Object.values(roots).filter(Boolean)) noLinks(root);
  const add = (file, category) => {
    const entry = { file, category };
    try { permitted(entry, roots); files.push({ ...entry, ...snapshot(file) }); }
    catch (e) { skipped.push({ file, reason: e.message }); }
  };
  if (fs.existsSync(roots.cache)) {
    for (const name of fs.readdirSync(roots.cache).sort())
      if (/^[a-f0-9]{40}\.f32$/.test(name)) add(path.join(roots.cache, name), "decoded-sample");
  }
  const builds = roots.out && path.join(roots.out, ".build");
  if (builds && fs.existsSync(builds)) {
    noLinks(builds);
    for (const name of fs.readdirSync(builds).sort()) {
      if (!name.endsWith("-engine")) continue;
      const frames = path.join(builds, name, "frames");
      try {
        noLinks(frames);
        if (!fs.existsSync(frames)) continue;
        for (const frame of fs.readdirSync(frames).sort())
          if (/^\d{5,}\.png$/.test(frame)) add(path.join(frames, frame), "engine-frame");
      } catch (e) { skipped.push({ file: frames, reason: e.message }); }
    }
  }
  const plan = { version: 1, roots, created_at: new Date().toISOString(), files, logical_bytes: files.reduce((n, f) => n + f.bytes, 0), skipped };
  return { ...plan, plan_sha256: planHash(plan), dry_run: true, scope: "decoded sampler files and marked external-engine frame PNGs only; no global uv cache or review evidence" };
}

/** Validate a frozen plan under the same checks and lock as apply, without deleting. */
export function validateCacheCleanup(plan, options = {}) {
  return applyCacheCleanup(plan, { ...options, dryRun: true });
}

/** Apply only a frozen plan under roots independently supplied by the caller.
 * dryRun performs the full pre-removal validation and never unlinks cache files. */
export function applyCacheCleanup(plan, options = {}) {
  const roots = rootsFor(options);
  if (plan?.version !== 1 || !Array.isArray(plan.files) || plan.plan_sha256 !== planHash(plan)) throw new Error("cleanup plan hash/schema mismatch; create a new plan");
  if (JSON.stringify(roots) !== JSON.stringify(plan.roots)) throw new Error("cleanup roots differ from plan; pass the same explicit output/cache roots");
  for (const root of Object.values(roots).filter(Boolean)) noLinks(root);
  const release = roots.out && fs.existsSync(roots.out) ? acquireOutputLock(roots.out) : () => {};
  try {
    const seen = new Set();
    const check = (entry) => {
      permitted(entry, roots);
      const current = snapshot(entry.file);
      for (const k of Object.keys(current)) if (current[k] !== entry[k]) throw new Error(`cache changed since plan: ${entry.file}; create a new plan`);
    };
    // Validate every item before the first removal. Files added later are never swept up.
    for (const entry of plan.files) {
      if (seen.has(entry.file)) throw new Error("duplicate cleanup entry");
      seen.add(entry.file); check(entry);
    }
    if (options.dryRun) return {
      ok: true, status: "VALIDATED", dry_run: true, applied: false,
      checked: plan.files.length, plan_sha256: plan.plan_sha256,
      removed: [], failures: [], deleted_logical_bytes: 0,
      note: "Frozen plan validated against current roots, ownership, identities and content under the output lock. No cache files deleted; a later apply rechecks because files may change.",
    };
    const targets = [...new Set(plan.files.map((f) => f.category === "engine-frame" ? roots.out : roots.cache))];
    const before = targets.map((p) => diskSpace(p));
    const removed = [], failures = [];
    for (const entry of plan.files) {
      try { check(entry); fs.unlinkSync(entry.file); removed.push(entry.file); }
      catch (e) { failures.push({ file: entry.file, reason: e.message }); break; }
    }
    const after = targets.map((p) => diskSpace(p));
    return { ok: failures.length === 0, status: failures.length ? "PARTIAL" : "PASS", removed, failures, deleted_logical_bytes: plan.files.filter((f) => removed.includes(f.file)).reduce((n, f) => n + f.bytes, 0), observations: before.map((b, i) => ({ before: b, after: after[i], available_delta_bytes: after[i].available_bytes - b.available_bytes })), note: "Free-space deltas are observations, not attributed reclaimed bytes; concurrent activity, snapshots and filesystem allocation can affect them." };
  } finally { release(); }
}
