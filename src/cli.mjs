import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  BriefError,
  FORMATS,
  STYLES,
  collectText,
  customText,
  readBrief,
  validateBrief,
} from "./brief.mjs";
import {
  FADE,
  audioSeconds,
  buildProject,
  claimDir,
  mediaInfo,
  plan,
} from "./build.mjs";
import { missingGlyphs } from "./fonts.mjs";
import { hyperframesBin, runHyperframes } from "./hf.mjs";
import { maybeNotify, upgrade } from "./update.mjs";
import {
  edgeAvailable,
  edgeGenerated,
  generateVoiceover,
  pickEngine,
} from "./voiceover.mjs";
import {
  buildFilm,
  checkFilm,
  initFilm,
  isFilm,
  resolveProject,
} from "./film.mjs";
import { normalizeAudio, verifyVideo, buildNarrationStem } from "./verify.mjs";
import { generateFilmNarration } from "./film-voiceover.mjs";
import { breakdownVideo } from "./breakdown.mjs";
import { fetchReference } from "./reference.mjs";
import { analyzeBeats, decodeMono } from "./beats.mjs";
import { compareVideos } from "./compare.mjs";
import { measureMotion, gradeMotion } from "./motion-check.mjs";
import { checkNarration, describeNarration, narrationItems } from "./narration-check.mjs";
import { probeText, describeText } from "./text-probe.mjs";
import { createSnapshot, findSnapshot, restoreSnapshot } from "./snapshot.mjs";
import { X_LIMIT, checkAgainstManifest, encodeMaster, encodeUnder, releaseEntry, writeReleaseManifest } from "./release.mjs";
import { compositeStill, compositeVideo, frameName, frameRange, runEngine, splitFrames } from "./engine.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
).version;

const HELP = `motion-use ${VERSION} — directed films, exact-time animation, local delivery

Usage: motion-use <command> [options]

  init [dir]          Start a directed film (film.json + composition/draw.js + DIRECTOR.md); fill the brief
                      fields up front: --subject --purpose --audience --tone --palette --length (seconds)
                      --mode template keeps the scene-template workflow; --style/--story also select it
  validate [brief]    Check a brief: fields, files, voiceover lengths, characters the fonts cannot draw
  voiceover [brief]   Speak each scene's "narration" into voiceover/<lang>/<scene-id>.mp3 (--engine azure|edge)
  voiceover check     Transcribe every narration clip (whisper via uv) and compare it with its script:
                      catches misread acronyms ("AI" as "A-A-I") and polyphones (重试 heard as 重视)
  still [brief]       Render keyframes as PNGs plus a contact sheet (--at 1.5,4 for exact seconds, --shot id,
                      --beats 1 one frame per beat (4: per bar), --guides tints what platform UI covers in portrait feeds,
                      --onion 1.2-2 stacks 8 evenly spaced frames of that range into one PNG to judge spacing)
  render [brief]      Render MP4s for every language and format in the brief
                      (--from 6 --to 10: a quick silent preview of that range of a film)
                      --release: high quality, then platform masters + release-manifest.json in out/release/
                      --snapshot <id|manifest>: render exactly the inputs an earlier render used
  verify <mp4>       Decode and measure a delivered video: frames, audio, motion lights (--gate fails on red,
                      --loop checks the last frame leads into the first, --manifest <json> proves the file
                      is the current release master)
  breakdown <video>   Take a reference video apart: cuts, beat grid, contact sheets, transition strips,
                      motion heatmaps, palette and motion lights (--out <dir>)
  reference <url>     Study a published piece (a prompt-motion.com entry, or any page with a VideoObject):
                      credits, prompt or skill, video and its breakdown in references/<slug>/ (git-ignored;
                      the prompt belongs to its creator: paraphrase, never paste) (--no-video, --out <dir>)
  beats <audio>      Find a song's tempo, first downbeat, bar loudness and drop; prints the film.json
                      music line that puts film second 0 on a downbeat (--from/--to: analyse a range)
  compare <a> <b>     Put frames of two videos side by side (--times 1.5,4 --out compare.png)
  doctor              Check Node, ffmpeg, Chrome and the bundled engine (--install-browser fetches Chrome)
  upgrade             Update motion-use and its skill (--check only looks)

Options for still/render:
  --lang zh,en        Only these languages (default: all in the brief)
  --format vertical   Only these formats (default: all in the brief)
  --out <dir>         Output directory (default: <brief dir>/out)
  --quality <q>       render only: draft | standard | high (default: standard)
  --max-size <size>   render only: re-encode any MP4 above this size (e.g. 9MB) until it fits
  --target github     render only: same as --max-size 9.5MB (GitHub's inline video limit is 10 MB)
  --force             Overwrite output files motion-use did not write
  --allow-custom-html Render "html" scenes (custom code; only for briefs you trust)
  --allow-code       Render authored film code (only projects you wrote or trust)
  --no-normalize     Keep original audio levels (default: two-pass -14 LUFS / -1 dBTP)
  --gate              render: fail on a flagged narration line or text running off the frame
                      (reading-time and contrast notes stay warnings)
  --no-asr            render: skip the narration transcription check (--asr-model small|medium|large-v3)
  --no-text-check     still/render: skip measuring drawn text against the frame and safe area
  --allow-static "why"       Deliver a film that the motion check reads as a slideshow, recording why
  --allow-blue-purple "why"  Deliver a blue-purple film (e.g. a Starry Night study), recording why
  --gpu               Render on the GPU: faster, but frames may differ by invisible noise between runs
                      (default: software rendering, bit-identical output for the same brief)
  --workers <n>       still/render: processes an external engine ("engine": {"type": "command"}) runs at
                      once, each on its own contiguous frame range (default 1); also passed to the browser renderer
  --json              Machine-readable result on stdout (compact; --verbose adds every measurement)

project defaults to ./film.json, otherwise ./brief.json. Docs: references/film.md`;

const fail = (msg, json) => {
  if (json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  else console.error(`motion-use: ${msg}`);
  return 1;
};

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h")
    return (console.log(HELP), 0);
  if (cmd === "--version" || cmd === "-v" || cmd === "version")
    return (console.log(VERSION), 0);
  const commands = {
    init,
    validate,
    voiceover,
    still,
    render,
    verify,
    breakdown,
    reference,
    beats,
    compare,
    doctor,
    upgrade: upgradeCmd,
  };
  if (!Object.hasOwn(commands, cmd))
    return fail(`unknown command "${cmd}". Run motion-use --help`);
  let args;
  try {
    args = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        style: { type: "string" },
        mode: { type: "string" },
        story: { type: "string" },
        name: { type: "string" },
        subject: { type: "string" },
        purpose: { type: "string" },
        audience: { type: "string" },
        tone: { type: "string" },
        palette: { type: "string" },
        length: { type: "string" },
        lang: { type: "string" },
        format: { type: "string" },
        out: { type: "string" },
        at: { type: "string" },
        quality: { type: "string" },
        engine: { type: "string" },
        "max-size": { type: "string" },
        target: { type: "string" },
        json: { type: "boolean" },
        check: { type: "boolean" },
        force: { type: "boolean" },
        "install-browser": { type: "boolean" },
        "allow-custom-html": { type: "boolean" },
        "allow-code": { type: "boolean" },
        "no-normalize": { type: "boolean" },
        "allow-static": { type: "string" },
        "allow-blue-purple": { type: "string" },
        gate: { type: "boolean" },
        verbose: { type: "boolean" },
        times: { type: "string" },
        shot: { type: "string" },
        guides: { type: "boolean" },
        from: { type: "string" },
        to: { type: "string" },
        gpu: { type: "boolean" },
        loop: { type: "boolean" },
        beats: { type: "string" },
        onion: { type: "string" },
        release: { type: "boolean" },
        snapshot: { type: "string" },
        manifest: { type: "string" },
        "asr-model": { type: "string" },
        "no-asr": { type: "boolean" },
        "no-text-check": { type: "boolean" },
        "no-video": { type: "boolean" },
        workers: { type: "string" },
      },
    });
  } catch (e) {
    return fail(e.message);
  }
  if (args.values.workers !== undefined && !/^([1-9]|[12][0-9]|3[0-2])$/.test(args.values.workers))
    return fail("--workers takes a whole number from 1 to 32", args.values.json);
  if (cmd !== "upgrade") await maybeNotify(VERSION);
  try {
    return await commands[cmd](args.values, args.positionals);
  } catch (e) {
    if (e instanceof BriefError) return fail(e.message, args.values.json);
    return fail(e.message, args.values.json);
  }
}

const list = (s) =>
  s
    ? s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : null;

const STORIES = [
  "problem-solution",
  "demo-first",
  "before-after",
  "walkthrough",
];

