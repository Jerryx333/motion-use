import fs from "node:fs";
import path from "node:path";
import { validateBrief } from "./brief.mjs";
import { audioSeconds } from "./build.mjs";
import { generateVoiceover, narrationFreshness } from "./voiceover.mjs";

const contained = (base, file) => {
  const r = path.relative(base, file);
  return (
    r !== "" &&
    r !== ".." &&
    !r.startsWith(".." + path.sep) &&
    !path.isAbsolute(r)
  );
};
export function resolveNarration(
  film,
  {
    error = () => {},
    warn = () => {},
    requireFiles = false,
    skipGenerated = false,
    probe = audioSeconds,
  } = {},
) {
  const languages = Array.isArray(film.languages) ? film.languages : [];
  if (film.voiceover === false)
    return { config: null, plans: [], pending: [], tracks: [] };
  const raw = film.voiceover ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    error(
      "$.voiceover",
      "settings object, or false only for an intentionally silent film",
    );
    return { plans: [], pending: [], tracks: [] };
  }
  const checked = validateBrief(
    {
      version: 1,
      name: "voice",
      languages: languages.length ? languages : ["en"],
      voiceover: { ...raw, dir: undefined },
      scenes: [{ id: "voice", type: "title", title: "Voice" }],
    },
    film.dir,
  );
  checked.errors
    .filter((e) => e.path.startsWith("$.voiceover"))
    .forEach((e) => error(e.path, e.message));
  const relative = raw.dir ?? "voiceover",
    dir =
      typeof relative === "string" ? path.resolve(film.dir, relative) : null;
  if (
    !dir ||
    path.isAbsolute(relative) ||
    /[\\\x00-\x1f]|^[a-z]+:/i.test(relative) ||
    !contained(film.dir, dir)
  )
    error("$.voiceover.dir", "a relative directory inside the film project");
  else {
    if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory())
      error("$.voiceover.dir", "must be a directory");
    let parent = dir;
    while (!fs.existsSync(parent)) parent = path.dirname(parent);
    const real = fs.realpathSync(parent),
      base = fs.realpathSync(film.dir);
    if (real !== base && !contained(base, real))
      error("$.voiceover.dir", "directory symlink escapes the project");
  }
  const config = { ...checked.brief.voiceover, dir };
  const map = (v, p) => {
    const out = {};
    for (const l of languages) {
      const text = typeof v === "string" ? v : v?.[l];
      if (typeof text !== "string" || !text.trim() || text.length > 4000)
        error(
          `${p}.${l}`,
          "non-empty narration text for every language, at most 4000 characters",
        );
      else out[l] = text;
    }
    return out;
  };
  const plans =
    film.narration !== undefined
      ? [
          {
            id: "narration",
            start: 0.1,
            end: film.duration - 0.1,
            narration: map(film.narration, "$.narration"),
          },
        ]
      : (Array.isArray(film.shots) ? film.shots : [])
          .filter((s) => s?.narration !== undefined)
          .map((s) => ({
            id: s.id,
            start: s.start + 0.08,
            end: s.end - 0.08,
            narration: map(s.narration, `$.shots.${s.id}.narration`),
          }));
  const tracks = [],
    pending = [];
  for (const l of languages) {
    const imported = (film.tracks ?? []).filter(
      (a) => a.role === "voiceover" && (!a.lang || a.lang === l),
    );
    if (imported.length) continue;
    if (!plans.some((p) => p.narration[l])) {
      error(
        `$.narration.${l}`,
        "voiceover is required: add narration to shots, a film narration script, or a voiceover audio track; set voiceover:false only when silence is intended",
      );
      continue;
    }
    for (const p of plans) {
      if (!p.narration[l]) continue;
      const file =
        dir &&
        [".wav", ".m4a", ".aac", ".ogg", ".mp3"]
          .map((ext) => path.join(dir, l, p.id + ext))
          .find((f) => fs.existsSync(f));
      if (!file || skipGenerated) {
        pending.push({ id: p.id, lang: l });
        if (
          (requireFiles === true ||
            (Array.isArray(requireFiles) && requireFiles.includes(l))) &&
          !skipGenerated
        )
          error(
            `$.voiceover.${l}.${p.id}`,
            "missing narration audio; run motion-use voiceover or render to generate it",
          );
        continue;
      }
      if (!contained(fs.realpathSync(film.dir), fs.realpathSync(file))) {
        error(
          `$.voiceover.${l}.${p.id}`,
          "voiceover file symlink escapes the project",
        );
        continue;
      }
      try {
        const freshness = narrationFreshness(dir, file, p.narration[l], config, l);
        if (!freshness.imported && !freshness.current) {
          error(`$.voiceover.${l}.${p.id}`, "stale narration: script, settings or audio hash changed; regenerate voiceover");
          continue;
        }
        const length = probe(file);
        if (length > p.end - p.start + 0.02)
          error(
            `$.voiceover.${l}.${p.id}`,
            `${length.toFixed(3)}s narration exceeds its ${(p.end - p.start).toFixed(3)}s shot window; retime the shot or shorten the script (never truncate speech)`,
          );
        tracks.push({
          file,
          lang: l,
          id: p.id,
          role: "voiceover",
          start: p.start,
          offset: 0,
          length,
          volume: config.volume ?? 1,
          generated: true,
        });
      } catch (e) {
        error(`$.voiceover.${l}.${p.id}`, e.message);
      }
    }
  }
  if (pending.length && !requireFiles)
    warn(
      "$.voiceover",
      `${pending.length} narration clip(s) await generation; render generates them before capture`,
    );
  return { config, plans, pending, tracks };
}

export async function generateFilmNarration(film, options = {}) {
  if (!film.narrationConfig) return { engine: null, rows: [] };
  const langs = options.langs ?? film.languages;
  // A declared imported voiceover takes precedence over generated narration.
  const wanted = langs.filter(
    (l) =>
      !(film.tracks ?? []).some(
        (a) =>
          a.role === "voiceover" && !a.generated && (!a.lang || a.lang === l),
      ),
  );
  fs.mkdirSync(film.narrationConfig.dir, { recursive: true });
  return generateVoiceover(
    {
      languages: wanted,
      voiceover: film.narrationConfig,
      scenes: film.narrationPlans,
    },
    { ...options, langs: wanted },
  );
}
