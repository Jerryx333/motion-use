// Release masters: what goes to the platforms. Only high-quality files, each recorded with its
// hash in out/release/release-manifest.json, so a publish step can prove it uploads the current
// cut. In the iphone-use promo (2026-10) a standard-quality cut and a cut from before the last
// review fix were both published by mistake and had to be deleted and re-posted.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const MANIFEST_NAME = "release-manifest.json";
export const X_LIMIT = 45e6; // what X's web upload reliably accepts

const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

function ffmpeg(args) {
  try {
    execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    throw new Error(`ffmpeg failed: ${e.code === "ENOENT" ? "ffmpeg not found" : e.stderr?.toString().trim().split("\n").slice(-3).join(" ")}`);
  }
}

/** Duration, size and stream facts of a delivered file. */
export function probeMedia(file) {
  const j = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,size,bit_rate:stream=codec_type,codec_name,width,height,r_frame_rate,bit_rate,sample_rate", "-of", "json", file], { encoding: "utf8" }),
  );
  const v = j.streams.find((s) => s.codec_type === "video"),
    a = j.streams.find((s) => s.codec_type === "audio");
  const [n, d] = (v?.r_frame_rate ?? "0/1").split("/").map(Number);
  return {
    duration: +Number(j.format.duration).toFixed(3),
    bytes: Number(j.format.size),
    width: v?.width ?? null,
    height: v?.height ?? null,
    fps: d ? +(n / d).toFixed(3) : null,
    video_bitrate: v?.bit_rate ? Number(v.bit_rate) : null,
    video_codec: v?.codec_name ?? null,
    audio: a ? { codec: a.codec_name, sample_rate: Number(a.sample_rate), bitrate: a.bit_rate ? Number(a.bit_rate) : null } : null,
  };
}

/** x264 veryslow CRF 16, yuv420p, faststart, AAC 192 kbps: the platform master. */
export function encodeMaster(src, dst) {
  const tmp = `${dst}.partial.mp4`;
  ffmpeg(["-i", src, "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryslow", "-crf", "16", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", tmp]);
  fs.renameSync(tmp, dst);
}

/** A variant that fits `limit` bytes: two-pass x264 at the bitrate the limit allows. */
export function encodeUnder(src, dst, limit, duration, workDir) {
  const audio = 192e3,
    video = Math.floor(((limit * 8) / duration) * 0.95 - audio);
  if (video < 1e6) throw new Error(`a ${duration}s video cannot fit ${limit / 1e6} MB at a usable bitrate`);
  const tmp = `${dst}.partial.mp4`,
    log = path.join(workDir, "x264-2pass");
  const common = ["-i", src, "-map", "0:v:0", "-c:v", "libx264", "-preset", "slow", "-b:v", String(video), "-pix_fmt", "yuv420p", "-passlogfile", log];
  ffmpeg([...common, "-pass", "1", "-an", "-f", "mp4", process.platform === "win32" ? "NUL" : "/dev/null"]);
  ffmpeg([...common, "-map", "0:a?", "-pass", "2", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", tmp]);
  for (const f of fs.readdirSync(workDir)) if (f.startsWith("x264-2pass")) fs.rmSync(path.join(workDir, f), { force: true });
  if (fs.statSync(tmp).size > limit) throw new Error(`variant came out at ${fs.statSync(tmp).size} bytes, above ${limit}`);
  fs.renameSync(tmp, dst);
}

export function readReleaseManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_NAME), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Add or replace entries in out/release/release-manifest.json. Entries whose file is gone or
 * no longer matches its hash are dropped, so the manifest only ever lists deliverable files.
 */
export function writeReleaseManifest(dir, { entries, snapshot, version, film, narrationCheck }) {
  const old = readReleaseManifest(dir);
  const keep = (old?.files ?? []).filter(
    (e) => !entries.some((n) => n.file === e.file) && fs.existsSync(path.join(dir, e.file)) && sha(path.join(dir, e.file)) === e.sha256,
  );
  const manifest = {
    motion_use: version,
    created: new Date().toISOString(),
    film,
    snapshot,
    ...(narrationCheck ? { narration_check: narrationCheck } : {}),
    files: [...keep, ...entries].sort((a, b) => a.file.localeCompare(b.file)),
  };
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

/** A manifest entry for one file in the release folder. */
export function releaseEntry(dir, file, extra) {
  const full = path.join(dir, file);
  const facts = file.endsWith(".png") ? { bytes: fs.statSync(full).size } : probeMedia(full);
  return { file, sha256: sha(full), ...extra, ...facts };
}

/**
 * Is `file` exactly a file the manifest lists? { ok, entry?, reason }.
 * A same-named file with another hash is a stale or edited cut.
 */
export function checkAgainstManifest(manifestPath, file) {
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(m.files)) return { ok: false, reason: `${manifestPath} is not a release manifest` };
  const h = sha(file);
  const entry = m.files.find((e) => e.sha256 === h);
  if (entry) return { ok: true, entry, snapshot: m.snapshot, created: m.created };
  const named = m.files.find((e) => path.basename(e.file) === path.basename(file));
  return {
    ok: false,
    reason: named
      ? `${path.basename(file)} differs from the manifest's ${named.file} (sha256 ${h.slice(0, 12)}… vs ${named.sha256.slice(0, 12)}…): a stale or edited cut`
      : `no file with sha256 ${h.slice(0, 12)}… in ${manifestPath}: not a release master of this film`,
  };
}
