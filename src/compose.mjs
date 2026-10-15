// composition/score.js → checked note events → rendered WAV, cached by everything that shapes it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { runScore, checkScore } from "./score.mjs";
import { renderScore, loadInstruments, packDir, packInstalled, PACK_VERSION } from "./sampler.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** True when the file is still the score `init` copied in. */
export const isStarterScore = (file) =>
  fs.readFileSync(file, "utf8") === fs.readFileSync(path.join(HERE, "..", "templates", "film", "score.js"), "utf8");

export const INSTALL_HINT = "install the instrument pack: motion-use instruments install";

/** What the score sees of the film: timing, shots, narration windows, words. */
export function scoreView(film, lang, voice) {
  return {
    name: film.name,
    duration: film.duration,
    shots: film.shots,
    voice,
    copy: film.copy?.[lang] ?? {},
    brief: film.brief ?? {},
    look: film.look ?? {},
  };
}

/** Run and check the film's score. Throws with every error; returns {score, problems, view}. */
export function evaluateScore(film, lang, voice, instruments = loadInstruments()) {
  const view = scoreView(film, lang, voice);
  let score;
  try {
    score = runScore(film.scoreFile, view, instruments);
  } catch (e) {
    throw new Error(`${path.relative(process.cwd(), film.scoreFile)}: ${e.message}`);
  }
  const problems = checkScore(score, view, instruments, packInstalled() ? null : INSTALL_HINT);
  if (isStarterScore(film.scoreFile))
    problems.push({ level: "warning", message: "this is the starter score every new film begins with: write this film's own (instruments, mode, peak and accents for its subject)" });
  const errors = problems.filter((p) => p.level === "error");
  if (errors.length) throw new Error(`music score: ${errors.map((e) => e.message).join("; ")}`);
  return { score, problems, view };
}

export function composeMusic(film, lang, voice) {
  const instruments = loadInstruments();
  const { score, problems, view } = evaluateScore(film, lang, voice, instruments);
  const engine = ["score.mjs", "sampler.mjs", "compose.mjs"].map((f) => fs.readFileSync(path.join(HERE, f), "utf8")).join("\n");
  const key = crypto
    .createHash("sha256")
    .update(engine)
    .update(fs.readFileSync(film.scoreFile))
    .update(JSON.stringify(view))
    .update(PACK_VERSION + (packInstalled() ? fs.readFileSync(path.join(packDir(), "manifest.json")) : ""))
    .digest("hex")
    .slice(0, 24);
  const cacheDir = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "motion-use", "music");
  const cached = path.join(cacheDir, `${key}.wav`);
  if (fs.existsSync(cached)) return { wav: fs.readFileSync(cached), score, problems, cached: true, key };
  const { wav, report } = renderScore(score, film.duration, instruments, parseInt(key.slice(0, 8), 16));
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cached, wav);
  return { wav, score, problems, report, cached: false, key };
}
