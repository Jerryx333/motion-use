---
name: motion-use
description: Direct and render local videos with an AI coding agent — launch films, motion graphics, data stories, explainers, product walkthroughs, kinetic type, graphics over footage; Chinese/English, landscape/portrait. Writes short exact-time drawing code with a kit of helpers (camera, charts, counters, callouts, captions, handwriting, footage), renders MP4s and checks the delivered file. Also has scene templates for quick factual explainers. Use for 宣传片、推广视频、讲解视频、产品视频、数据动画, launch videos, branded motion and social clips. Does not generate photorealistic footage from text or transcribe raw footage.
---

# motion-use

The agent directs the film; motion-use handles assets, exact-time rendering, fonts, narration, music and delivery checks.

```bash
motion-use --version || curl -fsSL https://raw.githubusercontent.com/leeguooooo/motion-use/main/install.sh | sh
motion-use doctor
```

## 1 · Plan

Unless the user specifies a location, create films with `motion-use init <name>` under
`~/motion-use/<name>/` (override `MOTION_USE_PROJECTS`; `MOTION_USE_HOME` is the CLI installation).
Use `motion-use list --json` to find past projects; explicit paths such as `./draft` still work.
Do not place new film projects in a product source repository by default.

Before authoring film.json, drawing code or generating speech, write and review `SCRIPT.md`:
opening frame/first line, shot actions with source evidence, spoken and displayed copy,
screen text and ending action. Init's generated files are scaffolds. Save pass/revise plus
concrete edits in `reviews/01-script.md`; fix failed points before production. The reviewer
gets only text at this stage. Check whether the opening earns attention, each line maps to
an action, claims are supported, wording avoids filler/repeated patterns, and the ending
acts on the subject. Continue through keyframe review, range-draft rhythm review and final
MP4 review, giving each reviewer only that stage's artifacts. See production.md for inputs
and review records; a user-approved script counts as reviewed without another approval gate.

Use the user's subject, material and existing project; verify product claims against the source or real behavior. An invented UI, cursor walkthrough or process illustration must not pass as a real recording or real terminal output; say it is an illustration. Ask only for decisions that change the result.

Read [references/production.md](references/production.md) for direction selection, feature-to-shot mapping, speech timing, review and editable delivery. When direction is open, compare A (direct), B (another medium), C (another telling) in project-local `DIRECTIONS.md`; render one representative frame each, or 2–4 seconds when motion decides the choice. Record an existing choice or delegation and continue without another gate. Do not make three full films. Map every required fact/feature to source evidence, a stable shot ID, its visible state change and final review evidence in `DIRECTOR.md`.

`motion-use catalog styles|shots` lists original cards; `catalog --out <fresh-dir>` creates a browsable, scrubbable gallery. `study <id> <fresh-dir>` creates the same mechanism as a renderable six-second silent film. Read the card's parameters and pitfalls before adapting it. These are illustrative studies, not a substitute for the subject's real material or a finished film.

Use `catalog recommend --product-type developer-tool --material screenshot` (or the relevant declared type) to expose fit conditions and reasons, not audience-response scores. See [catalog-selection.md](references/catalog-selection.md). Before coding every move, choose a continuous, montage or hybrid route and plan where intensity changes. Optional `film.json.rhythm` phases/events are checked by `motion-use rhythm <film> --json` and ordinary validation; they remain author declarations, with visual/listening review UNREVIEWED. Missing events/tempo stay unknown. `M.rhythmEvent(id)` / `S.rhythmEvent(id)` share an absolute landing time for drawing and music. Contract and retime limits: [rhythm.md](references/rhythm.md).

For footage, photos, BGM or SFX, read [asset-sourcing.md](references/asset-sourcing.md) before committing to a drawing route. Start from shot actions and crop/speech needs; keep a small candidate shortlist in `SOURCES.md`, inspect previews, check the applicable licence, and freeze selected files locally with source/creator/hash and measured media properties. Use chrome-use's listed read-only `site` adapters for discovery when available (`site list` → `site info` → search), then inspect the actual provider page. Search results are candidates, not clearance or playback evidence. The renderer stays browser-independent.

`motion-use init <name|path>` writes `SCRIPT.md`, `SOURCES.md`, `film.json`, `composition/draw.js`, `composition/score.js` and `DIRECTOR.md`. The starters are studies to replace, not a template to re-skin: a film laid out like it is flagged (`demo_similarity`).

