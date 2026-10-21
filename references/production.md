# From a direction to a reviewable film

Use this alongside [directing.md](directing.md) and the [film contract](film.md). The renderer owns exact time, packaging and measured checks. The agent owns the subject, visual argument and choice of technique.

## Review the script before production

For a new film, write SCRIPT.md before authoring film.json, drawing code, speech or music.
Init creates scaffolds; those files are not an approved plan. Include audience/takeaway,
opening frame, first line, shot IDs, source-backed actions, spoken copy, displayed copy,
screen text, intended windows and ending action. Existing user-approved copy counts as reviewed.

Review four stages in order; fix a revise result before proceeding:

| Stage | Reviewer receives | Record | Check |
|---|---|---|---|
| Script | SCRIPT.md and claim/source excerpts only | reviews/01-script.md | Concrete opening that earns attention; no unsupported claims, filler, abstract nouns in place of actions, repeated three-part patterns or forced slogans; each line matches a visible change; speech/reading budget; ending action |
| Storyboard | One selected keyframe per shot, copy and intended takeaway | reviews/02-storyboard.md | Composition, scale, subtitle placement, labels over the subject |
| Rhythm | Only the draft ranges whose timing is in question | reviews/03-rhythm.md | Holds, transitions, camera moves, readability and speech synchronization |
| Final | MP4, contact sheet, takeaway and unresolved notes | reviews/04-final.md | Continuity, technical defects and remaining detail; reopen earlier stages if their content changed |

Every record says pass/revise and names exact lines, shots or timecodes to change.
Use a fresh reviewer when available; do not repeatedly give a text reviewer the full video
or entire source repository. Mechanical checks do not establish an engaging opening.
Approval here is a review result, not an extra user confirmation requirement.

## Obtain real source material

First check the product for screenshot tests, a headless renderer, Storybook, deterministic
fixtures or an existing capture command. These can produce real UI frames at repeatable
sizes without taking over the user's display. Preserve the product version, fixture and
capture command with the footage. Use a local PNG image sequence directly in `videos`
instead of encoding an intermediate MP4 and extracting JPEGs. Use actual recordings where
live behavior matters; label diagrams and fabricated UI as illustrations.

## Compare directions cheaply

When the direction is open, propose three different approaches to the same facts:

| Direction | Difference | Preview |
|---|---|---|
| A · direct | The clearest explanation using the source material | One representative frame |
| B · another medium | Same message with a different material, type and motion treatment | One representative frame |
| C · another telling | Change the structure: one continuous object, a metaphor, reversed reveal or one camera journey | One frame, or 2–4 seconds when motion is the deciding factor |

For each, write the viewer's takeaway, palette/type, concrete opening/action/resolution, narration/music approach, implementation route, and any material limitation. Render the actual font, content and layout; placeholder boxes cannot settle a visual choice. Observe a short render before estimating full-render cost; otherwise mark it unknown.

Record the candidates in project-local `DIRECTIONS.md`. For each preview, record its path, the command and the code/film revision it used. When discussing alternatives, wait for a choice. When the user has already chosen a direction or delegated it, record that and proceed; do not add another confirmation gate. A small correction to an existing cut does not need three new proposals.

A code-based preview must run through the same drawing mechanism as its intended film. Still frames cannot demonstrate timing. Do not produce three complete films to choose a direction.

## Map the message onto shots

Write this table in `DIRECTOR.md` before implementation. Use stable shot IDs from film.json.

| Source fact / required feature | Evidence | Shot ID / time | Visible state change | Card / adaptation | Keyword cue | Review evidence |
|---|---|---|---|---|---|---|
| What must be understood | Source URL or local screenshot | Same ID as film.json | Object, action, consequence | Catalog ID, parameters changed and why | Named cue or none | Final frame/timecode |

Every required feature needs a visible, readable shot. A beautiful camera move over a generic UI does not demonstrate a feature. Actual product claims need actual product material. Label invented diagrams and schematic UI as illustrations.

Browse original motion-use mechanisms:

```bash
motion-use catalog styles
motion-use catalog recommend --product-type developer-tool --material screenshot --json
motion-use catalog shots
motion-use catalog shots parallax-tour --json
motion-use catalog --out ./motion-gallery
# Open motion-gallery/index.html; pause or scrub the shared 6-second studies.
motion-use study parallax-tour ./parallax-study
motion-use still ./parallax-study --allow-code --at 1,3,5
motion-use render ./parallax-study --allow-code --quality draft
```

The gallery and study projects use the same implementation (`src/catalog-study.js`). They are short, silent mechanism studies with illustrative objects, not finished adverts. Styles constrain material, type, rhythm and camera; shot cards describe an action. Select each independently. Retain a card's meaningful timing relationships while adapting its layout to the subject. Portrait needs a new composition inside the safe area; the study canvas itself is a landscape demonstration.

## Speech drives time

Before implementing every move, choose continuous, montage or hybrid and sketch
the whole-film intensity changes. Optional `film.json.rhythm` turns that into
validated phases, declared events and shared drawing/score anchors. Use
`motion-use rhythm <film> --json`; it reports author planning, not measured film
quality. Keep missing event/tempo data unknown. See [rhythm.md](rhythm.md).

