import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTeaching, teachingReadingSeconds, teachingSampleTimes, checkTeaching } from '../src/teaching.mjs';

const spec = {
  age: 7,
  regions: { label: { x: 40, y: 0, width: 20, height: 20 } },
  phases: [{ id: 'read', type: 'read', from: 0, to: 2, text: '五个点拿走三个还剩几个' }, { id: 'think', type: 'think', from: 2, to: 3, reason: 'count the remaining dots' }],
  assertions: [
    { id: 'remaining', type: 'count', from: 3, to: 4, objects: ['d1', 'd2', 'd3', 'd4', 'd5'], region: 'board', expected: 2 },
    { id: 'ownership', type: 'state', from: 3, to: 4, object: 'd3', expected: { removed: true } },
    { id: 'answer', type: 'reveal', from: 0, to: 4, object: 'answer', notBefore: 3 },
    { id: 'path', type: 'avoidRegion', from: 1, to: 3, object: 'd3', region: 'label' },
  ],
};
const good = (t) => ({ objects: [
  ...[1, 2, 3, 4, 5].map((n) => ({ id: `d${n}`, visible: true, region: n <= 2 || t < 3 ? 'board' : 'removed', state: { removed: n > 2 && t >= 3 }, bounds: { x: n * 3, y: 30, width: 2, height: 2 } })),
  { id: 'answer', visible: t >= 3 },
] });

test('teaching estimates are explicit and keep short reading windows visible', () => {
  assert.equal(teachingReadingSeconds('一二三四五六', { age: 7 }), 3);
  assert.equal(teachingReadingSeconds('一二三四五六', { age: 11 }), 2);
  assert.equal(validateTeaching(spec, { duration: 4 }).errors.length, 0);
  assert.match(validateTeaching(spec, { duration: 4 }).warnings[0].message, /planning estimate/);
  assert.ok(validateTeaching({ disableQualityChecks: true }).errors.length);
});

test('author state checks pass without claiming visual, mathematical or listening review', async () => {
  const r = await checkTeaching(spec, { duration: 4, fps: 30, sample: good });
  assert.equal(r.status, 'PASS');
  assert.equal(r.evidence, 'author-declared-state');
  assert.equal(r.visualReview, 'UNREVIEWED');
  assert.equal(r.mathematicalReview, 'UNREVIEWED');
  assert.equal(r.listeningReview, 'UNREVIEWED');
  assert.equal(r.readingTiming, 'estimated');
  assert.ok(r.assertions.every((a) => a.samples > 0 && a.status === 'PASS'));
});

test('one dot not removed, answer 0.5 s early, path crossing label fail separately', async () => {
  const r = await checkTeaching(spec, { duration: 4, fps: 30, sample: (t) => {
    const s = good(t);
    const dot = s.objects.find((o) => o.id === 'd3');
    if (t >= 3) { dot.region = 'board'; dot.state.removed = false; }
    if (t >= 1.5 && t < 2) dot.bounds = { x: 45, y: 5, width: 2, height: 2 };
    s.objects.find((o) => o.id === 'answer').visible = t >= 2.5;
    return s;
  } });
  assert.equal(r.status, 'FAIL');
  const rows = Object.fromEntries(r.assertions.map((a) => [a.id, a]));
  assert.equal(rows.remaining.failures[0].actual, 3);
  assert.deepEqual(rows.ownership.failures[0].objects, ['d3']);
  assert.equal(rows.answer.failures[0].from, 2.5);
  assert.equal(rows.answer.failures[0].to, 3);
  assert.equal(rows.path.failures[0].from, 1.5);
  assert.equal(rows.path.failures[0].to, 2);
  assert.equal(rows.path.failures[0].region, 'label');
});

test('transition sample plan covers adjacent continuous frames and never exceeds film duration', () => {
  const times = teachingSampleTimes(spec, { duration: 4, fps: 30 });
  for (const f of [87, 88, 89, 90, 91, 92, 93]) assert.ok(times.includes(f / 30));
  assert.ok(times.every((t) => t >= 0 && t < 4));
  assert.equal(new Set(times).size, times.length);
});

