# Round 3 — independent vertical MP4 review

Reviewed 2026-10-12. Judged only the two delivered MP4s; no composition, scripts, previous reviews, or producer claims were used to establish quality.

## Verdict

| Cut | Verdict | Basis |
| --- | --- | --- |
| `motion-use-zh-vertical.mp4` | **Don't ship** | Transitions carry words through platform exclusion zones and clip text at the edge. Important proof text and installation command are too small for casual phone viewing. Embedded demo captions coexist with the primary subtitles. |
| `motion-use-en-vertical.mp4` | **Don't ship** | Same layout/readability problems, plus English checklist text crosses the right action column. Several demonstrations still require reading Chinese, weakening silent comprehension for English viewers. |

Both files are H.264, 1080×1920, 60 fps, exactly 60.000 s, with stereo 48 kHz AAC. The settled main headings and primary subtitles are generally well positioned. The verdict applies the request's **all words, throughout the video** rule, including transitions and embedded footage; the brief transition violations alone would be less severe under a relaxed rule.

## Evidence and method

Extracted 120 frames per cut at 0.5 s spacing using FFmpeg `fps=2,scale=338:600`, then inspected another 80 frames per cut: ten frames at 0.1 s spacing around each of 7.4, 16.35, 22.75, 31.2, 37, 46.4, 54 and the additional 42.5 s flip. Exact evidence timestamps were separately extracted with `-ss TIME -frames:v 1`. Times below are MP4 times, not the small internal `t = …` printed inside a demonstration.

Saved **30 JPEGs, all 338×600**, in [v3](v3/). These are 28 unannotated decoded frames and two copies with pink platform zones. Links below point to the evidence; no annotation was added to the MP4s.

Exclusion geometry at original resolution: top y < 192; bottom y ≥ 1459.2; action column x ≥ 928.8 between y = 864 and 1459.2. At evidence size: top 60 px, bottom starting at 456 px, right column starting at approximately 291 px between 270 and 456 px. Orange tape is exempt.

## Blocking issues

### B1. Words enter platform UI zones during exits — both cuts

| Exact observed time | Cut / words | Finding and evidence |
| --- | --- | --- |
| **22.800 s** | Both: `停`, `−56%` and small chart text | The departing style grid rises through the top 10%; these words are in the covered band. The prints also intersect the top frame edge. [ZH](v3/zh-022.80.jpg), [EN](v3/en-022.80.jpg). |
| **31.250 s** | EN: `no blank frames` | The final letters enter the right action column as the verification panel slides right. This is an exit animation, but the words are still visible under the reserved UI area. [Raw](v3/en-031.25.jpg), [zone overlay](v3/en-031.25-zones.jpg). The shorter ZH checklist at this exact time does **not** establish the same word overlap: [ZH comparison](v3/zh-031.25.jpg). |
| **37.050 s** | ZH: `红色 = 平台按钮会挡住`; EN: `red = covered by the platform's buttons` | The departing legend extends into the right action column. The heading also runs off the right frame edge: `竖版安全区` / `Vertical safe area`. [ZH raw](v3/zh-037.05.jpg), [ZH zones](v3/zh-037.05-zones.jpg), [EN](v3/en-037.05.jpg). |
| **46.450 s** | ZH: `× 配音念错字`; EN: `× a misread word`, and the terminal's small header | The outgoing audit panel moves into the top exclusion band. The red warning is near the top edge, well inside the first 60 evidence pixels. [ZH](v3/zh-046.45.jpg), [EN](v3/en-046.45.jpg). |

These are confirmed samples, not asserted frame-accurate start/end bounds. Main subtitles were absent at these exits or stayed clear; the violations belong to the moving scene elements. No settled primary subtitle was found in the bottom exclusion zone. Fade text-bearing panels before translating them through excluded areas, or keep their animation inside the safe region.

### B2. Proof text and final installation action are too small — both cuts

At 338 px width, primary subtitles remain readily readable, while the code, terminal rows and embedded film captions are mostly only a few pixels high. This is a visual legibility judgment at phone-like display size, not an OCR score.

