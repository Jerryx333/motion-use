# Authored films

`film.json` fixes output timing and assets; `composition/draw.js` owns the entire picture. `DIRECTOR.md` records the directing choices and review. How to plan, pace and review a film: [directing.md](directing.md). Explainer looks: [grammars.md](grammars.md). Rendering preserves exact shot times: there is no implicit title entrance, crossfade, cover hold or narration stretch.

```json
{
  "version": 1, "kind": "film", "name": "my-film",
  "duration": 12, "fps": 60,
  "languages": ["zh", "en"], "formats": ["landscape", "vertical"],
  "composition": "composition/draw.js",
  "look": {"style": "Warm paper, flat shapes, one line weight", "palette": "paper", "character": "none"},
  "music": {"builtin": "pulse", "hits": [6.1]}, "motionBlur": {"samples": 4, "shutter": 0.5},
  "copy": {"zh": {"headline": "变化发生。"}, "en": {"headline": "A change happens."}},
  "shots": [
    {"id": "action", "start": 0, "end": 6, "camera": "push", "purpose": "Show the cause", "action": "A small dot swells into a message and flies across the gap"},
    {"id": "result", "start": 6, "end": 12, "camera": "slam", "purpose": "Show the consequence", "action": "The message hits the receiver, which writes the name onto itself"}
  ]
}
```

Formats: `landscape` 1920×1080, `vertical` 1080×1920, `square` 1440×1440. Frame rates: 24/25/30/60. Duration: 1–180 seconds. Shots cover the whole duration without gaps or overlap. Optional `cut: true` documents a deliberate cut (the motion check treats it as a transition); optional `hold` and `holdReason` document stillness; optional `camera` (`hold`, `push`, `pull`, `pan`, `slam`, `whip`, `follow`, `cut`, `drift`) and `text` (planned on-screen words, a string or language map) let validation check the plan. Shots annotate your code; they do not generate or impose visual scenes. Optional `loop: true` marks a film that repeats: `render` (and `verify --loop`) compares the last frame with the first and warns when the seam jumps further than an ordinary frame step.

Optional `cover: {"at": 6.6}` selects the film second for the rendered PNG cover and the cover copied into `--release` masters. `at` must be a finite number with `0 <= at < duration`; validation reports invalid values at `$.cover.at`. Without it, the cover uses frame 0. If that frame has almost no content, `render` warns and recommends setting `cover.at`; this does not fail delivery. The check reuses the motion check's grayscale Sobel statistics at width 320: fewer than 0.2% of pixels with gradient magnitude above 24 counts as nearly empty, including uniform bright frames. The warning appears in the terminal, verification report and JSON output.

Optional `brief` holds what a user changes first, as fields: `subject`, `purpose` (where it plays, what the viewer does next), `audience`, `tone`, `length` (target seconds) and `reference` (a folder from `motion-use reference`). `init --subject … --purpose … --audience … --tone … --palette … --length …` fills them; validation warns while a field still starts with `TODO` and when `length` differs from the shots' `duration`. Read the brief before planning shots; it is not rendered.

`motion-use reference <url>` saves a published piece for study in `references/<slug>/` (git-ignored): `REFERENCE.md` with the creator, original post and gallery link, the prompt or the skill behind it, `video.mp4` and `breakdown/`. Supported: prompt-motion.com entries; other pages work when they carry a schema.org `VideoObject` or `og:video`. The prompt belongs to its creator: paraphrase what you learn into your own brief, credit borrowed techniques in DIRECTOR.md, and never paste it into a deliverable or commit it.

`look` locks one `style`, a `palette` (a name from the kit or 3–6 hex colors) and the `character` approach. A blue-purple palette color is an error unless `look.allowBluePurple` gives the reason; `look.allowStatic` records why a deliberately still film may pass the motion check. Validation warns about presentation verbs in `action`, text-led opening/closing shots, shots over 8 s without `holdReason`, three identical camera moves in a row and a plan with no fast move; see [directing.md](directing.md).

## Drawing contract

