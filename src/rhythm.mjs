// Author-declared direction, not an aesthetic score or measured audiovisual energy.
export const RHYTHM_ROUTES = ["continuous", "montage", "hybrid"];
export const RHYTHM_PHASES = ["hook", "build", "hold", "burst", "stop", "peak", "resolve"];
export const RHYTHM_EVENTS = ["cut", "camera", "reveal", "text", "sound", "instrument"];
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const finite = (v, a, b) => Number.isFinite(v) && v >= a && v <= b;

export function validateRhythm(rhythm, { duration, shots = [] } = {}) {
  shots = Array.isArray(shots) ? shots : [];
  const errors = [], warnings = [];
  const error = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });
  if (rhythm === undefined) return { errors, warnings };
  if (!object(rhythm)) return { errors: [{ path: "$.rhythm", message: "an optional rhythm object" }], warnings };
  if (!RHYTHM_ROUTES.includes(rhythm.route)) error("$.rhythm.route", RHYTHM_ROUTES.join(", "));
  if (rhythm.bpm !== undefined && !finite(rhythm.bpm, 40, 240)) error("$.rhythm.bpm", "optional declared planning tempo, 40–240; not measured from the soundtrack");
  if (!Array.isArray(rhythm.phases) || !rhythm.phases.length || rhythm.phases.length > 200) {
    error("$.rhythm.phases", "1–200 ordered phases covering the whole film");
    return { errors, warnings };
  }
  const ids = new Set();
  let end = 0;
  for (const [i, p] of rhythm.phases.entries()) {
    const at = `$.rhythm.phases[${i}]`;
    if (!object(p)) { error(at, "a phase object"); continue; }
    if (typeof p.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(p.id) || ids.has(p.id)) error(`${at}.id`, "a unique lowercase slug");
    ids.add(p.id);
    if (!RHYTHM_PHASES.includes(p.type)) error(`${at}.type`, RHYTHM_PHASES.join(", "));
    if (!finite(p.from, 0, duration) || !finite(p.to, 0, duration) || p.to <= p.from) error(at, "0 <= from < to <= duration");
    if (!Number.isFinite(p.from) || Math.abs(p.from - end) > 0.001) error(`${at}.from`, "phases must cover the timeline without gaps or overlaps");
    end = p.to;
    if (!finite(p.energy, 0, 10)) error(`${at}.energy`, "author-declared energy, 0–10; not a measurement");
    if (typeof p.action !== "string" || !p.action.trim() || p.action.length > 1000) error(`${at}.action`, "what visibly or audibly changes, at most 1000 characters");
    if (p.type === "stop" && (typeof p.reason !== "string" || !p.reason.trim())) error(`${at}.reason`, "why this pause helps the film");
    if (p.shots !== undefined && (!Array.isArray(p.shots) || !p.shots.length || new Set(p.shots).size !== p.shots.length || p.shots.some((id) => !shots.some((s) => s.id === id && s.start < p.to && s.end > p.from)))) error(`${at}.shots`, "unique shot IDs overlapping this phase");
  }
  if (!Number.isFinite(end) || Math.abs(end - duration) > 0.001) error("$.rhythm.phases", "last phase must end at film duration");
  if (rhythm.events !== undefined && (!Array.isArray(rhythm.events) || rhythm.events.length > 10000)) error("$.rhythm.events", "at most 10000 declared events");
  else {
    const events = new Set();
    for (const [i, e] of (rhythm.events ?? []).entries()) {
      const at = `$.rhythm.events[${i}]`;
      if (!object(e)) { error(at, "an event object"); continue; }
      if (typeof e.id !== "string" || !e.id.trim() || events.has(e.id)) error(`${at}.id`, "a unique nonempty event id");
      events.add(e.id);
      if (!finite(e.at, 0, duration) || e.at === duration) error(`${at}.at`, "0 <= at < duration");
      if (!RHYTHM_EVENTS.includes(e.kind)) error(`${at}.kind`, RHYTHM_EVENTS.join(", "));
      if (e.shot !== undefined && !shots.some((s) => s.id === e.shot && e.at >= s.start && e.at < s.end)) error(`${at}.shot`, "a shot containing the event time");
    }
  }
  if (!errors.length) {
    if (rhythm.phases[0].type !== "hook") warn("$.rhythm.phases[0]", "no opening hook phase; review what earns attention in the first seconds");
    const energies = rhythm.phases.map((p) => p.energy);
    if (rhythm.phases.length > 1 && Math.max(...energies) - Math.min(...energies) < 2) warn("$.rhythm.phases", "little declared energy contrast; review whether each phase feels different");
    if (rhythm.route !== "continuous" && !rhythm.phases.some((p) => ["burst", "peak"].includes(p.type))) warn("$.rhythm.phases", "montage/hybrid route has no burst or peak; review the intended climax");
    if (rhythm.phases.at(-1).type !== "resolve") warn("$.rhythm.phases", "no closing resolve phase; review the final takeaway");
  }
  return { errors, warnings };
}

export function rhythmPlan(film) {
  const checked = validateRhythm(film.rhythm, film);
  const base = { schemaVersion: 1, evidence: "author-declared-plan", visualReview: "UNREVIEWED", listeningReview: "UNREVIEWED", ...checked };
  if (checked.errors.length) return { ...base, ok: false, status: "INVALID", phases: [] };
  if (!film.rhythm) return { ...base, ok: true, status: "UNPLANNED", phases: [], warning: "no rhythm plan; no aesthetic conclusion is implied" };
  const bpm = film.rhythm.bpm ?? null, eventsDeclared = film.rhythm.events !== undefined;
  return { ...base, ok: true, status: "PLANNED", route: film.rhythm.route, bpm, eventsDeclared,
    phases: film.rhythm.phases.map((p) => {
      const events = (film.rhythm.events ?? []).filter((e) => e.at >= p.from && e.at < p.to);
      return { ...p, shots: film.shots.filter((s) => s.start < p.to && s.end > p.from).map((s) => s.id),
        events, declaredEventCount: eventsDeclared ? events.length : null,
        declaredEventsPerSecond: eventsDeclared ? +(events.length / (p.to - p.from)).toFixed(2) : null,
        declaredEventsPerBar: eventsDeclared && bpm !== null ? +(events.length / ((p.to - p.from) * bpm / 240)).toFixed(2) : null };
    }),
  };
}

// Retime only unambiguous anchors. A phase boundary must coincide with a shot
// boundary; events remain at their offset in their containing shot. No silent scaling.
export function retimeRhythm(rhythm, before, after, duration) {
  if (!rhythm) return rhythm;
  const boundary = (time) => {
    if (Math.abs(time - before.at(-1).end) < 1e-6) return duration;
    const index = before.findIndex((s) => Math.abs(s.start - time) < 1e-6);
    if (index < 0) throw new Error(`rhythm boundary ${time}s is inside a shot; deliberately edit its new timing before retime`);
    return after[index].start;
  };
  return { ...rhythm, phases: rhythm.phases.map((p) => ({ ...p, from: boundary(p.from), to: boundary(p.to) })),
    ...(rhythm.events === undefined ? {} : { events: rhythm.events.map((e) => {
      const index = before.findIndex((s) => e.at >= s.start && e.at < s.end);
      if (index < 0) throw new Error(`rhythm event ${e.id} is outside the original timeline`);
      const offset = e.at - before[index].start;
      if (offset >= after[index].end - after[index].start) throw new Error(`rhythm event ${e.id} exceeds its retimed shot; edit its timing deliberately`);
      return { ...e, at: after[index].start + offset };
    }) }),
  };
}
