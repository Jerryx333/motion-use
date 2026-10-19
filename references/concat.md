# Joining chapters

`motion-use concat parts.json --out joined --release` joins 2–60 compatible,
constant-frame-rate videos. Resolution and frame rate must match. Existing
configs without titles remain valid.

```json
{
  "name": "math-course",
  "lang": "zh-CN",
  "parts": [
    { "file": "lesson-01.mp4", "title": "第一题：一加五是六" },
    {
      "file": "previous-course.mp4",
      "from": 2,
      "to": 12,
      "title": "第二题",
      "source": { "reused": true, "project": "original-course", "chapter": "Q02" }
    }
  ]
}
```

A title on any part enables MP4 chapters. Untitled parts get `Part N` labels.
Alternatively set `"chapters": true` to embed default labels. Without titles or
that setting, no chapter track is added. Titles must be nonempty single lines.
`source` is optional author-supplied provenance and is retained alongside the
actual input file SHA256, source frame range and any supplied release manifest
identity. A label does not modify reused video content.

Each run writes these files in the output directory, copies them beside the master,
includes their hashes in release manifests, and returns the delivered paths in
`chapterFiles`:

- `chapters.json`: exact integer `startFrame` / exclusive `endFrame`, rational
  `frameRate`, source hashes and provenance, video duration and container duration.
- `chapters.txt`: readable start/end times and titles.
- `chapters.srt`: chapter labels covering the corresponding intervals; these are
  navigation labels, not narration subtitles.

Time ranges round each endpoint to the nearest source frame. Omitted `to` uses
the video stream frame count (decoded when not present in the container), not MP4 container duration, which may include audio
padding. Output chapter positions accumulate integer frames. The joined video is
counted again and a mismatch fails before a release manifest is written. Text,
SRT and embedded MP4 chapter timestamps have millisecond precision; JSON frame
indices and rational frame rate are the authoritative timeline. The report keeps
`videoDuration` and `containerDuration` separate.

The output still needs visual and listening review across joins. Chapter metadata
does not establish teaching correctness or target-device navigation support.
