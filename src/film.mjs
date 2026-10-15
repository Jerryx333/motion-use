// A film owns its choreography. The CLI owns assets, exact time, packaging and delivery.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FORMATS, FPS_VALUES, lintCustomHtml } from "./brief.mjs";
import { claimDir, audioSeconds, mediaInfo } from "./build.mjs";
import { execFileSync } from "node:child_process";
import { writeSubsets, missingGlyphs } from "./fonts.mjs";
import { writeMusic, MOOD_NAMES, moodBpm } from "./music.mjs";
import { composeMusic } from "./compose.mjs";
import { peakTime } from "./beats.mjs";
import { esc } from "./html.mjs";
import { BriefError } from "./brief.mjs";
import { resolveNarration } from "./film-voiceover.mjs";
import { buildNarrationStem } from "./verify.mjs";
import { readVoManifest, estimateCues } from "./voiceover.mjs";
import { readingSeconds, READING_RULE } from "./text-probe.mjs";
import crypto from "node:crypto";
import { validateTiming } from "./timing.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FILM_FORMATS = { ...FORMATS, square: [1440, 1440] };
const finite = (x, min, max) => Number.isFinite(x) && x >= min && x <= max;
const inside = (base, file) => {
  const r = path.relative(base, file);
  return (
    r !== "" &&
    !r.startsWith(".." + path.sep) &&
    r !== ".." &&
    !path.isAbsolute(r)
  );
};

export function resolveProject(input) {
  if (input) {
    const p = path.resolve(input);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory())
      return path.join(
        p,
        fs.existsSync(path.join(p, "film.json")) ? "film.json" : "brief.json",
      );
    return p;
  }
  return path.resolve(fs.existsSync("film.json") ? "film.json" : "brief.json");
}

export function isFilm(file) {
  try {
    return (
      JSON.parse(fs.readFileSync(resolveProject(file), "utf8")).kind === "film"
    );
  } catch {
    return false;
  }
}

