// Load and validate a brief. Every problem is reported with a JSON path, so a
// human or an agent can fix the brief without reading this file.
import fs from "node:fs";
import path from "node:path";

export const STYLES = ["promo", "explainer"];
export const FORMATS = { landscape: [1920, 1080], vertical: [1080, 1920] };
export const FPS_VALUES = [24, 25, 30, 60];
export const SCENE_TYPES = ["title", "terminal", "steps", "diagram", "features", "image", "video", "stat", "compare", "kinetic", "code", "html", "cta"];

/**
 * Problems in a custom HTML scene that break the rules every other scene keeps: no network,
 * and the same picture for the same frame on every render. Returns [{rule, match}].
 */
// Keep executable template interpolations while masking quoted display copy and
// comments. This is lint, not a sandbox; the page's CSP enforces local resources.
function executableSource(source) {
  let i = 0;
  const literals = [];
  const scan = (closing = false) => {
    let out = "", depth = 0;
    while (i < source.length) {
      const c = source[i], next = source[i + 1];
      if (c === "/" && next === "/") { while (i < source.length && source[i] !== "\n") i++; out += " "; continue; }
      if (c === "/" && next === "*") { i += 2; while (i < source.length && source.slice(i, i + 2) !== "*/") i++; i += 2; out += " "; continue; }
      if (c === "'" || c === '"' || c === "`") {
        const quote = c, before = out.slice(-120); i++;
        const start = i;
        while (i < source.length) {
          if (source[i] === "\\") { i += 2; continue; }
          if (source[i] === quote) { literals.push({ before, text: source.slice(start, i) }); i++; break; }
          if (quote === "`" && source.slice(i, i + 2) === "${") { i += 2; out += " " + scan(true) + " "; continue; }
          i++;
        }
        out += " "; continue;
      }
      i++;
      if (closing && c === "}" && depth-- === 0) break;
      if (c === "{") depth++;
      out += c;
    }
    return out;
  };
  return { code: scan(), literals };
}

