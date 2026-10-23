# Cast the narrator before generating the film

“Configured” and “good for this film” are separate decisions. The legacy automatic
Azure/Edge choice is a convenience for rough previews; it is not a quality ranking.
Do not let available credentials or the starter's Chinese/English voice determine
the final narrator. Keep an explicit user-selected voice unless asked to change it.

## Describe the performance

Record the audience, language/accent, age/timbre impression, delivery and emotional
arc in SOURCES.md. Describe what a listener should hear: a colleague explaining a
bug with short confident phrases; a restrained documentary voice; a bright launch
read with room for the reveal. “Use the best AI” alone is not a casting brief.

Choose candidates by the actual language, pronunciation, controllable pauses and
emotion, consistency across sections, latency/cost and permitted use. Check current
official provider documentation and actual account access rather than maintaining
a permanent model leaderboard. MiniMax, ElevenLabs, Azure, other TTS providers,
local models and a supplied recording can all be candidates; a listed name does
not imply a built-in motion-use integration. Use chrome-use's listed read-only
search adapters to find official model/voice pages, then inspect those pages.
No subscription, clone or paid generation is implied by catalogue discovery.
For example, inspect the current [MiniMax model catalogue](https://platform.minimax.io/docs/guides/models-intro)
before choosing a model ID; this is discovery evidence, not an audio-quality verdict.

## Try the same words

Use a short representative passage containing the opening, a technical/proper name,
a transition and an ending. Compare the promising model/voice combinations on the
same text and comparable loudness. Start with a small useful set, usually 2–3;
do not generate the whole film for every voice. Test a selected candidate on a
second, different passage before committing if long-form consistency is in doubt.

`voiceover audition` creates isolated samples and an offline listening page:

```bash
motion-use voiceover audition voice-plan.json --out auditions/round-1 --allow-code --json
```

Example plan (replace the model/voice with real choices verified for the provider):

```json
{
  "version": 1,
  "lang": "zh",
  "text": "两个项目，还得我来回传话？客户端拿不到用户编号，就直接问服务端：字段叫什么？收到回复，改好，再跑一遍登录。",
  "candidates": [
    {
      "id": "preview",
      "label": "Existing preview baseline",
      "voiceover": {"engine":"edge", "voices":{"zh":"zh-CN-YunxiNeural"}}
    },
    {
      "id": "selected-provider",
      "label": "Candidate from the casting brief",
      "voiceover": {
        "engine":"command",
        "command":["node", "scripts/provider-tts.mjs"],
        "model":"provider-model-id",
        "voices":{"zh":"provider-voice-id"},
        "instructions":"像同事解释问题，短句，停顿自然；不要播音腔，结尾收住。"
      }
    }
  ]
}
```

This is a plan, not a bundled provider adapter. The bridge script must exist and
implement the contract below before running the command candidate. Different
voices from one provider can be compared too. Use explicit engines in audition
plans; credentials do not silently choose the candidate. Existing output folders
are refused. Failures remain in audition.json alongside successful samples, with
no fallback to another voice and no automatic winner. Production audio stays intact.

Listen without music first for accent, name pronunciation, phrasing, breath/pauses,
the shape of the ending and whether the delivery sounds like someone addressing
this audience. Then listen against actual picture and BGM for intelligibility,
energy and fatigue. A clear announcer can still be wrong for an office conversation.
Record listener, file/hash, passage, date, selected candidate and rejection reasons
in SOURCES.md. When playback cannot actually be heard, keep listening UNREVIEWED
and present the audio page for review; neither ASR nor waveform analysis can select
the most natural or appropriate voice.

## Use another TTS model through a trusted bridge

`engine:"command"` runs an argv array without a shell, in the project directory.
It requires `--allow-code`, just like authored drawing code. Read credentials from
the bridge's environment; do not put secrets in film.json, argv, stdout or cached
requests. No provider libraries or keys are bundled into motion-use.

The bridge receives one JSON object on stdin:

```json
{"schemaVersion":1,"text":"Words to speak","lang":"zh","voice":"provider-voice-id","model":"provider-model-id","instructions":"Performance direction","rate":"+0%","output":"/absolute/path/sample.partial.mp3"}
```

Translate these settings into the chosen provider's supported controls, write a
real MP3 to `output`, and exit zero only after it is complete. Prefer an appropriate
high-quality output setting; do not turn low-quality source audio into a high
bitrate file and call it better. If that model cannot honor requested style/rate,
report it or choose another candidate rather than silently ignoring the direction.
The CLI checks playable audio before replacing an older generated clip. Use the
existing imported WAV/audio-track path when a lossless deliverable is needed.

The bridge has a 120-second bound and no automatic retry, including 429 errors;
unknown/paid delivery must be checked at the provider before resubmitting. Detailed
provider logs are not echoed into reports. A bridge may use an installed provider
CLI/SDK or HTTP API; use its current official documentation and record tested
capabilities, not an imagined universal text-to-speech interface.

After selection, copy the chosen `voiceover` settings into film.json, set its
production `dir`, and run normal `voiceover`/`render --allow-code`. Model, voice,
instructions, rate and the bridge command/file fingerprint participate in cache
freshness. Changing them regenerates tracked audio; untracked user recordings
remain protected. Bridge files named in argv inside the project are included in
render snapshots; declare additional bridge inputs under `files` when needed.
The remote service's model deployment is external, so retain the accepted audio.

Generate only the selected performance for the full script. Check ASR, then
`retime`, then lock visual/music accents. ASR is a reading check, not acting approval.
Keep the selected settings explicit for the final cut; the Azure/Edge automatic
fallback remains a backwards-compatible preview path, not an accepted casting.
