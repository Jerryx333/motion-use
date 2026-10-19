# motion-use

English | [中文](README.zh-CN.md)

Direct a film with your coding agent: plan the action, author exact-time animation, render locally, then inspect the delivered MP4. Chinese/English, landscape/portrait/square, local fonts and assets. Scene templates remain available for quick explainers.

The promo below was directed and rendered with motion-use itself (60 s, 60 fps, English narration with burned-in subtitles). Everything on screen is real: films made with motion-use, the code behind one of them, and actual `verify`, `still --guides` and `voiceover check` output. [Source and director notes](examples/motion-use-film/). The earlier three.js promo is in [examples/motion-use-promo](examples/motion-use-promo/).

https://github.com/user-attachments/assets/4176ad22-c992-4c6f-ad7d-1dc50906fa96

A directed example: [OCS — a message crosses the gap](examples/ocs-film/film.json), with its [drawing code](examples/ocs-film/composition/draw.js) and [director notes](examples/ocs-film/DIRECTOR.md).

**Showcase: yarn relay (three.js).** Six felt monsters relay a ball of white yarn; the thread it pays out draws the OpenAI blossom, puffs into plush rope and stands up; the lights go out, six coloured lights run along the yarn and sum to white; a flash takes the group photo. 40 s at 60 fps, with the score and sound effects synthesised in code. [Source and director notes](examples/openai-yarn-film/).

https://github.com/user-attachments/assets/5bf4053f-9243-48cc-b8f2-ecd2dccc7e79

```bash
curl -fsSL https://raw.githubusercontent.com/leeguooooo/motion-use/main/install.sh | sh
motion-use doctor
```

