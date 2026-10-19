# Teaching timing and author assertions

A film may declare an optional `teaching` object. It supplements existing rendering,
readability, missing-glyph, collision, audio and delivery checks. It does not certify
mathematics, continuous visual playback, listening or target-device acceptance.

```json
{
  "teaching": {
    "age": 7,
    "unitsPerSecond": 2,
    "minimumReadSeconds": 2,
    "regions": { "label": { "x": 400, "y": 80, "width": 200, "height": 90 } },
    "phases": [
      { "id": "question", "type": "read", "from": 0, "to": 5, "text": "五个点拿走三个还剩几个" },
      { "id": "take-away", "type": "demonstrate", "from": 5, "to": 8 },
      { "id": "count", "type": "think", "from": 8, "to": 11, "reason": "let the learner count the two remaining dots" },
      { "id": "answer", "type": "reveal", "from": 11, "to": 13 }
    ],
    "assertions": [
      { "id": "two-left", "type": "count", "from": 8, "to": 13, "objects": ["d1", "d2", "d3", "d4", "d5"], "region": "board", "expected": 2 },
      { "id": "third-removed", "type": "state", "from": 8, "to": 13, "object": "d3", "expected": { "removed": true } },
      { "id": "no-spoiler", "type": "reveal", "from": 0, "to": 13, "object": "answer", "notBefore": 11 },
      { "id": "safe-path", "type": "avoidRegion", "from": 5, "to": 8, "object": "d3", "region": "label" }
    ]
  }
}
```

All intervals are `[from,to)` in seconds, within the film duration. Phases may overlap
when, for example, reading continues during a demonstration. A thinking pause records
its purpose; it does not waive motion or blank-frame checks. Use the existing explicit
static-pacing reason where appropriate.

`age` is 3–18. The default reading estimate uses 2 units/s through age 7, 3 through age
10, and 4 thereafter, with a minimum of 2 seconds. Each Han character and each other
letter/number run is one unit. These are editable author planning estimates, **not
measured developmental standards or word-level speech alignment**. A short `read`
phase produces a warning; review it with the learner. Narration and action should
still bind to measured cues when available.

## Library integration

`src/teaching.mjs` exports:

- `validateTeaching(teaching, {duration})` → `{errors,warnings}`; undefined configuration is valid.
- `teachingReadingSeconds(text, profile)` → estimated seconds.
- `teachingSampleTimes(teaching, {duration,fps,transitionFrames:3})` → sorted unique output-frame times. Samples every output frame of assertion intervals and consecutive frames before/after phase boundaries and reveal thresholds. Each plan is limited to 100000 frames.
- `await checkTeaching(teaching, {duration,fps,sample})` → structured report with assertion ids, checked intervals, sample counts and failed intervals naming objects and observed/expected values.

The author supplies a deterministic `sample(time)` callback (sync or async):

```js
function sample(t) {
  return {
    objects: [
      { id: 'd3', visible: true, region: t < 8 ? 'board' : 'removed',
        state: { removed: t >= 8 }, bounds: { x: 200, y: 300, width: 20, height: 20 } },
      { id: 'answer', visible: t >= 11 }
      // Include d1, d2, d4 and d5, including when hidden.
    ]
  };
}
```

Share animation values between drawing code and this callback. A separately invented
sampler can agree with assertions while the pixels are wrong. Bounds and protected
rectangles must use the same coordinate system. Counts use explicit `visible` and
ownership `region`, not inferred image recognition. State assertions compare shallow
primitive values in `state`. Reveal assertions reject visibility before `notBefore`;
add a state assertion if visibility after the threshold is also required. `avoidRegion`
checks visible object's sampled axis-aligned bounds against a fixed protected rectangle.
Missing objects, invalid samples and missing bounds fail; absent samplers or intervals
containing no output frame stay `UNREVIEWED`. Hidden objects must still be returned
with `visible:false`.

Reports identify evidence as `author-declared-state`, mark reading timing `estimated`,
and keep visual, mathematical and listening review `UNREVIEWED`. `PASS` means all
provided assertions passed at sampled output frames, never that the whole lesson is
correct or that a human listened. Save independent content checks and visual/listening
review evidence. Render and examine the returned transition times to check the actual
frames, including caption changes and path crossings. Motion blur or effects spanning
frames still need visual review.

`await checkTeachingFile(projectOrFilmJson, {samplesFile,plan:false})` is the file adapter.
A project can set `teaching.samples` to `reviews/teaching-states.json`, or the caller
can provide `samplesFile`. Both must resolve inside the project, including symlinks.
The file format is `{ "inputs": <plan.inputs>, "samples": [{ "time": 0, "objects": [...] }] }`. Each time must
match an output frame exactly (tolerance 1e-8 seconds). Duplicate frame samples are
rejected; missing required frame samples fail, and state is never interpolated.
The report binds the state file's SHA-256 and retains `author-declared-state` evidence.
`{plan:true}` returns `sample_plan` and leaves assertions `UNREVIEWED`, without
opening a declared state file. The library does not mutate the film or write reports.


State files must copy the complete `inputs` object from the current `--plan` result.
The fingerprint binds canonical film JSON (excluding only `teaching.samples` to avoid
a hash cycle), composition source, libraries, fonts/licenses, declared files/assets,
footage sequences, existing audio and voiceover tracks/manifests, and custom music
score files discovered through the render input resolver. A missing or stale binding
is rejected. Regenerate the plan and state samples after changing inputs. This binds
author evidence to a source revision; it still does not prove those states match the
rendered pixels. Inputs supplied to an external renderer outside the project's declared
input contract must be declared as film files to join the fingerprint.

The sampler/file must cover **all** `sample_plan` frames, including transition frames
outside active assertion intervals. `sampleCompleteness` reports expected, checked,
failed and missing/invalid frame times independently from individual assertion status.
A missing transition frame fails the overall report even if assertion frames pass.

Bundled sound effects selected by `audio[].effect` are trusted installation inputs:
the fingerprint records their actual bytes as `@motion-use/assets/sfx/<name>.wav`.
This exception requires the resolved effect track to name the exact bundled file
under the installation's assets directory; it does not allow project symlinks to
arbitrary external files. Projects without `teaching` return `SKIPPED` immediately
without resolving or hashing their other inputs.
