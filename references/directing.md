# Directing a film

How to plan, pace, check and review an authored film. The failure modes, pulse rhythm, storyboard rules, delivery gates and review protocol are adapted from [huashu-art-motion](https://github.com/alchaincyf/huashu-art-motion) (MIT, alchaincyf) and re-expressed for `film.json` and `composition/draw.js`. The drawing API is in [film.md](film.md); explainer looks are in [grammars.md](grammars.md).

For product promos, choose the audience's technical level first; [stories.md](stories.md#problem-solution) gives the developer and everyday-metaphor branches.

## Before code: lock the look, then plan objects and verbs

Write `look` before the first shot. One style and one palette hold to the last frame; changing scenes is fine, changing style is a collage.

```json
"look": {"style": "Warm paper, flat shapes, one pencil line weight", "palette": "wood", "character": "hands only"}
```

- `palette`: one of `paper`, `poster`, `ink`, `navy`, `bauhaus`, `snow`, `wood`, `chalk`, `whiteboard`, or 3–6 hex colors (`bg`, `ink`, `accent`, optional `accent2`, `sub`, `surface`). Pick light or dark once. Validation rejects a blue-purple color (hue 225–300°, saturation ≥ 0.30) unless `allowBluePurple` records why the subject needs it.
- `character`: `none`, `hands only`, real footage, or generated frames (a path). Code-drawn mascots, chibis, robots and coins with faces read as generic; use hands, silhouettes, objects or real material.

Each shot names **an object you could point at** and **what that object itself does**. Validation warns on presentation verbs (`appear`, `show`, `fade in`, `出现`, `展示`, `逐条`). Add `camera` (`hold`, `push`, `pull`, `pan`, `slam`, `whip`, `follow`, `cut`, `drift`) and `text` (the words planned on screen, ≤ 8 units: one CJK character or one Latin word each). Visible strings still live in `copy`.

```json
{"id": "spore", "start": 6, "end": 10, "camera": "pan", "text": {"zh": "孢子", "en": "A spore"},
 "purpose": "Show where the mould comes from", "action": "A spore tumbles in through the window gap and lands on the bread"}
```

Checks from the plan (warnings unless noted):

1. The first 3 seconds are a concrete small scene: an object or a pair of hands doing something about the subject. Not a title.
2. The last shot is an action on the subject (pocketed, closed, pulled back to the whole), words written on objects in the scene, not a centred quote card.
3. One example carries the film: the same loaf, the same hands, the same machine.
4. Shots of 2–6 s; over 8 s needs a `holdReason`.
5. Text-led shots ≤ 30%.
6. No three shots in a row with the same camera move; at least one push, pan, slam or whip.
7. Adjacent shots change composition (framing, object, distance), not style. Machines cannot check this one.

## Six ways a film goes wrong

Check them before coding and again on the contact sheet.

1. **Page-flip slideshow.** A fixed header or page number, bullets fading in one by one, the same slow push on every shot, ending on a centred card. Remove the page frame; give each shot one picture event; move the camera in pulses.
2. **Copying the demo.** Composition, objects or assets from an example or the starter end up in the film. Learn the method, redesign the picture for the subject.
3. **No concrete object.** An abstract idea shown only as words and icons. If you cannot write the object and its verb for a shot, the shot is not ready.
4. **Dead background, empty frame.** A large flat or starfield area that never changes while a small patch moves; or frames where the subject is gone. Make the subject fill at least half the frame, keep it in every shot, let the background follow the content.
5. **Drawing what you have as footage.** Screenshots, photos, recordings and source text go full frame; code explains, labels and moves the camera over them.
6. **The generic AI look.** Blue-purple gradients, deep-purple starfields, neon cyan-violet glow; a different style per shot; code-drawn mascots. A clean, unified film that is a little slide-like beats a flashy collage.

## Portrait: the platform covers part of the picture

Douyin, TikTok, Xiaohongshu, Reels and Shorts draw their own UI over a 9:16 video: navigation and search on top, the author row, caption, progress bar and like/collect/comment bar at the bottom, an action column on the right. Text and the key action go inside `view.safe`; subtitles sit at its bottom edge, not at the bottom of the frame. Camera pushes in portrait must not carry text or the subject into those bands. Review portrait stills with `--guides`.

## Pulse rhythm: hold, move on the event, hold

Explainer and launch films move in pulses, not in continuous drift. A uniform slow push on every shot was judged a slideshow; the same storyboard with pulses was approved, even though fully still frames rose from 16% to 72% (the fast frames went from 0.7% to 10%). Stillness is not the problem; uneventful motion is.

| move | duration | size |
|---|---|---|
| push | 0.28 s | 18–32% closer (default 25%) |
| pan | 0.30 s | same zoom |
| slam | 0.17 s | scale 1.55 → 0.94 → 1.0 |
| shake | 4/30 s | at most twice per film |

```js
const cam = M.camera(t, [
  {at: 1.4, kind: "push", k: 0.28, x: cup.x, y: cup.y},   // world point moves to centre
  {at: 3.5, kind: "pan", x: plate.x, y: plate.y},
  {at: 4.6, kind: "slam"},
  {at: 9.0, kind: "to", z: 0.8, x: W/2, y: H/2, dur: 0.34},
], {z: 1.1});
c.save(); M.applyCamera(c, cam); /* draw the world */ c.restore();
```

Each event starts from wherever earlier events have brought the camera at time `t`, so a move can begin before the last one lands. Zoom interpolates in log space. Redraw the world as vectors every frame; never scale a rendered bitmap.

- Land big numbers and words on objects in the world (a price tag, a phone screen, a blackboard), not on a separate card.
- Enter in 0.3–0.4 s, exit in ~0.18 s, then hold. Keep a sub line ≥ 1.2 s; hold ≥ 0.5 s after a number lands, ≥ 0.9 s after a punchline.
- Sizes: headline : sub line : label ≈ 3.4 : 1 : 0.4. One focus per screen.
- Two frame rates read as hand-made: camera smooth, illustrated elements stepped at 12 fps (`M.step(t - at)`). Under `motionBlur` a step change blends two poses in that one frame; turn blur off for stepped looks.
- Art-style pictures stay alive inside the hold: one main action plus 2–4 small motif loops.
- Reveal on the beat or on the spoken word: a count starts its roll before the word so it lands on it; whiteboard writing lags its phrase by about 0.5 s.

## Sound follows the picture

- One short motif, re-voiced rather than replaced. `music: {"builtin": "pulse"}` (also `promo`, `explainer`, `chiptune`, `pentatonic`, `ambient`) sets the beat grid to the mood's tempo, so `M.beat(t)` lines up.
- `hits: [4.62, 14.52]` adds a thump and a plucked accent at those seconds: put them on slams and reveals.
- Hard attacks at changes; no crossfaded music under cuts. For effects, `"align": "peak"` lands the measured transient on `start`.
- A multimodal model "listening" to a reference is a guess (it said 120 BPM; it was 128). Measure: `motion-use beats song.wav` for a song you will cut to, `motion-use breakdown` for a reference video.
- Cutting to a song: start it on its first downbeat (`music.from`), put shot starts on bars and the reveal on the drop, then check `still --beats 4` before rendering. Brief shape and recipes: [briefing.md](briefing.md).

## Learning from a reference

```bash
motion-use breakdown reference.mp4          # → breakdown/reference/breakdown.md
motion-use breakdown reference.mp4 --music song.mp3 --music alternative.wav
motion-use breakdown reference.mp4 --music song.mp3 --json
motion-use compare reference.mp4 out/my-film-en-landscape-VO.mp4 --times 1.5,4,7.2
```

The breakdown writes cut times, a beat-grid fit (confirm it against the music; few cuts fit any grid), 4 fps contact sheets, a strip of every second frame around each transition (the only place a transition's mechanism is visible), a heatmap of where pixels move inside each segment, the last clean frame of each segment, a palette with blue-purple share, and the same motion lights the delivery check uses. Replication means learning the mechanism (timing, framing, how a transition grows out of an object), then applying it to a new subject; it is never a pixel copy, and borrowed principles are credited in DIRECTOR.md.

Audio analysis runs even without `--music`: 100 ms windows use short-time energy, autocorrelation periodicity and zero-crossing rate (a coarse spectral proxy) to estimate speech/pause windows and median speech pitch. Pitch is a hint only, not a gender or voice identity. Supplying original song files enables matching and music/voice level estimates; this does not identify songs from an online catalog. Mono audio is decoded at 2 kHz with the existing ffmpeg decoder and matched using normalized linear FFT correlation. Positive offsets mean the song second playing at reference second 0; negative offsets mean the song enters after the head. At least half the reference (or the entire shorter input, with a 2 s target minimum) must overlap. Matching uses the best whole-clip NCC lag, then the upper quartile of 200 ms window NCC at that lag to tolerate narration; the match threshold is 0.5. Repeating passages can produce ambiguous offsets.

The Audio section appears on stdout and in `breakdown.md`; `--json` and `breakdown.json` include `audio`:

| Field | Meaning |
|---|---|
| `available`, `estimated` | Audio stream present; measurements are estimates (`estimated` is absent without audio). |
| `sample_rate`, `match_threshold` | Analysis sample rate in Hz and NCC match threshold (absent without audio). |
| `matches[]` | Each candidate: `file`, `offset_seconds` (signed), `ncc` (window upper quartile), `whole_clip_ncc`, `overlap_seconds`, `matched`. |
| `selected_music` | Highest-NCC matched file, or null. |
| `speech_windows[]`, `pause_windows[]` | Estimated intervals in reference seconds, each with inclusive `start` and exclusive `end`. |
| `pitch_median_hz` | Median voiced-window autocorrelation pitch (roughly 71–333 Hz), or null. |
| `levels` | Null without a match; otherwise the fields below. |
| `levels.voice_dbfs` | Estimated residual voice RMS level during covered speech windows. |
| `levels.music_speech_dbfs`, `levels.music_pause_dbfs` | Aligned music RMS levels fitted by nonnegative least-squares gain per 100 ms window. |
| `levels.music_below_voice_db`, `levels.pause_music_below_voice_db` | Voice level minus music level; positive means music is quieter. Pause music is compared with the same speech voice level. |
| `levels.speech_reduction_db`, `levels.ducked` | Pause music level minus speech music level; at least 3 dB suggests ducking. Null when either class has no measurable covered audio. |
| `levels.speech_gain`, `levels.pause_gain` | Median fitted linear original-song gains in each class, or null. |
| `film_music` | Suggested `{"file", "from", "volume", "duck"}` object, or null when a usable suggestion cannot be made. |
| `notes[]` | Limitations and reasons for skipped measurements. |

When matched, the song estimate is subtracted before detecting speech and pitch. This is approximate source separation: tonal instruments can resemble speech, unvoiced speech can be missed, effects contaminate the residual, and remixes, edits, time stretching, stereo differences and compression can spoil matching or gain estimates. A song naturally quieter under speech can trigger the 3 dB ducking heuristic; inspect the fitted gains and listen. Missing windows/levels remain null instead of asserting no ducking.

The last Audio line gives a film.json `music` suggestion when the offset and voice/music levels are usable, including `"duck": false` when no reduction is detected. `volume` is the measured music/voice RMS ratio, assuming similarly normalized music and narration assets; recalibrate it with your narration and listen to the rendered mix. This does not reconstruct ducking ramps or depth. Existing film.json `music.from` accepts only nonnegative seconds: negative-offset matches are reported but no directly usable music line is emitted. Without `--music` or a match, music-relative levels and the suggestion are skipped with a reason.

For a new character interpretation or style direction, show three options first, with different compositions, not three color grades. A named style is not exempt.

## Delivery lights

`render` measures the delivered MP4 (12 fps, 320 px gray, bottom subtitle band masked) and writes `motion` into `review/<id>/report.json`. For authored films, red fails delivery; for scene templates and `verify` (without `--gate`) it is reported.

| light | measures | yellow | red |
|---|---|---|---|
| `fast_ratio` | share of frame pairs inside shots whose mean gray change is ≥ 9/255 (cuts and dissolves excluded) | < 0.06 | < 0.035 |
| `blank_run_s` | longest mid-film run of frames with almost no edges (< 0.2% pixels above Sobel 24), first/last 0.5 s and transitions excluded | – | ≥ 0.3 s |
| `blue_purple_share` | share of frames where ≥ 30% of pixels are blue-purple | ≥ 0.12 | ≥ 0.30 |
| `worst_window_fast_ratio` | the slackest 30 s window (half the film when shorter than 60 s) | ≤ 0.02 | – |
| `longest_still_s`, `max_event_gap_s` | review hints only | ≥ 6 s, ≥ 15 s | – |
| `flashes_per_s` | general flashes in the densest one-second window (WCAG 2.3.1): a flash is two opposing swings of relative luminance by ≥ 0.10, darker side below 0.80, over ≥ 25% of the frame; measured per pixel at 30 fps, so a fade over a few frames is one swing | 3 | > 3 |

The lines come from the reference author's judgement of 13 films ≥ 45 s (approved films ≥ 0.068, rejected ≤ 0.021) and 88 films for blue-purple. Below 20 s a red `fast_ratio` is downgraded to yellow. Measured here: the OCS film 0.129, the three.js promo 0.096, the yarn film 0.236, the hand-written starter 0.090 (landscape) and 0.117 (portrait), the helper-based starter 0.076 and 0.089, the data-story example 0.054 and 0.072; a calm 138 s reference video 0.026. A pale, sparse composition can pulse correctly and still score low: a fast move must change much of the frame. Fix the composition (bigger, filled subject), not the threshold.

Overrides are recorded in the report: `--allow-static "why"` (or `look.allowStatic`) and `--allow-blue-purple "why"` (or `look.allowBluePurple`; the reference author's own Starry Night speedrun measures 0.41). Cuts are found by a frame-difference spike that also changes the luminance histogram; authored `cut: true` shots are always treated as cuts. Without camera-motion estimation, a very fast whip between similar frames can be counted as a cut.

A red flash light has no override: a strobe can trigger seizures in photosensitive viewers. Slow it to three flashes a second or fewer, keep the flashing area under a quarter of the frame, or shrink the brightness swing. Saturated-red flashes (the other half of WCAG 2.3.1) are not measured.

The lights cannot see a page frame, a collage of styles, a strong start with a slack middle the window misses, or an unclear story. Stillness metrics are hints: a pulse film legitimately holds still for long stretches.

## Independent review

Before delivery, someone who did not make the film watches only the MP4 (and its contact sheet) and writes notes into `<project>/reviews/<round>.md`. `render` lists those files in the report (`independent_reviews`); it never vouches for their content. With an agent, give the reviewer the MP4 path, the contact sheet and the viewer's intended takeaway, nothing else, and ask for:

- each issue with a timecode, what the viewer sees, and the likely cause;
- the six failure modes, checked one by one;
- regressions from the last round listed separately from new findings.

### Translate the note into numbers

Review notes arrive as feelings. Turn each into a change you can measure before touching code, and write the number into the round's notes so the next round can check it.

| the note | what to change |
|---|---|
| "make it pop" | one scale accent on the hit: 1 → 1.08 → 1 over about 6 frames, peaking on the beat or the spoken word; not on every element |
| "premium", "expensive" | entrances on ease-out quint (`easings.quintOut`, cubic-bezier(0.22, 1, 0.36, 1) on [easings.net](https://easings.net/#easeOutQuint) by Andrey Sitnik), springs at `springZeta(t, 0.8)`, no overshoot on text, longer holds than feels necessary |
| "playful" | springs at zeta 0.5, small rotations (±3°), stepped secondaries (`M.step`) |
| "it drags" | shorten every hold by one beat (60 / BPM s), cut the longest hold first; keep the ≥ 0.5 s after a number lands |
| "too busy" | one hero move at a time; secondaries start 100–200 ms after it and travel 50–70% as far; ambient motion under 5% of the frame's size |
| "hard to read" | check `text_check` reading and contrast notes first; fewer words before longer holds |
| "looks like AI" | name the defaults the render used (centred title card, blue-purple glow, every element fading in, uniform drift, symmetric layout), add them to the banned list, re-render without them |
| "feels robotic" | `still --onion` across the move: evenly spaced ghosts are linear; ease it so the ghosts bunch towards the landing |

Keep a living banned list in `reviews/banned.md`: each line a default the first render used anyway (the centred end card, the fade-in on every element, the 0.5 s cross-dissolve) and the round it was banned. Read it before each new round and each new film in the same project; a fix that reintroduces a banned default is a regression.

If the same class of issue survives three rounds and two fixes, go back to the assets or the renderer instead of polishing. Once the user picks a version, freeze code, timeline, mix and subtitles together.

## Lessons travel with the project

Keep a `## Lessons` section in DIRECTOR.md. Record what worked as **do / evidence / why / when**, and each new problem as **symptom → cause → fix → verified by**. The next session, another style or another model can then continue from evidence instead of taste.

Lessons from the iphone-use promo (2026-10), now checked by `render`:

- **Listen with a second pair of ears.** symptom: "AI" spoken "A-A-I", 重试 spoken zhòng shì; six visual review rounds missed both → cause: nobody listens to every TTS take → fix: speech recognition against the script (`narration_check`, `voiceover check`) → verified by: both misreads flagged on the real clips, the corrected lines pass.
- **Measure text against the frame.** symptom: a callout's second line ran 100 px off the right edge for five seconds in one cut → cause: layout changed late, only one format reviewed at full size → fix: `text_check` measures every drawn string → verified by: the reconstructed cut reports 43.1–48.2 s, the reviewer's own 43.2–48.2 s.
- **Hand over, do not stack.** symptom: "任何 App，不需要 API" was still fading out when "一步写入 278 字" slammed into the same spot; the opening of a promo shipped to nine platforms with two lines overprinted for 0.08 s → cause: the next stamp started 0.1 s after the previous one's `until`, inside its 0.18 s exit → fix: start the next line after the old one has gone (or move it elsewhere); `text_check` now reports collisions and re-draws every frame where visible text changes → verified by: all four cuts report 2.80–2.87 s, and a footnote showing through a translucent subtitle plate in the Chinese portrait cut.
- **Publish only release masters.** symptom: a README-sized cut, then a cut from before the last review fix, went to five platforms and had to be re-posted → cause: files copied by hand from `out/` while the film was still changing → fix: `render --release` + `verify --manifest` before each upload.
- **Keep what you published reproducible.** symptom: the published cut could not be re-rendered at higher quality because its narration had been regenerated in place → fix: every render's inputs are a snapshot; `render --snapshot <id>`.

### Blur on fast camera moves

Two blur samples produce two discrete images during a large pan or zoom, especially on
text and real UI. Prefer no blur for readable UI, or try 4/8 samples and a smaller shutter;
inspect the fast transition at full resolution. Validation conservatively warns for every
2-sample blur because arbitrary drawing code does not expose a reliable camera velocity.
