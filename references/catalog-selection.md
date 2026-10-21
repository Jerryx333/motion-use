# Choose a mechanism for the subject

Start with the available evidence and what the viewer must understand. The
catalog's selection tags explain which existing study might help; they are
authored guidance, not measured effectiveness or an audience-response score.

```sh
motion-use catalog recommend --product-type developer-tool --material screenshot --json
motion-use catalog recommend --product-type data-explainer --material data --out ./candidate-studies
motion-use catalog styles product --json
motion-use study before-after ./study-before-after
```

Product types: `developer-tool`, `data-explainer`, `education`, `hardware`, `brand`.
Material types: `screenshot`, `recording`, `document`, `data`, `text`, `diagram`,
`object`. Supply either or both. With both, a candidate must match both. Unknown
types fail explicitly; a valid combination without candidates returns `NO_MATCH`,
not an invented fallback. Matches retain catalog order and are not ranked.

Every card includes `fit.productTypes`, `fit.materials`, `fit.chooseWhen`, and the
command for its six-second study. `reasons` names the matched inputs and why the
mechanism may fit. Gallery details show those conditions together with the
mechanism, parameters and pitfalls. The studies themselves remain illustrative.

For a developer tool with screenshots, inspect `product`, `editorial`,
`focus-handoff`, `parallax-tour`, `before-after` and `shared-shape` where they
match the available material. For numerical comparisons, inspect `data-story`,
`chart-reveal` and aligned `before-after` states. A card does not establish that
your data are correct or that the depicted product behaviour is real.

Use a real product frame, font, copy and brand palette for the cheap preview.
Record the selected card and adapted parameters in DIRECTOR.md. Reject a
mechanism when its pitfalls conflict with the subject. Existing A/B/C direction
reviews still apply when the user is choosing a direction; no new approval gate
is added when a direction was already chosen or delegated.

This explicit product/material selection workflow was informed by huashu-motion;
the tags and studies are original motion-use guidance, without upstream media.