- Lock `look`: one style sentence, one palette, the character approach (none, hands, footage, generated frames — not code-drawn mascots).
- Direct the music with the look: compare a suitable licensed track or an authored `composition/score.js`, where it is sparse, where it peaks and which picture events it hits. Audition with the actual narration/picture; record listening UNREVIEWED if playback was not heard. A built-in mood is the same bed in every film and `--release` refuses it without `music.why`. [references/music.md](references/music.md).
- Each shot names an object you could point at, what *it* does, its `camera` move and the ≤ 8 words on screen. Open on a concrete small scene; end on an action on the subject, not a centred card; keep one example through the film.
- Words go in `copy` per language, numbers and series in `data`, images in `assets`, footage in `videos`. Changing one value then changes one thing.
- Fill the brief fields first: `motion-use init <dir> --subject … --purpose … --audience … --tone … --palette … --length 30` (or edit `film.json` → `brief`); `validate` lists any field still a TODO.
- Given a gallery entry (a prompt-motion.com page), run `motion-use reference <url>`: it saves the credits, the prompt or skill, the video and its breakdown in a git-ignored `references/<slug>/`. The prompt belongs to its creator: study it, write the brief in your own words, credit borrowed techniques in DIRECTOR.md, never paste it into a deliverable or commit it.
- Given a reference video, run `motion-use breakdown ref.mp4` first and learn the mechanism, not the pixels. Pick an explainer look from [references/grammars.md](references/grammars.md) by what the narration explains.
- Cutting to a song or building a UI-morph loop: ask for the inputs in [references/briefing.md](references/briefing.md), run `motion-use beats song.wav`, and show the shot list on the beat grid before writing code.

## 2 · Write the drawing

Read [references/kit.md](references/kit.md) — one page that covers most films. `M.shoot`, `M.chart`, `M.counter`, `M.callout`, `M.words`, `M.stamp`, `M.cover`/`M.video`, `M.cursor`, `M.spotlight`, `M.signature`, `M.captions` and the timing helpers keep a film to a few kilobytes; write custom drawing where the subject needs it. Move on events: hold → 0.28 s push / 0.30 s pan / 0.17 s slam → hold. Springs by damping ratio: `M.springZeta(t, 0.8)` premium, 0.5 playful, 1 no bounce; opacity and colour never bounce. In portrait, keep text and the key action inside `view.safe` (platform UI covers the top, bottom and right) and check with `still --guides`. Make subjects big and high-contrast. Directing method and failure modes: [references/directing.md](references/directing.md). Full contract: [references/film.md](references/film.md).

Films render with the native renderer (motion-render, installed by install.sh; `doctor` shows it): about twice as fast as Chrome for 2D, many times faster for WebGL/three.js (drawn on ANGLE, the GL layer Chrome uses, on the GPU), same frames, same checks. A missing binary or missing ANGLE libraries, WebGPU, or `--gpu` render in Chrome automatically; `--renderer chrome|native` forces one. Leave `--workers` alone: motion-render starts at the machine's performance cores and keeps adding workers while frames come out faster (processes for WebGL on the GPU, threads for 2D), remembering the count per film; `--workers n` only caps it. Results and reports name the `renderer`, and `native` in `--json` says what it settled on (`workers`, `processes`, `ms_per_frame`). Iterate on `--from/--to` drafts: a full `--release` spends most of its time in the x264 veryslow master encode, not in drawing. Contract: film.md → Renderers.

3D or another renderer: models, HDRs and decoders go in `files` (a three.js loader fetches `window.filmFiles.<name>`); a scene that belongs in Blender, Unity or Godot runs as `"engine": {"type": "command", "command": [...]}`, which renders PNG frames (or, with `"stream": true`, raw RGBA into a FIFO) from a job file while motion-use keeps sound, delivery checks and release. Draw subtitles in `composition` as a transparent overlay so the text check still measures them. Contract: film.md → External engines.

For real product material, first look for screenshot tests, a headless renderer or Storybook; render repeatable source frames rather than occupying the user’s screen. `videos.<name>.frames` accepts lossless numbered images directly. Footage/audio can anchor to a `shot`; `hold:last` retains a clip’s final frame. See film.md for timing contracts.

Narration is required by default. Before generating a full film, read [voice-casting.md](references/voice-casting.md): choose the model, voice and performance for the audience/content, compare same-script samples with `voiceover audition`, and record actual listening coverage. Available credentials and the default Azure/Edge voice are preview conveniences, not a quality choice. A trusted `command` bridge supports other TTS models; imported recordings remain supported. Keep a user-selected voice unless asked to change it.

Write narration per shot (each language), using `{say,text}` when pronunciation differs from displayed copy; `captionStyle.split` selects sentence (default), shot or cue. Then generate only the selected voice with `motion-use voiceover <dir>`; it must fit its shot window, so shorten the script or retime the shot, never truncate. `M.captions(c, t)` draws subtitles from it. `voiceover:false` only when the user wants a silent film.

