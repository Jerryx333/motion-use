// motion-render phase 1 has no WebGL: this film must fail with a clear message, not draw black.
window.setupFilm = function (film, view) {
  const c = document.createElement("canvas");
  c.width = view.width;
  c.height = view.height;
  window.__gl = c.getContext("webgl2");
};
window.drawFrame = function (ctx, t, film, view) {
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, view.width, view.height);
};
