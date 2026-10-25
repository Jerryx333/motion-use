# Tutorial production and script review

Start with `motion-use init tutorial-demo --mode tutorial --lang zh`. The starter uses an explicitly illustrative screenshot: replace it with real evidence, update SCRIPT.md, the narration and shot purposes before delivery.

Recommended order: script → LLM review and agent fact checks → author review → voiceover listening → draft with narration/music → full release. `render --quality draft` keeps narration and music unless their disabling flags are passed. Review one language/format before rendering all variants.

```sh
motion-use script review tutorial-demo --reviewer gemini --plan
motion-use script review tutorial-demo --reviewer gemini --out tutorial-demo/reviews/01-script-llm.md
motion-use script review tutorial-demo --reviewer chatgpt --transport api --model YOUR_MODEL
motion-use script review tutorial-demo --reviewer claude --response saved-review.json --out tutorial-demo/reviews/02-script-llm.md
motion-use redact screenshot.png --box 40,80,300,60 --box 40,160,300,60 --out screenshot-private.png
```

`--transport browser` (default) requires a logged-in Chrome, `chrome-use` and its `<reviewer>/ask` site adapter. Install/configure these separately; review never installs tools or logs in for you. The current adapters are provided by third-party OpenCLI; browser availability and account UI changes can affect them. Requests use a fresh session and a new conversation; uncertain sends are never retried automatically. Inspect the conversation before retrying a timeout. `--transport api` requires an explicit model ID and `GEMINI_API_KEY`, `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`; API calls use the provider's API billing.

A `--plan` run writes the prompt without contacting a service. Use a fresh `--out` for the actual run. Responses must be JSON: `{"issues":["..."],"rewrite":"full script with picture notes","alternatives":["hook or title"]}`. `--response` imports that format without sending. The prompt, raw response, script hash and result remain next to the Markdown report. A malformed response is retained in the evidence JSON for repair/import. Existing reports are never overwritten.

Add immutable claims and target platforms to film.json:

```json
{"brief":{"facts":["Idle instances may be reclaimed after 7 days"],"platforms":["抖音","YouTube"]}}
```

The request includes these claims and platform-specific editorial constraints. The report lists exaggerations, domestic platform keywords, candidate new claims, and every changed sentence for explicit review. These heuristics cannot establish truth or platform approval. Review starts `UNREVIEWED`; it never replaces SCRIPT.md or records author approval.

## Screenshot steps

Declare image files in `assets` and per-shot steps in `data.steps`:

```json
{"data":{"steps":{"setup":{"n":1,"title":"Open settings","frames":[{"img":"settings","at":0,"box":[80,120,480,160],"label":"Select"},{"img":"result","at":0.6,"box":[0,40,600,200],"label":"Confirm"}]}}}}
```

`at` is an increasing fraction of the shot duration, beginning at zero. Call `M.steps(c,t,film.data.steps[shot.id],{start:shot.start,duration:shot.end-shot.start})`. Retiming the shot preserves these fractions. The header, screenshot, label and progress dots stay in `M.tutorialLayout()`, above the subtitle area. Source boxes use pixels in the original screenshot.

`M.focusShot(c,t,img,box,rect,{at,label,maxZoom:3})` clips to a rounded rectangle, pushes toward a source box occupying up to 80% of the frame, clamps image edges, and draws a red emphasis box and label. Images may be loaded objects or names from `film.assets`. `M.stamp` supports `color`, `rotate`, `box` and a `fill` backing plate. All drawing is a pure function of time. `motion-use catalog shots tutorial-steps` and `study tutorial-steps <fresh-dir>` provide a procedural study.

`redact` applies Gaussian blur to repeated pixel boxes, respecting EXIF orientation and writing a new PNG without source metadata. Check the resulting image visually: blur does not guarantee irreversible removal of sensitive information. Use wider boxes or an opaque replacement when necessary.

## Narration accents and scoped waivers

`narrationCheck.accent: "zh-TW"` adds a neutral accent hint to recognition; `zh-CN` and `zh-HK` are also accepted. OpenCC normalizes traditional glyphs; spoken storage units and simple English currency/unit quantities are normalized before comparison. Quantities, operations and negation remain protected. High-similarity (≥0.85) near-sound substitutions may become `WARNING` with an explicit accent; low similarity, tone changes, polyphones and declared `narrationCheck.terms` remain blocking. Arbitrary synonyms and brand-name changes require review.

`render --release --allow-narration-flags "reason"` waives only fully transcribed, flagged lines from that invocation. Other lines still run through ASR; missing transcripts and skipped ASR remain blocked by their existing rules. Each waived line records its ID, language, exact audio hash, script, transcript and reason in the report/release manifest. The waiver is pinned for snapshot replay and never marks human listening as complete. Prefer an exact `narrationReviews` entry after listening when a durable audio-specific approval is needed.