test('no sampler, missing objects and sampler errors cannot become passing evidence', async () => {
  assert.equal((await checkTeaching(spec, { duration: 4 })).status, 'UNREVIEWED');
  const empty = await checkTeaching(spec, { duration: 4, sample: () => ({ objects: [] }) });
  assert.equal(empty.status, 'FAIL');
  assert.match(empty.assertions[0].failures[0].reason, /missing/);
  const broken = await checkTeaching(spec, { duration: 4, sample: () => { throw new Error('renderer unavailable'); } });
  assert.equal(broken.status, 'FAIL');
  assert.match(broken.assertions[0].failures[0].error, /renderer unavailable/);
  assert.equal((await checkTeaching(undefined)).status, 'SKIPPED');
});

test('bad specs fail validation and intervals with no output frame remain unreviewed', async () => {
  assert.ok(validateTeaching({ assertions: [{ id: 'x', type: 'reveal', object: 'a', from: 0, to: 1, notBefore: 2 }] }, { duration: 1 }).errors.length);
  assert.ok(validateTeaching({ assertions: [{ id: 'x', type: 'avoidRegion', object: 'a', from: 0, to: 1, region: 'missing' }] }).errors.length);
  assert.ok(validateTeaching({ phases: [{ id: 'x', type: 'think', from: 0, to: 1 }] }).errors.length);
  const r = await checkTeaching({ assertions: [{ id: 'x', type: 'state', object: 'a', from: 0.001, to: 0.002, expected: { done: true } }] }, { duration: 1, fps: 30, sample: good });
  assert.equal(r.status, 'UNREVIEWED');
  assert.equal(r.ok, false);
});


test('a zero-count cannot pass when visible objects omit ownership or protected bounds', async () => {
  const config = {
    regions: { label: { x: 0, y: 0, width: 10, height: 10 } },
    assertions: [
      { id: 'empty', type: 'count', from: 0, to: 1, objects: ['dot'], region: 'board', expected: 0 },
      { id: 'path', type: 'avoidRegion', from: 0, to: 1, object: 'dot', region: 'label' },
    ],
  };
  const r = await checkTeaching(config, { duration: 1, sample: () => ({ objects: [{ id: 'dot', visible: true }] }) });
  assert.equal(r.status, 'FAIL');
  assert.match(r.assertions[0].failures[0].reason, /ownership/);
  assert.match(r.assertions[1].failures[0].reason, /bounds/);
});

test('file adapter plans exact frames, checks author state files and rejects missing or interpolated frames', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { checkTeachingFile } = await import('../src/teaching.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mu-teaching-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const film = { duration: 1, fps: 30, teaching: { assertions: [{ id: 'done', type: 'state', from: 0, to: 1, object: 'dot', expected: { done: true } }] } };
  fs.writeFileSync(path.join(dir, 'film.json'), JSON.stringify(film));
  const planned = await checkTeachingFile(dir, { plan: true });
  assert.equal(planned.status, 'UNREVIEWED');
  assert.equal(planned.sample_plan.length, 30);
  const samples = planned.sample_plan.map((time) => ({ time, objects: [{ id: 'dot', visible: true, state: { done: true } }] }));
  const write = (rows) => fs.writeFileSync(path.join(dir, 'states.json'), JSON.stringify({ inputs: planned.inputs, samples: rows }));
  write(samples);
  const checked = await checkTeachingFile(dir, { samplesFile: 'states.json' });
  assert.equal(checked.status, 'PASS');
  assert.equal(checked.sampleSource.evidence, 'author-declared-state');
  assert.equal(checked.sampleSource.interpolation, false);
  assert.match(checked.sampleSource.sha256, /^[a-f0-9]{64}$/);
  write(samples.slice(1));
  assert.equal((await checkTeachingFile(dir, { samplesFile: 'states.json' })).status, 'FAIL');
  write([{ ...samples[0], time: 0.01 }]);
  await assert.rejects(checkTeachingFile(dir, { samplesFile: 'states.json' }), /frame grid/);
  write([samples[0], samples[0]]);
  await assert.rejects(checkTeachingFile(dir, { samplesFile: 'states.json' }), /duplicate/);
  await assert.rejects(checkTeachingFile(dir, { samplesFile: '../outside.json' }), /stay inside/);
  fs.symlinkSync(os.tmpdir(), path.join(dir, 'escape'));
  await assert.rejects(checkTeachingFile(dir, { samplesFile: 'escape' }), /symlink escapes/);
  film.teaching.samples = 'missing.json';
  fs.writeFileSync(path.join(dir, 'film.json'), JSON.stringify(film));
  assert.equal((await checkTeachingFile(dir, { plan: true })).status, 'UNREVIEWED');
});