`voiceover --json` reports actual clip paths, formats, seconds and window fit. Mark a shot `"duration":"narration","tail":0.4`, generate the voice, then `motion-use retime <dir>` returns a fresh numbered proposal (read its `film` field) with frame-aligned windows; the original and brief target are preserved. Use `--keep-captions` to shift explicit captions contained within one shot (overflow is an error). `pace:1.25` plus regenerated voiceover and retime speeds speech and tails; use `M.shotTime(t,id)` with `retime --scale-timing` / shot `authoredDuration` for choreography and scaled `S.at` offsets. Do this before placing absolute-time audio/cues/footage; shot-anchored audio/footage follow the new windows. With Azure, opt into `voiceover --engine azure --word-timing` for measured word boundaries (optional pinned SDK via uv). `M.at('phrase', {shot:'id'})` uses only cache-matched service timestamps; missing/ambiguous timing throws. For imported or manually checked timing, declare `captions.<lang>` and `cues.<lang>` and use `M.cue('slug')`, preserving estimated flags. Never call sentence interpolation measured word timing.

Lock music placement after `retime`, against the final shot windows. For imported tracks, use `music.file`, inspect `motion-use beats <audio>`, and choose the source offset and ending deliberately. For an authored score: `S.why(…)`, instruments from `motion-use instruments`, a mode, an `S.arc` over the shots, accents at picture events, melody kept out of narration. `motion-use music . --allow-code` renders a score alone with notes per shot. Listen to either route against speech and picture; technical checks do not approve the sound. Contract and helpers: [references/music.md](references/music.md).

For geographic explainers, `motion-use geo world --out map.json` projects the bundled illustrative Natural Earth boundaries; `geo china-provinces` uses 34 geoBoundaries ADM1 units from 2019 and requires the output attribution in film credits; pass a local GeoJSON/TopoJSON for your own data. Load the compiled JSON through `files`; `M.map`, `geoPoint`, `route`, `arrow`, `pin` and updating `list` handle generic map motion. Use actual historical geometry for historical boundary claims. Custom `fonts` need a local font and licence file; `captionStyle` configures subtitle plate/size/position. Contract and limits: film.md.

## 3 · Iterate cheaply

```bash
motion-use validate <dir>                                   # plan warnings, glyphs, narration fit
motion-use still <dir> --allow-code --shot <id>             # three frames of one shot
motion-use still <dir> --allow-code --beats 4               # one frame per bar; warns if drawing keeps state
motion-use still <dir> --allow-code --onion 4.4-5.2         # a move's frames in one PNG: even ghosts = linear, bunched = eased
motion-use preview <dir> --lang en --format vertical       # browser review of picture, pacing and narration; no MP4
motion-use render <dir> --allow-code --from 3 --to 7        # silent draft of a range
motion-use render <dir> --allow-code --quality draft --json # compact summary
```

Read the numbers first; open an image when they do not settle it. Fix clipping, crowding, unreadable text and decoration that does not explain. Stills cannot prove timing: watch a draft.

For frame-specific feedback, export `review page <film> --frame <project-local.png> --at <seconds> --out <fresh.html>`. The offline page lets the reviewer click a position and export a JSON note; import it with `review add <film> --input <comment.json>`. `review list` reports revision/staleness; `review done` requires the current revision, a new PNG and a change note, and records only addressed/UNREVIEWED. Reopen unresolved notes. A time attached to a supplied PNG is author-declared, never assumed renderer proof. See [frame-review.md](references/frame-review.md). No live editor or automatic source-object picking is implied.

`--allow-code` is for projects you wrote in this task or the user trusts; code runs in the renderer and lint is not a sandbox.

## 4 · Deliver

```bash
motion-use render <dir> --allow-code --quality high --json
motion-use render <dir> --allow-code --release --json    # what goes to platforms: out/release/ + manifest
motion-use verify --manifest <dir>/out/release/release-manifest.json <file.mp4>   # before every upload
motion-use voiceover check <dir>          # whisper hears each clip; flags misreads
motion-use verify <file.mp4> --json      # any MP4, without re-rendering
```

For editing, render `--no-captions` and/or `--no-bgm` variants (distinct filenames), then `motion-use handoff <dir> --out <fresh-dir>`. The handoff has SRT, separate source audio, a shot timeline, declared inputs, provenance and hashes; it is not a native editor draft. Subtitles drawn with `M.captions` are suppressed, custom text and baked footage text remain. `handoff --check --out <package>` verifies exported bytes. Check source permissions separately. Source declarations go in `film.json` → `provenance`.

A single film can run 1–3600 seconds with a continuous soundtrack (native streams the whole timeline). For independently produced parts, render matching parts, write `parts.json` with `{name, parts:[{file, from?, to?, manifest?}]}`, then `motion-use concat parts.json --out <fresh-dir> --release`. It checks supplied part manifests, normalizes the full soundtrack, measures join windows and writes a master with part hashes/snapshots and a release manifest. Watch and listen across every join; measurements do not establish continuity. Remote rendering and safe synchronization are documented in film.md.

