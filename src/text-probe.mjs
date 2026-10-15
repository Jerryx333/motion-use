// Text check: find drawn text that runs off the frame (or, in portrait, out of the platform-safe
// area) for long enough to be read as clipped. The iphone-use promo shipped a landscape cut whose
// "Scan to connect" callout lost the end of its second line for five seconds (2026-10); only a
// reviewer looking at full-size frames saw it. This measures every fillText/strokeText instead.
// The same probe finds two strings drawn over each other: the same promo cross-faded
// "任何 App，不需要 API" into "一步写入 278 字" in one spot for 0.08 s and shipped to nine platforms.
// Because the probe knows when each string is visible and what is under it, it also reports lines
// gone before they can be read and text too close to its background (WCAG contrast); both warn only.
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { runHyperframes } from "./hf.mjs";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".vrm": "model/gltf-binary",
  ".vrma": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".ktx2": "image/ktx2",
};

/**
 * Group per-sample overflows into runs. A run is the same string over the edge on consecutive
 * samples for at least `minRun` seconds; a whip that carries text through an edge for a frame or
 * two is not a run. Text entirely outside the picture is parked, not clipped, and is ignored.
 * samples: [{ t, boxes: [{ text, x0, y0, x1, y1 }] }], sorted by t.
 */
export function overflowRuns(samples, { width, height, safe = null, vertical = false, step = 0.1, minRun = 0.3 } = {}) {
  const margin = Math.max(2, width * 0.002),
    safeMargin = width * 0.01;
  const offenders = (b) => {
    const out = [];
    const visible = b.x1 > 0 && b.x0 < width && b.y1 > 0 && b.y0 < height;
    if (!visible) return out;
    const sides = [];
    if (b.x0 < -margin) sides.push(["left", -b.x0]);
    if (b.x1 > width + margin) sides.push(["right", b.x1 - width]);
    if (b.y0 < -margin) sides.push(["top", -b.y0]);
    if (b.y1 > height + margin) sides.push(["bottom", b.y1 - height]);
    if (sides.length) out.push({ kind: "frame", sides });
    else if (vertical && safe) {
      const s = [];
      if (b.x0 < safe.x - safeMargin) s.push(["left", safe.x - b.x0]);
      if (b.x1 > safe.x + safe.w + safeMargin) s.push(["right", b.x1 - safe.x - safe.w]);
      if (b.y0 < safe.y - safeMargin) s.push(["top", safe.y - b.y0]);
      if (b.y1 > safe.y + safe.h + safeMargin) s.push(["bottom", b.y1 - safe.y - safe.h]);
      if (s.length) out.push({ kind: "safe", sides: s });
    }
    return out;
  };
  const open = new Map(),
    runs = [];
  const close = (key) => {
    const r = open.get(key);
    open.delete(key);
    if (r.to - r.from + step >= minRun - 1e-6)
      runs.push({ ...r, from: +r.from.toFixed(2), to: +r.to.toFixed(2), overflow_px: Math.round(r.overflow_px), sides: [...r.sides] });
  };
  for (const s of samples) {
    const seen = new Set();
    for (const b of s.boxes)
      for (const o of offenders(b)) {
        const key = `${o.kind}\u0000${b.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const px = Math.max(...o.sides.map((x) => x[1]));
        const r = open.get(key);
        if (r && s.t - r.to <= step * 1.5) {
          r.to = s.t;
          r.overflow_px = Math.max(r.overflow_px, px);
          o.sides.forEach((x) => r.sides.add(x[0]));
        } else {
          if (r) close(key);
          open.set(key, { kind: o.kind, text: b.text, from: s.t, to: s.t, overflow_px: px, sides: new Set(o.sides.map((x) => x[0])) });
        }
      }
    for (const key of [...open.keys()]) if (!seen.has(key)) close(key);
  }
  for (const key of [...open.keys()]) close(key);
  return runs.sort((a, b) => a.from - b.from);
}

const area = (b) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const meet = (a, b) => ({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
const covers = (p, b) => p.x0 <= b.x0 + 1 && p.y0 <= b.y0 + 1 && p.x1 >= b.x1 - 1 && p.y1 >= b.y1 - 1;

/**
 * Pairs of different strings drawn over each other, both clearly visible, for at least `minDur`
 * seconds. Overlap counts when the shared area is at least `ratio` of the smaller box (stacked
 * lines of one paragraph touch at most). A string under an opaque fill drawn between the two (a
 * subtitle plate) is hidden, so that pair does not count; nor does text dimmed below `alpha`.
 * samples: [{ t, boxes: [{ text, x0, y0, x1, y1, alpha, order }], plates: [{ x0…, order }] }].
 */
export function collisionRuns(samples, { alpha = 0.25, ratio = 0.2, minDur = 0.05, gap = 0.15 } = {}) {
  const open = new Map(),
    runs = [];
  const close = (key) => {
    const r = open.get(key);
    open.delete(key);
    if (r.to - r.from + r.dt >= minDur - 1e-6)
      runs.push({ kind: "collision", text: r.a, other: r.b, from: +r.from.toFixed(3), to: +r.to.toFixed(3), overlap: +r.overlap.toFixed(2) });
  };
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i],
      dt = i + 1 < samples.length ? samples[i + 1].t - s.t : 0;
    const vis = s.boxes.filter((b) => (b.alpha ?? 1) >= alpha && area(b) > 0);
    const seen = new Set();
    for (let x = 0; x < vis.length; x++)
      for (let y = x + 1; y < vis.length; y++) {
        const [a, b] = vis[x].order <= vis[y].order ? [vis[x], vis[y]] : [vis[y], vis[x]];
        if (a.text === b.text) continue;
        const m = meet(a, b),
          shared = area(m);
        if (m.x1 <= m.x0 || m.y1 <= m.y0) continue;
        const k = shared / Math.min(area(a), area(b));
        if (k < ratio) continue;
        if ((s.plates ?? []).some((p) => p.order > (a.order ?? -1) && p.order < (b.order ?? Infinity) && covers(p, m))) continue;
        const key = [a.text, b.text].sort().join("\u0000");
        if (seen.has(key)) continue;
        seen.add(key);
        const r = open.get(key);
        if (r && s.t - r.to <= gap) {
          r.to = s.t;
          r.dt = dt;
          r.overlap = Math.max(r.overlap, k);
        } else {
          if (r) close(key);
          open.set(key, { a: a.text, b: b.text, from: s.t, to: s.t, dt, overlap: k });
        }
      }
    for (const key of [...open.keys()]) if (!seen.has(key)) close(key);
  }
  for (const key of [...open.keys()]) close(key);
  return runs.sort((a, b) => a.from - b.from);
}

/** Times to re-sample at frame resolution: every interval where the set of visible strings changed. */
export function transitionTimes(samples, fps, { alpha = 0.25, cap = 4000 } = {}) {
  const names = (s) => new Set(s.boxes.filter((b) => (b.alpha ?? 1) >= alpha).map((b) => b.text));
  const out = [];
  for (let i = 0; i + 1 < samples.length && out.length < cap; i++) {
    const a = names(samples[i]),
      b = names(samples[i + 1]);
    const changed = a.size !== b.size || [...a].some((x) => !b.has(x));
    if (!changed) continue;
    for (let t = samples[i].t + 1 / fps; t < samples[i + 1].t - 1e-6; t += 1 / fps) out.push(+t.toFixed(4));
  }
  return out;
}

// Reading time. 0.3 s per Latin word is about 200 words a minute, the pace subtitle guides
// allow for adults; the 0.5 s is the eye finding the line. Subtitle guides allow about 9 Chinese
// characters a second; motion text competes with the picture, so 0.15 s per CJK character (~7/s).
const CJK = /[⺀-鿿豈-﫿가-힯]/g;
export const READING_RULE = "0.3 s per word + 0.15 s per CJK character + 0.5 s";
export function readingSeconds(text) {
  const s = String(text),
    cjk = (s.match(CJK) ?? []).length,
    words = (s.replace(CJK, " ").match(/[\p{L}\p{N}][\p{L}\p{N}.%°'’-]*/gu) ?? []).length;
  return +(0.5 + 0.3 * words + 0.15 * cjk).toFixed(2);
}

// The same string drawn twice in the same place is one piece of text: a halo (strokeText in the
// background colour) under its fill, or a shadow pass. Without this a map label read "新疆新疆".
const sameDraw = (a, b) => a.text === b.text && area(meet(a, b)) >= 0.8 * Math.min(area(a), area(b));
export function distinctBoxes(boxes) {
  const out = [];
  for (const b of boxes) if (!out.some((o) => sameDraw(o, b))) out.push(b);
  return out;
}

// One line of words drawn piece by piece (M.words draws each word on its own): boxes on the same
// row, close together, read as one line, left to right. Returns { text, parts }.
function lines(boxes) {
  const rows = [];
  for (const b of distinctBoxes(boxes).sort((a, b) => a.x0 - b.x0)) {
    const h = b.y1 - b.y0;
    const row = rows.find((r) => {
      const last = r.at(-1),
        lh = Math.min(h, last.y1 - last.y0),
        overlap = Math.min(b.y1, last.y1) - Math.max(b.y0, last.y0);
      return overlap >= 0.5 * lh && b.x0 - last.x1 <= 1.2 * lh;
    });
    row ? row.push(b) : rows.push([b]);
  }
  const cjk = (ch) => /[⺀-鿿豈-﫿가-힯　-〿＀-￯]/.test(ch ?? "");
  // A word space between pieces that sit apart; letters written one by one stay one word.
  return rows.map((r) => ({
    text: r.reduce((s, b, i) => {
      const gap = i ? b.x0 - r[i - 1].x1 : 0;
      return i && gap > 0.15 * (b.y1 - b.y0) && !cjk(s.at(-1)) && !cjk(b.text[0]) ? `${s} ${b.text}` : s + b.text;
    }, ""),
    parts: r.map((b) => b.text),
  }));
}

/**
 * Lines of text visible for less time than it takes to read them (READING_RULE). A line that grows
 * (a typewriter, words arriving one by one, a counter rolling: digits are ignored for identity)
 * counts from the moment its first part appeared. Strings with no letters are not checked. A line
 * that went because the camera carried it out of the frame (a map label during a push) is not
 * judged: the film moved on, the text did not vanish; a line that disappears in place still is.
 * samples: [{ t, boxes }] sorted by t.
 */
export function readingRuns(samples, { width = Infinity, height = Infinity, alpha = 0.25, gap = 0.15 } = {}) {
  const open = new Map(),
    runs = [];
  const inFrame = (b) => b.x1 > 0 && b.x0 < width && b.y1 > 0 && b.y0 < height;
  const leftFrame = (r) =>
    (samples[r.nextIdx]?.boxes ?? []).some((b) => r.parts.has(b.text) && (b.alpha ?? 1) >= alpha && area(b) > 0 && !inFrame(b));
  const close = (key, at) => {
    const r = open.get(key);
    open.delete(key);
    if (r.grown || leftFrame(r)) return;
    const seconds = at - r.from,
      required = readingSeconds(r.text);
    if (seconds < required - 0.05)
      runs.push({ kind: "reading", text: r.text, from: +r.from.toFixed(2), to: +at.toFixed(2), seconds: +seconds.toFixed(2), required });
  };
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const vis = s.boxes.filter((b) => (b.alpha ?? 1) >= alpha && b.x1 > 0 && b.x0 < width && b.y1 > 0 && b.y0 < height && area(b) > 0);
    const now = new Map();
    for (const line of lines(vis)) if (/\p{L}/u.test(line.text)) now.set(line.text.replace(/\d/g, "0").replace(/\s+/g, ""), line);
    // Gone for longer than `gap`: the line ended at the first sample it was missing from.
    for (const [key, r] of [...open]) if (!now.has(key) && s.t - r.last > gap) close(key, r.next ?? s.t);
    for (const [key, { text, parts }] of now) {
      let r = open.get(key);
      if (!r) {
        r = { from: s.t, text, parts: new Set() };
        for (const [k, o] of open)
          if (!now.has(k) && s.t - o.last <= gap && key.includes(k)) ((r.from = Math.min(r.from, o.from)), (o.grown = true));
        for (const [k, o] of [...open]) if (o.grown) open.delete(k);
        open.set(key, r);
      }
      r.text = text;
      parts.forEach((p) => r.parts.add(p));
      r.last = s.t;
      r.next = samples[i + 1]?.t;
      r.nextIdx = i + 1;
    }
  }
  // A line still up when the film ends sits on the end frame (players hold it or loop): not judged.
  for (const [key, r] of [...open]) r.next === undefined ? open.delete(key) : close(key, r.next);
  return runs.sort((a, b) => a.from - b.from);
}

/**
 * Text against what is drawn under it, for at least `minRun` seconds while fully shown: WCAG
 * contrast under 4.5:1, or 3:1 for large text (≥ 24 px, or ≥ 18.66 px at weight 700+, in frame
 * pixels). The probe gives each filled string its colour and the median pixel under its box.
 */
export function contrastRuns(samples, { step = 0.1, minRun = 0.3, alpha = 0.9 } = {}) {
  const open = new Map(),
    runs = [];
  const close = (key) => {
    const r = open.get(key);
    open.delete(key);
    if (r.to - r.from + step >= minRun - 1e-6) {
      const { last, ...rest } = r;
      runs.push({ ...rest, from: +r.from.toFixed(2), to: +r.to.toFixed(2) });
    }
  };
  for (const s of samples) {
    const seen = new Set();
    for (const b of s.boxes) {
      if (b.contrast === undefined || (b.alpha ?? 1) < alpha) continue;
      const need = b.large ? 3 : 4.5;
      if (b.contrast >= need || seen.has(b.text)) continue;
      seen.add(b.text);
      const r = open.get(b.text);
      if (r && s.t - r.to <= step * 1.5) {
        r.to = s.t;
        if (b.contrast < r.contrast) Object.assign(r, { contrast: b.contrast, color: b.color, backdrop: b.backdrop });
      } else {
        if (r) close(b.text);
        open.set(b.text, { kind: "contrast", text: b.text, from: s.t, to: s.t, contrast: b.contrast, need, large: b.large, color: b.color, backdrop: b.backdrop });
      }
    }
    for (const key of [...open.keys()]) if (!seen.has(key)) close(key);
  }
  for (const key of [...open.keys()]) close(key);
  return runs.sort((a, b) => a.from - b.from);
}

function serve(dir) {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep) && file !== root) return res.writeHead(403).end();
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end();
      res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function browser() {
  // puppeteer-core ships with the pinned engine; resolve it from there.
  const require = createRequire(createRequire(import.meta.url).resolve("hyperframes/package.json"));
  const puppeteer = require("puppeteer-core");
  const r = await runHyperframes(["browser", "path"], {});
  const executablePath = r.out.trim().split("\n").pop();
  if (r.code !== 0 || !executablePath || !fs.existsSync(executablePath))
    throw new Error("no Chrome found (motion-use doctor --install-browser)");
  return puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"] });
}

/**
 * Draw a built film project at every `step` seconds and return the text runs that leave the
 * frame (all formats) or the safe area (portrait). Returns { runs, samples } or { skipped }.
 */
export async function probeText(projDir, duration, { step = 0.1, minRun = 0.3, native = null } = {}) {
  const times = [];
  for (let t = 0; t < duration - 1e-6; t += step) times.push(+t.toFixed(3));
  let server, b;
  try {
    // The probe is the film runtime's own JS: in Chrome, or in motion-render's V8 (same page).
    let draw;
    const errors = [];
    if (native) {
      const { nativeProbe } = await import("./native.mjs");
      draw = (ts) => nativeProbe({ bin: native.bin, projDir, times: ts, work: path.join(projDir, ".probe") });
    } else {
      server = await serve(projDir);
      b = await browser();
      const page = await b.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: "load", timeout: 60000 });
      await page.waitForFunction(() => typeof window.__motionUseTextProbe === "function", { timeout: 30000 });
      draw = async (ts) => {
        const out = { samples: [] };
        for (let i = 0; i < ts.length; i += 100) {
          const r = await page.evaluate((x) => window.__motionUseTextProbe(x), ts.slice(i, i + 100));
          Object.assign(out, r, { samples: [...out.samples, ...r.samples] });
        }
        return out;
      };
    }
    if (!times.length) return { runs: [], samples: 0 };
    const meta = await draw(times);
    const all = meta.samples;
    const runs = overflowRuns(all, { width: meta.width, height: meta.height, safe: meta.safe, vertical: meta.vertical, step, minRun });
    // Cross-fades are shorter than the sampling step: re-draw every frame where text changes.
    const fine = transitionTimes(all, meta.fps || 30);
    const dense = [...all];
    if (fine.length) dense.push(...(await draw(fine)).samples);
    dense.sort((a, b) => a.t - b.t);
    return {
      samples: dense.length,
      step,
      runs: [
        ...runs,
        ...collisionRuns(dense, { minDur: Math.max(0.05, 2 / (meta.fps || 30)) }),
        // the frame-accurate samples time when a line appears and goes
        ...readingRuns(dense, { width: meta.width, height: meta.height }),
        ...contrastRuns(all, { step, minRun }),
      ].sort((a, b) => a.from - b.from),
      page_errors: errors.slice(0, 5),
      renderer: native ? "native" : "chrome",
    };
  } catch (e) {
    return { skipped: `text check did not run: ${e.message.split("\n")[0]}` };
  } finally {
    await b?.close().catch(() => {});
    server?.close();
  }
}

/** Terminal lines for the runs a reviewer must look at. */
export function describeText(check) {
  if (!check) return [];
  if (check.skipped) return [check.note ? `text check skipped (${check.skipped}): ${check.note}` : check.skipped];
  const q = (s) => `"${s.length > 60 ? s.slice(0, 57) + "…" : s}"`;
  const line = (r) =>
    r.kind === "collision"
      ? `text drawn over other text ${r.from}–${r.to}s (${Math.round(r.overlap * 100)}% of the smaller box): ${q(r.text)} × ${q(r.other)}`
      : r.kind === "reading"
        ? `text on screen ${r.from}–${r.to}s for ${r.seconds}s, needs ${r.required}s to read (${READING_RULE}): ${q(r.text)}`
        : r.kind === "contrast"
          ? `low contrast ${r.contrast}:1 ${r.from}–${r.to}s, ${r.color} on ${r.backdrop} (WCAG ${r.need}:1 for ${r.large ? "large" : "normal"} text; large = 24 px+, or 18.66 px+ bold): ${q(r.text)}`
          : `text ${r.kind === "frame" ? "runs off the frame" : "leaves the portrait safe area"} (${r.sides.join("/")}, ${r.overflow_px}px) ${r.from}–${r.to}s: ${q(r.text)}`;
  // Reading and contrast notes can be many on a busy film; the report keeps every one.
  const out = [],
    count = {};
  for (const r of check.runs) {
    count[r.kind] = (count[r.kind] ?? 0) + 1;
    if (!["reading", "contrast"].includes(r.kind) || count[r.kind] <= 8) out.push(line(r));
  }
  for (const k of ["reading", "contrast"])
    if (count[k] > 8) out.push(`${count[k] - 8} more ${k} notes in report.json text_check`);
  return out;
}