Draft each shot's duration as the maximum of visible action, reading time and narration, plus the necessary opening/closing hold. Generate or import the audio, then retime against its actual length. For a hard duration limit, shorten the script or reduce scope; do not cut the voice or silently accelerate it.

For imported recordings, supply checked sentence subtitles under `captions.<lang>` and named word/phrase timestamps under `cues.<lang>` in film.json. See film.md. Mark estimates as estimates. Tie a reveal to `M.cue('result')`; missing cues throw rather than putting an action at second zero. Keep one event time for the picture and sound. Sentence interpolation does not establish a measured word onset.

Build the visual argument before adding textures. Verify one full-resolution frame first. Choose pure drawing, layered images, footage or an external engine based on the desired movement. A soft painting texture does not imply that code can produce a natural painted character performance; character/episodic work belongs in drama-use.

## Review what reached the file

Review the final MP4 against the source fact/shot table, chosen direction, card mechanism and approved copy. Technical measurements alone do not establish narrative or visual quality. If an independent reviewer is available, give them the actual cut, requirements, selected cards and reference frames without the maker's explanation. Do not require multi-agent infrastructure just to render a film.

For a point-specific correction, use the [offline frame review](frame-review.md)
to collect image bytes, location, declared time and source revision together.
Mark a note addressed only with a current revision and a new frame; visual
acceptance remains separate. This complements the MP4/rhythm review rather than
replacing playback with a still.

Record observable issues in `reviews/<round>.md`:

| Severity | Time / frame | Observable issue | Required change | Rechecked artifact / result |
|---|---|---|---|---|
| Must fix / improve / cannot verify | Exact location | What the file shows or sounds like | Concrete action | New cut and frame/time |

Check missing features, style drift, material quality, readable holds, voice intelligibility, audio/video hits, the opening hook and resolution. Compare the fastest move with a filmstrip and a full-resolution frame. Recheck old issues separately from finding new ones. After three substantial passes with the same failure, revisit the material or technique and state what remains; do not inflate a score until it passes.

Keep versions of the accepted code, time, subtitles and mix together using render snapshots. A changed script or audio invalidates old keyword timing and reviews. Preserve source attribution; project-specific feedback and private footage stay in the project. A recurring cross-project issue belongs in a card or a measurable check once its fix is verified.

## Give the editor useful layers

```bash
motion-use render my-film --allow-code --no-captions
motion-use render my-film --allow-code --no-bgm
motion-use render my-film --allow-code --no-captions --no-bgm
motion-use handoff my-film --out ./my-film-editing --json
motion-use handoff --check --out ./my-film-editing --json
```

Each variant gets a distinct output filename. `--no-captions` suppresses `M.captions`, including explicit lists passed to that helper. It does not erase custom drawing, `M.caption` titles, or words baked into footage. `--no-bgm` removes both root music and audio clips with role `music`, retaining narration/SFX; unlabelled clips retain their existing behaviour.

The handoff contains editable SRT, captions with estimated flags, keyword cues, the shot table, separate source audio with resolved placement, declared source files and a hash manifest. It generates the built-in score when present. It does not execute the film, transcribe speech, render a clean picture, flatten the final mix or install a native 剪映/CapCut draft. The editor imports the chosen rendered variant alongside those layers. Avoid doubling audio already present in the imported picture; code-drawn motion remains baked.

Record material declarations in film.json `provenance` (file → sourceUrl/license/useBasis). Handoff computes hashes from the real files. Unknown permission stays `needs-review`, and a supplied licence string remains an unverified declaration. The hash check proves exported bytes have not changed; it cannot prove permission or that the package matches a later source edit. Generate a fresh handoff after changes. Use existing release manifests to verify publication masters.

## Sources studied

These are workflow influences, not bundled upstream prompts, source code or media. Cards and studies in this repository are original implementations.

- [xilo-opus-video](https://github.com/Kianzzz/xilo-opus-video): differentiated directions and cheap real previews.
- [lemo-opuscar](https://github.com/lemomo-ai/lemo-opuscar): browsable style specifications paired with executable studies.
- [mg-styles-15](https://github.com/Vincentwei1021/mg-styles-15): observable style signatures, shared audio/visual cues and timecoded critique.
- [dashi-animationstyle](https://github.com/chuspeeism/dashi-animationstyle): narration-led keyword events and subtitle-free delivery.
- [huashu-art-motion](https://github.com/alchaincyf/huashu-art-motion): frame-first route selection and evidence-backed lessons. Existing grammar adaptations remain attributed in grammars.md.
- [huashu-motion](https://github.com/alchaincyf/huashu-motion): whole-film intensity planning, explicit product/material fit and frame-location feedback; original implementations and pinned attribution are in ASSETS.md.
- [wtt-code-animation-studio](https://github.com/WaterDJiang/Wattter_openSkills/tree/main/wattter_skills/wtt-code-animation-studio): content-led duration and source/version traceability.
- [video-shotcraft](https://github.com/Vincentwei1021/video-shotcraft): parameterized shot recipes, feature-to-shot mapping and separation of baked motion from editable layers.