Part of the [*-use family](https://github.com/leeguooooo/plugins): tools that give AI agents hands. The bundled skill teaches an agent to go from "make a launch video for X" to a brief, keyframes and finished MP4s.

## Directed films (default)

```bash
motion-use init my-film --name my-product --lang zh,en --format landscape,vertical \
  --subject "a paper boat app" --purpose "App Store preview" --tone "calm, precise" --length 30
motion-use reference https://prompt-motion.com/<entry> my-film  # study a published piece: credits, prompt, breakdown
# direct the film in DIRECTOR.md, film.json and composition/draw.js
motion-use validate my-film
motion-use voiceover my-film                 # narration per shot; cached
motion-use still my-film --allow-code
motion-use render my-film --allow-code --quality high --json
motion-use render my-film --allow-code --release  # platform masters + manifest in out/release/
motion-use breakdown reference.mp4           # learn from a reference: cuts, beat grid, heatmaps
motion-use beats song.wav                    # cut to a song: tempo, first downbeat, the drop
```

**Short code, varied films.** A kit of helpers keeps a film to a few kilobytes of drawing code: a pulse camera, charts and counters that read numbers from `film.json`, callouts, kinetic words, stamps, handwriting, a cursor and spotlight for walkthroughs, footage under graphics (`videos`, frames extracted at build time) and subtitles timed from the narration. The starter film shrank from 7,008 to 3,053 bytes with the same picture. Three examples in three looks show the range: a [data story](examples/data-story/), a [whiteboard](examples/whiteboard/) and [kinetic type](examples/kinetic/). Iterate cheaply with `still --shot <id>` and `render --from 3 --to 7` (a silent draft of a range); a film laid out like the starter is flagged so it gets redesigned, not re-skinned. One-page guide: [references/kit.md](references/kit.md).

**Directing, not decorating.** `film.json` locks one `look` (a style sentence, a palette, the character approach). Each shot names an object, what it does and its camera move, and validation flags slideshow habits: presentation verbs, text-led openings and endings, the same move three times, no fast move at all, blue-purple palettes. The drawing kit gives `draw.js` a pulse camera (hold → 0.28 s push / 0.30 s pan / 0.17 s slam → hold), easings and springs, 12 fps stepping, hand-drawn lines, whiteboard writing, palettes and paper texture. After rendering, motion lights measured on the MP4 fail a film that reads as a slideshow, has empty mid-film frames, or is mostly blue-purple, unless you record why. The method follows [huashu-art-motion](https://github.com/alchaincyf/huashu-art-motion) (MIT); see [references/directing.md](references/directing.md) and the eight explainer looks in [references/grammars.md](references/grammars.md).

The agent writes the choreography; the CLI does not turn every paragraph into a scene. Shots have a purpose and visible action. The drawing is a pure function of time, so a shape can carry between shots, the camera can follow it, and motion can align with the audio beat grid. Narration is required by default: write it per shot, then generate or import the speech. Render automatically generates missing narration; it fails if speech is missing, overlong or absent from the delivered mix. Use `voiceover:false` only for deliberately unnarrated films. Optional subframe sampling adds motion blur. Fonts and named images preload; local browser bundles can prepare more complex renderers.

The starter is an editable drawing study, not a finished ad. Replace its choreography for the subject. The [OCS film](examples/ocs-film/film.json) demonstrates another approach: large agent names compress into endpoints; one message travels, expands into a wake pulse, then resolves into the wordmark. It is an illustrated workflow, not a recording of actual message delivery.

`--allow-code` is for drawing code you wrote or trust. It executes inside the renderer; static lint is not a security sandbox. Ordinary text remains JSON data. Named files are copied individually, so a composition folder's secrets and unrelated files do not enter the build.

Every render also writes a cover, a contact sheet sampled from the **delivered MP4**, and a technical report: decoding, actual duration/FPS/dimensions, audio presence, loudness/peak, per-shot RMS, dark/still intervals, motion lights. It never labels an encode as aesthetic approval: `visual_review` remains pending until a person/agent watches and reviews it. Canvas text is not covered by DOM layout audits. Audio uses two-pass normalization to working -14 LUFS / -1 dBTP targets; `--no-normalize` preserves original levels.

**Checks that eyes miss.** Render transcribes every narration clip with whisper and compares it with the script, flagging misreads such as "AI" spoken "A-A-I" or 重试 read as 重视 (`voiceover check` runs it alone). It measures every drawn string against the frame and the portrait safe area and reports text that runs off the edge or lands on other text (a new line appearing where the old one is still fading out), with its time. It also warns when a line leaves the screen before it can be read (0.3 s per word, 0.15 s per CJK character, plus 0.5 s) or sits on a background under WCAG contrast, and the motion lights fail a film that flashes more than three times in a second (WCAG 2.3.1). Each render keeps its exact inputs as a snapshot (`render --snapshot <id>` rebuilds that cut after the narration changed). `render --release` writes the files for platforms — x264 veryslow CRF 16 masters, a ≤45 MB copy for X when needed, covers — and a `release-manifest.json` of their hashes; `verify --manifest` proves a file is the current master before you upload it.

**Not tied to one renderer.** `files` hands any local file (glb, vrm, hdr, wasm…) to a browser library as `window.filmFiles.<name>`. `"engine": {"type": "command", "command": ["blender", "-b", "-P", "scene.py", "--"]}` lets an external engine draw the picture: motion-use writes a job file, the command writes a PNG per frame, and everything after it is the same — sound, a composition drawn on top as a transparent overlay (subtitles over 3D, still measured by the text check), delivery checks, snapshots and release masters. `--workers 4` splits the frames across four processes; an engine that declares `"stream": true` writes raw RGBA into a FIFO that FFmpeg encodes as it arrives, and `"parallel": true` gets one process with four threads. The job contract is in [references/film.md](references/film.md#external-engines).

Full drawing/audio contract: [references/film.md](references/film.md). For an existing MP4, `motion-use verify file.mp4 --json` creates a review report without re-rendering it.

## Scene templates

```bash
motion-use init my-video --mode template --style promo        # or --style explainer
# edit my-video/brief.json
motion-use validate my-video/brief.json      # errors with JSON paths, timelines, missing glyphs
motion-use still my-video/brief.json         # one PNG per scene + a contact sheet
motion-use render my-video/brief.json        # my-video/out/<name>-<lang>-<format>.mp4
```

A brief is a list of scenes: `title`, `terminal`, `steps`, `diagram`, `features`, `image`, `video` (screen recordings), `stat`, `compare`, `kinetic`, `code` or `cta`, each with its own layout and transition options, and text per language:

```json
{
  "version": 1,
  "name": "my-tool",
  "style": "promo",
  "languages": ["zh", "en"],
  "formats": ["landscape", "vertical"],
  "voiceover": { "dir": "voiceover" },
  "scenes": [
    { "id": "hook", "type": "title", "title": { "zh": "验证码到底在哪个邮箱？", "en": "Which inbox has the code?" } },
    { "id": "demo", "type": "terminal", "lines": [{ "cmd": "mail-use code --since 10m" }] },
    { "id": "cta", "type": "cta", "title": "mail-use", "url": "github.com/leeguooooo/mail-use" }
  ]
}
```

Full schema: [references/brief.md](references/brief.md). Examples: [examples/](examples/) (`ocs` and `mail-use` promos, a `chrome-use` explainer).

## What you get

- **Two looks.** `promo`: dark, glowing, a sound on every beat. `explainer`: light paper, calm, steps that highlight in turn and diagrams that draw their arrows. `theme.accent` sets your brand color.
- **Voiceover.** Put recordings at `voiceover/<lang>/<scene-id>.mp3`, or write `narration` per scene and run `motion-use voiceover` (Azure AI Speech, or edge-tts as a preview). Each scene grows to fit its narration; narrations never overlap. Without any, the video still renders, with music.
- **A real cover.** Frame 0 is the finished first scene, so players and feeds show a thumbnail instead of a black frame; `render` also writes it as a PNG.
- **Real footage.** `video` scenes play your own screen recordings (trimmed, sped up); `image` scenes show screenshots or illustrations made with [image-use](https://github.com/leeguooooo/image-use). Both can highlight a region (everything else dims) and zoom into it.
- **Your brand.** Logo on the cover, end card and (optionally) every scene; a full color palette with contrast checks; your own fonts, subset per video, with their license.
- **Vertical safe areas.** 9:16 keeps text clear of the like/share column and the caption block.
- **Reproducible and local.** Same brief, same video: bit for bit (software rendering), except that frames of a recorded clip can differ by invisible noise. Animations are CSS that [HyperFrames](https://github.com/heygen-com/hyperframes) seeks frame by frame; fonts ship with motion-use and are cut to the characters each video uses; each film's music is written for it (`composition/score.js`) and played with recorded CC0 instruments. Rendering loads nothing from the network and runs the engine with telemetry off (`HYPERFRAMES_NO_TELEMETRY`, `DO_NOT_TRACK`). The CLI checks GitHub for a newer release at most once a day; `MOTION_USE_NO_UPDATE_CHECK=1` turns that off.
- **Safe with untrusted text.** Brief text is always drawn as text, never HTML. Custom HTML scenes exist for when templates are not enough, but render only with `--allow-custom-html`. motion-use never overwrites output files it did not write (`--force` to override).

## Requirements

motion-use is a Node.js program with an optional native renderer: films draw in `motion-render` (Rust, Skia, V8; WebGL and three.js on ANGLE, the GL layer Chrome uses; frames piped straight into FFmpeg, about twice as fast end to end for 2D films and many times faster for WebGL ones) and fall back to Chrome when the binary or its ANGLE libraries are missing.

- Node.js 22 or newer (the installer checks)
- FFmpeg (`brew install ffmpeg`, `apt install ffmpeg`)
- motion-render: installed by install.sh from the same release (macOS and Linux, arm64 and x64), with the ANGLE libraries it uses for WebGL
- Chrome: your installed Chrome, or `motion-use doctor --install-browser` (scene templates, the reference renderer, the fallback)

Verified on macOS (Apple Silicon). The CI workflow runs the tests and a real render on macOS and Ubuntu. Windows is not supported yet.

The installer downloads the release archive and its `.sha256` from GitHub, verifies it, and runs `npm ci` from the bundled lockfile into `~/.local/share/motion-use` (dependencies come from the public npm registry; no account or token). Options are at the top of [install.sh](install.sh).

## Commands

| Command | |
|---|---|
| `init [dir]` | Directed film by default; `--mode template` selects a starter brief: `--style`, `--name`, `--lang zh,en`, `--format landscape,vertical` |
| `validate [brief]` | Check the brief, files, voiceover lengths and glyph coverage; print timelines |
| `voiceover [brief]` | Speak each scene's `narration`: `--engine azure` (licensed) or `edge` (preview); `voiceover check` transcribes the clips and flags misreads |
| `still [brief]` | Keyframes and a contact sheet; `--at 1.5,4` for exact seconds, `--beats 4` one frame per bar; `--onion 1.2-2` stacks a move's frames into one PNG to judge its spacing; warns when film drawing keeps state between frames |
| `render [brief]` | MP4 per language × format, plus a cover PNG; `--quality draft\|standard\|high`, `--target github` / `--max-size 9MB`; `--release` platform masters + manifest, `--snapshot <id>` re-render an earlier cut, `--gate` fail on flagged narration, off-frame text or overlapping text |
| `verify <mp4>` | Decode and measure a delivered video: review frames, audio, motion lights; `--gate` fails on red, `--loop` checks the loop seam, `--manifest` checks a file is the current release master |
| `breakdown <video>` | Take a reference apart: cuts, beat grid, contact sheets, transition strips, motion heatmaps, palette, motion lights |
| `reference <url>` | Save a published piece for study (a [Prompt Motion](https://prompt-motion.com) entry, or any page with a `VideoObject`): creator and post, the prompt or skill, the video and its breakdown, in a git-ignored `references/<slug>/`. The prompt stays its creator's: paraphrase, never paste |
| `beats <audio>` | Measure a song: tempo, first downbeat, bar loudness, the drop; prints the `music` line that starts the film on a downbeat |
| `music [film]` | Play the film's own score (`composition/score.js`, written for this film: instruments, mode, where it peaks, accents on picture events) into a WAV, with notes per shot and score warnings |
| `instruments [list\|install]` | The recorded CC0 instrument pack scores play (zither, harp, piano, bells, gong, frame drum, strings, winds…) |
| `compare <a> <b>` | Frames of two videos side by side: `--times 1.5,4` |
| `doctor` | Check Node, FFmpeg, Chrome, the engine, the native renderer and fonts |
| `upgrade` | Update the CLI and its skill; `--check` only looks |

All commands take `--json`. `still` and `render` take `--lang`, `--format` and `--out`.

## Licenses

motion-use is MIT. The engine, HyperFrames, is Apache-2.0. Fonts are SIL OFL; sound effects are CC0 or original; one dependency of the engine (`@img/sharp-libvips`) is LGPL-3.0. Every file and dependency is listed in [ASSETS.md](ASSETS.md). How motion-use compares with HyperFrames, Remotion and others: [docs/alternatives.md](docs/alternatives.md).

## Direction studies and editing handoff

Compare three genuinely different directions with real keyframes before building an open-ended film. Map required facts/features to source evidence, stable shot IDs and final review frames; respect an already chosen or delegated direction. See [production.md](references/production.md).

```bash
motion-use catalog styles                 # six original material/motion studies
motion-use catalog shots                  # six parameterized shot cards with limits
motion-use catalog --out ./gallery        # local live previews, pause and scrub
motion-use study parallax-tour ./study    # the same implementation as a renderable film
motion-use render ./study --allow-code --quality draft
motion-use render my-film --allow-code --no-captions --no-bgm
motion-use handoff my-film --out ./editing-package
motion-use handoff --check --out ./editing-package
motion-use concat parts.json --out ./joined --release
```

Studies use illustrative objects and data. Handoff packages contain SRT, separate source audio, shot timing, explicitly declared inputs and provenance hashes, not a native editor draft or a rendered clean plate. Code-driven motion stays baked; no-captions suppresses M.captions, not custom drawing or text inside footage. Variants have distinct filenames and replayable snapshot settings. Drafts remain under out/preview even when delivery measurements fail.

The [film contract](references/film.md) also covers imported subtitles/keyword cues, optional measured Azure word boundaries, narration-driven retiming, custom licensed fonts, compiled GeoJSON/TopoJSON maps, camera anchors, updating legends, original documentary SFX, joined-master verification and remote-render synchronization.

Long renders can report phases on stderr without changing the final JSON result:
`motion-use render <dir> --allow-code --json --progress text` (or `--progress json`
for NDJSON events). Overlapping still/render jobs sharing `--out` now fail early.
`motion-use <command> --help` displays CLI usage. See
[frame boundaries and concurrent jobs](references/film.md#frame-boundaries-and-concurrent-jobs)
for exact cut timing, lock recovery and narration freshness requirements.

New films use `motion-use init <name>` under `~/motion-use/<name>` (configure
`MOTION_USE_PROJECTS`); `motion-use list --json` finds projects and their release
masters. Explicit paths still work. Review SCRIPT.md before production, then
keyframes, range drafts and the final cut. Narration supports separate `{say,text}`
copy and sentence/shot/cue subtitle grouping. Footage accepts lossless numbered
image sequences, shot-relative placement and first/last frame holds. Reports now
include per-shot motion diagnostics; selected stills scope text checks to the
requested time windows. See the [film contract](references/film.md).

Batch course production: [workflow, recovery, narration review, chapters and delivery](references/course-workflow.md).
