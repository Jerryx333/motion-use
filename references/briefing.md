# Briefs and recipes from the AI motion gallery

[awesome-ai-motion](https://github.com/guanmo-ai/awesome-ai-motion) (观默 / @guanmo_ai) catalogues 937 AI-made motion pieces with their authors' public prompts (107) and source links (32). This page records what the most-saved pieces have in common and how to get the same mechanisms out of motion-use. The prompts belong to their authors and are not covered by the gallery's MIT license, so nothing here copies them: each mechanism is re-described in motion-use terms and links back to the case.

Case links point to the gallery player: `https://guanmo-ai.github.io/awesome-ai-motion/#case-<id>`.

## What the most-saved pieces share

Two of the most-saved pieces with full public prompts ([one shape, a seamless UI morph loop](https://guanmo-ai.github.io/awesome-ai-motion/#case-2103273003555402193), ~19k saves; [beat-synced product ad](https://guanmo-ai.github.io/awesome-ai-motion/#case-2102554209166000267), ~1.4k) and a third that adapts the first ([MakerMap product journey](https://guanmo-ai.github.io/awesome-ai-motion/#case-2103483957266268381)) use the same brief shape. One-line requests ("make a 15-second showreel, go all out") also got saved a lot, but those reward a strong default look, not a method you can repeat.

| part of the brief | what it pins down | in motion-use |
|---|---|---|
| inputs, asked first | product and a one-line promise, 3–12 real UI states with the real data shown in each, one accent colour, brand font, formats, real clips the user owns, a licensed song with a clear drop | `copy`, `data`, `assets`, `videos`, `look.palette`, `formats`, `music.file` |
| direction | one idea per shot, a lot of empty space, one accent, one sans with tight tracking, one camera language, and an explicit **banned list** (particle bursts, shockwave rings, RGB split, lens flares, neon glow, grid floors, flashing backgrounds, bouncy easing) | `look.style`; the banned list goes in DIRECTOR.md and the six failure modes in [directing.md](directing.md) |
| structure on a beat grid | N bars at a fixed BPM, one move per bar, every cut on a downbeat and every UI hit on a beat; the hook lands word by word on beats | `motion-use beats song.wav` → `music.from` + `bpm`; shots start on bars; `M.beat(t)` |
| build rules | every value computed from `t`; springs in closed form; sound effects placed by their measured peak; loudness at -14 LUFS; real motion blur from subframes | the film contract ([film.md](film.md)), `M.follow`, `align: "peak"`, `render` normalization, `motionBlur` |
| look before rendering | one frame per beat as a contact sheet; fix anything cramped, overlapping or off the grid, then render | `motion-use still . --beats 1` (or `4` per bar) |
| gotchas | text that swaps inside a morphing container needs its own enter and exit; make the last frame equal the first, cursor speed included, or the loop stutters | the content window rule below; `"loop": true` |
| start | ask for the inputs, then show the storyboard with every timing on the beat grid before writing code | the Plan step in SKILL.md, with timings from `beats` |

Two DOM-only gotchas in those prompts (opacity on `preserve-3d`, `will-change` on scaled text) do not apply: motion-use draws to a canvas.

## A brief to fill in

Ask for this before planning a beat-driven piece; drop what the subject does not need.

```text
Subject and one-line promise:
Real states or scenes to show (3–12), each with the real data it displays:
Real material: screenshots, recordings, clips the user owns:
Look: one accent colour, one font, light or dark, banned effects:
Formats: landscape / vertical / square
Song: a file the user may use commercially (or a built-in mood), and where the drop should land
Length: N bars at the song's BPM
```

Then: `motion-use beats song.wav`, write the shot list with every start on a bar, show it, and only then write `draw.js`.

## Recipe: one shape, never cut

The mechanism behind the most-saved piece. One element morphs through every state; it is never cut away.

- **Every state is the same shape** changing position, size, radius and colour. Key each change on a beat with `M.follow(t, [[at, [x, y, w, h, r]], …])`: one closed-form spring step per change, summed, so a value retargeted mid-flight stays a pure function of `t`. Keep the overshoot small (default `f: 2, d: 12` overshoots about 5%).
- **Stretch by putting two edges on different springs.** Follow the leading edge with a faster `f` than the trailing one; the shape stretches while it travels and settles when it lands.
- **Content has its own window.** Words enter about 0.1 s after their container starts morphing and leave about 0.2 s before the next morph, so two labels never overlap inside a moving box: `M.tween(t, at + 0.12, 0.2) * (1 - M.tween(t, next - 0.18, 0.12))`.
- **Move an accent object between states** instead of flashing the background into the accent colour.
- **Zoom the camera so each state fills the frame** (`M.shoot` push/to events on the same beats).
- **A cursor drives each change** with a click or a drag (`M.cursor`); while dragging, compute the value from the cursor position; on release, `follow` springs it back from wherever it was.
- **Loop it:** the last key returns to the first state early enough to settle, and `"loop": true` makes `render` compare the last frame with the first.

## Recipe: cut to a real song

```bash
motion-use beats audio/song.wav          # tempo, first downbeat, bar loudness, the drop
# paste the printed "music" line into film.json: {"file": "audio/song.wav", "bpm": 128, "from": 1.301}
motion-use still . --allow-code --beats 4  # one frame per bar: does each bar change the picture?
```

- `from` starts the song on its first downbeat, so film second 0 is beat one and `M.beat(t)` counts the song's beats. To open on the drop instead, set `from` to the drop's song time minus the bars you want before it.
- The drop line tells you which film second carries the biggest lift; put the reveal or the first full-frame shot there.
- Sound effects: `{"effect": "whoosh", "role": "sfx", "start": 8, "align": "peak"}` puts the loudest moment of the clip on second 8 instead of the start of the file (a whoosh peaks well after it starts).
- `beats` assumes 4/4 and says when it is unsure (`confidence` below 2: no steady beat; a low `downbeat_confidence`: check which beat is one). A model listening to the song is a guess; measure.

## Other things that recur

- **Line-drawing explainers** are the most repeated Chinese request in the gallery (线稿, 轻松有趣, 配乐, TTS narration, bilingual subtitles), for example [five thousand years of Chinese history](https://guanmo-ai.github.io/awesome-ai-motion/#case-2102583898865873225) and [atmospheric circulation](https://guanmo-ai.github.io/awesome-ai-motion/#case-2102606609574941028). In motion-use: the whiteboard grammar ([grammars.md](grammars.md)), `M.write`/`M.stroke`, narration per shot and `M.captions`.
- **Research first, references as feeling, not style.** The [Austerlitz film](https://guanmo-ai.github.io/awesome-ai-motion/#case-2103116235009347650) asked for the battle to be researched, the paintings used for scale and atmosphere, and a stronger visual language if one existed. Same rule as here: verify claims against sources; learn the mechanism of a reference, never its pixels.
- **Score the parts until each passes.** The [dragon-ship scene](https://guanmo-ai.github.io/awesome-ai-motion/#case-2103122947133309311) had every element scored and improved until it reached 8/10. Here that is the independent review in [directing.md](directing.md): timecoded issues per round, at most three substantial passes, then disclose what remains.
- **Real photo, drawn over.** One piece found a real street photo first and lit its drawn figures from the photo's lamps ([rain on a street photo](https://guanmo-ai.github.io/awesome-ai-motion/#case-2102611841122017632)). Here: the photo in `assets`, `M.cover` full frame, drawing on top.
- **Show directions before building.** The [lyric video](https://guanmo-ai.github.io/awesome-ai-motion/#case-2103741636635496583) asked for the staging plan first; [directing.md](directing.md) asks for three compositions when the style is open.
- **State between frames breaks renders.** [claude-animation-skill](https://github.com/buildwithhanif/claude-animation-skill) checks that a frame drawn out of order matches the frame drawn in order. `motion-use still` now redraws its first frame at the end and warns when the two differ.

## What motion-use leaves to other tools

About a fifth of the gallery is interactive 3D (three.js, WebGL, Blender) and about one in eight is generated video (Seedance, Kling, Veo). motion-use renders exact-time 2D and WebGL/three.js, and accepts external command renderers for scenes better built in Blender or another engine. Generated video remains an input from the tools the cases name; use it as footage inside the film.

Tools the cases link to, studied for this page: [huashu-art-motion](https://github.com/alchaincyf/huashu-art-motion) (already the source of the directing method), [HyperFrames community skills](https://github.com/heygen-com/hyperframes-community-skills) (single-purpose HyperFrames workflows), [motion-graphics-skills](https://github.com/charlie947/motion-graphics-skills) (a brand-intake-first skill pack), [claude-animation-skill](https://github.com/buildwithhanif/claude-animation-skill) (detail vocabulary per surface, character rigs, an in-order/out-of-order frame check).
