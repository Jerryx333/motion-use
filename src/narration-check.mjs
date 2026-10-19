// Narration check: transcribe each generated voiceover clip and compare it with its script.
// TTS misreads that no reviewer heard in the iphone-use promo (2026-10): "AI" spoken as
// "A-A-I", and 重试 read zhòng shì so it came back as 重视. Speech recognition catches both.
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CJK = /[㐀-鿿]/;
const LATIN = /[a-z0-9]/;

/**
 * Comparable tokens: Chinese/Japanese characters one by one, Latin words and acronyms whole.
 * Punctuation, hyphens and spaces go ("A I", "A-A-I" and "AI" all become one token), case folds.
 * Each token keeps whether it was written as an acronym (2–6 capitals).
 */
export function tokenize(text, lang) {
  const cjkText = lang?.startsWith("zh") || lang?.startsWith("ja") || CJK.test(text);
  const tokens = [];
  if (cjkText) {
    // Spaces inside Latin runs carry no meaning in Chinese text ("A I" is the TTS spelling of AI).
    const s = text.normalize("NFKC").replace(/\s+/g, "");
    let latin = "",
      raw = "";
    const flush = () => {
      if (latin) tokens.push({ t: latin, latin: true, acronym: /^[A-Z]{2,6}$/.test(raw) });
      latin = raw = "";
    };
    for (const ch of s) {
      if (CJK.test(ch)) {
        flush();
        tokens.push({ t: ch, latin: false });
      } else if (/[\p{L}\p{N}]/u.test(ch)) {
        latin += ch.toLowerCase();
        raw += ch;
      } else if (/[-.'’·]/.test(ch) && latin) continue; // A-A-I, A.I.
      else flush();
    }
    flush();
    return tokens;
  }
  for (const w of text.normalize("NFKC").split(/\s+/)) {
    const raw = w.replace(/[^\p{L}\p{N}'’-]/gu, "");
    const t = raw.replace(/['’-]/g, "").toLowerCase();
    if (t) tokens.push({ t, latin: true, acronym: /^[A-Z]{2,6}$/.test(raw) });
  }
  return tokens;
}

/** Token-level edit script: [{op: "=", a, b} | {op: "~", a, b} | {op: "-", a} | {op: "+", b}]. */
function align(A, B) {
  const n = A.length,
    m = B.length,
    d = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i ? (j ? 0 : i) : j)));
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (A[i - 1].t === B[j - 1].t ? 0 : 1));
  const ops = [];
  let i = n,
    j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (A[i - 1].t === B[j - 1].t ? 0 : 1)) {
      ops.push({ op: A[i - 1].t === B[j - 1].t ? "=" : "~", a: A[i - 1], b: B[j - 1], i: i - 1 });
      i--, j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) ops.push({ op: "-", a: A[--i], i });
    else ops.push({ op: "+", b: B[--j], i });
  }
  return { ops: ops.reverse() };
}

const sameSound = (x, y, chars) => {
  const a = chars[x],
    b = chars[y];
  return Boolean(a && b && a.some((r) => b.includes(r)));
};
// With tones (TONE3 from pypinyin), a homophone must share a reading tone and all: 奉 fèng heard
// 凤 fèng is spelling, 买 mǎi heard 卖 mài is a misreading. Caches from before tones fall back
// to toneless readings.
const sameTone = (x, y, tones) => (tones[x] && tones[y] ? tones[x].some((r) => tones[y].includes(r)) : true);

// Neighbouring sounds (霖 lín heard 陵 líng, 蒋 jiǎng heard 抢 qiǎng, 卢 lú heard 如 rú): one
// consonant from the same group, or a front and back nasal (in/ing, an/ang). Whisper often hears
// names this way, but a voice can also really say them wrong, so they stay flagged; the kind
// "near" tells the reviewer to listen rather than to assume a different word.
const INITIALS = ["zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x", "r", "z", "c", "s", "y", "w"];
const NEAR_INITIALS = [["l", "r", "n"], ["j", "q"], ["g", "k"], ["z", "zh"], ["c", "ch"], ["s", "sh"]];
const PARTICLES = "的了地得着";
const splitReading = (r) => {
  const i = INITIALS.find((p) => r.startsWith(p)) ?? "";
  return [i, r.slice(i.length)];
};
function nearReading(a, b) {
  const [ia, fa] = splitReading(a),
    [ib, fb] = splitReading(b);
  if (ia === ib) return fa !== fb && fa.replace(/g$/, "") === fb.replace(/g$/, "");
  return fa === fb && NEAR_INITIALS.some((g) => g.includes(ia) && g.includes(ib));
}
const nearSound = (x, y, chars) =>
  (PARTICLES.includes(x) && PARTICLES.includes(y)) || Boolean(chars[x]?.some((a) => chars[y]?.some((b) => nearReading(a, b))));

