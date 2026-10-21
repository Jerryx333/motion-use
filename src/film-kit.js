// Browser-only drawing kit for authored films. Everything is a pure function of time or a seed.
// Easing constants, the pulse camera, palettes and the whiteboard reveal follow
// alchaincyf/huashu-art-motion (MIT, scripts/engine/lib). The runtime only adds names that
// do not already exist on `motion`, so older drawing code keeps its exact behavior.
window.__filmKit = function (view, film) {
  // Only decorative text is exempt. try/finally restores nested scopes even on errors.
  function decorativeTexture(c, draw) {
    const previous = c.__motionUseTexture;
    c.__motionUseTexture = true;
    try { return draw(c); } finally { c.__motionUseTexture = previous; }
  }
  function shotTime(t, id) {
    const s = id === undefined ? film.shots.find((s) => t >= s.start && t < s.end) : film.shots.find((s) => s.id === id);
    if (!s) throw new Error(`shotTime: no shot ${id ?? "at " + t}`);
    return (t - s.start) * ((s.authoredDuration ?? (s.end - s.start)) / (s.end - s.start));
  }
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const lerp = (a, b, p) => a + (b - a) * p;
  const bezier = (x1, y1, x2, y2) => (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const cx = 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3 - x;
      const dx = 3 * x1 * (1 - t) ** 2 + 6 * (x2 - x1) * t * (1 - t) + 3 * (1 - x2) * t * t;
      if (Math.abs(dx) < 1e-6) break;
      t = clamp(t - cx / dx);
    }
    return 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3;
  };
  const smooth = (p) => {
    const t = clamp(p);
    return t ** 3 * (10 - 15 * t + 6 * t * t);
  };
  const easings = {
    linear: clamp,
    smooth, // manim's default: still at both ends
    sineInOut: (p) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(p)),
    cubicIn: (p) => clamp(p) ** 3,
    cubicOut: (p) => 1 - (1 - clamp(p)) ** 3,
    cubicInOut: (p) => {
      const t = clamp(p);
      return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
    },
    quartOut: (p) => 1 - (1 - clamp(p)) ** 4,
    quintOut: (p) => 1 - (1 - clamp(p)) ** 5,
    quintInOut: (p) => {
      const t = clamp(p);
      return t < 0.5 ? 16 * t ** 5 : 1 - (-2 * t + 2) ** 5 / 2;
    },
    expoIn: (p) => (p <= 0 ? 0 : 2 ** (10 * clamp(p) - 10)),
    expoOut: (p) => (p >= 1 ? 1 : 1 - 2 ** (-10 * clamp(p))),
    expoInOut: (p) => {
      const t = clamp(p);
      if (t === 0 || t === 1) return t;
      return t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2;
    },
    // s = 1.70158 overshoots ~10%; 2.2 → 13%, 2.6 → 17%, 3.5 → 23%.
    backOut: (p, s = 1.70158) => {
      const t = clamp(p) - 1;
      return 1 + (s + 1) * t ** 3 + s * t * t;
    },
    elasticOut: (p) => {
      const t = clamp(p);
      if (t === 0 || t === 1) return t;
      return 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
    },
    appleOut: bezier(0.25, 0.1, 0.25, 1),
    emphasized: bezier(0.2, 0, 0, 1),
    k75: bezier(0.75, 0, 0.25, 1), // Kurzgesagt-style action
    easyEase: bezier(0.333, 0, 0.667, 1),
    longTail: bezier(0.33, 0, 0.2, 1),
  };
  const easeOf = (e) => (typeof e === "function" ? e : easings[e] || easings.cubicInOut);
  const zlerp = (z0, z1, p) => z0 * Math.pow(z1 / z0, p);
  const PULSE = { push: 0.28, pan: 0.3, slam: 0.17, k: 0.25, kMin: 0.18, kMax: 0.32 };
  const slamK = (k, from = 1.55, under = 0.94) =>
    k <= 0 ? from : k < 0.6 ? from - (from - under) * (k / 0.6) : k < 1 ? under + (1 - under) * ((k - 0.6) / 0.4) : 1;

  // Pulse camera: hold → a fast push, pan or slam → hold. Each event starts from where the
  // earlier events have brought the camera at time t; the world point (x, y) sits at screen centre.
  function camera(t, events = [], base = {}) {
    let cam = { x: base.x ?? view.width / 2, y: base.y ?? view.height / 2, z: base.z ?? 1, r: base.r ?? 0, anchor: base.anchor ?? [view.width / 2, view.height / 2] };
    let zMul = 1,
      dy = 0,
      moving = false;
    for (const e of [...events].sort((a, b) => a.at - b.at)) {
      if (t < e.at) break;
      const kind = e.kind ?? "push";
      if (kind === "cut") {
        cam = { ...cam, ...pick(e) };
        continue;
      }
      if (kind === "slam") {
        const k = (t - e.at) / (e.dur ?? PULSE.slam);
        if (k < 1) ((zMul *= slamK(k, e.from, e.under)), (moving = true));
        continue;
      }
      if (kind === "shake") {
        const dur = e.dur ?? 4 / 30,
          k = (t - e.at) / dur;
        if (k < 1) ((dy += ((e.amp ?? 14) * Math.sin(4 * Math.PI * k) * (1 - k)) / cam.z), (moving = true));
        continue;
      }
      const dur = e.dur ?? (kind === "pan" ? PULSE.pan : PULSE.push),
        raw = (t - e.at) / dur,
        p = easeOf(e.ease)(raw);
      if (raw < 1) moving = true;
      const target =
        kind === "push"
          ? { x: e.x ?? cam.x, y: e.y ?? cam.y, z: cam.z * (1 + (e.k ?? PULSE.k)), r: e.r ?? cam.r }
          : { x: e.x ?? cam.x, y: e.y ?? cam.y, z: kind === "pan" ? cam.z : (e.z ?? cam.z), r: e.r ?? cam.r };
      cam = { x: lerp(cam.x, target.x, p), y: lerp(cam.y, target.y, p), z: zlerp(cam.z, target.z, p), r: lerp(cam.r, target.r, p), anchor: cam.anchor.map((v, i) => lerp(v, (e.anchor ?? cam.anchor)[i], p)) };
    }
    return { x: cam.x, y: cam.y + dy, z: cam.z * zMul, r: cam.r, anchor: cam.anchor, moving };
  }
  const pick = (e) => Object.fromEntries(["x", "y", "z", "r", "anchor"].filter((k) => e[k] !== undefined).map((k) => [k, e[k]]));
  function applyCamera(c, cam) {
    c.translate(...(cam.anchor ?? [view.width / 2, view.height / 2]));
    c.rotate(cam.r || 0);
    c.scale(cam.z, cam.z);
    c.translate(-cam.x, -cam.y);
  }
  function toScreen(cam, x, y) {
    const dx = (x - cam.x) * cam.z,
      dy = (y - cam.y) * cam.z,
      cs = Math.cos(cam.r || 0),
      sn = Math.sin(cam.r || 0);
    const anchor = cam.anchor ?? [view.width / 2, view.height / 2];
    return [anchor[0] + dx * cs - dy * sn, anchor[1] + dx * sn + dy * cs];
  }

  function rng(seed = 1) {
    let s = seed >>> 0 || 1;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const perm = (() => {
    const r = rng(1337),
      p = [...Array(256).keys()];
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    return [...p, ...p];
  })();
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (h, x, y) => ((h & 1 ? -x : x) + (h & 2 ? -y : y)) * (h & 4 ? 0.7071 : 1);
  function noise(x, y = 0) {
    const X = Math.floor(x) & 255,
      Y = Math.floor(y) & 255,
      xf = x - Math.floor(x),
      yf = y - Math.floor(y),
      u = fade(xf),
      v = fade(yf);
    const aa = perm[perm[X] + Y],
      ab = perm[perm[X] + Y + 1],
      ba = perm[perm[X + 1] + Y],
      bb = perm[perm[X + 1] + Y + 1];
    return lerp(lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u), lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u), v);
  }
  const fbm = (x, y = 0, octaves = 4) => {
    let s = 0,
      a = 0.5,
      f = 1;
    for (let i = 0; i < octaves; i++) ((s += a * noise(x * f, y * f)), (a *= 0.5), (f *= 2));
    return s;
  };

  const pathLength = (pts) => {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return L;
  };
  function resample(pts, step) {
    if (pts.length < 2) return pts.map((p) => [...p]);
    const out = [[...pts[0]]];
    let carry = 0;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1],
        [bx, by] = pts[i],
        seg = Math.hypot(bx - ax, by - ay);
      let d = step - carry;
      while (d <= seg) (out.push([lerp(ax, bx, d / seg), lerp(ay, by, d / seg)]), (d += step));
      carry = seg - (d - step);
    }
    out.push([...pts.at(-1)]);
    return out;
  }
  // Draw the first `progress` (0–1) of a polyline by arc length; returns the pen tip.
  function drawOn(c, pts, progress, { color = "#151515", width = 4, cap = "round" } = {}) {
    const L = pathLength(pts),
      target = clamp(progress) * L;
    if (!pts.length || target <= 0) return pts[0] ? [...pts[0]] : null;
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    let run = 0,
      tip = [...pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1],
        [bx, by] = pts[i],
        seg = Math.hypot(bx - ax, by - ay);
      if (run + seg >= target) {
        const q = seg ? (target - run) / seg : 0;
        tip = [lerp(ax, bx, q), lerp(ay, by, q)];
        c.lineTo(tip[0], tip[1]);
        break;
      }
      run += seg;
      c.lineTo(bx, by);
      tip = [bx, by];
    }
    c.strokeStyle = color;
    c.lineWidth = width;
    c.lineCap = cap;
    c.lineJoin = "round";
    c.stroke();
    return tip;
  }
  // A hand-drawn line. `boil` re-jitters it at 12 fps (animation "boiling"); 0 keeps it static.
  function rough(c, pts, { amp = 2.5, seed = 1, step = 14, t = 0, boil = 0, color = "#151515", width = 3, close = false, progress = 1 } = {}) {
    const frame = boil ? Math.floor(t * boil + 1e-6) : 0;
    const dense = resample(close ? [...pts, pts[0]] : pts, step).map(([x, y], i) => [
      x + amp * noise(i * 0.37 + seed * 7.1, frame * 3.3),
      y + amp * noise(i * 0.37 + seed * 3.7 + 50, frame * 3.3),
    ]);
    return drawOn(c, dense, progress, { color, width });
  }
  // A marker pen held at the tip; draw it after the strokes so the hand sits on top.
  function pen(c, x, y, { color = "#151515", size = 1, angle = -0.6 } = {}) {
    c.save();
    c.translate(x, y);
    c.rotate(angle);
    c.scale(size, size);
    c.fillStyle = "#2b2b2b";
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(10, -6);
    c.lineTo(10, 6);
    c.closePath();
    c.fill();
    c.fillStyle = color;
    c.fillRect(10, -9, 26, 18);
    c.fillStyle = "#f4f2ec";
    c.fillRect(36, -10, 120, 20);
    c.restore();
  }

  function wrap(c, text, maxWidth) {
    const tokens = String(text).match(/[⺀-鿿豈-﫿＀-￯][，。！？、；：”’）》]*|[^\s⺀-鿿]+\s*|\s+/g) || [];
    const lines = [];
    let line = "";
    for (const tok of tokens) {
      if (line && c.measureText((line + tok).trimEnd()).width > maxWidth) (lines.push(line.trimEnd()), (line = tok.trimStart()));
      else line += tok;
    }
    if (line.trim()) lines.push(line.trimEnd());
    return lines;
  }
  // A paragraph that wraps and shrinks until it fits `maxLines`. Returns {size, lines, height}.
  function paragraph(c, text, x, y, { size = 48, maxWidth = view.width * 0.8, maxLines = 3, lineHeight = 1.3, color = "#151515", weight = 700, align = "left", mono = false, minSize = 12 } = {}) {
    const family = mono ? '"Film Mono", "Film Sans"' : '"Film Sans"';
    let lines;
    for (;;) {
      c.font = `${weight} ${size}px ${family}`;
      lines = wrap(c, text, maxWidth);
      if (lines.length <= maxLines || size <= minSize) break;
      size = Math.max(minSize, size * 0.92);
    }
    c.fillStyle = color;
    c.textAlign = align;
    c.textBaseline = "middle";
    lines.forEach((l, i) => c.fillText(l, x, y + i * size * lineHeight));
    return { size, lines, height: lines.length * size * lineHeight };
  }
  // Whiteboard writing: characters appear as a pen sweeps through them. Returns the pen tip.
  function write(c, text, x, y, progress, { size = 56, color = "#0a0503", weight = 700, mono = false } = {}) {
    const family = mono ? '"Film Mono", "Film Sans"' : '"Film Sans"';
    c.font = `${weight} ${size}px ${family}`;
    c.textAlign = "left";
    c.textBaseline = "middle";
    const chars = [...String(text)],
      shown = clamp(progress) * chars.length,
      whole = Math.floor(shown);
    const head = chars.slice(0, whole).join("");
    c.fillStyle = color;
    c.fillText(head, x, y);
    const x0 = x + c.measureText(head).width;
    if (whole >= chars.length) return [x0, y + size * 0.35];
    const w = c.measureText(chars[whole]).width,
      q = shown - whole;
    // Three zigzag rows inside the glyph box, as a pen would fill it.
    const row = Math.min(2, Math.floor(q * 3)),
      inRow = q * 3 - row,
      top = y - size * 0.6,
      rowH = (size * 1.2) / 3;
    c.save();
    c.beginPath();
    if (row > 0) c.rect(x0, top, w, rowH * row);
    c.rect(x0, top + rowH * row, w * inRow, rowH);
    c.clip();
    c.fillText(chars[whole], x0, y);
    c.restore();
    return [x0 + w * inRow, top + rowH * (row + 0.5)];
  }

  // Palettes: bg, surface, ink, sub, accent, accent2. One palette per film; no blue-purple backgrounds.
  const palettes = {
    paper: { bg: "#F3EDE2", surface: "#FBF8F2", ink: "#1B1A17", sub: "#6B655B", accent: "#C8402F", accent2: "#2F5D62" },
    poster: { bg: "#FFD23F", surface: "#FFF6D6", ink: "#111111", sub: "#4A4433", accent: "#FF5A36", accent2: "#14213D" },
    ink: { bg: "#121417", surface: "#1E2226", ink: "#F2EFE8", sub: "#A39E93", accent: "#F2B33D", accent2: "#5FB3A1" },
    navy: { bg: "#0D1B2A", surface: "#16293D", ink: "#EEF3F6", sub: "#8FA3B3", accent: "#5CC8E0", accent2: "#F2A93B" },
    bauhaus: { bg: "#EFE9DD", surface: "#FFFFFF", ink: "#111111", sub: "#555555", accent: "#D62828", accent2: "#1D4E89" },
    snow: { bg: "#E9EEF0", surface: "#FFFFFF", ink: "#1F2A30", sub: "#5E6B72", accent: "#D9482B", accent2: "#3E7C8C" },
    wood: { bg: "#EDE3D1", surface: "#F7F1E6", ink: "#2B2622", sub: "#7A6E62", accent: "#C4552D", accent2: "#3F5B4B" },
    chalk: { bg: "#23302B", surface: "#2E3D37", ink: "#F1EFE6", sub: "#A9B3AA", accent: "#F4D35E", accent2: "#E87D5A" },
    whiteboard: { bg: "#FBFBFB", surface: "#FFFFFF", ink: "#0A0503", sub: "#6E6A66", accent: "#EB701F", accent2: "#2F5D62" },
  };
  const palette = (p) => {
    if (p && typeof p === "object" && !Array.isArray(p)) return p;
    const name = p ?? film.look?.palette;
    if (typeof name === "string" && palettes[name]) return palettes[name];
    if (Array.isArray(name) && name.length >= 3) {
      const [bg, ink, accent, accent2 = accent, sub = ink, surface = bg] = name;
      return { bg, surface, ink, sub, accent, accent2 };
    }
    return palettes.paper;
  };

  // Static paper/grain textures are painted once per key, then reused every frame.
  const cache = new Map();
  function texture(key, options = {}) {
    if (typeof options === "function") return decorativeTexture(key, options);
    const { base = "#F3EDE2", amount = 18, grain = 10, scale = 0.004, seed = 7 } = options;
    if (cache.has(key)) return cache.get(key);
    const w = Math.ceil(view.width / 2),
      h = Math.ceil(view.height / 2),
      layer = document.createElement("canvas");
    layer.width = w;
    layer.height = h;
    const g = layer.getContext("2d"),
      img = g.createImageData(w, h),
      r = rng(seed),
      n = parseInt(base.slice(1), 16),
      rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = fbm(x * scale * 2, y * scale * 2) * amount + (r() - 0.5) * grain,
          o = (y * w + x) * 4;
        for (let k = 0; k < 3; k++) img.data[o + k] = Math.max(0, Math.min(255, rgb[k] + v));
        img.data[o + 3] = 255;
      }
    g.putImageData(img, 0, 0);
    cache.set(key, layer);
    return layer;
  }
  function paper(c, key = "paper", options = {}) {
    c.drawImage(texture(key, { base: palette().bg, ...options }), 0, 0, view.width, view.height);
  }

  // ---------------------------------------------------------------- composed helpers
  // Every time-dependent helper takes (c, t, ...positional, options). Points are [x, y].
  const unit = Math.min(view.width, view.height) / 1080;
  const lerp2 = (a, b, p) => [lerp(a[0], b[0], p), lerp(a[1], b[1], p)];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
  const ring = (n, center, rx, ry = rx, start = -Math.PI / 2) =>
    Array.from({ length: n }, (_, i) => {
      const a = start + (i * Math.PI * 2) / n;
      return [center[0] + Math.cos(a) * rx, center[1] + Math.sin(a) * ry];
    });
  const ink = () => palette();
  const fontOf = (weight, size, mono) => `${weight} ${size}px ${mono ? '"Film Mono", "Film Sans"' : '"Film Sans"'}`;
  const line = (c, a, b, color, width, dash) => {
    c.save();
    if (dash) c.setLineDash(dash);
    c.strokeStyle = color;
    c.lineWidth = width;
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(a[0], a[1]);
    c.lineTo(b[0], b[1]);
    c.stroke();
    c.restore();
  };
  function label(c, text, x, y, { size = 40 * unit, color = ink().ink, weight = 700, align = "center", maxWidth = Infinity, mono = false } = {}) {
    c.font = fontOf(weight, size, mono);
    const w = c.measureText(text).width;
    if (w > maxWidth) c.font = fontOf(weight, (size *= maxWidth / w), mono);
    c.fillStyle = color;
    c.textAlign = align;
    c.textBaseline = "middle";
    c.fillText(text, x, y);
    return size;
  }
  function rounded(c, x, y, w, h, r, fill) {
    c.beginPath();
    c.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
    c.fillStyle = fill;
    c.fill();
  }

  // Camera as compact tuples: [at, "push", [x, y]?, k?] · [at, "pan", [x, y]] · [at, "to", [x, y], z]
  // · [at, "slam"] · [at, "shake", amp] · [at, "cut", [x, y], z]. Objects as in camera() work too.
  function shoot(c, t, events, drawWorld, base = {}) {
    const ev = events.map((e) => {
      if (!Array.isArray(e)) return e;
      const [at, kind, a, b] = e,
        o = { at, kind };
      if (Array.isArray(a)) ((o.x = a[0]), (o.y = a[1]));
      if (kind === "push" && b !== undefined) o.k = b;
      if ((kind === "to" || kind === "cut") && b !== undefined) o.z = b;
      if (kind === "shake" && a !== undefined) o.amp = a;
      return o;
    });
    const cam = camera(t, ev, base);
    c.save();
    applyCamera(c, cam);
    drawWorld?.(cam);
    c.restore();
    return cam;
  }

  // A filled card with an optional dot icon and a label underneath it.
  function card(c, at, { w = 560 * unit, h = 360 * unit, label: text = "", fill = ink().accent, color = ink().surface, icon = "dot", scale = 1, radius = 40 * unit, shadow = true } = {}) {
    c.save();
    c.translate(at[0], at[1]);
    c.scale(scale, scale);
    if (shadow) {
      c.shadowColor = ink().ink + "33";
      c.shadowBlur = 40 * unit;
      c.shadowOffsetY = 18 * unit;
    }
    rounded(c, -w / 2, -h / 2, w, h, radius, fill);
    c.shadowColor = "transparent";
    if (icon === "dot") {
      c.fillStyle = color;
      c.beginPath();
      c.arc(0, text ? -h * 0.11 : 0, h * 0.16, 0, Math.PI * 2);
      c.fill();
    }
    if (text) label(c, text, 0, icon ? h * 0.26 : 0, { size: h * 0.145, color, weight: 800, maxWidth: w - 60 * unit });
    c.restore();
  }
  // A message pill that swells out of nothing at `from` and collapses at `to`.
  function pill(c, t, at, text, { from = 0, to = Infinity, w = 520 * unit, h = 140 * unit, fill = ink().ink, color = ink().surface, mono = true, rotate = 0 } = {}) {
    if (t < from || t > to + 0.3) return;
    const grow = easings.backOut(clamp((t - from) / 0.45), 2.2) * (1 - easings.cubicInOut((t - to) / 0.3));
    if (grow <= 0) return;
    const ww = lerp(h * 0.43, w, grow),
      hh = lerp(h * 0.43, h, grow);
    c.save();
    c.translate(at[0], at[1]);
    c.rotate(rotate);
    rounded(c, -ww / 2, -hh / 2, ww, hh, hh / 2, fill);
    c.globalAlpha = Math.min(1, grow * 1.4);
    label(c, text, 0, 0, { size: h * 0.37, color, maxWidth: ww - 60 * unit, mono });
    c.restore();
  }
  // Rings radiating from a point on arrival.
  function ripple(c, t, at, { at: start = 0, count = 3, gap = 0.22, dur = 0.9, radius = 280 * unit, color = ink().accent2, width = 10 * unit } = {}) {
    for (let i = 0; i < count; i++) {
      const q = (t - start - i * gap) / dur;
      if (q <= 0 || q >= 1) continue;
      c.save();
      c.globalAlpha = 1 - q;
      c.strokeStyle = color;
      c.lineWidth = width;
      c.beginPath();
      c.arc(at[0], at[1], radius * (0.6 + q * 1.4), 0, Math.PI * 2);
      c.stroke();
      c.restore();
    }
  }
  // A timed stroke: draws on from `at` over `dur`, optional pen at the tip, gone after `until`.
  function stroke(c, t, pts, { at = 0, dur = 0.8, until = Infinity, ease = "expoOut", pen: withPen = false, color = ink().accent, width = 8 * unit, rough: hand = 0, seed = 1 } = {}) {
    const p = easeOf(ease)((t - at) / dur) * (1 - easings.cubicInOut((t - until) / 0.3));
    if (p <= 0) return null;
    const tip = hand ? rough(c, pts, { progress: p, amp: hand, seed, color, width }) : drawOn(c, pts, p, { color, width });
    if (withPen && tip && p < 1 && t < until) pen(c, tip[0], tip[1], { color, size: width / (8 * unit) * unit * 1.2 });
    return tip;
  }
  // A link that draws from `from` to `to`, then a dot pops at `to`.
  function node(c, t, from, to, { at = 0, dur = 0.5, color = ink().accent, radius = 46 * unit, linkColor = ink().ink, width = 6 * unit, seed = 1 } = {}) {
    const q = clamp((t - at) / dur);
    if (q <= 0) return;
    rough(c, [from, to], { progress: q, seed, amp: 4 * unit, width, color: linkColor });
    c.fillStyle = color;
    c.beginPath();
    c.arc(to[0], to[1], radius * Math.max(0, easings.backOut(clamp(q * 2), 2.2)), 0, Math.PI * 2);
    c.fill();
  }
  // Handwrite a word centred on a point, with the pen, then underline it.
  function signature(c, t, text, at, { at: start = 0, dur = 1.2, underline = null, size = 120 * unit, maxWidth = Infinity, color = ink().ink, accent = ink().accent, pen: withPen = true, weight = 900 } = {}) {
    c.font = fontOf(weight, size, false);
    size *= Math.min(1, maxWidth / c.measureText(text).width);
    c.font = fontOf(weight, size, false);
    const w = c.measureText(text).width,
      p = clamp((t - start) / dur);
    if (p <= 0) return;
    const tip = write(c, text, at[0] - w / 2, at[1], p, { size, color, weight });
    if (withPen && p < 1) pen(c, tip[0], tip[1], { color, size: size / 100 });
    if (underline !== null)
      drawOn(c, [[at[0] - w / 2, at[1] + size * 0.62], [at[0] + w / 2, at[1] + size * 0.62]], easings.expoOut((t - underline) / 0.35), { color: accent, width: size * 0.1 });
  }

  // One line in a masked slot: rises in (0.35 s), holds, leaves fast (0.18 s).
  // Portrait titles default to the platform-safe column (the text check flagged the starter's
  // beat titles reaching under the right-hand action buttons); landscape keeps the full width.
  const portraitSafe = view.vertical && view.safe;
  function caption(c, t, text, start, end, { y = view.vertical ? 0.16 : 0.15, x = portraitSafe ? (view.safe.x + view.safe.w / 2) / view.width : 0.5, align = "center", size = (view.vertical ? 70 : 88) * unit, color = ink().ink, weight = 800, maxWidth = portraitSafe ? view.safe.w : view.width - (view.vertical ? 140 : 220) * unit, plate = null, lines: maxLines = 1 } = {}) {
    const enter = easings.expoOut((t - start) / 0.35),
      exit = easings.expoIn((t - end + 0.18) / 0.18);
    if (enter <= 0 || exit >= 1 || !text) return;
    c.font = fontOf(weight, size, false);
    // With lines > 1, a line that does not fit wraps (balanced) instead of shrinking. A text that
    // needs more than `lines` rows is shrunk step by step until it fits in that many, never
    // collapsed back onto one tiny line.
    let rows = [text];
    if (maxLines > 1 && c.measureText(text).width > maxWidth) {
      let all = wrap(c, text, maxWidth);
      while (all.length > maxLines && size > 12 * unit) {
        size *= 0.92;
        c.font = fontOf(weight, size, false);
        all = wrap(c, text, maxWidth);
      }
      const target = c.measureText(text).width / all.length;
      rows = wrap(c, text, Math.min(maxWidth, target * 1.08 + size));
      if (rows.length > all.length) rows = all;
    }
    const lh = size * 1.25,
      block = lh * rows.length;
    const cy = y * view.height - (block - lh),
      cx = x * view.width;
    c.save();
    c.beginPath();
    c.rect(0, cy - size, view.width, block + size);
    c.clip();
    const yy = cy + (1 - enter) * size * 1.2 - exit * size * 1.2;
    if (plate) {
      const w = Math.min(maxWidth, Math.max(...rows.map((r) => c.measureText(r).width))) + size,
        left = align === "left" ? cx - size / 2 : align === "right" ? cx - w + size / 2 : cx - w / 2;
      rounded(c, left, yy - size * 0.72, w, block - lh + size * 1.44, size * 0.3, plate);
    }
    rows.forEach((row, i) => label(c, row, cx, yy + i * lh, { size, color, weight, maxWidth, align }));
    c.restore();
  }
  // A list of [text, start, end] beat titles; with no list, the film's narration subtitles
  // (film.captions, timed from the voice track or estimated) in the lower safe area.
  function captions(c, t, list, options = {}) {
    if (film.noCaptions) return;
    if (list) {
      for (const [text, start, end] of list) caption(c, t, text, start, end, { ...film.captionStyle, ...options });
      return;
    }
    // Subtitles sit at the bottom of the safe area: in portrait that is above the platform's
    // author row and like/comment bar, not at the very bottom of the frame.
    const safe = view.safe ?? { x: view.width * 0.05, y: view.height * 0.06, w: view.width * 0.9, h: view.height * 0.88 };
    // Centred on the safe area, so a long line never reaches the right-hand action column.
    // Portrait is narrow: a sentence may need three lines; landscape keeps two.
    const sub = { lines: view.vertical ? 3 : 2, x: view.vertical ? (safe.x + safe.w / 2) / view.width : 0.5, y: view.vertical ? (safe.y + safe.h) / view.height - 0.03 : 0.885, size: 50 * unit, weight: 700, color: "#ffffff", plate: "rgba(0,0,0,.78)", maxWidth: view.vertical ? safe.w : view.width * 0.86, ...film.captionStyle, ...options };
    for (const cue of film.captions ?? []) caption(c, t, cue.text, cue.start, cue.end, sub);
  }
  // Updating legends: shared items are drawn once; replaced text exits before new text enters.
  function list(c, t, events, { x = 80 * unit, y = 160 * unit, gap = 56 * unit, size = 36 * unit, ...style } = {}) {
    const event = [...events].sort((a,b) => a[0]-b[0]);
    let index = -1; for (let i=0;i<event.length;i++) if (t>=event[i][0]) index=i;
    if (index<0) return;
    const normalize = (items) => items.map((v) => typeof v === "string" ? {id:v,text:v} : v);
    const current=normalize(event[index][1]), previous=index?normalize(event[index-1][1]):[];
    const elapsed=t-event[index][0], key=(v)=>`${v.id}\0${v.text}`;
    const draw=(item,row,alpha)=>{if(alpha<=0)return;c.save();c.globalAlpha*=alpha;label(c,item.text,x,y+row*gap,{size,align:"left",...style,...(item.color?{color:item.color}:{})});c.restore();};
    for(let i=0;i<previous.length;i++)if(!current.some((v)=>key(v)===key(previous[i])))draw(previous[i],i,1-clamp(elapsed/.18));
    for(let i=0;i<current.length;i++){
      const old=previous.findIndex((v)=>key(v)===key(current[i]));
      if(old>=0)draw(current[i],elapsed < .18 ? old : i,1);
      else draw(current[i],i,clamp((elapsed-(index ? .18 : 0))/.35));
    }
  }
  function map(c,t,geo,{fills=[],fill=ink().surface,stroke=ink().sub,width=1.5*unit}={}) {
    for(const region of geo.regions){
      let color=fill;
      for(const e of [...fills].sort((a,b)=>a.at-b.at)){
        const i=e.ids.indexOf(region.id);if(i<0)continue;
        const at=e.at+i*(e.stagger??0), q=clamp((t-at)/(e.duration??.3));
        if(q>0){
          const parse=(v)=>/^#[0-9a-f]{6}$/i.test(v)?[1,3,5].map((n)=>parseInt(v.slice(n,n+2),16)):null;
          const a=parse(color),b=parse(e.color);color=a&&b?`#${a.map((v,j)=>Math.round(lerp(v,b[j],q)).toString(16).padStart(2,"0")).join("")}`:q>=1?e.color:color;
        }
      }
      c.beginPath();for(const polygon of region.polygons)for(const ring of polygon){ring.forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y));c.closePath();}
      c.fillStyle=color;c.fill("evenodd");c.strokeStyle=stroke;c.lineWidth=width;c.stroke();
    }
  }
  function geoPoint(geo,lon,lat){
    const phi=Math.max(-85.05112878,Math.min(85.05112878,lat))*Math.PI/180;
    const x=lon*Math.PI/180,y=geo.projection==="mercator"?-Math.log(Math.tan(Math.PI/4+phi/2)):-lat*Math.PI/180;
    return [x*geo.transform.scale+geo.transform.offset[0],y*geo.transform.scale+geo.transform.offset[1]];
  }
  function route(c,t,points,{at=0,dur=1.2,color=ink().accent,width=5*unit,head=false}={}){
    const progress=easings.smooth((t-at)/dur);if(progress<=0)return null;
    const tip=drawOn(c,points,progress,{color,width});
    if(head&&tip&&points.length>1){
      const dense=resample(points,Math.max(1,pathLength(points)/100));
      const i=Math.max(1,Math.min(dense.length-1,Math.floor(progress*(dense.length-1))));
      const a=dense[i-1],b=dense[i],angle=Math.atan2(b[1]-a[1],b[0]-a[0]);
      c.save();c.translate(...tip);c.rotate(angle);c.fillStyle=color;c.beginPath();c.moveTo(0,0);c.lineTo(-18*unit,-8*unit);c.lineTo(-18*unit,8*unit);c.closePath();c.fill();c.restore();
    }return tip;
  }
  function pin(c,t,point,{at=0,text="",color=ink().accent,labelColor=ink().ink,size=10*unit}={}){
    const q=easings.smooth((t-at)/.3);if(q<=0)return;
    c.save();c.globalAlpha*=q;c.fillStyle=color;c.beginPath();c.arc(...point,size*q,0,Math.PI*2);c.fill();
    if(text)label(c,text,point[0],point[1]-size-22*unit,{color:labelColor,size:28*unit});c.restore();
  }
  // Kinetic words: each word enters at its own time (at + i * stagger, or times[i]).
  function words(c, t, text, at, { at: start = 0, stagger = 0.12, times = null, style = "rise", size = 96 * unit, color = ink().ink, emphasis = [], emphasisColor = ink().accent, weight = 800, align = "center", maxWidth = view.width * 0.86, lineHeight = 1.15, until = Infinity } = {}) {
    c.font = fontOf(weight, size, false);
    const tokens = String(text).match(/[⺀-鿿豈-﫿][，。！？、]*|[^\s⺀-鿿]+/g) || [];
    const space = /[⺀-鿿]/.test(text) ? 0 : c.measureText(" ").width;
    const lines = [[]];
    let lw = 0;
    tokens.forEach((tok, i) => {
      const w = c.measureText(tok).width;
      if (lw && lw + space + w > maxWidth) (lines.push([]), (lw = 0));
      lines.at(-1).push({ tok, w, i });
      lw += (lw ? space : 0) + w;
    });
    const exit = easings.expoIn((t - until) / 0.18);
    if (exit >= 1) return;
    lines.forEach((ln, row) => {
      const total = ln.reduce((s, x) => s + x.w, 0) + space * (ln.length - 1);
      let x = align === "center" ? at[0] - total / 2 : align === "right" ? at[0] - total : at[0];
      const y = at[1] + (row - (lines.length - 1) / 2) * size * lineHeight;
      for (const { tok, w, i } of ln) {
        const s0 = times?.[i] ?? start + i * stagger,
          p = clamp((t - s0) / (style === "slam" ? 0.17 : 0.32));
        if (p > 0) {
          const emph = emphasis.some((e) => tok.includes(e));
          c.save();
          c.globalAlpha = (style === "type" ? 1 : Math.min(1, p * 2.5)) * (1 - exit);
          c.translate(x + w / 2, y);
          if (style === "rise") c.translate(0, (1 - easings.expoOut(p)) * size * 0.6);
          if (style === "slam") c.scale(slamK(p), slamK(p));
          if (style === "pop") c.scale(easings.backOut(p, 2.6), easings.backOut(p, 2.6));
          if (style !== "type" || p > 0) label(c, tok, 0, 0, { size, color: emph ? emphasisColor : color, weight });
          c.restore();
        }
        x += w + space;
      }
    });
  }

  const dataOf = (v) => (typeof v === "string" ? film.data?.[v] : v);
  // Data labels may be language maps: {"en": "Starter", "zh": "起手模板"}.
  const localize = (v) => (v && typeof v === "object" ? (v[film.lang] ?? Object.values(v)[0]) : v);
  const fmt = (v, decimals = 0) => Number(v).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).replace("-", "−");
  // A number that rolls to its value and lands at `at` + `dur`. `value` may name a key in film.data.
  function counter(c, t, at, { value, from = 0, at: start = 0, dur = 0.9, decimals = 0, prefix = "", suffix = "", size = 160 * unit, color = ink().ink, weight = 900, align = "center" } = {}) {
    const v = Number(dataOf(value));
    if (t < start) return;
    const shown = lerp(from, v, easings.expoOut((t - start) / dur));
    label(c, prefix + fmt(shown, decimals) + suffix, at[0], at[1], { size, color, weight, align });
  }
  // Bar, line or dot chart from [{label, value}] (or a film.data key). Bars grow from zero in turn;
  // the line draws on; `highlight` keeps one item in the accent and dims the rest.
  function chart(c, t, { data, type = "bar", x = view.width * 0.12, y = view.height * 0.22, w = view.width * 0.76, h = view.height * 0.56, at = 0, dur = 0.7, stagger = 0.12, highlight = null, color = ink().accent, dim = ink().sub + "66", axis = ink().ink, labels = true, values = true, decimals = 0, suffix = "", min = 0, max = null } = {}) {
    const rows = (dataOf(data) ?? []).map((r, i) => (typeof r === "number" ? { label: String(i + 1), value: r } : { ...r, label: localize(r.label) }));
    if (!rows.length || t < at) return;
    const top = max ?? Math.max(...rows.map((r) => r.value)) * 1.1,
      base = y + h,
      sy = (v) => base - ((v - min) / (top - min || 1)) * h;
    line(c, [x, base], [x + w * easings.cubicOut((t - at) / 0.4), base], axis, 3 * unit);
    const step = w / rows.length,
      fs = Math.min(36 * unit, step * 0.3);
    const colorOf = (i) => (highlight === null || highlight === i || rows[i].label === highlight ? color : dim);
    if (type === "line") {
      const pts = rows.map((r, i) => [x + step * (i + 0.5), sy(r.value)]);
      const p = clamp((t - at) / (dur + stagger * rows.length));
      const tip = drawOn(c, pts, p, { color, width: 8 * unit });
      if (tip && p < 1) ((c.fillStyle = color), c.beginPath(), c.arc(tip[0], tip[1], 12 * unit, 0, Math.PI * 2), c.fill());
    }
    rows.forEach((r, i) => {
      const p = easings.quintOut((t - at - i * stagger) / dur),
        cx = x + step * (i + 0.5);
      if (p <= 0) return;
      const v = lerp(min, r.value, p);
      if (type === "bar") rounded(c, cx - step * 0.32, sy(v), step * 0.64, base - sy(v), 8 * unit, colorOf(i));
      if (type === "dots" || (type === "line" && p >= 1)) {
        c.fillStyle = colorOf(i);
        c.beginPath();
        c.arc(cx, sy(v), (type === "dots" ? 22 : 10) * unit * easings.backOut(p, 2.2), 0, Math.PI * 2);
        c.fill();
      }
      if (values) label(c, fmt(v, decimals) + suffix, cx, sy(v) - fs * 1.1, { size: fs, color: colorOf(i) === dim ? ink().sub : axis, weight: 800 });
      if (labels) label(c, String(r.label ?? ""), cx, base + fs * 1.2, { size: fs * 0.85, color: ink().sub, weight: 600, maxWidth: step * 0.95 });
    });
  }
  // A callout: a dot springs onto the point, a ring pulses, a leader line runs out, the label lands.
  function callout(c, t, at, text, { at: start = 0, until = Infinity, dx = 160 * unit, dy = -120 * unit, sub = null, color = ink().accent, bg = ink().ink, fg = ink().surface, size = 42 * unit } = {}) {
    if (t < start || t > until + 0.18) return;
    const leave = 1 - easings.expoIn((t - until) / 0.18);
    c.save();
    c.globalAlpha *= leave;
    const k = t - start,
      dot = easings.backOut(clamp(k / 0.25), 2.6);
    c.fillStyle = color;
    c.beginPath();
    c.arc(at[0], at[1], 12 * unit * dot, 0, Math.PI * 2);
    c.fill();
    ripple(c, t, at, { at: start, count: 1, dur: 0.6, radius: 30 * unit, color, width: 4 * unit });
    const end = add(at, [dx, dy]);
    drawOn(c, [at, end], easings.expoOut((k - 0.15) / 0.3), { color, width: 3 * unit });
    const p = easings.backOut(clamp((k - 0.35) / 0.3), 2.2);
    if (p <= 0) return c.restore();
    c.save();
    c.translate(end[0], end[1]);
    c.scale(p, p);
    c.font = fontOf(800, size, false);
    const w = Math.max(c.measureText(text).width, sub ? c.measureText(sub).width * 0.7 : 0) + size * 1.2,
      hh = size * (sub ? 2.4 : 1.6);
    rounded(c, dx < 0 ? -w : 0, -hh / 2, w, hh, size * 0.25, bg);
    label(c, text, (dx < 0 ? -w : 0) + size * 0.6, sub ? -size * 0.4 : 0, { size, color: fg, align: "left" });
    if (sub) label(c, sub, (dx < 0 ? -w : 0) + size * 0.6, size * 0.6, { size: size * 0.66, color: fg + "bb", weight: 600, align: "left" });
    c.restore();
    c.restore();
  }
  // A stamped word: slams in (1.55 → 0.94 → 1) with a slight tilt, in a box or bare.
  function stamp(c, t, text, at, { at: start = 0, until = Infinity, size = 150 * unit, color = ink().accent, rotate = -0.06, box = true, weight = 900, maxWidth = view.width * 0.86 } = {}) {
    if (t < start || t > until + 0.18) return;
    c.font = fontOf(weight, size, false);
    size *= Math.min(1, maxWidth / (c.measureText(text).width + (box ? size * 0.6 : 0)));
    const s = slamK((t - start) / 0.17) * (1 - 0.4 * easings.expoIn((t - until) / 0.18));
    c.save();
    c.translate(at[0], at[1]);
    c.rotate(rotate);
    c.scale(s, s);
    c.globalAlpha = 1 - easings.expoIn((t - until) / 0.18);
    if (box) {
      c.font = fontOf(weight, size, false);
      const w = c.measureText(text).width + size * 0.6;
      c.strokeStyle = color;
      c.lineWidth = size * 0.07;
      c.strokeRect(-w / 2, -size * 0.65, w, size * 1.3);
    }
    label(c, text, 0, 0, { size, color, weight });
    c.restore();
  }
  // Dim everything outside a rectangle [x, y, w, h], easing in at `at`.
  function spotlight(c, t, rect, { at = 0, dur = 0.35, until = Infinity, dim = 0.62, radius = 24 * unit, color = "#000000" } = {}) {
    const p = easings.cubicOut((t - at) / dur) * (1 - easings.cubicIn((t - until) / dur));
    if (p <= 0) return;
    c.save();
    c.fillStyle = color;
    c.globalAlpha = dim * p;
    c.beginPath();
    c.rect(0, 0, view.width, view.height);
    c.roundRect(rect[0], rect[1], rect[2], rect[3], radius);
    c.fill("evenodd");
    c.restore();
  }
  // A pointer moving through [[time, x, y], …]; `clicks` are times that press and ripple.
  function cursor(c, t, keys, { clicks = [], size = 1, color = "#111111" } = {}) {
    if (!keys.length || t < keys[0][0]) return;
    let pos = [keys.at(-1)[1], keys.at(-1)[2]];
    for (let i = 1; i < keys.length; i++)
      if (t < keys[i][0]) {
        const [t0, x0, y0] = keys[i - 1],
          [t1, x1, y1] = keys[i],
          p = easings.appleOut((t - t0) / (t1 - t0));
        pos = [lerp(x0, x1, p), lerp(y0, y1, p)];
        break;
      }
    for (const at of clicks) ripple(c, t, pos, { at, count: 1, dur: 0.45, radius: 26 * unit, color: color + "88", width: 4 * unit });
    const press = clicks.some((at) => t >= at && t < at + 0.12) ? 0.86 : 1;
    c.save();
    c.translate(pos[0], pos[1]);
    c.scale(size * unit * 1.6 * press, size * unit * 1.6 * press);
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(0, 34);
    c.lineTo(9, 26);
    c.lineTo(15, 40);
    c.lineTo(21, 37);
    c.lineTo(15, 24);
    c.lineTo(26, 24);
    c.closePath();
    c.fillStyle = color;
    c.strokeStyle = "#ffffff";
    c.lineWidth = 2.5;
    c.fill();
    c.stroke();
    c.restore();
  }
  // Draw an image (or a named film asset) covering [x, y, w, h], zoomed around a focus point (0–1).
  function cover(c, image, { x = 0, y = 0, w = view.width, h = view.height, fx = 0.5, fy = 0.5, zoom = 1, radius = 0 } = {}) {
    const img = typeof image === "string" ? window.filmAssets?.[image] : image;
    if (!img) throw new Error(`cover: no image "${image}"; declare it under film.json assets`);
    const iw = img.naturalWidth || img.videoWidth || img.width,
      ih = img.naturalHeight || img.videoHeight || img.height;
    const s = Math.max(w / iw, h / ih) * zoom,
      dw = iw * s,
      dh = ih * s;
    const dx = Math.min(x, Math.max(x + w - dw, x + w / 2 - fx * dw)),
      dy = Math.min(y, Math.max(y + h - dh, y + h / 2 - fy * dh));
    c.save();
    c.beginPath();
    c.roundRect(x, y, w, h, radius);
    c.clip();
    c.drawImage(img, dx, dy, dw, dh);
    c.restore();
  }
  // Whole-frame looks, drawn last: "mono", "tint" (color), "duotone" (dark → light).
  function grade(c, mode = "mono", { color = ink().accent, dark = ink().ink, light = ink().bg, amount = 1 } = {}) {
    c.save();
    c.globalAlpha = amount;
    if (mode === "mono" || mode === "duotone") {
      c.globalCompositeOperation = "saturation";
      c.fillStyle = "#808080";
      c.fillRect(0, 0, view.width, view.height);
    }
    if (mode === "duotone") {
      c.globalCompositeOperation = "screen";
      c.fillStyle = dark;
      c.fillRect(0, 0, view.width, view.height);
      c.globalCompositeOperation = "multiply";
      c.fillStyle = light;
      c.fillRect(0, 0, view.width, view.height);
    }
    if (mode === "tint") {
      c.globalCompositeOperation = "color";
      c.fillStyle = color;
      c.fillRect(0, 0, view.width, view.height);
    }
    c.restore();
  }
  const grainTiles = [];
  // Film grain that changes at `fps` (deterministic per step).
  function grain(c, t, { amount = 0.08, fps = 12 } = {}) {
    if (!grainTiles.length)
      for (let k = 0; k < 4; k++) {
        const g = document.createElement("canvas");
        g.width = g.height = 256;
        const x = g.getContext("2d"),
          img = x.createImageData(256, 256),
          r = rng(101 + k);
        for (let i = 0; i < img.data.length; i += 4) {
          const v = Math.round(r() * 255);
          img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
          img.data[i + 3] = 255;
        }
        x.putImageData(img, 0, 0);
        grainTiles.push(g);
      }
    c.save();
    c.globalCompositeOperation = "overlay";
    c.globalAlpha = amount;
    c.fillStyle = c.createPattern(grainTiles[Math.floor(t * fps + 1e-6) % 4], "repeat");
    c.fillRect(0, 0, view.width, view.height);
    c.restore();
  }
  function vignette(c, { amount = 0.45, color = "#000000" } = {}) {
    const g = c.createRadialGradient(view.width / 2, view.height / 2, Math.min(view.width, view.height) * 0.35, view.width / 2, view.height / 2, Math.hypot(view.width, view.height) / 2);
    g.addColorStop(0, color + "00");
    g.addColorStop(1, color);
    c.save();
    c.globalAlpha = amount;
    c.fillStyle = g;
    c.fillRect(0, 0, view.width, view.height);
    c.restore();
  }

  return {
    shotTime,
    easings,
    bezier,
    tween: (t, start, dur, e = "cubicInOut") => easeOf(e)((t - start) / dur),
    springHz: (t, start, f = 2.5, d = 9) => {
      const x = Math.max(0, t - start);
      return t < start ? 0 : 1 - Math.exp(-d * x) * Math.cos(2 * Math.PI * f * x);
    },
    // Spring by damping ratio: progress 0 → 1, `t` seconds after the start, zero starting velocity.
    // Closed form, so any frame renders on its own. zeta 1 never overshoots; 0.7–0.85 lands with a
    // small settle (premium), 0.4–0.6 bounces (playful), under 0.3 wobbles (cartoon). hz is the
    // undamped frequency; the bounce itself runs at hz·√(1 − zeta²). Named springZeta because the
    // runtime's spring(time, start, speed, damping) keeps its signature.
    springZeta: (t, zeta = 0.7, hz = 2) => {
      if (!(t > 0)) return 0;
      const w = 2 * Math.PI * hz;
      if (zeta === 1) return 1 - Math.exp(-w * t) * (1 + w * t);
      if (zeta > 1) {
        const r = Math.sqrt(zeta * zeta - 1),
          s1 = -w * (zeta - r),
          s2 = -w * (zeta + r);
        return 1 + (s2 * Math.exp(s1 * t) - s1 * Math.exp(s2 * t)) / (s1 - s2);
      }
      const wd = w * Math.sqrt(1 - zeta * zeta);
      return 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + ((zeta * w) / wd) * Math.sin(wd * t));
    },
    // A value that changes target many times and stays a pure function of t: one closed-form spring
    // step (zero starting velocity) per change, summed. keys = [[at, value], …]; the first value holds
    // before the second key. Values are numbers or same-length arrays. Two edges of one shape on
    // different f stretch it while it moves (the leading edge on the faster spring).
    follow: (t, keys, { f = 2, d = 12 } = {}) => {
      const w = 2 * Math.PI * f;
      const step = (x) => (x <= 0 ? 0 : 1 - Math.exp(-d * x) * (Math.cos(w * x) + (d / w) * Math.sin(w * x)));
      let v = Array.isArray(keys[0][1]) ? [...keys[0][1]] : keys[0][1];
      for (let i = 1; i < keys.length; i++) {
        const k = step(t - keys[i][0]), a = keys[i - 1][1], b = keys[i][1];
        v = Array.isArray(v) ? v.map((x, j) => x + (b[j] - a[j]) * k) : v + (b - a) * k;
      }
      return v;
    },
    settle: (t, start, amp, f = 3, d = 5) => {
      const x = t - start;
      return x < 0 ? 0 : (amp * Math.sin(2 * Math.PI * f * x)) / Math.exp(d * x);
    },
    thereAndBack: (p) => smooth(clamp(p) < 0.5 ? 2 * clamp(p) : 2 * (1 - clamp(p))),
    lagged: (i, n, p, r = 0.05) => clamp(p * (1 + (n - 1) * r) - i * r),
    // Hold poses for whole 1/fps steps (pass t - at so a step starts exactly at `at`).
    // Under motionBlur a step change blends two poses in that one frame.
    step: (t, fps = 12) => Math.floor(t * fps + 1e-6) / fps,
    zlerp,
    pulse: PULSE,
    slam: (t, at, o = {}) => (t < at ? 0 : slamK((t - at) / (o.dur ?? PULSE.slam), o.from, o.under)),
    camera,
    applyCamera,
    toScreen,
    count: (t, at, dur, from, to, decimals = 0) => {
      const v = lerp(from, to, easings.expoOut((t - at) / dur));
      return v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).replace("-", "−");
    },
    rng,
    noise,
    fbm,
    pathLength,
    resample,
    drawOn,
    rough,
    pen,
    wrap,
    paragraph,
    write,
    palettes,
    palette,
    texture,
    paper,
    unit,
    lerp2,
    add,
    ring,
    shoot,
    card,
    pill,
    ripple,
    stroke,
    node,
    signature,
    caption,
    captions,
    list, map, geoPoint, route, pin,
    arrow: (c,t,points,options={}) => route(c,t,points,{...options,head:true}),
    at: (word, { shot, occurrence } = {}) => {
      const needle = typeof word === "string" ? word.replace(/\s+/gu, "") : "";
      if (!needle) throw new Error("A non-empty keyword is required");
      if (occurrence !== undefined && (!Number.isInteger(occurrence) || occurrence < 0)) throw new Error("Word occurrence must be a non-negative integer");
      const groups = new Map();
      for (const w of film.words ?? []) {
        if (shot && w.id !== shot) continue;
        if (!groups.has(w.id)) groups.set(w.id, []);
        groups.get(w.id).push(w);
      }
      const matches = [];
      for (const words of groups.values()) {
        for (let i = 0; i < words.length; i++) {
          let phrase = "";
          for (let j = i; j < words.length; j++) {
            phrase += words[j].text.replace(/\s+/gu, "");
            if (phrase === needle) { matches.push(words[i].start); break; }
            if (!needle.startsWith(phrase)) break;
          }
        }
      }
      matches.sort((a, b) => a - b);
      if (!matches.length) throw new Error(`No measured word timing for: ${word}`);
      if (matches.length > 1 && occurrence === undefined) throw new Error(`Ambiguous word timing: ${word}; specify shot or occurrence`);
      const match = matches[occurrence ?? 0];
      if (match === undefined) throw new Error(`No such word occurrence: ${word}`);
      return match;
    },
    hasCue: (name) => Object.hasOwn(film.cues ?? {}, name),
    cue: (name) => {
      if (!Object.hasOwn(film.cues ?? {}, name)) throw new Error(`Unknown keyword cue: ${name}`);
      return film.cues[name].time;
    },
    words,
    counter,
    chart,
    callout,
    stamp,
    spotlight,
    cursor,
    cover,
    grade,
    grain,
    vignette,
  };
};
