import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const BUNDLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Author-declared teaching checks. Samples describe authored state, never pixel evidence.
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const positive = (v) => Number.isFinite(v) && v > 0;
const rect = (v) => object(v) && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(v[k])) && v.width > 0 && v.height > 0;
const TYPES = ['read', 'demonstrate', 'think', 'reveal'];
const ASSERTIONS = ['count', 'state', 'reveal', 'avoidRegion'];
const primitive = (v) => v === null || ['string', 'boolean', 'number'].includes(typeof v) && (typeof v !== 'number' || Number.isFinite(v));

// These are explicit planning estimates, not empirically measured child reading speeds.
export function teachingReadingSeconds(text, { age = 7, unitsPerSecond, minimumReadSeconds = 2 } = {}) {
  const rate = unitsPerSecond ?? (age <= 7 ? 2 : age <= 10 ? 3 : 4);
  if (!positive(rate) || !Number.isFinite(minimumReadSeconds) || minimumReadSeconds < 0)
    throw new Error('teaching reading rate must be positive and minimumReadSeconds nonnegative');
  const units = (String(text).match(/[\p{Script=Han}]|[\p{Letter}\p{Number}]+/gu) ?? []).length;
  return Math.max(minimumReadSeconds, units / rate);
}

export function validateTeaching(teaching, { duration } = {}) {
  const errors = [], warnings = [];
  const error = (path, message) => errors.push({ path, message });
  const warning = (path, message) => warnings.push({ path, message });
  if (teaching === undefined) return { errors, warnings };
  if (!object(teaching)) return { errors: [{ path: '$.teaching', message: 'an optional teaching object' }], warnings };
  const p = '$.teaching';
  if (teaching.samples !== undefined && (typeof teaching.samples !== 'string' || !teaching.samples.trim())) error(`${p}.samples`, 'project-relative JSON author state sample file');
  if (teaching.age !== undefined && (!Number.isInteger(teaching.age) || teaching.age < 3 || teaching.age > 18)) error(`${p}.age`, 'integer age, 3–18');
  if (teaching.unitsPerSecond !== undefined && !positive(teaching.unitsPerSecond)) error(`${p}.unitsPerSecond`, 'positive estimated reading units per second');
  if (teaching.minimumReadSeconds !== undefined && (!Number.isFinite(teaching.minimumReadSeconds) || teaching.minimumReadSeconds < 0)) error(`${p}.minimumReadSeconds`, 'nonnegative estimated minimum reading seconds');
  if (teaching.disableQualityChecks !== undefined) error(`${p}.disableQualityChecks`, 'teaching does not disable blank, glyph, collision, motion, audio or delivery checks');
  if (teaching.regions !== undefined && !object(teaching.regions)) error(`${p}.regions`, 'named rectangles {x,y,width,height} in the same coordinates as sample bounds');
  else for (const [id, r] of Object.entries(teaching.regions ?? {})) if (!id || !rect(r)) error(`${p}.regions.${id}`, 'rectangle with finite coordinates and positive size');
  const interval = (v, at) => {
    if (!Number.isFinite(v.from) || !Number.isFinite(v.to) || v.from < 0 || v.to <= v.from || Number.isFinite(duration) && v.to > duration)
      error(at, 'interval 0 <= from < to <= film duration, in seconds');
  };
  for (const key of ['phases', 'assertions']) {
    if (teaching[key] !== undefined && !Array.isArray(teaching[key])) { error(`${p}.${key}`, 'an array'); continue; }
    const seen = new Set();
    for (const [i, v] of (teaching[key] ?? []).entries()) {
      const at = `${p}.${key}[${i}]`;
      if (!object(v)) { error(at, 'an object'); continue; }
      if (typeof v.id !== 'string' || !v.id.trim() || seen.has(v.id)) error(`${at}.id`, 'nonempty unique id');
      seen.add(v.id);
      interval(v, at);
      if (key === 'phases') {
        if (!TYPES.includes(v.type)) error(`${at}.type`, TYPES.join(', '));
        if (v.type === 'read') {
          if (typeof v.text !== 'string' || !v.text.trim()) error(`${at}.text`, 'text for the reading estimate');
          else if (!errors.some((e) => [p + '.unitsPerSecond', p + '.minimumReadSeconds'].includes(e.path))) {
            const required = teachingReadingSeconds(v.text, teaching);
            if (v.to - v.from < required) warning(at, `reading window ${v.to - v.from} s is below the author planning estimate ${required} s; independently review with the learner`);
          }
        }
        if (v.type === 'think' && (typeof v.reason !== 'string' || !v.reason.trim())) error(`${at}.reason`, 'record the purpose of the thinking pause');
        continue;
      }
      if (!ASSERTIONS.includes(v.type)) error(`${at}.type`, ASSERTIONS.join(', '));
      if (v.type === 'count') {
        if (!Array.isArray(v.objects) || !v.objects.length || v.objects.some((id) => typeof id !== 'string' || !id.trim()) || new Set(v.objects).size !== v.objects.length) error(`${at}.objects`, 'nonempty unique object ids');
        if (!Number.isInteger(v.expected) || v.expected < 0) error(`${at}.expected`, 'nonnegative expected visible count');
        if (v.region !== undefined && (typeof v.region !== 'string' || !v.region.trim())) error(`${at}.region`, 'named ownership region');
      } else if (ASSERTIONS.includes(v.type)) {
        if (typeof v.object !== 'string' || !v.object.trim()) error(`${at}.object`, 'object id');
        if (v.type === 'state' && (!object(v.expected) || !Object.keys(v.expected).length || Object.values(v.expected).some((x) => !primitive(x)))) error(`${at}.expected`, 'nonempty shallow state object with primitive values');
        if (v.type === 'reveal' && (!Number.isFinite(v.notBefore) || v.notBefore < v.from || v.notBefore > v.to)) error(`${at}.notBefore`, 'answer reveal threshold within the assertion interval');
        if (v.type === 'avoidRegion' && !rect(teaching.regions?.[v.region])) error(`${at}.region`, 'a declared rectangle region to avoid');
      }
    }
  }
  return { errors, warnings };
}