```js
window.drawFrame = function (ctx, seconds, film, view, motion) {
  const {width, height, vertical} = view;
  ctx.fillStyle = "#f4f2ec";
  ctx.fillRect(0, 0, width, height);
  const progress = motion.ramp(seconds, 0, 1);
  motion.text(ctx, film.copy.headline, width/2, height/2 + (1-progress)*100,
    vertical ? 70 : 110, "#172c2a", 800, "center", width-160);
};
```

Paint an opaque background every frame. The caller resets transforms and restores context state. All pose values must derive from the supplied time, not the last rendered frame. The renderer seeks backward and splits capture among workers; `still` redraws its first frame after the others and warns (`pure: false`) when the picture changed. Avoid clocks, unseeded random numbers, animation loops and network sourcing.

`film.copy` is already selected for the current language; `film.look` is passed through. `view` supplies width, height, format, vertical and `safe`: the box platform UI leaves visible (portrait 6–86 % × 10–76 %, otherwise 5 % margins). Keep text, subtitles and the key action inside it; `still --guides` tints the rest. `motion` provides `mix`, `clamp`, `ease` (smoothstep), `progress`, `ramp`, analytic `spring`, deterministic `hash`, `beat`, `round`, `line` and font-aware `text`. `text` shrinks a line to an explicit maximum width; `paragraph` wraps. Neither enforces platform safe areas. Design the portrait composition rather than cropping landscape.

The drawing kit adds, all pure functions of time or a seed:

| helper | |
|---|---|
| `easings.{smooth, sineInOut, cubicIn/Out/InOut, quartOut, quintOut/InOut, expoIn/Out/InOut, backOut(p, s), elasticOut, appleOut, emphasized, k75, easyEase, longTail}`, `bezier(x1, y1, x2, y2)` | easing curves |
| `tween(t, start, dur, ease)` | eased progress; `ease` is a name or function (default `cubicInOut`) |
| `springZeta(t, zeta, hz)` | spring by damping ratio, progress 0 → 1 at `t` seconds after the start (below) |
| `springHz(t, start, f, d)`, `settle(t, start, amp, f, d)`, `thereAndBack(p)`, `lagged(i, n, p, r)` | overshoot, decaying wobble, out-and-back, staggered progress |
| `follow(t, [[at, value], …], {f, d})` | a value (number or array) that changes target many times: one closed-form spring step per change, summed, so it stays a pure function of `t`; two edges on different `f` stretch a moving shape |
| `step(t, fps = 12)` | hold poses for whole steps (pass `t - at`) |
| `camera(t, events, base)`, `applyCamera(c, cam)`, `toScreen(cam, x, y)`, `zlerp`, `pulse` | pulse camera: `push` (k, x, y), `pan`, `to` (x, y, z), `slam`, `shake`, `cut`; durations default to 0.28 / 0.30 / 0.17 s |
| `slam(t, at, {dur, from, under})` | element scale 1.55 → 0.94 → 1.0 (0 before `at`) |
| `count(t, at, dur, from, to, decimals)` | a rolling number string with thousands separators |
| `rng(seed)`, `noise(x, y)`, `fbm(x, y, octaves)` | seeded randomness and Perlin noise |
| `pathLength`, `resample`, `drawOn(c, pts, progress, style)` | draw a polyline by arc length; returns the pen tip |
| `rough(c, pts, {amp, seed, boil, t, progress, color, width, close})` | hand-drawn line; `boil: 12` re-jitters it at 12 fps |
| `write(c, text, x, y, progress, style)`, `pen(c, x, y, style)` | whiteboard handwriting and the marker |
| `wrap(c, text, maxWidth)`, `paragraph(c, text, x, y, options)` | CJK-aware wrapping; shrinks to `maxLines` |
| `palettes`, `palette(nameOrColors?)` | `{bg, surface, ink, sub, accent, accent2}`; defaults to `film.look.palette` |
| `paper(c, key, {base, amount, grain})`, `texture(key, options)` | a static paper texture painted once and reused |

