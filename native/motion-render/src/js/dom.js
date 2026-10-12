// motion-render browser shim: just enough DOM + Canvas 2D for motion-use's film-runtime.js,
// film-kit.js and drawing code. Every drawing call goes to Skia through __native (Rust).
// Nothing here is a free-running clock: timers run on a virtual clock, in order, between frames.
(() => {
  "use strict";
  const N = globalThis.__native;
  const G = globalThis;
  G.window = G;
  G.self = G;
  G.globalThis = G;

  // ---------------------------------------------------------------- console
  const fmt = (args) =>
    args
      .map((a) => {
        if (typeof a === "string") return a;
        if (a instanceof Error) return a.stack || String(a);
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");
  G.console = {
    log: (...a) => N.log(1, fmt(a)),
    info: (...a) => N.log(1, fmt(a)),
    debug: (...a) => N.log(0, fmt(a)),
    warn: (...a) => N.log(2, fmt(a)),
    error: (...a) => N.log(3, fmt(a)),
    trace: () => {},
    time: () => {},
    timeEnd: () => {},
    assert: (c, ...a) => {
      if (!c) N.log(3, "Assertion failed: " + fmt(a));
    },
  };

  // ---------------------------------------------------------------- timers (virtual clock)
  let timerSeq = 1,
    clock = 0;
  const timers = new Map();
  G.setTimeout = (fn, ms = 0, ...args) => {
    const id = timerSeq++;
    timers.set(id, { fn, at: clock + Math.max(0, +ms || 0), args, seq: id });
    return id;
  };
  G.clearTimeout = (id) => timers.delete(id);
  G.setInterval = (fn, ms = 0, ...args) => {
    // Intervals would run forever on a virtual clock: run once, like a timeout.
    return G.setTimeout(fn, ms, ...args);
  };
  G.clearInterval = G.clearTimeout;
  G.requestAnimationFrame = (fn) => G.setTimeout(() => fn(clock), 16);
  G.cancelAnimationFrame = G.clearTimeout;
  G.queueMicrotask = G.queueMicrotask || ((fn) => Promise.resolve().then(fn));
  const runTimers = () => {
    let ran = 0;
    while (timers.size && ran < 10000) {
      let next = null;
      for (const t of timers.values()) if (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq)) next = t;
      timers.delete(next.seq);
      clock = Math.max(clock, next.at);
      ran++;
      try {
        next.fn(...next.args);
      } catch (e) {
        N.log(3, "timer: " + (e && e.stack ? e.stack : e));
      }
    }
    return ran;
  };
  G.performance = G.performance || { now: () => N.now() };

  // ---------------------------------------------------------------- events
  class Event {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = !!init.bubbles;
      this.defaultPrevented = false;
    }
    preventDefault() {
      this.defaultPrevented = true;
    }
    stopPropagation() {}
  }
  class CustomEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.detail = init.detail ?? null;
    }
  }
  G.Event = Event;
  G.CustomEvent = CustomEvent;
  class EventTarget {
    addEventListener(type, fn) {
      ((this.__listeners ||= {})[type] ||= []).push(fn);
    }
    removeEventListener(type, fn) {
      const l = this.__listeners?.[type];
      if (l) this.__listeners[type] = l.filter((f) => f !== fn);
    }
    dispatchEvent(ev) {
      for (const fn of [...(this.__listeners?.[ev.type] || [])]) {
        if (typeof fn === "function") fn.call(this, ev);
        else if (fn && typeof fn.handleEvent === "function") fn.handleEvent(ev);
      }
      const on = this["on" + ev.type];
      if (typeof on === "function") on.call(this, ev);
      return !ev.defaultPrevented;
    }
  }
  G.EventTarget = EventTarget;
  const winListeners = new EventTarget();
  G.addEventListener = (t, f) => winListeners.addEventListener(t, f);
  G.removeEventListener = (t, f) => winListeners.removeEventListener(t, f);
  G.dispatchEvent = (e) => winListeners.dispatchEvent(e);

  // ---------------------------------------------------------------- URLs and files
  const unwrapUrl = (s) => {
    s = String(s).trim();
    const m = /^url\(\s*(['"]?)(.*?)\1\s*\)/.exec(s);
    return m ? m[2] : s;
  };
  G.fetch = (url) => {
    try {
      const buf = N.readFile(unwrapUrl(url));
      if (!buf) return Promise.reject(new TypeError(`fetch: cannot read ${url}`));
      const bytes = new Uint8Array(buf);
      const res = {
        ok: true,
        status: 200,
        url: String(url),
        arrayBuffer: () => Promise.resolve(buf.slice(0)),
        text: () => Promise.resolve(new TextDecoder().decode(bytes)),
        json: () => Promise.resolve(JSON.parse(new TextDecoder().decode(bytes))),
        blob: () => Promise.resolve(new Blob([bytes])),
      };
      return Promise.resolve(res);
    } catch (e) {
      return Promise.reject(e);
    }
  };
  if (typeof G.TextDecoder === "undefined") {
    G.TextDecoder = class {
      decode(b) {
        return N.utf8Decode(b instanceof ArrayBuffer ? b : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      }
    };
    G.TextEncoder = class {
      encode(s) {
        return new Uint8Array(N.utf8Encode(String(s)));
      }
    };
  }
  G.Blob = class {
    constructor(parts = []) {
      this.parts = parts;
    }
  };
  G.URL = G.URL || class {
    constructor(u) {
      this.href = String(u);
    }
    toString() {
      return this.href;
    }
  };
  G.URL.createObjectURL = () => "blob:unsupported";
  G.URL.revokeObjectURL = () => {};

  // ---------------------------------------------------------------- geometry
  class DOMMatrix {
    constructor(init) {
      let a = 1, b = 0, c = 0, d = 1, e = 0, f = 0;
      if (Array.isArray(init) && init.length >= 6) [a, b, c, d, e, f] = init;
      else if (init && typeof init === "object") ({ a = 1, b = 0, c = 0, d = 1, e = 0, f = 0 } = init);
      Object.assign(this, { a, b, c, d, e, f });
    }
    get m11() { return this.a; }
    get m12() { return this.b; }
    get m21() { return this.c; }
    get m22() { return this.d; }
    get m41() { return this.e; }
    get m42() { return this.f; }
    get is2D() { return true; }
    get isIdentity() {
      return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
    }
    multiply(m) {
      const { a, b, c, d, e, f } = this;
      return new DOMMatrix([
        a * m.a + c * m.b, b * m.a + d * m.b,
        a * m.c + c * m.d, b * m.c + d * m.d,
        a * m.e + c * m.f + e, b * m.e + d * m.f + f,
      ]);
    }
    inverse() {
      const { a, b, c, d, e, f } = this;
      const det = a * d - b * c;
      if (!det) return new DOMMatrix([NaN, NaN, NaN, NaN, NaN, NaN]);
      return new DOMMatrix([d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]);
    }
    translate(x = 0, y = 0) {
      return this.multiply(new DOMMatrix([1, 0, 0, 1, x, y]));
    }
    scale(sx = 1, sy = sx) {
      return this.multiply(new DOMMatrix([sx, 0, 0, sy, 0, 0]));
    }
    rotate(deg = 0) {
      const r = (deg * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
      return this.multiply(new DOMMatrix([cs, sn, -sn, cs, 0, 0]));
    }
    transformPoint(p = {}) {
      const x = p.x ?? 0, y = p.y ?? 0;
      return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f, z: 0, w: 1 };
    }
  }
  G.DOMMatrix = DOMMatrix;
  G.DOMMatrixReadOnly = DOMMatrix;
  G.DOMPoint = class {
    constructor(x = 0, y = 0, z = 0, w = 1) {
      Object.assign(this, { x, y, z, w });
    }
  };

  // ---------------------------------------------------------------- images
  class ImageData {
    constructor(a, b, c) {
      if (a instanceof Uint8ClampedArray) {
        this.data = a;
        this.width = b;
        this.height = c ?? a.length / 4 / b;
      } else {
        this.width = a | 0;
        this.height = b | 0;
        this.data = new Uint8ClampedArray(this.width * this.height * 4);
      }
      this.colorSpace = "srgb";
    }
  }
  G.ImageData = ImageData;

  class Node extends EventTarget {
    constructor(tag) {
      super();
      this.tagName = this.nodeName = String(tag).toUpperCase();
      this.style = {};
      this.children = [];
      this.childNodes = this.children;
      this.attributes = {};
      this.dataset = {};
      this.id = "";
      this.className = "";
      this.textContent = "";
      this.parentNode = null;
    }
    appendChild(c) {
      this.children.push(c);
      c.parentNode = this;
      return c;
    }
    append(...cs) {
      for (const c of cs) if (typeof c === "object") this.appendChild(c);
    }
    removeChild(c) {
      this.children = this.childNodes = this.children.filter((x) => x !== c);
      return c;
    }
    remove() {
      this.parentNode?.removeChild(this);
    }
    insertBefore(c) {
      return this.appendChild(c);
    }
    setAttribute(k, v) {
      this.attributes[k] = String(v);
      if (k === "id") this.id = String(v);
      if (k === "width" || k === "height") this[k] = +v;
    }
    getAttribute(k) {
      return this.attributes[k] ?? null;
    }
    hasAttribute(k) {
      return k in this.attributes;
    }
    removeAttribute(k) {
      delete this.attributes[k];
    }
    getBoundingClientRect() {
      const w = this.width || 0, h = this.height || 0;
      return { x: 0, y: 0, left: 0, top: 0, width: w, height: h, right: w, bottom: h };
    }
    querySelector(sel) {
      return G.document.querySelector(sel);
    }
    querySelectorAll(sel) {
      return G.document.querySelectorAll(sel);
    }
    get innerHTML() {
      return "";
    }
    set innerHTML(v) {}
    get clientWidth() {
      return this.width || 0;
    }
    get clientHeight() {
      return this.height || 0;
    }
  }
  G.Node = G.Element = G.HTMLElement = Node;

  let imageLoads = 0;
  // Decoded images are released when their element is collected (footage frames come and go).
  const imageRegistry = typeof FinalizationRegistry === "function" ? new FinalizationRegistry((id) => N.imageFree(id)) : null;
  class HTMLImageElement extends Node {
    constructor(w, h) {
      super("img");
      this._img = -1;
      this._src = "";
      this.complete = false;
      this.naturalWidth = 0;
      this.naturalHeight = 0;
      this._w = w;
      this._h = h;
      this.crossOrigin = null;
      this.decoding = "auto";
      this._error = null;
    }
    get src() {
      return this._src;
    }
    set src(v) {
      this._src = String(v);
      this._error = null;
      try {
        const r = N.imageLoad(this._src);
        if (!r) throw new Error(`could not decode image ${this._src}`);
        [this._img, this.naturalWidth, this.naturalHeight] = r;
        imageRegistry?.register(this, this._img);
        this.complete = true;
        imageLoads++;
        setTimeout(() => this.dispatchEvent(new Event("load")), 0);
      } catch (e) {
        this._img = -1;
        this.complete = true;
        this._error = e;
        setTimeout(() => this.dispatchEvent(new Event("error")), 0);
      }
    }
    get width() {
      return this._w ?? this.naturalWidth;
    }
    set width(v) {
      this._w = +v;
    }
    get height() {
      return this._h ?? this.naturalHeight;
    }
    set height(v) {
      this._h = +v;
    }
    decode() {
      return this._error ? Promise.reject(new DOMException(`EncodingError: ${this._error.message}`)) : Promise.resolve();
    }
  }
  G.Image = HTMLImageElement;
  G.HTMLImageElement = HTMLImageElement;
  G.DOMException = G.DOMException || class DOMException extends Error {};
  G.createImageBitmap = (src) => Promise.resolve(src);

  // ---------------------------------------------------------------- canvas
  const CAP = { butt: 0, round: 1, square: 2 };
  const JOIN = { miter: 0, round: 1, bevel: 2 };
  const ALIGN = { start: 0, end: 1, left: 2, right: 3, center: 4 };
  const BASE = { alphabetic: 0, top: 1, hanging: 2, middle: 3, ideographic: 4, bottom: 5 };
  const QUALITY = { low: 0, medium: 1, high: 2 };
  const RULE = (r) => (r === "evenodd" ? 1 : 0);

  class CanvasGradient {
    constructor(id) {
      this._g = id;
    }
    addColorStop(offset, color) {
      offset = +offset;
      if (!(offset >= 0 && offset <= 1)) throw new DOMException("IndexSizeError: offset out of range");
      if (!N.gradientStop(this._g, offset, String(color))) throw new DOMException(`SyntaxError: bad color ${color}`);
    }
  }
  class CanvasPattern {
    constructor(id) {
      this._p = id;
    }
    setTransform(m = {}) {
      const t = new DOMMatrix(m);
      N.patternTransform(this._p, t.a, t.b, t.c, t.d, t.e, t.f);
    }
  }
  G.CanvasGradient = CanvasGradient;
  G.CanvasPattern = CanvasPattern;

  class Path2D {
    constructor(src) {
      this._path = N.pathNew();
      if (src instanceof Path2D) N.pathAdd(this._path, src._path, 1, 0, 0, 1, 0, 0);
      else if (typeof src === "string") N.pathSvg(this._path, src);
    }
    addPath(p, m) {
      const t = new DOMMatrix(m);
      N.pathAdd(this._path, p._path, t.a, t.b, t.c, t.d, t.e, t.f);
    }
  }
  const pathMethods = {
    closePath() {
      N.closePath(this._path);
    },
    moveTo(x, y) {
      N.moveTo(this._path, +x, +y);
    },
    lineTo(x, y) {
      N.lineTo(this._path, +x, +y);
    },
    quadraticCurveTo(cx, cy, x, y) {
      N.quadTo(this._path, +cx, +cy, +x, +y);
    },
    bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
      N.bezierTo(this._path, +c1x, +c1y, +c2x, +c2y, +x, +y);
    },
    arc(x, y, r, a0, a1, ccw = false) {
      if (+r < 0) throw new DOMException("IndexSizeError: negative radius");
      N.arc(this._path, +x, +y, +r, +a0, +a1, !!ccw);
    },
    arcTo(x1, y1, x2, y2, r) {
      if (+r < 0) throw new DOMException("IndexSizeError: negative radius");
      N.arcTo(this._path, +x1, +y1, +x2, +y2, +r);
    },
    ellipse(x, y, rx, ry, rot, a0, a1, ccw = false) {
      if (+rx < 0 || +ry < 0) throw new DOMException("IndexSizeError: negative radius");
      N.ellipse(this._path, +x, +y, +rx, +ry, +rot, +a0, +a1, !!ccw);
    },
    rect(x, y, w, h) {
      N.rect(this._path, +x, +y, +w, +h);
    },
    roundRect(x, y, w, h, radii = 0) {
      const list = Array.isArray(radii) ? radii : [radii];
      if (list.length < 1 || list.length > 4) throw new RangeError("roundRect: 1 to 4 radii");
      const rs = list.map((r) => (typeof r === "object" && r ? [+(r.x ?? 0), +(r.y ?? 0)] : [+r, +r]));
      for (const [a, b] of rs) if (a < 0 || b < 0) throw new RangeError("roundRect: negative radius");
      // CSS order: top-left, top-right, bottom-right, bottom-left.
      let tl, tr, br, bl;
      if (rs.length === 1) tl = tr = br = bl = rs[0];
      else if (rs.length === 2) [tl, tr, br, bl] = [rs[0], rs[1], rs[0], rs[1]];
      else if (rs.length === 3) [tl, tr, br, bl] = [rs[0], rs[1], rs[2], rs[1]];
      else [tl, tr, br, bl] = rs;
      N.roundRect(this._path, +x, +y, +w, +h, tl[0], tl[1], tr[0], tr[1], br[0], br[1], bl[0], bl[1]);
    },
  };
  Object.assign(Path2D.prototype, pathMethods);
  G.Path2D = Path2D;

  class TextMetrics {
    constructor(a) {
      this.width = a[0];
      this.actualBoundingBoxLeft = a[1];
      this.actualBoundingBoxRight = a[2];
      this.actualBoundingBoxAscent = a[3];
      this.actualBoundingBoxDescent = a[4];
      this.fontBoundingBoxAscent = a[5];
      this.fontBoundingBoxDescent = a[6];
      this.emHeightAscent = a[7];
      this.emHeightDescent = a[8];
      this.hangingBaseline = a[9];
      this.alphabeticBaseline = a[10];
      this.ideographicBaseline = a[11];
    }
  }
  G.TextMetrics = TextMetrics;

  const defaults = () => ({
    fillStyle: "#000000",
    strokeStyle: "#000000",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    miterLimit: 10,
    lineDash: [],
    lineDashOffset: 0,
    shadowBlur: 0,
    shadowColor: "rgba(0, 0, 0, 0)",
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    font: "10px sans-serif",
    textAlign: "start",
    textBaseline: "alphabetic",
    direction: "ltr",
    filter: "none",
    imageSmoothingEnabled: true,
    imageSmoothingQuality: "low",
    letterSpacing: "0px",
    wordSpacing: "0px",
    fontKerning: "auto",
    fontStretch: "normal",
    fontVariantCaps: "normal",
    textRendering: "auto",
  });

  class CanvasRenderingContext2D {
    constructor(canvas, id, opts = {}) {
      this.canvas = canvas;
      this._id = id;
      this._path = N.ctxPath(id);
      this._s = defaults();
      this._stack = [];
      this._opts = opts;
    }
    getContextAttributes() {
      return { alpha: this._opts.alpha !== false, colorSpace: "srgb", desynchronized: false, willReadFrequently: !!this._opts.willReadFrequently };
    }
    _reset() {
      this._s = defaults();
      this._stack = [];
    }
    save() {
      this._stack.push({ ...this._s });
      N.save(this._id);
    }
    restore() {
      if (!this._stack.length) return;
      this._s = this._stack.pop();
      N.restore(this._id);
    }
    reset() {
      N.resetCtx(this._id);
      this._reset();
    }
    isContextLost() {
      return false;
    }
    // transforms
    scale(x, y) {
      N.transform(this._id, +x, 0, 0, +y, 0, 0);
    }
    rotate(a) {
      const c = Math.cos(a), s = Math.sin(a);
      N.transform(this._id, c, s, -s, c, 0, 0);
    }
    translate(x, y) {
      N.transform(this._id, 1, 0, 0, 1, +x, +y);
    }
    transform(a, b, c, d, e, f) {
      N.transform(this._id, +a, +b, +c, +d, +e, +f);
    }
    setTransform(a, b, c, d, e, f) {
      if (arguments.length === 0) return this.resetTransform();
      if (typeof a === "object") {
        const m = new DOMMatrix(a);
        return N.setTransform(this._id, m.a, m.b, m.c, m.d, m.e, m.f);
      }
      N.setTransform(this._id, +a, +b, +c, +d, +e, +f);
    }
    resetTransform() {
      N.setTransform(this._id, 1, 0, 0, 1, 0, 0);
    }
    getTransform() {
      return new DOMMatrix(N.getTransform(this._id));
    }
    // paths
    beginPath() {
      N.beginPath(this._path);
    }
    fill(a, b) {
      if (a instanceof Path2D) N.fill(this._id, a._path, RULE(b));
      else N.fill(this._id, this._path, RULE(a));
    }
    stroke(p) {
      N.stroke(this._id, p instanceof Path2D ? p._path : this._path);
    }
    clip(a, b) {
      if (a instanceof Path2D) N.clip(this._id, a._path, RULE(b));
      else N.clip(this._id, this._path, RULE(a));
    }
    isPointInPath(a, b, c, d) {
      if (a instanceof Path2D) return N.isPointInPath(this._id, a._path, +b, +c, RULE(d));
      return N.isPointInPath(this._id, this._path, +a, +b, RULE(c));
    }
    isPointInStroke(a, b, c) {
      if (a instanceof Path2D) return N.isPointInStroke(this._id, a._path, +b, +c);
      return N.isPointInStroke(this._id, this._path, +a, +b);
    }
    fillRect(x, y, w, h) {
      N.fillRect(this._id, +x, +y, +w, +h);
    }
    strokeRect(x, y, w, h) {
      N.strokeRect(this._id, +x, +y, +w, +h);
    }
    clearRect(x, y, w, h) {
      N.clearRect(this._id, +x, +y, +w, +h);
    }
    // text
    fillText(text, x, y, maxWidth) {
      N.fillText(this._id, String(text), +x, +y, maxWidth === undefined ? Infinity : +maxWidth);
    }
    strokeText(text, x, y, maxWidth) {
      N.strokeText(this._id, String(text), +x, +y, maxWidth === undefined ? Infinity : +maxWidth);
    }
    measureText(text) {
      return new TextMetrics(N.measureText(this._id, String(text)));
    }
    // images
    drawImage(img, ...a) {
      if (img == null) throw new TypeError("drawImage: image is null");
      let kind, src;
      if (img instanceof HTMLCanvasElement) {
        kind = 1;
        src = img._id;
      } else if (img instanceof HTMLImageElement) {
        if (img._img < 0) {
          if (img._error) throw new DOMException(`InvalidStateError: broken image ${img._src}`);
          return;
        }
        kind = 0;
        src = img._img;
      } else if (img && img.canvas instanceof HTMLCanvasElement) {
        kind = 1;
        src = img.canvas._id;
      } else throw new TypeError("drawImage: unsupported image source");
      if (a.length !== 2 && a.length !== 4 && a.length !== 8) throw new TypeError("drawImage: wrong number of arguments");
      N.drawImage(this._id, kind, src, a.length, ...a.map(Number));
    }
    createImageData(a, b) {
      if (a instanceof ImageData) return new ImageData(a.width, a.height);
      return new ImageData(Math.abs(a | 0), Math.abs(b | 0));
    }
    getImageData(x, y, w, h) {
      const out = new ImageData(Math.abs(w | 0), Math.abs(h | 0));
      N.getImageData(this._id, x | 0, y | 0, out.width, out.height, out.data);
      return out;
    }
    putImageData(img, dx, dy, x = 0, y = 0, w = img.width, h = img.height) {
      N.putImageData(this._id, img.data, img.width, img.height, dx | 0, dy | 0, x | 0, y | 0, w | 0, h | 0);
    }
    createLinearGradient(x0, y0, x1, y1) {
      return new CanvasGradient(N.gradientNew(0, +x0, +y0, 0, +x1, +y1, 0));
    }
    createRadialGradient(x0, y0, r0, x1, y1, r1) {
      if (r0 < 0 || r1 < 0) throw new DOMException("IndexSizeError: negative radius");
      return new CanvasGradient(N.gradientNew(1, +x0, +y0, +r0, +x1, +y1, +r1));
    }
    createConicGradient(angle, x, y) {
      return new CanvasGradient(N.gradientNew(2, +x, +y, +angle, 0, 0, 0));
    }
    createPattern(img, repetition) {
      let kind, src;
      if (img instanceof HTMLCanvasElement) {
        kind = 1;
        src = img._id;
      } else if (img instanceof HTMLImageElement) {
        if (img._img < 0) return null;
        kind = 0;
        src = img._img;
      } else throw new TypeError("createPattern: unsupported source");
      const rep = { "": 0, null: 0, repeat: 0, "repeat-x": 1, "repeat-y": 2, "no-repeat": 3 }[String(repetition ?? "")];
      if (rep === undefined) throw new DOMException("SyntaxError: bad repetition");
      const id = N.patternNew(kind, src, rep);
      return id < 0 ? null : new CanvasPattern(id);
    }
    setLineDash(list) {
      if (!Array.isArray(list) && !(list && typeof list.length === "number")) return;
      const l = Array.from(list, Number);
      if (l.some((v) => !Number.isFinite(v) || v < 0)) return;
      this._s.lineDash = l.length % 2 ? [...l, ...l] : l;
      N.setLineDash(this._id, this._s.lineDash);
    }
    getLineDash() {
      return [...this._s.lineDash];
    }
    drawFocusIfNeeded() {}
  }
  const prop = (name, set) =>
    Object.defineProperty(CanvasRenderingContext2D.prototype, name, {
      get() {
        return this._s[name];
      },
      set,
      configurable: true,
    });
  const style = (name, fn) =>
    prop(name, function (v) {
      if (v instanceof CanvasGradient) {
        N[fn](this._id, 1, v._g, "");
        this._s[name] = v;
      } else if (v instanceof CanvasPattern) {
        N[fn](this._id, 2, v._p, "");
        this._s[name] = v;
      } else {
        const norm = N[fn](this._id, 0, 0, String(v));
        if (norm !== undefined) this._s[name] = norm;
      }
    });
  style("fillStyle", "setFillStyle");
  style("strokeStyle", "setStrokeStyle");
  const finite = (name, fn, ok = (v) => true) =>
    prop(name, function (v) {
      v = +v;
      if (!Number.isFinite(v) || !ok(v)) return;
      this._s[name] = v;
      N[fn](this._id, v);
    });
  finite("globalAlpha", "setGlobalAlpha", (v) => v >= 0 && v <= 1);
  finite("lineWidth", "setLineWidth", (v) => v > 0);
  finite("miterLimit", "setMiterLimit", (v) => v > 0);
  finite("lineDashOffset", "setLineDashOffset");
  finite("shadowBlur", "setShadowBlur", (v) => v >= 0);
  prop("shadowOffsetX", function (v) {
    v = +v;
    if (!Number.isFinite(v)) return;
    this._s.shadowOffsetX = v;
    N.setShadowOffset(this._id, v, this._s.shadowOffsetY);
  });
  prop("shadowOffsetY", function (v) {
    v = +v;
    if (!Number.isFinite(v)) return;
    this._s.shadowOffsetY = v;
    N.setShadowOffset(this._id, this._s.shadowOffsetX, v);
  });
  prop("shadowColor", function (v) {
    const norm = N.setShadowColor(this._id, String(v));
    if (norm !== undefined) this._s.shadowColor = norm;
  });
  const keyword = (name, table, fn) =>
    prop(name, function (v) {
      v = String(v);
      if (!(v in table)) return;
      this._s[name] = v;
      N[fn](this._id, table[v]);
    });
  keyword("lineCap", CAP, "setLineCap");
  keyword("lineJoin", JOIN, "setLineJoin");
  keyword("textAlign", ALIGN, "setTextAlign");
  keyword("textBaseline", BASE, "setTextBaseline");
  prop("globalCompositeOperation", function (v) {
    v = String(v);
    if (N.setComposite(this._id, v)) this._s.globalCompositeOperation = v;
  });
  prop("font", function (v) {
    const norm = N.setFont(this._id, String(v));
    if (norm !== undefined) this._s.font = norm;
  });
  prop("filter", function (v) {
    v = String(v);
    if (N.setFilter(this._id, v)) this._s.filter = v;
  });
  prop("imageSmoothingEnabled", function (v) {
    this._s.imageSmoothingEnabled = !!v;
    N.setSmoothing(this._id, !!v, QUALITY[this._s.imageSmoothingQuality]);
  });
  prop("imageSmoothingQuality", function (v) {
    if (!(v in QUALITY)) return;
    this._s.imageSmoothingQuality = v;
    N.setSmoothing(this._id, this._s.imageSmoothingEnabled, QUALITY[v]);
  });
  prop("letterSpacing", function (v) {
    const m = /^(-?[\d.]+)px$/.exec(String(v).trim());
    if (!m) return;
    this._s.letterSpacing = String(v).trim();
    N.setLetterSpacing(this._id, +m[1]);
  });
  for (const name of ["direction", "wordSpacing", "fontKerning", "fontStretch", "fontVariantCaps", "textRendering"])
    prop(name, function (v) {
      this._s[name] = String(v);
    });
  Object.assign(CanvasRenderingContext2D.prototype, pathMethods);
  G.CanvasRenderingContext2D = CanvasRenderingContext2D;
  G.OffscreenCanvasRenderingContext2D = CanvasRenderingContext2D;

  class HTMLCanvasElement extends Node {
    constructor(w = 300, h = 150) {
      super("canvas");
      this._w = Math.max(0, w | 0);
      this._h = Math.max(0, h | 0);
      this._id = N.canvasNew(this._w, this._h);
      this._ctx = null;
    }
    get width() {
      return this._w;
    }
    set width(v) {
      this._w = Math.max(0, +v | 0);
      N.canvasResize(this._id, this._w, this._h);
      this._ctx?._reset();
    }
    get height() {
      return this._h;
    }
    set height(v) {
      this._h = Math.max(0, +v | 0);
      N.canvasResize(this._id, this._w, this._h);
      this._ctx?._reset();
    }
    getContext(type, opts) {
      type = String(type);
      if (type === "2d") return (this._ctx ||= new CanvasRenderingContext2D(this, this._id, opts || {}));
      if (/^(webgl2?|experimental-webgl|webgpu|bitmaprenderer)$/.test(type)) {
        N.log(3, `motion-render: getContext("${type}") is not supported in phase 1 (2D canvas only; WebGL comes with the wgpu backend). Render this film with motion-use's browser engine.`);
        G.__mr.unsupported = `getContext("${type}") is not supported by motion-render yet (2D canvas only)`;
        return null;
      }
      return null;
    }
    toDataURL() {
      throw new Error("motion-render: canvas.toDataURL is not supported");
    }
    toBlob() {
      throw new Error("motion-render: canvas.toBlob is not supported");
    }
    transferControlToOffscreen() {
      return this;
    }
  }
  G.HTMLCanvasElement = HTMLCanvasElement;
  G.OffscreenCanvas = class OffscreenCanvas extends HTMLCanvasElement {
    constructor(w, h) {
      super(w, h);
    }
    convertToBlob() {
      return Promise.reject(new Error("motion-render: convertToBlob is not supported"));
    }
  };

  // ---------------------------------------------------------------- fonts
  class FontFace {
    constructor(family, source, descriptors = {}) {
      this.family = String(family).replace(/^['"]|['"]$/g, "");
      this._source = source;
      this.weight = descriptors.weight ?? "normal";
      this.style = descriptors.style ?? "normal";
      this.status = "unloaded";
      this.loaded = new Promise((res, rej) => ((this._res = res), (this._rej = rej)));
      this.loaded.catch(() => {});
    }
    load() {
      if (this.status === "loaded") return Promise.resolve(this);
      let ok;
      const src = this._source;
      if (typeof src === "string") {
        // first url(...) of a src list
        const m = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(src);
        ok = N.fontLoadUrl(this.family, m ? m[2] : src.trim());
      } else if (src instanceof ArrayBuffer) ok = N.fontLoadBytes(this.family, src);
      else if (ArrayBuffer.isView(src)) ok = N.fontLoadBytes(this.family, src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength));
      if (ok) {
        this.status = "loaded";
        this._res(this);
        return Promise.resolve(this);
      }
      this.status = "error";
      const e = new DOMException(`NetworkError: font ${this.family} could not be loaded`);
      this._rej(e);
      return Promise.reject(e);
    }
  }
  G.FontFace = FontFace;
  const fontSet = new Set();
  const fonts = {
    add(f) {
      fontSet.add(f);
      if (f.status === "unloaded") f.load().catch(() => {});
      return fonts;
    },
    delete(f) {
      return fontSet.delete(f);
    },
    has(f) {
      return fontSet.has(f);
    },
    clear() {
      fontSet.clear();
    },
    load(font) {
      return Promise.resolve([]);
    },
    check(font) {
      return N.fontCheck(String(font));
    },
    forEach(fn) {
      fontSet.forEach(fn);
    },
    get size() {
      return fontSet.size;
    },
    status: "loaded",
    ready: null,
    addEventListener() {},
    removeEventListener() {},
    [Symbol.iterator]() {
      return fontSet[Symbol.iterator]();
    },
  };
  fonts.ready = Promise.resolve(fonts);

  // ---------------------------------------------------------------- document
  const byId = new Map();
  const all = [];
  const root = new Node("html");
  const head = new Node("head");
  const body = new Node("body");
  root.appendChild(head);
  root.appendChild(body);
  const matches = (el, sel) => {
    sel = sel.trim();
    if (sel.startsWith("#")) return el.id === sel.slice(1);
    const m = /^([a-z0-9]+)?(?:#([\w-]+))?(?:\.([\w-]+))?(?:\[([\w-]+)(?:="?([^"\]]*)"?)?\])?$/i.exec(sel);
    if (!m) return false;
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    if (m[2] && el.id !== m[2]) return false;
    if (m[3] && !String(el.className).split(/\s+/).includes(m[3])) return false;
    if (m[4] && !(m[4] in el.attributes)) return false;
    if (m[4] && m[5] !== undefined && el.attributes[m[4]] !== m[5]) return false;
    return true;
  };
  const document = {
    nodeType: 9,
    readyState: "complete",
    documentElement: root,
    head,
    body,
    fonts,
    defaultView: G,
    createElement(tag) {
      tag = String(tag).toLowerCase();
      if (tag === "canvas") return new HTMLCanvasElement();
      if (tag === "img") return new HTMLImageElement();
      return new Node(tag);
    },
    createElementNS(ns, tag) {
      return document.createElement(tag);
    },
    createTextNode(t) {
      const n = new Node("#text");
      n.textContent = t;
      return n;
    },
    getElementById(id) {
      return byId.get(String(id)) ?? null;
    },
    querySelector(sel) {
      for (const part of String(sel).split(",")) {
        const el = all.find((e) => matches(e, part));
        if (el) return el;
      }
      return null;
    },
    querySelectorAll(sel) {
      return all.filter((e) => String(sel).split(",").some((p) => matches(e, p)));
    },
    getElementsByTagName(tag) {
      return all.filter((e) => e.tagName === String(tag).toUpperCase());
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
  };
  G.document = document;
  G.navigator = { userAgent: "motion-render", language: "en", languages: ["en"], hardwareConcurrency: 1, platform: "motion-render" };
  G.location = { href: "file:///index.html", protocol: "file:", host: "", hostname: "", origin: "null", pathname: "/index.html", search: "", hash: "" };
  G.devicePixelRatio = 1;
  G.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  G.getComputedStyle = (el) => el.style || {};

  // ---------------------------------------------------------------- driver
  let state = "idle",
    failure = null;
  const settle = (p) => {
    if (p && typeof p.then === "function") {
      state = "pending";
      p.then(
        () => {
          if (state === "pending") state = "ok";
        },
        (e) => {
          state = "error";
          failure = e;
        },
      );
    } else state = "ok";
  };
  const fail = (e) => {
    state = "error";
    failure = e;
  };
  G.__mr = {
    unsupported: null,
    // elements parsed from the page's HTML: [{tag, id, attrs, text}]
    init(elements, size) {
      for (const e of elements) {
        let el;
        if (e.tag === "canvas") {
          const w = e.attrs.width !== undefined ? +e.attrs.width : size?.[0] ?? 300;
          const h = e.attrs.height !== undefined ? +e.attrs.height : size?.[1] ?? 150;
          el = new HTMLCanvasElement(w, h);
        } else if (e.tag === "img") el = new HTMLImageElement();
        else el = new Node(e.tag);
        for (const [k, v] of Object.entries(e.attrs)) if (k !== "width" && k !== "height") el.setAttribute(k, v);
        if (e.attrs.class) el.className = e.attrs.class;
        for (const [k, v] of Object.entries(e.attrs)) if (k.startsWith("data-")) el.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
        el.textContent = e.text ?? "";
        el.text = el.textContent;
        if (e.id) byId.set(e.id, el);
        all.push(el);
        body.appendChild(el);
      }
    },
    runTimers,
    state: () => (state === "error" ? "error: " + (failure && failure.stack ? failure.stack : failure) : G.__mr.unsupported ? "error: " + G.__mr.unsupported : state),
    // motion-use film page: wait for the runtime's build promise.
    filmSetup() {
      state = "idle";
      failure = null;
      try {
        const ready = G.__hf?.buildReady?.["motion-use-film"];
        if (!ready) throw new Error("page did not start motion-use's film runtime (window.__hf.buildReady missing)");
        settle(ready);
      } catch (e) {
        fail(e);
      }
    },
    filmOutput() {
      const c = document.getElementById("film-canvas");
      if (!c) throw new Error("page has no #film-canvas");
      return c._id;
    },
    // Exactly what HyperFrames does: an hf-seek event; a promise handed to waitUntil must settle.
    filmSeek(t) {
      state = "idle";
      failure = null;
      let pending = null;
      try {
        G.dispatchEvent(new CustomEvent("hf-seek", { detail: { time: t, waitUntil: (p) => (pending = p) } }));
        settle(pending);
      } catch (e) {
        fail(e);
      }
    },
    // A frame-engine page (window.setupEngine(job) / window.renderFrame(t)).
    engineSetup(job) {
      state = "idle";
      failure = null;
      try {
        const c = document.querySelector("canvas");
        if (!c) throw new Error("page has no <canvas>");
        c.width = job.width;
        c.height = job.height;
        settle(typeof G.setupEngine === "function" ? G.setupEngine(job) : null);
      } catch (e) {
        fail(e);
      }
    },
    engineOutput() {
      return document.querySelector("canvas")._id;
    },
    engineFrame(t) {
      state = "idle";
      failure = null;
      try {
        if (typeof G.renderFrame !== "function") throw new Error("page does not define window.renderFrame(t)");
        settle(G.renderFrame(t));
      } catch (e) {
        fail(e);
      }
    },
  };
})();
