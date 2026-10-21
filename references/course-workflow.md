# Course production workflow

Confirm the receiving device, offline requirement and transfer method before batching. Make one complete lesson and test playback there. A desktop browser pass does not establish iPad local-folder playback or cloud-drive preview compatibility.

Keep original questions, independently checked solutions, spoken script, captions and animation references in one project-owned source of truth. Record ambiguity instead of asking the renderer to infer a mathematical answer.

## Revise speech and timing

`narration.<language>` accepts `{say,text}`. Measured spoken word boundaries remain available to `M.at` when captions differ; display cues remain estimated when there is no measured mapping. Audio/script hash mismatches still discard old timings.

```sh
motion-use voiceover lesson --engine azure --word-timing --json
motion-use retime lesson --json
```

Read the returned `film` path. Default retime proposals are `film.retimed.json`, `film.retimed-2.json`, etc.; earlier proposals and the original stay intact. Explicit `--out` never overwrites an existing file. Review the new timeline before adopting it. A failure has no usable new proposal. `--keep-captions` shifts explicit cues wholly contained in one shot, rejecting overflow. `--scale-timing` records original choreography durations for `M.shotTime` and score offsets; film `pace` also scales speech rate and tails after regeneration. Single films support 1–3600 seconds with one continuous soundtrack.

Voiceover generation validates narration inputs, deferring picture/music/SFX/font inputs. Retime defers music while checking existing anchored assets against the proposed windows. Full `validate`, `render` and `--release` still require complete assets.

Pin `narrationCheck.model`, optional `fallbackModel`, and decoding `params` in film.json. Only flagged clips use the fallback. Different models remain in the content-addressed cache; changing the script always reruns comparison. See [narration checking](narration-check.md).

`voiceover check lesson --out review.html --json` produces a static comparison page with playable local audio. Render retains a separate review directory even when the narration gate fails. PASS means automatic comparison passed; `human_review` remains separate. A narrated release/gate rejects FAIL and incomplete transcription; SKIPPED/UNREVIEWED requires `--allow-asr-skip "reason"`. A genuine mismatch needs correction or an exact audio/script/transcript-bound review. Silent projects do not need a skip waiver. Actual ASR configuration and waivers are recorded in reports/releases and frozen in render snapshots.

## Batch and deliver

Use [batch DAGs](batch.md) with explicit inputs, outputs and dependencies, rather than loops that trust filenames. `batch plan` is read-only; `batch run` persists state and verifies output hashes before reuse. Supply per-task storage estimates for shared disk reservations. SIGINT/SIGTERM cancels active child process groups and records cancellation.

[Preflight and cleanup](storage.md) separate observed free space from estimated intermediate/output bytes. Cleanup is preview-first and restricted to known rebuildable caches, with frozen plans and an independently checked root. It never cleans global uv caches.

[Concat chapters](concat.md) use final integer video-frame boundaries. Frame end and audio/container end are reported separately. Preserve reused clip source labels instead of silently relabelling their contents.

[Delivery](delivery.md) offers `videos`, `offline` and `site` packages. Check packages after moving the complete directory. Device and human audiovisual acceptance stay UNREVIEWED until performed. These packages provide no PWA or iPad offline guarantee.

Optional [teaching checks](teaching.md) define reading/operation/thinking/reveal phases and author-state assertions. They supplement text/motion checks. Their sample plans and input binding do not prove the rendered pixels or a correct mathematical solution.

## Time and review evidence

Project commands persist bounded events to `.motion-use/events.jsonl`; `--journal` selects another destination. Batch state contains a shared task/child-command journal. `motion-use stats lesson`, `motion-use stats tasks.json` (or an explicit events.jsonl path) reports wall interval, measured active processing, separate concurrent duration sums, recorded phase durations, retries, cache hits and observed output seconds. Waiting and cost remain null when not measured. Active processing means the observed union of active command/task intervals, including service waits that were not measured separately; it is not CPU or model computation time. This is not a reconstruction of work performed before recording began.

Record mathematics, technical validation, static frames, continuous frames, full playback and human listening separately. A contact sheet or ASR pass must not be labelled full human audiovisual acceptance.
