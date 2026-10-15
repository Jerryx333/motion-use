// Measure motion in a delivered MP4: is it a film or a slideshow? Reads only the encoded file.
// Method and thresholds ported from alchaincyf/huashu-art-motion scripts/film_gate.py (MIT),
// without OpenCV: no camera-motion estimate, so cuts are found by frame-difference spikes that
// also change the luminance histogram (a fast push keeps the histogram; a cut replaces it).
import { execFileSync } from "node:child_process";

const FPS = 12, // analysis frame rate
  WIDTH = 320, // analysis width, portrait too
  STILL = 0.3, // mean |Δ| on 0–255 gray: below is still
  DRIFT = 3, // below is slow drift
  FAST = 9, // at or above is a fast change inside a shot
  BLANK_GRAD = 24, // a frame with < 0.2% of pixels above this Sobel magnitude has no edges at all
  BLANK_FRAC = 0.002,
  BLANK_MIN_S = 0.3,
  EDGE_S = 0.5; // ignore the first and last half second for blank frames
// Hue 225–300°, saturation ≥ .30, value .06–.90; a frame is blue-purple when ≥ 30% of its pixels are.
const BP = { hue: [225, 300], sat: 0.3, val: [0.06, 0.9], frame: 0.3 };

// Gate lines from the reference's calibration (13 judged films ≥ 45 s; 88 films for blue-purple).
// They are signals for short films: below SHORT_S a red fast_ratio is reported as yellow.
export const MOTION_LIMITS = {
  fast_ratio: { yellow: 0.06, red: 0.035, low: true },
  blank_run_s: { red: BLANK_MIN_S },
  blue_purple_share: { yellow: 0.12, red: 0.3 },
  worst_window_fast_ratio: { yellow: 0.02, low: true },
  longest_still_s: { yellow: 6 },
  max_event_gap_s: { yellow: 15 },
  // flashes in the densest second; WCAG 2.3.1 allows three
  flashes_per_s: { yellow: 3, red: 3.5 },
};
export const SHORT_S = 20;

function probe(file) {
  const j = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", file], { encoding: "utf8" }),
  );
  return { width: j.streams[0].width, height: j.streams[0].height };
}

function decode(file, fps, width, height, pixFmt) {
  return execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-vf", `fps=${fps},scale=${width}:${height}:flags=area`, "-pix_fmt", pixFmt, "-f", "rawvideo", "-"],
    { maxBuffer: 2 ** 31 - 1, stdio: ["ignore", "pipe", "pipe"] },
  );
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};
const round = (x, n = 3) => (Number.isFinite(x) ? +x.toFixed(n) : null);

function edgeShare(f, w, h) {
  let e = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const gx = f[p - w + 1] + 2 * f[p + 1] + f[p + w + 1] - f[p - w - 1] - 2 * f[p - 1] - f[p + w - 1];
      const gy = f[p + w - 1] + 2 * f[p + w] + f[p + w + 1] - f[p - w - 1] - 2 * f[p - w] - f[p - w + 1];
      if (gx * gx + gy * gy > BLANK_GRAD * BLANK_GRAD) e++;
    }
  return e / ((w - 2) * (h - 2));
}

/** A grayscale frame with fewer than 0.2% strong Sobel edges is nearly empty. */
export function isBlankFrame(frame, width, height) {
  return edgeShare(frame, width, height) < BLANK_FRAC;
}