// Sample every frame throughout assertion intervals and continuous frames around transitions.
// Times are on the output frame grid; intervals are [from,to), matching rendered frames.
export function teachingSampleTimes(teaching, { duration, fps = 30, transitionFrames = 3 } = {}) {
  const validation = validateTeaching(teaching, { duration });
  if (validation.errors.length) throw new Error(`invalid teaching configuration: ${JSON.stringify(validation.errors)}`);
  if (!Number.isFinite(fps) || fps < 1 || fps > 120 || !Number.isInteger(transitionFrames) || transitionFrames < 0 || transitionFrames > 60) throw new Error('fps must be 1–120 and transitionFrames an integer 0–60');
  const times = new Set();
  const limit = Number.isFinite(duration) ? Math.ceil(duration * fps) : Infinity;
  const add = (frame) => { if (frame >= 0 && frame < limit) times.add(frame); };
  for (const a of teaching?.assertions ?? []) {
    const first = Math.ceil(a.from * fps - 1e-8), end = Math.ceil(a.to * fps - 1e-8);
    if (end - first > 100000) throw new Error('teaching assertion exceeds 100000 frames; split or shorten the interval');
    for (let f = first; f < end; f++) add(f);
  }
  for (const v of [...(teaching?.phases ?? []), ...(teaching?.assertions ?? [])]) {
    for (const boundary of [v.from, v.to, ...(v.type === 'reveal' ? [v.notBefore] : [])]) {
      const frame = Math.round(boundary * fps);
      for (let offset = -transitionFrames; offset <= transitionFrames; offset++) add(frame + offset);
    }
  }
  if (times.size > 100000) throw new Error('teaching sample plan exceeds 100000 frames');
  return [...times].sort((a, b) => a - b).map((f) => f / fps);
}

const intersects = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
function evaluate(a, objects, teaching, t) {
  const ids = a.type === 'count' ? a.objects : [a.object];
  const missing = ids.filter((id) => !objects.has(id));
  if (missing.length) return { pass: false, reason: 'missing sampled object', objects: missing };
  if (a.type === 'count') {
    const candidates = ids.map((id) => objects.get(id));
    const unassigned = candidates.filter((o) => o.visible && a.region !== undefined && (typeof o.region !== 'string' || !o.region.trim()));
    if (unassigned.length) return { pass: false, reason: 'visible object has no declared ownership region', objects: unassigned.map((o) => o.id) };
    const selected = candidates.filter((o) => o.visible && (a.region === undefined || o.region === a.region));
    return { pass: selected.length === a.expected, reason: 'visible object count', expected: a.expected, actual: selected.length, objects: selected.map((o) => o.id) };
  }
  const o = objects.get(a.object);
  if (a.type === 'state') return { pass: Object.entries(a.expected).every(([k, v]) => Object.hasOwn(o.state ?? {}, k) && o.state[k] === v), reason: 'declared object state', expected: a.expected, actual: o.state ?? null, objects: [o.id] };
  if (a.type === 'reveal') return { pass: t + 1e-8 >= a.notBefore || !o.visible, reason: 'answer visible before notBefore', expected: a.notBefore, actual: t, objects: [o.id] };
  if (a.type === 'avoidRegion') {
    if (o.visible && !rect(o.bounds)) return { pass: false, reason: 'visible object has no valid sampled bounds', objects: [o.id] };
    return { pass: !o.visible || !intersects(o.bounds, teaching.regions[a.region]), reason: 'object intersects protected region', region: a.region, objects: [o.id] };
  }
}