Render writes MP4s, covers and `review/<id>/report.json` measured on the delivered file: decode, duration/fps/size, loudness (-14 LUFS / -1 dBTP), narration present in the mix, and motion lights. For standard/high, release and gate renders a red light fails delivery; drafts retain red lights as warnings and exit zero if other checks pass: slideshow pacing, empty mid-film frames, mostly blue-purple. Fix the film; use `--allow-static "reason"` / `--allow-blue-purple "reason"` only when the subject needs it, and tell the user.

Use `M.texture(c, ctx => {...})` only for decorative text; its scope is exempt from text checks. Aligned same-font substring colour repaints are recognized; draw segmented prefix/highlight/suffix for complex layouts. Render also checks what eyes miss: every narration clip is transcribed and compared with its script (a flagged line names the misread: "AI" spoken "A-A-I" → write "A I"; 重试 heard 重视 → 再试), and every drawn string is measured against the frame and, in portrait, the safe area (text off the edge for 0.3 s or more is reported with its time), and two strings drawn over each other while both are visible are reported too (a cross-fade that stacks the old and new line for a few frames). `--gate` makes these fatal. It also warns when a line goes before it can be read (0.3 s per word, 0.15 s per CJK character, + 0.5 s) or falls under WCAG contrast against what is behind it (4.5:1, large text 3:1); a film flashing more than three times in a second (WCAG 2.3.1) gets a red motion light. Each render keeps its exact inputs (film, code, voiceover clips) as a snapshot; `render --snapshot <id>` rebuilds that cut after the narration changed. Publish only files from `--release` (x264 veryslow CRF 16; a ≤45 MB X copy when needed), and check each with `verify --manifest` so a stale or README-sized cut never goes out.

A technical pass is not visual approval. Before delivering, have someone who did not make the film review it: spawn a fresh agent with only the MP4, its contact sheet and the intended takeaway; it writes timecoded issues into `<dir>/reviews/<round>.md`. Turn each note into numbers (directing.md has the table) and add any default the render used anyway to `reviews/banned.md`. After three substantial passes, disclose what remains. Keep feedback and `## Lessons` (do / evidence / why / when) in DIRECTOR.md. Report exactly what was measured, what was watched and what was not listened to. Do not publish unless asked.

## Multi-lesson projects

Read [references/course-workflow.md](references/course-workflow.md) for batch recovery, narration models, chapters, storage, teaching assertions and portable delivery. Before a large batch, confirm the target viewing device and test one full lesson there.

- Pin `film.json` → `narrationCheck` model/params. `fallbackModel` checks flagged clips only; optional `narrationCheck.terms` supplies proper-name hints to Whisper (cached separately, never a pronunciation waiver); automatic comparison is separate from human listening. `voiceover check --out <fresh-review.html>` shows both transcripts and local audio. Narrated release/gate rejects skipped/incomplete ASR unless `--allow-asr-skip "reason"` records an explicit waiver; actual mismatches need correction or an exact review record.
- `batch plan|run|status <tasks.json>` uses explicit inputs/outputs/dependencies, persisted results and hash-verified resume. Inputs must include all source/config/audio dependencies; existing files alone are insufficient.
- `concat` accepts part titles and emits frame-based chapter sidecars/MP4 chapters. `delivery <config.json> --out <fresh-dir>` packages videos, desktop offline folders or site files; `delivery --check --out <package>` verifies local integrity/decoding. Do not claim device compatibility without target-device playback.
- `preflight <film>` estimates storage. `clean plan` previews only owned rebuildable caches; `clean apply <plan.json>` revalidates the frozen plan. Never remove global caches or review evidence as a production shortcut.
- `stats <film>` reports recorded wall/processing time; unrecorded waits/cost are unknown. Teaching assertions use author state, supplement ordinary checks, and cannot establish mathematical or pixel correctness.

## Scene templates

For quick information cards or an existing `brief.json`: `motion-use init <dir> --mode template --style explainer`, then `validate`, `still`, `render` on `<dir>/brief.json`. Schema: [references/brief.md](references/brief.md); narratives: [references/stories.md](references/stories.md).

## Rules

- Rendering is local; narration generation uses the voice service. Update checks run at most daily (`MOTION_USE_NO_UPDATE_CHECK=1` disables them).
- Preserve user files; motion-use never overwrites outputs it did not write. Do not run two jobs on the same output folder.
- Missing edge-tts: `uv tool install edge-tts`, then retry. Never disable narration as a workaround. edge-tts is a preview voice; public videos need suitably licensed speech (Azure).
- Install and update through GitHub Releases; `motion-use upgrade` refreshes the CLI and this skill.