export function validateFilm(
  data,
  dir,
  {
    probe = audioSeconds,
    requireNarration = false,
    skipGeneratedVoiceover = false,
  } = {},
) {
  const errors = [],
    warnings = [];
  const error = (p, message) => errors.push({ path: p, message });
  const text = (v, p, max = 1000) => {
    if (typeof v !== "string" || !v.trim() || v.length > max)
      error(p, `non-empty text, at most ${max} characters`);
    return v;
  };
  if (!data || typeof data !== "object" || Array.isArray(data))
    return { errors: [{ path: "$", message: "a film object" }], warnings };
  if (data.version !== 1 || data.kind !== "film")
    error("$.kind", 'version: 1, kind: "film"');
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(data.name ?? ""))
    error("$.name", "a lowercase slug, 1–40 characters");
  if (!finite(data.duration, 1, 180))
    error(
      "$.duration",
      "seconds, 1–180; authored timing is never silently stretched",
    );
  if (data.brief !== undefined) {
    const b = data.brief;
    if (!b || typeof b !== "object" || Array.isArray(b))
      error("$.brief", "{subject, purpose, audience, tone, length, reference}");
    else {
      for (const [k, v] of Object.entries(b)) {
        if (k === "length") {
          if (!finite(v, 1, 180)) error("$.brief.length", "target seconds, 1–180");
          else if (finite(data.duration, 1, 180) && Math.abs(v - data.duration) > 0.5)
            warnings.push({ path: "$.brief.length", message: `the brief asks for ${v} s but the shots cover ${data.duration} s: re-plan the shots and set duration` });
        } else if (typeof v !== "string" || v.length > 500)
          error(`$.brief.${k}`, "text, at most 500 characters");
        else if (/^\s*TODO\b/.test(v) && k !== "reference")
          warnings.push({ path: `$.brief.${k}`, message: "still a TODO: fill this field before directing (motion-use init --subject … --purpose … --tone …)" });
      }
    }
  }
  if (!FPS_VALUES.includes(data.fps)) error("$.fps", "24, 25, 30 or 60");
  for (const [key, allowed] of [
    ["languages", null],
    ["formats", Object.keys(FILM_FORMATS)],
  ]) {
    const v = data[key];
    if (
      !Array.isArray(v) ||
      !v.length ||
      v.length > 4 ||
      new Set(v).size !== v.length ||
      v.some(
        (x) =>
          typeof x !== "string" ||
          (allowed
            ? !allowed.includes(x)
            : !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(x)),
      )
    )
      error(
        `$.${key}`,
        allowed
          ? `unique formats: ${allowed.join(", ")}`
          : "1–4 unique language codes",
      );
  }
  validateTiming(data, error);
  if (data.narrationReviews !== undefined) {
    if (!data.narrationReviews || typeof data.narrationReviews !== "object" || Array.isArray(data.narrationReviews)) error("$.narrationReviews", "a map keyed by language/shot-id");
    else for (const [key, review] of Object.entries(data.narrationReviews)) {
      const [lang, id, extra] = key.split("/");
      if (extra || !Array.isArray(data.languages) || !data.languages.includes(lang) || !(id === "narration" || (Array.isArray(data.shots) && data.shots.some((s) => s?.id === id))))
        error(`$.narrationReviews.${key}`, "a language and narration shot ID in this film");
      if (!review || !/^[a-f0-9]{64}$/.test(review.sha256 ?? "") || ["script", "heard", "reason"].some((f) => typeof review[f] !== "string" || !review[f].trim() || review[f].length > 16000))
        error(`$.narrationReviews.${key}`, "{sha256, script, heard, reason}: an exact audio/script/transcript review record");
    }
  }
  const local = (v, p) => {
    if (
      typeof v !== "string" ||
      !v ||
      path.isAbsolute(v) ||
      /[\\\x00-\x1f]|^[a-z]+:/i.test(v)
    ) {
      error(p, "a relative local path inside this project");
      return null;
    }
    const f = path.resolve(dir, v);
    if (
      !inside(dir, f) ||
      !fs.existsSync(f) ||
      !fs.statSync(f).isFile() ||
      !inside(fs.realpathSync(dir), fs.realpathSync(f))
    ) {
      error(p, "a file inside this project (no escaping symlinks)");
      return null;
    }
    return f;
  };
  if (data.provenance !== undefined) {
    const entries = data.provenance;
    if (!entries || typeof entries !== "object" || Array.isArray(entries))
      error("$.provenance", "a map of project-relative file paths to {sourceUrl, license, useBasis}");
    else for (const [file, entry] of Object.entries(entries)) {
      const p = `$.provenance.${file}`;
      local(file, p);
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) { error(p, "{sourceUrl, license, useBasis}"); continue; }
      if (entry.sourceUrl !== null && entry.sourceUrl !== undefined) {
        try { if (!["http:", "https:"].includes(new URL(entry.sourceUrl).protocol)) throw new Error(); }
        catch { error(`${p}.sourceUrl`, "an http(s) source URL, or null for self-made material"); }
      }
      for (const key of ["license", "useBasis"])
        if (entry[key] !== null && entry[key] !== undefined && (typeof entry[key] !== "string" || !entry[key].trim() || entry[key].length > 2000))
          error(`${p}.${key}`, "non-empty text up to 2000 characters, or null when unverified");
    }
  }
  const fonts = {};
  if (data.fonts !== undefined) {
    if (!data.fonts || typeof data.fonts !== "object" || Array.isArray(data.fonts)) error("$.fonts", "a map of family names to {file, license}");
    else for (const [family, spec] of Object.entries(data.fonts)) {
      const p = `$.fonts.${family}`;
      if (!/^[A-Za-z][A-Za-z0-9-]{0,39}$/.test(family) || ["Film-Sans", "Film-Mono"].includes(family)) { error(p, "a safe CSS family name, e.g. Title"); continue; }
      const file = local(spec?.file, `${p}.file`), license = local(spec?.license, `${p}.license`);
      if (file && !/\.(ttf|otf|woff2?)$/i.test(file)) error(`${p}.file`, "TTF, OTF, WOFF or WOFF2");
      if (file && license) fonts[family] = { file, license };
    }
  }
  if (data.captionStyle !== undefined) {
    const style = data.captionStyle;
    if (!style || typeof style !== "object" || Array.isArray(style)) error("$.captionStyle", "subtitle style options");
    else for (const [key, v] of Object.entries(style)) {
      const p = `$.captionStyle.${key}`;
      if (["x", "y"].includes(key)) { if (!finite(v, 0, 1)) error(p, "fraction of the frame, 0–1"); }
      else if (key === "lines") { if (!Number.isInteger(v) || v < 1 || v > 4) error(p, "1–4 subtitle lines"); }
      else if (["size", "maxWidth", "weight"].includes(key)) { if (!finite(v, 1, 4096)) error(p, "positive pixels/count"); }
      else if (["plate", "color"].includes(key)) { if (typeof v !== "string" || !/^(#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\([\d.,\s]+\))$/i.test(v)) error(p, "a hex or rgb(a) color"); }
      else error(p, "supported options: x, y, size, maxWidth, weight, lines, plate, color");
    }
  }
  // External engine: a local command renders the picture as PNG frames; the browser composition,
  // when one is declared, becomes a transparent overlay (subtitles over 3D) composited on top.
  let engine = null;
  if (data.engine !== undefined) {
    const e = data.engine;
    if (!e || typeof e !== "object" || Array.isArray(e) || !["browser", "command"].includes(e.type))
      error("$.engine", '{"type": "browser"} or {"type": "command", "command": ["blender", "-b", "-P", "scene.py", "--"], "cwd": ".", "env": {}}');
    else if (e.type === "command") {
      if (!Array.isArray(e.command) || !e.command.length || e.command.length > 64 || e.command.some((x) => typeof x !== "string" || !x || x.length > 4096 || /\x00/.test(x)))
        error("$.engine.command", "an argv array of non-empty strings, e.g. [\"blender\", \"-b\", \"-P\", \"scene.py\", \"--\"]");
      let cwd = path.resolve(dir);
      if (e.cwd !== undefined) {
        cwd = typeof e.cwd === "string" && e.cwd ? path.resolve(dir, e.cwd) : null;
        if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) error("$.engine.cwd", "a directory, relative to the film");
      }
      if (e.env !== undefined && (!e.env || typeof e.env !== "object" || Array.isArray(e.env) || Object.entries(e.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== "string")))
        error("$.engine.env", "an object of environment variables with string values");
      // Arguments naming a file in the film folder are passed as absolute paths, whatever cwd is.
      const args = (Array.isArray(e.command) ? e.command : []).map((x) => {
        if (typeof x !== "string" || x.startsWith("-") || path.isAbsolute(x) || /^[a-z]+:/i.test(x)) return x;
        const f = path.resolve(dir, x);
        return inside(dir, f) && fs.existsSync(f) && fs.statSync(f).isFile() && (x.includes("/") || x.includes(".")) ? f : x;
      });
      for (const k of ["stream", "parallel"])
        if (e[k] !== undefined && typeof e[k] !== "boolean")
          error(`$.engine.${k}`, k === "stream" ? "true when the command can write raw RGBA frames into the FIFO its job names" : "true when one process renders the whole range on job.workers threads");
      // motion-render as an engine does both.
      const native = /^motion-render(\.exe)?$/.test(path.basename(String(e.command?.[0] ?? "")));
      engine = { type: "command", command: args, cwd, env: e.env ?? {}, stream: e.stream ?? native, parallel: e.parallel ?? native };
      warnings.push({ path: "$.engine", message: `renders with a local command (${e.command?.[0]}): it runs arbitrary code on this machine and needs --allow-code; it must draw frame N from time N/fps only` });
    }
  }
  // Which renderer draws the picture; --renderer overrides it (src/native.mjs).
  if (data.renderer !== undefined && !["auto", "native", "chrome"].includes(data.renderer))
    error("$.renderer", '"auto" (default: native when motion-render is installed and the film draws no WebGL), "native" or "chrome"');
  const composition = engine && data.composition === undefined ? null : (data.composition ?? "composition/draw.js");
  const source = composition === null ? null : local(composition, "$.composition");
  const libraries = [];
  if (data.libraries !== undefined && !Array.isArray(data.libraries))
    error("$.libraries", "an array of local, bundled browser scripts");
  for (const [i, v] of (Array.isArray(data.libraries)
    ? data.libraries
    : []
  ).entries()) {
    const f = local(v, `$.libraries[${i}]`);
    if (f && path.extname(f) === ".js") libraries.push(f);
    else if (f) error(`$.libraries[${i}]`, "a local .js browser bundle");
  }
  if (source) {
    if (
      path.dirname(source) === path.resolve(dir) ||
      path.extname(source) !== ".js"
    )
      error("$.composition", "a .js file in its own composition folder");
    const src = fs.readFileSync(source, "utf8");
    if (src.length > 500000)
      error(
        "$.composition",
        "keep the drawing code below 500 KB; put assets in files",
      );
    // Declared files are loaded from the page's own folder; host names stay forbidden.
    const loads = data.files && typeof data.files === "object" && Object.keys(data.files).length;
    for (const issue of lintCustomHtml(src))
      if (!(loads && issue.rule === "network" && /^(fetch|XMLHttpRequest)$/.test(issue.match))) error(
        "$.composition",
        `${issue.rule}: ${issue.match}; render from time with local assets`,
      );
    if (!/\b(?:window\.)?drawFrame\b/.test(src))
      error(
        "$.composition",
        "define window.drawFrame(ctx, time, film, view, motion)",
      );
  }
  // Editable numbers and series for charts and counters: change one value, the rest stays.
  if (
    data.data !== undefined &&
    (!data.data || typeof data.data !== "object" || Array.isArray(data.data))
  )
    error("$.data", "an object of named values and series");
  else if (data.data !== undefined && JSON.stringify(data.data).length > 100000)
    error("$.data", "keep data below 100 KB; load larger sets from a file asset");
  if (!data.copy || typeof data.copy !== "object" || Array.isArray(data.copy))
    error("$.copy", "visible text keyed by language, used for font subsetting");
  for (const lang of Array.isArray(data.languages) ? data.languages : []) {
    const c = data.copy?.[lang];
    if (!c || typeof c !== "object" || Array.isArray(c))
      error(`$.copy.${lang}`, "an object of text strings");
    else
      for (const [k, v] of Object.entries(c))
        text(v, `$.copy.${lang}.${k}`, 2000);
  }
  const shots = Array.isArray(data.shots) ? data.shots : [];
  if (!shots.length || shots.length > 60)
    error("$.shots", "1–60 shots, including a purpose and visible action");
  const ids = new Set();
  let end = 0;
  shots.forEach((s, i) => {
    const p = `$.shots[${i}]`;
    if (!s || typeof s !== "object") return error(p, "a shot object");
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(s.id ?? "") || ids.has(s.id))
      error(`${p}.id`, "a unique lowercase slug");
    ids.add(s.id);
    if (
      !finite(s.start, 0, data.duration) ||
      !finite(s.end, 0, data.duration) ||
      s.end <= s.start
    )
      error(p, "0 <= start < end <= duration");
    if (Math.abs(s.start - end) > 0.001)
      error(
        `${p}.start`,
        "shots must cover the timeline without gaps or overlaps",
      );
    end = s.end;
    text(s.purpose, `${p}.purpose`);
    text(s.action, `${p}.action`);
    if (s.duration !== undefined && s.duration !== "narration") error(`${p}.duration`, '"narration" for retime; start/end remain the execution timeline');
    if (s.tail !== undefined && !finite(s.tail, 0, 10)) error(`${p}.tail`, "narration tail seconds, 0–10");
    if (s.hold !== undefined && !finite(s.hold, 0, s.end - s.start))
      error(`${p}.hold`, "seconds, within the shot");
    if (s.hold > 1 && !s.holdReason)
      warnings.push({
        path: `${p}.hold`,
        message:
          "hold exceeds 1 second; record a reading/pacing reason instead of adding dead time",
      });
    if (s.holdReason !== undefined) text(s.holdReason, `${p}.holdReason`);
    if (s.cut !== undefined && typeof s.cut !== "boolean")
      error(`${p}.cut`, "true marks a deliberate hard cut into this shot");
  });
  if (Math.abs(end - data.duration) > 0.001)
    error("$.shots", "last shot must end at duration");
  directingChecks(data, shots, error, (p, message) =>
    warnings.push({ path: p, message }),
  );
  const music = data.music ?? "none";
  let musicFile = null,
    scoreFile = null;
  // Every film gets music written for it (composition/score.js). A built-in bed is the same
  // sound in every film of that mood, so it has to say why it is enough here.
  const sameBed =
    "a built-in mood is the same bed in every film that uses it: write composition/score.js for this film (music: {score}), or record why the bed is right here in music.why";
  if (music === "builtin") warnings.push({ path: "$.music", message: sameBed });
  if (typeof music === "object" && music && music.why !== undefined) text(music.why, "$.music.why");
  if (!["builtin", "none"].includes(music)) {
    if (!music || typeof music !== "object" || Array.isArray(music))
      error(
        "$.music",
        '"none", {score: "composition/score.js", volume}, {file, volume, bpm, from} or {builtin: mood, why, volume, hits}',
      );
    else if (music.score !== undefined) {
      if (music.builtin !== undefined || music.file !== undefined)
        error("$.music", "choose a score, a file or a built-in mood, not two");
      scoreFile = local(music.score, "$.music.score");
      if (music.volume !== undefined && !finite(music.volume, 0, 1))
        error("$.music.volume", "0–1");
    } else if (music.builtin !== undefined) {
      if (!music.why) warnings.push({ path: "$.music.builtin", message: sameBed });
      if (music.file !== undefined)
        error("$.music", "choose a built-in mood or a file, not both");
      if (!MOOD_NAMES.includes(music.builtin))
        error("$.music.builtin", MOOD_NAMES.join(", "));
      if (music.volume !== undefined && !finite(music.volume, 0, 1))
        error("$.music.volume", "0–1");
      if (
        music.hits !== undefined &&
        (!Array.isArray(music.hits) ||
          music.hits.length > 200 ||
          music.hits.some((x) => !finite(x, 0, data.duration)))
      )
        error("$.music.hits", "accent times in seconds within the film");
    } else {
      musicFile = local(music.file, "$.music.file");
      if (music.volume !== undefined && !finite(music.volume, 0, 1))
        error("$.music.volume", "0–1");
      // from: the song second that plays at film second 0 (`motion-use beats` prints its first downbeat).
      if (music.from !== undefined && !finite(music.from, 0, 86400))
        error("$.music.from", "seconds into the song where the film starts");
      else if (musicFile && music.from)
        try {
          const songSeconds = probe(musicFile);
          if (music.from >= songSeconds)
            error("$.music.from", `the song is ${songSeconds.toFixed(2)} s long; from must start inside it`);
          else if (music.from + data.duration > songSeconds + 0.05)
            warnings.push({ path: "$.music.from", message: `the song ends ${(music.from + data.duration - songSeconds).toFixed(2)} s before the film` });
        } catch (e) {
          error("$.music.file", e.message);
        }
    }
  }
  const bpm =
    data.bpm ??
    (typeof music === "object" ? (music?.bpm ?? moodBpm(music?.builtin)) : undefined) ??
    100;
  if (!finite(bpm, 40, 240))
    error("$.bpm", "40–240; built-in music and the beat grid use the same BPM");
  if (data.loop !== undefined && typeof data.loop !== "boolean")
    error("$.loop", "true when the film repeats: render checks the last frame leads into the first");
  const tracks = [];
  if (data.audio !== undefined && !Array.isArray(data.audio))
    error("$.audio", "an array of local audio clips");
  if (data.audio?.length > 64) error("$.audio", "at most 64 clips");
  (Array.isArray(data.audio) ? data.audio.slice(0, 64) : []).forEach((a, i) => {
    const p = `$.audio[${i}]`;
    if (!a || typeof a !== "object") return error(p, "an audio clip");
    if (a.effect !== undefined && a.file !== undefined)
      error(p, "choose a local file or a bundled effect, not both");
    if (
      a.effect !== undefined &&
      !["click", "switch", "whoosh", "ding", "stamp", "thud", "paper", "explosion", "train", "map-pin", "page-turn", "low-boom"].includes(a.effect)
    )
      error(`${p}.effect`, "a bundled effect: click, switch, whoosh, ding, stamp, thud, paper, explosion, train, map-pin, page-turn, low-boom");
    const file = ["click", "switch", "whoosh", "ding", "stamp", "thud", "paper", "explosion", "train", "map-pin", "page-turn", "low-boom"].includes(a.effect)
        ? path.join(ROOT, "assets", "sfx", `${a.effect}.wav`)
        : local(a.file, `${p}.file`);
    let start = a.start ?? 0,
      offset = a.offset ?? 0,
      peak;
    if (!finite(start, 0, data.duration) || !finite(offset, 0, 86400))
      error(p, "non-negative start and offset");
    if (a.volume !== undefined && !finite(a.volume, 0, 2))
      error(`${p}.volume`, "0–2");
    if (a.role !== undefined && !["voiceover", "music", "sfx"].includes(a.role))
      error(`${p}.role`, "voiceover, music or sfx");
    if (a.align !== undefined && !["start", "peak"].includes(a.align))
      error(`${p}.align`, '"start" (default: the file starts at start) or "peak" (its loudest moment lands at start)');
    if (
      a.lang !== undefined &&
      (!Array.isArray(data.languages) || !data.languages.includes(a.lang))
    )
      error(`${p}.lang`, "a language in this film");
    if (file)
      try {
        const sourceSeconds = probe(file);
        let trimmed = 0;
        // align "peak": measure where the clip actually hits and move it so that moment lands on start.
        if (a.align === "peak" && Number.isFinite(start) && Number.isFinite(offset)) {
          peak = peakTime(file, { offset, length: a.length });
          start -= peak;
          if (start < 0) {
            trimmed = -start;
            offset += trimmed;
            start = 0;
          }
        }
        const length = a.length !== undefined ? a.length - trimmed : sourceSeconds - offset;
        if (
          !finite(length, 0.01, 180) ||
          offset + length > sourceSeconds + 0.05 ||
          start + length > data.duration + 0.05
        )
          error(
            p,
            "audio is cut off; trim explicitly or extend the film and its shots",
          );
        tracks.push({
          ...a,
          file,
          start,
          offset,
          length,
          volume: a.volume ?? 1,
          ...(peak !== undefined ? { peak: Math.round(peak * 1000) / 1000 } : {}),
        });
      } catch (e) {
        error(p, e.message);
      }
  });
  if (
    data.motionBlur !== undefined &&
    (!data.motionBlur ||
      ![1, 2, 4].includes(data.motionBlur.samples) ||
      !finite(data.motionBlur.shutter, 0, 1))
  )
    error("$.motionBlur", "{samples: 1|2|4, shutter: 0–1}");
  const fileAssets = {};
  if (
    data.assets !== undefined &&
    (!data.assets ||
      typeof data.assets !== "object" ||
      Array.isArray(data.assets))
  )
    error("$.assets", "named local image files");
  for (const [k, v] of Object.entries(data.assets ?? {})) {
    if (
      !/^[a-z][a-z0-9-]{0,39}$/i.test(k) ||
      !/\.(png|jpe?g|webp|svg)$/i.test(v)
    )
      error(`$.assets.${k}`, "named PNG/JPG/WebP/SVG image");
    const f = local(v, `$.assets.${k}`);
    if (f) fileAssets[k] = f;
  }
  // Any other local file a browser library or an external engine loads (glb, vrm, hdr, wasm, json…).
  const files = {};
  if (data.files !== undefined && (!data.files || typeof data.files !== "object" || Array.isArray(data.files)))
    error("$.files", 'named local files: {"alice": "models/alice.vrm"}');
  let fileBytes = 0;
  for (const [k, v] of Object.entries(data.files ?? {})) {
    if (!/^[a-z][a-z0-9-]{0,39}$/i.test(k)) error(`$.files.${k}`, "a name: a letter, then letters, digits or -");
    const f = local(v, `$.files.${k}`);
    if (f) ((files[k] = f), (fileBytes += fs.statSync(f).size));
  }
  if (fileBytes > 200e6)
    warnings.push({ path: "$.files", message: `${Math.round(fileBytes / 1e6)} MB of files are copied into every language and format build; files over 200 MB are kept in snapshots by hash only` });
  // Footage: frames are extracted at build time for the declared film window, so every
  // film time maps to one source frame and the page stays a pure function of time.
  const videos = {};
  if (
    data.videos !== undefined &&
    (!data.videos || typeof data.videos !== "object" || Array.isArray(data.videos))
  )
    error("$.videos", "named footage clips: {name: {file, at, from, rate, length, volume}}");
  let videoFrames = 0;
  for (const [k, v] of Object.entries(data.videos ?? {})) {
    const p = `$.videos.${k}`;
    if (!/^[a-z][a-z0-9-]{0,39}$/i.test(k) || !v || typeof v !== "object")
      { error(p, "a named clip object"); continue; }
    if (!/\.(mp4|mov|m4v|webm)$/i.test(v.file ?? "")) error(`${p}.file`, "an MP4, MOV, M4V or WebM file");
    const f = local(v.file, `${p}.file`);
    const at = v.at ?? 0,
      from = v.from ?? 0,
      rate = v.rate ?? 1;
    if (!finite(at, 0, data.duration)) error(`${p}.at`, "the film second where the clip starts");
    if (!finite(from, 0, 86400)) error(`${p}.from`, "seconds into the source");
    if (!finite(rate, 0.25, 4)) error(`${p}.rate`, "playback speed 0.25–4");
    if (v.volume !== undefined && !finite(v.volume, 0, 2)) error(`${p}.volume`, "0–2 (default 0: muted)");
    if (v.volume > 0 && rate !== 1) error(`${p}.volume`, "footage sound plays only at rate 1");
    if (!f) continue;
    try {
      const info = mediaInfo(f),
        room = Math.max(0, ((info.duration ?? 0) - from) / rate),
        length = v.length ?? Math.min(room, data.duration - at);
      if (!finite(length, 0.04, 180) || length > room + 0.05 || at + length > data.duration + 0.05)
        error(p, "the clip runs past its source or the film; set length or from");
      else {
        videoFrames += Math.ceil(length * data.fps);
        videos[k] = { file: f, at, from, rate, length, volume: v.volume ?? 0, width: info.w, height: info.h, audio: info.audio };
      }
    } catch (e) {
      error(`${p}.file`, e.message);
    }
  }
  if (videoFrames > 5400)
    error("$.videos", `${videoFrames} footage frames; keep footage under 5400 frames (90 s at 60 fps) per film`);
  else if (videoFrames > 1800)
    warnings.push({ path: "$.videos", message: `${videoFrames} footage frames are extracted per language and format (~${Math.round(videoFrames * 0.12)} MB of JPEG in the build folder)` });
  let glyphs = [];
  try { glyphs = missingGlyphs(JSON.stringify([data.copy ?? {}, data.data ?? {}, data.captions ?? {}]), fonts); }
  catch (e) { error("$.fonts", `cannot read font: ${e.message}`); }
  if (glyphs.length)
    error("$.copy", `missing font glyphs: ${glyphs.join(" ")}`);
  const narration = resolveNarration(
    { ...data, dir, tracks },
    {
      error,
      warn: (p, message) => warnings.push({ path: p, message }),
      requireFiles: requireNarration,
      skipGenerated: skipGeneratedVoiceover,
      probe,
    },
  );
  tracks.push(...narration.tracks);
  return {
    errors,
    warnings,
    film: {
      ...data,
      composition,
      source,
      musicFile,
      scoreFile,
      bpm,
      tracks,
      fileAssets,
      files,
      engine,
      videos,
      libraries,
      dir,
      fonts,
      narrationConfig: narration.config,
      narrationPlans: narration.plans,
      narrationPending: narration.pending,
    },
    shots,
  };
}