`springZeta(t, zeta = 0.7, hz = 2)` is a damped spring written by its damping ratio, solved in closed form so any frame renders on its own (`t` is seconds since the move began; `t ≤ 0` gives 0). Pick the band by feel: `1` arrives with no bounce (overdamped above 1 arrives slower still); `0.7–0.85` lands with a settle you feel more than see (overshoot 5% → under 1%), the premium default; `0.4–0.6` bounces (16% at 0.5), playful; under `0.3` wobbles, cartoon. `hz` sets how quick: 2 is a firm UI move, 1 a heavy object, 4 a snap. Springs move position, scale and rotation; opacity and colour never bounce (ease them, or clamp a spring to 1). The runtime's `spring(time, start, speed, damping)` is unchanged.

Composed helpers build on these: `shoot`, `card`, `pill`, `ripple`, `stroke`, `node`, `signature`, `caption`/`captions`, `words`, `counter`, `chart`, `callout`, `stamp`, `spotlight`, `cursor`, `cover`, `video`, `grade`, `grain`, `vignette`, plus `unit`, `lerp2`, `add`, `ring`. Their signatures and a worked example are in [kit.md](kit.md). New helpers never replace an existing `motion` name, so older drawing code renders identically.

## Data, footage and subtitles

`data` holds named values and series (≤ 100 KB) passed to the page as `film.data`; `chart`, `counter` and friends read them by key, and labels may be language maps. Changing a number in `film.json` changes that number in every language and format.

`videos` declares footage: `{"name": {"file": "footage/demo.mp4", "at": 4, "from": 12.5, "rate": 1, "length": 6, "volume": 0}}`. `at` is the film second where the clip starts, `from` the source second, `rate` 0.25–4. The build extracts exactly the frames that window needs (film fps ÷ rate, ≤ 5,400 per film) as JPEGs, and the page loads the frames a seek needs before drawing, so footage stays deterministic and seekable. `motion.video(name, t)` returns the current frame (or `null` outside the clip) for `cover` or `drawImage`. Footage sound plays when `volume > 0`, only at rate 1. Validation rejects clips that run past their source or the film.

`film.captions` is `[{text, start, end, estimated?}]` for the narration placed in the current language: sentence cues timed by edge-tts when the clip still matches its script, otherwise sentences timed by character share and marked `estimated`. `motion.captions(c, t)` draws them in a safe lower slot. Word-level timing is not available; pass explicit `times` to `words` for word-accurate emphasis.

`render --from A --to B` renders a silent draft of that window into `out/preview/` with motion lights but no delivery checks. `still --shot id` captures the first settled frame, the middle and the last frame of a shot. `still --onion 1.2-2` (`:12` for twelve frames) stacks evenly spaced frames of that range into one PNG, later frames a little stronger: evenly spaced ghosts mean constant speed (robotic for anything that should land); ghosts that bunch up towards a key mean the easing works; one wide gap is a jump. Judge spacing there before rendering.

Declare local PNG/JPG/WebP/SVG images under `assets`, e.g. `{"logo":"images/logo.png"}`. They are decoded before rendering and available as `window.filmAssets.logo`; draw with `ctx.drawImage`. Only named files are copied. Paths must remain inside the project, including symlink targets. Fonts ship as local subset WOFF2s with their licenses; visible copy and drawing-source characters enter the subset. Missing glyphs in `copy` fail validation.

Declare any other local file a library or an external engine loads under `files`: `{"alice": "models/alice.vrm", "studio": "env/studio.hdr", "draco": "vendor/draco_decoder.wasm"}` (glb, gltf, bin, vrm, vrma, hdr, exr, ktx2, json, wasm, ttf… — the extension is not checked). The same path rules as `assets` apply; a missing file fails validation. Each is copied to `assets/files/<name><ext>` and the page gets `window.filmFiles.<name>` (also `film.files.<name>`): a relative URL to `fetch` or hand to a loader, e.g. `new GLTFLoader().loadAsync(window.filmFiles.alice)` in `setupFilm`. With `files` declared the page may fetch its own folder (`connect-src 'self'`) and compile WebAssembly, and the lint lets `fetch`/`XMLHttpRequest` through; other hosts stay blocked. A `.gltf` finds its `.bin` only when the bin's copied name matches the URI inside the gltf, so prefer `.glb`. More than 200 MB in total warns (files are copied into every language/format build; snapshots keep files over 200 MB by hash only).

