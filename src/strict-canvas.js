// Shared by Chrome and motion-render. Validation runs on a private context, never capture.
globalThis.__motionUseStrictCanvas = function () {
  const minimum = {
    scale: 2, translate: 2, rotate: 1, moveTo: 2, lineTo: 2, arc: 5, arcTo: 5,
    rect: 4, roundRect: 4, fillRect: 4, strokeRect: 4, clearRect: 4,
    quadraticCurveTo: 4, bezierCurveTo: 6, ellipse: 7, fillText: 3, strokeText: 3,
    drawImage: 3, setTransform: 0, transform: 6, createLinearGradient: 4,
    createRadialGradient: 6, createConicGradient: 3, addColorStop: 2,
    createPattern: 2, measureText: 1, setLineDash: 1, getImageData: 4,
    createImageData: 1, putImageData: 3, isPointInPath: 2, isPointInStroke: 2,
  };
  const numeric = new Set(["globalAlpha", "lineWidth", "miterLimit", "shadowBlur", "shadowOffsetX", "shadowOffsetY", "lineDashOffset"]);
  const errors = new Map(), originals = new WeakMap();
  let frame = 0, time = 0;
  function record(name, kind, message) {
    const key = `${name}\u0000${kind}\u0000${message}`;
    const old = errors.get(key);
    if (old) {
      if (old.last !== frame) old.frames++;
      old.last = frame;
    } else errors.set(key, { name, kind, message, time: +time.toFixed(2), frame, frames: 1, last: frame });
  }
  function nonFinite(value) {
    if (typeof value === "number") return !Number.isFinite(value);
    if (Array.isArray(value) || ArrayBuffer.isView(value)) return Array.from(value).some(nonFinite);
    return false;
  }
  function wrap(target) {
    const methods = new Map();
    const proxy = new Proxy(target, {
      get(obj, name) {
        const value = Reflect.get(obj, name, obj);
        if (typeof value !== "function") return value;
        if (!methods.has(name)) methods.set(name, (...args) => {
          let bad = false;
          const min = minimum[name];
          if (min !== undefined && args.length < min) {
            record(name, "arguments", `needs at least ${min} arguments, received ${args.length}`);
            bad = true;
          }
          // setTransform has an optional DOMMatrix2DInit overload and a six-number overload.
          if (name === "setTransform" && args.length > 0 && args.length < 6 && !(args.length === 1 && (args[0] === undefined || args[0] === null || typeof args[0] === "object"))) {
            record(name, "arguments", `needs a matrix object or 6 arguments, received ${args.length}`);
            bad = true;
          }
          const matrix = name === "setTransform" && args.length === 1 && args[0];
          if (args.some(nonFinite) || (matrix && typeof matrix === "object" && ["a", "b", "c", "d", "e", "f", "m11", "m12", "m21", "m22", "m41", "m42"].some((k) => nonFinite(matrix[k])))) {
            record(name, "non-finite", "received NaN or Infinity");
            bad = true;
          }
          // Avoid a second TypeError for a known bad call, so later errors in this frame survive.
          if (bad) return;
          // Keep state and measurements, but avoid raster work during the full-film pass.
          if (["fill", "stroke", "fillRect", "strokeRect", "clearRect", "fillText", "strokeText", "drawImage", "putImageData"].includes(name)) return;
          const result = value.apply(obj, args);
          return ["createLinearGradient", "createRadialGradient", "createConicGradient", "createPattern"].includes(name) && result ? wrap(result) : result;
        });
        return methods.get(name);
      },
      set(obj, name, value) {
        if (numeric.has(name) && nonFinite(value)) {
          record(name, "non-finite", "assigned NaN or Infinity");
          return true;
        }
        return Reflect.set(obj, name, originals.get(value) ?? value, obj);
      },
    });
    originals.set(proxy, target);
    return proxy;
  }
  return {
    wrap,
    at(f, t) { frame = f; time = t; },
    exception(error) { record("drawFrame", "exception", String(error?.message ?? error)); },
    result() {
      return { errors: [...errors.values()].slice(0, 15).map(({ last, ...error }) => error), error_count: errors.size };
    },
  };
};