export async function checkTeaching(teaching, { duration, fps = 30, sample } = {}) {
  const { errors, warnings } = validateTeaching(teaching, { duration });
  const base = { schemaVersion: 1, evidence: 'author-declared-state', visualReview: 'UNREVIEWED', mathematicalReview: 'UNREVIEWED', listeningReview: 'UNREVIEWED', readingTiming: 'estimated', errors, warnings };
  if (errors.length) return { ...base, ok: false, status: 'FAIL', assertions: [], sampleTimes: [] };
  if (teaching === undefined) return { ...base, ok: true, status: 'SKIPPED', reason: 'no teaching configuration', assertions: [], sampleTimes: [] };
  const sampleTimes = teachingSampleTimes(teaching, { duration, fps });
  const assertions = (teaching.assertions ?? []).map((a) => ({ id: a.id, type: a.type, from: a.from, to: a.to, status: 'UNREVIEWED', samples: 0, failures: [] }));
  if (sampleTimes.length && typeof sample !== 'function') return { ...base, ok: false, status: 'UNREVIEWED', reason: 'provide an author state sampler to check assertions', assertions, sampleTimes };
  const sampleCompleteness = { expected: sampleTimes.length, checked: 0, failed: 0, failures: [] };
  for (const t of sampleTimes) {
    const active = (teaching.assertions ?? []).map((a, i) => ({ a, row: assertions[i] })).filter(({ a }) => t + 1e-8 >= a.from && t < a.to - 1e-8);
    let objects, sampleError;
    try {
      const frame = await sample(t);
      if (!Array.isArray(frame?.objects) || frame.objects.some((o) => !object(o) || typeof o.id !== 'string' || typeof o.visible !== 'boolean') || new Set(frame.objects.map((o) => o.id)).size !== frame.objects.length) throw new Error('sample requires unique object ids and explicit boolean visible');
      objects = new Map(frame.objects.map((o) => [o.id, o]));
    } catch (e) { sampleError = e.message; }
    sampleCompleteness.checked++;
    if (sampleError) { sampleCompleteness.failed++; sampleCompleteness.failures.push({ time: t, error: sampleError }); }
    for (const { a, row } of active) {
      row.samples++;
      const result = sampleError ? { pass: false, reason: 'sample unavailable', error: sampleError, objects: a.objects ?? [a.object] } : evaluate(a, objects, teaching, t);
      if (!result.pass) {
        const last = row.failures.at(-1);
        const detail = JSON.stringify({ ...result, actual: a.type === 'reveal' ? undefined : result.actual });
        if (last && Math.abs(last.to - t) < 1e-7 && last.detail === detail) last.to = Math.min(a.to, t + 1 / fps);
        else row.failures.push({ from: t, to: Math.min(a.to, t + 1 / fps), ...result, detail });
      }
    }
  }
  for (const row of assertions) {
    row.status = row.failures.length ? 'FAIL' : row.samples ? 'PASS' : 'UNREVIEWED';
    for (const failure of row.failures) { delete failure.detail; delete failure.pass; }
  }
  sampleCompleteness.status = sampleCompleteness.failed ? 'FAIL' : 'PASS';
  const ok = !sampleCompleteness.failed && assertions.every((a) => a.status === 'PASS');
  return { ...base, ok, status: ok ? 'PASS' : sampleCompleteness.failed || assertions.some((a) => a.status === 'FAIL') ? 'FAIL' : 'UNREVIEWED', assertions, sampleTimes, sampleCompleteness };
}


