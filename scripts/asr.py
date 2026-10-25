# Transcribe narration clips for `motion-use voiceover check`.
# Run by motion-use through: uv run --with faster-whisper --with pypinyin python scripts/asr.py
# stdin:  {"model": "small", "items": [{"file": "...", "lang": "zh"}], "texts": ["script line", ...]}
# stdout: {"items": [{"file": "...", "text": "..."}],
#          "chars": {"重": ["chong", "zhong"], ...},   readings of every CJK character seen
#          "tones": {"重": ["chong2", "zhong4"], ...},  the same readings with tones (TONE3)
#          "phrases": ["重视", ...]}                    2-3 character dictionary words seen
import json
import re
import subprocess
import sys

import numpy as np

req = json.load(sys.stdin)
from faster_whisper import WhisperModel  # noqa: E402

model = WhisperModel(req.get("model") or "small", device="cpu", compute_type="int8")
# A neutral prompt keeps Chinese output in simplified characters. Never prompt with the
# script itself: that would bias the transcript toward the very text being checked.
PROMPTS = {"zh": "以下是普通话的句子。"}
items = []
for it in req["items"]:
    lang = it["lang"].split("-")[0].lower()
    # Decode with ffmpeg (motion-use already needs it) instead of PyAV, whose API keeps moving.
    pcm = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", it["file"], "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
        check=True,
        capture_output=True,
    ).stdout
    segments, _ = model.transcribe(
        np.frombuffer(pcm, dtype=np.float32),
        language=lang,
        **{
            "beam_size": 5, "vad_filter": False, "condition_on_previous_text": False,
            **req.get("params", {}),
        },
        initial_prompt=" ".join(filter(None, [PROMPTS.get(lang), "台湾口音，使用简体字。" if req.get("accent") == "zh-TW" else None, ", ".join(req.get("terms", []))])) or None,
    )
    items.append({"file": it["file"], "text": "".join(s.text for s in segments).strip()})

cjk = re.compile(r"[㐀-鿿]")
chars, tones, phrases = {}, {}, set()
try:
    from pypinyin import Style, pinyin
    from pypinyin.constants import PHRASES_DICT

    corpus = [i["text"] for i in items] + list(req.get("texts", []))
    for text in corpus:
        for c in text:
            if cjk.match(c) and c not in chars:
                chars[c] = sorted(set(pinyin(c, style=Style.NORMAL, heteronym=True)[0]))
                tones[c] = sorted(set(pinyin(c, style=Style.TONE3, heteronym=True, neutral_tone_with_five=True)[0]))
        for n in (2, 3):
            for i in range(len(text) - n + 1):
                w = text[i : i + n]
                if all(cjk.match(c) for c in w) and w in PHRASES_DICT:
                    phrases.add(w)
except ImportError:
    pass
json.dump({"items": items, "chars": chars, "tones": tones, "phrases": sorted(phrases)}, sys.stdout, ensure_ascii=False)
