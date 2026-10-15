// Measure the delivered MP4, never the pre-render plan. Visual quality remains a review task.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { claimDir } from "./build.mjs";
import { measureMotion, gradeMotion, demoSimilarity } from "./motion-check.mjs";
import { fileURLToPath } from "node:url";

const DEMOS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "demo-signatures.json");

const run = (bin, args) =>
  execFileSync(bin, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
export function probeVideo(file) {
  const j = JSON.parse(
    run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,width,height,avg_frame_rate,nb_frames",
      "-of",
      "json",
      file,
    ]),
  );
  const v = j.streams.find((s) => s.codec_type === "video");
  if (!v) throw new Error("output contains no video stream");
  const rate = String(v.avg_frame_rate).split("/").map(Number);
  return {
    width: v.width,
    height: v.height,
    fps: rate[0] / rate[1],
    seconds: Number(j.format.duration),
    frames: Number(v.nb_frames) || null,
    audio: j.streams.some((s) => s.codec_type === "audio"),
  };
}

export function loudness(file) {
  const r = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-i",
      file,
      "-af",
      "loudnorm=I=-14:TP=-1:LRA=11:print_format=json",
      "-vn",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (r.error || r.status !== 0)
    throw new Error(r.error?.message || r.stderr.slice(-1500));
  const json = r.stderr.slice(
      r.stderr.lastIndexOf("{"),
      r.stderr.lastIndexOf("}") + 1,
    ),
    m = JSON.parse(json);
  return m;
}