test('missing transition frame fails even while every assertion frame passes', async () => {
  const config = { assertions: [{ id: 'done', type: 'state', from: 1, to: 2, object: 'dot', expected: { done: true } }] };
  const r = await checkTeaching(config, { duration: 3, fps: 30, sample: (time) => {
    if (time < 1) throw new Error('missing continuous pre-transition sample');
    return { objects: [{ id: 'dot', visible: true, state: { done: true } }] };
  } });
  assert.equal(r.assertions[0].status, 'PASS');
  assert.equal(r.status, 'FAIL');
  assert.equal(r.sampleCompleteness.status, 'FAIL');
  assert.equal(r.sampleCompleteness.failed, 3);
});

test('state input binding rejects missing binding and changes to film, composition and library', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { checkTeachingFile } = await import('../src/teaching.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mu-teaching-bind-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'composition'));
  fs.writeFileSync(path.join(dir, 'composition/draw.js'), 'window.drawFrame = () => {};');
  fs.writeFileSync(path.join(dir, 'composition/library.js'), 'window.number = 2;');
  const film = { duration: 1, fps: 30, composition: 'composition/draw.js', libraries: ['composition/library.js'], teaching: { assertions: [{ id: 'done', type: 'state', from: 0, to: 1, object: 'dot', expected: { done: true } }] } };
  const save = () => fs.writeFileSync(path.join(dir, 'film.json'), JSON.stringify(film));
  save();
  const plan = await checkTeachingFile(dir, { plan: true });
  assert.ok(plan.inputs.files.some((f) => f.path === 'composition/draw.js'));
  assert.ok(plan.inputs.files.some((f) => f.path === 'composition/library.js'));
  const states = { samples: plan.sample_plan.map((time) => ({ time, objects: [{ id: 'dot', visible: true, state: { done: true } }] })) };
  const writeStates = () => fs.writeFileSync(path.join(dir, 'states.json'), JSON.stringify(states));
  writeStates();
  await assert.rejects(checkTeachingFile(dir, { samplesFile: 'states.json' }), /binding missing or stale/);
  states.inputs = plan.inputs;
  writeStates();
  film.teaching.samples = 'states.json';
  save();
  assert.equal((await checkTeachingFile(dir)).status, 'PASS', 'state file reference does not create a hash cycle');
  fs.appendFileSync(path.join(dir, 'composition/draw.js'), '\n// changed drawing');
  await assert.rejects(checkTeachingFile(dir), /binding missing or stale/);
  fs.writeFileSync(path.join(dir, 'composition/draw.js'), 'window.drawFrame = () => {};');
  fs.appendFileSync(path.join(dir, 'composition/library.js'), '\n// changed library');
  await assert.rejects(checkTeachingFile(dir), /binding missing or stale/);
  fs.writeFileSync(path.join(dir, 'composition/library.js'), 'window.number = 2;');
  film.fps = 60;
  save();
  await assert.rejects(checkTeachingFile(dir), /binding missing or stale/);
});

