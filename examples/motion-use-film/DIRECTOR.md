# motion-use promo (2026-10-11) · 60 s · zh / en

**Takeaway**: a coding agent directs the film as code, renders it on your machine, then measures the MP4 it delivered. Said in the first sentence, over six real films made with motion-use.

**Look**: an editing bench on warm paper. Real films play as black-bordered prints; the real code and real tool output sit on dark cards; one orange perforated tape runs under every station and carries the eye from one to the next. Palette locked in `look` (paper, ink, signal orange, check green); no blue-purple.

**Everything on screen is real**:

- The prints are footage of films rendered by motion-use: the iphone-use promo release cuts, ocs-film, data-story, whiteboard, kinetic, and the yarn relay. `footage/*.mp4` are composites built from those MP4s with ffmpeg (a 3×2 wall, zh|en side by side, four formats), so the film stays inside the 5,400-frame footage budget; the drawing crops each print out of the composite frame.
- The code card is the first lines of the iphone-use promo's `composition/draw.js`. Sizes: `draw.js` 15,989 B + `film.json` 9,950 B = 25.9 KB ("26 KB"); its release MP4 is 10.2 MB.
- The terminal is `motion-use verify iphone-use-zh-vertical.mp4` output (v0.6.0): 1080×1920, 60 fps, 3330 frames, −14.93 LUFS, true peak −0.88 dBTP, fast_ratio 0.0828 green, blank 0, blue-purple 0, demo_similarity 0.
- The safe-area frame is real `motion-use still --guides` output of the iphone-use vertical cut at 9 s.
- "Text off the frame" is the iphone-use en-landscape cut at 43.5 s before round 7's fix (`images/clip-before.png`) and after it (`clip-after.png`).
- The voiceover-check card is `motion-use voiceover check` (v0.7.0, whisper small) on the iphone-use round-6 lines re-voiced with the same edge-tts voice: "让 AAI 直接操作你的真iphone" and "…能不能重视", with the tool's own suggestions ("A I", 重试 → 再试).

## Beats

| time | narration (zh) | picture |
|---|---|---|
| 0–7.4 | motion-use 让 coding agent 当导演… | the six-film wall under the headline; slow push, then a push toward the yarn and iPhone prints |
| 7.4–16.35 | 每一帧都是时间的函数… | whip to the code card typing beside the iPhone promo; its clock `t` runs; source bar (26 KB) against the MP4 bar (10.2 MB), to scale |
| 16.35–22.75 | 画风每次重新设计… | four prints with unrelated looks fly into a row, each labelled |
| 22.75–31.2 | 本地渲染完，它把成片解码一遍… | verify output types; three lights turn green as their lines land |
| 31.2–37 | 竖版会标出平台按钮挡住的区域，字和重点都避开它。 | the guides still rises, a scan line checks it top to bottom |
| 37–46.4 | 上一支片子里，配音念错了字… | the clipped callout gets boxed, flips to the fixed frame; the voiceover check prints script / heard / fix |
| 46.4–54 | 一份源码，出中文和英文、横版和竖版… | one print opens into the four real cuts |
| 54–60 | motion-use，开源，一行命令就能装。 | wordmark, underline drawn, install command types and holds |

## Checks run

- Narration: own ASR pass (faster-whisper small and large-v3-turbo) and `motion-use voiceover check`: all 16 clips pass. Changed before release: 母版 (both models heard 模板) → 高画质文件; 风格 (heard 分隔) → 画风; "26 KB" → "26 kilobytes" in English (the check reads KB as an acronym).
- Text in frame: v0.7.0 flagged the code card running off the left edge during a camera push at 10.7–12.5 s; the push no longer moves sideways.
- Motion: green (draft fast_ratio 0.11).

## Review round 1 (independent, codex, MP4 only) → changes

Verdict on the first draft: don't ship either cut. Fixed:

- **Text collision inside the inset iPhone film** at 10.25 s and 47.25 s: the iphone-use promo itself crossfades two headline lines over each other around its 2.5–3.5 s. Both composites now start outside that window (ip from source 5 s, formats from 12 s); the code card's clock counts from 5 s accordingly. (The collision is in the published iphone-use cut, not in this film.)
- **zh safe-area line was ambiguous** ("放在里面" read as inside the covered area): now "字和重点都避开它".
- **English viewers could not read the Chinese ASR evidence**: the en cut adds a gloss under each heard line ("AI" read as A-A-I; 重试 (retry) read as 重视 (value)).
- Non-blocking, also done: "this 55-second film" → "example"; "No templates" (scene templates do exist) → "a look of its own"; terminal cards labelled "real output · motion-use <version>"; the tape moved below the subtitles.
- Prints going empty while the camera left a station (footage clip ended first): every clip now runs until its station is off screen.

## Lessons

- Do: composite real footage into one clip and crop prints out of it in the drawing. Evidence: six films in one 22.75 s clip cost 1,365 extracted frames instead of 8,190. Why: the footage budget counts film frames per clip. When: any wall of videos.
- Do: let the new checks run on every draft. Evidence: the off-frame code and the 风格 misread were both found by the tool, not by looking. When: always; they are on by default in v0.7.0.

## Vertical cut (2026-10-12)

Same stations, voiceover and timing; every station is re-laid for 1080×1920 inside `view.safe`, stacked top to bottom (film over code, card over lights, clip over transcript, four cuts two by two). The tape runs low, under the platform's author row, where only decoration may sit. Subtitles: three lines in the safe box; each cue is cut where the next begins so two never show at once.

Review round 3 (independent, codex, MP4 only, [round-3-vertical.md](reviews/round-3-vertical.md)) said don't ship. Fixed:

- **Words carried through covered zones by the whips** (22.8, 31.25, 37.05, 46.45 s): each station now fades out just before its whip leaves and fades in as the next lands, so nothing readable travels through the top band or the action column.
- **Two subtitle tracks at once** (the iPhone promo inside the prints has its own subtitles): the prints are cropped above that film's subtitle band.
- **Proof text too small**: code 22→25 px, verify output 24→28 px, install command 25→30 px on three lines, repository address darker and larger.
- **The flip hid the comparison**: before fades out, then after fades in; the ✕ heading leaves with the defect.

Not changed (kept as non-blocking): the films inside the prints keep their own small type and, in the English cut, their Chinese kinetic words; the main subtitles and labels carry each claim.

- Do: fade a station's words out before a whip in portrait. Evidence: four whip frames put headings in the top band or the action column. Why: portrait's covered zones are close to every edge, so any travel crosses one. When: vertical films with camera travel between stations.