async function init(o, [dir = "."]) {
  if (o.mode && !["film", "template"].includes(o.mode))
    return fail("--mode must be film or template", o.json);
  if (o.mode === "film" || (!o.mode && !o.story && !o.style)) {
    if (o.story || o.style)
      return fail(
        "--story/--style select templates; omit them for a film",
        o.json,
      );
    const result = initFilm(o, dir);
    if (o.json) console.log(JSON.stringify(result, null, 2));
    else
      console.log(
        `wrote ${result.film}\nnext: edit DIRECTOR.md, film.json and composition/draw.js; motion-use still ${result.film} --allow-code`,
      );
    return 0;
  }
  if (o.story && !STORIES.includes(o.story))
    return fail(
      `--story must be one of: ${STORIES.join(", ")} (see references/stories.md)`,
      o.json,
    );
  if (o.style && !STYLES.includes(o.style))
    return fail(`--style must be one of: ${STYLES.join(", ")}`, o.json);
  const target = path.resolve(dir, "brief.json");
  if (fs.existsSync(target) && !o.force)
    return fail(`${target} already exists (use --force to overwrite)`, o.json);
  const tpl = o.story
    ? path.join(ROOT, "templates", "stories", `${o.story}.json`)
    : path.join(ROOT, "templates", `${o.style ?? "promo"}.json`);
  const brief = JSON.parse(fs.readFileSync(tpl, "utf8"));
  if (o.style) brief.style = o.style;
  const style = brief.style;
  if (o.name) brief.name = o.name;
  const langs = list(o.lang);
  if (langs) {
    brief.languages = langs;
    // Keep zh/en text where asked for; other languages start from the English text to translate.
    const fix = (v) => {
      if (Array.isArray(v)) return v.map(fix);
      if (v && typeof v === "object") {
        if (
          typeof v.en === "string" &&
          typeof v.zh === "string" &&
          Object.keys(v).length === 2
        )
          return Object.fromEntries(langs.map((l) => [l, v[l] ?? v.en]));
        return Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k, fix(x)]),
        );
      }
      return v;
    };
    brief.scenes = fix(brief.scenes);
  }
  const formats = list(o.format);
  if (formats) brief.formats = formats;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(brief, null, 2) + "\n");
  // Voiceover is optional; the folders show where recordings go.
  for (const l of brief.languages) {
    const d = path.join(path.dirname(target), "voiceover", l);
    fs.mkdirSync(d, { recursive: true });
    const note = path.join(d, "README.txt");
    if (!fs.existsSync(note))
      fs.writeFileSync(
        note,
        `Optional narration for language "${l}": one audio file per scene, named after the scene id\n(${brief.scenes.map((s) => s.id + ".mp3").join(", ")}). .wav and .m4a work too.\nA scene grows longer when its narration needs more time. Scenes without a file stay silent.\n`,
      );
  }
  const { errors } = validateBrief(brief, path.dirname(target));
  if (o.json)
    console.log(
      JSON.stringify(
        {
          ok: errors.length === 0,
          brief: target,
          style,
          story: o.story ?? null,
          errors,
        },
        null,
        2,
      ),
    );
  else {
    console.log(
      `wrote ${target} (${o.story ? `${o.story} story, ` : ""}${style})`,
    );
    if (errors.length)
      console.log(
        "fix these before rendering:\n" +
          errors.map((e) => `  ${e.path}: ${e.message}`).join("\n"),
      );
    const shown = path.relative(process.cwd(), target);
    console.log(
      `next: edit it, then motion-use validate ${shown.startsWith("..") ? target : shown} && motion-use still ${shown.startsWith("..") ? target : shown}`,
    );
  }
  return errors.length ? 1 : 0;
}

/** Load + validate + font coverage + voiceover probing. Returns { ok, brief, report }. */
function check(briefPath, o) {
  if (isFilm(briefPath)) return checkFilm(briefPath, o);
  briefPath = resolveProject(briefPath);
  const { data, dir, file } = readBrief(briefPath ?? "brief.json");
  const { brief, errors, warnings } = validateBrief(data, dir);
  const report = {
    brief: file,
    errors,
    warnings,
    missing_glyphs: [],
    media: [],
    timelines: [],
  };
  if (errors.length) return { ok: false, brief, dir, report };
  // Sizes of images and clips: highlight and zoom boxes are in these pixels.
  brief.scenes.forEach((s, i) => {
    const f = s.image ?? s.video;
    if (!f) return;
    try {
      const m = mediaInfo(f);
      report.media.push({
        scene: s.id,
        file: path.relative(dir, f),
        width: m.w,
        height: m.h,
        seconds: m.duration === null ? null : +m.duration.toFixed(2),
        audio: m.audio,
      });
    } catch (e) {
      errors.push({ path: `$.scenes[${i}]`, message: e.message });
    }
  });
  if (errors.length) return { ok: false, brief, dir, report };
  const missing = missingGlyphs(
    collectText(brief) + customText(brief),
    brief.fonts,
  );
  if (missing.length) {
    report.missing_glyphs = missing;
    warnings.push({
      path: "$.scenes",
      message: `the bundled fonts cannot draw ${missing.map((c) => `"${c}" U+${c.codePointAt(0).toString(16).toUpperCase()}`).join(", ")}; they will use a system font or show as boxes`,
    });
  }
  const langs = list(o.lang) ?? brief.languages;
  const formats = list(o.format) ?? brief.formats;
  for (const l of langs)
    if (!brief.languages.includes(l))
      errors.push({
        path: "--lang",
        message: `${l} is not in the brief's languages (${brief.languages.join(", ")})`,
      });
  for (const f of formats)
    if (!brief.formats.includes(f))
      errors.push({
        path: "--format",
        message: `${f} is not in the brief's formats (${brief.formats.join(", ")})`,
      });
  if (errors.length) return { ok: false, brief, dir, report };
  try {
    for (const l of langs)
      for (const f of formats) {
        const p = plan(brief, l, f, { probe: audioSeconds });
        report.timelines.push({
          lang: l,
          format: f,
          seconds: p.total,
          scenes: p.scenes.map((s) => ({
            id: s.id,
            start: +s.start.toFixed(2),
            seconds: +s.duration.toFixed(2),
            voiceover: s.vo ? +s.vo.seconds.toFixed(2) : null,
            stretched_for_voiceover: s.stretched,
          })),
        });
        for (const s of p.scenes)
          if (
            s.raised &&
            !warnings.some((w) => w.path.endsWith(`${s.id}.duration`))
          )
            warnings.push({
              path: `$.scenes.${s.id}.duration`,
              message: `too short for its animation; using ${s.raised}s instead`,
            });
      }
  } catch (e) {
    errors.push({
      path: e.message.startsWith("$.")
        ? e.message.split(":")[0]
        : "media/voiceover",
      message: e.message.startsWith("$.")
        ? e.message.slice(e.message.indexOf(":") + 2)
        : e.message,
    });
  }
  return { ok: errors.length === 0, brief, dir, report, langs, formats };
}

function printReport(r) {
  for (const e of r.errors) console.error(`error   ${e.path}: ${e.message}`);
  for (const w of r.warnings) console.error(`warning ${w.path}: ${w.message}`);
  for (const m of r.media ?? [])
    console.log(
      `media ${m.scene}: ${m.file} ${m.width}×${m.height}${m.seconds !== null ? `, ${m.seconds}s${m.audio ? ", has sound" : ""}` : ""}`,
    );
  for (const t of r.timelines)
    console.log(
      `${t.lang} ${t.format}: ${t.seconds.toFixed(1)}s, ${t.scenes.length} scenes${
        t.scenes.some((s) => s.stretched_for_voiceover)
          ? ` (stretched for voiceover: ${t.scenes
              .filter((s) => s.stretched_for_voiceover)
              .map((s) => s.id)
              .join(", ")})`
          : ""
      }`,
    );
}

async function validate(o, [briefPath]) {
  const { ok, report } = check(briefPath, o);
  if (o.json) console.log(JSON.stringify({ ok, ...report }, null, 2));
  else {
    printReport(report);
    console.log(ok ? "brief OK" : `${report.errors.length} error(s)`);
  }
  return ok ? 0 : 1;
}