Optional `libraries: ["vendor/library.js"]` loads explicit local classic browser bundles before the drawing code. Bundle ES modules into a browser file first. The film directory is not recursively copied. Optional `window.setupFilm(film, view, motion)` can return a promise to prepare geometry/renderers after fonts and images load; the engine waits for it. A WebGL renderer can draw into its own offscreen canvas and composite it into `ctx` during `drawFrame`. This is an authoring capability, not a built-in 3D scene generator. motion-render draws WebGL 1/2 itself (ANGLE on the GPU), so a three.js film renders natively; `--gpu` (Chrome on the GPU) is only for comparison or a feature motion-render lacks.

`motionBlur` samples 1/2/4 subframes over a 0–1 frame backward shutter and averages the rendered canvases. The sampling order is deterministic. Default: one sample, no blur. Tune exposure for readable movement; blur does not rescue an unclear layout.

## Renderers

Two renderers draw the same built page (`index.html`, runtime, kit, fonts) and deliver the same film:

- **native** — `motion-render` (`native/`, Skia on the CPU, the drawing code in V8, WebGL on ANGLE). Frames go as raw RGBA through a pipe into one ffmpeg; the sound is mixed by ffmpeg from film.json; the text check runs the same probe in its V8. About twice as fast end to end for 2D (ocs-film draft 12 s vs 26 s), byte-identical between runs on one machine. `install.sh` installs it for macOS and Linux (arm64, x64); in a checkout, `cargo build --release --manifest-path native/Cargo.toml`. `MOTION_RENDER=<path>` picks a binary, `MOTION_RENDER=0` turns it off.
- **chrome** — HyperFrames in Chrome: the reference and the fallback.

**WebGL in motion-render.** `getContext("webgl2" | "webgl")` is ANGLE in WebGL-compatibility mode — the same GLES implementation, shader translator and validation Chrome uses — on Metal (macOS) or Vulkan (Linux), else SwiftShader on the CPU. The libraries (`libEGL`, `libGLESv2`, SwiftShader) ship next to the binary; `motion-render --capabilities` says `"webgl": true` and which backend it found. `--gl <auto|gpu|metal|vulkan|swiftshader|off>` (or `MOTION_RENDER_GL`) picks one: `swiftshader` gives the same pixels as Chrome's software GL and is reproducible across machines; the GPU is reproducible on one machine. three.js examples match Chrome to SSIM ≥ 0.98 (mostly ≥ 0.998). Not drawn: WebGPU, video textures, WebGL 1 extensions with methods (VAO, instancing), `toDataURL`.

