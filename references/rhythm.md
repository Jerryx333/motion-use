# Whole-film rhythm

Plan how the film changes intensity before writing every move. Choose
`continuous` (one world and its consequences), `montage` (cuts carry the beat),
or `hybrid` (a continuous spine with a burst). These are directing choices, not
quality grades or rules that every film needs a drop.

An optional `film.json.rhythm` makes that plan executable and reviewable:

```json
{
  "route": "continuous",
  "bpm": 120,
  "phases": [
    {"id":"opening","from":0,"to":2,"type":"hook","energy":7,"action":"A signal reaches the receiver"},
    {"id":"ending","from":2,"to":4,"type":"resolve","energy":3,"action":"The resulting value stays readable"}
  ],
  "events": [
    {"id":"arrival","at":1,"kind":"reveal","shot":"a"},
    {"id":"reply","at":2,"kind":"sound","shot":"b"}
  ]
}
```

Adapt the times to the actual film. Phases cover its full duration without gaps
or overlap; IDs are unique. Types: `hook`, `build`, `hold`, `burst`, `stop`, `peak`,
`resolve`. Each has a concrete `action` and declared `energy` from 0 to 10. A
`stop` also needs a `reason`. Optional `shots` lists IDs overlapping that phase.
Event kinds: `cut`, `camera`, `reveal`, `text`, `sound`, `instrument`; optional
`shot` must contain the event time. Events use [from,to) windows at boundaries.

```sh
motion-use rhythm ./film --json
motion-use validate ./film
```

The report distinguishes `UNPLANNED`, `PLANNED` and `INVALID`. Missing rhythm is
compatible with existing projects and does not fail a release. Invalid supplied
timing fails validation. Weak contrast or a missing hook/resolve is a review
warning, never a measured aesthetic failure. The full render report also includes
the plan alongside its existing motion measurements.

`bpm` here is an optional **declared planning tempo**, not a measured soundtrack
tempo and not inferred from root BPM or score code. Per-bar density is unknown
without it. With no `events` field, event counts/densities are unknown; an explicit
empty array means the author listed zero events. Counts never imply that the
actual drawing or sound contains those events. Visual and listening review stay
`UNREVIEWED`.

## Share a landing time with the score

In draw.js use `M.rhythmEvent('arrival')` in a tween or reveal. In score.js use
`S.rhythmEvent('arrival')` for its accent. Both return the same absolute film
second; unknown IDs throw. `M.rhythmPhase(id)` / `S.rhythmPhase(id)` expose the
declared phase (`from`, `to`, `energy`, `action`). The score's `film.rhythm` also
contains the plan. These helpers do not generate moves, notes or sound effects.
Displayed words still belong in `copy`, not in planning `action` descriptions.

Retime moves phase boundaries that coincide with shot boundaries. Event offsets
stay relative to their original containing shot. A boundary inside a shot, or an
event that no longer fits, fails before writing a proposal. Review and explicitly
edit those times; retime never silently stretches the plan. These anchors are in
actual output seconds, independently of `authoredDuration` choreography clocks.

The workflow was informed by huashu-motion's rhythm direction. The schema and
implementation are original to motion-use; see ASSETS.md for the pinned source.