// Shot-plan checks ported from huashu-art-motion's storyboard lint (MIT), mapped onto film.json.
export const PALETTES = [
  "paper",
  "poster",
  "ink",
  "navy",
  "bauhaus",
  "snow",
  "wood",
  "chalk",
  "whiteboard",
];
export const CAMERA_MOVES = [
  "hold",
  "push",
  "pull",
  "pan",
  "slam",
  "whip",
  "follow",
  "cut",
  "drift",
];
const FAST_MOVES = new Set(["push", "pull", "pan", "slam", "whip"]);
const WEAK_ACTION =
  /(出现|显示|展示|呈现|淡入|淡出|弹出|停留|介绍|逐条)|\b(appears?|shows?|displays?|is shown|fades? (in|out)|pops? up|introduces?)\b/i;
const HEX = /^#[0-9a-f]{6}$/i;
// Hue 225–300°, saturation ≥ .30: the blue-purple band the motion check also measures.
export function bluePurpleHex(hex) {
  const n = parseInt(hex.slice(1), 16),
    r = ((n >> 16) & 255) / 255,
    g = ((n >> 8) & 255) / 255,
    b = (n & 255) / 255;
  const mx = Math.max(r, g, b),
    d = mx - Math.min(r, g, b);
  if (!d || d / mx < 0.3 || mx < 0.06 || mx > 0.9) return false;
  const h =
    60 *
    (mx === r ? (((g - b) / d) % 6 + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4);
  return h >= 225 && h <= 300;
}
// One CJK character is one unit; a run of Latin letters or digits is one unit.
export const textUnits = (s) =>
  (String(s).match(/[\u2e80-\u9fff\uf900-\ufaff]|[A-Za-z0-9][A-Za-z0-9.%°']*/g) ?? []).length;

function directingChecks(data, shots, error, warn) {
  const look = data.look;
  if (look === undefined)
    warn(
      "$.look",
      'lock one style and palette for the whole film: {"style": "...", "palette": "paper"}',
    );
  else if (!look || typeof look !== "object" || Array.isArray(look))
    error("$.look", "{style, palette, character?, allowBluePurple?, allowStatic?}");
  else {
    if (typeof look.style !== "string" || !look.style.trim())
      error("$.look.style", "one sentence naming the single style of the whole film");
    const pal = look.palette;
    if (typeof pal === "string") {
      if (!PALETTES.includes(pal))
        error("$.look.palette", `a palette name (${PALETTES.join(", ")}) or 3–6 hex colors`);
    } else if (
      !Array.isArray(pal) ||
      pal.length < 3 ||
      pal.some((c) => typeof c !== "string" || !HEX.test(c))
    )
      error("$.look.palette", `a palette name (${PALETTES.join(", ")}) or 3–6 hex colors`);
    else {
      if (pal.length > 6)
        warn("$.look.palette", "more than 6 colors: one accent points at one thing per shot");
      const bp = pal.filter(bluePurpleHex);
      if (bp.length && !look.allowBluePurple)
        error(
          "$.look.palette",
          `blue-purple ${bp.join(" ")} reads as the generic AI look; choose another color, or set look.allowBluePurple to the reason the subject needs it`,
        );
    }
    for (const k of ["character", "allowBluePurple", "allowStatic"])
      if (look[k] !== undefined && (typeof look[k] !== "string" || !look[k].trim()))
        error(`$.look.${k}`, "non-empty text");
    if (/(q版|chibi|stick ?figure|火柴人|小人|机器人|robot)/i.test(look.character ?? "") && !/(frames?|帧库|\.png|\/)/i.test(look.character))
      warn(
        "$.look.character",
        "code-drawn mascots and robots read as generic; use generated character frames, hands and silhouettes, or real footage",
      );
  }
  const langs = Array.isArray(data.languages) ? data.languages : [];
  const textOf = (s) =>
    s.text === undefined
      ? []
      : typeof s.text === "string"
        ? [s.text]
        : langs.map((l) => s.text?.[l]).filter((x) => typeof x === "string");
  const valid = shots.filter((s) => s && typeof s === "object");
  let textLed = 0;
  valid.forEach((s, i) => {
    const p = `$.shots[${i}]`,
      seconds = s.end - s.start;
    if (s.camera !== undefined && !CAMERA_MOVES.includes(s.camera))
      error(`${p}.camera`, CAMERA_MOVES.join(", "));
    if (s.camera === "drift")
      warn(`${p}.camera`, "a uniform slow drift reads as a slideshow; hold, then move on an event");
    if (
      s.text !== undefined &&
      typeof s.text !== "string" &&
      (!s.text || typeof s.text !== "object" || Array.isArray(s.text))
    )
      error(`${p}.text`, "on-screen text: a string or a language map");
    const units = Math.max(0, ...textOf(s).map(textUnits));
    if (units > 8)
      warn(`${p}.text`, `${units} units on screen; keep shot text to 8 or fewer and leave the sentence to narration`);
    // The shot window is the most time its planned words can stay up; render measures the real span.
    const slow = textOf(s).find((x) => Number.isFinite(seconds) && seconds < readingSeconds(x));
    if (slow)
      warn(`${p}.text`, `${s.start}–${s.end}s gives "${slow}" ${+seconds.toFixed(2)}s on screen; reading it needs ${readingSeconds(slow)}s (${READING_RULE}): fewer words or a longer shot`);
    const led = units >= 7 || /^(title|text|headline|quote|标题|文字|大字|金句|字卡)/i.test(String(s.action ?? "").trim());
    if (led) textLed++;
    if (led && (i === 0 || (i === valid.length - 1 && valid.length > 1)))
      warn(p, `${i === 0 ? "opening" : "closing"} shot is led by text; ${i === 0 ? "open on an object doing something related to the subject" : "end on the subject doing something, with any words written on objects in the scene"}`);
    const weak = typeof s.action === "string" ? WEAK_ACTION.exec(s.action) : null;
    if (weak)
      warn(`${p}.action`, `presentation verbs: matched ${JSON.stringify(weak[0])} at character ${[...s.action.slice(0, weak.index)].length}; say what the object itself does`);
    if (Number.isFinite(seconds) && valid.length > 1) {
      if (seconds > 8 && !s.holdReason)
        warn(p, `${+seconds.toFixed(2)}s shot: split it, or record why it holds in holdReason`);
      else if (seconds < 1)
        warn(p, `${+seconds.toFixed(2)}s shot: too short to read unless it is a deliberate flash`);
    }
    if (i >= 2 && s.camera && s.camera === valid[i - 1].camera && s.camera === valid[i - 2].camera && s.camera !== "cut")
      warn(`${p}.camera`, `three "${s.camera}" shots in a row; vary the framing or camera move`);
  });
  if (valid.length >= 4 && textLed / valid.length > 0.3)
    warn("$.shots", `${textLed} of ${valid.length} shots are led by text; keep it to 30% or less`);
  const cams = valid.map((s) => s.camera).filter(Boolean);
  if (cams.length === valid.length && valid.length >= 3 && !cams.some((c) => FAST_MOVES.has(c)))
    warn("$.shots", "no push, pan, slam or whip anywhere: move on events instead of drifting");
}

export function checkFilm(input, o = {}) {
  const file = resolveProject(input),
    dir = path.dirname(file);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const { film, errors, warnings } = validateFilm(data, dir, o);
  const langs = o.lang
      ? o.lang.split(",")
      : Array.isArray(film.languages)
        ? film.languages
        : [],
    formats = o.format
      ? o.format.split(",")
      : Array.isArray(film.formats)
        ? film.formats
        : [];
  for (const l of langs ?? [])
    if (!film.languages?.includes(l))
      errors.push({ path: "--lang", message: `${l} is not in this film` });
  for (const f of formats ?? [])
    if (!film.formats?.includes(f))
      errors.push({ path: "--format", message: `${f} is not in this film` });
  return {
    ok: errors.length === 0,
    film,
    brief: film,
    dir,
    langs,
    formats,
    report: {
      brief: file,
      errors,
      warnings,
      missing_glyphs: [],
      media: [],
      timelines: errors.length
        ? []
        : langs.flatMap((lang) =>
            formats.map((format) => ({
              lang,
              format,
              seconds: film.duration,
              scenes: film.shots.map((s) => ({
                id: s.id,
                start: s.start,
                seconds: s.end - s.start,
              })),
            })),
          ),
    },
  };
}

export function initFilm(o, dir) {
  dir = path.resolve(dir);
  const target = path.join(dir, "film.json");
  const draw = path.join(dir, "composition", "draw.js"),
    director = path.join(dir, "DIRECTOR.md");
  // Preflight every target before writing any file. Never erase custom drawing code on re-init.
  for (const f of [target, draw, director])
    if (fs.existsSync(f))
      throw new BriefError(
        `${f} already exists; choose a fresh project directory`,
      );
  const data = JSON.parse(
    fs.readFileSync(path.join(ROOT, "templates", "film", "film.json"), "utf8"),
  );
  if (o.name) data.name = o.name;
  // Every part a user changes first is a field: fill the brief from flags, keep TODOs for the rest.
  for (const k of ["subject", "purpose", "audience", "tone"])
    if (typeof o[k] === "string" && o[k].trim()) data.brief[k] = o[k].trim();
  if (o.length !== undefined) {
    const n = Number(o.length);
    if (!finite(n, 1, 180)) throw new BriefError("--length: seconds, 1–180");
    data.brief.length = n;
  }
  if (o.palette) {
    const hex = o.palette.split(",").map((x) => x.trim());
    data.look.palette = hex.length > 1 ? hex : o.palette.trim();
  }
  if (o.lang) {
    data.languages = o.lang.split(",");
    data.copy = Object.fromEntries(
      data.languages.map((l) => [l, data.copy[l] ?? data.copy.en]),
    );
  }
  if (o.format) data.formats = o.format.split(",");
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(data.name))
    throw new BriefError("--name must be a lowercase slug");
  if (
    !data.formats.length ||
    data.formats.some((f) => !Object.hasOwn(FILM_FORMATS, f))
  )
    throw new BriefError("--format: landscape, vertical or square");
  if (
    !data.languages.length ||
    data.languages.some((l) => !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(l))
  )
    throw new BriefError("--lang: language codes such as zh,en");
  fs.mkdirSync(path.dirname(draw), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(data, null, 2) + "\n");
  fs.copyFileSync(path.join(ROOT, "templates", "film", "draw.js"), draw);
  fs.copyFileSync(path.join(ROOT, "templates", "film", "score.js"), path.join(path.dirname(draw), "score.js"));
  fs.copyFileSync(
    path.join(ROOT, "templates", "film", "DIRECTOR.md"),
    director,
  );
  return { ok: true, film: target, composition: draw, director, mode: "film" };
}

// Subtitles for the narration actually placed in this language: cues timed by the voice
// service when the clip still matches its manifest entry, otherwise estimated per sentence.
export function filmCaptions(film, lang, voiceTracks) {
  if (film.captions?.[lang] !== undefined) return film.captions[lang].map((c) => ({ ...c }));
  const dir = film.narrationConfig?.dir,
    manifest = dir ? readVoManifest(dir) : {},
    out = [];
  for (const track of voiceTracks) {
    const plan = (film.narrationPlans ?? []).find((p) => p.id === track.id),
      text = plan?.narration?.[lang];
    if (!text) continue; // an imported recording without a script has no subtitles
    const rec = dir ? manifest[path.relative(dir, track.file)] : null,
      current =
        rec?.cues &&
        rec.text === text &&
        rec.sha === crypto.createHash("sha256").update(fs.readFileSync(track.file)).digest("hex");
    if (current)
      for (const c of rec.cues)
        out.push({ text: c.text, start: +(track.start + c.start).toFixed(3), end: +(track.start + Math.min(c.end, track.length)).toFixed(3) });
    else out.push(...estimateCues(text, track.start, track.start + track.length));
  }
  return out.sort((a, b) => a.start - b.start);
}

// Only cache-matched service word boundaries reach the picture; stale clips yield no words.
export function filmWords(film, lang, voiceTracks) {
  const dir=film.narrationConfig?.dir, manifest=dir?readVoManifest(dir):{};
  return voiceTracks.flatMap((track)=>{
    const plan=film.narrationPlans?.find((p)=>p.id===track.id), rec=dir?manifest[path.relative(dir,track.file)]:null;
    if(!rec?.words || rec.text!==plan?.narration?.[lang] || rec.sha!==crypto.createHash("sha256").update(fs.readFileSync(track.file)).digest("hex")) return [];
    return rec.words.filter((w)=>Number.isFinite(w.start)&&Number.isFinite(w.end)&&w.start>=0&&w.end>w.start&&w.end<=track.length+.05)
      .map((w)=>({...w,id:track.id,start:track.start+w.start,end:track.start+Math.min(track.length,w.end),estimated:false}));
  }).sort((a,b)=>a.start-b.start);
}

// Where platform UI leaves the picture visible; film-runtime.js computes the same box as view.safe.
export const safeBox = (w, h) =>
  h > w
    ? { x: w * 0.06, y: h * 0.1, w: w * 0.8, h: h * 0.66 }
    : { x: w * 0.05, y: h * 0.06, w: w * 0.9, h: h * 0.88 };

export async function buildFilm(film, lang, format, outDir, { range = null, guides = false, noCaptions = false, noBgm = false, progress = () => {} } = {}) {
  claimDir(outDir);
  const [w, h] = FILM_FORMATS[format],
    fmt = { w, h, vertical: h > w, name: format };
  // With an external engine the page is a transparent layer over its frames (or empty, carrying
  // only the sound): nothing paints a background, and blur would average against transparency.
  const overlay = film.engine?.type === "command";
  // Copy declared assets only. Never sweep a project folder containing credentials.
  fs.mkdirSync(path.join(outDir, "composition"));
  if (film.source) fs.copyFileSync(film.source, path.join(outDir, "composition", "draw.js"));
  else fs.writeFileSync(path.join(outDir, "composition", "draw.js"), "window.drawFrame = function () {};\n");
  const scripts = film.libraries
    .map((f, i) => {
      const rel = `composition/library-${i}.js`;
      fs.copyFileSync(f, path.join(outDir, rel));
      return `<script src="${rel}"></script>`;
    })
    .join("");
  fs.mkdirSync(path.join(outDir, "assets", "audio"), { recursive: true });
  const assets = {};
  for (const [key, file] of Object.entries(film.fileAssets)) {
    const rel = `assets/${key}${path.extname(file)}`;
    fs.copyFileSync(file, path.join(outDir, rel));
    assets[key] = rel;
  }
  const files = {};
  if (Object.keys(film.files ?? {}).length) fs.mkdirSync(path.join(outDir, "assets", "files"));
  for (const [key, file] of Object.entries(film.files ?? {})) {
    const rel = `assets/files/${key}${path.extname(file)}`;
    fs.copyFileSync(file, path.join(outDir, rel));
    files[key] = rel;
  }
  const videos = {};
  for (const [key, v] of Object.entries(film.videos ?? {})) {
    if (range && (v.at >= range.to || v.at + v.length <= range.from)) continue;
    const dir = path.join(outDir, "assets", "video", key);
    fs.mkdirSync(dir, { recursive: true });
    // Output frame k (film time at + k/fps) shows source time from + k·rate/fps.
    const scale = Math.min(1, Math.max(w, h) / Math.max(v.width, v.height));
    execFileSync(
      "ffmpeg",
      ["-v", "error", "-y", "-ss", String(v.from), "-t", String(v.length * v.rate), "-i", v.file,
        "-vf", `fps=${film.fps / v.rate},scale=${Math.round((v.width * scale) / 2) * 2}:-2`, "-q:v", "3", "-start_number", "0",
        path.join(dir, "%05d.jpg")],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const frames = fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).length;
    if (!frames) throw new Error(`no frames could be read from ${v.file}`);
    videos[key] = { dir: `assets/video/${key}`, at: v.at, length: v.length, frames, fps: film.fps };
  }
  const fontDir = path.join(outDir, "assets", "fonts");
  const fontSizes = await writeSubsets(
    // The kit draws characters of its own (e.g. "−" and "," in count()).
    JSON.stringify(film.copy) +
    JSON.stringify(film.data ?? {}) + JSON.stringify(film.captions ?? {}) +
      (film.source ? fs.readFileSync(film.source, "utf8") : "") +
      fs.readFileSync(path.join(ROOT, "src", "film-kit.js"), "utf8"),
    fontDir,
    film.fonts,
  );
  for (const f of fs
    .readdirSync(path.join(ROOT, "assets", "fonts"))
    .filter((f) => f.startsWith("OFL-")))
    fs.copyFileSync(
      path.join(ROOT, "assets", "fonts", f),
      path.join(fontDir, f),
    );
  // A range preview is silent: it checks picture and timing, not the mix.
  // Every sound is one entry of `mix` (what plays where, how loud): the page's <audio> tags are
  // written from it for the browser renderer, and src/mix.mjs mixes it with ffmpeg for the native one.
  const mix = [],
    selectedTracks = range ? [] : film.tracks.filter((a) => (!a.lang || a.lang === lang) && !(noBgm && a.role === "music"));
  if (!range && !noBgm && film.music !== "none" && film.music !== undefined) {
    let rel = "assets/audio/music.wav";
    if (film.scoreFile) {
      const voice = selectedTracks
        .filter((a) => a.role === "voiceover")
        .map((a) => ({ start: a.start, end: a.start + a.length }));
      progress("score", "start", { lang, format });
      const { wav, score, problems } = composeMusic(film, lang, voice);
      progress("score", "finish");
      fs.writeFileSync(path.join(outDir, rel), wav);
      fs.writeFileSync(path.join(outDir, "assets", "audio", "score.json"), JSON.stringify({ why: score.why, tempo: score.tempo, key: score.key, instruments: [...new Set(score.events.map((e) => e.instrument))].sort(), notes: score.events.length, warnings: problems.map((p) => p.message) }, null, 2));
      for (const p of problems) console.error(`warning: music score: ${p.message}`);
    } else if (film.music === "builtin" || film.music.builtin)
      writeMusic(
        path.join(outDir, rel),
        film.music.builtin ?? "promo",
        film.duration,
        { bpm: film.bpm, hits: film.music.hits ?? [] },
      );
    else {
      rel = `assets/audio/music${path.extname(film.musicFile)}`;
      fs.copyFileSync(film.musicFile, path.join(outDir, rel));
    }
    const volume =
      typeof film.music === "object" ? (film.music.volume ?? 0.6) : 0.6;
    // Voiceover windows carve the music, with short ramps at both edges.
    const points = [{ t: 0, v: volume }];
    const voices = selectedTracks
      .filter((a) => a.role === "voiceover")
      .sort((a, b) => a.start - b.start);
    const windows = [];
    for (const a of voices) {
      const prev = windows.at(-1);
      if (prev && a.start <= prev.end + 0.2)
        prev.end = Math.max(prev.end, a.start + a.length);
      else windows.push({ start: a.start, end: a.start + a.length });
    }
    for (const a of windows)
      points.push(
        { t: Math.max(0, a.start - 0.15), v: volume },
        { t: a.start, v: volume * 0.25 },
        { t: a.end, v: volume * 0.25 },
        { t: Math.min(film.duration, a.end + 0.2), v: volume },
      );
    const unique = [...new Map(points.map((p) => [p.t, p])).values()].sort(
      (a, b) => a.t - b.t,
    );
    mix.push({ id: "film-music", rel, start: 0, mediaStart: film.music.from || 0, seek: Boolean(film.music.from), duration: film.duration, volume, fadeIn: 0, fadeOut: 0.3, track: 10, automation: voices.length ? unique : null });
  }
  selectedTracks.forEach((a, i) => {
    const rel = `assets/audio/clip-${i}${path.extname(a.file)}`;
    fs.copyFileSync(a.file, path.join(outDir, rel));
    mix.push({ id: `film-audio-${i}`, rel, start: a.start, mediaStart: a.offset, seek: true, duration: a.length, volume: a.volume, fadeIn: 0.015, fadeOut: 0.03, track: 11 + i });
  });
  // Footage sound, when asked for, is extracted once and placed like any other clip.
  if (!range)
    for (const [key, v] of Object.entries(film.videos ?? {})) {
      if (!(v.volume > 0) || !v.audio) continue;
      const rel = `assets/audio/video-${key}.wav`;
      execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(v.from), "-t", String(v.length), "-i", v.file, "-vn", "-ac", "2", "-ar", "48000", path.join(outDir, rel)], { stdio: ["ignore", "ignore", "pipe"] });
      mix.push({ id: `film-video-${key}`, rel, start: v.at, mediaStart: 0, duration: v.length, volume: v.volume, fadeIn: 0.015, fadeOut: 0.05, track: 60 + Object.keys(film.videos).indexOf(key) });
    }
  const audio = mix.map(
    (m) =>
      `<audio id="${esc(m.id)}" src="${m.rel}" data-start="${m.start}"${m.seek ? ` data-media-start="${m.mediaStart}"` : ""} data-duration="${m.duration}" data-volume="${m.volume}"${m.fadeIn ? ` data-fade-in="${m.fadeIn}"` : ""} data-fade-out="${m.fadeOut}" data-track-index="${m.track}"${m.automation ? ` data-automation="${esc(JSON.stringify({ version: 1, lanes: [{ target: "volume", points: m.automation }] }))}"` : ""}></audio>`,
  );
  const voiceTracks = selectedTracks.filter((a) => a.role === "voiceover");
  const narrationStem = voiceTracks.length
    ? path.join(outDir, "assets", "audio", "narration-stem.wav")
    : null;
  if (narrationStem)
    buildNarrationStem(voiceTracks, film.duration, narrationStem);
  const config = {
    captions: noCaptions ? [] : filmCaptions(film, lang, voiceTracks),
    cues: film.cues?.[lang] ?? {},
    words: filmWords(film, lang, voiceTracks),
    noCaptions,
    captionStyle: film.captionStyle ?? {},
    name: film.name,
    duration: film.duration,
    fps: film.fps,
    bpm: film.bpm,
    lang,
    format,
    copy: film.copy[lang],
    shots: film.shots,
    motionBlur: overlay ? { samples: 1, shutter: 0 } : (film.motionBlur ?? { samples: 1, shutter: 0 }),
    look: film.look ?? null,
    data: film.data ?? {},
    offset: range ? range.from : 0,
    guides,
    videos,
    assets,
    files,
    overlay,
  };
  // Declared files are fetched from the page's own folder (and decoders may compile WebAssembly).
  const loads = Object.keys(files).length > 0;
  fs.writeFileSync(
    path.join(outDir, "runtime.js"),
    fs.readFileSync(path.join(ROOT, "src", "film-runtime.js")),
  );
  fs.copyFileSync(
    path.join(ROOT, "src", "film-kit.js"),
    path.join(outDir, "kit.js"),
  );
  const customFaces = Object.keys(film.fonts ?? {}).map((family) => `@font-face{font-family:"${family}";src:url(assets/fonts/brand-${family}.woff2);font-weight:100 900}`).join("");
  fs.writeFileSync(
    path.join(outDir, "index.html"),
    `<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'${loads ? " 'wasm-unsafe-eval'" : ""}; style-src 'self' 'unsafe-inline'; connect-src ${loads ? "'self' data: blob:" : "'none'"}; object-src 'none'; frame-src 'none'; base-uri 'none'"><title>${esc(film.name)}</title><style>${customFaces}@font-face{font-family:Film Sans;src:url(assets/fonts/sans.woff2);font-weight:100 900}@font-face{font-family:Film Mono;src:url(assets/fonts/mono.woff2);font-weight:100 800}html,body{margin:0;background:${overlay ? "transparent" : "#151515"}}#root{width:100%;height:100%;overflow:hidden}canvas{display:block;width:100%;height:100%}</style></head><body><div id="root" data-composition-id="main" data-no-timeline data-width="${w}" data-height="${h}" data-duration="${range ? range.to - range.from : film.duration}"><canvas id="film-canvas" width="${w}" height="${h}"></canvas>${audio.join("")}</div><script id="film-config" type="application/json">${JSON.stringify(config).replace(/</g, "\\u003c")}</script>${scripts}<script src="kit.js"></script><script src="composition/draw.js"></script><script src="runtime.js"></script></body></html>`,
  );
  return {
    range,
    fmt,
    total: range ? range.to - range.from : film.duration,
    fps: film.fps,
    bpm: film.bpm,
    dir: outDir,
    fontSizes,
    lang,
    format,
    film: true,
    scenes: film.shots.map((s) => ({
      id: s.id,
      start: s.start,
      duration: s.end - s.start,
      vo: null,
    })),
    reviewTimes: film.shots.flatMap((s) => [
      s.start + Math.min(0.2, (s.end - s.start) / 4),
      (s.start + s.end) / 2,
      Math.max(s.start, s.end - 1 / film.fps),
    ]),
    narrationStem,
    narrationTracks: voiceTracks,
    narrationRequired: film.voiceover !== false,
    overlay,
    config,
    // the sound of this cut, for the native mix (src/mix.mjs)
    mix: mix.map((m) => ({ ...m, file: path.join(outDir, m.rel) })),
  };
}
