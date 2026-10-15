# Direct the film

This is an editable motion study of the pulse rhythm. Replace the drawing and shot plan for the subject; changing only the text makes another template video. Method: [directing.md](https://github.com/leeguooooo/motion-use/blob/main/references/directing.md).

Before coding, fill `film.json` → `brief` (subject, purpose, audience, tone, length; `validate` lists the TODOs), then write:

- The viewer's one takeaway, backed by the product/source.
- The look, locked for the whole film: one style sentence, one palette, the character approach. Put it in `film.json` → `look`.
- The object that carries the film from the first shot to the last: a real action, object, recording, illustration or diagram.
- A shot plan: for each shot, the object, what it does, the camera move (`hold`, `push`, `pan`, `slam`…), the few words on screen, and how the next shot inherits an object or motion.
- The reference and what you are borrowing (timing, framing, typography), with attribution. `motion-use breakdown ref.mp4` measures a video; `motion-use reference <url>` saves a gallery entry with its credits. Describe the borrowed technique in your own words; never paste the source prompt.
- The four decisive frames: opening (a concrete small scene, not a title), action, consequence, resolution (an action on the subject, not a centred card).

The default is an 18-second study: two objects, one message, a reply, a network, a name written onto the receiver. There is no required shot count or palette. The code is `composition/draw.js`; `film.json` contains copy, look, output formats, authored shot windows and audio placement.

## Check against the six failure modes

Slideshow pacing · copied demo · no concrete object · dead background or empty frame · drawing what exists as footage · the generic AI look.

## Review

- Does something meaningful change while narration plays? Does the camera move on events and then hold?
- Is motion explaining the idea, or decorating a slide?
- Do objects carry between shots? Does the viewer know where to look?
- Are short holds deliberate, and text readable at phone size?
- Is the first second already interesting? Does the last beat pay off the opening?
- Have source facts and footage provenance been checked?
- Did `render` report any `narration_check` line or `text_check` run? Listen to each flagged clip; look at each reported time.
- Is every file you hand over listed by `verify --manifest out/release/release-manifest.json`?

Run `motion-use still . --allow-code`, examine the frames, then render. Read `out/review/<id>/report.json` (including the motion lights) and watch the MP4. Technical pass is not visual approval. Have someone who did not make the film write notes into `reviews/`. Keep `reviews/banned.md` as a living list of defaults the first render used anyway (centred end card, fade-in on every element, uniform drift); read it before each round. Keep feedback and remaining issues here so another session can continue.

## Lessons

What worked, as do / evidence / why / when; new problems as symptom → cause → fix → verified by.

## Direction and source-to-shot record

When the direction is open, compare A (direct), B (another medium), C (another telling) in DIRECTIONS.md, with one real keyframe each or a 2–4 second motion test. Record an existing choice/delegation and proceed without another gate. Read the production method: https://github.com/leeguooooo/motion-use/blob/main/references/production.md

| Required fact / feature | Source evidence | Shot ID / time | Visible change | Card / adapted parameters | Cue | Final review evidence |
|---|---|---|---|---|---|---|
| Fill for this subject | Source URL or file | Same ID as film.json | Object/action/consequence | catalog ID or custom | named time or none | Timecode/frame |

Browse `motion-use catalog styles` / `catalog shots`; `catalog --out <fresh-dir>` writes a live study gallery. These are mechanisms to adapt, not film templates. Check one frame before committing to a drawing/footage/mixed route.

Keep review findings as time/frame → observable issue → change → rechecked artifact. Retain previous versions and cite the final cut; do not replace evidence with a quality score. Record material sources/permissions in film.json provenance; hashes are calculated by handoff. Use no-captions/no-bgm variants and `handoff` for editing; code-drawn motion remains baked in the picture.