async function each(briefPath, o, fn) {
  const c = check(briefPath, o);
  if (!c.ok) {
    if (o.json)
      console.log(JSON.stringify({ ok: false, ...c.report }, null, 2));
    else
      (printReport(c.report),
        console.error(
          `motion-use: ${c.report.errors.length} error(s); nothing rendered`,
        ));
    return { code: 1 };
  }
  if (!o.json)
    for (const w of c.report.warnings)
      console.error(`warning ${w.path}: ${w.message}`);
  if (c.film && !o["allow-code"]) {
    const message =
      "this film executes authored drawing code; pass --allow-code only for a project you wrote or trust";
    if (o.json)
      console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    else console.error(`motion-use: ${message}`);
    return { code: 1 };
  }
  const custom = (c.brief.scenes ?? []).filter((s) => s.type === "html");
  if (custom.length && !o["allow-custom-html"]) {
    const msg = `this brief has ${custom.length} custom HTML scene(s) (${custom.map((s) => s.id).join(", ")}). They run as code in the renderer: pass --allow-custom-html only for a brief you wrote or trust`;
    if (o.json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    else console.error(`motion-use: ${msg}`);
    return { code: 1 };
  }
  const out = path.resolve(o.out ?? path.join(c.dir, "out"));
  // Outputs go into subfolders motion-use owns; the brief's own folder is never an output folder.
  const rel = path.relative(out, c.dir);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    const msg = `--out ${out} contains the brief; choose a separate folder (default: ${path.join(c.dir, "out")})`;
    if (o.json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    else console.error(`motion-use: ${msg}`);
    return { code: 1 };
  }
  const results = [];
  for (const l of c.langs)
    for (const f of c.formats) {
      const id = `${c.brief.name}-${l}-${f}`;
      const proj = c.film
        ? await buildFilm(c.film, l, f, path.join(out, ".build", id), { range: o.range, guides: Boolean(o.guides) && !o._render })
        : await buildProject(c.brief, l, f, path.join(out, ".build", id));
      if (!c.film) {
        proj.narrationTracks = proj.scenes
          .filter((s) => s.vo)
          .map((s) => ({
            id: s.id,
            lang: l,
            file: s.vo.file,
            start: s.vo.at,
            offset: 0,
            length: s.vo.seconds,
            volume: c.brief.voiceover?.volume ?? 1,
          }));
        proj.narrationRequired = c.brief.voiceover?.required ?? false;
        proj.narrationStem = proj.narrationTracks.length
          ? path.join(proj.dir, "assets", "audio", "narration-stem.wav")
          : null;
        if (proj.narrationStem)
          buildNarrationStem(
            proj.narrationTracks,
            proj.total,
            proj.narrationStem,
          );
      }
      results.push(await fn(proj, id, out, c.brief));
    }
  return {
    code: results.every((r) => r.ok) ? 0 : 1,
    results,
    warnings: c.report.warnings,
  };
}

// Final files (MP4s, contact sheets) are tracked in <out>/.motion-use-outputs.json with
// their hash. An existing file motion-use did not write, or that changed since, is never
// overwritten without --force.
const MANIFEST = ".motion-use-outputs.json";
const sha = (f) =>
  crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const readManifest = (out) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(out, MANIFEST), "utf8"));
  } catch {
    return {};
  }
};
function guardOutput(out, file, force) {
  if (!fs.existsSync(file) || force) return null;
  const rec = readManifest(out)[path.relative(out, file)];
  if (rec && rec === sha(file)) return null;
  return `${file} already exists and ${rec ? "was changed since motion-use wrote it" : "was not written by motion-use"}; move it away or pass --force`;
}
/** Move a freshly written temp file into place and record it. */
function commitOutput(out, tmp, file) {
  fs.renameSync(tmp, file);
  const m = readManifest(out);
  m[path.relative(out, file)] = sha(file);
  fs.writeFileSync(path.join(out, MANIFEST), JSON.stringify(m, null, 2) + "\n");
}

