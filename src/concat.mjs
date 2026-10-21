// Join already rendered parts, normalize the whole soundtrack, then verify the actual master.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { freshDirectory } from "./catalog.mjs";
import {
  probeMedia,
  checkAgainstManifest,
  releaseEntry,
  writeReleaseManifest,
} from "./release.mjs";
import { normalizeAudio, verifyVideo } from "./verify.mjs";

const hash = (file) => {
  const h = crypto.createHash("sha256"),
    fd = fs.openSync(file, "r"),
    buf = Buffer.alloc(1 << 20);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)))
      h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
};
const ff = (args) =>
  execFileSync("ffmpeg", ["-hide_banner", "-nostats", "-y", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });

// Read the video timeline independently of format.duration, which may include AAC padding.
function videoTimeline(file, decode = false) {
  const read = (count) => JSON.parse(execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0", ...(count ? ["-count_frames"] : []),
    "-show_entries", "stream=r_frame_rate,avg_frame_rate,nb_frames,nb_read_frames", "-of", "json", file,
  ], { encoding: "utf8" })).streams?.[0];
  let v = read(decode);
  if (!decode && !Number.isSafeInteger(Number(v?.nb_frames))) {
    v = read(true);
    decode = true;
  }
  const [numerator, denominator] = (v?.r_frame_rate ?? "0/1").split("/").map(Number);
  const frames = Number(decode ? v?.nb_read_frames : v?.nb_frames ?? v?.nb_read_frames), fps = numerator / denominator;
  if (!Number.isSafeInteger(frames) || frames < 1 || !Number.isFinite(fps) || fps <= 0)
    throw new Error(`${file}: cannot establish video frame timeline`);
  const [an, ad] = (v.avg_frame_rate ?? "0/1").split("/").map(Number);
  if (ad && an && Math.abs(an / ad - fps) > 1e-6)
    throw new Error(`${file}: variable frame rate is unsupported; render constant frame rate first`);
  return { frames, fps, numerator, denominator };
}
const clock = (seconds, separator = ".") => {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}${separator}${String(ms % 1000).padStart(3, "0")}`;
};
const metadataText = (value) => String(value).replace(/([\\=;#])/g, "\\$1").replace(/\r?\n/g, " ");

export function concatParts(configFile, options = {}) {
  const base = path.dirname(path.resolve(configFile)),
    config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  if (
    !/^[a-z0-9][a-z0-9-]{0,39}$/.test(config.name ?? "") ||
    !Array.isArray(config.parts) ||
    config.parts.length < 2 ||
    config.parts.length > 60
  )
    throw new Error(
      "concat config needs {name: slug, parts: [{file, from?, to?, manifest?}, ...]} (2–60 parts)",
    );
  const parts = config.parts.map((p) => {
    if (!p || typeof p.file !== "string")
      throw new Error("concat part needs a file");
    const file = path.resolve(base, p.file),
      facts = probeMedia(file),
      timeline = videoTimeline(file);
    facts.fps = timeline.fps;
    if (!facts.width || !facts.height || !Number.isFinite(facts.fps) || facts.fps <= 0)
      throw new Error(`${p.file}: a video stream with dimensions and frame rate is required`);
    if (p.title !== undefined && (typeof p.title !== "string" || !p.title.trim() || /[\r\n]/.test(p.title)))
      throw new Error(`${p.file}: title must be a nonempty single line`);
    const from = p.from ?? 0,
      to = p.to ?? timeline.frames / timeline.fps;
    if (
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      from < 0 ||
      to <= from ||
      to > timeline.frames / timeline.fps + 1e-6
    )
      throw new Error(`${p.file}: invalid source range`);
    let snapshot = null,
      manifestHash = null;
    if (p.manifest) {
      const manifest = path.resolve(base, p.manifest),
        checked = checkAgainstManifest(manifest, file);
      if (!checked.ok) throw new Error(checked.reason);
      snapshot = checked.snapshot ?? null;
      manifestHash = hash(manifest);
    }
    return {
      file,
      facts,
      from,
      to,
      timeline,
      title: p.title ?? null,
      source: p.source ?? null,
      startFrame: Math.round(from * timeline.fps),
      frames: Math.round(to * timeline.fps) - Math.round(from * timeline.fps),
      length: (Math.round(to * timeline.fps) - Math.round(from * timeline.fps)) / timeline.fps,
      sha256: hash(file),
      snapshot,
      manifestHash,
    };
  });
  const first = parts[0].facts;
  if (
    parts.some(
      (p) =>
        p.facts.width !== first.width ||
        p.facts.height !== first.height ||
        p.facts.fps !== first.fps,
    )
  )
    throw new Error(
      "concat parts must have the same width, height and fps; render matching formats first",
    );
  if (parts.some((p) => p.length < 1 / first.fps))
    throw new Error("concat part shorter than one frame");
  const out = freshDirectory(
    options.out ?? path.join(base, "out", config.name + "-joined"),
  );
  fs.mkdirSync(out);
  const input = parts.flatMap((p) => ["-i", p.file]),
    filters = [];
  const withAudio = parts.some((p) => p.facts.audio);
  parts.forEach((p, i) => {
    filters.push(
      `[${i}:v]trim=start_frame=${p.startFrame}:end_frame=${p.startFrame + p.frames},setpts=N/(${first.fps}*TB),setsar=1[v${i}]`,
    );
    if (withAudio)
      filters.push(
        p.facts.audio
          ? `[${i}:a]atrim=start=${p.startFrame / first.fps}:duration=${p.length},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${p.length}[a${i}]`
          : `anullsrc=r=48000:cl=stereo,atrim=duration=${p.length}[a${i}]`,
      );
  });
  filters.push(
    `${parts.map((_, i) => `[v${i}]${withAudio ? `[a${i}]` : ""}`).join("")}concat=n=${parts.length}:v=1:a=${withAudio ? 1 : 0}[v]${withAudio ? "[a]" : ""}`,
  );
  const candidate = path.join(out, "candidate.mp4");
  ff([
    "-v",
    "error",
    ...input,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[v]",
    ...(withAudio ? ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"] : []),
    "-c:v",
    "libx264",
    "-preset",
    options.release ? "veryslow" : "fast",
    "-crf",
    options.release ? "16" : "20",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    candidate,
  ]);
  const normalized = path.join(out, "normalized.mp4"),
    normalization = normalizeAudio(candidate, normalized);
  if (normalization.applied) fs.renameSync(normalized, candidate);
  let frame = 0;
  const provenance = parts.map((p) => {
    const startFrame = frame;
    frame += p.frames;
    return {
      file: path.basename(p.file),
      sha256: p.sha256,
      snapshot: p.snapshot,
      manifestSha256: p.manifestHash,
      source: p.source,
      title: p.title,
      requestedRange: { from: p.from, to: p.to },
      from: p.startFrame / first.fps,
      to: (p.startFrame + p.frames) / first.fps,
      sourceStartFrame: p.startFrame,
      frames: p.frames,
      startFrame,
      endFrame: frame,
      start: startFrame / first.fps,
      end: frame / first.fps,
    };
  });
  const duration = frame / first.fps;
  const chapters = provenance.map((p, i) => ({
    index: i + 1, title: p.title ?? `Part ${i + 1}`,
    startFrame: p.startFrame, endFrame: p.endFrame,
    start: p.start, end: p.end,
    source: { file: p.file, sha256: p.sha256, from: p.from, to: p.to, provenance: p.source },
  }));
  const embedded = config.chapters === true || parts.some((p) => p.title !== null);
  if (embedded) {
    const { numerator, denominator } = parts[0].timeline;
    const metadata = path.join(out, "chapters.ffmetadata");
    fs.writeFileSync(metadata, ";FFMETADATA1\n" + chapters.map((c) => `[CHAPTER]\nTIMEBASE=1/${numerator}\nSTART=${c.startFrame * denominator}\nEND=${c.endFrame * denominator}\ntitle=${metadataText(c.title)}\n`).join(""));
    const chaptered = path.join(out, "chaptered.mp4");
    ff(["-v", "error", "-i", candidate, "-i", metadata, "-map", "0:v:0", "-map", "0:a?", "-map_metadata", "1", "-map_chapters", "1", "-c", "copy", "-movflags", "+faststart", chaptered]);
    fs.renameSync(chaptered, candidate);
  }
  const actual = videoTimeline(candidate, true);
  if (actual.frames !== frame) throw new Error(`Joined video has ${actual.frames} frames; expected ${frame}`);
  const containerDuration = probeMedia(candidate).duration;
  const chapterFiles = {
    json: path.join(out, "chapters.json"),
    text: path.join(out, "chapters.txt"),
    srt: path.join(out, "chapters.srt"),
  };
  fs.writeFileSync(chapterFiles.json, JSON.stringify({ schemaVersion: 1, name: config.name, fps: first.fps, frameRate: `${parts[0].timeline.numerator}/${parts[0].timeline.denominator}`, frames: frame, videoDuration: duration, containerDuration, embedded, chapters }, null, 2) + "\n");
  fs.writeFileSync(chapterFiles.text, chapters.map((c) => `${clock(c.start)} – ${clock(c.end)}  ${c.title}`).join("\n") + "\n");
  fs.writeFileSync(chapterFiles.srt, chapters.map((c) => `${c.index}\n${clock(c.start, ",")} --> ${clock(c.end, ",")}\n${c.title}\n`).join("\n"));
  const joins = provenance
    .slice(1)
    .map((p) => joinCheck(candidate, p.start, duration, withAudio));
  const verification = verifyVideo(candidate, path.join(out, "review"), {
    expected: {
      duration,
      width: first.width,
      height: first.height,
      fps: first.fps,
    },
    shots: provenance.map((p, i) => ({
      id: `part-${i + 1}`,
      start: p.start,
      end: p.end,
    })),
    motionCheck: {
      gate: Boolean(options.release),
      cuts: provenance.slice(1).map((p) => p.start),
      allowStatic: options["allow-static"] ?? null,
      allowBluePurple: options["allow-blue-purple"] ?? null,
    },
  });
  const dir = path.join(
    out,
    options.release && verification.ok ? "release" : "preview",
  );
  fs.mkdirSync(dir);
  const target = path.join(
    dir,
    `${config.name}${verification.ok ? "" : "-failed"}.mp4`,
  );
  fs.renameSync(candidate, target);
  for (const kind of Object.keys(chapterFiles)) {
    const destination = path.join(dir, path.basename(chapterFiles[kind]));
    fs.copyFileSync(chapterFiles[kind], destination);
    chapterFiles[kind] = destination;
  }
  const report = {
    ...verification,
    file: target,
    normalization,
    videoDuration: duration,
    containerDuration,
    chapterFiles,
    chaptersEmbedded: embedded,
    parts: provenance,
    joins,
    limitations: [
      ...verification.limitations,
      "Join windows measure static spans and mean level changes, not narrative continuity or perceived loudness. Review and listen across every join. Part source files are recorded by hash, not bundled.",
    ],
  };
  fs.writeFileSync(verification.report, JSON.stringify(report, null, 2) + "\n");
  fs.writeFileSync(
    path.join(out, "parts.json"),
    JSON.stringify({ name: config.name, parts: provenance, joins }, null, 2) +
      "\n",
  );
  let manifest = null;
  if (parts.some((p) => hash(p.file) !== p.sha256))
    throw new Error(
      "A source part changed during concat; no release manifest written",
    );
  if (options.release && verification.ok) {
    const m = writeReleaseManifest(dir, {
      entries: [
        releaseEntry(dir, path.basename(target), {
          kind: "master",
          lang: config.lang ?? "und",
          format: config.format ?? "custom",
        }),
        ...Object.values(chapterFiles).map((file) => ({ file: path.basename(file), kind: "chapters", sha256: hash(file), bytes: fs.statSync(file).size })),
      ],
      snapshot: null,
      version: options.version,
      film: config.name,
    });
    m.chapters = { ...Object.fromEntries(Object.entries(chapterFiles).map(([kind, file]) => [kind, path.basename(file)])), embedded };
    m.parts = provenance;
    m.joins = joins;
    manifest = path.join(dir, "release-manifest.json");
    fs.writeFileSync(manifest, JSON.stringify(m, null, 2) + "\n");
  }
  return {
    ok: verification.ok,
    file: target,
    report: verification.report,
    release_manifest: manifest,
    videoDuration: duration,
    containerDuration,
    chapterFiles,
    chaptersEmbedded: embedded,
    parts: provenance,
    joins,
  };
}
function joinCheck(file, time, duration, withAudio) {
  const start = Math.max(0, time - 1.5),
    length = Math.min(duration - start, 3);
  const scan = runLog([
    "-ss",
    String(start),
    "-t",
    String(length),
    "-i",
    file,
    "-vf",
    "freezedetect=n=-50dB:d=0.8",
    "-an",
    "-f",
    "null",
    "-",
  ]);
  const level = (a, b) => {
    const log = runLog([
      "-ss",
      String(a),
      "-t",
      String(b - a),
      "-i",
      file,
      "-vn",
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ]);
    const m = /mean_volume: (-?[\d.]+) dB/.exec(log);
    return m ? +m[1] : null;
  };
  const before = withAudio ? level(Math.max(0, time - 1), time) : null,
    after = withAudio ? level(time, Math.min(duration, time + 1)) : null;
  const staticDetected = /freeze_start:/.test(scan);
  return {
    time,
    window: [start, start + length],
    staticDetected,
    beforeMeanDb: before,
    afterMeanDb: after,
    meanLevelJumpDb:
      before !== null && after !== null ? +(after - before).toFixed(2) : null,
    reviewRequired:
      staticDetected ||
      (before !== null && after !== null && Math.abs(after - before) > 3),
  };
}
function runLog(args) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
  });
  if (r.error || r.status !== 0)
    throw new Error(
      `join measurement failed: ${String(r.stderr ?? r.error?.message).slice(-300)}`,
    );
  return r.stderr ?? "";
}
