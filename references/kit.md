# Writing a film with the kit

Everything needed to write `composition/draw.js` for most films, on one page. Full contract: [film.md](film.md). Directing method: [directing.md](directing.md). Looks: [grammars.md](grammars.md).

```js
window.drawFrame = function (c, t, film, view, M) {
  const { width: W, height: H, vertical: V } = view, u = M.unit, p = film.copy, k = M.palette();
  M.paper(c);                                             // palette background with paper grain
  M.shoot(c, t, [[1.2, "push", [W * 0.3, H / 2], 0.28], [3, "slam"]], () => {
    M.chart(c, t, { data: "sales", at: 0.3, highlight: "Q3" });
    M.callout(c, t, [W * 0.62, H * 0.3], p.peak, { at: 1.6, sub: p.why });
  });
  M.captions(c, t);                                       // narration subtitles
};
```

Portrait feeds cover the picture: navigation at the top, the author row, caption and like/comment bar at the bottom, an action column on the right. `view.safe` (`{x, y, w, h}`: 6–86 % across and 10–76 % down in portrait, 5 % margins otherwise) is where text and key action belong; `M.captions(c, t)` already sits at its bottom. Check with `still --guides`, which tints what the platform UI would cover.

Rules: draw from `t` only; paint the background every frame; words go in `film.json` `copy` (per language), numbers and series in `data` (one place to change them), images in `assets`, footage in `videos`. Sizes scale with `u` (1 at 1080p). `k` is the locked palette: `bg`, `surface`, `ink`, `sub`, `accent`, `accent2`.

Every time-based helper is `(c, t, …positional, options)`; points are `[x, y]`; `at` is when it starts.

| helper | does |
|---|---|
| `shoot(c, t, events, drawWorld, base)` | camera: `[at, "push", [x,y]?, k]` · `[at, "pan", [x,y]]` · `[at, "to", [x,y], z]` · `[at, "slam"]` · `[at, "shake", amp]` · `[at, "cut", [x,y], z]`; `base` = `{x, y, z, anchor?}` at start; object camera events accept `anchor:[screenX,screenY]` |
| `cue(name)`, `hasCue(name)`, `at(phrase, {shot, occurrence})` | named imported keyword seconds, or cache-matched measured speech boundaries; missing timing throws |
| `list(c, t, [[at, items], …], {x,y,gap})` | updating legend with non-overlapping text handoff; shared items drawn once |
| `map(c,t,geo,{fills})`, `geoPoint(geo,lon,lat)`, `route` / `arrow` / `pin` | compiled GeoJSON regions, timed fills and geographic marks; see film.md |
| `captions(c, t)` | narration subtitles from the voice track (sentence cues; estimated when the service gave none); long lines wrap into two balanced lines |
| `captions(c, t, [[text, start, end], …])`, `caption(c, t, text, start, end, {x, y, align, size, plate, lines})` | beat titles in a masked slot: rise 0.35 s, hold, leave 0.18 s |
| `words(c, t, text, [x,y], {at, stagger, times, style: rise\|slam\|pop\|type, emphasis: [words], until})` | kinetic words entering in turn |
| `stamp(c, t, text, [x,y], {at, until, box, rotate})` | a word slammed in, 1.55 → 0.94 → 1 |
| `counter(c, t, [x,y], {value, from, at, dur, prefix, suffix, decimals})` | number rolling to `value` (a `data` key or a number) |
| `chart(c, t, {data, type: bar\|line\|dots, at, highlight, x, y, w, h, max})` | bars grow in turn, line draws on; labels may be `{en, zh}` |
| `callout(c, t, [x,y], text, {at, until, sub, dx, dy})` | dot, pulse, leader line, label |
| `card(c, [x,y], {label, fill, icon, scale})`, `pill(c, t, [x,y], text, {from, to})` | a filled object; a message that swells and collapses |
| `stroke(c, t, points, {at, dur, until, pen, rough})`, `node(c, t, a, b, {at})`, `ripple(c, t, [x,y], {at})` | drawn lines with an optional pen; link-and-dot; arrival rings |
| `signature(c, t, text, [x,y], {at, dur, underline})`, `write`, `pen` | handwriting with the marker |
| `cover(c, image, {x, y, w, h, fx, fy, zoom})`, `video(name, t)` | image or current footage frame covering a box, zoomed on a focus |
| `spotlight(c, t, [x,y,w,h], {at, until})`, `cursor(c, t, [[t,x,y], …], {clicks})` | dim all but a region; a pointer that moves and clicks |
| `grade(c, "mono"\|"tint"\|"duotone", …)`, `grain(c, t)`, `vignette(c)` | whole-frame looks, drawn last |
| `follow(t, [[at, value], …], {f, d})` | a number or point that springs to each new target in turn, a pure function of `t` (UI morphs) |
| `tween(t, at, dur, ease)`, `springZeta(t, zeta, hz)`, `springHz`, `settle`, `lagged`, `step`, `easings.*` | timing building blocks; `springZeta` takes seconds since the move and a damping ratio (0.8 premium, 0.5 playful, 1 no bounce) |
| `rough`, `drawOn`, `paragraph`, `wrap`, `ring`, `lerp2`, `add`, `rng`, `noise` | drawing building blocks |