async function render(o, [briefPath]) {
  o._render = true; // --guides is a review overlay for stills; it never reaches a delivered MP4
  if (o.snapshot) {
    // Re-render exactly what an earlier render used, even after narration or film changed.
    if (!isFilm(briefPath)) return fail("--snapshot re-renders an authored film", o.json);
    const projFile = resolveProject(briefPath),
      out = path.resolve(o.out ?? path.join(path.dirname(projFile), "out"));
    let restored, found;
    try {
      found = findSnapshot(o.snapshot, out);
      restored = restoreSnapshot(found);
    } catch (e) {
      return fail(e.message, o.json);
    }
    if (!o.json)
      console.error(`restored snapshot ${found.record.id} (${found.record.created}); output goes to ${path.join(out, `snapshot-${found.record.id}`)}`);
    return render({ ...o, snapshot: undefined, _snapshot: found.record.id, out: path.join(out, `snapshot-${found.record.id}`) }, [restored]);
  }
  if (o.release) {
    if (o["max-size"] || o.target)
      return fail("--release makes full-quality masters; drop --max-size/--target (render a small README copy separately)", o.json);
    if (o.quality && o.quality !== "high") return fail("--release always renders at --quality high", o.json);
    if (o.from !== undefined || o.to !== undefined) return fail("--release renders the whole film; drop --from/--to", o.json);
  }
  const QUALITY = { draft: "draft", standard: "looks", high: "delivery" };
  const q = o.release ? "high" : (o.quality ?? "standard");
  const quality = Object.hasOwn(QUALITY, q) ? QUALITY[q] : null;
  if (!quality)
    return fail("--quality must be draft, standard or high", o.json);
  const TARGETS = { github: "9.5MB" };
  if (o.target && !Object.hasOwn(TARGETS, o.target))
    return fail(
      `--target must be one of: ${Object.keys(TARGETS).join(", ")}`,
      o.json,
    );
  const maxBytes = parseSize(
    o["max-size"] ?? (o.target ? TARGETS[o.target] : null),
  );
  if (maxBytes === undefined)
    return fail("--max-size takes a size like 9MB, 9.5M or 9000000", o.json);
  if (o.from !== undefined || o.to !== undefined) {
    // A quick silent preview of part of a film: picture and timing only, no delivery checks.
    if (!isFilm(briefPath))
      return fail("--from/--to preview a range of an authored film", o.json);
    const duration = JSON.parse(fs.readFileSync(resolveProject(briefPath), "utf8")).duration;
    const from = Number(o.from ?? 0),
      to = Number(o.to ?? duration);
    if (!(from >= 0 && to > from && to <= duration && to - from >= 0.5))
      return fail(`--from/--to: 0 ≤ from < to ≤ ${duration}, at least 0.5 s apart`, o.json);
    o.range = { from, to };
  }
  if (isFilm(briefPath)) {
    if (o.engine && !["edge", "azure"].includes(o.engine))
      return fail("--engine must be azure or edge", o.json);
    if (!o["allow-code"])
      return fail(
        "this film executes authored drawing code; pass --allow-code only for a project you wrote or trust",
        o.json,
      );
    const c = checkFilm(briefPath, { ...o, skipGeneratedVoiceover: true });
    if (!c.ok) {
      if (o.json)
        console.log(JSON.stringify({ ok: false, ...c.report }, null, 2));
      else printReport(c.report);
      return 1;
    }
    const generated = o.range ? { rows: [] } : await generateFilmNarration(c.film, {
      langs: c.langs,
      engine: o.engine,
      log: o.json ? () => {} : (m) => console.error(m),
    });
    const failed = generated.rows.filter((r) => r.status === "error");
    if (failed.length)
      return fail(
        `narration generation failed: ${failed.map((r) => r.error).join("; ")}`,
        o.json,
      );
  } else {
    const { data, dir } = readBrief(resolveProject(briefPath));
    if (data.scenes?.some((s) => s?.type === "html") && !o["allow-custom-html"])
      return fail(
        "custom HTML requires --allow-custom-html before executing this project",
        o.json,
      );
    if (
      data.scenes?.some((s) => s?.narration) &&
      data.voiceover?.required !== false
    ) {
      if (typeof data.voiceover?.dir !== "string")
        return fail(
          "a narration script needs voiceover.dir; do not deliver music-only output",
          o.json,
        );
      const voiceDir = path.resolve(dir, data.voiceover.dir),
        relative = path.relative(dir, voiceDir);
      if (
        !relative ||
        relative === ".." ||
        relative.startsWith(".." + path.sep) ||
        path.isAbsolute(relative)
      )
        return fail(
          "automatic narration requires a voiceover directory inside the project; import external recordings by scene file instead",
          o.json,
        );
      let parent = voiceDir;
      while (!fs.existsSync(parent)) parent = path.dirname(parent);
      const resolved = path.relative(
        fs.realpathSync(dir),
        fs.realpathSync(parent),
      );
      if (
        resolved === ".." ||
        resolved.startsWith(".." + path.sep) ||
        path.isAbsolute(resolved)
      )
        return fail("voiceover directory symlink escapes the project", o.json);
      fs.mkdirSync(voiceDir, { recursive: true });
      const checked = validateBrief(data, dir);
      if (checked.errors.length) {
        if (o.json)
          console.log(
            JSON.stringify({ ok: false, errors: checked.errors }, null, 2),
          );
        else
          printReport({ errors: checked.errors, warnings: [], timelines: [] });
        return 1;
      }
      if (o.engine && !["azure", "edge"].includes(o.engine))
        return fail("--engine must be azure or edge", o.json);
      const generated = await generateVoiceover(checked.brief, {
        langs: list(o.lang) ?? checked.brief.languages,
        engine: o.engine,
        log: o.json ? () => {} : (m) => console.error(m),
      });
      const failed = generated.rows.filter((r) => r.status === "error");
      if (failed.length)
        return fail(
          `narration generation failed: ${failed.map((r) => r.error).join("; ")}`,
          o.json,
        );
    }
  }
  // Narration check: what speech recognition hears against each script line.
  let narrationCheck = null;
  if (!o.range && !o["no-asr"]) {
    narrationCheck = runNarrationCheck(briefPath, o);
    const quiet = narrationCheck.skipped && !narrationCheck.lines.length && narrationCheck.skipped.startsWith("no generated");
    if (!o.json && !quiet) for (const line of describeNarration(narrationCheck)) console.error(`warning: ${line}`);
    if (o.gate && !narrationCheck.skipped && !narrationCheck.ok)
      return fail(`narration check flagged ${narrationCheck.lines.filter((l) => l.flagged).length} line(s); listen to them and fix the script or the voice (--gate)`, o.json);
  }
  // Snapshot: the exact inputs of this render, so the cut can be rebuilt later.
  let snapshot = o._snapshot ?? null,
    filmFile = null;
  if (isFilm(briefPath) && !o.range) {
    filmFile = resolveProject(briefPath);
    if (!snapshot) {
      const c = checkFilm(briefPath, { ...o });
      const outDir = path.resolve(o.out ?? path.join(path.dirname(filmFile), "out"));
      try {
        snapshot = createSnapshot(c.film, filmFile, outDir, { version: VERSION }).id;
      } catch (e) {
        if (!o.json) console.error(`warning: snapshot not saved: ${e.message}`);
      }
    }
  }
  const r = await each(
    briefPath,
    { ...o, requireNarration: list(o.lang) ?? true },
    async (proj, id, out, brief) => {
      const edgeFiles = proj.film
        ? edgeGenerated(
            {
              voiceover: brief.narrationConfig,
              scenes: proj.narrationTracks.map((a) => ({
                voiceover: { [proj.lang]: a.file },
              })),
            },
            proj.lang,
          )
        : edgeGenerated(brief, proj.lang);
      if (edgeFiles.length && !o.json)
        console.error(
          `motion-use: ${id} uses ${edgeFiles.length} voiceover file(s) made with edge-tts: preview quality, and whether they may be published is not established. For a public video, regenerate with --engine azure.`,
        );
      if (proj.range) {
        const { from, to } = proj.range,
          previewFile = path.join(out, "preview", `${id}-${from}-${to}.mp4`),
          blockedPreview = guardOutput(out, previewFile, o.force);
        if (blockedPreview) return { ok: false, id, error: blockedPreview };
        const tmpPreview = path.join(proj.dir, "preview.mp4");
        if (!o.json) console.error(`previewing ${id} ${from}–${to}s (silent, no delivery checks)…`);
        const hf = brief.engine
          ? await engineRender(brief, proj, tmpPreview, { ...o, quality: "draft" })
          : await runHyperframes(
              ["render", proj.dir, "--output", tmpPreview, "--fps", String(proj.fps), "--quality", "draft", "--quiet", ...hfWorkers(o), o.gpu ? "--browser-gpu" : "--no-browser-gpu"],
              {},
            );
        if (hf.code !== 0 || !fs.existsSync(tmpPreview))
          return { ok: false, id, error: hf.out.trim().split("\n").slice(-15).join("\n") };
        fs.mkdirSync(path.dirname(previewFile), { recursive: true });
        commitOutput(out, tmpPreview, previewFile);
        let motion = null;
        try {
          const m = measureMotion(previewFile);
          motion = { level: gradeMotion(m).level, fast_ratio: m.fast_ratio, blank_run_s: m.blank_run_s, blue_purple_share: m.blue_purple_share };
        } catch {}
        if (!o.json) console.log(previewFile);
        return { ok: true, id, preview: true, file: previewFile, from, to, motion };
      }
      const file = path.join(
        out,
        `${id}${proj.film && proj.narrationTracks.length ? "-VO" : ""}.mp4`,
      );
      const blocked = guardOutput(out, file, o.force);
      if (blocked) return { ok: false, id, error: blocked };
      // Text check before capture: measured boxes of every drawn string against the frame.
      let textCheck = null;
      if (proj.film && !o["no-text-check"]) {
        // An engine's own text is pixels; only a composition overlay's strings can be measured.
        textCheck = brief.engine && !brief.source ? ENGINE_TEXT : await probeText(proj.dir, proj.total);
        if (!o.json) for (const line of describeText(textCheck)) console.error(`warning: ${id}: ${line}`);
        const off = textCheck.runs?.filter((x) => x.kind === "frame" || x.kind === "collision") ?? [];
        if (o.gate && off.length)
          return { ok: false, id, error: `text runs off the frame or over other text (--gate): ${describeText({ runs: off }).join("; ")}` };
      }
      const tmp = path.join(proj.dir, "render.mp4");
      fs.rmSync(tmp, { force: true });
      if (!o.json)
        console.error(`rendering ${id} (${proj.total.toFixed(1)}s)…`);
      const hf = brief.engine
        ? await engineRender(brief, proj, tmp, { ...o, quality, crf: o.release ? 10 : undefined })
        : await runHyperframes(
            [
              "render",
              proj.dir,
              "--output",
              tmp,
              "--fps",
              String(proj.fps),
              "--quality",
              quality,
              // A release renders near-lossless first; the platform masters are encoded from it.
              ...(o.release ? ["--crf", "10"] : []),
              "--quiet",
              ...hfWorkers(o),
              o.gpu ? "--browser-gpu" : "--no-browser-gpu",
            ].filter(Boolean),
            {},
          );
      const ok =
        hf.code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 0;
      if (!ok)
        return {
          ok,
          id,
          error: hf.out.trim().split("\n").slice(-15).join("\n"),
        };
      let normalization = { applied: false, reason: "disabled" };
      if (!o["no-normalize"]) {
        const norm = path.join(proj.dir, "normalized.mp4");
        normalization = normalizeAudio(tmp, norm);
        if (normalization.applied) fs.renameSync(norm, tmp);
      }
      let fitted = null;
      if (maxBytes && fs.statSync(tmp).size > maxBytes) {
        fitted = fitSize(tmp, maxBytes, proj.dir);
        if (!fitted.ok) return { ok: false, id, error: fitted.error };
      }
      const bytes = fs.statSync(tmp).size;
      const verification = verifyVideo(tmp, path.join(out, "review", id), {
        expected: {
          duration: proj.total,
          fps: proj.fps,
          width: proj.fmt.w,
          height: proj.fmt.h,
          audio: proj.film
            ? (brief.music !== "none" && brief.music !== undefined) ||
              brief.tracks.length > 0
            : undefined,
          narration: proj.narrationRequired,
        },
        shots: proj.scenes.map((s) => ({
          id: s.id,
          start: s.start,
          end: s.start + s.duration,
        })),
        narrationStem: proj.narrationStem,
        narrationTracks: proj.narrationTracks,
        loop: Boolean(proj.film && brief.loop),
        // Authored films are gated on slideshow pacing, empty frames and blue-purple palettes.
        motionCheck: {
          gate: Boolean(proj.film),
          cuts: proj.film
            ? brief.shots.filter((s) => s.cut).map((s) => s.start)
            : proj.scenes.slice(1).map((s) => s.start),
          allowStatic: o["allow-static"] ?? brief.look?.allowStatic ?? null,
          allowBluePurple:
            o["allow-blue-purple"] ?? brief.look?.allowBluePurple ?? null,
        },
      });
      if (!verification.ok)
        return {
          ok: false,
          id,
          error: verification.errors.join("; "),
          verification: { ok: false, report: verification.report },
        };
      commitOutput(out, tmp, file);
      verification.file = file;
      // Independent review: notes by someone who did not make the film, watching only the MP4.
      // Listed by name only; the report never vouches for what they say.
      const reviewDir = path.join(path.dirname(resolveProject(briefPath)), "reviews");
      verification.independent_reviews = fs.existsSync(reviewDir)
        ? fs.readdirSync(reviewDir).filter((f) => f.endsWith(".md") && f !== "banned.md").map((f) => path.join(reviewDir, f))
        : [];
      if (textCheck) {
        verification.text_check = textCheck;
        for (const line of describeText(textCheck)) verification.warnings.push(line);
      }
      if (narrationCheck) {
        verification.narration_check = narrationCheck.skipped
          ? { skipped: narrationCheck.skipped }
          : { ok: !narrationCheck.lines.some((l) => l.lang === proj.lang && l.flagged), model: narrationCheck.model, lines: narrationCheck.lines.filter((l) => l.lang === proj.lang) };
        for (const line of describeNarration({ lines: verification.narration_check.lines ?? [] })) verification.warnings.push(line);
      }
      verification.snapshot = snapshot;
      fs.writeFileSync(
        verification.report,
        JSON.stringify(verification, null, 2) + "\n",
      );
      if (!o.json && bytes > 10e6)
        console.error(
          `motion-use: ${path.basename(file)} is ${mb(bytes)}; GitHub plays videos inline only up to 10 MB (use --target github)`,
        );
      if (!o.json)
        console.log(
          `${file}  ${mb(bytes)}${fitted ? ` (re-encoded at CRF ${fitted.crf} to fit)` : ""}`,
        );
      // Frame 0 as a PNG: the cover to upload where a platform asks for one.
      const coverFile = path.join(out, `${id}-cover.png`);
      let cover = null;
      if (!guardOutput(out, coverFile, o.force)) {
        const tmpCover = path.join(proj.dir, "cover.png");
        try {
          execFileSync(
            "ffmpeg",
            ["-v", "error", "-y", "-i", file, "-frames:v", "1", tmpCover],
            { stdio: ["ignore", "ignore", "pipe"] },
          );
          commitOutput(out, tmpCover, coverFile);
          cover = coverFile;
        } catch (e) {
          console.error(
            `motion-use: cover image not created (${e.code === "ENOENT" ? "ffmpeg not found" : e.stderr?.toString().trim()})`,
          );
        }
      } else
        console.error(
          `motion-use: cover image skipped: ${guardOutput(out, coverFile, o.force)}`,
        );
      // Release: platform masters encoded from the near-lossless render, each hashed.
      let release = null;
      if (o.release) {
        try {
          release = makeRelease({ out, proj, id, file, cover, seconds: verification.observed.seconds, force: o.force, log: o.json ? () => {} : (m) => console.error(m) });
        } catch (e) {
          return { ok: false, id, file, error: `release masters: ${e.message}` };
        }
      }
      return {
        ok: verification.ok,
        id,
        file,
        cover,
        bytes,
        ...(release ? { release: release.map((e) => path.join(out, "release", e.file)) } : {}),
        _release: release,
        refit_crf: fitted?.crf ?? null,
        edge_voiceover: edgeFiles.length,
        seconds: verification.observed.seconds,
        lang: proj.lang,
        format: proj.format,
        normalization,
        verification: {
          ok: verification.ok,
          report: verification.report,
          sheet: verification.sheet,
          warnings: verification.warnings,
          errors: verification.errors,
          visual_review: verification.visual_review,
          // Compact by default: what an agent needs to decide its next step. The report file has the rest.
          narration:
            o.verbose || !verification.narration
              ? verification.narration
              : {
                  ok: verification.narration.ok,
                  segments: verification.narration.segments.length,
                  failed: verification.narration.segments.filter((x) => !x.ok),
                },
          motion: verification.motion && {
            level: verification.motion.level,
            ...Object.fromEntries(
              verification.motion.lights
                .filter((l) => o.verbose || l.level !== "green")
                .map((l) => [l.metric, l.value]),
            ),
            fast_ratio: verification.motion.fast_ratio,
            demo_similarity: verification.motion.demo_similarity?.share,
          },
          independent_reviews: verification.independent_reviews?.length ?? 0,
          narration_check: verification.narration_check && (verification.narration_check.skipped
            ? verification.narration_check
            : { ok: verification.narration_check.ok, flagged: verification.narration_check.lines.filter((l) => l.flagged).map((l) => ({ id: l.id, similarity: l.similarity, heard: l.heard, changes: l.changes.filter((c) => c.flag) })) }),
          text_check: textCheck && (textCheck.skipped ? textCheck : { runs: textCheck.runs }),
        },
        snapshot,
      };
    },
  );
  const entries = (r.results ?? []).flatMap((x) => x._release ?? []);
  for (const x of r.results ?? []) delete x._release;
  let releaseManifest = null;
  if (o.release && entries.length && r.code === 0) {
    const relDir = path.join(path.resolve(o.out ?? path.join(path.dirname(resolveProject(briefPath)), "out")), "release");
    releaseManifest = path.join(relDir, "release-manifest.json");
    writeReleaseManifest(relDir, {
      entries,
      snapshot,
      version: VERSION,
      film: filmFile ? { file: filmFile, sha256: sha(filmFile) } : null,
    });
    if (!o.json) console.log(releaseManifest);
  }
  if (o.json && r.results)
    console.log(
      JSON.stringify(
        { ok: r.code === 0, outputs: r.results, warnings: r.warnings, snapshot, ...(releaseManifest ? { release_manifest: releaseManifest } : {}) },
        null,
        2,
      ),
    );
  else
    for (const x of r.results ?? [])
      if (!x.ok)
        console.error(`motion-use: render failed for ${x.id}:\n${x.error}`);
  return r.code;
}