// Chinese numerals as a number: 两百六十八 → 268, 一百五十 → 150, 一九一二 → 1912.
const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS = { 十: 10, 百: 100, 千: 1000 };
const CN_NUMBER = /^[零〇一二两三四五六七八九十百千万亿]+$/;
export function chineseNumber(s) {
  // Apply the largest unit first: 一万亿 is 10000 × 亿, not 10000 + 0 × 亿.
  for (const [unit, scale] of [["亿", 1e8], ["万", 1e4]]) {
    const at = s.indexOf(unit);
    if (at >= 0) return chineseNumber(s.slice(0, at) || "一") * scale + chineseNumber(s.slice(at + 1) || "零");
  }
  const cs = [...s];
  if (!cs.some((c) => c in CN_UNITS || c === "万" || c === "亿")) return Number(cs.map((c) => CN_DIGITS[c]).join(""));
  let total = 0,
    section = 0,
    num = 0;
  for (const c of cs) {
    if (c in CN_DIGITS) num = CN_DIGITS[c];
    else if (c in CN_UNITS) ((section += (num || 1) * CN_UNITS[c]), (num = 0));
    else ((total += (section + num) * (c === "万" ? 1e4 : 1e8)), (section = 0), (num = 0));
  }
  return total + section + num;
}

export const COMPARATOR_VERSION = "2";