export function normalizeAudio(file, output) {
  if (!probeVideo(file).audio) return { applied: false, reason: "no audio" };
  const m = loudness(file);
  if (!Number.isFinite(Number(m.input_i)))
    return { applied: false, reason: "silent audio" };
  const filter = `loudnorm=I=-14:TP=-1:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  run("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    file,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-c:v",
    "copy",
    "-af",
    filter,
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    output,
  ]);
  return { applied: true, target_lufs: -14, target_peak_dbtp: -1 };
}

export function buildNarrationStem(tracks, seconds, output) {
  const inputs = tracks.flatMap((a) => ["-i", a.file]);
  const filters = tracks.map(
    (a, i) =>
      `[${i}:a]atrim=start=${a.offset}:duration=${a.length},asetpts=PTS-STARTPTS,volume=${a.volume},afade=t=in:d=0.015,afade=t=out:st=${Math.max(0, a.length - 0.03)}:d=0.03,adelay=${Math.round(a.start * 1000)}:all=1[v${i}]`,
  );
  filters.push(
    `${tracks.map((_, i) => `[v${i}]`).join("")}amix=inputs=${tracks.length}:normalize=0,apad,atrim=duration=${seconds},aresample=16000[out]`,
  );
  run("ffmpeg", [
    "-v",
    "error",
    "-y",
    ...inputs,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[out]",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    output,
  ]);
}

export function verifyNarration(file, stem, tracks) {
  const pcm = (f) =>
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        f,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "f32le",
        "-",
      ],
      { maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
  const delivered = pcm(file),
    reference = pcm(stem),
    segments = [];
  for (const a of tracks) {
    const start = Math.floor(a.start * 16000),
      end = Math.min(
        Math.floor((a.start + a.length) * 16000),
        reference.length / 4,
        delivered.length / 4,
      );
    let dot = 0,
      rx = 0,
      dy = 0;
    for (let i = start; i < end; i++) {
      const x = reference.readFloatLE(i * 4),
        y = delivered.readFloatLE(i * 4);
      dot += x * y;
      rx += x * x;
      dy += y * y;
    }
    const rms = rx > 0 ? 10 * Math.log10(rx / Math.max(1, end - start)) : null;
    const correlation = rx && dy ? dot / Math.sqrt(rx * dy) : 0;
    segments.push({
      id: a.id ?? path.basename(a.file),
      lang: a.lang ?? null,
      start: a.start,
      end: a.start + a.length,
      reference_rms_dbfs: rms,
      correlation: +correlation.toFixed(4),
      ok: rms !== null && rms > -55 && correlation >= 0.45,
    });
  }
  return {
    ok: segments.length > 0 && segments.every((s) => s.ok),
    method: "time-aligned voice-stem correlation against delivered mix",
    segments,
  };
}

export function reviewTimes(seconds, fps, shots = []) {
  const values = [
    0,
    Math.min(0.2, seconds / 2),
    Math.max(0, seconds - 1 / fps),
  ];
  for (const s of shots)
    values.push(
      s.start,
      Math.max(0, s.start - 1 / fps),
      Math.min(seconds - 1 / fps, s.start + 1 / fps),
      (s.start + s.end) / 2,
      Math.max(s.start, s.end - 1 / fps),
    );
  if (!shots.length)
    for (let t = seconds / 8; t < seconds; t += seconds / 8) values.push(t);
  return [
    ...new Set(
      values
        .filter((t) => t >= 0 && t < seconds)
        .map((t) => +(Math.round(t * fps) / fps).toFixed(6)),
    ),
  ]
    .sort((a, b) => a - b)
    .slice(0, 160);
}

export function compareDelivery(meta, expected = {}) {
  const errors = [];
  if (!Number.isFinite(meta.seconds) || meta.seconds <= 0)
    errors.push("invalid output duration");
  if (
    expected.duration !== undefined &&
    Math.abs(meta.seconds - expected.duration) >
      Math.max(0.12, 2 / (expected.fps || meta.fps))
  )
    errors.push(
      `duration ${meta.seconds}s differs from planned ${expected.duration}s`,
    );
  if (
    expected.width !== undefined &&
    (meta.width !== expected.width || meta.height !== expected.height)
  )
    errors.push(
      `output is ${meta.width}×${meta.height}, expected ${expected.width}×${expected.height}`,
    );
  if (expected.fps !== undefined && Math.abs(meta.fps - expected.fps) > 0.01)
    errors.push(`output fps ${meta.fps} differs from ${expected.fps}`);
  if (expected.audio === true && !meta.audio)
    errors.push("expected audio is missing");
  return errors;
}

export function verifyVideo(
  file,
  outDir,
  {
    expected = {},
    progress = () => {},
    shots = [],
    narrationStem = null,
    narrationTracks = [],
    // gate: red motion lights fail delivery (authored films); otherwise they are reported only.
    motionCheck = { gate: false, cuts: [], allowStatic: null, allowBluePurple: null },
    // loop: the film is meant to repeat, so its last frame must lead straight into its first.
    loop = false,
  } = {},
) {
  file = path.resolve(file);
  const meta = probeVideo(file),
    errors = compareDelivery(meta, expected),
    warnings = [];
  claimDir(outDir);
  progress("decode", "start");
  const decode = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-xerror",
      "-i",
      file,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (decode.error || decode.status !== 0)
    errors.push(
      `decode failed: ${decode.error?.message || decode.stderr.slice(-800)}`,
    );
  progress("decode", decode.error || decode.status !== 0 ? "error" : "finish");
  let sound = null;
  if (meta.audio)
    try {
      const m = loudness(file);
      sound = {
        integrated_lufs: Number.isFinite(Number(m.input_i))
          ? Number(m.input_i)
          : null,
        true_peak_dbtp: Number.isFinite(Number(m.input_tp))
          ? Number(m.input_tp)
          : null,
        loudness_range_lu: Number(m.input_lra),
      };
      if (sound.integrated_lufs === null)
        warnings.push("audio stream is silent");
      if (sound.true_peak_dbtp > -0.5)
        warnings.push("audio peak exceeds -0.5 dBTP");
      if (
        sound.integrated_lufs !== null &&
        (sound.integrated_lufs < -20 || sound.integrated_lufs > -10)
      )
        warnings.push(
          "integrated loudness is outside the working -20 to -10 LUFS range",
        );
    } catch (e) {
      errors.push(`audio measurement failed: ${e.message}`);
    }
  const scan = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-i",
      file,
      "-vf",
      "blackdetect=d=0.2:pix_th=0.02,freezedetect=n=-50dB:d=0.8",
      "-an",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const black = [
    ...String(scan.stderr).matchAll(
      /black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g,
    ),
  ].map((m) => ({
    start: Number(m[1]),
    end: Number(m[2]),
    seconds: Number(m[3]),
  }));
  const freezes = [];
  for (const m of String(scan.stderr).matchAll(
    /freeze_(start|end): ([\d.]+)/g,
  )) {
    if (m[1] === "start") freezes.push({ start: Number(m[2]) });
    else if (freezes.length) {
      const f = freezes.at(-1);
      f.end = Number(m[2]);
      f.seconds = +(f.end - f.start).toFixed(4);
    }
  }
  let narration = null;
  if (expected.narration === true && !narrationStem)
    errors.push("required narration is missing (music is not voiceover)");
  if (narrationStem)
    try {
      narration = verifyNarration(file, narrationStem, narrationTracks);
      if (!narration.ok)
        errors.push(
          "narration is missing, silent, mistimed or drowned in the delivered mix",
        );
    } catch (e) {
      errors.push(`narration verification failed: ${e.message}`);
    }
  for (const f of freezes)
    if (f.end === undefined) {
      f.end = meta.seconds;
      f.seconds = +(f.end - f.start).toFixed(4);
    }
  if (scan.error || scan.status !== 0)
    errors.push("black/freeze analysis failed");
  if (black.length)
    warnings.push(
      `${black.length} dark interval(s): review whether these are intended`,
    );
  if (freezes.length)
    warnings.push(
      `${freezes.length} still interval(s) over 0.8s: review reading holds and dead time`,
    );
  const times = reviewTimes(meta.seconds, meta.fps, shots),
    frames = [];
  for (const [i, t] of times.entries()) {
    const frame = path.join(outDir, `frame-${String(i).padStart(3, "0")}.png`);
    run("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-ss",
      String(t),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      "scale=480:-2",
      frame,
    ]);
    frames.push({ at: t, file: frame });
  }
  const sheet = path.join(outDir, "contact.png"),
    cols = meta.height > meta.width ? 5 : 4;
  // Input PNGs are numbered contiguously; no quoting-sensitive concat file.
  run("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-framerate",
    "1",
    "-i",
    path.join(outDir, "frame-%03d.png"),
    "-vf",
    `scale=320:-2,tile=${cols}x${Math.ceil(frames.length / cols)}`,
    "-frames:v",
    "1",
    sheet,
  ]);
  const sections = [];
  if (meta.audio)
    for (const [i, s] of shots.entries()) {
      const start = Math.max(0, s.start),
        end = Math.min(meta.seconds, s.end);
      if (end <= start) continue;
      const r = spawnSync(
        "ffmpeg",
        [
          "-hide_banner",
          "-nostats",
          "-ss",
          String(start),
          "-i",
          file,
          "-t",
          String(end - start),
          "-af",
          "astats=metadata=0:reset=0",
          "-vn",
          "-f",
          "null",
          "-",
        ],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );
      const all = [...String(r.stderr).matchAll(/RMS level dB: ([-\d.inf]+)/g)],
        value = all.at(-1)?.[1];
      if (r.error || r.status !== 0)
        errors.push(`section audio measurement failed at ${start}s`);
      sections.push({
        id: s.id ?? `shot-${i}`,
        start,
        end,
        rms_dbfs: Number.isFinite(Number(value)) ? Number(value) : null,
      });
    }
  progress("motion_analysis", "start");
  let motion = null;
  try {
    const measured = measureMotion(file, { cuts: motionCheck.cuts ?? [], shots });
    const graded = gradeMotion(measured, motionCheck);
    motion = {
      level: graded.level,
      gate: Boolean(motionCheck.gate),
      allowed: {
        static: motionCheck.allowStatic ?? null,
        blue_purple: motionCheck.allowBluePurple ?? null,
      },
      lights: graded.rows,
      ...measured,
    };
    const red = graded.rows.filter((r) => r.level === "red");
    const explain = {
      fast_ratio: `almost no fast movement inside shots (fast_ratio ${measured.fast_ratio}): a slideshow, not a film. Move on events — hold, then a 0.17–0.3 s push, pan or slam, then hold — or pass --allow-static "reason"`,
      blank_run_s: `mid-film frames with no edges at all (${measured.blank_runs.map((r) => `${r.start}–${r.end}s`).join(", ")}): keep the subject in frame`,
      flashes_per_s: `${measured.flashes_per_s} flashes in one second (${measured.flash_windows.slice(0, 4).map((r) => `${r.start}–${r.end}s`).join(", ") || `from ${measured.flashes_at}s`}): over the WCAG 2.3.1 limit of three, a seizure risk for photosensitive viewers. Slow the strobe, shrink the flashing area below a quarter of the frame, or lower its brightness swing`,
      blue_purple_share: `blue-purple frames cover ${Math.round(measured.blue_purple_share * 100)}% of the film (${measured.blue_purple_spans.slice(0, 4).map((r) => `${r.start}–${r.end}s`).join(", ")}): the generic AI look. Change the palette, or record why the subject needs it with look.allowBluePurple / --allow-blue-purple "reason"`,
    };
    for (const r of red)
      (motionCheck.gate ? errors : warnings).push(`motion: ${explain[r.metric]}`);
    for (const r of graded.rows.filter((r) => r.level === "yellow"))
      warnings.push(
        `motion: ${r.metric} ${r.value} is in the review zone${r.note ? ` (${r.note})` : ""}`,
      );
    // Structural likeness to the starter or a bundled example: a signal, never a gate.
    if (fs.existsSync(DEMOS)) {
      const similar = demoSimilarity(file, JSON.parse(fs.readFileSync(DEMOS, "utf8")));
      motion.demo_similarity = similar;
      if (similar.share >= 0.3)
        warnings.push(
          `motion: ${Math.round(similar.share * 100)}% of frames are laid out like the bundled ${similar.closest} demo; redesign the composition for this subject instead of re-skinning the demo`,
        );
    }
  } catch (e) {
    warnings.push(`motion measurement failed: ${e.message}`);
  }
  let loopSeam = null;
  if (loop)
    try {
      loopSeam = measureLoopSeam(file, meta);
      if (!loopSeam.ok)
        warnings.push(
          `loop: the last frame does not lead into the first (seam ${loopSeam.seam_diff} vs a normal frame step ${loopSeam.step_diff} on 0-255 gray); make draw(duration) equal draw(0), cursor position and speed included`,
        );
    } catch (e) {
      warnings.push(`loop measurement failed: ${e.message}`);
    }
  const report = {
    version: 1,
    ok: errors.length === 0,
    file,
    observed: meta,
    expected,
    audio: sound,
    narration,
    section_audio: sections,
    errors,
    warnings,
    black_intervals: black,
    still_intervals: freezes,
    motion,
    loop: loopSeam,
    frames,
    sheet,
    visual_review: "pending",
    limitations: [
      "Measurements and sampled frames do not judge design quality, narrative coherence, subtitle readability or listening quality.",
      "Black and still intervals are review signals, not automatic aesthetic failures.",
      "Motion lights detect slideshow pacing, empty frames, blue-purple palettes and full-frame flashing; they cannot see page frames, collage styles or an unclear story.",
    ],
  };
  const reportFile = path.join(outDir, "report.json");
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
  progress("motion_analysis", "finish");
  return { ...report, report: reportFile };
}

// Mean gray difference between frames, 160 px wide.
function grayFrames(file, args) {
  const r = spawnSync("ffmpeg", ["-v", "error", ...args.pre, "-i", file, ...args.post, "-vf", "scale=160:90,format=gray", "-f", "rawvideo", "-"], { maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(String(r.stderr || r.error?.message).slice(-400));
  const n = 160 * 90, out = [];
  for (let i = 0; i + n <= r.stdout.length; i += n) out.push(r.stdout.subarray(i, i + n));
  return out;
}
const grayDiff = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
};

/** Compare the last frame with the first, against how much the film moves per frame near the seam. */
export function measureLoopSeam(file, meta = probeVideo(file)) {
  const [first, second] = grayFrames(file, { pre: [], post: ["-frames:v", "2"] });
  const tail = grayFrames(file, { pre: ["-sseof", String(-Math.min(1, meta.seconds / 2))], post: [] });
  const last = tail.at(-1), before = tail.at(-2);
  if (!first || !last) throw new Error("could not read the first and last frames");
  const seam = grayDiff(last, first);
  const step = Math.max(grayDiff(first, second ?? first), before ? grayDiff(before, last) : 0);
  return {
    seam_diff: Math.round(seam * 100) / 100,
    step_diff: Math.round(step * 100) / 100,
    // A seamless loop jumps no further across the seam than one ordinary frame step (plus codec noise).
    ok: seam <= Math.max(1.5, step * 1.5 + 0.5),
  };
}
