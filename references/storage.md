# Disk preflight and bounded cache cleanup

`storagePreflight()` observes available filesystem space and returns an advisory
estimate, with the assumptions in the report. Pass the actual width, height, fps,
duration and whether the renderer streams frames. Sequence rendering reserves raw
RGBA bytes plus PNG overhead; streaming has no persistent frame sequence allowance.
The budget also includes estimated encoded outputs, an audio working buffer and
512 MiB headroom. These numbers are estimates, not measured render requirements.
Source copies, extracted footage, browser caches and third-party tools may require
additional space. A `PASS` cannot guarantee that another process will not fill the disk.

For simultaneous jobs, pass `concurrency` for equal-sized jobs or use the sum of
other jobs' estimates as `reservedBytes`. Independent preflights without aggregate
reservations are not a shared disk reservation system. Heterogeneous batch schedulers
must sum budgets on the same filesystem before launch.

The cleanup API has separate preview and apply calls:

```js
const options = { out: "/absolute/course/out" };
const plan = planCacheCleanup(options); // read-only; serialize this for inspection
// After the caller explicitly selects this frozen plan:
const result = applyCacheCleanup(plan, options);
```

The preview only identifies these rebuildable files:

- `<XDG_CACHE_HOME or ~/.cache>/motion-use/samples/<40 hex digits>.f32`, the
  sampler's decoded audio cache. Original audio files are never included.
- `<out>/.build/<name>-engine/frames/<frame number>.png`, only when the engine
  directory has the exact `.motion-use-build` ownership marker.

It does not remove whole build directories, narration/ASR caches, original assets,
source code, final videos, snapshots, review reports or global uv caches. Unrecognized
files remain untouched, even if they are under a tool directory. A missing marker is
not permission to delete. The list can therefore be small or empty; do not infer that
all project disk usage is reclaimable.

Apply requires the same independently supplied roots and a matching plan checksum,
then verifies every file's identity, content hash and metadata before deleting any.
It rejects symbolic links in the path, files with multiple hard links and changed
ownership markers, and takes the output lock to avoid a concurrent project render.
New files are not swept into an older plan. Failed checks before deletion abort the
whole plan; an unexpected failure during deletion produces a partial report.
Do not intentionally run a competing writer in the cache directories during apply.

`deleted_logical_bytes` measures removed file sizes. The before/after filesystem
observations report available-space deltas separately; APFS snapshots, shared blocks,
open files and concurrent activity mean these deltas cannot be attributed entirely to
this cleanup and must not be presented as guaranteed reclaimed bytes.
