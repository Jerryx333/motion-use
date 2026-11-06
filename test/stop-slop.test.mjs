import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { findStopSlop, stopSlopCandidates, stopSlopNarration, STOP_SLOP_INSTALL } from "../src/stop-slop.mjs";
import { reviewScript } from "../src/script-review.mjs";

const entry = fileURLToPath(new URL("../bin/motion-use.mjs", import.meta.url));
const fixtureFile = (name) => fileURLToPath(new URL(`./fixtures/narration-${name}.json`, import.meta.url));
const fixture = (name) => JSON.parse(fs.readFileSync(fixtureFile(name), "utf8"));

// A stand-in for `stop-slop detect --shots - --json` (v1.2.0 contract): records its stdin and
// answers with one item of every level, flagged and not.
function mockStopSlop(t, version = "1.2.0") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mu-stop-slop-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "stop-slop"), input = path.join(dir, "input.json");
  const hit = (shot, excerpt) => ({ file: "shots", line: 1, excerpt, shot });
  const items = [
    { id: "F2", level: "F", rule: "9", name: "分号「；」", count: 2, density: 9.9, unit: "千字", human_ref: "0.77", ai_ref: "1.51", advice: "能安全拆成句号就拆", flagged: true, hits: [hit("abuse", "只算一次【；】同一个"), hit("ops", "查作弊【；】还要")] },
    { id: "R13b", level: "B", rule: "13", name: "相邻两句同构", count: 1, density: 66.7, unit: "百段", human_ref: "4.8", advice: "换一句的句式", flagged: true, hits: [hit("what", "A ／ B")] },
    { id: "R2", level: "A", rule: "2", name: "二元对立 / 翻案腔", count: 1, advice: "直接说是什么", flagged: true, hits: [hit("hook", "不是…而是…")] },
    { id: "R1", level: "A", rule: "1", name: "程度副词", count: 1, advice: "删", flagged: false, hits: [hit("abuse", "【十分】")] },
    { id: "X4", level: "X", rule: "慎改", name: "正文问句", count: 3, advice: "别改", flagged: true, hits: [hit("hook", "？")] },
    { id: "H1", level: "H", rule: "人审", name: "拟人化喻体", count: 1, advice: "人看", flagged: true, hits: [hit("hook", "x")] },
    { id: "C1", level: "C", rule: "整篇", name: "句长 CV", count: 0, advice: "", flagged: true, hits: [] },
  ];
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require("node:fs");
const a = process.argv.slice(2);
if (a[0] === "--version") { console.log("stop-slop ${version}"); process.exit(0); }
if (a.join(" ") === "candidates --shots -") {
  const shots = JSON.parse(fs.readFileSync(0, "utf8"));
  const cohesion = shots.slice(1).map((s, i) => ({ type: "cohesion", prev_shot: shots[i].id, prev_tail: shots[i].text.slice(-6), shot: s.id, next_head: s.text.slice(0, 6), label: "", confidence: "", reason: "" }));
  console.log(JSON.stringify({ meta: { mode: "spoken", version: "${version}" }, rename: [], cohesion, colon: [], iso3: [] }));
  process.exit(0);
}
if (a.join(" ") !== "detect --shots - --json") { console.error("bad args " + a.join(" ")); process.exit(2); }
fs.writeFileSync(${JSON.stringify(input)}, fs.readFileSync(0, "utf8"));
console.log(JSON.stringify({ version: "${version}", meta: { mode: "spoken" }, items: ${JSON.stringify(items)}, structure: {} }));
`, { mode: 0o755 });
  return { bin, input };
}

const lint = (target, env, ...args) => {
  const r = spawnSync(process.execPath, [entry, "script", "lint", target, "--film", ...args], {
    encoding: "utf8", timeout: 30_000, env: { ...process.env, MOTION_USE_NO_UPDATE_CHECK: "1", ...env },
  });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test("stop-slop's flagged A/B/F items become findings; X, H, C and unflagged items do not", (t) => {
  const { bin, input } = mockStopSlop(t);
  const out = JSON.parse(lint(fixtureFile("ai"), { MOTION_USE_STOP_SLOP: bin }, "--json"));
  // One shot per entry, in order, narration as plain text.
  const sent = JSON.parse(fs.readFileSync(input, "utf8"));
  assert.deepEqual(sent.map((x) => x.id), fixture("ai").shots.map((s) => s.id));
  assert.ok(sent.every((x) => typeof x.text === "string" && x.text));

  const film = out.results.find((r) => r.source === "film.json");
  const ss = film.findings.filter((f) => f.rule.startsWith("stop-slop/"));
  assert.deepEqual(ss.map((f) => `${f.rule} ${f.shot}`), ["stop-slop/F2 abuse", "stop-slop/F2 ops", "stop-slop/R13b what", "stop-slop/R2 hook"]);
  const ids = fixture("ai").shots.map((s) => s.id);
  assert.equal(ss[0].path, `$.shots[${ids.indexOf("abuse")}].narration`);
  assert.match(ss[0].message, /能安全拆成句号就拆/);
  assert.match(ss[0].message, /0\.77/);
  // The motion-use rules still run alongside.
  assert.ok(film.findings.some((f) => f.rule === "name-reveal"));
  assert.equal(out.stop_slop.installed, true);
  assert.equal(out.stop_slop.version, "1.2.0");
  assert.equal(out.stop_slop.runs[0].items.length, 7, "raw items stay in the JSON for the reviewer");
});

test("SCRIPT.md rows are checked too, with row paths", (t) => {
  const { bin } = mockStopSlop(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mu-stop-slop-script-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shots = fixture("ai").shots;
  fs.writeFileSync(path.join(dir, "SCRIPT.md"), `| Shot | 口播（zh） |\n|---|---|\n${shots.map((s) => `| ${s.id} | ${s.narration.zh} |`).join("\n")}\n`);
  const r = spawnSync(process.execPath, [entry, "script", "lint", path.join(dir, "SCRIPT.md"), "--json"], { encoding: "utf8", env: { ...process.env, MOTION_USE_NO_UPDATE_CHECK: "1", MOTION_USE_STOP_SLOP: bin } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const f = out.results[0].findings.find((x) => x.rule === "stop-slop/R2");
  assert.equal(f.path, `SCRIPT.md row ${shots.findIndex((s) => s.id === "hook") + 1}`);
  assert.deepEqual(out.stop_slop.runs.map((x) => x.source), ["SCRIPT.md"]);
});

test("without stop-slop the lint still passes and says how to install it", () => {
  const env = { MOTION_USE_STOP_SLOP: path.join(os.tmpdir(), "no-such-stop-slop-bin") };
  const out = JSON.parse(lint(fixtureFile("human"), env, "--json"));
  assert.equal(out.status, "PASS");
  assert.deepEqual(out.stop_slop, { installed: false, reason: "not installed", install: STOP_SLOP_INSTALL });
  assert.match(lint(fixtureFile("human"), env), /stop-slop second-layer check skipped \(not installed\); install: curl -fsSL .*install\.sh \| sh/);
});

test("a stop-slop without spoken mode is skipped, not run", (t) => {
  const { bin, input } = mockStopSlop(t, "1.1.0");
  const tool = findStopSlop({ ...process.env, MOTION_USE_STOP_SLOP: bin });
  assert.equal(tool.installed, false);
  assert.match(tool.reason, /1\.1\.0 has no spoken mode/);
  const out = JSON.parse(lint(fixtureFile("ai"), { MOTION_USE_STOP_SLOP: bin }, "--json"));
  assert.equal(out.stop_slop.installed, false);
  assert.ok(!fs.existsSync(input));
  assert.ok(out.results[0].findings.every((f) => !f.rule.startsWith("stop-slop/")));
});

test("only Chinese narration is sent; a failing run is reported, not thrown", (t) => {
  const { bin } = mockStopSlop(t);
  const tool = { installed: true, bin, version: "1.2.0" };
  assert.equal(stopSlopNarration([{ id: "a", narration: "Hello there." }], "en", tool), null);
  assert.equal(stopSlopNarration([{ id: "a" }], "zh", tool), null);
  const broken = stopSlopNarration([{ id: "a", narration: "你好。" }], "zh", { installed: true, bin: process.execPath, version: "1.2.0" });
  assert.ok(broken.error && broken.findings.length === 0);
});

test("script review hands the voice pass stop-slop's shot-to-shot joins (1.3.0+) and its findings", (t) => {
  const { bin } = mockStopSlop(t, "1.3.0");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mu-stop-slop-review-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ai = fixture("ai");
  fs.writeFileSync(path.join(dir, "film.json"), JSON.stringify({ ...ai, brief: { audience: "内部开发" } }));
  fs.writeFileSync(path.join(dir, "SCRIPT.md"), `| Shot | 口播（zh） |\n|---|---|\n${ai.shots.map((s) => `| ${s.id} | ${s.narration.zh} |`).join("\n")}\n`);
  const env = { ...process.env, MOTION_USE_STOP_SLOP: bin };
  const voice = reviewScript(dir, { reviewer: "gemini", plan: true, focus: "voice", out: path.join(dir, "r", "voice.md"), env });
  return voice.then((r) => {
    assert.equal(r.stop_slop.version, "1.3.0");
    assert.equal(r.stop_slop.cohesion, ai.shots.length - 1);
    const prompt = fs.readFileSync(r.prompt, "utf8");
    assert.match(prompt, /镜头衔接候选/);
    assert.match(prompt, new RegExp(`\\[${ai.shots[0].id} → ${ai.shots[1].id}\\]`));
    assert.match(prompt, /semantic\.md 第 2 节/);
    assert.match(prompt, /stop-slop\/F2 \[abuse\]/);
    return reviewScript(dir, { reviewer: "gemini", plan: true, focus: "facts", out: path.join(dir, "r", "facts.md"), env });
  }).then((r) => {
    assert.equal(r.stop_slop.cohesion, null, "the facts pass does not ask for joins");
    assert.doesNotMatch(fs.readFileSync(r.prompt, "utf8"), /镜头衔接候选/);
  });
});

test("joins need stop-slop 1.3.0; 1.2.0 still gives findings but no candidates", (t) => {
  const { bin } = mockStopSlop(t, "1.2.0");
  const shots = fixture("ai").shots;
  assert.equal(stopSlopCandidates(shots, "zh", { installed: true, bin, version: "1.2.0" }), null);
  const { bin: newer } = mockStopSlop(t, "1.3.0");
  const c = stopSlopCandidates(shots, "zh", { installed: true, bin: newer, version: "1.3.0" });
  assert.equal(c.cohesion.length, shots.length - 1);
  assert.equal(stopSlopCandidates(shots.slice(0, 1), "zh", { installed: true, bin: newer, version: "1.3.0" }), null, "one shot has no joins");
});
