import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { lintNarration, lintFilmNarration, narrationText } from "../src/narration-lint.mjs";
import { scriptReviewPrompt, requestScriptReview, parseScriptReview, reviewScript, reviewCommand } from "../src/script-review.mjs";
import { initFilm, validateFilm } from "../src/film.mjs";

// Keep these tests independent of a stop-slop installed on this machine (test/stop-slop.test.mjs mocks it).
process.env.MOTION_USE_STOP_SLOP = path.join(os.tmpdir(), "mu-no-stop-slop");

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/narration-${name}.json`, import.meta.url), "utf8"));
const rules = (r) => r.findings.reduce((m, f) => ({ ...m, [f.rule]: (m[f.rule] ?? 0) + 1 }), {});

test("a machine-sounding internal explainer lights every countable fingerprint", () => {
  const r = lintNarration(fixture("ai").shots, "zh");
  const n = rules(r);
  assert.equal(n["opening-quantity"], 1);
  assert.equal(n["opening-rule"], 1);
  assert.equal(n["name-reveal"], 3);
  assert.equal(n["moral-tail"], 2);
  assert.ok(n["spoken-list"] >= 4);
  assert.equal(n["semicolon-chain"], 2);
  assert.deepEqual(r.findings.filter((f) => f.rule === "written-register").map((f) => f.text).sort(), ["一律", "前提是", "细则"].sort());
  assert.ok(r.findings.every((f) => f.path.startsWith("$.shots[") && f.message.includes("narration-writing.md")));
  assert.equal(r.stats.firstPerson, 1);
});

test("the same facts said by a colleague stay quiet", () => {
  const r = lintNarration(fixture("human").shots, "zh");
  assert.deepEqual(rules(r), {});
  assert.ok(r.stats.firstPerson >= 2 && r.stats.shortSentences >= 1);
});

test("必须 is speech, not written register; a single name reveal or moral tail is allowed", () => {
  const shots = [
    { id: "a", narration: { zh: { say: "两张照片必须拍到同一辆车。", text: "x" } } },
    { id: "b", narration: { zh: "停对了还有奖励，这叫连停。所以每天都停对。" } },
  ];
  assert.equal(narrationText(shots[0], "zh"), "两张照片必须拍到同一辆车。");
  assert.deepEqual(lintNarration(shots, "zh").findings, []);
});

test("English rules and skipped languages", () => {
  const en = lintNarration([
    { id: "a", narration: "Every time you park inside the line, 30 seconds later you get ten points." },
    { id: "b", narration: "Seven good days in a row earn a bonus. This is called a streak. So park well every day." },
    { id: "c", narration: "Points buy ride passes, and this is known as redemption. So parking well pays." },
  ], "en");
  const n = rules(en);
  assert.equal(n["opening-quantity"], 1);
  assert.equal(n["opening-rule"], 1);
  assert.equal(n["name-reveal"], 2);
  assert.equal(n["moral-tail"], 2);
  assert.match(lintNarration([{ id: "a", narration: "こんにちは" }], "ja").skipped, /no narration rules/);
  assert.equal(lintFilmNarration({ languages: ["zh", "en"], shots: [] }).length, 2);
});

test("validate reports narration fingerprints as warnings, never errors", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mu-lint-"));
  initFilm({ lang: "zh", format: "landscape" }, dir);
  const data = JSON.parse(fs.readFileSync(path.join(dir, "film.json"), "utf8"));
  data.voiceover = false;
  data.languages = ["zh"];
  data.shots = data.shots.map((s, i) => ({ ...s, narration: { zh: i === 0 ? "你每停对一次，三十秒后就多十个积分。" : `第${i}段说完了，这叫例子。所以就这样。` } }));
  const { errors, warnings } = validateFilm(data, dir);
  assert.deepEqual(errors.filter((e) => /narration/.test(e.message)), []);
  const lint = warnings.filter((w) => /^narration [a-z-]+ \[zh/.test(w.message));
  assert.ok(lint.some((w) => /opening-quantity/.test(w.message)));
  assert.ok(lint.some((w) => /name-reveal/.test(w.message)));
  assert.ok(lint.some((w) => /moral-tail/.test(w.message)));
});

test("script review asks for a separate voice pass carrying the lint evidence", () => {
  const lint = [lintNarration(fixture("ai").shots, "zh")];
  const both = scriptReviewPrompt("稿子", { audience: "内部开发" }, { lint });
  assert.match(both, /## 事实轮/);
  assert.match(both, /## 口语轮/);
  assert.match(both, /【事实】或【口语】/);
  assert.match(both, /name-reveal \[photo\]/);
  assert.match(both, /第一句必须能指着画面说出来/);
  const voice = scriptReviewPrompt("稿子", {}, { focus: "voice", lint });
  assert.doesNotMatch(voice, /## 事实轮/);
  assert.doesNotMatch(scriptReviewPrompt("稿子", {}, { focus: "facts" }), /## 口语轮/);
  assert.throws(() => scriptReviewPrompt("稿子", {}, { focus: "tone" }), /--focus/);
});

test("command reviewers run without a shell, get the prompt on stdin, and may print a preamble", async () => {
  assert.deepEqual(reviewCommand('["codex","exec","-"]'), ["codex", "exec", "-"]);
  assert.throws(() => reviewCommand("codex exec -"), /JSON argv/);
  assert.throws(() => reviewCommand("[]"), /JSON argv/);
  const answer = { issues: ["【口语】开头是规则"], rewrite: "你看这辆车。", alternatives: [] };
  let seen;
  const spawnImpl = (cmd, args) => {
    seen = { cmd, args, input: "" };
    const ev = (o) => { const h = {}; o.on = (k, f) => { h[k] = f; return o; }; o.emit = (k, v) => h[k]?.(v); return o; };
    const child = ev({ kill() {} });
    child.stdout = ev({}); child.stderr = ev({});
    child.stdin = ev({ end(x) { seen.input = x; setImmediate(() => { child.stdout.emit("data", `thinking…\n${JSON.stringify(answer)}\n`); child.emit("close", 0); }); } });
    return child;
  };
  const raw = await requestScriptReview("PROMPT", { reviewer: "codex", transport: "command", command: '["codex","exec","-"]', spawnImpl });
  assert.deepEqual(seen, { cmd: "codex", args: ["exec", "-"], input: "PROMPT" });
  assert.deepEqual(parseScriptReview(raw), answer);
  await assert.rejects(requestScriptReview("p", { reviewer: "Codex Pro", transport: "command", command: '["x"]', spawnImpl }), /short label/);
});

test("a planned voice review records the focus and the lint evidence in its prompt", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mu-voice-"));
  initFilm({ lang: "zh", format: "landscape" }, dir);
  const file = path.join(dir, "film.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.shots[0].narration = { zh: "你每停对一次，三十秒后就多十个积分。" };
  fs.writeFileSync(file, JSON.stringify(data));
  const r = await reviewScript(dir, { reviewer: "codex", transport: "command", focus: "voice", plan: true, out: path.join(dir, "reviews", "02-voice.md") });
  assert.equal(r.status, "PREPARED");
  assert.equal(r.focus, "voice");
  assert.match(fs.readFileSync(r.prompt, "utf8"), /opening-quantity/);
});

test("the SCRIPT.md shot table is linted before film.json exists or catches up", async () => {
  const { scriptTableShots } = await import("../src/narration-lint.mjs");
  const md = "# Script\n\n| Shot | 画面 | 口播（zh） | 屏幕字 |\n|---|---|---|---|\n| hook | 车 | 你每停对一次，三十秒后就多十个积分。 | 积分 |\n| next | x | TODO | y |\n";
  assert.deepEqual(scriptTableShots(md), [{ id: "hook", narration: "你每停对一次，三十秒后就多十个积分。" }]);
  assert.equal(scriptTableShots("| a | b |\n|---|---|\n| 1 | 2 |"), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mu-table-"));
  initFilm({ lang: "zh", format: "landscape" }, dir);
  fs.writeFileSync(path.join(dir, "SCRIPT.md"), md);
  const r = await reviewScript(dir, { reviewer: "codex", transport: "command", focus: "voice", plan: true, out: path.join(dir, "reviews", "02-voice.md") });
  assert.match(fs.readFileSync(r.prompt, "utf8"), /opening-quantity \[hook\]/);
});

test("an over-corrected rewrite is caught: outline announcements, fillers, matched pairs", () => {
  const r = lintNarration([
    { id: "a", narration: "有两个条件：同一辆车，同一个区域。" },
    { id: "b", narration: "第一样是积分。积分这块，记住白线就行。" },
    { id: "c", narration: "第二样是券。停对一次，多十分；停错一次，扣十分。" },
    { id: "d", narration: "一样的车，一样的线。说白了就是停好。" },
  ], "zh");
  const n = rules(r);
  assert.equal(n["frame-open"], 3);
  assert.equal(n["filler"], 3);
  assert.equal(n["symmetric-pair"], 2);
  assert.equal(rules(lintNarration(fixture("human").shots, "zh"))["frame-open"], undefined);
  assert.match(scriptReviewPrompt("稿", {}, { focus: "voice" }), /别矫枉过正/);
});

test("addressing the player both as you and by role is flagged once", () => {
  const r = lintNarration([
    { id: "a", narration: "玩家停好车就有积分。你停得越准，积分越多。" },
    { id: "b", narration: "玩家每天最多拿五次。你换券的时候看余额。" },
  ], "zh");
  assert.deepEqual(rules(r), { "audience-drift": 1 });
});

// SCRIPT.md and film.json both say what the film says; the voiceover reads film.json.
const tableOf = (shots, header = "口播（zh）") =>
  `# Script\n\n| Shot | 画面 | ${header} |\n|---|---|---|\n${shots.map((s) => `| ${s.id} | x | ${narrationText(s, "zh")} |`).join("\n")}\n`;

