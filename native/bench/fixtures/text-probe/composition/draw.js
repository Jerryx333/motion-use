// Calibration sheet for motion-render's text against Chrome: weights, sizes, every baseline, the
// measured width (red line and tick) and actualBoundingBox (blue box). Frame 1 adds shadow, blur,
// gradients, dashes and composite operations.
window.drawFrame = function (c, t, film, view) {
  c.fillStyle = "#ffffff";
  c.fillRect(0, 0, view.width, view.height);
  const txt = film.copy.a;
  if (t < 1) {
    const rows = [
      [100, '"Film Sans"', 150, "middle"],
      [700, '"Film Sans"', 150, "top"],
      [900, '"Film Sans"', 48, "alphabetic"],
      [700, '"Film Mono", "Film Sans"', 110, "bottom"],
      [400, '"Film Mono", "Film Sans"', 24, "middle"],
      [700, '"Film Sans"', 18, "hanging"],
      [500, "sans-serif", 40, "ideographic"],
    ];
    let y = 10;
    for (const [w, f, s, bl] of rows) {
      y += s * 1.3;
      c.font = `${w} ${s}px ${f}`;
      c.textBaseline = bl;
      c.textAlign = "left";
      c.fillStyle = "#111";
      c.fillText(txt, 40, y);
      const m = c.measureText(txt);
      c.fillStyle = "#e00";
      c.fillRect(40, y, m.width, 1);
      c.fillRect(40 + m.width, y - s / 2, 2, s);
      c.strokeStyle = "#06c";
      c.lineWidth = 1;
      c.strokeRect(40 - m.actualBoundingBoxLeft, y - m.actualBoundingBoxAscent, m.actualBoundingBoxLeft + m.actualBoundingBoxRight, m.actualBoundingBoxAscent + m.actualBoundingBoxDescent);
    }
    c.font = '700 60px "Film Sans"';
    c.textBaseline = "middle";
    c.textAlign = "center";
    c.fillStyle = "#111";
    c.fillText("centered maxWidth squeeze", view.width * 0.75, 980, 500);
    c.textAlign = "right";
    c.fillText("right", view.width - 40, 1040);
    return;
  }
  // effects
  const g = c.createLinearGradient(0, 0, 600, 0);
  g.addColorStop(0, "#ff5a4e");
  g.addColorStop(0.5, "rgba(255, 200, 58, 0.5)");
  g.addColorStop(1, "hsl(200, 80%, 50%)");
  c.fillStyle = g;
  c.fillRect(40, 40, 600, 200);
  const r = c.createRadialGradient(900, 140, 10, 900, 140, 120);
  r.addColorStop(0, "white");
  r.addColorStop(1, "navy");
  c.fillStyle = r;
  c.beginPath();
  c.arc(900, 140, 120, 0, Math.PI * 2);
  c.fill();
  c.save();
  c.shadowColor = "rgba(0,0,0,0.5)";
  c.shadowBlur = 30;
  c.shadowOffsetY = 18;
  c.fillStyle = "#fff";
  c.beginPath();
  c.roundRect(1100, 40, 400, 200, 24);
  c.fill();
  c.restore();
  c.save();
  c.filter = "blur(12px)";
  c.fillStyle = "#4fd86a";
  c.fillRect(1600, 60, 200, 160);
  c.restore();
  c.save();
  c.setLineDash([24, 12]);
  c.lineDashOffset = 6;
  c.lineWidth = 8;
  c.lineCap = "round";
  c.lineJoin = "round";
  c.strokeStyle = "#333";
  c.beginPath();
  c.moveTo(40, 320);
  c.bezierCurveTo(300, 260, 500, 460, 800, 320);
  c.quadraticCurveTo(900, 260, 1000, 380);
  c.arcTo(1100, 480, 1200, 300, 60);
  c.stroke();
  c.restore();
  const modes = ["multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "destination-out", "source-atop", "xor", "lighter"];
  modes.forEach((m, i) => {
    const x = 40 + (i % 10) * 180,
      y = 520 + Math.floor(i / 10) * 220;
    c.fillStyle = "#2a6fdb";
    c.fillRect(x, y, 120, 120);
    c.save();
    c.globalCompositeOperation = m;
    c.fillStyle = "rgba(255, 140, 0, 0.8)";
    c.beginPath();
    c.ellipse(x + 100, y + 100, 70, 50, 0.4, 0, Math.PI * 2);
    c.fill();
    c.restore();
    c.font = '500 18px "Film Mono"';
    c.fillStyle = "#111";
    c.textBaseline = "top";
    c.textAlign = "left";
    c.fillText(m, x, y + 160);
  });
  c.save();
  c.translate(1500, 900);
  c.rotate(0.3);
  c.scale(1.5, 0.8);
  c.globalAlpha = 0.6;
  c.fillStyle = "#c33";
  c.beginPath();
  c.rect(-100, -60, 200, 120);
  c.rect(-50, -30, 100, 60);
  c.fill("evenodd");
  c.restore();
};
