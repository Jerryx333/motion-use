// Speech and display copy have separate roles; only speech is sent to TTS/ASR.
export const spoken = (value) =>
  value && typeof value === "object" ? value.say : value;
export const displayed = (value) =>
  value && typeof value === "object" ? value.text : value;

// A dot inside a decimal, version or URL is not a sentence boundary.
export function splitSentences(text) {
  const source = String(text), out = [];
  let start = 0;
  for (const m of source.matchAll(/[。！？!?；;]+[”’"')）]*|\.(?=[”’"')）]*(?:\s|$))[”’"')）]*/g)) {
    out.push(source.slice(start, m.index + m[0].length));
    start = m.index + m[0].length;
  }
  if (start < source.length) out.push(source.slice(start));
  return out;
}
export const endsSentence = (text, next = "") =>
  /[。！？!?][”’"')）]*\s*$/.test(text) ||
  (/\.[”’"')）]*\s*$/.test(text) && !(/\d\.$/.test(text) && /^\d/.test(next)));

export function groupCaptions(cues, mode = "sentence") {
  if (mode === "cue") return cues.map((c) => ({ ...c }));
  const out = [];
  let group = null;
  const flush = () => {
    if (group) out.push(group);
    group = null;
  };
  for (const [i, cue] of cues.entries()) {
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
    if (mode === "sentence" && endsSentence(cue.text, cues[i + 1]?.text))
      flush();
  }
  flush();
  return out;
}
