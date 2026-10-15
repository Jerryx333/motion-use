import fs from "node:fs";
import path from "node:path";
import { checkFilm, resolveProject, validateFilm } from "./film.mjs";
import { audioSeconds } from "./build.mjs";

export function retimeFilm(input, { out } = {}) {
  const file = resolveProject(input),
    dir = path.dirname(file);
  const checked = checkFilm(file, { skipGeneratedVoiceover: true });
  if (!checked.ok)
    throw new Error(
      checked.report.errors.map((e) => `${e.path}: ${e.message}`).join("\n"),
    );
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (data.narration !== undefined)
    throw new Error(
      "retime needs per-shot narration, not a continuous root narration",
    );
  if (
    data.captions ||
    data.cues ||
    data.audio?.length ||
    Object.keys(data.videos ?? {}).length
  )
    throw new Error(
      "Retime before placing external captions, cues, audio or footage; their absolute times need deliberate editing.",
    );
  const voDir = checked.film.narrationConfig?.dir;
  let frame = 0;
  const changes = [];
  for (const shot of data.shots) {
    const before = { start: shot.start, end: shot.end };
    let count = Math.round((shot.end - shot.start) * data.fps);
    if (shot.duration === "narration") {
      if (!voDir || !shot.narration)
        throw new Error(`${shot.id}: needs generated per-shot narration`);
      const seconds = data.languages.map((lang) => {
        const clip = [".wav", ".m4a", ".aac", ".ogg", ".mp3"]
          .map((e) => path.join(voDir, lang, shot.id + e))
          .find((f) => fs.existsSync(f));
        if (!clip)
          throw new Error(
            `${lang}/${shot.id}: missing audio; run voiceover first`,
          );
        const relative = path.relative(
          fs.realpathSync(dir),
          fs.realpathSync(clip),
        );
        if (
          !relative ||
          relative === ".." ||
          relative.startsWith(".." + path.sep) ||
          path.isAbsolute(relative) ||
          !fs.statSync(clip).isFile()
        )
          throw new Error(
            `${lang}/${shot.id}: narration file escapes the project`,
          );
        return audioSeconds(clip);
      });
      count = Math.ceil(
        (0.16 + Math.max(...seconds) + (shot.tail ?? 0.4)) * data.fps,
      );
    }
    if (count < 1)
      throw new Error(`${shot.id}: a shot must last at least one frame`);
    shot.start = frame / data.fps;
    frame += count;
    shot.end = frame / data.fps;
    changes.push({
      id: shot.id,
      before,
      after: { start: shot.start, end: shot.end },
    });
  }
  data.duration = frame / data.fps;
  if (data.duration > 180)
    throw new Error(
      `Retimed film is ${data.duration}s; split into parts and use concat (single-film limit 180s)`,
    );
  const target = path.resolve(out ?? path.join(dir, "film.retimed.json"));
  if (path.dirname(target) !== dir)
    throw new Error(
      "Keep the retimed JSON beside film.json so declared paths remain valid",
    );
  if (fs.existsSync(target))
    throw new Error(`${target} already exists; choose a fresh --out`);
  const validation = validateFilm(data, dir).errors.map(
    (e) => `${e.path}: ${e.message}`,
  );
  if (validation.length) throw new Error(validation.join("\n"));
  fs.writeFileSync(target, JSON.stringify(data, null, 2) + "\n", {
    flag: "wx",
  });
  return {
    ok: true,
    film: target,
    duration: data.duration,
    changes,
    targetLength: data.brief?.length ?? null,
    warning:
      "A new timeline proposal; target brief.length is preserved. Review choreography, music hits and duration before rendering this file.",
  };
}