// Whole-frame cross-dissolves: the endpoints differ, every middle frame is a linear blend of them.
function dissolves(frame, d, cutLike, n, len) {
  const found = [];
  const taken = new Uint8Array(n);
  for (const half of [12, 8, 5, 3, 2])
    for (let t = half; t < n - half; t++) {
      const a = t - half,
        b = t + half;
      if (taken.subarray(a, b).some(Boolean)) continue;
      let sum = 0,
        max = 0,
        cut = false;
      for (let i = a; i < b; i++) {
        sum += d[i];
        max = Math.max(max, d[i]);
        cut ||= cutLike[i];
      }
      if (cut || sum < 10 || max > 0.75 * sum) continue;
      const A = frame(a),
        B = frame(b);
      let dm = 0,
        big = 0,
        nd = 0;
      for (let k = 0; k < len; k++) {
        const D = A[k] - B[k];
        dm += Math.abs(D);
        nd += D * D;
        if (Math.abs(D) > 20) big++;
      }
      if (dm / len < 10 || big / len < 0.2) continue;
      const alphas = [],
        res = [];
      for (let i = a + 1; i < b; i++) {
        const X = frame(i);
        let dot = 0;
        for (let k = 0; k < len; k++) dot += (X[k] - B[k]) * (A[k] - B[k]);
        const al = dot / (nd + 1e-6);
        let r = 0;
        for (let k = 0; k < len; k++) r += Math.abs(X[k] - B[k] - al * (A[k] - B[k]));
        alphas.push(al);
        res.push(r / dm);
      }
      const mono = alphas.every((x, i) => i === 0 || x - alphas[i - 1] <= 0.08);
      const mid = res.filter((_, i) => alphas[i] > 0.15 && alphas[i] < 0.85);
      const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
      if (mono && mid.length >= 2 && mean(mid) < 0.22 && mean(res) < 0.25 && alphas[0] > 0.55 && alphas.at(-1) < 0.45) {
        taken.fill(1, a, b);
        found.push({ start: a / FPS, end: b / FPS, a, b });
      }
    }
  return found.sort((x, y) => x.a - y.a);
}

function bluePurple(file, w, h) {
  const width = 160,
    height = Math.max(2, Math.round((h * width) / w / 2) * 2);
  const raw = decode(file, 2, width, height, "rgb24"),
    px = width * height,
    n = Math.floor(raw.length / (px * 3));
  const bad = [];
  for (let i = 0; i < n; i++) {
    let hit = 0;
    for (let k = 0; k < px; k++) {
      const o = (i * px + k) * 3,
        r = raw[o] / 255,
        g = raw[o + 1] / 255,
        b = raw[o + 2] / 255;
      const mx = Math.max(r, g, b),
        mn = Math.min(r, g, b),
        dd = mx - mn + 1e-6;
      if (mx < BP.val[0] || mx > BP.val[1] || dd / (mx + 1e-6) < BP.sat) continue;
      let hue = mx === r ? ((((g - b) / dd) % 6) + 6) % 6 : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4;
      hue *= 60;
      if (hue >= BP.hue[0] && hue <= BP.hue[1]) hit++;
    }
    bad.push(hit / px >= BP.frame);
  }
  const spans = [];
  let s = null;
  bad.concat(false).forEach((x, i) => {
    if (x && s === null) s = i;
    if (!x && s !== null) {
      if (i - s >= 2) spans.push({ start: s / 2, end: i / 2 });
      s = null;
    }
  });
  return { share: n ? bad.filter(Boolean).length / n : 0, spans };
}