/**
 * out/release/<id>.mp4 (x264 veryslow CRF 16), <id>-x.mp4 when a landscape master is above
 * X's upload limit, and the cover; returns manifest entries.
 */
function makeRelease({ out, proj, id, file, cover, seconds, force, log }) {
  const relDir = path.join(out, "release");
  fs.mkdirSync(relDir, { recursive: true });
  const voiceover = proj.narrationTracks.map((t) => ({ id: t.id, sha256: sha(t.file) }));
  const meta = { lang: proj.lang, format: proj.format, voiceover };
  const entries = [];
  const put = (name, make, extra) => {
    const final = path.join(relDir, name),
      blocked = guardOutput(out, final, force);
    if (blocked) throw new Error(blocked);
    const tmp = path.join(proj.dir, `release-${name}`);
    make(tmp);
    commitOutput(out, tmp, final);
    entries.push(releaseEntry(relDir, name, { ...extra, ...meta }));
    return entries.at(-1);
  };
  log(`encoding release master ${id}.mp4 (x264 veryslow, CRF 16)…`);
  const master = put(`${id}.mp4`, (tmp) => encodeMaster(file, tmp), { kind: "master" });
  if (Math.abs(master.duration - seconds) > 0.1)
    throw new Error(`master is ${master.duration}s but the render is ${seconds}s`);
  if (proj.format === "landscape" && master.bytes > X_LIMIT) {
    log(`${id}.mp4 is ${mb(master.bytes)}; encoding ${id}-x.mp4 under ${mb(X_LIMIT)} for X…`);
    put(`${id}-x.mp4`, (tmp) => encodeUnder(file, tmp, X_LIMIT, seconds, proj.dir), { kind: "x", limit: X_LIMIT });
  }
  if (cover) put(`${id}-cover.png`, (tmp) => fs.copyFileSync(cover, tmp), { kind: "cover" });
  return entries;
}

const mb = (b) => `${(b / 1e6).toFixed(1)} MB`;
const hfWorkers = (o) => (o.workers ? ["--workers", o.workers] : []);

const ENGINE_TEXT = {
  skipped: "external engine",
  note: "text the engine draws is pixels the text check cannot measure; draw subtitles and labels in a composition overlay to have them checked",
};

/**
 * External engine render: its PNG frames for the film (or the --from/--to window), the browser
 * layer as a transparent MOV carrying the mix, composited into `file`. Returns { code, out }
 * like runHyperframes, so the delivery steps after it are the same for both engines.
 */
async function engineRender(film, proj, file, o) {
  const fps = proj.fps,
    work = `${proj.dir}-engine`,
    workers = Number(o.workers ?? 1);
  const range = proj.range ? frameRange(fps, proj.range.from, proj.range.to) : frameRange(fps, 0, proj.total);
  if (!o.json) console.error(`external engine: frames ${range.from}–${range.to} (${workers} worker${workers > 1 ? "s" : ""})…`);
  const r = await runEngine(film, proj, splitFrames(range, workers), { workers, work });
  if (!r.ok) return { code: 1, out: r.error };
  const layer = path.join(work, "layer.mov");
  const hf = await runHyperframes(
    ["render", proj.dir, "--output", layer, "--format", "mov", "--fps", String(fps), "--quiet", ...hfWorkers(o), o.gpu ? "--browser-gpu" : "--no-browser-gpu"],
    {},
  );
  if (hf.code !== 0 || !fs.existsSync(layer)) return { code: 1, out: `browser layer: ${hf.out}` };
  try {
    compositeVideo({ frames: r.frames, range, layer, fps, w: proj.fmt.w, h: proj.fmt.h, quality: o.quality, crf: o.crf, out: file });
  } catch (e) {
    return { code: 1, out: e.message };
  }
  return { code: 0, out: "" };
}

/**
 * Stills of an external-engine film: one engine job per requested frame (time t shows frame
 * floor(t * fps)), the overlay snapshot at that frame's time on top. Writes PNGs named like the
 * browser snapshots into `dir`.
 */
async function engineStills(film, proj, times, dir, o) {
  const fps = proj.fps,
    last = Math.round(proj.total * fps) - 1,
    work = `${proj.dir}-engine`,
    workers = Number(o.workers ?? 1);
  const ks = times.map((t) => Math.min(last, Math.floor(t * fps + 1e-6)));
  const unique = [...new Set(ks)].sort((a, b) => a - b);
  const r = await runEngine(film, proj, unique.map((k) => ({ from: k, to: k })), { workers, work });
  if (!r.ok) return { code: 1, out: r.error };
  let layers = null;
  if (film.source) {
    const layerDir = path.join(work, "layer");
    const hf = await runHyperframes(
      ["snapshot", proj.dir, "--at", ks.map((k) => (k / fps).toFixed(4)).join(","), "--no-end", "--output", layerDir, o.gpu ? "--browser-gpu" : "--no-browser-gpu"],
      {},
    );
    layers = fs.existsSync(layerDir)
      ? fs.readdirSync(layerDir).filter((f) => f.endsWith(".png")).sort((a, b) => a.localeCompare(b, "en", { numeric: true })).map((f) => path.join(layerDir, f))
      : [];
    if (hf.code !== 0 || layers.length !== ks.length) return { code: 1, out: `overlay snapshot: ${hf.out}` };
  }
  try {
    ks.forEach((k, i) =>
      compositeStill({ frame: path.join(r.frames, frameName(k)), layer: layers?.[i], w: proj.fmt.w, h: proj.fmt.h, out: path.join(dir, `frame-${String(i).padStart(2, "0")}-at-${+(k / fps).toFixed(3)}s.png`) }),
    );
  } catch (e) {
    return { code: 1, out: e.message };
  }
  return { code: 0, out: "" };
}

/** "9MB" / "9.5M" / "9000000" -> bytes (1 MB = 1,000,000 bytes). null when not given, undefined when invalid. */
export function parseSize(s) {
  if (s === null || s === undefined) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(k|kb|m|mb|g|gb)?$/i.exec(String(s).trim());
  if (!m) return undefined;
  const mult =
    { k: 1e3, kb: 1e3, m: 1e6, mb: 1e6, g: 1e9, gb: 1e9 }[
      (m[2] ?? "").toLowerCase()
    ] ?? 1;
  const n = Math.round(Number(m[1]) * mult);
  return n >= 100e3 ? n : undefined;
}

/**
 * Re-encode `file` in place with rising x264 CRF until it is at most `max` bytes.
 * Motion-use frames are mostly flat text and shapes, so this usually shrinks a file
 * severalfold with no visible change.
 */
