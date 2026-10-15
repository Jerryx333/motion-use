"""Optional Azure SDK path. Input JSON on stdin; credentials stay in environment.
Invoked through a pinned uv environment by voiceover.mjs only with --word-timing.
"""
import json
import os
import sys
from pathlib import Path


def synthesize(request, sdk):
    config = sdk.SpeechConfig(subscription=os.environ['AZURE_SPEECH_KEY'], region=os.environ['AZURE_SPEECH_REGION'])
    config.set_speech_synthesis_output_format(sdk.SpeechSynthesisOutputFormat.Audio24Khz96KBitRateMonoMp3)
    synth = sdk.SpeechSynthesizer(speech_config=config, audio_config=None)
    words = []

    def boundary(event):
        if str(event.boundary_type).split('.')[-1] != 'Word':
            return
        duration = event.duration.total_seconds()
        start = event.audio_offset / 10_000_000
        if event.text and duration > 0:
            words.append({'text': event.text, 'start': round(start, 6), 'end': round(start + duration, 6), 'estimated': False})

    synth.synthesis_word_boundary.connect(boundary)
    result = synth.speak_ssml_async(request['ssml']).get()
    if result.reason != sdk.ResultReason.SynthesizingAudioCompleted:
        raise RuntimeError('Azure synthesis did not complete; check the configured resource/voice/network')
    if not result.audio_data or not words:
        raise RuntimeError('Azure returned no audio or no word boundaries; no timing was fabricated')
    Path(request['out']).write_bytes(result.audio_data)
    return {'words': sorted(words, key=lambda w: w['start'])}


if __name__ == '__main__':
    try:
        import azure.cognitiveservices.speech as speechsdk
        print(json.dumps(synthesize(json.load(sys.stdin), speechsdk), ensure_ascii=False))
    except Exception as exc:
        # Avoid dumping SDK internals, credentials or SSML in subprocess logs.
        print(f'Azure word timing failed ({type(exc).__name__})', file=sys.stderr)
        sys.exit(1)
