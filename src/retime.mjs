import { spoken } from "./caption-plan.mjs";
import { narrationFreshness } from "./voiceover.mjs";
import fs from "node:fs";
import path from "node:path";
import { checkFilm, resolveProject, validateFilm } from "./film.mjs";
import { audioSeconds } from "./build.mjs";

export function retimeFilm(input, { out, keepCaptions = false, scaleTiming = false } = {}) {
  const file = resolveProject(input),
    dir = path.dirname(file);
  const checked = checkFilm(file, { skipGeneratedVoiceover: true, phase: "narration" });
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
    (data.captions && !keepCaptions) ||
    data.cues ||
    data.audio?.some((a) => !a.shot) ||
    Object.values(data.videos ?? {}).some((v) => !v.shot)
  )
    throw new Error(
      "Retime before placing external captions, cues, audio or footage; their absolute times need deliberate editing. For captions contained in one shot, use --keep-captions.",
    );
  const voDir = checked.film.narrationConfig?.dir;
  const captionOwners = Object.entries(data.captions ?? {}).flatMap(([lang, cues]) => cues.map((cue) => {
    const shot = data.shots.find((s) => cue.start >= s.start - 1e-6 && cue.end <= s.end + 1e-6);
    if (!shot) throw new Error(`${lang}: caption spans shot boundaries; edit its timing deliberately`);
    return { cue, id: shot.id, start: cue.start - shot.start, end: cue.end - shot.start };
  }));
  let frame = 0;
  const changes = [];
  for (const shot of data.shots) {
    const before = { start: shot.start, end: shot.end };
    if ((scaleTiming || data.pace !== undefined) && shot.authoredDuration === undefined) shot.authoredDuration = shot.end - shot.start;
    let count = Math.round((data.pace !== undefined ? shot.authoredDuration / data.pace : shot.end - shot.start) * data.fps);
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
        const freshness = narrationFreshness(voDir, clip, spoken(typeof shot.narration === "string" ? shot.narration : shot.narration[lang]), checked.film.narrationConfig, lang);
        if (!freshness.current)
          throw new Error(`${lang}/${shot.id}: ${freshness.imported ? "unverified recording (no matching narration manifest)" : "stale narration"}; run voiceover --force to generate current speech before retime`);
        return audioSeconds(clip);
      });
      count = Math.ceil(
        (0.16 + Math.max(...seconds) + (shot.tail ?? 0.4) / (data.pace ?? 1)) * data.fps,
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
  for (const { cue, id, start, end } of captionOwners) {
    const shot = data.shots.find((s) => s.id === id);
    if (end > shot.end - shot.start + 1e-6) throw new Error(`${id}: caption exceeds the retimed shot window; regenerate or shorten the caption`);
    cue.start = shot.start + start;
    cue.end = shot.start + end;
  }
  let target = path.resolve(out ?? path.join(dir, "film.retimed.json"));
  // Each default proposal gets a new filename; a failed iteration cannot advertise the old one.
  if (out === undefined) {
    for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `film.retimed-${n}.json`);
  }
  if (path.dirname(target) !== dir)
    throw new Error(
      "Keep the retimed JSON beside film.json so declared paths remain valid",
    );
  if (fs.existsSync(target))
    throw new Error(`${target} already exists; it may contain an old timeline. Do not use it as this command's result; omit --out for a fresh proposal or choose a fresh --out`);
  const validation = validateFilm(data, dir, { phase: "retime" }).errors.map(
    (e) => `${e.path}: ${e.message}`,
  );
  if (validation.length) throw new Error(validation.join("\n"));
  fs.writeFileSync(target, JSON.stringify(data, null, 2) + "\n", {
    flag: "wx",
  });
  return {
    ok: true,
    film: target,
    source: file,
    validation_phase: "narration",
    duration: data.duration,
    changes,
    targetLength: data.brief?.length ?? null,
    warning:
      "A new timeline proposal; target brief.length is preserved. Review choreography, music hits and duration before rendering this file.",
  };
}
