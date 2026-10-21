# Narration checks

A transcription comparison is an automatic check. It does not establish that a person listened to the recording, or that a lesson's solution is correct.

## Pin the configuration

Set the project-level configuration in `film.json`:

```json
{
  "narrationCheck": {
    "model": "small",
    "fallbackModel": "medium",
    "params": {
      "beam_size": 5,
      "vad_filter": false,
      "condition_on_previous_text": false
    }
  }
}
```

An explicit command model overrides the project model. Without either, `MOTION_USE_ASR_MODEL` is used, then `small`. The optional fallback defaults to disabled. It runs only for clips flagged by the primary comparison, or for clips without a returned transcript; clean clips retain their primary result. Both attempts remain in the report. A fallback pass is an automatic pass, never a human listening approval.

The supported decoding parameters are `beam_size` (integer 1–20), `vad_filter` (boolean), `condition_on_previous_text` (boolean), and `temperature` (number 0–1). Invalid configuration types and unknown options fail explicitly. Script-derived prompts are deliberately unsupported because they could bias recognition toward the answer being checked. Reports record the resolved model, fallback, decoding parameters and comparator version.

## Status and review evidence

`status` is the authoritative automatic check state:

| Status | Meaning |
| --- | --- |
| `PASS` | The selected transcript passed comparison, or an exact bound review exception was supplied. |
| `FAIL` | The selected transcript has unresolved differences. |
| `SKIPPED` | Recognition did not run, for example because ASR was disabled or unavailable, or there were no narration items. |
| `UNREVIEWED` | A recognizer ran without returning a transcript for a requested clip. |

For compatibility, a skipped result still has `ok:true`; integrations must inspect `status` and `skipped`, not just `ok`. Release policy decides whether skipped or missing checks are acceptable, and must keep the reason with any exception. A silent project has no narrated audio to recognize.

`human_review` is separate. It remains `UNREVIEWED` after an automatic pass, including a fallback pass. An existing review exception requires the exact audio SHA-256, script, selected transcript and nonempty reason. Changing any of those invalidates the exception. Automatic checking does not create such a record.

The static narration review HTML shows the script, model attempts, differences, review state and audio playback links without JavaScript. Audio links point to the project files; retain the relative directory structure when sharing this review.

## Mathematical boundaries

The comparator independently checks number values, mathematical operations and negation. It tolerates Chinese-versus-Arabic notation for equal values, such as `一加五是六` and `1加5是6`, or `一点一三` and `1.13`. A numeral replacing a single nonnumeric character inside a word (`后羿` heard as `后一`) remains a lexical/phonetic difference, rather than inventing a math quantity; it is not automatically approved. It keeps `1加56` flagged: recognition has not preserved the boundary between `5` and `6`. A dropped `不`, changed quantity, or changed plus/minus remains flagged even in a long otherwise matching sentence. Homophone tolerance cannot erase those differences; `6减` versus `六简` still needs review or a better transcript.

This is a conservative lexical structure check, not a mathematical parser or proof checker. Ambiguous recognition is deliberately retained as a difference. Fractions, mixed numeral systems, alternate formulations and longer equations may need review. The checker does not solve the question, establish equivalence of alternative derivations, or verify that animation objects match the spoken quantities. The fallback can reduce ASR uncertainty but cannot replace checking the audio or the teaching material.

The regression cases are transcript fixtures from the reported course feedback plus deliberately wrong numbers, operations and negation. They are not the original recordings and do not demonstrate that a particular recording was spoken correctly.

## Cache behavior and concurrency

`.motion-use-asr.json` schema version 2 keys transcripts by audio content SHA-256, model, full language tag and decoding parameters. Switching models preserves other model results, and identical bytes at another path can reuse recognition. The comparison is always recomputed against the current script, so editing text cannot reuse a previous pass conclusion. The comparator version is reported separately from recognition parameters.

Reports include `cache.hits` and `cache.misses`, counting requested clip/model entries across primary and fallback checks. A miss means recognition was needed, even when the recognizer subsequently skipped or failed; it is not a count of successful transcriptions. Forced checks count as misses, and a check with no narration reports zero for both.

Legacy cache entries are retained as evidence but are not reused under the stronger key contract. An explicit refresh runs recognition again. A missing transcript in that refresh is `UNREVIEWED`, even if an older successful cache record exists.

Concurrent commands acquire a short exclusive cache-write lock, reread the newest cache, merge only their new records and atomically rename a complete replacement. Recognition runs outside the lock. A writer waits at most five seconds for `.motion-use-asr.json.lock`; it then fails with the lock path rather than overwrite another writer. A process killed during this short write may leave a stale lock: verify that its recorded process is no longer active before removing it. The lock is never automatically reclaimed from a potentially active writer.


Optional `narrationCheck.terms: ["后羿", "嫦娥"]` supplies up to 100 proper-name
hints (80 characters each) in Whisper's initial prompt. Supply names, not entire
scripts or expected answers. Hints participate in the transcript cache key and
remain in report config; changing them triggers recognition again. They do not
whitelist substitutions, wrong quantities or missing negation, and do not create
human listening evidence.