test("script lint compares the SCRIPT.md table with film.json instead of trusting the table", async () => {
  const { lintScriptAndFilm, scriptTable } = await import("../src/narration-lint.mjs");
  const ai = fixture("ai"), human = fixture("human");
  assert.deepEqual(scriptTable(tableOf(human.shots)).lang, "zh");

  // Same words in both: the table is linted once, nothing drifts, film.json is not linted twice.
  const same = lintScriptAndFilm({ script: tableOf(ai.shots), film: ai });
  assert.deepEqual(same.map((r) => r.source), ["SCRIPT.md", "drift"]);
  assert.equal(same[1].findings.length, 0);
  assert.ok(same[0].findings.length >= 10);

  // A rewritten SCRIPT.md that never reached film.json: the stale film.json is still linted, and every shot drifts.
  const stale = lintScriptAndFilm({ script: tableOf(human.shots), film: ai });
  assert.deepEqual(stale.map((r) => r.source), ["SCRIPT.md", "film.json", "drift"]);
  assert.deepEqual(stale[0].findings, []);
  assert.deepEqual(stale[1].findings.map((f) => f.rule).filter((r) => r === "name-reveal").length, 3);
  const drift = stale[2].findings;
  assert.ok(drift.length > 0 && drift.every((f) => f.rule === "script-drift"));

  // Shots missing on either side.
  const film = { languages: ["zh"], shots: [{ id: "a", narration: { zh: "看这两只狗。" } }, { id: "c", narration: { zh: "多出来的一句。" } }] };
  const gap = lintScriptAndFilm({ script: tableOf([{ id: "a", narration: "看这两只 狗。" }, { id: "b", narration: "合成了。" }]), film });
  const ids = gap.find((r) => r.source === "drift").findings.map((f) => f.shot).sort();
  assert.deepEqual(ids, ["b", "c"], "whitespace alone is not drift; a missing shot on either side is");

  // A spoken column with no language in a multi-language film cannot be compared.
  const multi = lintScriptAndFilm({ script: tableOf(film.shots, "Spoken copy per language"), film: { ...film, languages: ["zh", "en"] } });
  assert.match(multi.find((r) => r.source === "drift").skipped, /names no language/);
  assert.deepEqual(multi.filter((r) => r.source === "film.json").map((r) => r.lang), ["zh", "en"]);
});

