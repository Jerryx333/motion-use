// Every released film's music, remembered on this machine, so a new release that sounds like an
// earlier one is caught: the same built-in bed, or a score with the same instruments, key and tempo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const indexFile = () =>
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "motion-use", "music-index.json");

/** What identifies a film's music: {kind, mood?, instruments?, key?, tempo?, hash}. */
export function musicSignature(film, score) {
  const m = film.music;
  if (film.scoreFile && score)
    return {
      kind: "score",
      instruments: [...new Set(score.events.map((e) => e.instrument))].sort(),
      key: score.key ?? null,
      tempo: score.tempo,
      hash: crypto.createHash("sha256").update(fs.readFileSync(film.scoreFile)).digest("hex").slice(0, 16),
    };
  if (m === "builtin" || m?.builtin) return { kind: "builtin", mood: m?.builtin ?? "promo", hash: `builtin:${m?.builtin ?? "promo"}` };
  if (film.musicFile)
    return { kind: "file", hash: crypto.createHash("sha256").update(fs.readFileSync(film.musicFile)).digest("hex").slice(0, 16) };
  return { kind: "none", hash: "none" };
}

const jaccard = (a, b) => {
  const A = new Set(a), B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / Math.max(1, new Set([...A, ...B]).size);
};

/** Earlier releases of other films whose music is the same or nearly so. */
export function similarReleases(entry, entries) {
  return entries.filter((e) => {
    if (e.film === entry.film || e.sig.kind !== entry.sig.kind) return false;
    if (e.sig.hash === entry.sig.hash) return true;
    if (entry.sig.kind !== "score") return false;
    return jaccard(e.sig.instruments, entry.sig.instruments) >= 0.8 && e.sig.key === entry.sig.key && Math.abs(e.sig.tempo - entry.sig.tempo) <= 4;
  });
}

/** Record this release; returns warnings about films that already sound like it. */
export function recordRelease(filmFile, film, score) {
  const file = indexFile();
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(file, "utf8")).entries ?? []; } catch {}
  const entry = { film: path.resolve(filmFile), name: film.name ?? null, released: new Date().toISOString(), sig: musicSignature(film, score) };
  if (entry.sig.kind === "none") return [];
  const warnings = similarReleases(entry, entries).map((e) =>
    entry.sig.kind === "score"
      ? `music sounds like the release of ${e.name ?? e.film} (${e.released.slice(0, 10)}): same key, tempo and instruments — give this film its own`
      : `music is the same ${entry.sig.kind === "builtin" ? `built-in "${entry.sig.mood}" bed` : "song"} as the release of ${e.name ?? e.film} (${e.released.slice(0, 10)})`,
  );
  entries = entries.filter((e) => e.film !== entry.film).concat(entry);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ format: 1, entries }, null, 2));
  return warnings;
}