function fitSize(file, max, workDir) {
  const tmp = path.join(workDir, "fit.mp4");
  for (const crf of [23, 26, 28, 30, 33, 36]) {
    try {
      execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-y",
          "-i",
          file,
          "-c:v",
          "libx264",
          "-preset",
          "slow",
          "-crf",
          String(crf),
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-b:a",
          "96k",
          "-movflags",
          "+faststart",
          tmp,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
    } catch (e) {
      return {
        ok: false,
        error: `re-encoding failed: ${e.code === "ENOENT" ? "ffmpeg not found" : e.stderr?.toString().trim()}`,
      };
    }
    if (fs.statSync(tmp).size <= max) {
      fs.renameSync(tmp, file);
      return { ok: true, crf };
    }
  }
  return {
    ok: false,
    error: `cannot get under ${mb(max)} even at CRF 36 (${mb(fs.statSync(tmp).size)}); shorten the video or raise --max-size`,
  };
}

async function voiceover(o, [briefPath, ...rest]) {
  if (briefPath === "check") return voiceoverCheck(o, rest);
  if (isFilm(briefPath)) {
    const c = checkFilm(briefPath, { ...o, skipGeneratedVoiceover: true });
    if (!c.ok) {
      if (o.json)
        console.log(JSON.stringify({ ok: false, ...c.report }, null, 2));
      else printReport(c.report);
      return 1;
    }
    if (o.engine && !["edge", "azure"].includes(o.engine))
      return fail("--engine must be azure or edge", o.json);
    const res = await generateFilmNarration(c.film, {
      langs: c.langs,
      engine: o.engine,
      force: o.force,
      log: o.json ? () => {} : (m) => console.error(m),
    });
    const post = checkFilm(briefPath, { ...o, requireNarration: c.langs });
    const ok = post.ok && !res.rows.some((r) => r.status === "error");
    if (o.json)
      console.log(
        JSON.stringify(
          {
            ok,
            engine: res.engine,
            files: res.rows,
            errors: post.report.errors,
          },
          null,
          2,
        ),
      );
    else {
      for (const row of res.rows)
        console.log(
          `${row.status}: ${row.lang}/${row.scene}${row.error ? ": " + row.error : ""}`,
        );
      if (!post.ok) printReport(post.report);
    }
    return ok ? 0 : 1;
  }
  // The folder may not exist yet on a first run: create it so validation passes.
  const { data, dir } = readBrief(briefPath ?? "brief.json");
  if (typeof data?.voiceover?.dir === "string")
    fs.mkdirSync(path.resolve(dir, data.voiceover.dir), { recursive: true });
  const { brief, errors, warnings } = validateBrief(data, dir);
  if (errors.length) {
    if (o.json)
      console.log(JSON.stringify({ ok: false, errors, warnings }, null, 2));
    else printReport({ errors, warnings, timelines: [] });
    return 1;
  }
  if (o.engine && !["azure", "edge"].includes(o.engine))
    return fail("--engine must be azure or edge", o.json);
  const langs = list(o.lang) ?? brief.languages;
  if (!brief.scenes.some((s) => s.narration))
    return fail(
      'no scene has "narration" text; add it to the scenes you want spoken',
      o.json,
    );
  const res = await generateVoiceover(brief, {
    langs,
    engine: o.engine,
    force: o.force,
    log: o.json ? () => {} : (m) => console.error(m),
  });
  const failed = res.rows.filter((r) => r.status === "error");
  if (o.json)
    console.log(
      JSON.stringify(
        { ok: failed.length === 0, engine: res.engine, files: res.rows },
        null,
        2,
      ),
    );
  else {
    for (const r of res.rows)
      console.log(
        `${r.status.padEnd(9)} ${path.relative(process.cwd(), r.file)}${r.reason ? `  (${r.reason})` : ""}${r.error ? `  ${r.error}` : ""}`,
      );
    if (res.engine === "edge")
      console.error(
        "note: edge-tts is preview quality and its audio is not cleared for publishing; for a public video use --engine azure (AZURE_SPEECH_KEY, AZURE_SPEECH_REGION).",
      );
  }
  return failed.length ? 1 : 0;
}

/** Narration clips of a project with their scripts, filtered to the languages asked for. */
function projectNarration(briefPath, o) {
  if (isFilm(briefPath)) {
    const c = checkFilm(briefPath, { ...o, skipGeneratedVoiceover: false });
    return { items: narrationItems(c.film).filter((it) => c.langs.includes(it.lang)), dir: c.film.narrationConfig?.dir };
  }
  const { data, dir } = readBrief(resolveProject(briefPath));
  const checked = validateBrief(data, dir);
  const langs = list(o.lang) ?? checked.brief.languages ?? [];
  return { items: narrationItems(checked.brief).filter((it) => langs.includes(it.lang)), dir: checked.brief.voiceover?.dir };
}

function runNarrationCheck(briefPath, o) {
  const { items, dir } = projectNarration(briefPath, o);
  return checkNarration(items, { dir, model: o["asr-model"], log: o.json ? () => {} : (m) => console.error(m) });
}

async function voiceoverCheck(o, [briefPath]) {
  const r = runNarrationCheck(briefPath, o);
  if (o.json) console.log(JSON.stringify(r, null, 2));
  else if (r.skipped) console.error(`motion-use: narration check skipped: ${r.skipped}`);
  else {
    for (const l of r.lines)
      console.log(`${l.flagged ? "check" : "ok   "} ${l.lang}/${l.id} ${Math.round(l.similarity * 100)}%  heard: ${l.heard}`);
    for (const line of describeNarration(r)) console.error(line);
  }
  return r.skipped ? 0 : r.ok ? 0 : 1;
}

async function still(o, [briefPath]) {
  const at = list(o.at)?.map(Number);
  if (at?.some((x) => !Number.isFinite(x) || x < 0))
    return fail("--at takes seconds, e.g. --at 1.5,4", o.json);
  const shotIds = list(o.shot);
  const everyBeats = o.beats === undefined ? null : Number(o.beats);
  if (everyBeats !== null && !(Number.isInteger(everyBeats) && everyBeats >= 1 && everyBeats <= 64))
    return fail("--beats takes a whole number of beats between frames: 1 every beat, 4 every bar", o.json);
  // --onion a-b[:n]: n evenly spaced frames of that range stacked into one picture.
  let onion = null;
  if (o.onion !== undefined) {
    const m = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)(?::(\d+))?$/.exec(o.onion);
    onion = m && { from: +m[1], to: +m[2], n: m[3] ? +m[3] : 8 };
    if (!onion || !(onion.to > onion.from) || onion.n < 2 || onion.n > 24)
      return fail("--onion takes a range of seconds, e.g. --onion 1.2-2 (or 1.2-2:12 for 12 frames, 2–24)", o.json);
    if (at || shotIds || everyBeats) return fail("--onion replaces --at/--shot/--beats; pass one of them", o.json);
  }
  const r = await each(briefPath, o, async (proj, id, out, brief) => {
    if (onion) return onionSkin(proj, id, out, onion, o, brief);
    // --beats n: a frame on every n-th beat of the film's grid, the hits a cut or a UI change should land on.
    let beatTimes = null;
    if (everyBeats) {
      if (!proj.bpm) return { ok: false, id, error: "--beats needs a film with a beat grid (bpm or music)" };
      const step = (60 / proj.bpm) * everyBeats;
      beatTimes = [];
      for (let t = 0; t < proj.total - 1e-6; t += step) beatTimes.push(t);
      if (beatTimes.length > 64)
        return { ok: false, id, error: `--beats ${everyBeats} gives ${beatTimes.length} frames; use a larger step (at most 64 frames)` };
    }
    // --shot id[,id]: the shot's first settled frame, its middle and its last frame (both sides of its cuts).
    let shotTimes = null;
    if (shotIds) {
      const picked = proj.scenes.filter((s) => shotIds.includes(s.id));
      if (picked.length !== shotIds.length)
        return { ok: false, id, error: `--shot: unknown id; this project has ${proj.scenes.map((s) => s.id).join(", ")}` };
      shotTimes = picked.flatMap((s) => [
        s.start + Math.min(0.25, s.duration / 4),
        s.start + s.duration / 2,
        Math.max(s.start, s.start + s.duration - 1 / proj.fps),
      ]);
    }
    // Default: one frame per scene, once its content has finished arriving.
    const times =
      at ??
      beatTimes ??
      shotTimes ??
      proj.reviewTimes ??
      proj.scenes.map((s) =>
        Math.min(s.start + s.duration - FADE - 0.1, proj.total - 0.05),
      );
    if (times.some((t) => t >= proj.total))
      return { ok: false, id, error: "--at must be within the film duration" };
    const dir = path.join(out, "stills", id);
    claimDir(dir);
    // Authored films: draw the first time again at the end, after the page has drawn the others.
    // The renderer seeks backward and splits frames among workers, so a picture that depends on
    // what was drawn before flickers in the MP4.
    // An external engine is trusted to be a function of the frame number; it is not re-run.
    const probe = proj.film && !brief.engine
      ? times.length > 1
        ? [times[0]]
        : [Math.min(proj.total - 0.05, times[0] + 1), times[0]]
      : [];
    const hf = brief.engine
      ? await engineStills(brief, proj, times, dir, o)
      : await runHyperframes(
          [
            "snapshot",
            proj.dir,
            "--at",
            [...times, ...probe].map((t) => t.toFixed(3)).join(","),
            "--no-end",
            "--output",
            dir,
            o.gpu ? "--browser-gpu" : "--no-browser-gpu",
          ],
          {},
        );
    const pngs = fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((f) => f.endsWith(".png"))
          .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
          .map((f) => path.join(dir, f))
      : [];
    if (hf.code !== 0 || pngs.length === 0)
      return {
        ok: false,
        id,
        error: hf.out.trim().split("\n").slice(-15).join("\n"),
      };
    let pure = null;
    if (probe.length && pngs.length === times.length + probe.length) {
      const extra = pngs.splice(times.length);
      pure = pixelHash(pngs[0]) === pixelHash(extra.at(-1));
      for (const f of extra) fs.rmSync(f);
      if (!pure && !o.json)
        console.error(
          `warning: ${id}: drawFrame drew ${times[0].toFixed(2)}s differently the second time; it carries state between frames (a counter, a mutated array, a cached result). Compute every value from t, or the MP4 flickers.`,
        );
    }
    const sheetFile = path.join(out, "stills", `${id}-sheet.png`);
    const blocked = guardOutput(out, sheetFile, o.force);
    if (blocked) return { ok: false, id, error: blocked };
    const tmpSheet = path.join(dir, ".sheet.png");
    const sheet = contactSheet(pngs, tmpSheet, proj.fmt)
      ? (commitOutput(out, tmpSheet, sheetFile), sheetFile)
      : null;
    if (!o.json) console.log(sheet ?? `${dir} (contact sheet not created)`);
    // Text check over the whole film, not only the sampled frames.
    let text = null;
    if (proj.film && !o["no-text-check"] && !proj.range) {
      text = brief.engine && !brief.source ? ENGINE_TEXT : await probeText(proj.dir, proj.total);
      if (!o.json) for (const line of describeText(text)) console.error(`warning: ${id}: ${line}`);
    }
    return { ok: true, id, frames: pngs, sheet, at: times, ...(pure === null ? {} : { pure }), ...(text ? { text_check: text.skipped ? text : { runs: text.runs } } : {}) };
  });
  if (o.json && r.results)
    console.log(
      JSON.stringify(
        { ok: r.code === 0, outputs: r.results, warnings: r.warnings },
        null,
        2,
      ),
    );
  else
    for (const x of r.results ?? [])
      if (!x.ok)
        console.error(`motion-use: still failed for ${x.id}:\n${x.error}`);
  return r.code;
}