// General flashes after WCAG 2.3.1 (three flashes or below threshold): a transition is a swing of
// relative luminance by ≥ 0.10 where the darker side is below 0.80; a flash is two opposing
// transitions. Each pixel of a 64 px, 30 fps copy tracks its own swings (a fade over several
// frames still counts once), and a frame is a transition when ≥ 25% of the picture swings the
// same way on it. More than three flashes in any one second (seven transitions) is red.
const FLASH = { fps: 30, width: 64, swing: 0.1, dark: 0.8, area: 0.25 };
function flashes(file, w, h) {
  const width = FLASH.width,
    height = Math.max(2, Math.round((h * width) / w / 2) * 2);
  const raw = decode(file, FLASH.fps, width, height, "rgb24"),
    px = width * height,
    n = Math.floor(raw.length / (px * 3));
  const lin = new Float64Array(256).map((_, v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  // Per pixel: direction of the last swing (0 none yet), and the extreme reached since it.
  const dir = new Int8Array(px),
    hi = new Float64Array(px),
    lo = new Float64Array(px),
    marks = [];
  for (let i = 0; i < n; i++) {
    let up = 0,
      down = 0;
    for (let k = 0; k < px; k++) {
      const o = (i * px + k) * 3,
        L = 0.2126 * lin[raw[o]] + 0.7152 * lin[raw[o + 1]] + 0.0722 * lin[raw[o + 2]];
      if (i === 0) {
        hi[k] = lo[k] = L;
        continue;
      }
      // After a rise only a fall can follow, measured from the highest point since (and back).
      if (dir[k] <= 0 && L - lo[k] >= FLASH.swing && lo[k] < FLASH.dark) ((dir[k] = 1), (hi[k] = L), up++);
      else if (dir[k] >= 0 && hi[k] - L >= FLASH.swing && L < FLASH.dark) ((dir[k] = -1), (lo[k] = L), down++);
      else {
        if (dir[k] >= 0) hi[k] = Math.max(hi[k], L);
        if (dir[k] <= 0) lo[k] = Math.min(lo[k], L);
      }
    }
    if (Math.max(up, down) >= FLASH.area * px) marks.push(i / FLASH.fps);
  }
  // The densest one-second window.
  let best = 0,
    at = null,
    j = 0;
  const windows = [];
  for (let i = 0; i < marks.length; i++) {
    while (marks[i] - marks[j] >= 1 - 1e-9) j++;
    const count = i - j + 1;
    if (count > best) ((best = count), (at = marks[j]));
    if (count >= 7) {
      const last = windows.at(-1);
      if (last && marks[j] <= last.end) ((last.end = round(marks[i], 2)), (last.flashes = Math.max(last.flashes, count / 2)));
      else windows.push({ start: round(marks[j], 2), end: round(marks[i], 2), flashes: count / 2 });
    }
  }
  return { per_s: best / 2, at: at === null ? null : round(at, 2), windows };
}

// Colour changes the gray difference misses: a map province turning from blue to red barely moves
// luminance, and a 0.4 s recolour spreads over several analysis frames. Per analysis frame pair:
// the share of pixels (subtitle band masked) whose largest channel moves by ≥ 24. Measured on an
// 8-minute map film, recolours and pushes gave 2.2–2.7 region events per 10 s while fast_ratio stayed
// at 0.017–0.022; the approved launch promo changes ≥ 5% of the frame on half its frame pairs.
const REGION = { width: 160, delta: 24, area: 0.05 };
function colorChange(file, w, h) {
  const width = REGION.width,
    height = Math.max(2, Math.round((h * width) / w / 2) * 2),
    hc = Math.round(height * (1 - (h > w ? 0.18 : 0.15)));
  const raw = decode(file, FPS, width, height, "rgb24"),
    px = width * height,
    n = Math.floor(raw.length / (px * 3)),
    len = width * hc;
  const share = new Float64Array(Math.max(0, n - 1));
  for (let i = 0; i + 1 < n; i++) {
    let hit = 0;
    for (let k = 0; k < len; k++) {
      const a = (i * px + k) * 3,
        b = a + px * 3;
      if (Math.max(Math.abs(raw[a] - raw[b]), Math.abs(raw[a + 1] - raw[b + 1]), Math.abs(raw[a + 2] - raw[b + 2])) >= REGION.delta) hit++;
    }
    share[i] = hit / len;
  }
  return share;
}

// cuts: authored hard-cut times in seconds, always treated as transitions (not as motion).
export function measureMotion(file, { cuts = [] } = {}) {
  const { width: W0, height: H0 } = probe(file);
  const h = Math.max(2, Math.round((H0 * WIDTH) / W0 / 2) * 2);
  const raw = decode(file, FPS, WIDTH, h, "gray");
  // Mask the bottom subtitle band so burned-in captions do not count as picture motion.
  const hc = Math.round(h * (1 - (H0 > W0 ? 0.18 : 0.15))),
    len = WIDTH * hc,
    n = Math.floor(raw.length / (WIDTH * h));
  if (n < 4) throw new Error("video too short to measure motion");
  const frame = (i) => raw.subarray(i * WIDTH * h, i * WIDTH * h + len);
  const d = new Float64Array(n - 1),
    hist = [];
  for (let i = 0; i < n; i++) {
    const f = frame(i),
      hh = new Float64Array(32);
    for (let k = 0; k < len; k++) hh[f[k] >> 3]++;
    hist.push(hh.map((x) => x / len));
  }
  for (let i = 0; i < n - 1; i++) {
    const a = frame(i),
      b = frame(i + 1);
    let s = 0;
    for (let k = 0; k < len; k++) s += Math.abs(a[k] - b[k]);
    d[i] = s / len;
  }
  const histDiff = (i) => {
    let s = 0;
    for (let k = 0; k < 32; k++) s += Math.abs(hist[i][k] - hist[i + 1][k]);
    return s / 2;
  };
  const cutLike = new Array(n - 1).fill(false);
  for (let i = 0; i < n - 1; i++) {
    const nb = [...d.slice(Math.max(0, i - 6), i), ...d.slice(i + 1, Math.min(n - 1, i + 7))];
    cutLike[i] = d[i] >= Math.max(8, 3 * median(nb) + 2) && histDiff(i) >= 0.25;
  }
  for (const c of cuts) {
    const i = Math.min(n - 2, Math.max(0, Math.ceil(c * FPS) - 1));
    if (d[i] > STILL) cutLike[i] = true;
  }
  // Dissolves are whole-frame blends: an 80 px copy is enough and 16× cheaper.
  const sw = WIDTH / 4,
    sh = Math.floor(hc / 4),
    small = new Float32Array(n * sw * sh);
  for (let i = 0; i < n; i++) {
    const f = frame(i);
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++) {
        let s = 0;
        for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) s += f[(y * 4 + dy) * WIDTH + x * 4 + dx];
        small[(i * sh + y) * sw + x] = s / 16;
      }
  }
  const smallFrame = (i) => small.subarray(i * sw * sh, (i + 1) * sw * sh);
  const diss = dissolves(smallFrame, d, cutLike, n, sw * sh),
    inDiss = new Array(n - 1).fill(false);
  for (const x of diss) inDiss.fill(true, x.a, x.b);
  const trans = cutLike.map((c, i) => c || inDiss[i]);
  const cutStarts = cutLike.flatMap((c, i) => (c && !cutLike[i - 1] ? [i] : []));

  let fast = 0,
    still = 0,
    drift = 0,
    count = 0,
    longest = 0,
    run = 0,
    longestAt = 0;
  const fastFull = new Array(n - 1).fill(false);
  for (let i = 0; i < n - 1; i++) {
    if (trans[i]) {
      run = 0;
      continue;
    }
    count++;
    if (d[i] >= FAST) (fast++, (fastFull[i] = true));
    else if (d[i] < STILL) still++;
    else if (d[i] < DRIFT) drift++;
    run = d[i] < STILL ? run + 1 : 0;
    if (run > longest) ((longest = run), (longestAt = i - run + 1));
  }
  // Region changes in colour inside shots (a recolour, an arrow drawn, a stamp landing).
  const region = colorChange(file, W0, H0),
    regionFull = Array.from({ length: n - 1 }, (_, i) => !trans[i] && (region[i] ?? 0) >= REGION.area);
  const regionStarts = regionFull.flatMap((v, i) => (v && !regionFull[i - 1] ? [i] : []));
  // Events: cuts, dissolves, the start of each fast run and of each region change, merged within 0.3 s.
  const events = [...cutStarts, ...diss.map((x) => (x.a + x.b) >> 1), ...regionStarts];
  fastFull.forEach((v, i) => v && !fastFull[i - 1] && events.push(i));
  events.sort((a, b) => a - b);
  const merged = events.filter((t, i, all) => i === 0 || t - all[i - 1] > 0.3 * FPS);
  const marks = [0, ...merged, n - 1];
  let maxGap = 0,
    gapAt = 0;
  for (let i = 1; i < marks.length; i++)
    if (marks[i] - marks[i - 1] > maxGap) ((maxGap = marks[i] - marks[i - 1]), (gapAt = marks[i - 1]));
  // The worst 30 s window (half the film when shorter than 60 s) catches a strong start and a slack middle.
  const seconds = n / FPS,
    win = Math.floor(Math.min(30, seconds / 2) * FPS);
  let worst = null,
    worstAt = null;
  if (win >= 4 * FPS)
    for (let s = 0; s + win <= n - 1; s += FPS) {
      let f = 0,
        c = 0;
      for (let i = s; i < s + win; i++) if (!trans[i]) (c++, (f += fastFull[i] ? 1 : 0));
      const v = c ? f / c : 0;
      if (worst === null || v < worst) ((worst = v), (worstAt = s / FPS));
    }
  const blankOk = new Array(n).fill(true),
    edge = Math.round(EDGE_S * FPS);
  for (let i = 0; i < n; i++) if (i < edge || i >= n - edge) blankOk[i] = false;
  trans.forEach((t, i) => t && ((blankOk[i] = false), (blankOk[i + 1] = false)));
  const blankRuns = [];
  let b0 = null;
  for (let i = 0; i <= n; i++) {
    const blank = i < n && blankOk[i] && isBlankFrame(frame(i), WIDTH, hc);
    if (blank && b0 === null) b0 = i;
    if (!blank && b0 !== null) {
      if ((i - b0) / FPS >= BLANK_MIN_S - 1e-9) blankRuns.push({ start: round(b0 / FPS, 2), end: round(i / FPS, 2) });
      b0 = null;
    }
  }
  const bp = bluePurple(file, W0, H0),
    fl = flashes(file, W0, H0);
  return {
    method: "12 fps, 320 px gray, subtitle band masked; cuts by difference spike + histogram change (heuristic) plus authored cuts; region events: ≥ 5% of a 160 px colour frame changing by ≥ 24",
    seconds: round(seconds, 2),
    cuts: cutStarts.map((i) => round((i + 1) / FPS, 2)),
    dissolves: diss.map((x) => ({ start: round(x.start, 2), end: round(x.end, 2) })),
    fast_ratio: round(count ? fast / count : 0, 4),
    still_ratio: round(count ? still / count : 0),
    drift_ratio: round(count ? drift / count : 0),
    longest_still_s: round(longest / FPS, 2),
    longest_still_at: round(longestAt / FPS, 2),
    events_per_10s: round((merged.length / seconds) * 10, 2),
    color_change_ratio: round(count ? regionFull.filter(Boolean).length / count : 0, 4),
    region_events_per_10s: round((regionStarts.length / seconds) * 10, 2),
    max_event_gap_s: round(maxGap / FPS, 2),
    max_event_gap_at: round(gapAt / FPS, 2),
    worst_window_fast_ratio: round(worst, 4),
    worst_window_at: worstAt,
    blank_run_s: blankRuns.reduce((m, r) => Math.max(m, r.end - r.start), 0),
    blank_runs: blankRuns,
    blue_purple_share: round(bp.share),
    blue_purple_spans: bp.spans,
    flashes_per_s: fl.per_s,
    flashes_at: fl.at,
    flash_windows: fl.windows,
  };
}