```json
"look": {"style": "one sentence", "palette": "paper", "character": "hands only"},
"data": {"sales": [{"label": {"en": "Q3", "zh": "第三季度"}, "value": 18}]},
"videos": {"demo": {"file": "footage/demo.mp4", "at": 4, "from": 12.5, "rate": 1, "volume": 0}},
"music": {"score": "composition/score.js"},
"shots": [{"id": "peak", "start": 0, "end": 4, "camera": "push", "text": {"en": "Q3 peak"},
           "purpose": "…", "action": "the Q3 bar grows past the others and a callout pins it",
           "narration": {"en": "Sales peaked in the third quarter."}}]
```

Palettes: `paper` `poster` `ink` `navy` `bauhaus` `snow` `wood` `chalk` `whiteboard`, or 3–6 hex colors. Music: each film's own `composition/score.js` ([music.md](music.md)); a built-in bed (`promo` `explainer` `pulse` `chiptune` `pentatonic` `ambient`) only with `music.why`; or a song: `{"file": "audio/song.wav", "bpm": 128, "from": 1.3}` from `motion-use beats`. Original documentary accents: `stamp`, `thud`, `paper`, `explosion`, `train`, `map-pin`, `page-turn`, `low-boom` (stylized, not historical recordings). Sound effects take `"align": "peak"` to land their hit on `start`; `"loop": true` checks the last frame leads into the first. Beat-driven briefs and the one-shape morph: [briefing.md](briefing.md). Footage frames are extracted at build time (≤ 5,400 per film); sound only at rate 1.

## Cheap iteration

```bash
motion-use validate .                                  # plan warnings, glyphs, narration fit
motion-use still . --allow-code --shot peak            # three frames of one shot
motion-use still . --allow-code --format vertical --guides   # tint what platform UI covers
motion-use still . --allow-code --beats 4              # one frame per bar of the beat grid
motion-use still . --allow-code --onion 4.4-5.2        # 8 frames of a move in one PNG: is the spacing eased?
motion-use beats audio/song.wav                        # imported song: tempo, downbeat, drop → music line
motion-use render . --allow-code --from 3 --to 7       # silent draft of a range, no delivery checks
motion-use render . --allow-code --quality draft --json  # compact summary; full report on disk
```

Look at an image only when the numbers do not settle the question. A `demo_similarity` above 0.3 means the film is laid out like the starter: redesign it, do not re-skin it.

## Three examples, three looks

- [examples/data-story](../examples/data-story/): finance chart, data in `film.json`, a bar that shrinks when its value changes.
- [examples/whiteboard](../examples/whiteboard/): marker on a wide board, the camera framing each idea, then the whole.
- [examples/kinetic](../examples/kinetic/): one heavy word per beat, flat colour chapters, a stroke that crosses out the last word.

The production workflow, preview directions, style/shot gallery, speech timing and layered editing handoff are in [production.md](production.md). For frame timing from actual narration use `retime`; for measured Azure word boundaries use `voiceover --word-timing`. Catalogue studies are intentionally silent.


For text used as decoration or texture, wrap the synchronous drawing in
`M.texture(c, ctx => { ctx.fillText(...); })`. It draws normally and excludes only
that scope from clipping, collision, contrast and reading checks. Use ordinary
text calls for information the viewer must read. An OffscreenCanvas texture
composited with drawImage is also supported. Exact same-font, same-baseline
substring colour repaints are recognized as highlights; displaced text still
collides. Prefer separate prefix/highlight/suffix draws for complex alignment.

Use `M.shotTime(t, id)` for shot-local choreography that follows retime. With a
shot `authoredDuration`, it returns authored seconds; without one, actual local
seconds. `retime --scale-timing` records the original durations. See film.md for
`pace`, speech regeneration and matching score offsets.

`M.rhythmEvent(id)` reads an event's absolute output second from the optional
`film.json.rhythm` plan; `M.rhythmPhase(id)` reads its declared phase. Score helpers
use the same names, so a picture event and musical accent share one anchor.
Missing IDs throw. These declarations do not prove the event was drawn or heard;
see [rhythm.md](rhythm.md).
