// Browser-only adapter: exact time in, exact picture out. No free-running animation loop.
(() => {
  const film = JSON.parse(document.getElementById("film-config").textContent);
  const canvas = document.getElementById("film-canvas"),
    ctx = canvas.getContext("2d");
  const view = {
    width: canvas.width,
    height: canvas.height,
    vertical: canvas.height > canvas.width,
    format: film.format,
  };
  // Where platform UI does not cover the picture. Portrait feeds (Douyin, TikTok, Xiaohongshu,
  // Reels, Shorts) put navigation on top, the author row, caption and like/comment bar at the
  // bottom and an action column on the right; keep text and key action inside this box.
  view.safe = view.vertical
    ? { x: canvas.width * 0.06, y: canvas.height * 0.1, w: canvas.width * 0.8, h: canvas.height * 0.66 }
    : { x: canvas.width * 0.05, y: canvas.height * 0.06, w: canvas.width * 0.9, h: canvas.height * 0.88 };
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const ease = (x) => {
    const t = clamp(x);
    return t * t * (3 - 2 * t);
  };
  const motion = {
    clamp,
    ease,
    mix: (a, b, p) => a + (b - a) * p,
    progress: (time, start, duration) => clamp((time - start) / duration),
    ramp: (time, start, duration) => ease((time - start) / duration),
    spring: (time, start, speed = 12, damping = 8) => {
      const t = Math.max(0, time - start);
      return 1 - Math.exp(-damping * t) * Math.cos(speed * t);
    },
    hash: (n) => {
      const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
      return x - Math.floor(x);
    },
    beat: (time) => (time * film.bpm) / 60,
    round(c, x, y, w, h, r, fill, stroke) {
      c.beginPath();
      c.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
      if (fill) {
        c.fillStyle = fill;
        c.fill();
      }
      if (stroke) {
        c.strokeStyle = stroke;
        c.stroke();
      }
    },
    text(
      c,
      text,
      x,
      y,
      size,
      color = "#151515",
      weight = 700,
      align = "left",
      maxWidth = Infinity,
      mono = false,
    ) {
      const family = mono ? '"Film Mono", "Film Sans"' : '"Film Sans"';
      c.font = `${weight} ${size}px ${family}`;
      if (c.measureText(text).width > maxWidth) {
        size *= maxWidth / c.measureText(text).width;
        c.font = `${weight} ${size}px ${family}`;
      }
      c.fillStyle = color;
      c.textAlign = align;
      c.textBaseline = "middle";
      c.fillText(text, x, y);
      return size;
    },
    line(c, x1, y1, x2, y2, color, width = 3) {
      c.strokeStyle = color;
      c.lineWidth = width;
      c.lineCap = "round";
      c.beginPath();
      c.moveTo(x1, y1);
      c.lineTo(x2, y2);
      c.stroke();
    },
  };
  // The drawing kit only adds names; the original helpers above keep their exact behavior.
  if (typeof window.__filmKit === "function")
    for (const [key, value] of Object.entries(window.__filmKit(view, film)))
      if (!Object.hasOwn(motion, key)) motion[key] = value;
  // Footage frames were extracted at build time; each sample time maps to one JPEG.
  const frameCache = new Map();
  const frameSrc = (v, time) => {
    const k = Math.floor((time - v.at) * v.fps + 1e-6);
    if (k < 0 || time >= v.at + v.length) return null;
    return `${v.dir}/${String(Math.min(k, v.frames - 1)).padStart(5, "0")}.jpg`;
  };
  motion.video = (name, time) => {
    const v = film.videos?.[name];
    if (!v) throw new Error(`video "${name}" is not declared under film.json videos`);
    const src = frameSrc(v, time);
    return src ? (frameCache.get(src) ?? null) : null;
  };
  const sampleTimes = (time) => {
    const { samples, shutter } = film.motionBlur;
    return Array.from({ length: samples }, (_, i) =>
      Math.max(0, time - (((samples - i - 0.5) / samples) * shutter) / film.fps),
    );
  };
  const missingFrames = (time) => {
    const at = Math.max(0, Math.min(film.duration, (Number(time) || 0) + (film.offset || 0)));
    const srcs = new Set();
    for (const v of Object.values(film.videos ?? {}))
      for (const s of sampleTimes(at)) {
        const src = frameSrc(v, s);
        if (src && !frameCache.has(src)) srcs.add(src);
      }
    return [...srcs];
  };
  const loadFrames = (srcs) =>
    Promise.all(
      srcs.map(async (src) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        frameCache.set(src, image);
        // Keep a small window: workers seek forward, and blur needs only neighbours.
        if (frameCache.size > 24) frameCache.delete(frameCache.keys().next().value);
      }),
    );
  // still --guides: tint what platform UI would cover, so overlaps are visible in review frames.
  function drawGuides(c) {
    const { x, y, w, h } = view.safe,
      W = canvas.width,
      H = canvas.height;
    c.save();
    c.fillStyle = "rgba(255,40,40,0.28)";
    c.beginPath();
    c.rect(0, 0, W, H);
    c.rect(x, y, w, h);
    c.fill("evenodd");
    c.strokeStyle = "rgba(255,60,60,0.9)";
    c.lineWidth = Math.max(2, W / 640);
    c.setLineDash([12, 8]);
    c.strokeRect(x, y, w, h);
    c.restore();
  }
  const layer = document.createElement("canvas");
  layer.width = canvas.width;
  layer.height = canvas.height;
  const scratch = layer.getContext("2d");
  let ready = false,
    requested = 0;
  function renderAt(time) {
    // A range preview renders a window of the film: page time 0 is film time `offset`.
    requested = Math.max(
      0,
      Math.min(film.duration, (Number(time) || 0) + (film.offset || 0)),
    );
    if (!ready) return;
    const { samples, shutter } = film.motionBlur;
    ctx.resetTransform();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < samples; i++) {
      const at = Math.max(
        0,
        requested - (((samples - i - 0.5) / samples) * shutter) / film.fps,
      );
      scratch.resetTransform();
      scratch.clearRect(0, 0, layer.width, layer.height);
      scratch.save();
      window.drawFrame(scratch, at, film, view, motion);
      scratch.restore();
      if (film.guides) drawGuides(scratch);
      // Running average in premultiplied alpha; every drawFrame must paint an opaque background
      // (an overlay over external engine frames paints none and always has one sample).
      ctx.globalAlpha = 1 / (i + 1);
      ctx.drawImage(layer, 0, 0);
    }
    ctx.globalAlpha = 1;
  }
  window.addEventListener("hf-seek", (event) => {
    const need = ready ? missingFrames(event.detail.time) : [];
    if (need.length) {
      const done = loadFrames(need).then(() => renderAt(event.detail.time));
      if (event.detail.waitUntil) event.detail.waitUntil(done);
      return;
    }
    try {
      renderAt(event.detail.time);
    } catch (error) {
      // Surface a failed pose to the renderer instead of encoding the last good frame.
      if (event.detail.waitUntil) event.detail.waitUntil(Promise.reject(error));
      else throw error;
    }
  });
  // Text check (render/still): draw the given times on a private canvas and report every
  // fillText/strokeText box in output pixels, so text running off the frame is found by
  // measurement instead of by eye. Never called during capture.
  window.__motionUseTextProbe = async (times) => {
    await window.__hf.buildReady["motion-use-film"];
    const probe = document.createElement("canvas");
    probe.width = canvas.width;
    probe.height = canvas.height;
    const pc = probe.getContext("2d", { willReadFrequently: true });
    // Contrast: the picture under a string's box just before it is drawn, shrunk to 48×12, and its
    // median-luminance pixel against the fill colour (WCAG relative luminance and ratio).
    const tiny = document.createElement("canvas");
    tiny.width = 48;
    tiny.height = 12;
    const tc = tiny.getContext("2d", { willReadFrequently: true });
    const rgbOf = (style) => {
      if (typeof style !== "string") return null;
      const hex = /^#([0-9a-f]{6})$/i.exec(style);
      if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
      const m = /^rgba?\(([^)]+)\)$/.exec(style);
      return m ? m[1].split(",").slice(0, 3).map(Number) : null;
    };
    const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const hexOf = (rgb) => "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
    const contrastOf = (ctx, box, style, alpha) => {
      const fill = rgbOf(style);
      const x0 = Math.max(0, Math.floor(box.x0)),
        y0 = Math.max(0, Math.floor(box.y0)),
        x1 = Math.min(probe.width, Math.ceil(box.x1)),
        y1 = Math.min(probe.height, Math.ceil(box.y1));
      if (!fill || x1 - x0 < 1 || y1 - y0 < 1) return null;
      tc.clearRect(0, 0, 48, 12);
      tc.drawImage(probe, x0, y0, x1 - x0, y1 - y0, 0, 0, 48, 12);
      const d = tc.getImageData(0, 0, 48, 12).data,
        px = [];
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] >= 128) px.push([d[i], d[i + 1], d[i + 2]]);
      if (!px.length) return null;
      px.sort((a, b) => lum(a) - lum(b));
      const back = px[px.length >> 1],
        // a translucent fill blends with what is under it (the canvas blends in sRGB)
        text = fill.map((v, i) => alpha * v + (1 - alpha) * back[i]);
      const [hi, lo] = [lum(text), lum(back)].sort((a, b) => b - a);
      const size = (parseFloat(/([\d.]+)px/.exec(ctx.font)?.[1]) || 0) * Math.sqrt(Math.abs(box.det)),
        bold = /\bbold/.test(ctx.font) || +(/\b([1-9]00)\b/.exec(ctx.font)?.[1] ?? 400) >= 700;
      return { contrast: +((hi + 0.05) / (lo + 0.05)).toFixed(2), large: size >= 24 || (bold && size >= 18.66), color: hexOf(fill), backdrop: hexOf(back), size: Math.round(size) };
    };
    let boxes = [],
      plates = [],
      order = 0,
      path = null;
    // Effective opacity of a draw: globalAlpha times the alpha of a colour style (gradients and
    // patterns count as opaque). The canvas normalises colours to #rrggbb or rgba(…).
    const styleAlpha = (style) => {
      if (typeof style !== "string") return 1;
      const m = /^rgba\(.*,\s*([\d.]+)\)$/.exec(style);
      return m ? +m[1] : 1;
    };
    const toBox = (T, pts) => {
      const xs = [],
        ys = [];
      for (const [px, py] of pts) {
        xs.push(T.a * px + T.c * py + T.e);
        ys.push(T.b * px + T.d * py + T.f);
      }
      return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    };
    const record = (draw, styleKey) =>
      function (text, x, y, maxWidth) {
        try {
          const s = String(text);
          if (s.trim() && this.globalAlpha > 0.05) {
            const m = this.measureText(s);
            let l = x - m.actualBoundingBoxLeft,
              r = x + m.actualBoundingBoxRight;
            if (maxWidth !== undefined && m.width > maxWidth && m.width > 0) {
              const k = maxWidth / m.width;
              l = x + (l - x) * k;
              r = x + (r - x) * k;
            }
            const top = y - m.actualBoundingBoxAscent,
              bottom = y + m.actualBoundingBoxDescent;
            const T = this.getTransform(),
              box = toBox(T, [[l, top], [r, top], [l, bottom], [r, bottom]]),
              alpha = +(this.globalAlpha * styleAlpha(this[styleKey])).toFixed(3);
            // Filled text only: an outline is usually there to lift the text off its background.
            const seen = styleKey === "fillStyle" && alpha >= 0.5 ? contrastOf(this, { ...box, det: T.a * T.d - T.b * T.c }, this[styleKey], alpha) : null;
            boxes.push({ text: s, ...box, alpha, order: order++, ...(seen ?? {}) });
          }
        } catch {}
        return draw.apply(this, arguments);
      };
    pc.fillText = record(CanvasRenderingContext2D.prototype.fillText, "fillStyle");
    pc.strokeText = record(CanvasRenderingContext2D.prototype.strokeText, "strokeStyle");
    // Opaque fills drawn between two strings hide one from the other (a subtitle plate over the
    // picture), so record the bounds of filled rectangles and paths as occluders.
    const P = CanvasRenderingContext2D.prototype;
    const extend = (pts) => {
      const b = toBox(pc.getTransform(), pts);
      path = path ? { x0: Math.min(path.x0, b.x0), y0: Math.min(path.y0, b.y0), x1: Math.max(path.x1, b.x1), y1: Math.max(path.y1, b.y1) } : b;
    };
    pc.beginPath = function () {
      path = null;
      return P.beginPath.apply(this, arguments);
    };
    for (const name of ["moveTo", "lineTo"])
      pc[name] = function (x, y) {
        extend([[x, y]]);
        return P[name].apply(this, arguments);
      };
    for (const name of ["rect", "roundRect"])
      pc[name] = function (x, y, w, h) {
        extend([[x, y], [x + w, y], [x, y + h], [x + w, y + h]]);
        return P[name].apply(this, arguments);
      };
    pc.arc = function (x, y, r) {
      extend([[x - r, y - r], [x + r, y + r]]);
      return P.arc.apply(this, arguments);
    };
    const plate = (b, ctx) => {
      const a = ctx.globalAlpha * styleAlpha(ctx.fillStyle);
      if (b && a >= 0.85) plates.push({ ...b, order: order++ });
    };
    pc.fill = function () {
      plate(path, this);
      return P.fill.apply(this, arguments);
    };
    pc.fillRect = function (x, y, w, h) {
      plate(toBox(this.getTransform(), [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]), this);
      return P.fillRect.apply(this, arguments);
    };
    const out = [];
    for (const t of times) {
      await loadFrames(missingFrames(t - (film.offset || 0)));
      boxes = [];
      plates = [];
      order = 0;
      pc.resetTransform();
      pc.clearRect(0, 0, probe.width, probe.height);
      pc.save();
      window.drawFrame(pc, t, film, view, motion);
      pc.restore();
      out.push({ t, boxes, plates });
    }
    return { width: canvas.width, height: canvas.height, safe: view.safe, vertical: view.vertical, fps: film.fps || 30, samples: out };
  };
  window.__hf = window.__hf || {};
  window.__hf.buildReady = window.__hf.buildReady || {};
  window.__hf.buildReady["motion-use-film"] = (async () => {
    await Promise.all([
      document.fonts.load('700 80px "Film Sans"'),
      document.fonts.load('500 30px "Film Mono"'),
    ]);
    if (!document.fonts.check('700 80px "Film Sans"'))
      throw new Error("Film Sans did not load");
    if (typeof window.drawFrame !== "function")
      throw new Error("composition must define window.drawFrame");
    window.filmAssets = {};
    await Promise.all(
      Object.entries(film.assets).map(async ([key, src]) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        window.filmAssets[key] = image;
      }),
    );
    // Declared files (models, environment maps, decoders) as URLs a loader can fetch.
    window.filmFiles = { ...(film.files ?? {}) };
    // Optional setup: a local library can prepare a renderer or geometry once.
    // A WebGL author can draw its offscreen renderer into ctx on each drawFrame.
    if (typeof window.setupFilm === "function")
      await window.setupFilm(film, view, motion);
    ready = true;
    await loadFrames(missingFrames(requested - (film.offset || 0)));
    renderAt(requested - (film.offset || 0));
  })();
})();