test('fingerprint accepts exact bundled SFX and no-teaching skips source resolution', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { checkTeachingFile } = await import('../src/teaching.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mu-teaching-sfx-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const film = { duration: 1, fps: 30, audio: [{ effect: 'click', start: 0 }], teaching: { assertions: [{ id: 'done', type: 'state', from: 0, to: 1, object: 'dot', expected: { done: true } }] } };
  const save = () => fs.writeFileSync(path.join(dir, 'film.json'), JSON.stringify(film));
  save();
  const plan = await checkTeachingFile(dir, { plan: true });
  const effect = plan.inputs.files.find((f) => f.path === '@motion-use/assets/sfx/click.wav');
  assert.equal(effect.role, 'audio');
  assert.match(effect.sha256, /^[a-f0-9]{64}$/);
  const samples = plan.sample_plan.map((time) => ({ time, objects: [{ id: 'dot', visible: true, state: { done: true } }] }));
  fs.writeFileSync(path.join(dir, 'states.json'), JSON.stringify({ inputs: plan.inputs, samples }));
  assert.equal((await checkTeachingFile(dir, { samplesFile: 'states.json' })).status, 'PASS');
  delete film.teaching;
  film.libraries = 'invalid-but-unrelated';
  film.duration = 'not-needed-for-skip';
  save();
  const skipped = await checkTeachingFile(dir);
  assert.equal(skipped.status, 'SKIPPED');
  assert.equal(skipped.inputs, undefined);
});

test('snapshot preserves the effective --states override for restored teaching checks', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { checkTeachingFile } = await import('../src/teaching.mjs');
  const { createSnapshot, findSnapshot, restoreSnapshot } = await import('../src/snapshot.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mu-teaching-snapshot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project'), output = path.join(dir, 'output');
  fs.mkdirSync(project);
  fs.mkdirSync(output);
  const filmFile = path.join(project, 'film.json');
  const raw = { duration: 1, fps: 30, voiceover: false, teaching: { samples: 'A.json', assertions: [{ id: 'done', type: 'state', from: 0, to: 1, object: 'dot', expected: { done: true } }] } };
  fs.writeFileSync(filmFile, JSON.stringify(raw));
  const plan = await checkTeachingFile(project, { plan: true });
  const samples = plan.sample_plan.map((time) => ({ time, objects: [{ id: 'dot', visible: true, state: { done: true } }] }));
  fs.writeFileSync(path.join(project, 'A.json'), JSON.stringify({ inputs: plan.inputs, samples: [] }));
  fs.writeFileSync(path.join(project, 'B.json'), JSON.stringify({ inputs: plan.inputs, samples }));
  const checked = await checkTeachingFile(project, { samplesFile: 'B.json' });
  assert.equal(checked.status, 'PASS');
  assert.equal(checked.sampleSource.file, 'B.json');
  const effectiveFilm = { ...raw, dir: project, teaching: { ...raw.teaching, samples: checked.sampleSource.file } };
  const record = createSnapshot(effectiveFilm, filmFile, output, { version: 'test', renderOptions: { teachingSamples: checked.sampleSource.file } });
  assert.equal(record.renderOptions.teachingSamples, 'B.json');
  assert.ok(record.files.some((f) => f.role === 'teaching-state' && f.path === 'B.json' && f.stored));
  assert.ok(!record.files.some((f) => f.path === 'A.json'));
  fs.rmSync(project, { recursive: true });
  const restoredFilm = restoreSnapshot(findSnapshot(record.id, output));
  const restoredRaw = JSON.parse(fs.readFileSync(restoredFilm, 'utf8'));
  assert.equal(restoredRaw.teaching.samples, 'A.json', 'snapshot does not rewrite the source film');
  const restoredCheck = await checkTeachingFile(restoredFilm, { samplesFile: record.renderOptions.teachingSamples });
  assert.equal(restoredCheck.status, 'PASS');
  assert.equal(restoredCheck.inputs.sha256, checked.inputs.sha256, 'restored source binding is portable');
  assert.equal(restoredCheck.sampleSource.sha256, checked.sampleSource.sha256, 'restored state bytes match');
  assert.equal(restoredCheck.sampleSource.file, 'B.json');
});
