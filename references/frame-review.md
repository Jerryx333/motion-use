# Single-frame feedback

Export a self-contained local page for a still. The reviewer clicks a location,
writes an observation, optionally names an object, and downloads a JSON comment.
The page needs no server, account or network. This is a frame review, not a live
timeline editor or automatic source-code object picker.

```sh
motion-use still ./film --allow-code --at 1 --json
# Use a PNG path returned by still, relative to this film project:
motion-use review page ./film --frame out/stills/.../frame.png --at 1 --out ./frame-review.html
# Open that page, click the frame, enter the change and export frame-comment.json.
motion-use review add ./film --input ./frame-comment.json --json
motion-use review list ./film --json
```

The exported JSON carries the source revision, PNG bytes and the clicked point
in **PNG pixel coordinates**, including when the page scaled the image. It also
carries the declared time and containing shot ID. An object ID is manually
supplied; it is not inferred from pixels. Inline comments are supported too:

```sh
motion-use review add ./film --frame out/stills/.../frame.png --at 1 --x 320 --y 180 --object price --note "Make this number readable" --json
```

Only PNGs up to 20 MiB and 64 megapixels are accepted and decoded by FFmpeg before
recording or export. A header without a complete image is rejected. Inline file paths must remain inside the
project, including symlink targets. Imported JSON is limited to 30 MiB. Export
always uses a fresh HTML path; existing pages are not overwritten.

## Revision and evidence

The revision hashes film.json and the inputs declared to validation/snapshots,
with generated narration excluded for this visual-source check. A changed source,
asset or declared input changes the revision. Source changes invalidate importing
an old page; export a fresh page instead. Existing notes remain visible and are
marked `stale` when their original or addressed revision differs from the current
source.

PNG bytes are frozen by content hash in `.motion-use/review/`; replacing the
original file does not replace recorded evidence. Time is **author-declared**.
Supplying a PNG and a time does not prove that the renderer produced that image
at that time. This tool never upgrades that declaration to measured timing.

After changing the source, render a new still. Read the current `revision` from
`review list`, then explicitly record what changed and the new frame:

```sh
motion-use review done ./film <note-id> --revision <current-revision> --frame out/stills/.../new.png --note "Enlarged the value and added a hold" --json
motion-use review reopen ./film <note-id> --revision <current-revision> --note "Still too small on the phone" --json
```

`done` means `addressed`, an agent statement; `acceptance` remains `UNREVIEWED`.
Both actions preserve their notes and revisions in history. If the film's new
timeline no longer contains the old time, `done` requires a new `--at`.
There is no automatic closure or visual approval, and review status does not
replace release checks. Review writes take an exclusive metadata lock and use
atomic JSON replacement; source files are not edited by these commands. Metadata
symlinks are refused. A crash lock remains for inspection under the existing
output-lock policy.

Batch source fingerprints ignore this operational feedback directory, so adding
a comment does not by itself invalidate a rendered task. If a frame file is a
real rendering dependency, declare that file explicitly as a batch input.

The workflow was informed by huashu-motion's location-bearing comment loop. This
offline frame page and revision/evidence protocol are implemented for motion-use.