// File adapter for CLI/report integration. State files are author declarations,
// not observations of rendered pixels, and must cover exact requested frame times.
export async function checkTeachingFile(input, { samplesFile, plan = false } = {}) {
  const resolved = path.resolve(input ?? '.');
  const filmFile = fs.statSync(resolved).isDirectory() ? path.join(resolved, 'film.json') : resolved;
  const film = JSON.parse(fs.readFileSync(filmFile, 'utf8'));
  const dir = fs.realpathSync(path.dirname(filmFile));
  if (film.teaching === undefined) return { ...(await checkTeaching(undefined)), sample_plan: [] };
  const options = { duration: film.duration, fps: film.fps ?? 30 };
  if (!Number.isFinite(options.duration) || options.duration <= 0 || !Number.isFinite(options.fps) || options.fps < 1 || options.fps > 120)
    throw new Error('teaching requires positive film.duration and fps in 1–120');
  const validation = validateTeaching(film.teaching, options);
  if (validation.errors.length) return { ...(await checkTeaching(film.teaching, options)), sample_plan: [] };
  const sample_plan = teachingSampleTimes(film.teaching, options);
  const inputs = await teachingInputFingerprint(film, filmFile, dir);
  const file = samplesFile ?? film.teaching?.samples;
  if (plan || file === undefined) {
    const report = await checkTeaching(film.teaching, options);
    return { ...report, sample_plan, inputs };
  }
  if (typeof file !== 'string' || !file.trim()) throw new Error('teaching state file must be a nonempty project-relative path');
  // Reject lexical escapes as well as symlink escapes, before opening content.
  const candidate = path.resolve(dir, file);
  const inside = (f) => { const rel = path.relative(dir, f); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
  if (!inside(candidate)) throw new Error('teaching state file must stay inside the project');
  const real = fs.realpathSync(candidate);
  if (!inside(real)) throw new Error('teaching state file symlink escapes the project');
  const raw = fs.readFileSync(real, 'utf8');
  const data = JSON.parse(raw);
  if (!object(data) || !Array.isArray(data.samples)) throw new Error('teaching state JSON requires {samples:[{time,objects}]}');
  if (!object(data.inputs) || data.inputs.schemaVersion !== inputs.schemaVersion || data.inputs.sha256 !== inputs.sha256) throw new Error('teaching state inputs binding missing or stale; regenerate the plan and author states for the current film and source inputs');
  const frames = new Map();
  for (const [i, row] of data.samples.entries()) {
    if (!object(row) || !Number.isFinite(row.time) || row.time < 0 || row.time >= options.duration || !Array.isArray(row.objects)) throw new Error(`invalid teaching sample at index ${i}: time within film and objects array required`);
    const frame = Math.round(row.time * options.fps);
    if (Math.abs(row.time - frame / options.fps) > 1e-8) throw new Error(`teaching sample at index ${i} is not on the output frame grid`);
    if (frames.has(frame)) throw new Error(`duplicate teaching sample for output frame ${frame}`);
    frames.set(frame, row);
  }
  const report = await checkTeaching(film.teaching, { ...options, sample: (t) => {
    const frame = Math.round(t * options.fps);
    if (!frames.has(frame)) throw new Error(`missing author state sample at ${t} s (frame ${frame}); no interpolation`);
    return frames.get(frame);
  } });
  return { ...report, sample_plan, inputs, sampleSource: { file: path.relative(dir, candidate), sha256: crypto.createHash('sha256').update(raw).digest('hex'), evidence: 'author-declared-state', interpolation: false } };
}


async function teachingInputFingerprint(rawFilm, filmFile, dir) {
  // Dynamic imports avoid a film -> teaching -> film initialization cycle.
  const [{ validateFilm }, { filmInputs }] = await Promise.all([import('./film.mjs'), import('./snapshot.mjs')]);
  const { film } = validateFilm(rawFilm, dir, { probe: () => 0 });
  const canonical = structuredClone(rawFilm);
  if (object(canonical.teaching)) delete canonical.teaching.samples;
  const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  const sources = filmInputs(film, filmFile).filter((entry) => entry.role !== 'film' && entry.role !== 'teaching-state');
  if (film.scoreFile) sources.push({ role: 'music-score', file: film.scoreFile });
  const files = [{ role: 'film', path: path.relative(dir, filmFile), sha256: sha(JSON.stringify(canonical)) }];
  const bundledEffects = new Set((film.tracks ?? []).filter((track) =>
    typeof track.effect === 'string' && /^[a-z][a-z-]*$/.test(track.effect) &&
    path.resolve(track.file) === path.join(BUNDLE_ROOT, 'assets', 'sfx', track.effect + '.wav')
  ).map((track) => path.resolve(track.file)));
  const bundleAssets = fs.realpathSync(path.join(BUNDLE_ROOT, 'assets'));
  const seen = new Set();
  for (const entry of sources) {
    const real = fs.realpathSync(entry.file);
    let rel = path.relative(dir, real);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
      const bundleRel = path.relative(bundleAssets, real);
      const trustedBundle = ['audio', 'voiceover'].includes(entry.role) && bundledEffects.has(path.resolve(entry.file)) && bundleRel !== '..' && !bundleRel.startsWith('..' + path.sep) && !path.isAbsolute(bundleRel);
      if (!trustedBundle) throw new Error('teaching source input escapes the project');
      rel = '@motion-use/assets/' + bundleRel.split(path.sep).join('/');
    }
    if (seen.has(real)) continue;
    seen.add(real);
    // Stream hashes to avoid loading large footage into the JS heap.
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(real, 'r'), buffer = Buffer.alloc(1024 * 1024);
    try { let count; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count)); }
    finally { fs.closeSync(fd); }
    files.push({ role: entry.role, path: rel, sha256: hash.digest('hex') });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { schemaVersion: 1, sha256: sha(JSON.stringify(files)), files };
}
