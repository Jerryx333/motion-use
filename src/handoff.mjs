// Portable editing inputs, not a release master or a native editor project.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { checkFilm, filmCaptions, filmWords, resolveProject } from "./film.mjs";
import { filmInputs } from "./snapshot.mjs";
import { freshDirectory } from "./catalog.mjs";
import { toSrt } from "./timing.mjs";
import { writeMusic } from "./music.mjs";

function sha(file) {
  const h = crypto.createHash("sha256"),
    buffer = Buffer.alloc(1024 * 1024),
    fd = fs.openSync(file, "r");
  try {
    let n;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)))
      h.update(buffer.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}
const within = (base, file) => {
  const rel = path.relative(base, file);
  return (
    rel &&
    rel !== ".." &&
    !rel.startsWith(".." + path.sep) &&
    !path.isAbsolute(rel)
  );
};
const slash = (s) => s.split(path.sep).join("/");

export function checkHandoff(dir) {
  const base = fs.realpathSync(dir);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(base, "handoff-manifest.json"), "utf8"),
  );
  if (
    manifest.schema !== "motion-use-handoff/v1" ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length
  )
    throw new Error("Not a motion-use handoff manifest");
  const errors = [];
  for (const entry of manifest.files) {
    if (
      typeof entry.path !== "string" ||
      path.isAbsolute(entry.path) ||
      entry.path.includes("\\")
    ) {
      errors.push("Invalid manifest path");
      continue;
    }
    const file = path.resolve(base, entry.path);
    if (
      !within(base, file) ||
      !fs.existsSync(file) ||
      !fs.statSync(file).isFile() ||
      !within(base, fs.realpathSync(file))
    ) {
      errors.push(`${entry.path}: missing or outside handoff`);
      continue;
    }
    if (sha(file) !== entry.sha256)
      errors.push(`${entry.path}: changed since export`);
  }
  return {
    ok: errors.length === 0,
    errors,
    files: manifest.files.length,
    scope:
      "Exported bytes only; does not verify permission, editing-app compatibility or current source state.",
  };
}

