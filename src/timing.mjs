// Imported speech timing is explicit; estimates must never become measured word timing.
export function validateTiming(data, error) {
  const object = (x) => x && typeof x === "object" && !Array.isArray(x);
  const time = (x) => Number.isFinite(x) && x >= 0 && x <= data.duration;
  for (const field of ["captions", "cues"]) {
    if (data[field] === undefined) continue;
    if (!object(data[field])) {
      error(`$.${field}`, "a map keyed by film language");
      continue;
    }
    for (const [lang, value] of Object.entries(data[field])) {
      const p = `$.${field}.${lang}`;
      if (!Array.isArray(data.languages) || !data.languages.includes(lang))
        error(p, "a language in this film");
      if (field === "captions") {
        if (!Array.isArray(value) || value.length > 2000) {
          error(p, "at most 2000 subtitle cues");
          continue;
        }
        let end = 0;
        value.forEach((c, i) => {
          if (
            !object(c) ||
            typeof c.text !== "string" ||
            !c.text.trim() ||
            c.text.length > 2000 ||
            !time(c.start) ||
            !time(c.end) ||
            c.end <= c.start ||
            c.start < end ||
            (c.estimated !== undefined && typeof c.estimated !== "boolean")
          )
            error(
              `${p}[${i}]`,
              "{text, start, end, estimated?}: ordered, non-overlapping seconds within the film",
            );
          end = c?.end;
        });
      } else {
        if (!object(value) || Object.keys(value).length > 2000) {
          error(p, "at most 2000 named keyword cues");
          continue;
        }
        for (const [name, c] of Object.entries(value)) {
          if (
            !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) ||
            !object(c) ||
            !time(c.time) ||
            typeof c.estimated !== "boolean"
          )
            error(
              `${p}.${name}`,
              "a slug mapped to {time: seconds within the film, estimated: boolean}",
            );
        }
      }
    }
  }
}

const stamp = (seconds) => {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};

export function toSrt(captions) {
  return captions
    .map(
      (c, i) =>
        `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text.replace(/\r/g, "").replace(/\n\s*\n/g, "\n")}\n`,
    )
    .join("\n");
}