// Lights per metric. Only fast_ratio, blank_run_s, blue_purple_share and flashes_per_s can be red.
export function gradeMotion(m, { allowStatic = null, allowBluePurple = null } = {}) {
  const rows = [];
  for (const [key, lim] of Object.entries(MOTION_LIMITS)) {
    const v = m[key];
    if (v === null || v === undefined) continue;
    const bad = (t) => t !== undefined && (lim.low ? v <= t : v >= t);
    let level = bad(lim.red) ? "red" : bad(lim.yellow) ? "yellow" : "green";
    let note = null;
    if (level === "red" && key === "fast_ratio" && m.seconds < SHORT_S)
      ((level = "yellow"), (note = `shorter than ${SHORT_S}s: calibrated on longer films`));
    if (level === "red" && key === "fast_ratio" && allowStatic) ((level = "yellow"), (note = `allowed: ${allowStatic}`));
    // Low fast_ratio with frequent region events is a different problem from a slideshow: things
    // happen, but each changes little of the picture. Say so; the light stays as measured.
    if (key === "fast_ratio" && level !== "green" && (m.region_events_per_10s ?? 0) >= 1.5) {
      const hint = `${m.region_events_per_10s} region changes per 10 s, but each moves little of the frame (low contrast or small): enlarge what moves, push the camera further, or raise contrast`;
      note = note ? `${note}; ${hint}` : hint;
    }
    if (level === "red" && key === "blue_purple_share" && allowBluePurple)
      ((level = "yellow"), (note = `allowed: ${allowBluePurple}`));
    rows.push({ metric: key, value: v, level, ...(note ? { note } : {}) });
  }
  const level = rows.some((r) => r.level === "red") ? "red" : rows.some((r) => r.level === "yellow") ? "yellow" : "green";
  return { level, rows };
}

