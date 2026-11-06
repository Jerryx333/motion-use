// Second-layer narration check: stop-slop (github.com/leeguooooo/stop-slop-zh), a Chinese
// AI-writing detector with human/AI reference densities. Its spoken mode (`detect --shots`,
// v1.2.0+) treats each shot's narration as one paragraph and counts what the motion-use lint
// does not: scattered semicolons, adjacent sentences built the same way, 「不是…而是…」,
// 「最绕的是」, prompt colons, translationese. Optional: absent or too old, it is skipped with
// an install line and never fails a lint.
import { spawnSync } from "node:child_process";
import { narrationText } from "./narration-lint.mjs";

export const STOP_SLOP_INSTALL = "curl -fsSL https://raw.githubusercontent.com/leeguooooo/stop-slop-zh/main/install.sh | sh";
export const STOP_SLOP_MIN = "1.2.0";
/** `candidates --shots` (joins between neighbouring shots) arrived in 1.3.0. */
export const STOP_SLOP_CANDIDATES_MIN = "1.3.0";
const GUIDE = "references/narration-writing.md";
// A: wording tells, B: structure, F: punctuation density. X (change with care) and H (human
// judgement) are guard rails against over-correcting; C is a whole-script metric. None of those
// is reported as a problem.
const REPORTED = new Set(["A", "B", "F"]);

const older = (a, b) => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
};

/**
 * Which stop-slop to run: MOTION_USE_STOP_SLOP names the binary, else `stop-slop` on PATH.
 * → {installed:true, bin, version} or {installed:false, install, reason}
 */
export function findStopSlop(env = process.env, min = STOP_SLOP_MIN) {
  const bin = env.MOTION_USE_STOP_SLOP || "stop-slop";
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000, env });
  if (r.error || r.status !== 0) return { installed: false, bin, install: STOP_SLOP_INSTALL, reason: r.error?.code === "ENOENT" ? "not installed" : (r.error?.message ?? r.stderr?.trim()) || "stop-slop --version failed" };
  const version = (r.stdout.match(/\d+\.\d+\.\d+/) ?? [null])[0];
  if (!version || older(version, min))
    return { installed: false, bin, version, install: STOP_SLOP_INSTALL, reason: `stop-slop ${version ?? "(unknown version)"} has no spoken mode; ${min}+ is needed` };
  return { installed: true, bin, version };
}

/**
 * Run stop-slop's spoken mode on one language of a shot list (film.json shots or SCRIPT.md rows).
 * Only Chinese is checked. → null (nothing to check) or
 * {lang, version, findings:[{rule:"stop-slop/<id>", shot, path, text, message, level}], items, error?}
 */
export function stopSlopNarration(shots, lang, tool, { pathOf = (i) => `$.shots[${i}].narration`, env = process.env } = {}) {
  if (String(lang ?? "").toLowerCase().split("-")[0] !== "zh" || !tool?.installed) return null;
  const lines = (Array.isArray(shots) ? shots : []).map((s, i) => ({ i, id: String(s?.id ?? i), text: narrationText(s, lang) })).filter((x) => x.text);
  if (!lines.length) return null;
  const r = spawnSync(tool.bin, ["detect", "--shots", "-", "--json"], {
    input: JSON.stringify(lines.map(({ id, text }) => ({ id, text }))),
    encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024, env,
  });
  if (r.error || r.status !== 0) return { lang, version: tool.version, findings: [], items: [], error: (r.error?.message ?? r.stderr?.trim()) || `stop-slop exited ${r.status}` };
  let out;
  try { out = JSON.parse(r.stdout); } catch { return { lang, version: tool.version, findings: [], items: [], error: "stop-slop did not print JSON" }; }
  const index = new Map(lines.map((x) => [x.id, x.i]));
  const findings = [];
  for (const item of out.items ?? []) {
    if (!item?.flagged || !REPORTED.has(item.level)) continue;
    const ref = item.density !== undefined && item.human_ref !== undefined ? ` ${item.density}/${item.unit ?? ""} vs human ~${item.human_ref}` : "";
    const message = `${item.name}${ref}: ${item.advice ?? "see stop-slop-zh SKILL.md"} (stop-slop; ${GUIDE})`;
    const hits = item.hits?.length ? item.hits : [{}];
    for (const h of hits) {
      const shot = h.shot === undefined || h.shot === null ? null : String(h.shot);
      findings.push({ rule: `stop-slop/${item.id}`, level: item.level, shot, path: shot !== null && index.has(shot) ? pathOf(index.get(shot)) : "$.shots", text: h.excerpt ?? item.name, message });
    }
  }
  return { lang, version: out.version ?? tool.version, findings, items: out.items ?? [] };
}

/**
 * Joins between neighbouring shots for the voice review: `stop-slop candidates --shots - ` (1.3.0+).
 * Each cohesion candidate has prev_shot / prev_tail (end of the previous shot) and shot / next_head
 * (start of the next). A reviewer labels them by stop-slop-zh references/semantic.md section 2.
 * → null (not Chinese, nothing to send, or tool missing) or {version, cohesion:[...], error?}
 */
export function stopSlopCandidates(shots, lang, tool, { env = process.env } = {}) {
  if (String(lang ?? "").toLowerCase().split("-")[0] !== "zh" || !tool?.installed || older(tool.version ?? "0.0.0", STOP_SLOP_CANDIDATES_MIN)) return null;
  const lines = (Array.isArray(shots) ? shots : []).map((s, i) => ({ id: String(s?.id ?? i), text: narrationText(s, lang) })).filter((x) => x.text);
  if (lines.length < 2) return null;
  const r = spawnSync(tool.bin, ["candidates", "--shots", "-"], { input: JSON.stringify(lines), encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024, env });
  if (r.error || r.status !== 0) return { version: tool.version, cohesion: [], error: (r.error?.message ?? r.stderr?.trim()) || `stop-slop exited ${r.status}` };
  try {
    const out = JSON.parse(r.stdout);
    return { version: out.meta?.version ?? tool.version, cohesion: Array.isArray(out.cohesion) ? out.cohesion : [] };
  } catch {
    return { version: tool.version, cohesion: [], error: "stop-slop candidates did not print JSON" };
  }
}
