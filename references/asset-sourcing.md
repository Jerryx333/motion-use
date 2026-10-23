# Find material that can carry the shot

Read this when a film needs footage, photographs, music or sound effects. Plan the
material before committing to the drawing route. A generated office still can
establish a place; pushing into it for a minute cannot supply a minute of action.

## Search for the action and the crop

Start with the script's shot IDs. In project-local `SOURCES.md`, record the object,
action, needed seconds, output crop and room for captions. Look through supplied
files and existing captures first. Use real product fixtures/recordings to prove
behavior; use stock for context and generated images for declared concept shots.
Keep those uses distinct in the cut.

Search with visible attributes rather than the product's abstract promise:

- Footage: `hands typing keyboard dark close up`, `two coworkers office side view`,
  `monitor desk daylight slow dolly`. Add `vertical` or `copy space` when useful.
- Music: `minimal electronic instrumental dry percussion 100 bpm`, `restrained
  documentary pulse no vocals`, `warm acoustic sparse underscore`. Include the
  speech density, energy arc and desired ending in the need, not just “cool music”.

For each materially different need, keep a small useful shortlist, usually 2–3
candidates. Note the selected source and why the others lose: crop, action, quality,
licence, a vocal fighting speech, an unusable ending. Do not accumulate dozens of
links after a suitable source has been verified.

## Use chrome-use site adapters for discovery

When chrome-use is available, load its skill and `chrome-use skills get core`.
Use one task session; run browser operations sequentially in that session.
Discover commands rather than guessing provider names:

```bash
chrome-use site list --json
chrome-use site info google/search --json
chrome-use --session film-sources site google/search \
  'site:pexels.com/video hands typing keyboard dark close up' --count 5 --json
chrome-use --session film-sources site google/search \
  'site:pixabay.com/music minimal electronic instrumental' --count 5 --json
```

These are discovery queries, not recommendations of a particular asset or proof
of its licence. `google/search` exposes candidate titles/URLs; inspect the result's
actual success and count, including empty/partial results. If it is not installed,
use the available search tool or the site's browser search. Do not invent
`pexels/search` or `pixabay/music` adapters. A matching provider adapter listed by
`site list` can replace this route after `site info` confirms its arguments and
read-only behavior. Do not install third-party executable adapters just to search.

Open candidate detail pages and the applicable licence with `read` or `open` and
`snapshot`/`get text --main`. A failed public `read` may still work as a visible
browser page. Review the image/video preview as well as extracted text. Follow
the installed chrome-use guide for downloads; use the provider's offered file,
not a guessed CDN path. If access is blocked, inspect the actual page once and
switch source or leave the candidate unresolved rather than retrying blindly.

Search, detail-page inspection and download are separate outcomes. A YouTube,
Bilibili, Douyin or Pinterest result can be a reference; it is not automatically
licensed stock. Keep account actions, publishing and purchasing outside source
discovery. End with `chrome-use --session film-sources done`; keep only a page the
user needs. Without chrome-use, follow the same selection/evidence workflow using
available browsing tools; it is an authoring aid, not a renderer dependency.

## Freeze the selected files

For each used asset, record in `SOURCES.md`:

- Shot/use, detail-page URL, creator/title, licence URL and date checked; attribution,
  commercial/platform limits and any additional restrictions that affect this use.
  A catalogue's “free” label or a search snippet does not establish permission.
- Local project-relative file and SHA-256; measured dimensions, fps/duration or
  audio channels/sample rate. Inspect early/middle/late frames for crop, watermarks,
  baked text and whether the promised action actually occurs.
- Exact source in/out points, target shot ID, speed/hold/loop decisions, crop and
  mute/mix choice. Download enough real action for the window; `hold:last` is an
  intentional reading hold, not an invisible way to extend a short clip forever.
- Selection reason and remaining unknowns. Preserve the provider's licence or
  download certificate when available. Music marked Content ID registered needs
  the provider's stated clearance process recorded; do not promise claim-free use.

Use `ffprobe` to measure the downloaded bytes, not the search result:

```bash
ffprobe -v error -show_entries format=duration:stream=codec_type,width,height,r_frame_rate,sample_rate,channels \
  -of json assets/stock/selected.mp4
```

Mirror the used files into film.json `provenance` with `sourceUrl`, `license` and
`useBasis`; put the checked licence URL/date and credits in `useBasis` or the linked
record. Leave unknowns explicit. See [film.md](film.md) for the schema. `handoff`
computes file hashes; it does not adjudicate licences. Rendering uses frozen local
files and must not depend on a signed URL or a browser session.

If media-use is installed, it can resolve catalogues or ingest selected media.
Read its installed skill first; provider/auth support depends on that version.
Its manifest is useful evidence, not permission or a reason to bypass comparison.
Copy the selected file and relevant provenance into the film project. Do not add
a hard dependency on the latest HyperFrames or replace motion-use's pinned engine.

## Choose the music against speech and picture

An existing track and an authored `score.js` are both valid. Choose by the actual
sound and the film, not by whichever route the starter already uses. For a stock
route, compare the promising tracks against the same representative 10–15 seconds
of narration and picture. Prefer instrumental space under speech; check the intro,
the main beat/reveal and the ending, not just a catalogue preview's loudest moment.

Record which file/range was auditioned, by whom, with or without picture/voice, the
selected offset, and what remains unlistened. If the agent cannot hear playback,
mark listening UNREVIEWED and provide the candidate clips/mix for review; waveform,
genre metadata and ASR do not count as auditioning. Do not claim “best sounding”.

Once a track is selected, use `motion-use beats assets/music/selected.wav` to
estimate the beat grid. Check it by ear; do not reshape every cut to an uncertain
BPM. Generate/import narration and `retime` before locking picture accents and
audio placement. Set imported music using the existing film contract:

```json
"music": {"file":"assets/music/selected.wav", "volume":0.25, "bpm":104, "from":1.2}
```

The numbers above are illustrative, not a mix preset. `from` is the song offset at
film second zero; root `bpm` takes precedence, so update/remove a stale starter
value. Confirm the selected range covers the cut or make a deliberate musical
edit. Use shot-anchored `audio` clips with `role:"music"` for sections when needed;
see [film.md](film.md). Test the voice-heavy moment and ending in the real mix,
then check final loudness/peak and narration presence. Ducking and -14 LUFS cannot
establish intelligibility or musical quality. For authored music, continue with
[music.md](music.md); keep both routes under the same listening review.

## Review the event, not just the environment

Test the central causal sequence as a short moving range before the full render:
problem → action/question → response → changed result. A beautiful monitor with
tiny text, a blank sender card, or two code values shown together does not prove
the action. Make the question readable, the reply arrive, and the field visibly
replace the old value. Let the camera follow that change, then hold for reading.

If movement checks and reviewers keep finding a slideshow, change the source or
shot construction instead of adding drift to the same still. Record playback,
sampled-frame and listening coverage separately. For range tests, use a distinct
output directory (`--out out/range-ask`) from the full render (`--out out/final`),
so their review directories remain separate. Keep source evidence and reviews;
clean only task-owned reproducible caches after verifying the retained master.
