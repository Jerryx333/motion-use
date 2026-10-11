# Alternatives

Checked 2026-10-05; huashu-art-motion, Claude Motion and Higgsfield Katana added 2026-10-10; Prompt Motion added 2026-10-12. Licenses are as reported by the GitHub API on that date. Only features we read in each project's own README or docs are listed.

| Project | License | What it is | Pick it when |
|---|---|---|---|
| [Claude Motion](https://claude.com/resources/articles/dashboards-and-motion) (Anthropic, beta) | Part of Claude; Team and Enterprise plans | Claude writes code that animates your text, charts, shapes and images inside a Claude artifact, with an editor, comments and MP4 export; no video model, no generated people | You are on a Team/Enterprise plan and want a quick explainer or animated chart inside Claude, edited by asking |
| [Higgsfield Katana](https://x.com/higgsfield/status/2108294775644585998) | Commercial, via Higgsfield MCP in Claude | Motion graphics over footage, "powered by Claude Motion": kinetic captions, stamps, colour grades on uploaded references | Your edit is footage-led and you use Higgsfield |
| [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes) | Apache-2.0 | HTML/CSS compositions rendered frame by frame to MP4, with a CLI (`init`, `lint`, `check`, `render`, `snapshot`, `doctor`) and agent skills, including product-launch and explainer workflows | You want full creative freedom and have an agent write each video's HTML from scratch |
| [Remotion](https://www.remotion.dev) and its [agent skills](https://github.com/remotion-dev/skills) | Remotion License: free for individuals, non-profits and companies up to 3 employees; a Company License above that ([terms](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md)). The skills repo had no license file detected by GitHub | Videos written as React components | Your team writes React and is fine with the license terms |
| [memex-lab/product-launch-video-skill](https://github.com/memex-lab/product-launch-video-skill) | MIT | An agent skill: brief → storyboard → Remotion → review, with optional TTS | You want a cinematic launch video and already use Remotion |
| [browser-use/video-use](https://github.com/browser-use/video-use) | MIT | Editing existing footage with a coding agent (transcripts, cuts) | You have recordings to edit, not a video to generate |
| [alchaincyf/huashu-art-motion](https://github.com/alchaincyf/huashu-art-motion) | MIT | An agent skill (Python + Playwright) for art-style and explainer animation: 35 art-style recipes drawn in code, 8 explainer grammars, reference breakdown, a delivery gate for slideshow pacing, AI-generated character frames, optional voice cloning | You want painterly art-history styles, a character crossing many styles, or its parameterized explainer clips |
| [Prompt Motion](https://prompt-motion.com) (curated by @p4nthera_) | Gallery; "videos and prompts belong to their creators" | A hand-reviewed gallery of motion videos made with Claude Opus 5.5, each with the creator's X post, the prompt or skill behind it, model and effort, tags, and prompt templates with every changeable part as a field | You want to see what one prompt or skill produced before writing your own. motion-use reads an entry with `motion-use reference <url>` (credits, prompt, video, breakdown, kept out of git) and borrowed the field idea for the film `brief` |
| [calesthio/OpenMontage](https://github.com/calesthio/OpenMontage) | AGPL-3.0 | A large agentic video production system with many pipelines | You want one system covering many kinds of production |

## Where motion-use fits

motion-use supports authored films as its default workflow: a directing document, exact shot windows and deterministic drawing code. Scene templates in two looks remain an optional fast path. The CLI manages assets, rendering and measured delivery review; the agent still owns the creative decisions.

- **Exact-time rendering.** Film code is authored and reviewed per video; each pose is a function of the requested time. In template mode, the agent fills a brief. Frames are CSS animations that HyperFrames seeks exactly, so two renders are identical (recorded clips aside, which can differ by invisible pixel noise).
- **The matrix for free.** Chinese and English, 16:9 and 9:16, from one brief, with vertical safe areas.
- **Voiceover drives timing.** Drop in recordings; scenes stretch to fit and narrations never overlap.
- **Local and license-light.** Fonts are bundled and subset per video, music is synthesized, sound effects are CC0 or original; rendering loads nothing from the network and runs the engine with telemetry off. MIT code on an Apache-2.0 engine.

motion-use adopted huashu-art-motion's directing method — the six failure modes, the pulse camera, the slideshow/blank/blue-purple delivery lights, reference breakdown and independent review — as part of its Node CLI and film.json; it does not ship that project's art-style scenes or clip engine.

Compared with Claude Motion, motion-use works the same way (code, not a video model) but runs locally in any coding agent and any plan: bilingual and multi-format output from one project, narration with timed subtitles, footage frames, delivery measurements on the MP4, and a kit that keeps the code an agent writes short.

It is not a general video editor, does not generate realistic footage, and has no timeline UI. For those, use the projects above.
