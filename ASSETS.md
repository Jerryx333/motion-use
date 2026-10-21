# Assets and third-party licenses

motion-use's own code is MIT (see `LICENSE`). Everything else it ships or installs is listed here.

## Shipped in this repository

| File | Source | License |
|---|---|---|
| `assets/fonts/NotoSansSC[wght].ttf` | [google/fonts](https://github.com/google/fonts/tree/main/ofl/notosanssc) `ofl/notosanssc`, commit `2894aab3`, sha256 `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da` | SIL OFL 1.1 (`assets/fonts/OFL-NotoSansSC.txt`) |
| `assets/fonts/JetBrainsMono[wght].ttf` | [google/fonts](https://github.com/google/fonts/tree/main/ofl/jetbrainsmono) `ofl/jetbrainsmono`, commit `2e05c1cf`, sha256 `48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda` | SIL OFL 1.1 (`assets/fonts/OFL-JetBrainsMono.txt`) |
| `assets/sfx/ding.wav` | Synthesized by `scripts/make-sfx.py` | MIT (this repository) |
| `assets/sfx/whoosh.wav` | "Woosh" by 1bob, [freesound.org/s/831936](https://freesound.org/s/831936/), via [@remotion/sfx](https://www.remotion.dev/docs/sfx/whoosh) | CC0 |
| `assets/sfx/click.wav` | "Mouse Click Sound.mp3" by Pixeliota, [freesound.org/s/678248](https://freesound.org/s/678248/), via [@remotion/sfx](https://www.remotion.dev/docs/sfx/mouse-click) | CC0 |
| `assets/sfx/switch.wav` | "UI Audio - Switch 35" by [kenney.nl](https://kenney.nl), via [@remotion/sfx](https://www.remotion.dev/docs/sfx/ui-switch) | CC0 |
| `examples/chrome-use/images/browser.svg` | Drawn for this repository | MIT (this repository) |

## Ported methods

`src/film-kit.js` (easing constants, the pulse camera and slam curve, the eight palettes, the whiteboard writing reveal), `src/motion-check.mjs` (motion, blank-frame and blue-purple measurements and their thresholds), `src/breakdown.mjs` (reference breakdown and beat-grid fit), the plucked-string voice in `src/music.mjs`, the shot-plan checks in `src/film.mjs` and the guidance in `references/directing.md` and `references/grammars.md` are adapted from [alchaincyf/huashu-art-motion](https://github.com/alchaincyf/huashu-art-motion) (commit `d861767`), MIT License, Copyright (c) 2026 alchaincyf (花叔 · 花生). The code was rewritten for this project; no files were copied.

`assets/demo-signatures.json` holds 12×8 frame descriptors of the starter and OCS example renders (made by `scripts/demo-signatures.mjs` from this repository's own output, MIT), used only to flag films laid out like the demos.

Whole-film rhythm planning, explicit product/material catalog selection and location-bearing frame feedback are informed by [alchaincyf/huashu-motion](https://github.com/alchaincyf/huashu-motion/tree/5f2608c2e12abcf518f74dde86093b19f7f88603) (commit `5f2608c`, MIT, Copyright (c) 2026 Huashu). Their schemas, CLI, drawing/score anchors and offline review page are original motion-use implementations. No upstream runtime, prompts, characters, fonts or media are bundled by these additions.

Built-in background beds are not files: `src/music.mjs` synthesizes them to the exact length of each video. A film's own music is written as `composition/score.js` and played by `src/sampler.mjs` (the reverb follows Jezar's public-domain Freeverb design) with the synthesized voices there and the instrument pack below.

## In rendered projects and videos

Each build folder (`out/.build/…`) contains WOFF2 subsets cut from the fonts above (a Modified Version under the OFL), with the OFL text next to them. Noto Sans SC's license reserves the font name "Source"; the subsets keep the family name "Noto Sans SC" and are loaded under the CSS name "MU Sans", neither of which uses the reserved name. JetBrains Mono declares no reserved name. In the rendered video the text is pixels, which the OFL does not restrict.

## Installed on the user's machine (not shipped in the release)

`install.sh` runs `npm ci --omit=dev`, which downloads these from the npm registry:

| Package | License | Role |
|---|---|---|
| [hyperframes](https://github.com/heygen-com/hyperframes) 0.8.123 | Apache-2.0 | Rendering engine (HTML → frames → MP4) |
| [subset-font](https://github.com/papandreou/subset-font) 2.9.0 | BSD-3-Clause | Font subsetting |
| [harfbuzzjs](https://github.com/harfbuzz/harfbuzzjs) 1.6.2 | MIT | Font coverage check |

Their dependencies (82 packages in total) are MIT, Apache-2.0, ISC, BSD, 0BSD, CC0, Python-2.0 or MIT AND Zlib, with one exception, libvips (**LGPL-3.0-or-later**), which sharp (a HyperFrames dependency) brings in one of two forms: `@img/sharp-libvips-<platform>`, a prebuilt dynamically linked binary, or `@img/sharp-wasm32` (Apache-2.0 AND LGPL-3.0-or-later AND MIT), sharp's WebAssembly build with libvips inside, which npm installs on some systems (it did on the GitHub Actions runners). `node scripts/licenses.mjs` prints the full list and fails CI on any license outside the reviewed set.

`motion-use instruments install` downloads the recorded instrument pack, `motion-use-instruments-1.0.0.tar.gz` (sha256 `35730e57c59bf6569af9f3e086376363046d45bdd50652e0cf57855d35f8b2bd`), from this repository's GitHub Release `instruments-v1.0.0` into `~/.local/share/motion-use/instruments/1.0.0/`: 21 instruments, 447 FLAC files trimmed, faded and level-matched from

| Source | Commit | License |
|---|---|---|
| [sgossner/VCSL](https://github.com/sgossner/VCSL) (Versilian Community Sample Library) | `c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e` | CC0-1.0 |
| [sgossner/VSCO-2-CE](https://github.com/sgossner/VSCO-2-CE) (Versilian Studios Chamber Orchestra 2, Community Edition) | `440300901dfe9275fd84e0b7763af1f8443ae62e` | CC0-1.0 |

The pack's `manifest.json` names the source folder of every instrument; the pack itself is CC0-1.0.

Rendering also uses programs motion-use does not install: **Node.js**, **FFmpeg** and **Chrome** (system Chrome, or Chrome for Testing downloaded by `motion-use doctor --install-browser`), each under its own license.

## Not included

motion-use ships neither GSAP nor Remotion. Template animations use seekable CSS; authored films use time-driven Canvas drawing. A trusted film may supply explicit local browser libraries, whose licenses remain the film author's responsibility.

## Original mechanism studies and documentary accents

`src/catalog-study.js` and the cards in `src/catalog.mjs` are original motion-use code, MIT. The gallery uses synthetic interface shapes and explicitly illustrative data; it contains no upstream sample films, prompts or product screenshots. Workflow influences are credited in `references/production.md`.

`assets/sfx/{stamp,thud,paper,explosion,train,map-pin,page-turn,low-boom}.wav` are original deterministic procedural synthesis, MIT (this repository), generated by `scripts/make-documentary-sfx.py` with Python's standard library. They contain no recorded or third-party samples. Names describe stylized accents, not authentic historical sounds.

`assets/geo/world.geojson` is derived from Natural Earth's public-domain 1:110m admin-0 countries. Names/IDs and polygon coordinates only, rounded to four decimals. Source URL, original download hash and transformation are in `assets/geo/SOURCES.md`. These are present-day illustrative boundaries, not historical or authoritative boundaries. `assets/geo/china-provinces.geojson` is derived from geoBoundaries gbOpen CHN ADM1 (34 units, source year 2019). Its CC BY 4.0 distribution terms, attribution, pinned download and transformation are recorded in `assets/geo/SOURCES.md`; the license text is in `LICENSE-geoboundaries.txt`. Films/products using it must credit geoBoundaries with its full URL. Neither dataset is an authoritative or historical boundary determination.