// "Copied the demo": compare a film's frames with signatures of the starter and bundled
// examples (assets/demo-signatures.json). Descriptor after huashu-art-motion's
// template_similarity: a 12×8 gray thumbnail and a 12×8 edge map, each z-scored.
const SIG_FPS = 1;
function descriptor(f, w, h, cols, rows) {
  const gray = new Float64Array(cols * rows),
    edge = new Float64Array(cols * rows),
    count = new Float64Array(cols * rows);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x,
        k = Math.min(rows - 1, Math.floor((y * rows) / h)) * cols + Math.min(cols - 1, Math.floor((x * cols) / w));
      const gx = f[p + 1] - f[p - 1],
        gy = f[p + w] - f[p - w];
      gray[k] += f[p];
      edge[k] += Math.hypot(gx, gy);
      count[k]++;
    }
  const z = (v) => {
    const mean = v.reduce((s, x) => s + x, 0) / v.length,
      sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length) || 1;
    return [...v].map((x) => +((x - mean) / sd).toFixed(2));
  };
  return [...z(gray.map((g, i) => g / (count[i] || 1))), ...z(edge.map((g, i) => g / (count[i] || 1)))];
}
export function frameSignatures(file) {
  const { width: W0, height: H0 } = probe(file),
    vertical = H0 > W0,
    [cols, rows] = vertical ? [8, 12] : [12, 8],
    w = vertical ? 108 : 192,
    h = Math.max(2, Math.round((H0 * w) / W0 / 2) * 2);
  const raw = decode(file, SIG_FPS, w, h, "gray"),
    n = Math.floor(raw.length / (w * h));
  return {
    orientation: vertical ? "vertical" : "landscape",
    frames: Array.from({ length: n }, (_, i) => descriptor(raw.subarray(i * w * h, (i + 1) * w * h), w, h, cols, rows)),
  };
}
const cos = (a, b, from, to) => {
  let d = 0,
    x = 0,
    y = 0;
  for (let i = from; i < to; i++) ((d += a[i] * b[i]), (x += a[i] * a[i]), (y += b[i] * b[i]));
  return d / Math.sqrt(x * y || 1);
};
// Layout likeness that survives a re-skin: edges, plus brightness with its polarity ignored
// (a dark palette inverts light and dark but keeps the layout).
const cosine = (a, b) => {
  const half = a.length / 2;
  return 0.5 * cos(a, b, half, a.length) + 0.5 * Math.abs(cos(a, b, 0, half));
};
// Share of the film's frames that follow a demo: runs of ≥ 3 consecutive frames whose closest
// frame in one demo is similar (cosine ≥ 0.70) and advances through it in order. A single
// static look-alike (big word on a flat background) never advances, so it does not count.
export function demoSimilarity(file, demos) {
  const mine = frameSignatures(file),
    pool = demos.filter((d) => d.orientation === mine.orientation);
  const best = mine.frames.map((f) => {
    let top = { sim: 0, name: null, index: -1 };
    for (const d of pool)
      d.frames.forEach((g, index) => {
        const sim = cosine(f, g);
        if (sim > top.sim) top = { sim, name: d.name, index };
      });
    return top;
  });
  let hits = 0,
    closest = null;
  for (let i = 0; i < best.length; ) {
    let j = i;
    if (best[i].sim >= 0.7)
      while (
        j + 1 < best.length &&
        best[j + 1].sim >= 0.7 &&
        best[j + 1].name === best[i].name &&
        best[j + 1].index - best[j].index >= 0 &&
        best[j + 1].index - best[j].index <= 2
      )
        j++;
    if (j - i + 1 >= 3 && best[j].index - best[i].index >= 2) ((hits += j - i + 1), (closest = best[i].name));
    i = j + 1;
  }
  const max = best.reduce((m, b) => Math.max(m, b.sim), 0);
  return { share: best.length ? +(hits / best.length).toFixed(3) : 0, max: +max.toFixed(3), closest };
}