// Onion skin: frames evenly spaced in time, averaged into one PNG, later frames a little stronger
// so the direction reads. Even ghost spacing is constant speed; spacing that tightens towards the
// ends is easing; one wide gap is a jump.
async function onionSkin(proj, id, out, { from, to, n }, o, brief) {
  const end = Math.min(to, proj.total - 1 / proj.fps);
  if (from >= end) return { ok: false, id, error: `--onion must lie within the film (0–${proj.total}s)` };
  const times = Array.from({ length: n }, (_, i) => from + ((end - from) * i) / (n - 1));
  const dir = path.join(out, "stills", `${id}-onion`);
  claimDir(dir);
  const hf = brief?.engine
    ? await engineStills(brief, proj, times, dir, o)
    : await runHyperframes(
        ["snapshot", proj.dir, "--at", times.map((t) => t.toFixed(3)).join(","), "--no-end", "--output", dir, o.gpu ? "--browser-gpu" : "--no-browser-gpu"],
        {},
      );
  const pngs = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort((a, b) => a.localeCompare(b, "en", { numeric: true })).map((f) => path.join(dir, f))
    : [];
  if (hf.code !== 0 || pngs.length !== n) return { ok: false, id, error: hf.out.trim().split("\n").slice(-15).join("\n") || `expected ${n} frames, got ${pngs.length}` };
  const file = path.join(out, "stills", `${id}-onion-${from}-${to}.png`);
  const blocked = guardOutput(out, file, o.force);
  if (blocked) return { ok: false, id, error: blocked };
  const tmp = path.join(dir, ".onion.png");
  const weights = times.map((_, i) => (1 + i / (n - 1)).toFixed(3)).join(" ");
  try {
    execFileSync(
      "ffmpeg",
      ["-v", "error", "-y", ...pngs.flatMap((p) => ["-i", p]), "-filter_complex", `${pngs.map((_, i) => `[${i}:v]`).join("")}mix=inputs=${n}:weights='${weights}'`, "-frames:v", "1", tmp],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (e) {
    return { ok: false, id, error: `onion skin not created (${e.code === "ENOENT" ? "ffmpeg not found" : e.stderr?.toString().trim()})` };
  }
  commitOutput(out, tmp, file);
  if (!o.json) console.log(file);
  return { ok: true, id, onion: file, frames: pngs, at: times.map((t) => +t.toFixed(3)) };
}

// Decoded pixels, so PNG metadata cannot make two identical frames look different.
const pixelHash = (file) =>
  crypto
    .createHash("sha256")
    .update(execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 256 * 1024 * 1024 }))
    .digest("hex");

async function verify(o, [file]) {
  if (o.manifest) {
    // Is this exactly a release master listed in the manifest? (publish only what render made)
    if (!fs.existsSync(o.manifest)) return fail(`no manifest at ${o.manifest}`, o.json);
    const files = file
      ? [file]
      : (JSON.parse(fs.readFileSync(o.manifest, "utf8")).files ?? []).map((e) => path.join(path.dirname(o.manifest), e.file));
    const results = files.map((f) =>
      fs.existsSync(f) ? { file: f, ...checkAgainstManifest(o.manifest, f) } : { file: f, ok: false, reason: "file not found" },
    );
    if (o.json) console.log(JSON.stringify({ ok: results.every((x) => x.ok), results }, null, 2));
    else
      for (const x of results)
        console.log(
          x.ok
            ? `ok  ${x.file}: ${x.entry.file} (${x.entry.kind}, ${x.entry.lang}/${x.entry.format}, ${x.entry.width ? `${x.entry.width}x${x.entry.height}` : `${x.entry.bytes} bytes`}${x.entry.fps ? ` ${x.entry.fps} fps` : ""}, snapshot ${x.snapshot ?? "none"})`
            : `NO  ${x.file}: ${x.reason}`,
        );
    return results.every((x) => x.ok) ? 0 : 1;
  }
  if (!file) return fail("verify needs a delivered MP4 path", o.json);
  const input = path.resolve(file),
    out = path.resolve(
      o.out ??
        path.join(
          path.dirname(input),
          "review",
          path.basename(input, path.extname(input)),
        ),
    );
  const rel = path.relative(out, input);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)))
    return fail("verification output must not contain the input video", o.json);
  const r = verifyVideo(input, out, {
    loop: Boolean(o.loop),
    motionCheck: {
      gate: Boolean(o.gate),
      allowStatic: o["allow-static"] ?? null,
      allowBluePurple: o["allow-blue-purple"] ?? null,
    },
  });
  if (o.json) console.log(JSON.stringify(r, null, 2));
  else
    console.log(
      `${r.report}\n${r.sheet}\n${r.ok ? "technical checks passed" : "technical checks failed"}; motion ${r.motion?.level ?? "not measured"}${r.loop ? `; loop seam ${r.loop.ok ? "clean" : "visible"} (${r.loop.seam_diff} vs step ${r.loop.step_diff})` : ""}; visual review pending${r.warnings.length ? "\n" + r.warnings.join("\n") : ""}`,
    );
  return r.ok ? 0 : 1;
}

async function runBreakdown(input, out) {
  const r = await breakdownVideo(input, out);
  // The same motion lights the delivery check uses, so a reference and your film compare directly.
  const measured = measureMotion(input),
    motion = { level: gradeMotion(measured).level, ...measured };
  r.motion = motion;
  fs.writeFileSync(
    path.join(out, "breakdown.json"),
    JSON.stringify(r, null, 2) + "\n",
  );
  fs.appendFileSync(
    path.join(out, "breakdown.md"),
    `\n## Motion lights\n\n${motion.level}: fast_ratio ${motion.fast_ratio}, worst window ${motion.worst_window_fast_ratio ?? "n/a"}, longest still ${motion.longest_still_s}s, events ${motion.events_per_10s}/10s, blue-purple ${motion.blue_purple_share}. Compare with your own film's review/<id>/report.json.\n`,
  );
  return r;
}

async function reference(o, [url, dir = "."]) {
  if (!url)
    return fail(
      "reference needs a gallery URL: motion-use reference https://prompt-motion.com/<entry>",
      o.json,
    );
  const outRoot = path.resolve(o.out ?? path.join(dir, "references"));
  const r = await fetchReference(url, {
    outRoot,
    video: !o["no-video"],
    breakdown: async (file, out) => {
      const b = await runBreakdown(file, out);
      return {
        transitions: b.transitions.length,
        segments: b.segments.length,
        beat: b.beat_grid?.step_seconds ?? null,
        motion: b.motion.level,
      };
    },
  });
  if (o.json) console.log(JSON.stringify(r, null, 2));
  else {
    const c = r.reference.creator,
      who = c?.handle ? `@${c.handle}` : (c?.name ?? "unknown creator");
    console.log(
      `${path.join(r.dir, "REFERENCE.md")}\n${r.reference.title ?? url} by ${who} (${r.reference.kind ?? r.reference.source})${r.breakdown ? `; ${r.breakdown.transitions} transitions, motion ${r.breakdown.motion}` : ""}\nthe prompt and video belong to their creator: study and paraphrase, never paste or commit them (the folder is git-ignored)${r.warnings.length ? "\n" + r.warnings.join("\n") : ""}`,
    );
  }
  return 0;
}

