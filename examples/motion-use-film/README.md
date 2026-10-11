# motion-use promo (60 s, zh / en, landscape / vertical)

The film in the README. 60 s at 60 fps, Chinese and English narration with burned-in subtitles, in landscape (README) and vertical (Douyin, Channels, Xiaohongshu, TikTok, Shorts). The vertical cut re-lays every station inside the portrait safe area with the same timing. Everything on screen is real: films rendered with motion-use (as footage), the iphone-use promo's code, and real `verify`, `still --guides` and `voiceover check` output. Director notes: [DIRECTOR.md](DIRECTOR.md).

```bash
cd examples/motion-use-film
IP=…/iphone-use/docs/promo/out/release sh footage/build.sh   # composites of the other films (not committed)
motion-use voiceover .                       # zh + en narration (edge-tts)
motion-use voiceover check .                 # transcribe it and compare with the script
motion-use render . --allow-code --release   # high quality, platform masters + release-manifest.json
```

`footage/build.sh` cuts the composites from other films' MP4s; they stay out of git because examples ship in every release archive. `images/` holds frames taken from the iphone-use promo.
