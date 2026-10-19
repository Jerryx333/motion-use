import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Persist operational metadata only. Never put script text, argv, or service output here.
export function createJournal(file, context = {}, now = () => Date.now()) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const run = context.run ?? crypto.randomUUID();
  const started = now();
  const phases = new Map();
  const emit = (phase, event, data = {}) => {
    const timestamp = now();
    const key = `${phase}:${data.task ?? ""}`;
    if (event === "started") phases.set(key, timestamp);
    const row = { schemaVersion: 1, run, at: new Date(timestamp).toISOString(), elapsed_s: (timestamp - started) / 1000, phase, event };
    const parentRun = context.parentRun ?? process.env.MOTION_USE_JOURNAL_PARENT_RUN;
    if (parentRun) row.parent_run = String(parentRun).slice(0, 256);
    for (const key of ["task", "status", "duration_s", "output_seconds", "cache_hit", "attempt", "frames", "total", "reason_code"]) {
      const value = data[key];
      if (typeof value === "string") row[key] = value.slice(0, 256);
      else if (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) row[key] = value;
    }
    if (event === "finished" && phases.has(key)) {
      row.duration_s ??= (timestamp - phases.get(key)) / 1000;
      phases.delete(key);
    }
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("journal must be a single-link regular file");
      fs.writeFileSync(fd, JSON.stringify(row) + "\n", { encoding: "utf8" });
    } finally { fs.closeSync(fd); }
    return row;
  };
  emit.runId = run;
  return emit;
}

export function aggregateJournal(file) {
  const rows = [], warnings = [];
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
      const row = JSON.parse(lines[i]);
      if (!Number.isFinite(Date.parse(row.at))) throw new Error("invalid timestamp");
      rows.push(row);
    } catch { warnings.push(`ignored incomplete or invalid journal row ${i + 1}`); }
  }
  const times = rows.map(r => Date.parse(r.at));
  const intervals = rows.filter(r => r.event === "finished" && Number.isFinite(r.duration_s) && r.duration_s >= 0);
  const phases = {};
  for (const row of intervals.filter(r => !["command", "batch"].includes(r.phase))) phases[row.phase] = (phases[row.phase] ?? 0) + row.duration_s;
  const byRun = new Map();
  for (const row of intervals) { const group = byRun.get(row.run) ?? []; group.push(row); byRun.set(row.run, group); }
  const selected = new Map([...byRun].map(([run, group]) => {
    const commands = group.filter(r => r.phase === "command");
    if (commands.length) return [run, commands];
    const tasks = group.filter(r => r.task !== undefined);
    return [run, tasks.length ? tasks : group.filter(r => r.phase !== "batch")];
  }));
  // Child CLI commands can share a journal with their scheduling task. Their
  // parent interval already measures their processing and must not be added twice.
  const processing = [...selected].flatMap(([, group]) => group.filter(row => !selected.get(row.parent_run)?.some(parent => {
    const end = Date.parse(row.at), parentEnd = Date.parse(parent.at);
    return end <= parentEnd && end - row.duration_s * 1000 >= parentEnd - parent.duration_s * 1000;
  })));
  const spans = processing.map(r => [Date.parse(r.at) - r.duration_s * 1000, Date.parse(r.at)]).sort((a, b) => a[0] - b[0]);
  let unionMs = 0, end = -Infinity;
  for (const [start, stop] of spans) { unionMs += Math.max(0, stop - Math.max(start, end)); end = Math.max(end, stop); }
  const outputs = rows.filter(r => r.event === "finished" && r.status === "success" && Number.isFinite(r.output_seconds));
  return {
    schemaVersion: 1,
    measurement_scope: "Observed command/task elapsed intervals, including unseparated service waits; not CPU or model computation time",
    wall_elapsed_s: times.length ? (Math.max(...times) - Math.min(...times)) / 1000 : null,
    // Union of processing intervals, excluding command/phase nesting and overlap.
    active_processing_s: processing.length ? unionMs / 1000 : null,
    processing_sum_s: processing.length ? processing.reduce((n, r) => n + r.duration_s, 0) : null,
    phase_seconds: phases,
    waiting_s: null,
    cost: null,
    retries: rows.filter(r => r.event === "started" && r.attempt > 1).length,
    cache_hits: rows.filter(r => r.cache_hit === true).length,
    output_video_seconds: outputs.length ? outputs.reduce((n, r) => n + r.output_seconds, 0) : null,
    warnings,
  };
}