export function exportHandoff(input, options = {}) {
  const file = resolveProject(input);
  const checked = checkFilm(file, { requireNarration: true });
  if (!checked.ok)
    throw new Error(
      checked.report.errors.map((e) => `${e.path}: ${e.message}`).join("\n"),
    );
  const { film } = checked;
  // Resolve everything before making output; no code is executed and no network call is made.
  const inputs = filmInputs(film, file),
    copied = new Map(),
    files = [];
  const out = freshDirectory(
    options.out ?? path.join(checked.dir, "out", "handoff"),
  );
  fs.mkdirSync(out);
  const write = (rel, content, role) => {
    const dst = path.join(out, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, content);
    files.push({
      path: slash(rel),
      role,
      sha256: sha(dst),
      bytes: fs.statSync(dst).size,
    });
  };
  const provenance = [];
  for (const item of inputs) {
    const local = within(film.dir, item.file),
      rel = local ? path.relative(film.dir, item.file) : null;
    const target = local
      ? path.join("project", rel)
      : path.join(
          "media",
          `${sha(item.file).slice(0, 16)}-${path.basename(item.file)}`,
        );
    const dst = path.join(out, target);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(item.file, dst);
    copied.set(item.file, slash(target));
    const hash = sha(dst);
    files.push({
      path: slash(target),
      role: item.role,
      sha256: hash,
      bytes: fs.statSync(dst).size,
    });
    if (
      !["film", "composition", "engine", "voiceover-manifest"].includes(
        item.role,
      )
    ) {
      const declared = rel ? film.provenance?.[slash(rel)] : null;
      provenance.push({
        path: slash(target),
        sha256: hash,
        sourceUrl: declared?.sourceUrl ?? null,
        license: declared?.license ?? null,
        useBasis: declared?.useBasis ?? null,
        status:
          declared?.license && declared?.useBasis
            ? "declared-not-legally-verified"
            : "needs-review",
      });
    }
  }
  let music = null;
  if (film.music && film.music !== "none") {
    let source = copied.get(film.musicFile);
    if (film.music === "builtin" || film.music.builtin) {
      source = "media/builtin-music.wav";
      const target = path.join(out, source);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeMusic(target, film.music.builtin ?? "promo", film.duration, {
        bpm: film.bpm,
        hits: film.music.hits ?? [],
      });
      files.push({
        path: source,
        role: "music",
        sha256: sha(target),
        bytes: fs.statSync(target).size,
      });
      provenance.push({
        path: source,
        sha256: sha(target),
        status: "generated",
        sourceUrl: null,
        license: "See motion-use ASSETS.md",
        useBasis: "Built-in procedural score",
      });
    }
    music = { source, settings: film.music, bpm: film.bpm };
  }
  const captions = {};
  for (const lang of film.languages) {
    captions[lang] = filmCaptions(
      film,
      lang,
      film.tracks.filter(
        (a) => a.role === "voiceover" && (!a.lang || a.lang === lang),
      ),
    );
    write(`subtitles/${lang}.srt`, toSrt(captions[lang]), "subtitles");
  }
  const timeline = {
    schema: "motion-use-edit-timeline/v1",
    name: film.name,
    fps: film.fps,
    duration: film.duration,
    timebase:
      "seconds; start/end are authoritative; frame boundaries round each absolute endpoint separately",
    audioMix:
      "Source clips and resolved placement. Renderer ducking and final loudness normalization are not baked.",
    shots: film.shots.map((s) => ({
      ...s,
      fromFrame: Math.round(s.start * film.fps),
      toFrame: Math.round(s.end * film.fps),
    })),
    captions,
    cues: film.cues ?? {},
    words: Object.fromEntries(
      film.languages.map((lang) => [
        lang,
        filmWords(
          film,
          lang,
          film.tracks.filter(
            (a) => a.role === "voiceover" && (!a.lang || a.lang === lang),
          ),
        ),
      ]),
    ),
    music,
    audio: film.tracks.map(({ file: source, ...track }) => ({
      ...track,
      file: copied.get(source),
    })),
    videos: Object.fromEntries(
      Object.entries(film.videos ?? {}).map(([k, { file: source, ...v }]) => [
        k,
        { ...v, file: copied.get(source), ...(v.sequence ? {sequence:v.sequence.map((f)=>copied.get(f))}: {}) },
      ]),
    ),
  };
  write("timeline.json", JSON.stringify(timeline, null, 2) + "\n", "timeline");
  write(
    "sources.json",
    JSON.stringify(provenance, null, 2) + "\n",
    "provenance",
  );
  write(
    "README.md",
    `# ${film.name} — editing handoff\n\nThis is an editing-input package, not a release master or a native 剪映/CapCut draft.\n\n- timeline.json: shot boundaries, source audio placement, subtitle cues and keyword timing. Frame ranges are half-open.\n- subtitles/: editable SRT per language. Estimated cue flags remain in timeline.json. Empty SRT means no subtitle source was available.\n- project/: explicitly declared source files only; unrelated project files are excluded. External engine dependencies and private configuration are not automatically bundled.\n- media/: bundled inputs and any generated background score. Audio remains separate and is not the final normalized mix.\n- sources.json: source declarations plus byte hashes. A declaration is not a legal determination; needs-review entries require checking.\n\nFor an editable picture, render the same film with --no-captions; add --no-bgm for a version retaining narration and SFX. These switches suppress M.captions and background music, not custom text drawn by the composition or text baked into footage. Import that picture, the SRT and source audio into your editor; preserve the source time ranges in timeline.json. Do not add source tracks on top of an already mixed picture audio track.\n\nCode-drawn motion stays baked into the rendered picture. Editing its internal animation requires the source code. Render variants have distinct filenames. Re-render variants after any timeline change.\n\nCheck exported bytes: motion-use handoff . --check --out <this-directory>\n\nSharing this package also shares its declared inputs; review their distribution terms before sharing.\n`,
    "instructions",
  );
  // Keep bundled-input licence information alongside the files it describes.
  const assetsFile = new URL("../ASSETS.md", import.meta.url);
  write("MOTION-USE-ASSETS.md", fs.readFileSync(assetsFile), "licenses");
  const manifest = {
    schema: "motion-use-handoff/v1",
    film: film.name,
    created: new Date().toISOString(),
    files,
  };
  fs.writeFileSync(
    path.join(out, "handoff-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return {
    ok: true,
    out,
    manifest: path.join(out, "handoff-manifest.json"),
    files: files.length,
    provenanceNeedsReview: provenance.filter((x) => x.status === "needs-review")
      .length,
    estimatedCaptions: Object.values(captions)
      .flat()
      .filter((c) => c.estimated).length,
    warnings: checked.report.warnings,
  };
}
