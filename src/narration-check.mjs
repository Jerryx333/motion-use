// Narration check: transcribe each generated voiceover clip and compare it with its script.
// TTS misreads that no reviewer heard in the iphone-use promo (2026-10): "AI" spoken as
// "A-A-I", and 重试 read zhòng shì so it came back as 重视. Speech recognition catches both.
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spokenText } from "./voiceover.mjs";

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
      if (file) items.push({ id: p.id, lang, text: spokenText(text, (project.narrationConfig ?? project.voiceover)?.say), file, ...(project.narrationReviews?.[`${lang}/${p.id}`] ? { review: project.narrationReviews[`${lang}/${p.id}`] } : {}) });
    }
  return items;
}

const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const CACHE = ".motion-use-asr.json";

/**
 * Transcribe (cached by clip hash and model) and compare every narration clip.
 * Never throws for a missing recognizer: returns { skipped: "<why>" } so render can go on.
 */
export function checkNarration(items, { model = process.env.MOTION_USE_ASR_MODEL || "small", dir, log = () => {}, run = runAsr, force = false } = {}) {
  if (!items.length) return { ok: true, lines: [], skipped: "no generated narration with a script" };
  const cacheFile = dir ? path.join(dir, CACHE) : null;
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  } catch {}
  const key = (it) => (dir ? path.relative(dir, it.file) : it.file);
  const todo = items.filter((it) => {
    const rec = cache[key(it)];
    return force || !(rec && rec.sha === sha(it.file) && rec.model === model && rec.chars);
  });
  if (todo.length) {
    log(`narration check: transcribing ${todo.length} clip(s) with whisper ${model}…`);
    const res = run({ model, items: todo.map((it) => ({ file: it.file, lang: it.lang })), texts: items.map((it) => it.text) });
    if (res.skipped) return { ok: true, lines: [], skipped: res.skipped };
    for (const it of todo) {
      const got = res.items.find((x) => x.file === it.file);
      cache[key(it)] = { sha: sha(it.file), model, text: got?.text ?? "", chars: res.chars, tones: res.tones, phrases: res.phrases };
    }
    if (cacheFile)
      try {
        fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2) + "\n");
      } catch {}
  }
  const lines = items.map((it) => {
    const rec = cache[key(it)];
    const r = compareNarration(it.text, rec.text, it.lang, { chars: rec.chars, tones: rec.tones, phrases: rec.phrases });
    const audioSha = sha(it.file), review = it.review;
    const reviewed = review?.sha256 === audioSha && review.script === it.text && review.heard === rec.text && typeof review.reason === "string" && review.reason.trim();
    return { id: it.id, lang: it.lang, script: it.text, heard: rec.text, audio_sha256: audioSha, ...r,
      ...(reviewed ? { comparison_flagged: r.flagged, flagged: false, reviewed: { reason: review.reason, sha256: audioSha } } : {}) };
  });
  return { ok: !lines.some((l) => l.flagged), model, lines };
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