| Exact evidence time / affected beat | Finding | Evidence |
| --- | --- | --- |
| **10.500 s**, code/proof beat around 7.4–16.35 s | Code in `composition/draw.js`, the phone list, and embedded output text require pausing and enlargement. The broad “film as code” claim survives in the primary subtitle; the actual proof does not. | [ZH](v3/zh-010.50.jpg), [EN](v3/en-010.50.jpg) |
| **28.000 s**, verification beat around 22.75–31.2 s | Main checkmarks and labels work; detailed `fast_ratio`, `blank_run_s`, `blue_purple_share`, `demo_similarity` rows and numerical results are tiny. They are presented as evidence but cannot be comfortably read during normal phone playback. | [ZH](v3/zh-028.00.jpg), [EN](v3/en-028.00.jpg) |
| **34.000 s**, safe-area beat | Red mask and overall idea are visible; the inset phone/output text is too small to verify that the important action and words are clear. | [ZH](v3/zh-034.00.jpg), [EN](v3/en-034.00.jpg) |
| **41.000 s**, error detection beat | `AI` versus the misread word and the corrective terminal lines are too small. This is the substance of the voice-error example, not merely decorative code. | [ZH](v3/zh-041.00.jpg), [EN](v3/en-041.00.jpg) |
| **51.000 s**, multi-output beat | Four prints show orientation differences, but their titles/captions/code cannot be read comfortably. Outer language/orientation labels are much more useful than the content. | [ZH](v3/zh-051.00.jpg), [EN](v3/en-051.00.jpg) |
| **57.000 s**, CTA (full command visible from roughly 56.5 s onward) | `curl -fsSL https://raw.githubusercontent.com/…/install.sh` and `| sh` are approximately 6–8 px high in these evidence images. The repository address is small and low contrast. “One command to install” is readable; the command itself is not comfortably actionable without enlarging the frame. | [ZH](v3/zh-057.00.jpg), [EN](v3/en-057.00.jpg) |

Enlarge the few proof lines that carry each claim and simplify the CTA. Resizing the entire landscape print into a vertical card preserves detail technically but does not preserve its readability.

### B3. Concurrent subtitle layers — both cuts

At **10.500 s**, the ZH main subtitle says `这支 55 秒的示例，源码只有 26 KB，agent 改代码，不用拖时间线。`, while an embedded subtitle in the film above describes reading the screen. EN has `This 55-second example is just 26 kilobytes.` below and `It reads the screen as text, in about a tenth of a second.` inside the print. [ZH](v3/zh-010.50.jpg), [EN](v3/en-010.50.jpg).

At **51.000 s**, the main multi-output explanation appears below four prints that also contain their own captions. [ZH](v3/zh-051.00.jpg), [EN](v3/en-051.00.jpg).

This is **embedded footage plus one primary cue**, not two accidentally overlapping primary cues. Nevertheless, multiple subtitle layers are visible at once and compete for reading; they fail the literal “never two at once” requirement. Use caption-free proof footage or mask the embedded subtitles. The primary track itself showed no double cue or collision with important content in the inspected samples.

## Non-blocking notes and other checks

- **Edge clipping during slides:** At **7.450 s**, the opening collage slides off the left edge, clipping its small print text ([ZH](v3/zh-007.45.jpg), [EN](v3/en-007.45.jpg)). At **16.400 s**, `按名字点` / `Tap by name`, the `10.2 MB` bar and `改代码，不拖时间线` / `edit code, not a timeline` are partly cut off ([ZH](v3/zh-016.40.jpg), [EN](v3/en-016.40.jpg)). At **54.050 s**, departing output cards and their labels are similarly clipped ([ZH](v3/zh-054.05.jpg), [EN](v3/en-054.05.jpg)). These look like intentional exit choreography, not an accidental settled-layout crop. They still matter if every visible word must remain readable through transitions.
- **The “bad previous film” is not a new export defect:** Around 37–42.5 s the `Scan to connect` label intentionally extends beyond an inset print, with a red error annotation. The damaged label is part of the before/after demonstration. It does not reach the outer MP4 edge in the settled layout. The black panels at the start of code/terminal beats have window controls and later fill with text; they are animated terminal windows, not evidence of a missing film.
- **42.650 s flip:** The before/after print becomes almost an edge-on vertical sliver while the orange error box remains wide ([ZH](v3/zh-042.65.jpg), [EN](v3/en-042.65.jpg)). The surrounding sampled frames show a coherent flip, rather than a decode failure. It momentarily obscures the key comparison; a simple dissolve would be easier to follow. The old red error heading remains above the corrected print afterward, alongside a green “fixed” label, making the result less immediate.
- **No unintended text-on-text collision found** in settled scenes. Dense embedded captions/code are a scale problem, not observed text drawn directly over another text line. Slides/flip introduce brief occlusion and clipping.
- **No broken print or unexplained full-frame black flash found** in the sampled images. Full-stream FFmpeg decoding completed for both cuts with 3,600 frames and no reported decode error. `blackdetect=d=0.05:pix_th=0.10` reported no qualifying near-full-frame black event. This detector cannot certify that every inset plays correctly.
- **Copy:** ZH primary copy is broadly natural for a technical audience. `动得够不够` is colloquial but vague; `画风每次重新设计` is understandable, while `每部片重新设计` could more clearly say what is redesigned. EN primary subtitles are broadly natural. `Your coding agent, directing` and `A new look every film` are acceptable headline fragments. `For vertical video it marks what the platform's buttons cover` is wordy but understandable. No obvious primary-copy typo was found.
- **English localization:** Chinese kinetic type (`推`, `砸`, `不是幻灯片`, `停`) remains in the opening/style samples. Around 40–46 s, the central transcript example still contains Chinese sentences even though row labels are English. Authentic source examples can stay Chinese, but an English viewer cannot inspect that demonstration without translated, enlarged callouts.