export function lintCustomHtml(src, { javascript = false } = {}) {
  src = src.replace(/<!--[\s\S]*?-->/g, "");
  const { code, literals } = executableSource(javascript ? src : [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((m) => m[1]).join("\n") || src);
  const RULES = [
    ["network", /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon)\b/g],
    ["network", /\bimport\s*\(/g],
    ["nondeterministic", /\b(?:Date\.now|new\s+Date|performance\.now|Math\.random|crypto\.getRandomValues)\b/g],
    ["nondeterministic", /\b(?:setTimeout|setInterval|requestAnimationFrame|requestIdleCallback)\b/g],
  ];
  const out = [];
  for (const [rule, re] of RULES) for (const m of code.matchAll(re)) out.push({ rule, match: m[0] });
  // Resource sinks still reject remote literal URLs, including Image.src and CSS url().
  for (const literal of literals) if (/^(?:https?:)?\/\//i.test(literal.text) && /(?:\.src\s*=|\bimport|\bfrom|\b(?:fetch|WebSocket|EventSource)\s*\(|\.open\s*\([^,]*,)\s*$/.test(literal.before))
    out.push({ rule: "network", match: literal.text });
  if (!javascript) {
    const markup = src.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of markup.matchAll(/\b(?:src|href|srcset)\s*=\s*["'](?:https?:)?\/\/[^"'\s]+|\burl\(\s*["']?(?:https?:)?\/\/[^\s)"']+/gi)) out.push({ rule: "network", match: m[0] });
  }
  if (!javascript) for (const m of src.matchAll(/<\s*\/?\s*(?:html|head|body|base|meta|iframe|frame|object|embed)\b/gi)) out.push({rule:"structure",match:m[0]});
  return out;
}
export const TRANSITIONS = ["fade", "slide", "wipe", "zoom", "cut"];
// Layout variants per scene type (without one, each style picks its own default).
export const LAYOUTS = { title: ["center", "left", "split"], features: ["pills", "grid", "list"] };
const AUDIO_EXT = [".mp3", ".wav", ".m4a", ".aac", ".ogg"];
const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"];
const VIDEO_EXT = [".mp4", ".mov", ".webm", ".m4v"];
const num = (v, min = 0, max = Infinity) => Number.isFinite(v) && v >= min && v <= max;

/**
 * Highlights and zooms on an image or a video. Boxes are [x, y, width, height] in the
 * source's own pixels (validate prints the size); times are seconds from the moment the
 * media appears. Bounds against the real size are checked when the media is probed.
 */
function annotations(s, out, p, { r, text }) {
  const box = (v, bp) => {
    if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => num(n)) || v[2] <= 0 || v[3] <= 0) {
      r.error(bp, "[x, y, width, height] in the source's pixels, e.g. [120, 80, 400, 160]");
      return null;
    }
    return v;
  };
  out.highlights = (Array.isArray(s.highlights) ? s.highlights : s.highlights === undefined ? [] : (r.error(`${p}.highlights`, "an array of highlights"), [])).slice(0, 8).map((h, i) => {
    const hp = `${p}.highlights[${i}]`;
    if (!isObj(h)) return r.error(hp, '{"box": [x, y, w, h], "at": 1, "label": "…"}'), null;
    const at = h.at ?? 0.8;
    if (!num(at, 0, 120)) r.error(`${hp}.at`, "seconds from when the media appears");
    if (h.until !== undefined && !(num(h.until, 0, 120) && h.until > at)) r.error(`${hp}.until`, "seconds, later than at");
    return { box: box(h.box, `${hp}.box`), at, until: h.until, label: text(h.label, `${hp}.label`, { required: false, max: 40 }) };
  }).filter(Boolean);
  if (Array.isArray(s.highlights) && s.highlights.length > 8) r.error(`${p}.highlights`, "at most 8");
  out.zoom = (Array.isArray(s.zoom) ? s.zoom : s.zoom === undefined ? [] : (r.error(`${p}.zoom`, "an array of zooms"), [])).slice(0, 4).map((z, i) => {
    const zp = `${p}.zoom[${i}]`;
    if (!isObj(z)) return r.error(zp, '{"box": [x, y, w, h], "at": 2, "hold": 2}'), null;
    const at = z.at ?? 1;
    const hold = z.hold ?? 2;
    if (!num(at, 0, 120)) r.error(`${zp}.at`, "seconds from when the media appears");
    if (!num(hold, 0.3, 30)) r.error(`${zp}.hold`, "seconds to stay zoomed, 0.3 to 30");
    return { box: box(z.box, `${zp}.box`), at, hold };
  }).filter(Boolean);
  if (Array.isArray(s.zoom) && s.zoom.length > 4) r.error(`${p}.zoom`, "at most 4");
  const zs = [...out.zoom].sort((a, b) => a.at - b.at);
  for (let i = 1; i < zs.length; i++) if (zs[i].at < zs[i - 1].at + zs[i - 1].hold + 0.8) r.error(`${p}.zoom`, "zooms overlap: each needs to finish (at + hold + 0.8 s) before the next starts");
}
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
export const HEX_RE = /^#[0-9a-fA-F]{6}$/;
export const VO_ENGINES = ["azure", "edge"];
const VOICE_RE = /^[A-Za-z]{2,3}-[A-Za-z]{2,4}(-[A-Za-z]+)?-[A-Za-z0-9]+(Neural|MultilingualNeural|HDNeural)?$/;
const RATE_RE = /^[+-]\d{1,3}%$/;
const langsFor = (data) => (Array.isArray(data.languages) ? data.languages.filter((l) => typeof l === "string") : ["en"]);
// accent2: a second highlight color; panel: cards and terminals; dim: secondary text; border: outlines.
export const THEME_KEYS = ["accent", "accent2", "background", "panel", "text", "dim", "border"];
const FONT_EXT = [".ttf", ".otf", ".woff", ".woff2"];

/** WCAG contrast ratio of two #rrggbb colors. */
export function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
const TONES = ["ok", "warn", "dim", "error"];

class Report {
  constructor() {
    this.errors = [];
    this.warnings = [];
  }
  error(p, message) {
    this.errors.push({ path: p, message });
  }
  warn(p, message) {
    this.warnings.push({ path: p, message });
  }
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function readBrief(file) {
  const abs = path.resolve(file);
  let raw;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch (e) {
    throw new BriefError(`cannot read brief ${file}: ${e.code ?? e.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new BriefError(`${file} is not valid JSON: ${e.message}`);
  }
  return { data, dir: path.dirname(abs), file: abs };
}

export class BriefError extends Error {}

/**
 * Validate and normalize. Returns { brief, errors, warnings }; `brief` is only
 * safe to use when errors is empty.
 */
const BASES = new WeakMap();
const baseDirOf = (r) => BASES.get(r);

export function validateBrief(data, baseDir) {
  const r = new Report();
  BASES.set(r, baseDir);
  if (!isObj(data)) {
    r.error("$", "the brief must be a JSON object");
    return { brief: null, errors: r.errors, warnings: r.warnings };
  }
  const known = ["$schema", "version", "name", "style", "languages", "formats", "fps", "cover", "theme", "brand", "fonts", "music", "sfx", "voiceover", "product", "scenes"];
  for (const k of Object.keys(data)) if (!known.includes(k)) r.warn(`$.${k}`, `unknown field, ignored (known: ${known.join(", ")})`);

  if (data.version !== 1) r.error("$.version", "must be 1");
  const name = data.name ?? "video";
  if (typeof name !== "string" || !ID_RE.test(name)) r.error("$.name", "lowercase letters, digits and dashes, up to 40 characters (used in output file names)");
  const style = data.style ?? "promo";
  if (!STYLES.includes(style)) r.error("$.style", `must be one of: ${STYLES.join(", ")}`);

  const languages = data.languages ?? ["en"];
  // Plain-object lookups below use Object.hasOwn so "__proto__" or "toString" never pass as a value.
  if (!Array.isArray(languages) || languages.length === 0) r.error("$.languages", 'a non-empty array, e.g. ["zh", "en"]');
  else languages.forEach((l, i) => typeof l === "string" && LANG_RE.test(l) ? null : r.error(`$.languages[${i}]`, "a language code like zh, en or pt-BR"));
  if (Array.isArray(languages) && new Set(languages).size !== languages.length) r.error("$.languages", "contains duplicates");

  const formats = data.formats ?? ["landscape"];
  if (!Array.isArray(formats) || formats.length === 0) r.error("$.formats", `a non-empty array of: ${Object.keys(FORMATS).join(", ")}`);
  else {
    formats.forEach((f, i) => (typeof f === "string" && Object.hasOwn(FORMATS, f) ? null : r.error(`$.formats[${i}]`, `must be one of: ${Object.keys(FORMATS).join(", ")}`)));
    if (new Set(formats).size !== formats.length) r.error("$.formats", "contains duplicates");
  }

  const fps = data.fps ?? 30;
  if (!FPS_VALUES.includes(fps)) r.error("$.fps", `must be one of: ${FPS_VALUES.join(", ")}`);

  const rawTheme = data.theme ?? {};
  const theme = {}; // only validated keys survive; the rest never reaches the CSS
  if (!isObj(rawTheme)) r.error("$.theme", "must be an object");
  else
    for (const [k, v] of Object.entries(rawTheme)) {
      if (!THEME_KEYS.includes(k)) r.error(`$.theme.${k}`, `unknown theme key (known: ${THEME_KEYS.join(", ")})`);
      else if (typeof v !== "string" || !HEX_RE.test(v)) r.error(`$.theme.${k}`, 'a 6-digit hex color like "#7cf2b0"');
      else theme[k] = v;
    }

  const langs = Array.isArray(languages) ? languages.filter((l) => typeof l === "string") : [];
  const text = (v, p, { required = true, max = 400 } = {}) => {
    if (v === undefined || v === null) {
      if (required) r.error(p, "required");
      return undefined;
    }
    const out = {};
    if (typeof v === "string") for (const l of langs) out[l] = v;
    else if (isObj(v)) {
      for (const l of langs) {
        if (!Object.hasOwn(v, l) || typeof v[l] !== "string") r.error(`${p}.${l}`, `missing ${l} text (give a string for every language, or one plain string for all)`);
        else out[l] = v[l];
      }
    } else {
      r.error(p, 'a string, or an object of strings per language like {"zh": "…", "en": "…"}');
      return undefined;
    }
    for (const [l, s] of Object.entries(out)) if (s.length > max) r.error(`${p}.${l}`, `too long (${s.length} characters, max ${max})`);
    return out;
  };
  const file = (v, p, exts, kind) => {
    if (typeof v !== "string" || v.length === 0) {
      r.error(p, `a path to a local ${kind} file`);
      return undefined;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(v) && !/^[a-z]:[\\/]/i.test(v)) {
      r.error(p, `must be a local file, not a URL (rendering never touches the network); download it first`);
      return undefined;
    }
    const abs = path.resolve(baseDir, v);
    if (!exts.includes(path.extname(abs).toLowerCase())) r.error(p, `unsupported ${kind} type; use ${exts.join(", ")}`);
    else if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) r.error(p, `file not found: ${abs}`);
    return abs;
  };

  // Contrast: warn only, the style's own colors fill in what the theme leaves out.
  const STYLE_DEFAULTS = { promo: { background: "#0b0d12", text: "#e8ebf2", accent: "#7cf2b0" }, explainer: { background: "#f6f3ec", text: "#1d2330", accent: "#2f6fec" } };
  const eff = { ...(STYLE_DEFAULTS[style] ?? STYLE_DEFAULTS.promo), ...theme };
  if (contrast(eff.text, eff.background) < 4.5) r.warn("$.theme.text", `text on background has contrast ${contrast(eff.text, eff.background).toFixed(1)}:1; under 4.5:1 is hard to read`);
  if (contrast(eff.accent, eff.background) < 3) r.warn("$.theme.accent", `accent on background has contrast ${contrast(eff.accent, eff.background).toFixed(1)}:1; under 3:1 headings in the accent color are hard to read`);

  const brand = {};
  if (data.brand !== undefined) {
    if (!isObj(data.brand)) r.error("$.brand", 'an object like {"logo": "logo.svg"}');
    else {
      if (data.brand.logo !== undefined) brand.logo = file(data.brand.logo, "$.brand.logo", [".svg", ".png", ".webp", ".jpg", ".jpeg"], "logo");
      brand.corner = data.brand.corner ?? false;
      if (typeof brand.corner !== "boolean") r.error("$.brand.corner", "true shows the logo small in a corner of every scene");
      if (brand.corner && !brand.logo) r.error("$.brand.logo", "corner needs a logo");
    }
  }

  // Fonts the user brings: each needs its license file, which travels with the subset.
  const fonts = {};
  if (data.fonts !== undefined) {
    if (!isObj(data.fonts)) r.error("$.fonts", 'an object like {"sans": {"file": "Brand.ttf", "license": "OFL.txt"}}');
    else
      for (const [k, v] of Object.entries(data.fonts)) {
        const fp = `$.fonts.${k}`;
        if (!["sans", "mono"].includes(k)) r.error(fp, "only sans (headings and text) and mono (terminals and code)");
        else if (!isObj(v)) r.error(fp, '{"file": "Brand.ttf", "license": "LICENSE.txt"}');
        else {
          const f = file(v.file, `${fp}.file`, FONT_EXT, "font");
          const lic = v.license === undefined ? (r.error(`${fp}.license`, "the font's license text file; it is copied next to the font in every build, and you are responsible for the font allowing this use"), undefined) : file(v.license, `${fp}.license`, [".txt", ".md", ""], "license");
          fonts[k] = { file: f, license: lic };
        }
      }
  }

  let music = data.music ?? "builtin";
  if (music === "builtin" || music === "none") music = { kind: music, volume: 0.5 };
  else if (isObj(music)) {
    const volume = music.volume ?? 0.5;
    if (!Number.isFinite(volume) || volume < 0 || volume > 2) r.error("$.music.volume", "a number from 0 to 2");
    music = { kind: "file", file: file(music.file, "$.music.file", AUDIO_EXT, "audio"), volume };
  } else r.error("$.music", '"builtin", "none", or {"file": "path", "volume": 0.5}');

  const cover = data.cover ?? "first-scene";
  if (!["first-scene", "animate"].includes(cover)) r.error("$.cover", '"first-scene" (frame 0 shows the finished first scene) or "animate" (it animates in from an empty frame)');

  const sfx = data.sfx ?? true;
  if (typeof sfx !== "boolean") r.error("$.sfx", "true or false");

  const vo = data.voiceover ?? null;
  let voiceover = null;
  if (vo !== null) {
    if (!isObj(vo)) r.error("$.voiceover", 'an object like {"dir": "voiceover"}');
    else {
      const volume = vo.volume ?? 1;
      if (!Number.isFinite(volume) || volume < 0 || volume > 3) r.error("$.voiceover.volume", "a number from 0 to 3");
      let dir = null;
      if (vo.dir !== undefined) {
        if (typeof vo.dir !== "string") r.error("$.voiceover.dir", "a directory path");
        else {
          dir = path.resolve(baseDir, vo.dir);
          if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) r.error("$.voiceover.dir", `directory not found: ${dir}`);
        }
      }
      // Generated narration (`motion-use voiceover`): engine, voice per language, speaking rate.
      const engine = vo.engine ?? null;
      if (engine !== null && !VO_ENGINES.includes(engine)) r.error("$.voiceover.engine", `one of: ${VO_ENGINES.join(", ")}`);
      const voices = {};
      if (vo.voices !== undefined) {
        if (!isObj(vo.voices)) r.error("$.voiceover.voices", 'an object of voice names per language, like {"zh": "zh-CN-YunxiNeural"}');
        else
          for (const [l, v] of Object.entries(vo.voices)) {
            if (typeof v !== "string" || !VOICE_RE.test(v)) r.error(`$.voiceover.voices.${l}`, 'a voice name like "zh-CN-YunxiNeural"');
            else voices[l] = v;
          }
      }
      const rates = {};
      if (vo.rate !== undefined) {
        const one = typeof vo.rate === "string";
        const entries = one ? langsFor(data).map((l) => [l, vo.rate]) : isObj(vo.rate) ? Object.entries(vo.rate) : null;
        if (!entries) r.error("$.voiceover.rate", 'a rate like "+8%", or one per language like {"zh": "+8%"}');
        else for (const [l, v] of entries) typeof v === "string" && RATE_RE.test(v) ? (rates[l] = v) : r.error(one ? "$.voiceover.rate" : `$.voiceover.rate.${l}`, 'a percentage like "+8%" or "-5%"');
      }
      let say = {};
      if (vo.say !== undefined) {
        if (!isObj(vo.say) || Object.entries(vo.say).some(([k, v]) => !k.length || typeof v !== "string"))
          r.error("$.voiceover.say", 'an object mapping non-empty strings to strings, like {"有数": "有树"}');
        else say = { ...vo.say };
      }
      const required=vo.required ?? (Array.isArray(data.scenes)&&data.scenes.some(s=>s?.narration));
      if(typeof required!=="boolean")r.error("$.voiceover.required","true or false; false is only for deliberately unnarrated output");
      voiceover = { dir, volume, engine, voices, rates, say, required };
    }
  }

  const product = data.product ?? {};
  if (!isObj(product)) r.error("$.product", "must be an object");

  const scenes = [];
  if (!Array.isArray(data.scenes) || data.scenes.length === 0) r.error("$.scenes", "a non-empty array of scenes");
  else if (data.scenes.length > 20) r.error("$.scenes", "at most 20 scenes");
  else {
    const ids = new Set();
    data.scenes.forEach((s, i) => {
      const p = `$.scenes[${i}]`;
      if (!isObj(s)) return r.error(p, "must be an object");
      const id = s.id ?? `scene-${i + 1}`;
      if (typeof id !== "string" || !ID_RE.test(id)) r.error(`${p}.id`, "lowercase letters, digits and dashes");
      else if (ids.has(id)) r.error(`${p}.id`, `duplicate id "${id}"`);
      ids.add(id);
      if (!SCENE_TYPES.includes(s.type)) return r.error(`${p}.type`, `must be one of: ${SCENE_TYPES.join(", ")}`);
      const scene = { id, type: s.type };
      if (s.duration !== undefined) {
        if (!Number.isFinite(s.duration) || s.duration < 1 || s.duration > 60) r.error(`${p}.duration`, "seconds, from 1 to 60");
        else scene.duration = s.duration;
      }
      if (s.voiceover !== undefined) {
        if (!isObj(s.voiceover)) r.error(`${p}.voiceover`, 'an object of audio paths per language, like {"zh": "vo/zh/hook.mp3"}');
        else {
          scene.voiceover = {};
          for (const [l, f] of Object.entries(s.voiceover)) {
            if (!langs.includes(l)) r.warn(`${p}.voiceover.${l}`, `language ${l} is not in $.languages, ignored`);
            else scene.voiceover[l] = file(f, `${p}.voiceover.${l}`, AUDIO_EXT, "audio");
          }
        }
      }
      scene.narration = text(s.narration, `${p}.narration`, { required: false, max: 600 });
      scene.transition = s.transition ?? "fade";
      if (!TRANSITIONS.includes(scene.transition)) r.error(`${p}.transition`, `one of: ${TRANSITIONS.join(", ")} (how this scene comes in)`);
      const layouts = Object.hasOwn(LAYOUTS, s.type) ? LAYOUTS[s.type] : null;
      if (s.layout !== undefined && !layouts) r.error(`${p}.layout`, `${s.type} scenes have one layout; layouts exist for: ${Object.keys(LAYOUTS).join(", ")}`);
      else if (s.layout !== undefined && !layouts.includes(s.layout)) r.error(`${p}.layout`, `one of: ${layouts.join(", ")}`);
      scene.layout = layouts ? s.layout ?? null : undefined; // null: the style's default
      SCENE_FIELDS[s.type](s, scene, p, { r, text, file });
      scenes.push(scene);
    });
  }

  // Find voiceover files by convention: <dir>/<lang>/<scene-id>.<ext>
  if (voiceover?.dir && fs.existsSync(voiceover.dir) && fs.statSync(voiceover.dir).isDirectory()) {
    for (const scene of scenes) {
      for (const l of langs) {
        if (scene.voiceover?.[l]) continue;
        const hit = AUDIO_EXT.map((e) => path.join(voiceover.dir, l, scene.id + e)).find((f) => fs.existsSync(f));
        if (hit) (scene.voiceover ??= {})[l] = hit;
      }
    }
    for (const l of langs) {
      const n = scenes.filter((s) => s.voiceover?.[l]).length;
      if (n === 0) r.warn("$.voiceover.dir", `no voiceover for ${l} yet (optional); to add it, put ${path.join(voiceover.dir, l, "<scene-id>.mp3")}`);
      else if (n < scenes.length) r.warn("$.voiceover.dir", `${l}: ${scenes.length - n} of ${scenes.length} scenes have no voiceover file`);
    }
  }

  const brief = { version: 1, name, style, languages: langs, formats, fps, cover, theme, brand, fonts, music, sfx, voiceover, product: isObj(product) ? product : {}, scenes };
  return { brief, errors: r.errors, warnings: r.warnings };
}

const arr = (v, p, r, min, max, what) => {
  if (!Array.isArray(v)) {
    r.error(p, `an array of ${what}`);
    return [];
  }
  if (v.length < min || v.length > max) r.error(p, `${min} to ${max} ${what}`);
  return v.slice(0, max);
};

const SCENE_FIELDS = {
  title(s, out, p, { r, text, file }) {
    out.title = text(s.title, `${p}.title`, { max: 120 });
    out.subtitle = text(s.subtitle, `${p}.subtitle`, { required: false, max: 160 });
    if (s.image !== undefined) out.image = file(s.image, `${p}.image`, IMAGE_EXT, "image");
    if (s.layout === "split" && s.image === undefined) r.error(`${p}.image`, 'the "split" layout shows an image next to the title; add one');
  },
  stat(s, out, p, { r, text }) {
    out.title = text(s.title, `${p}.title`, { required: false, max: 120 });
    out.value = text(s.value, `${p}.value`, { max: 16 });
    out.label = text(s.label, `${p}.label`, { max: 80 });
    out.note = text(s.note, `${p}.note`, { required: false, max: 160 });
    if (s.count !== undefined && typeof s.count !== "boolean") r.error(`${p}.count`, "true counts the number up from 0 (default when the value contains an integer)");
    out.count = s.count ?? true;
  },
  compare(s, out, p, { r, text, file }) {
    out.title = text(s.title, `${p}.title`, { required: false, max: 120 });
    for (const side of ["left", "right"]) {
      const v = s[side];
      const sp = `${p}.${side}`;
      if (!isObj(v)) {
        r.error(sp, '{"label": "Before", "points": ["…"]} (and/or "image")');
        continue;
      }
      out[side] = {
        label: text(v.label, `${sp}.label`, { max: 30 }),
        points: (v.points === undefined ? [] : arr(v.points, `${sp}.points`, r, 1, 5, "points")).map((x, i) => text(x, `${sp}.points[${i}]`, { max: 60 })),
        image: v.image === undefined ? undefined : file(v.image, `${sp}.image`, IMAGE_EXT, "image"),
      };
      if (v.points === undefined && v.image === undefined) r.error(sp, 'give "points", an "image", or both');
    }
    if (s.verdict !== undefined && !["left", "right", "none"].includes(s.verdict)) r.error(`${p}.verdict`, '"right" (default: the right side is the better one), "left" or "none"');
    out.verdict = s.verdict ?? "right";
  },
  kinetic(s, out, p, { r, text }) {
    out.lines = arr(s.lines, `${p}.lines`, r, 1, 6, "lines").map((x, i) => text(x, `${p}.lines[${i}]`, { max: 40 }));
    out.beat = s.beat ?? 0.7;
    if (!(Number.isFinite(out.beat) && out.beat >= 0.25 && out.beat <= 3)) r.error(`${p}.beat`, "seconds between lines, 0.25 to 3");
  },
  code(s, out, p, { r, text }) {
    out.title = text(s.title, `${p}.title`, { required: false, max: 120 });
    out.file = text(s.file, `${p}.file`, { required: false, max: 60 });
    out.lines = arr(s.lines, `${p}.lines`, r, 1, 16, "lines").map((line, i) => {
      const lp = `${p}.lines[${i}]`;
      if (typeof line === "string") return { kind: "ctx", text: text(line, lp, { max: 120 }) };
      if (!isObj(line)) return r.error(lp, 'a string, or {"add": "…"} / {"del": "…"}'), null;
      const kinds = ["add", "del", "ctx"].filter((k) => line[k] !== undefined);
      if (kinds.length !== 1) return r.error(lp, 'exactly one of "add", "del" or "ctx"'), null;
      return { kind: kinds[0], text: text(line[kinds[0]], `${lp}.${kinds[0]}`, { max: 120 }) };
    }).filter(Boolean);
  },
  terminal(s, out, p, { r, text }) {
    out.title = text(s.title, `${p}.title`, { required: false, max: 120 });
    const panes = arr(s.panes ?? [{ label: "Terminal" }], `${p}.panes`, r, 1, 2, "panes");
    out.panes = panes.map((pane, i) => ({
      label: text(pane?.label, `${p}.panes[${i}].label`, { max: 40 }),
      // What precedes a typed line: "$" for a shell, ">" for an agent chat like Claude Code.
      prompt: pane?.prompt === undefined ? "$" : typeof pane.prompt === "string" && pane.prompt.length <= 3 ? pane.prompt : (r.error(`${p}.panes[${i}].prompt`, 'up to 3 characters, e.g. "$" or ">"'), "$"),
      accent: pane?.accent !== undefined && !HEX_RE.test(pane.accent) ? (r.error(`${p}.panes[${i}].accent`, "a 6-digit hex color"), undefined) : pane?.accent,
    }));
    out.lines = arr(s.lines, `${p}.lines`, r, 1, 14, "lines").map((line, i) => {
      const lp = `${p}.lines[${i}]`;
      if (!isObj(line)) return r.error(lp, '{"cmd": "…"} or {"out": "…"}'), null;
      const pane = line.pane ?? 0;
      if (!Number.isInteger(pane) || pane < 0 || pane >= out.panes.length) r.error(`${lp}.pane`, `0${out.panes.length > 1 ? " or 1" : ""}`);
      if ((line.cmd === undefined) === (line.out === undefined)) return r.error(lp, 'exactly one of "cmd" (typed command) or "out" (printed output)'), null;
      const tone = line.tone ?? (line.cmd !== undefined ? undefined : "ok");
      if (tone !== undefined && !TONES.includes(tone)) r.error(`${lp}.tone`, `one of: ${TONES.join(", ")}`);
      return line.cmd !== undefined
        ? { pane, kind: "cmd", text: text(line.cmd, `${lp}.cmd`, { max: 160 }) }
        : { pane, kind: "out", tone, text: text(line.out, `${lp}.out`, { max: 200 }) };
    }).filter(Boolean);
  },
  steps(s, out, p, { r, text }) {
    out.title = text(s.title, `${p}.title`, { max: 120 });
    out.steps = arr(s.steps, `${p}.steps`, r, 2, 6, "steps").map((st, i) =>
      isObj(st)
        ? { title: text(st.title, `${p}.steps[${i}].title`, { max: 60 }), body: text(st.body, `${p}.steps[${i}].body`, { required: false, max: 140 }) }
        : { title: text(st, `${p}.steps[${i}]`, { max: 60 }) },
    );
  },
  diagram(s, out, p, { r, text }) {
    out.title = text(s.title, `${p}.title`, { max: 120 });
    const ids = new Set();
    out.nodes = arr(s.nodes, `${p}.nodes`, r, 2, 5, "nodes").map((n, i) => {
      const np = `${p}.nodes[${i}]`;
      if (!isObj(n)) return r.error(np, '{"id": "…", "label": "…"}'), null;
      if (typeof n.id !== "string" || !ID_RE.test(n.id)) r.error(`${np}.id`, "lowercase letters, digits and dashes");
      else if (ids.has(n.id)) r.error(`${np}.id`, `duplicate node id "${n.id}"`);
      ids.add(n.id);
      return { id: n.id, label: text(n.label, `${np}.label`, { max: 40 }), note: text(n.note, `${np}.note`, { required: false, max: 60 }) };
    }).filter(Boolean);
    out.edges = arr(s.edges ?? [], `${p}.edges`, r, 0, 8, "edges").map((e, i) => {
      const ep = `${p}.edges[${i}]`;
      if (!isObj(e)) return r.error(ep, '{"from": "<node id>", "to": "<node id>"}'), null;
      for (const k of ["from", "to"]) if (!ids.has(e[k])) r.error(`${ep}.${k}`, `unknown node id "${e[k]}"`);
      if (e.from === e.to) r.error(ep, "an edge needs two different nodes");
      return { from: e.from, to: e.to, label: text(e.label, `${ep}.label`, { required: false, max: 30 }) };
    }).filter(Boolean);
  },
  features(s, out, p, { r, text }) {
    out.title = text(s.title, `${p}.title`, { max: 120 });
    out.subtitle = text(s.subtitle, `${p}.subtitle`, { required: false, max: 160 });
    out.items = arr(s.items, `${p}.items`, r, 1, 6, "items").map((it, i) => text(it, `${p}.items[${i}]`, { max: 40 }));
  },
  image(s, out, p, ctx) {
    const { text, file } = ctx;
    out.title = text(s.title, `${p}.title`, { required: false, max: 120 });
    out.caption = text(s.caption, `${p}.caption`, { required: false, max: 160 });
    out.image = file(s.image, `${p}.image`, IMAGE_EXT, "image");
    annotations(s, out, p, ctx);
  },
  video(s, out, p, ctx) {
    const { r, text, file } = ctx;
    out.title = text(s.title, `${p}.title`, { required: false, max: 120 });
    out.caption = text(s.caption, `${p}.caption`, { required: false, max: 160 });
    out.video = file(s.video, `${p}.video`, VIDEO_EXT, "video");
    out.start = s.start ?? 0;
    if (!num(out.start, 0, 3600)) r.error(`${p}.start`, "seconds into the clip to start from");
    if (s.length !== undefined && !num(s.length, 0.5, 120)) r.error(`${p}.length`, "seconds of the clip to show, 0.5 to 120");
    out.length = s.length;
    out.speed = s.speed ?? 1;
    if (!num(out.speed, 0.25, 4)) r.error(`${p}.speed`, "playback speed, 0.25 to 4");
    out.audio = s.audio ?? false;
    if (typeof out.audio !== "boolean") r.error(`${p}.audio`, "true keeps the clip's own sound (default false: music and narration only)");
    annotations(s, out, p, ctx);
  },
  html(s, out, p, { r, file }) {
    out.file = file(s.file, `${p}.file`, [".html", ".htm"], "HTML fragment");
    if (!Number.isFinite(s.duration)) r.error(`${p}.duration`, "required for an html scene: seconds, 1 to 60 (motion-use cannot tell how long your animation runs)");
    // Its folder is copied into every build, so it must be a folder of its own.
    if (out.file && path.resolve(path.dirname(out.file)) === path.resolve(baseDirOf(r))) r.error(`${p}.file`, "put the fragment and its files in a folder of their own (e.g. scenes/intro/intro.html); that whole folder is copied into the build");
    if (out.file && fs.existsSync(out.file)) {
      const src = fs.readFileSync(out.file, "utf8");
      if (src.length > 200000) r.error(`${p}.file`, "larger than 200 KB; keep a scene fragment small and put media in files next to it");
      for (const issue of lintCustomHtml(src)) {
        const why = { network: "rendering never touches the network; use local files", nondeterministic: "use CSS animation with animation-delay instead (seconds from the scene start), so every frame is reproducible", structure: "write a fragment (the scene's contents), not a full document or embedded frame" }[issue.rule];
        r.error(`${p}.file`, `${issue.rule}: "${issue.match}": ${why}`);
      }
    }
  },
  cta(s, out, p, { text }) {
    out.title = text(s.title, `${p}.title`, { max: 40 });
    out.subtitle = text(s.subtitle, `${p}.subtitle`, { required: false, max: 160 });
    out.command = text(s.command, `${p}.command`, { required: false, max: 120 });
    out.url = text(s.url, `${p}.url`, { required: false, max: 80 });
  },
};

/** Visible text of custom HTML scenes (tags, styles and scripts removed), for font subsetting. */
export function customText(brief) {
  return brief.scenes
    .filter((s) => s.type === "html" && s.file && fs.existsSync(s.file))
    .map((s) => fs.readFileSync(s.file, "utf8").replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, " "))
    .join("\n");
}

/** Every string in the brief that will be drawn for these languages (for font subsetting and coverage checks). */
export function collectText(brief, langs = brief.languages) {
  const out = [];
  const walk = (v) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (isObj(v)) {
      const keys = Object.keys(v);
      if (keys.length && keys.every((k) => brief.languages.includes(k)) && keys.every((k) => typeof v[k] === "string")) {
        for (const l of langs) if (v[l]) out.push(v[l]);
        return;
      }
      for (const [k, val] of Object.entries(v)) if (!["id", "type", "image", "video", "box", "voiceover", "narration", "transition", "layout", "verdict", "accent", "kind", "tone", "from", "to", "pane"].includes(k)) walk(val);
    }
  };
  walk(brief.scenes);
  return out.join("\n");
}
