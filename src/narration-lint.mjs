// Narration lint: countable fingerprints of a script written by summarising a source document
// instead of a person talking. Every finding is a warning with its evidence; whether the line is
// wrong stays a judgement for the author (references/narration-writing.md).
//
// Calibrated on a shipped internal explainer that reviewers recognised as machine-written (kept
// private) and the synthetic pair test/fixtures/narration-ai.json / narration-human.json
// (the same fictional facts written as a summary and as a colleague speaking).

const GUIDE = "references/narration-writing.md";
const ZH_NUM = "[零一二两三四五六七八九十百千万\\d]";
const RULES = {
  zh: {
    // "…，这叫有效停车" / "这就是所谓的…": describe, then reveal the term.
    define: /这叫|就叫(?=[^，。]{0,6}[。，])|叫做|这就是所谓|这就是我们说的/g,
    // A shot that ends by stating its own moral.
    conclusion: /^(所以|因此|这就是|这样一来|总之|说到底|总而言之|由此可见)/,
    // A shot that opens by defining the topic.
    definitionOpen: /^这(就)?是/,
    // Written register read aloud.
    written: /一律|前提是|细则|进行|予以|相应|此外|综上|首先|其次|即可|均可|(?<!必)须(?!要)|值得注意的是|不难发现|与此同时|在此基础上|具体而言/g,
    // Rule connectives that turn a line into a clause of a specification.
    rule: /每[^。！？]{1,20}(就|都|便)|只要[^。！？]{1,20}就|一旦|当且仅当/,
    // A parameter: digits, a decimal, or a numeral with a measuring unit ("两只" and "一次" are ordinary speech).
    quantity: new RegExp(`\\d|${ZH_NUM}+点${ZH_NUM}+|${ZH_NUM}+\\s*(秒|分钟|小时|级|倍|格|金币|波|天|星|%|％|百分)|百分之`),
    // Announcing the structure before the content: 「有两个条件」「多了一件事」「一共养三样」「第一样是…」.
    frame: /^.{0,10}?(有|一共|多了|分成?|就)\s*[一两二三四五六几](个|样|件|条|块|点|步|种)(事|东西|条件|部分|活)?[。：:，]|^.{0,10}?(一共|分成?)\s*[两二三四五六几](个|样|件|条|块|点|步|种)|^第[一二三四五六]\s*(样|个|点|条|步|块)/,
    // Colloquial-looking filler that locates nothing: 「这块」「记住…就行」「说白了」.
    filler: /这块|记住[^，。]{0,8}就行|说白了|简单来说|其实/g,
    speaker: { first: /我|咱们|咱|我们/g, you: /你(?!们)/g, role: /玩家|用户|观众/g },
    sentence: /[^。！？!?；;\n]+[。！？!?；;]?/g,
    unit: (s) => (s.match(/[⺀-鿿豈-﫿]|[A-Za-z0-9]+/g) ?? []).length,
    listSep: "、",
    headChars: 16,
  },
  en: {
    define: /\b(this is called|that's called|which is called|known as|this is what we call)\b/gi,
    conclusion: /^(so|that's why|that is why|in short|in other words|ultimately|this means)\b/i,
    definitionOpen: /^(this is|here is|meet)\b/i,
    written: /\b(utili[sz]e|leverage|in order to|furthermore|moreover|additionally|subsequently|thereby|prior to|commence)\b/gi,
    rule: /\b(every time|whenever|each time|as soon as|if and only if)\b/i,
    quantity: /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|hundred)\b\s+(seconds?|minutes?|levels?|times?|percent)/i,
    frame: /^(there are|we have|here are)\s+(two|three|four|five|several)\b|^(first|second|third|number (one|two|three))\b/i,
    filler: /\b(basically|simply put|at the end of the day|just remember)\b/gi,
    speaker: { first: /\b(I|we|let's|us)\b/gi, you: /\byou\b/gi, role: /\b(players?|users?|viewers?)\b/gi },
    sentence: /[^.!?;\n]+[.!?;]?/g,
    unit: (s) => (s.match(/[A-Za-z0-9']+/g) ?? []).length,
    listSep: ",",
    headChars: 60,
  },
};

/** Plain spoken text of one shot's narration in `lang`; null when the shot has none. */
export function narrationText(shot, lang) {
  let v = shot?.narration;
  if (v === undefined || v === null) return null;
  if (typeof v === "object" && !("say" in v) && !("text" in v)) v = v[lang];
  if (v && typeof v === "object") v = v.say ?? v.text;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

const sentencesOf = (text, R) => (text.match(R.sentence) ?? []).map((s) => s.trim()).filter((s) => R.unit(s) > 0);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * lintNarration(shots, lang) → {lang, findings:[{rule, shot, path, text, message}], stats}
 * `shots` are film.json shots (id + narration). Only languages with a rule table are linted.
 */
export function lintNarration(shots, lang, { pathOf = (i) => `$.shots[${i}].narration` } = {}) {
  const base = String(lang ?? "").toLowerCase().split("-")[0];
  const R = RULES[base];
  if (!R) return { lang, findings: [], stats: null, skipped: `no narration rules for ${lang}` };
  const lines = (Array.isArray(shots) ? shots : []).map((s, i) => ({ i, id: s?.id ?? String(i), text: narrationText(s, lang) })).filter((x) => x.text);
  const findings = [];
  const add = (rule, x, text, message) => findings.push({ rule, shot: x?.id ?? null, path: x ? pathOf(x.i) : "$.shots", text, message: `${message} (${GUIDE})` });
  if (!lines.length) return { lang, findings, stats: null };

  // 1. The opening line: speakable while pointing at the picture, not a clause of the rules.
  const first = lines[0], head = sentencesOf(first.text, R)[0] ?? first.text;
  const headSpan = [...head].slice(0, R.headChars).join("");
  if (R.quantity.test(headSpan))
    add("opening-quantity", first, head, "the first line carries a number or unit before the viewer knows what they are looking at; open on the thing in the picture and give the number later or on screen");
  if (R.rule.test(head))
    add("opening-rule", first, head, "the first line is a rule (every…/whenever…); open on one concrete thing happening in the picture, then let the rule follow");

  // 2. Describe-then-name tags across the script.
  const defs = lines.flatMap((x) => [...x.text.matchAll(R.define)].map((m) => ({ x, m: m[0] })));
  if (defs.length >= 2)
    for (const { x, m } of defs) add("name-reveal", x, m, `"${m}" appears ${defs.length} times; describe-then-name is a lesson template. Use the term the team already uses, or name it once without the reveal`);

  // 3. Shots that end on their own moral.
  const tails = lines.map((x) => ({ x, last: sentencesOf(x.text, R).at(-1) ?? "" })).filter(({ last }) => R.conclusion.test(last));
  if (tails.length >= 2)
    for (const { x, last } of tails) add("moral-tail", x, last, `${tails.length} shots end on a summary sentence; stop when the information stops and let the picture land it`);

  // 4. Shots that open by defining their topic.
  const opens = lines.filter((x) => R.definitionOpen.test(sentencesOf(x.text, R)[0] ?? ""));
  if (opens.length >= 2 || (opens[0] && opens[0] === first))
    for (const x of opens) add("definition-open", x, sentencesOf(x.text, R)[0], "the shot opens by defining its topic (\"this is…\"); start with what happens");

  // 5. Spoken lists: a habit when it repeats (four or more lists of three short items) or one list
  //    runs to five items; a single "A, B and C" in a promo is ordinary speech.
  const lists = [];
  for (const x of lines) {
    for (const clause of x.text.split(/[，。！？!?；;：:\n]/)) {
      // The first item may carry the lead-in ("…负责拍照、展示余额和兑换"); the rest are short.
      let items;
      if (base === "zh") items = clause.split(R.listSep).flatMap((it, k, all) => (k === all.length - 1 ? it.split(/和|与|及/) : [it]));
      else items = /,\s*(?:and|or)\s+\S/i.test(clause) ? clause.split(/,\s*(?:and\s+|or\s+)?/) : [clause];
      const max = base === "zh" ? 6 : 3;
      if (items.length >= 3 && items.slice(1).every((it) => R.unit(it) > 0 && R.unit(it) <= max)) lists.push({ x, clause: clause.trim(), n: items.length });
    }
  }
  for (const l of lists)
    if (lists.length >= 4 || l.n >= 5) add("spoken-list", l.x, l.clause, `${l.n} parallel items read aloud${lists.length >= 4 ? ` (${lists.length} lists in this script)` : ""}; keep two in speech and put the full list on screen`);
  for (const x of lines) {
    const semis = (x.text.match(/[；;]/g) ?? []).length;
    if (semis >= 2) add("semicolon-chain", x, x.text, `${semis} semicolons in one narration line: a written list structure; split into sentences with different shapes or move the list on screen`);
  }

  // 6a. Second-order fingerprints: what an over-corrected script does to sound spoken.
  const frames = lines.filter((x) => R.frame.test(sentencesOf(x.text, R)[0] ?? ""));
  if (frames.length >= 2)
    for (const x of frames) add("frame-open", x, sentencesOf(x.text, R)[0], `${frames.length} shots open by announcing a count or a numbered item; say the first thing instead of the outline`);
  const fillers = lines.flatMap((x) => [...x.text.matchAll(R.filler)].map((m) => ({ x, m: m[0] })));
  if (fillers.length >= 2)
    for (const { x, m } of fillers) add("filler", x, m, `"${m}" sounds spoken but points at nothing (${fillers.length} in this script); name the thing or drop it`);
  const pairs = [];
  for (const x of lines) {
    const clauses = x.text.split(/[，；;,。！？.!?：:]/).map((c) => c.trim()).filter(Boolean);
    for (let k = 1; k < clauses.length; k++) {
      const a = clauses[k - 1], b = clauses[k], ua = R.unit(a), ub = R.unit(b);
      const head = base === "zh" ? [...a].slice(0, 2).join("") === [...b].slice(0, 2).join("") : a.split(/\s+/)[0].toLowerCase() === b.split(/\s+/)[0].toLowerCase();
      if (head && ua <= (base === "zh" ? 10 : 7) && Math.abs(ua - ub) <= 1) pairs.push({ x, text: `${a}，${b}` });
    }
  }
  if (pairs.length >= 2)
    for (const p of pairs) add("symmetric-pair", p.x, p.text, `${pairs.length} matched clause pairs; symmetry reads as copywriting. Say the rule once in one plain clause`);

  // 6b. Who "you" is: the same person named two ways reads as a script stitched from sources.
  const count = (re) => lines.reduce((n, x) => n + (x.text.match(re) ?? []).length, 0);
  const yous = count(R.speaker.you), roles = count(R.speaker.role);
  if (yous >= 2 && roles >= 2)
    add("audience-drift", null, `"you" ×${yous}, a named role ×${roles}`, "the same person is addressed as \"you\" and by a role name; pick one name for the player or user, and keep \"we\" for the team");

  // 6. Written register.
  for (const x of lines) for (const m of x.text.matchAll(R.written)) add("written-register", x, m[0], `"${m[0]}" is written register; say it the way you would across a table`);

  // 7. Uniform rhythm across the script.
  const lens = lines.flatMap((x) => sentencesOf(x.text, R)).map(R.unit);
  const mu = lens.length ? mean(lens) : 0;
  const cv = lens.length > 1 && mu ? Math.sqrt(mean(lens.map((l) => (l - mu) ** 2))) / mu : null;
  const short = lens.filter((l) => l <= (base === "zh" ? 6 : 4)).length;
  const firstPerson = lines.reduce((n, x) => n + (x.text.match(R.speaker.first) ?? []).length, 0);
  return {
    lang,
    findings,
    stats: { shots: lines.length, sentences: lens.length, meanUnits: +mu.toFixed(1), rhythmCv: cv === null ? null : +cv.toFixed(2), shortSentences: short, firstPerson },
  };
}

/**
 * Spoken copy from a SCRIPT.md shot table: the column whose header names spoken copy
 * (Spoken / Narration / 口播 / 旁白). The script is written before film.json, so a script
 * review lints this, not film.json. Returns null when no such table exists.
 */
export function scriptTableShots(markdown) {
  const rows = String(markdown).split("\n").filter((l) => /^\s*\|.*\|\s*$/.test(l));
  const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((x) => x.trim());
  for (let i = 0; i + 1 < rows.length; i++) {
    const head = cells(rows[i]);
    const col = head.findIndex((h) => /spoken|narration|口播|旁白/i.test(h));
    if (col < 0 || !/^[\s|:-]+$/.test(rows[i + 1])) continue;
    const shots = [];
    for (const l of rows.slice(i + 2)) {
      if (/^[\s|:-]+$/.test(l)) break;
      const c = cells(l);
      if (c.length !== head.length) break;
      if (c[col] && !/^todo$/i.test(c[col])) shots.push({ id: c[0] || String(shots.length), narration: c[col] });
    }
    if (shots.length) return shots;
  }
  return null;
}

/** Lint every narrated language of a film.json object. */
export function lintFilmNarration(film) {
  const langs = Array.isArray(film?.languages) && film.languages.length ? film.languages : ["en"];
  return langs.map((lang) => lintNarration(film?.shots, lang));
}