## Silent comprehension by beat

| Beat | Without sound |
| --- | --- |
| 0–7.4 s: agent directs a film | Main caption communicates the promise; collage communicates variety. Six tiny prints cannot each be read. |
| 7.4–16.35 s: film as code / compact source | Main caption, `26 KB` and “edit code” make the premise understandable. Code and embedded proof are too small to inspect. |
| 16.35–22.75 s: visual variety | Four styles and outer labels communicate this well. Chinese kinetic type limits EN sample comprehension. |
| 22.75–31.2 s: local render / checks | Checkmarks and primary caption convey motion/loudness/blank checks. Detailed terminal evidence is illegible at normal size. |
| 31.2–37 s: safe area | Red regions and primary caption communicate avoidance. Inset action is too small to judge; legend exits through a forbidden zone. |
| 37–46.4 s: catches mistakes | Red/green annotations communicate before/after. The exact pronunciation error is not independently clear at phone size; especially weak for EN viewers. |
| 46.4–54 s: one source, many exports | Four output shapes and language labels communicate the idea. Inner captions add reading clutter. |
| 54–60 s: install | Product name/open-source/install promise are clear. Actual command and address need larger type. |

## Audio measurements

Ran the requested full-track measurement independently on each delivered file:

```sh
ffmpeg -hide_banner -i out/release/motion-use-zh-vertical.mp4 -af ebur128=peak=true -f null -
ffmpeg -hide_banner -i out/release/motion-use-en-vertical.mp4 -af ebur128=peak=true -f null -
```

| Cut | Integrated loudness | Loudness range | True peak |
| --- | ---: | ---: | ---: |
| ZH | −14.3 LUFS | 4.3 LU | −0.9 dBFS |
| EN | −14.0 LUFS | 4.4 LU | −1.0 dBFS |

No numerical clipping indication; cuts are only 0.3 LU apart. Both tracks decay substantially in the last second, consistent with an end fade. `silencedetect=noise=-45dB:d=0.25` reported no qualifying silence event. The inset terminal's printed loudness is about another demonstration and was not used as the measurement of these deliverables.

## Limits

This is a decoded-frame visual review and full-track signal measurement, **not a listening sign-off**. Pronunciation, narration/subtitle synchronization, musical balance, audible clicks, and voice naturalness remain unverified. Written copy judgments above are based on burned-in text.

400 sampled images were inspected in total, including all listed transitions and the additional flip; this is not frame-by-frame visual inspection of all 7,200 frames. Exact timestamps identify confirmed samples; no precise defect duration is claimed. Legibility was judged on 338×600 images and enlarged contact sheets, not on a physical phone or after platform recompression. Zones use the supplied geometry, not live platform overlays. No external product claims, installation command, links, assets, or platform upload were tested.

Input SHA-256:

- ZH: `314c216f87daf4c1519c8c2b09ad0ddfc81d20e5e0b47c755776c56d9f7de5b4`
- EN: `271efe47e3c21ad9b3937ead5ff3474cb83aade53c05b23859acfa3b48f77072`

_Evidence frames were extracted locally and are not committed (examples ship in every release archive); regenerate them with ffmpeg at the listed times._