// Keep quantities, operations and negation separate. A recognizer's "56" is never
// interpreted as "5 是 6", and homophone tolerance cannot erase a minus or a 不.
export function mathSignature(text, lang) {
  // Preserve ASCII arithmetic without treating acronym hyphens (A-A-I) as minus.
  const s = text.normalize("NFKC").toLowerCase()
    .replace(/([0-9零〇一二两三四五六七八九十百千万亿])\s*([-*/])\s*(?=[0-9零〇一二两三四五六七八九十百千万亿])/g,
      (_, left, op) => left + ({ "-": "减", "*": "乘", "/": "除" })[op])
    .replace(/(^|[=:(，。,：])\s*-\s*(?=\d)/g, "$1负");
  const tokens = s.match(/[零〇一二两三四五六七八九十百千万亿]+|\d+(?:\.\d+)?|负|加|减|乘|除|等于|不是|不|没|无|未|别|[+−×÷=]|\b(?:not|no|never|without)\b/g) ?? [];
  const ops = { 加: "+", 减: "-", "−": "-", 乘: "*", "×": "*", 除: "/", "÷": "/", 等于: "=", 不是: "不", 没: "不", 无: "不", 未: "不", 别: "不" };
  return tokens.map((t) => CN_NUMBER.test(t) ? `n:${chineseNumber(t)}` : /^\d/.test(t) ? `n:${Number(t)}` : ops[t] ?? t);
}

/**
 * Compare a script line with what speech recognition heard.
 * `lexicon.chars` maps CJK characters to their toneless readings and `lexicon.phrases` lists
 * dictionary words (both come from pypinyin; tests pass small hand-made tables).
 * Returns { similarity, flagged, changes: [{expected, heard, kind, flag}] }.
 * Kinds: acronym/latin (a Latin word read differently), polyphone (a homophone substitution
 * that forms a word with a many-reading neighbour: 重试 → 重视), homophone (ASR spelling only:
 * 它 → 他), word (different sound), missing/extra.
 */
export function compareNarration(script, heard, lang, { chars = {}, tones = {}, phrases = [], threshold = 0.8 } = {}) {
  const A = tokenize(script, lang),
    B = tokenize(heard, lang);
  const { ops } = align(A, B);
  const phraseSet = new Set(phrases);
  const changes = [];
  for (let k = 0; k < ops.length; ) {
    if (ops[k].op === "=") {
      k++;
      continue;
    }
    const start = k;
    while (k < ops.length && ops[k].op !== "=") k++;
    const run = ops.slice(start, k);
    const exp = run.filter((o) => o.a).map((o) => o.a),
      got = run.filter((o) => o.b).map((o) => o.b);
    const join = (ts) => ts.map((x) => x.t).join(CJK.test(ts[0]?.t ?? "") ? "" : " ");
    const change = { expected: join(exp), heard: join(got) };
    const prev = ops[start - 1]?.op === "=" ? ops[start - 1].b.t : "",
      next = ops[k]?.op === "=" ? ops[k].b.t : "";
    const expText = exp.map((x) => x.t).join(""),
      gotText = got.map((x) => x.t).join("");
    if (expText === gotText) {
      change.kind = "spelling"; // "API" heard as "A P I": the same letters
      change.flag = false;
    } else if (exp.length && got.length && CN_NUMBER.test(expText) && got.every((x) => /^\d+$/.test(x.t))) {
      // 两百六十八 written as 268 by the recognizer: the same number, unless the values differ.
      change.kind = "number";
      change.flag = chineseNumber(expText) !== Number(gotText);
    } else if ([...exp, ...got].some((x) => x.latin)) {
      const acronym = exp.some((x) => x.acronym);
      change.kind = acronym ? "acronym" : "latin";
      // A number written in digits and spoken in words is not a misreading. In a Latin-script
      // language a single word heard differently is usually the recognizer, not the voice:
      // only acronyms are flagged there, the rest counts against the line's similarity.
      const digits = exp.every((x) => /^\d+$/.test(x.t)) && got.every((x) => !x.latin);
      const latinLine = !A.some((x) => !x.latin);
      change.flag = acronym || (!digits && !latinLine);
    } else if (exp.length && exp.length === got.length) {
      const toneless = exp.every((x, i) => sameSound(x.t, got[i].t, chars));
      const homophone = toneless && exp.every((x, i) => sameTone(x.t, got[i].t, tones));
      const near = !toneless && exp.every((x, i) => sameSound(x.t, got[i].t, chars) || nearSound(x.t, got[i].t, chars));
      if (toneless && !homophone) {
        change.kind = "tone";
        change.flag = true;
      } else if (homophone) {
        // The heard word exists in the dictionary and the script puts a many-reading character
        // in it: the voice most likely read that character the wrong way (重试 spoken zhòng shì →
        // 重视). The many-reading character must be the script's own neighbour: 帝制 heard 地质 is
        // ASR spelling, the heard 地 being many-reading proves nothing.
        const multi = (c) => (chars[c]?.length ?? 0) > 1;
        const word = prev + change.heard + next;
        const words = [];
        for (let n = 2; n <= 3; n++)
          for (let i = 0; i + n <= word.length; i++) words.push(word.slice(i, i + n));
        // Comparing readings in context does not help: pypinyin itself reads 重试 as zhòng shì.
        const polyphone = words.some(
          (w) => phraseSet.has(w) && w.includes(change.heard) && ((prev && w.startsWith(prev) && multi(prev)) || (next && w.endsWith(next) && multi(next))),
        );
        change.kind = polyphone ? "polyphone" : "homophone";
        change.flag = polyphone;
      } else if (near) {
        change.kind = "near";
        change.flag = true;
      } else {
        change.kind = "word";
        change.flag = true;
      }
    } else if (!got.length) {
      change.kind = "missing";
      change.flag = exp.length > 1;
    } else if (!exp.length) {
      change.kind = "extra";
      change.flag = got.length > 1;
    } else {
      change.kind = "word";
      change.flag = true;
    }
    // The same sound (tone included when known) or the same number costs nothing.
    if (change.cost === undefined)
      change.cost = ["spelling", "homophone"].includes(change.kind) || (change.kind === "number" && !change.flag) ? 0 : Math.max(exp.length, got.length);
    changes.push(change);
  }
  // Edit cost per changed run; a spelled-out acronym costs nothing.
  const cost = changes.reduce((s, c) => s + c.cost, 0);
  for (const c of changes) delete c.cost;
  const expectedMath = mathSignature(script, lang), heardMath = mathSignature(heard, lang);
  if (JSON.stringify(expectedMath) !== JSON.stringify(heardMath)) {
    changes.push({ expected: expectedMath.join(" "), heard: heardMath.join(" "), kind: "math", flag: true });
  }
  const similarity = +Math.max(0, 1 - cost / Math.max(A.length, 1)).toFixed(3);
  return {
    similarity,
    flagged: similarity < threshold || changes.some((c) => c.flag),
    changes,
  };
}

/** Narration clips with their scripts, for films (shots/narration) and template briefs (scenes). */
export function narrationItems(project) {
  const items = [];
  const plans = project.narrationPlans ?? project.scenes ?? [];
  const dir = project.narrationConfig?.dir ?? project.voiceover?.dir;
  if (!dir) return items;
  for (const p of plans)
    for (const [lang, text] of Object.entries(p.narration ?? {})) {
      if (typeof text !== "string" || !text.trim()) continue;
      const selected = project.tracks?.find((a) => a.role === "voiceover" && a.id === p.id && (!a.lang || a.lang === lang))?.file ?? p.voiceover?.[lang];
      const file = selected ?? [".wav", ".m4a", ".aac", ".ogg", ".mp3"].map((e) => path.join(dir, lang, p.id + e)).find((f) => fs.existsSync(f));
      if (file) items.push({ id: p.id, lang, text, file, ...(project.narrationReviews?.[`${lang}/${p.id}`] ? { review: project.narrationReviews[`${lang}/${p.id}`] } : {}) });
    }
  return items;
}

const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const CACHE = ".motion-use-asr.json";

/**
 * Transcribe (cached by clip hash and model) and compare every narration clip.
 * Never throws for a missing recognizer: returns { skipped: "<why>" } so render can go on.
 */
/** Resolve once per command; persist the returned config in release records. */
export function resolveNarrationCheckConfig(project = {}, overrides = {}, env = process.env) {
  const object = (value, name) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
    return value;
  };
  const supplied = Object.hasOwn(project, "narrationCheck") ? project.narrationCheck : project.narrationConfig?.check;
  const cfg = supplied === undefined ? {} : object(supplied, "narrationCheck");
  const allowedConfig = new Set(["model", "fallbackModel", "params"]);
  for (const key of Object.keys(cfg)) if (!allowedConfig.has(key)) throw new Error(`unsupported narrationCheck option: ${key}`);
  if (Object.hasOwn(cfg, "params")) object(cfg.params, "narrationCheck.params");
  if (Object.hasOwn(overrides, "params")) object(overrides.params, "narrationCheck.params");
  const out = {
    model: overrides.model ?? cfg.model ?? env.MOTION_USE_ASR_MODEL ?? "small",
    fallbackModel: overrides.fallbackModel ?? cfg.fallbackModel ?? null,
    params: { beam_size: 5, vad_filter: false, condition_on_previous_text: false, ...(cfg.params ?? {}), ...(overrides.params ?? {}) },
    comparatorVersion: COMPARATOR_VERSION,
  };
  for (const key of ["model", "fallbackModel"]) if (out[key] !== null && (typeof out[key] !== "string" || !out[key].trim())) throw new Error(`narrationCheck.${key} must be a nonempty model name`);
  const allowed = new Set(["beam_size", "vad_filter", "condition_on_previous_text", "temperature"]);
  for (const [key, value] of Object.entries(out.params)) {
    if (!allowed.has(key)) throw new Error(`unsupported narrationCheck parameter: ${key}`);
    if (key === "beam_size" && (!Number.isInteger(value) || value < 1 || value > 20)) throw new Error("narrationCheck beam_size must be 1..20");
    if (["vad_filter", "condition_on_previous_text"].includes(key) && typeof value !== "boolean") throw new Error(`narrationCheck ${key} must be boolean`);
    if (key === "temperature" && (!Number.isFinite(value) || value < 0 || value > 1)) throw new Error("narrationCheck temperature must be 0..1");
  }
  return out;
}
const stable = (value) => JSON.stringify(value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, JSON.parse(stable(value[k]))])) : value);
export function asrCacheKey(audioSha, model, lang, params) {
  return crypto.createHash("sha256").update(stable({ audioSha, model, lang, params })).digest("hex");
}