async function breakdown(o, [file]) {
  if (!file) return fail("breakdown needs a video path", o.json);
  const input = path.resolve(file);
  if (!fs.existsSync(input)) return fail(`${file} does not exist`, o.json);
  const out = path.resolve(
    o.out ??
      path.join(
        path.dirname(input),
        "breakdown",
        path.basename(input, path.extname(input)),
      ),
  );
  const r = await runBreakdown(input, out),
    motion = r.motion;
  if (o.json) console.log(JSON.stringify({ ok: true, out, ...r }, null, 2));
  else
    console.log(
      `${path.join(out, "breakdown.md")}\n${r.transitions.length} transitions, ${r.segments.length} segments${r.beat_grid ? `, beat grid ${r.beat_grid.step_seconds}s (${r.beat_grid.bpm_if_quarter} BPM if quarters)` : ""}; motion ${motion.level}`,
    );
  return 0;
}

async function beats(o, [file]) {
  if (!file) return fail("beats needs an audio file: beats song.mp3", o.json);
  const input = path.resolve(file);
  if (!fs.existsSync(input)) return fail(`${file} does not exist`, o.json);
  const from = o.from === undefined ? 0 : Number(o.from),
    to = o.to === undefined ? undefined : Number(o.to);
  if (!Number.isFinite(from) || from < 0 || (to !== undefined && !(to > from)))
    return fail("--from/--to take seconds into the song, with --to after --from", o.json);
  const r = analyzeBeats(decodeMono(input, { from, length: to === undefined ? undefined : to - from }));
  // Report song time, not range time.
  const sh = (x) => Math.round((x + from) * 1000) / 1000;
  const res = {
    ...r,
    first_beat: sh(r.first_beat),
    downbeat: sh(r.downbeat),
    beats: r.beats.map(sh),
    bars: r.bars.map((b) => ({ ...b, start: sh(b.start) })),
    drop: r.drop && { ...r.drop, start: sh(r.drop.start) },
  };
  const warnings = [];
  if (res.confidence < 2) warnings.push("no clear beat: the grid is a guess; confirm it by ear before cutting to it");
  if (res.downbeat_confidence < 1.2) warnings.push("the bar start is a guess: no beat carries clearly more kick; check which beat is one");
  const music = { file, bpm: res.bpm, from: res.downbeat };
  if (o.json) {
    const { beats: grid, ...rest } = res;
    console.log(JSON.stringify({ ok: true, ...rest, ...(o.verbose ? { beats: grid } : {}), music, warnings }, null, 2));
  } else {
    console.log(
      [
        `${res.bpm} BPM (beat ${res.beat_seconds}s, confidence ${res.confidence}); first beat ${res.first_beat}s, first downbeat ${res.downbeat}s (4/4 assumed, confidence ${res.downbeat_confidence})`,
        res.drop
          ? `drop: bar ${res.drop.bar} at ${res.drop.start}s in the song, +${res.drop.lift_db} dB over the bars before (film second ${Math.round((res.drop.start - res.downbeat) * 1000) / 1000} with the line below)`
          : "no drop: no bar rises 3 dB over the four before it",
        `bars (dB): ${res.bars.slice(0, 32).map((b) => b.db).join(" ")}${res.bars.length > 32 ? " …" : ""}`,
        "",
        `"music": ${JSON.stringify(music)}`,
        "film second 0 then sits on a downbeat, so M.beat(t) counts the song's beats and `still --beats 1` shows every hit.",
        ...warnings.map((w) => `warning: ${w}`),
      ].join("\n"),
    );
  }
  return 0;
}

async function compare(o, [a, b]) {
  if (!a || !b) return fail("compare needs two videos: compare <a> <b> --times 1.5,4", o.json);
  const times = list(o.times ?? o.at)?.map(Number);
  if (!times?.length || times.some((t) => !Number.isFinite(t)))
    return fail("--times takes seconds like 1.5,4", o.json);
  const out = path.resolve(o.out ?? "compare.png");
  if (fs.existsSync(out) && !o.force)
    return fail(`${out} exists; pass --force or choose --out`, o.json);
  const r = compareVideos(path.resolve(a), path.resolve(b), out, { times });
  if (o.json) console.log(JSON.stringify({ ok: true, ...r }, null, 2));
  else console.log(r.out);
  return 0;
}

function contactSheet(pngs, out, fmt) {
  const cols = fmt.vertical
    ? Math.min(pngs.length, 5)
    : Math.min(pngs.length, 3);
  const tw = fmt.vertical ? 360 : 640;
  const th = Math.round((tw * fmt.h) / fmt.w);
  const inputs = pngs.flatMap((p) => ["-i", p]);
  const scaled = pngs
    .map((_, i) => `[${i}:v]scale=${tw}:${th}[s${i}]`)
    .join(";");
  const layout = pngs
    .map((_, i) => `${(i % cols) * tw}_${Math.floor(i / cols) * th}`)
    .join("|");
  const filter =
    pngs.length === 1
      ? `[0:v]scale=${tw}:${th}`
      : `${scaled};${pngs.map((_, i) => `[s${i}]`).join("")}xstack=inputs=${pngs.length}:layout=${layout}:fill=black`;
  fs.rmSync(out, { force: true });
  try {
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        ...inputs,
        "-filter_complex",
        filter,
        "-frames:v",
        "1",
        out,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (e) {
    console.error(
      `motion-use: contact sheet not created (${e.code === "ENOENT" ? "ffmpeg not found" : e.stderr?.toString().trim()})`,
    );
  }
  return fs.existsSync(out);
}

async function doctor(o) {
  const checks = [];
  const add = (name, ok, detail, fix) =>
    checks.push({ name, ok, detail, ...(ok ? {} : { fix }) });
  const major = Number(process.versions.node.split(".")[0]);
  add(
    "node",
    major >= 22,
    `v${process.versions.node}`,
    "install Node.js 22 or newer: https://nodejs.org",
  );
  for (const bin of ["ffmpeg", "ffprobe"]) {
    try {
      const v = execFileSync(bin, ["-version"], { encoding: "utf8" }).split(
        "\n",
      )[0];
      add(bin, true, v);
    } catch {
      add(
        bin,
        false,
        "not found on PATH",
        process.platform === "darwin"
          ? "brew install ffmpeg"
          : "install ffmpeg with your package manager (e.g. apt install ffmpeg)",
      );
    }
  }
  let engine;
  try {
    engine = hyperframesBin();
    add("engine", true, `hyperframes ${engine.version}`);
  } catch {
    add(
      "engine",
      false,
      "hyperframes is not installed next to motion-use",
      "reinstall: curl -fsSL https://raw.githubusercontent.com/leeguooooo/motion-use/main/install.sh | sh",
    );
  }
  if (engine) {
    if (o["install-browser"])
      await runHyperframes(["browser", "ensure"], { echo: !o.json });
    const r = await runHyperframes(["browser", "path"], {});
    const p = r.out.trim().split("\n").pop();
    add(
      "chrome",
      r.code === 0 && p && fs.existsSync(p),
      r.code === 0 ? p : "no Chrome found for rendering",
      "run: motion-use doctor --install-browser (downloads Chrome for rendering), or install Google Chrome",
    );
  }
  for (const f of ["NotoSansSC[wght].ttf", "JetBrainsMono[wght].ttf"])
    add(
      `font ${f}`,
      fs.existsSync(path.join(ROOT, "assets", "fonts", f)),
      "bundled",
      "reinstall motion-use",
    );
  // Voiceover engines are optional: reported, never a failure.
  const azureReady = Boolean(
    process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION,
  );
  const optional = [
    {
      name: "voiceover azure",
      ok: azureReady,
      detail: azureReady
        ? `region ${process.env.AZURE_SPEECH_REGION}`
        : "not configured (optional): set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION",
    },
    {
      name: "voiceover edge",
      ok: edgeAvailable(),
      detail: edgeAvailable()
        ? "edge-tts found (preview only)"
        : "not installed (optional): pip install edge-tts",
    },
  ];
  const defaultEngine = pickEngine();
  const ok = checks.every((c) => c.ok);
  if (o.json)
    console.log(
      JSON.stringify(
        {
          ok,
          version: VERSION,
          checks,
          optional,
          voiceover_default_engine: defaultEngine,
        },
        null,
        2,
      ),
    );
  else {
    for (const c of checks)
      console.log(
        `${c.ok ? "ok  " : "FAIL"} ${c.name.padEnd(28)} ${c.detail}${c.fix ? `\n     fix: ${c.fix}` : ""}`,
      );
    for (const c of optional)
      console.log(`${c.ok ? "ok  " : "--  "} ${c.name.padEnd(28)} ${c.detail}`);
    console.log(`voiceover default engine: ${defaultEngine}`);
    console.log(ok ? "all good" : "some checks failed");
  }
  return ok ? 0 : 1;
}

async function upgradeCmd(o) {
  return upgrade({
    current: VERSION,
    root: ROOT,
    check: o.check,
    json: o.json,
  });
}