`--renderer auto` (default; film.json `"renderer"` pins one) uses native when motion-render is installed, and for WebGL drawings (`getContext("webgl")`, a three.js bundle in `libraries`) when its capabilities report WebGL; a context it cannot create at render time also falls back to Chrome with a note. `--gpu` is Chrome's GPU path. `--workers n` is motion-render's thread count (default: cores, at most 8). Reports, JSON results and release manifests say which renderer made the file (`renderer`). Pixels match Chrome to SSIM ≥ 0.99 on the 2D examples (whiteboard's scaled paper texture 0.98); the mix to ±0.5 dB.

## External engines

The browser canvas is the default engine (`"engine": {"type": "browser"}` or no `engine`). A scene that belongs in Blender, Unity, Godot or a native renderer can draw the picture instead, while motion-use keeps everything around it:

```json
"engine": {"type": "command", "command": ["blender", "-b", "-P", "scene.py", "--"], "cwd": ".", "env": {"SCENE_QUALITY": "final"}, "stream": false, "parallel": false}
```

`command` is an argv array (no shell). Arguments that name a file in the film folder (`scene.py`, `shot.blend`) are passed as absolute paths; `cwd` (default: the film folder) and `env` are optional. The command runs arbitrary local code, so `still` and `render` need `--allow-code`, and validation says so. `composition` becomes optional: without it the picture is the engine's alone.

For each language and format, motion-use writes a job file and runs the command with `--job <job.json>` appended and `MOTION_USE_JOB=<job.json>` in its environment:

```json
{
  "version": 1,
  "film": {"name": "…", "dir": "/abs/film", "duration": 12, "fps": 30, "bpm": 100, "lang": "zh", "format": "vertical",
           "copy": {"…": "this language's copy"}, "data": {}, "look": {}, "shots": [], "captions": [{"text": "…", "start": 1.2, "end": 3.4}],
           "files": {"alice": "/abs/film/models/alice.vrm"}, "assets": {"logo": "/abs/film/images/logo.png"}},
  "lang": "zh", "format": "vertical", "width": 1080, "height": 1920, "fps": 30, "duration": 12,
  "frames": {"from": 0, "to": 359},
  "out": "/abs/film/out/.build/<id>-engine/frames", "pattern": "%05d.png",
  "safe": {"x": 64.8, "y": 192, "w": 864, "h": 1267.2}
}
```

- Write every frame `k` from `frames.from` to `frames.to` (inclusive) as `out/<pattern>`: `00000.png` is film time 0, frame `k` shows time `k / fps`. Indices stay film frames in a range: `render --from 1 --to 2` at 30 fps asks for `{from: 30, to: 59}` → `00030.png…00059.png`.
- PNG, RGB or RGBA, exactly `width × height`; alpha is flattened on black. Exit 0 when done. A missing frame, another size or a non-zero exit fails the render with the frame name, the size found or the command's last output lines.
- **Determinism**: draw frame N from time N/fps only — no state carried from the previous frame, no clocks, no unseeded noise. motion-use may split a range among processes (`--workers 4`: four contiguous chunks, four processes at once; default 1) and `still` asks for single frames (`{from: k, to: k}`, time `t` → frame ⌊t·fps⌋).
- `safe` is `view.safe` in pixels: keep text and the key action inside it in portrait. `captions` are the narration cues `M.captions` would draw. `film.videos` lists the footage frames motion-use extracted for this cut (absolute folders).
- **Raw stream** (`"stream": true` in `engine`): the job also carries `"formats": ["png", "rgba-stream"]` and `"stream": "<fifo path>"`. Write every frame in order, `width × height × 4` bytes of straight RGBA, into that FIFO instead of PNGs; motion-use encodes them as they arrive (one process, no PNG sequence on disk). Fewer frames than asked fails the render. Not on Windows.
- **Parallel** (`"parallel": true`): one process gets the whole range and `"workers": n` (motion-use's `--workers`, default the cores up to 8) instead of n processes on chunks, so threads are not multiplied by processes. `motion-render` as the command gets both automatically.
- **motion-render as the engine.** A frame-engine page (`window.setupEngine(job)` / `window.renderFrame(t)` drawing into its first `<canvas>`, WebGL included) renders natively with `"engine": {"type": "command", "command": ["motion-render", "composition/engine.html"]}`; a bare `motion-render` is the binary motion-use found (no PATH needed), and it streams and runs in parallel. A drawing `.js` instead of the page runs as a film drawing (`drawFrame`).

motion-use then encodes the sequence at the film's fps and continues unchanged: music, sound effects and narration mixed and normalized, decode/duration/loudness checks, motion lights, contact sheet, cover, snapshot, `--release` masters and manifest, `verify`. The mix is made by ffmpeg from film.json (the same placement, volumes, ducking and fades as a browser film); nothing is captured in Chrome when there is no composition. The command gets `MOTION_USE_ROOT` (this motion-use's folder) in its environment.

**Overlay.** With both `engine` (command) and `composition`, the composition is drawn as a transparent layer over the engine frames, by motion-render when it is installed (straight into the encode) or as a transparent capture in Chrome: `drawFrame` gets a cleared canvas and must not paint a background (motion blur is off for the layer). Subtitles, labels and callouts over a 3D picture belong there: the text check measures them as for any film (contrast is judged against the transparent layer, not the engine picture underneath). Without a composition the report says `text_check: {skipped: "external engine"}`: text the engine draws is pixels.

**Snapshot.** film.json, and with it the command line, is in every snapshot; files the command names inside the project and every declared `files` entry are stored like drawing code. A file the engine reads that is neither (a module `scene.py` imports, a texture folder) is not: pass it as an argument or declare it under `files`, which the job lists with absolute paths.

## Narration is required by default

Add `narration` to each narrated shot as a language map, e.g. `{"zh":"发一条消息。","en":"Send a message."}`. A root `narration` map instead makes one continuous track. Optional `voiceover` settings accept `dir`, `engine` (`azure`/`edge`), `voices`, `rate`, `say` and `volume`. Defaults: `voiceover/`, configured Azure or the Edge preview provider, and the bundled Chinese/English voice choices. For other languages, set an appropriate voice explicitly.

`voiceover.say` is an optional string-to-string map, for example `{"有数": "有树"}`: narration “抬头就有数” is sent to TTS as “抬头就有树”, while captions keep “抬头就有数”. Use it when a polyphonic character or tone sandhi is read incorrectly and you want to keep the original subtitles. Keys must be non-empty and values must be strings; replacements run in descending key-length order. The cache and voice manifest use the resulting spoken text, so changing its pronunciation regenerates audio, while unchanged spoken text reuses it. When substitutions change the script, captions use the original text with estimated timing rather than the provider’s substituted cue text.

`motion-use voiceover <project>` supports films and caches one audio file per language/shot. `render` automatically generates missing or outdated narration before frame capture. Generation uses the voice provider's network service; the frame renderer stays local. Imported `audio` tracks with `role: "voiceover"` take precedence. Optional `lang` selects one language; omit it for an intentionally shared track. User recordings are preserved. When trimming silence from imported or own recordings, trim only the end; preserve the opening silence and quiet onset. Trimming the start cut the E from “ESP” (recognized as “PSP”); even leaving 60 ms at both ends cut the nasal m from “Mac” (recognized as “Nike”). For recordings placed in a shot’s narration window, estimate an event’s alignment as `shot start + 0.08 s + opening silence + pause position` within the spoken line; explicitly imported tracks instead use their authored `start` and `offset`.

Before locking narration or rendering, audition 3–5 voices on the same, most emotional line, then choose the voice and rate.
In a temporary project copy, use a fresh `voiceover.dir`, keep `narration` on one shot only, omit root `narration` and imported voiceover tracks, and change `voiceover.voices.zh` between runs of `motion-use voiceover <project> --lang zh`.
Save each candidate clip before the next run replaces it; tune `voiceover.rate` after choosing the voice, then apply both settings to the full project.
Listen by ear: emphatic lines can sound hoarse or crack; ASR checks words, not vocal quality. Confirm authorization for preview online TTS voices before public release.

Each shot's spoken window starts 80 ms after its start and ends 80 ms before its end. Whole-film narration has 100 ms at each edge. Audio that does not fit fails: shorten the script or retime the authored shots and drawing; words are never trimmed to fit. `voiceover:false` opts into a deliberately unnarrated film, not an automatic fallback after a provider failure.

Final delivery verifies that the voice-only reference actually appears in the MP4's mix, using per-window waveform correlation and non-silence checks. This checks presence and alignment of the expected signal, not speech recognition or listening quality. A music-only MP4 cannot pass required narration, and a failed candidate never replaces the last delivered video. Generated audio and voice manifests are excluded from release packages. Narrated film filenames end in `-VO.mp4`, making them distinct from older unnarrated exports.

## Sound and narration

`music` accepts `"none"`, `"builtin"`, `{"builtin":"pulse","volume":0.6,"hits":[4.6,9.2]}` or `{"file":"audio/song.wav","volume":0.6,"bpm":120,"from":1.3}`. Both object forms accept an optional boolean `duck` (default `true`), including `"duck": false`. Built-in moods: `promo`, `explainer`, `pulse` (plucked strings, soft downbeat), `chiptune`, `pentatonic` (plucked D minor pentatonic) and `ambient`; `hits` adds a thump and a plucked accent at those seconds. Root `bpm` wins over the music's BPM; a built-in mood otherwise sets the tempo. Built-in music uses that same tempo, so `motion.beat(seconds)` lines up with it. For imported music, `motion-use beats song.wav` measures the tempo, the first downbeat, per-bar loudness and the drop (4/4 assumed) and prints `{"file", "bpm", "from"}`: `from` is the song second that plays at film second 0, so starting on the downbeat makes `motion.beat(t)` count the song's beats. `still --beats 1` (or `4` for one per bar) renders a frame on every beat of the grid.

`motion-use beats song.wav --drop-at 5.5` places the detected drop at film second 5.5 and prints the aligned `music` line: `from = drop.start - dropAt`, rounded to three decimal places. A negative offset fails with the latest possible film second (`drop.start`); no detected drop also fails. Human output lists bar lines on the film timeline; `--json` includes `film_bars`, an array of seconds at or after film second 0, ending before the song ends, capped at 64 lines (including the final partial bar). With `--from`/`--to`, detection is limited to that range and bar lines stop at the analysed end; `drop.start` and `music.from` remain absolute song seconds. Alignment can start between downbeats, so the film's zero-based `motion.beat(t)` grid need not match these bar lines.

```json
"audio": [
  {"file":"audio/narration.wav","role":"voiceover","start":1.2,"offset":0,"length":4.5,"volume":1},
  {"file":"audio/click.wav","role":"sfx","start":3.6,"volume":0.5}
]
```

Times refer to the output timeline. Omitted `length` uses the remaining source duration. Validation rejects a source overrun or a clip running past the film; trim it explicitly or extend the authored picture. Voiceover windows duck the music with short ramps by default. Use `"duck": false` when music should stay at `music.volume` throughout the film; the final fade and master loudness normalization still apply. HyperFrames owns media playback and the final mix; the drawing code does not play audio. `render` normalizes the final track without re-encoding the video. Imported audio must already have suitable authorization.

For bundled licensed sounds, use `{"effect":"click","role":"sfx","start":3.38,"volume":0.6}` instead of a file. Effects: `click`, `switch`, `whoosh`, `ding`; sources/licenses are in ASSETS.md. `start` is the beginning of the file, not its loudest transient. Add `"align": "peak"` to any clip and validation measures where it peaks and moves it so that moment lands on `start` (trimming the head when the clip would begin before 0).

## Delivery review

`render` writes a technical report and contact sheet from the delivered MP4. It checks full-file decoding, measured dimensions/FPS/duration, audio presence, integrated loudness, true peak and per-shot RMS. Black intervals and freeze starts over 0.8 seconds are signals to inspect. Review times include the opening, shot midpoints, the final frame, and both sides of shot boundaries.

`motion` in the report holds the motion lights measured on the MP4: fast movement inside shots, empty mid-film frames, blue-purple share and flashes (WCAG 2.3.1: more than three general flashes in any one second is red, with the window in `flash_windows`) (thresholds and calibration in [directing.md](directing.md)). For authored films a red light fails delivery and the previous video stays in place; `--allow-static "why"` / `--allow-blue-purple "why"` (or the matching `look` fields) downgrade it to yellow and are recorded under `motion.allowed`. Films shorter than 20 s get yellow instead of red for pacing. `independent_reviews` lists `reviews/*.md` notes written by someone who watched only the MP4. `motion.demo_similarity` is the share of frames that follow the starter or a bundled example: runs of at least three consecutive frames whose layout matches one demo (edges and brightness, polarity ignored, so a re-coloured copy still counts) while advancing through it in order. A single look-alike frame does not count. A warning at 0.3; never a gate. `render --json` prints a compact summary; add `--verbose` for every narration segment and motion light.

`narration_check`: before capture, render transcribes every generated narration clip (faster-whisper through `uv`, model `small` unless `--asr-model`; transcripts cached in `voiceover/.motion-use-asr.json` by clip hash) and compares it with its script. Flagged: an acronym or Latin word heard differently ("AI" spoken "A-A-I" — spell it "A I" in the script, subtitles may keep "AI"), a homophone that forms a dictionary word with a many-reading neighbour (重试 heard 重视: the voice read 重 as zhòng — use 再试), a different-sounding word, missing or extra words, or a line under 80 % similar. Plain ASR spelling (它 → 他) is listed but not flagged. Without `uv` or the model the check is skipped with a note. `motion-use voiceover check <dir>` runs it alone; `--no-asr` skips it. With `voiceover.say`, the comparison uses the substituted spoken text.

Recognition checks characters, not tones: “有数” read as shǔ can still pass at 100%, and it cannot detect “板” becoming bán in the consecutive third tones of “小板子”; conversely, correctly spoken “下一班” can be transcribed as “下一半” and falsely flagged. For polyphonic characters and consecutive third tones, compare pitch or listen by ear. If the reading is wrong, use `voiceover.say` to substitute a homophone without changing subtitles.

`canvas_check`: before capture, still and render (including range previews) call the composition at every output frame time across the whole film, in Chrome or motion-render. Too few Canvas arguments, NaN/Infinity numeric arguments or properties, and drawFrame exceptions fail even without `--gate` or with `--no-text-check`; errors list the first time (two decimal seconds), zero-based frame index and affected frame count, grouped into at most 15 entries in terminal and JSON output. `--no-canvas-check` temporarily skips this check for false positives.

`text_check`: render and still draw the film every 0.1 s on a private canvas and measure each `fillText`/`strokeText` box through the current transform. Text partly off the frame for 0.3 s or more is reported with its string and time (a whip through an edge is not); in portrait, text outside `view.safe` likewise. It also reports two different strings drawn over each other while both are at least 25% opaque (a cross-fade that puts the new line where the old one is still fading, a footnote under a translucent subtitle plate): wherever the visible strings change between samples it re-draws every frame, so a 0.08 s overlap is found. An opaque fill drawn between the two (a solid plate) hides the lower one and does not count. It also reports, as warnings only: a line gone before it can be read (0.3 s per word + 0.15 s per CJK character + 0.5 s; a line counts from when its first word or letter appeared, digits are ignored so a rolling counter is one line, and a line still up at the end is not judged), and filled text under WCAG contrast against the median pixel under its box while fully shown for 0.3 s or more (4.5:1; 3:1 for large text, 24 px or more, or 18.66 px at weight 700+, in frame pixels, which most film titles are). The colour is the fill style of the draw call; gradients, patterns and outlines are not judged. Text drawn into your own offscreen canvas is not seen, nor text an external engine draws (an overlay composition is measured; see External engines). `--gate` makes a flagged narration line, off-frame text or a collision fail the render; `--no-text-check` skips it.

`snapshot`: each full render stores its inputs (film.json, drawing code, voiceover clips and their manifest, footage, images, `files`, an external engine's script files, music; files over 200 MB by hash only) under `out/.snapshots/`, deduplicated by sha256. `render --snapshot <id or release-manifest.json>` restores them and renders into `out/snapshot-<id>/` — the same cut after the narration or film changed (with the same motion-use version, bit-identical).

`render --release`: renders at high quality with near-lossless CRF 10, then encodes the platform masters into `out/release/`: `<name>-<lang>-<format>.mp4` (x264 veryslow, CRF 16, yuv420p, faststart, AAC 192 kbps 48 kHz), a two-pass `-x.mp4` under 45 MB for X when a landscape master is larger, and the cover. `release-manifest.json` lists every file with sha256, size, duration, fps, bitrate, dimensions, its voiceover hashes, the snapshot and the motion-use version. `motion-use verify --manifest <manifest> [file]` passes only for a file that is byte-for-byte a listed master; a same-named file with other bytes is reported as a stale or edited cut. `--max-size`/`--target github` are for README copies, never for release.

`visual_review: "pending"` is intentional: neither a successful encode nor a numeric report proves the film looks good. Canvas typography is invisible to DOM text audits. Read the frames and watch the MP4; record the outcome and remaining concerns in `DIRECTOR.md`. Review files are written only into directories owned by motion-use. Concurrent renders/stills targeting the same output are unsupported.

## Existing briefs

`brief.json` and `--style` / `--story` keep their previous scene behavior. Use `--mode template` explicitly when creating information-card videos. `--allow-code` authorizes film code; `--allow-custom-html` remains the separate opt-in for template HTML scenes. Validation never executes the authored script. Static lint checks are not a security boundary for arbitrary code.
