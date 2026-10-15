// Speech and display copy have separate roles; only speech is sent to TTS/ASR.
export const spoken = (value) =>
  value && typeof value === "object" ? value.say : value;
export const displayed = (value) =>
  value && typeof value === "object" ? value.text : value;

export function groupCaptions(cues, mode = "sentence") {
  if (mode === "cue") return cues.map((c) => ({ ...c }));
  const out = [];
  let group = null;
  const flush = () => {
    if (group) out.push(group);
    group = null;
  };
  for (const cue of cues) {
    if (!group) group = { ...cue };
    else {
      const space =
        /[A-Za-z0-9,;:]$/.test(group.text) && /^[A-Za-z0-9]/.test(cue.text)
          ? " "
          : "";
      group.text += space + cue.text;
      group.end = cue.end;
      if (cue.estimated) group.estimated = true;
    }
    if (mode === "sentence" && /[。！？.!?][”’"')）]*\s*$/.test(cue.text))
      flush();
  }
  flush();
  return out;
}
