# Persistent batch production

`batch` runs an explicit dependency graph. A successful file from yesterday is
not evidence that today's task completed. Each task must exit successfully,
produce every declared nonempty output, and leave its inputs unchanged. Resume
then checks both input and output content hashes before skipping work.

Example manifest (`tasks.json`):

```json
{
  "schemaVersion": 1,
  "concurrency": 2,
  "tasks": [
    {
      "id": "lesson-a",
      "cwd": "lessons/a",
      "command": ["render", "--out", "rendered"],
      "inputs": ["film.json", "scenes.mjs", "assets"],
      "outputs": ["rendered"],
      "phase": "render",
      "storage": { "width": 1920, "height": 1080, "fps": 30, "duration": 120, "streaming": true }
    },
    {
      "id": "lesson-b",
      "cwd": "lessons/b",
      "command": ["render", "--out", "rendered"],
      "inputs": ["film.json", "scenes.mjs", "assets"],
      "outputs": ["rendered"],
      "phase": "render"
    }
  ]
}
```

Paths are relative to the task's `cwd`, which is relative to the manifest.
`command` contains motion-use arguments, without a leading `motion-use`.
`dependsOn` lists task IDs. Every task requires an explicit, nonempty `inputs`
array; an omitted or empty array is rejected before state or output writes.
Declare all source, audio, timing and configuration
inputs that can affect a result. Include a producer's generated artifact in a
consumer's `inputs`, and declare the producer in `dependsOn`. Changing audio
therefore invalidates timing, renders and their descendants. Independent,
verified tasks remain reusable. Hashes include names and bytes, not mtimes.
Output directories are hashed recursively. Use precise output paths: unrelated
outputs may not overlap, and symbolic links in input/output trees are refused.
An input may contain its output directory (which is excluded from that input
hash), but an authored input may not sit inside its own output directory.
The runtime signature covers motion-use source, CLI and package metadata.
External renderer binaries, fonts, bundled assets copied from elsewhere, tool
configuration and model files need explicit declared inputs or pinned versions;
the scheduler cannot infer undeclared external dependencies or environment edits.

The exported APIs are `planBatch(file, options)`, `runBatch(file, options)` and
`readBatchStatus(file, options)` from `src/batch.mjs`. Options include `dryRun`,
`resume` (default true), `concurrency` (1–64), `stateFile`, `signal`, and `onEvent`.
The normal CLI wiring exposes these through the batch command; inspect
`motion-use batch --help` for the installed version's command syntax.

Planning/dry-run does not create directories or change state. State is stored
under `.motion-use/batch/` next to the manifest, using atomic replacement and an
exclusive owner lock. Never delete a live owner's lock. After a crashed process,
inspect the lock and confirm its owner is no longer running before removal.
Interrupted tasks are not accepted as completed, even if files remain. Failed
tasks block their descendants while independent tasks continue. A later run
retries invalid/failed nodes and reuses verified successes. `resume: false`
forces every task to run. Commands that refuse existing output directories need
their own explicit regeneration option or a fresh output path; the scheduler
does not delete authored or generated files on the user's behalf.

Every subprocess uses an argv array with `shell: false`. Trusted custom tools
can set `executable` on a task, but require explicit `allowExec: true` for every
API call. This is arbitrary local code execution, so review the manifest before
authorizing it. Custom scripts and tool configuration must also be listed in
`inputs`. Logs may contain subprocess output and are private local files; the
operational journal does not copy their contents or argv.

`storage` passes render dimensions, FPS, duration, streaming mode and optional
headroom/bitrate to the common storage preflight estimator. Alternatively,
`estimatedBytes` declares an author-supplied additional disk budget. Use one or
the other. Plans expose the estimate and its assumptions; neither is a measured
peak or a guarantee. Concurrent tasks reserve their estimates against current
free space on the same filesystem. A task waits for running reservations when
needed; without running reservations it fails with an explicit space reason.
Other filesystems have independent budgets. Missing estimates stay unknown and
reserve no bytes. The scheduler never cleans global caches.

`src/journal.mjs` exports `createJournal(file, context)` for existing progress
callbacks and `aggregateJournal(file)` for cross-command reports. Append-only
JSONL records include a run ID, wall timestamp, elapsed time, phase and bounded
operational metadata. Incomplete trailing rows are reported and ignored.
Existing task logs and journals must be regular files with one hard link;
symlink/hardlink targets are rejected before any truncation or append.
`active_processing_s` takes the union of top-level command/task time intervals,
excluding nested phase double counts and cross-run concurrency overlap.
`processing_sum_s` sums those durations and can exceed wall time. These are
observed command intervals, not CPU usage; waiting inside a command cannot be
separated unless it is explicitly measured. Phase durations are reported
separately. Unmeasured waiting, cost and video duration stay null.
The journal records execution and cache reuse; it does not claim mathematical,
visual, listening, or target-device acceptance.