export function checkNarration(items, options = {}) {
  const { dir, log = () => {}, run = runAsr, force = false } = options;
  const config = resolveNarrationCheckConfig({}, options);
  const { model, fallbackModel, params } = config;
  const cacheStats = { hits: 0, misses: 0 };
  // ok retains legacy compatibility; status is the authoritative release-policy input.
  if (!items.length) return { ok: true, status: "SKIPPED", human_review: "UNREVIEWED", lines: [], config, cache: cacheStats, skipped: "no generated narration with a script" };
  const cacheFile = dir ? path.join(dir, CACHE) : null;
  let cache = { schemaVersion: 2, records: {} };
  try {
    const old = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (old.schemaVersion === 2 && old.records) cache = old;
    // Legacy keys omit language and decoding parameters. Keep their evidence without
    // trusting them as a hit under the stronger cache contract.
    else cache.legacy = old;
  } catch {}
  const hashes = new Map(items.map((it) => [it.file, sha(it.file)]));
  const key = (it, selected) => asrCacheKey(hashes.get(it.file), selected, it.lang, params);
  const missingTranscripts = new Set(), writtenKeys = new Set();
  const persist = () => {
    if (!cacheFile) return;
    // Only hold the lock for the merge + rename, never while running Whisper.
    // A second command may have filled other keys since our initial cache read.
    const lockFile = `${cacheFile}.lock`, token = crypto.randomUUID();
    const until = Date.now() + 5000;
    let fd;
    while (fd === undefined) {
      try { fd = fs.openSync(lockFile, "wx"); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (Date.now() >= until) throw new Error(`ASR cache busy: ${lockFile}; check for an active writer before removing a stale lock`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    const tempFile = `${cacheFile}.${token}.tmp`;
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
      let latest;
      try { latest = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
      const merged = { ...cache, records: { ...(latest?.schemaVersion === 2 ? latest.records : {}), ...cache.records } };
      // Merge only keys produced by this invocation over the latest cache. Our
      // initial snapshot must not overwrite another process's forced refresh.
      for (const [key, rec] of Object.entries(latest?.schemaVersion === 2 ? latest.records : {})) {
        if (!writtenKeys.has(key)) merged.records[key] = rec;
      }
      fs.writeFileSync(tempFile, JSON.stringify(merged, null, 2) + "\n");
      fs.renameSync(tempFile, cacheFile);
      cache = merged;
      writtenKeys.clear();
    } finally {
      fs.closeSync(fd);
      fs.rmSync(tempFile, { force: true });
      fs.rmSync(lockFile, { force: true });
    }
  };
  const transcribe = (subset, selected) => {
    const todo = subset.filter((it) => {
      const miss = force || !cache.records[key(it, selected)];
      cacheStats[miss ? "misses" : "hits"]++;
      return miss;
    });
    if (!todo.length) return null;
    log(`narration check: transcribing ${todo.length} clip(s) with whisper ${selected}…`);
    const res = run({ model: selected, params, items: todo.map((it) => ({ file: it.file, lang: it.lang })), texts: items.map((it) => it.text) });
    if (res.skipped) return res.skipped;
    for (const it of todo) {
      const got = res.items?.find((x) => x.file === it.file);
      if (!got || typeof got.text !== "string") { missingTranscripts.add(key(it, selected)); continue; }
      writtenKeys.add(key(it, selected));
      cache.records[key(it, selected)] = { sha: hashes.get(it.file), model: selected, lang: it.lang, params, text: got.text, chars: res.chars ?? {}, tones: res.tones ?? {}, phrases: res.phrases ?? [], created_at: new Date().toISOString() };
    }
    persist();
    return null;
  };
  const primarySkipped = transcribe(items, model);
  if (primarySkipped) return { ok: true, status: "SKIPPED", human_review: "UNREVIEWED", lines: [], model, config, cache: cacheStats, skipped: primarySkipped };
  const compare = (it, selected) => {
    const rec = cache.records[key(it, selected)];
    if (!rec || missingTranscripts.has(key(it, selected))) return { model: selected, status: "UNREVIEWED", flagged: true, heard: "", similarity: 0, changes: [], reason: "recognizer returned no transcript for this clip" };
    const r = compareNarration(it.text, rec.text, it.lang, rec);
    return { model: selected, heard: rec.text, ...r, status: r.flagged ? "FAIL" : "PASS", cache_key: key(it, selected) };
  };
  const primary = items.map((it) => compare(it, model));
  const flagged = items.filter((it, i) => primary[i].flagged);
  const fallbackSkipped = fallbackModel && fallbackModel !== model && flagged.length ? transcribe(flagged, fallbackModel) : null;
  const lines = items.map((it, i) => {
    const attempts = [primary[i]];
    if (fallbackModel && fallbackModel !== model && primary[i].flagged) attempts.push(fallbackSkipped ? { model: fallbackModel, status: "SKIPPED", skipped: fallbackSkipped } : compare(it, fallbackModel));
    const selected = attempts.at(-1).status === "SKIPPED" ? primary[i] : attempts.at(-1);
    const audioSha = hashes.get(it.file), review = it.review;
    const reviewed = review?.sha256 === audioSha && review.script === it.text && review.heard === selected.heard && typeof review.reason === "string" && review.reason.trim();
    return { id: it.id, lang: it.lang, script: it.text, file: it.file, audio_sha256: audioSha, ...selected, attempts, human_review: reviewed ? "PASS" : "UNREVIEWED",
      ...(reviewed ? { status: "PASS", comparison_flagged: selected.flagged, flagged: false, reviewed: { reason: review.reason, sha256: audioSha } } : {}) };
  });
  const status = lines.some((l) => l.status === "FAIL") ? "FAIL" : lines.some((l) => l.status === "UNREVIEWED") ? "UNREVIEWED" : "PASS";
  return { ok: status === "PASS", status, human_review: lines.every((l) => l.human_review === "PASS") ? "PASS" : "UNREVIEWED", model, config, cache: cacheStats, lines };
}

/** Standalone static review; audio links and all text remain usable without JavaScript. */
export function writeNarrationReview(check, file) {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const rows = check.lines.map((line) => {
    const audio = path.relative(path.dirname(path.resolve(file)), path.resolve(line.file)).split(path.sep).map(encodeURIComponent).join("/");
    return `<article><h2>${esc(line.lang)}/${esc(line.id)} — ${esc(line.status)}</h2><p>Human review: ${esc(line.human_review)}</p><p>Script: ${esc(line.script)}</p><audio controls src="${esc(audio)}"></audio>${line.attempts.map((a) => `<h3>${esc(a.model)} — ${esc(a.status)}</h3><p>${esc(a.heard ?? a.skipped)}</p><pre>${esc(JSON.stringify(a.changes ?? [], null, 2))}</pre>`).join("")}</article>`;
  }).join("\n");
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Narration review</title><style>body{max-width:900px;margin:2rem auto;padding:1rem;font:18px system-ui}article{border-top:1px solid #aaa;padding:1rem 0}pre{white-space:pre-wrap}audio{width:100%}</style><h1>Narration ${esc(check.status)}</h1><p>Human review: ${esc(check.human_review)}. Automatic transcription does not establish listening approval.</p>${check.skipped ? `<p>${esc(check.skipped)}</p>` : ""}${rows}</html>`);
  return file;
}

/** Run scripts/asr.py through uv. Returns { skipped } when uv or the model is unavailable. */
export function runAsr(request) {
  if (process.env.MOTION_USE_ASR === "off") return { skipped: "MOTION_USE_ASR=off" };
  const r = spawnSync(
    "uv",
    ["run", "--quiet", "--no-project", "--python", "3.12", "--with", "faster-whisper", "--with", "pypinyin", "python", path.join(ROOT, "scripts", "asr.py")],
    { input: JSON.stringify(request), encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, HF_HUB_DISABLE_TELEMETRY: "1" } },
  );
  if (r.error?.code === "ENOENT")
    return { skipped: "uv is not installed (https://docs.astral.sh/uv/); narration was not transcribed" };
  if (r.status !== 0)
    return { skipped: `speech recognition failed: ${(r.stderr || "").trim().split("\n").slice(-3).join(" ")}` };
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { skipped: "speech recognition returned no result" };
  }
}

const FIX = {
  acronym: 'spell the letters apart in the script, e.g. "A I" (subtitles may keep "AI")',
  latin: "check how the voice reads this word; respell it the way it should sound",
  polyphone: "the voice read a many-reading character the other way; use a word with one reading (重试 → 再试)",
  math: "quantity, operator or negation differs: listen; never dismiss a mathematical change as spelling",
  number: "the clip says a different number; listen and fix the script or re-voice it",
  tone: "same syllable, different tone: listen; if the voice is wrong, respell or use another word",
  near: "a neighbouring sound (often the recognizer on a name): listen before re-voicing",
  word: "the clip says something else; listen and re-voice it",
  missing: "words are missing from the clip; re-voice it",
  extra: "the clip has extra words; re-voice it",
};

/** One line per flagged script line, for terminal output. */
export function describeNarration(check) {
  if (check.skipped) return [`narration check skipped: ${check.skipped}`];
  return check.lines
    .filter((l) => l.flagged)
    .map((l) => {
      const flagged = l.changes.filter((c) => c.flag);
      const kinds = [...new Set(flagged.map((c) => c.kind))];
      return (
        `narration ${l.lang}/${l.id} ${Math.round(l.similarity * 100)}%: ` +
        (flagged.map((c) => `expected "${c.expected}" heard "${c.heard}" (${c.kind})`).join("; ") ||
          `heard "${l.heard}"`) +
        ` — ${kinds.map((k) => FIX[k]).filter(Boolean).join("; ") || "the transcript is far from the script; listen to the clip"}`
      );
    });
}
