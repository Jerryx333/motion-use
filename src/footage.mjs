import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function anchoredTime(clip, shots, absolute, relative = "offset") {
  if (clip.shot === undefined) {
    if (clip[relative] !== undefined && relative !== "offset")
      throw Error(`${relative} requires shot`);
    return clip[absolute] ?? 0;
  }
  const shot = shots.find((s) => s.id === clip.shot);
  if (!shot) throw Error(`unknown shot ${clip.shot}`);
  if (clip[absolute] !== undefined)
    throw Error(`use shot + ${relative}, not ${absolute} together with shot`);
  const delay = clip[relative] ?? 0;
  if (!Number.isFinite(delay) || delay < 0 || delay >= shot.end - shot.start)
    throw Error(`${relative} must be inside shot ${shot.id}`);
  return shot.start + delay;
}

export function sequenceFiles(pattern, local, fps, start = 0) {
  if (
    typeof pattern !== "string" ||
    !/%(?:0[1-9]\d?)?d\.(png|jpe?g|webp)$/i.test(pattern) ||
    (pattern.match(/%/g) ?? []).length !== 1
  )
    throw Error(
      "frames must be a local numbered pattern such as capture/%05d.png",
    );
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240)
    throw Error("image sequence fps must be > 0 and <= 240");
  if (!Number.isInteger(start) || start < 0)
    throw Error("startNumber must be a non-negative integer");
  const token = pattern.match(/%(?:0([1-9]\d?))?d/),
    width = Number(token[1] ?? 0);
  const name = (n) => pattern.replace(token[0], String(n).padStart(width, "0"));
  const first = local(name(start));
  if (!first) throw Error("missing first image sequence frame");
  const dir = path.dirname(first),
    names = fs.readdirSync(dir);
  const escaped = path
    .basename(pattern)
    .split(token[0])
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`^${escaped[0]}(\\d+)${escaped[1]}$`);
  const indices = names
    .map((s) => re.exec(s))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .filter((n) => n >= start)
    .sort((a, b) => a - b);
  if (!indices.length || indices.length > 21600)
    throw Error("image sequence needs 1–21600 frames");
  return indices.map((n, i) => {
    if (n !== start + i)
      throw Error(`image sequence gap: missing ${name(start + i)}`);
    const file = local(name(n));
    if (!file) throw Error(`missing image sequence frame ${name(n)}`);
    return file;
  });
}

export function buildFootage(v, dir, fps, width) {
  const seconds = Math.min(v.length, v.room);
  if (v.sequence) {
    const first = Math.floor(v.from * v.sourceFps + 1e-7);
    const last = Math.min(
      v.sequence.length - 1,
      Math.ceil((v.from + seconds * v.rate) * v.sourceFps - 1e-7) - 1,
    );
    const ext = path.extname(v.sequence[0]).slice(1).toLowerCase();
    for (let i = first; i <= last; i++)
      fs.copyFileSync(
        v.sequence[i],
        path.join(dir, `${String(i - first).padStart(5, "0")}.${ext}`),
      );
    return {
      frames: last - first + 1,
      ext,
      fps: v.sourceFps / v.rate,
      frameOffset: v.from * v.sourceFps - first,
    };
  }
  const scale = Math.min(1, width / Math.max(v.width, v.height));
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-ss",
      String(v.from),
      "-t",
      String(seconds * v.rate),
      "-i",
      v.file,
      "-vf",
      `fps=${fps / v.rate},scale=${Math.max(2, Math.round((v.width * scale) / 2) * 2)}:-2`,
      "-q:v",
      "3",
      "-start_number",
      "0",
      path.join(dir, "%05d.jpg"),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const frames = fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).length;
  if (!frames) throw Error(`no frames could be read from ${v.file}`);
  return { frames, ext: "jpg" };
}