test("script lint <dir>, validate and the CLI report drift between SCRIPT.md and film.json", async () => {
  const { spawnSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mu-drift-"));
  initFilm({ lang: "zh", format: "landscape" }, dir);
  const data = JSON.parse(fs.readFileSync(path.join(dir, "film.json"), "utf8"));
  data.voiceover = false;
  data.languages = ["zh"];
  const ai = fixture("ai");
  data.shots = data.shots.map((s, i) => ({ ...s, id: ai.shots[i]?.id ?? s.id, narration: ai.shots[i]?.narration }));
  fs.writeFileSync(path.join(dir, "film.json"), JSON.stringify(data, null, 2));
  const used = data.shots.filter((s) => s.narration);
  fs.writeFileSync(path.join(dir, "SCRIPT.md"), tableOf(used.map((s) => ({ id: s.id, narration: "我先说一句人话。" }))));

  const r = spawnSync(process.execPath, [new URL("../bin/motion-use.mjs", import.meta.url).pathname, "script", "lint", dir, "--json"], {
    encoding: "utf8", env: { ...process.env, MOTION_USE_NO_UPDATE_CHECK: "1", MOTION_USE_STOP_SLOP: path.join(dir, "no-stop-slop") },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "WARN");
  assert.equal(out.drift, used.length);
  assert.ok(out.results.some((x) => x.source === "film.json" && x.findings.some((f) => f.rule === "name-reveal")));

  const { warnings } = validateFilm(data, dir);
  const drift = warnings.filter((w) => /^script-drift/.test(w.message));
  assert.equal(drift.length, 1, "one summary warning, not one per shot");
  assert.match(drift[0].message, new RegExp(`${used.length} shot\\(s\\)`));
});
