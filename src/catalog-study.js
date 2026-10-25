// Original, seek-safe studies shared by the gallery and renderable film projects.
// Coordinates use a 960×540 design canvas. No previous frame is read.
window.motionStudy = function (c, t, width, height, id) {
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const ease = (x) => {
    const p = clamp(x);
    return p * p * (3 - 2 * p);
  };
  const p = (at, dur) => ease((t - at) / dur);
  const mix = (a, b, x) => a + (b - a) * x;
  const ink = "#24342b",
    accent = "#d75b36",
    paper = "#f3ecdc";
  c.save();
  c.scale(width / 960, height / 540);
  c.fillStyle = ["kinetic", "shared-shape"].includes(id) ? "#e5c146" : paper;
  c.fillRect(0, 0, 960, 540);
  function box(x, y, w, h, color, r = 12) {
    c.fillStyle = color;
    c.beginPath();
    c.roundRect(x, y, w, h, r);
    c.fill();
  }
  function line(x1, y1, x2, y2, color = ink, w = 5) {
    c.strokeStyle = color;
    c.lineWidth = w;
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    c.stroke();
  }
  function text(s, x, y, size = 28, color = ink) {
    c.fillStyle = color;
    c.font = `700 ${size}px "Film Sans",system-ui,sans-serif`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(s, x, y);
  }
  function dot(x, y, r, color) {
    c.fillStyle = color;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  }
  if (id === "whiteboard") {
    const pts = [
        [180, 340],
        [360, 340],
        [360, 210],
        [720, 210],
      ],
      total = 670;
    let remain = p(0.4, 2.2) * total;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1],
        b = pts[i],
        len = Math.hypot(b[0] - a[0], b[1] - a[1]),
        q = clamp(remain / len);
      if (remain > 0) line(a[0], a[1], mix(a[0], b[0], q), mix(a[1], b[1], q));
      remain -= len;
    }
    for (const [x, y] of [pts[0], pts[3]]) dot(x, y, 26, ink);
    let d = p(2.8, 1.8) * total;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1],
        b = pts[i],
        len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (d <= len) {
        dot(mix(a[0], b[0], d / len), mix(a[1], b[1], d / len), 15, accent);
        break;
      }
      d -= len;
    }
  } else if (id === "editorial") {
    c.save();
    c.translate(480, 270);
    c.rotate(-0.025);
    box(-280, -175, 560, 350, "#fffaf0", 2);
    for (let i = 0; i < 6; i++)
      box(
        -220,
        -115 + i * 44,
        i === 2 ? 280 : 420,
        10,
        i === 2 ? ink : "#bbb7a9",
        1,
      );
    line(
      260 - 480,
      270 - 270,
      260 - 480 + 300 * p(1, 0.55),
      270 - 270,
      accent,
      8,
    );
    c.restore();
    c.save();
    c.globalAlpha = p(1.8, 0.4);
    box(650, 355, 190, 70, accent, 3);
    text("EVIDENCE", 745, 390, 22, "#fffaf0");
    c.restore();
  } else if (id === "kinetic") {
    const q = p(0.5, 0.5),
      z = t < 0.5 ? 1.2 : mix(1.2, 1, q);
    c.save();
    c.translate(480, 255);
    c.scale(z, z);
    c.globalAlpha = q;
    text("MAKE IT MOVE", 0, 0, 80);
    c.restore();
    line(170, 330, 170 + 620 * p(1.4, 0.45), 330, ink, 12);
  } else if (["data-story", "chart-reveal"].includes(id)) {
    const vals = [3, 5, 8];
    line(180, 420, 780, 420, ink, 3);
    vals.forEach((v, i) => {
      const h = v * 32 * p(0.4 + i * 0.45, 0.9);
      box(235 + i * 190, 420 - h, 110, h, i === 2 ? accent : "#819487", 0);
      if (t > 2.5) text(String(v), 290 + i * 190, 420 - v * 32 - 26, 30);
    });
    if (id === "chart-reveal") {
      c.save();
      c.globalAlpha = p(3.5, 0.4);
      text("ILLUSTRATIVE", 480, 90, 25);
      line(620, 110, 720, 150, accent);
      c.restore();
    }
  } else if (id === "print") {
    const q = p(0.5, 1.6);
    c.save();
    c.beginPath();
    c.rect(160, 80, 640, 380 * q);
    c.clip();
    box(225, 150, 300, 270, ink, 0);
    dot(570 + 4, 255 + 4, 150, accent);
    c.save();
    c.beginPath();
    c.arc(570, 255, 150, 0, Math.PI * 2);
    c.clip();
    for (let x = 420; x < 730; x += 14)
      for (let y = 100; y < 410; y += 14) dot(x, y, 2.5, paper);
    c.restore();
    c.restore();
  } else if (id === "product") {
    box(170, 100, 620, 340, "#fffdfa");
    box(170, 100, 620, 35, ink, 0);
    for (let i = 0; i < 4; i++) box(205, 165 + i * 57, 130, 22, "#c4cbbc", 4);
    box(405, 200, 270, 140, "#e4e9df");
    c.save();
    c.globalAlpha = p(1, 0.45);
    c.strokeStyle = accent;
    c.lineWidth = 5;
    c.strokeRect(397, 192, 286, 156);
    c.restore();
    const q = p(2, 0.6),
      x = mix(760, 610, q),
      y = mix(440, 305, q);
    c.fillStyle = ink;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + 25, y + 18);
    c.lineTo(x + 10, y + 25);
    c.closePath();
    c.fill();
    if (t > 2.8) dot(610, 305, 8 + 12 * (1 - p(2.8, 0.6)), accent);
  } else if (id === "focus-handoff") {
    const q = p(0.8, 1.4);
    line(290, 270, 670, 270, "#a1aa9b", 3);
    box(120, 190, 170, 160, ink);
    box(670, 190, 170, 160, t > 2.2 ? accent : "#a1aa9b");
    dot(mix(290, 670, q), 270, 17, accent);
    if (t > 2.2) {
      const r = mix(10, 45, p(2.2, 0.35));
      c.strokeStyle = paper;
      c.lineWidth = 4;
      c.beginPath();
      c.arc(755, 270, r, 0, Math.PI * 2);
      c.stroke();
    }
  } else if (id === "parallax-tour") {
    const drive = mix(260, -260, p(0.7, 2.4));
    [
      [0.3, 160, 140, "#d9d2bc"],
      [0.7, 220, 180, ink],
      [1.3, 360, 80, accent],
    ].forEach(([k, y, h, col]) => {
      for (let i = -1; i < 4; i++)
        box(190 + i * 300 + drive * k, y, 230, h, col);
    });
  } else if (id === "before-after") {
    const cut = 210 + 540 * p(1, 1.7);
    box(210, 140, 540, 260, "#b6bcaf");
    for (let i = 0; i < 6; i++)
      box(
        245 + (i % 3) * 160,
        175 + Math.floor(i / 3) * 100,
        125,
        65,
        "#edf0e7",
      );
    c.save();
    c.beginPath();
    c.rect(210, 140, cut - 210, 260);
    c.clip();
    box(210, 140, 540, 260, ink);
    box(300, 200, 360, 120, accent);
    c.restore();
    line(cut, 120, cut, 420, accent, 5);
  } else if (id === "exploded-view") {
    const q = p(0.6, 0.9) * (1 - p(4.4, 0.9));
    [2, 1, 0].forEach((i) => {
      const y = 200 + (i - 1) * 105 * q;
      box(310 + (i - 1) * 48 * q, y, 340, 100, [accent, "#8c9f8e", ink][i], 6);
    });
  } else if (id === "tutorial-steps") {
    box(120,100,720,320,"#fff");
    const x=mix(160,230,p(.4,.6)), w=mix(550,450,p(.4,.6));
    box(x,190,w,85,"#eee");
    c.strokeStyle=accent; c.lineWidth=5; c.strokeRect(x,190,w,85);
    c.fillStyle=ink; c.font="30px sans-serif"; c.fillText(t<3 ? "1. Select the setting" : "2. Confirm the result",170,150);
    [0,1].forEach(i=>{c.beginPath();c.arc(465+i*30,450,7,0,Math.PI*2);c.fillStyle=(t<3?0:1)===i?accent:ink;c.fill();});
  } else if (id === "shared-shape") {
    let state = [330, 215, 300, 110, 55];
    for (const [at, next] of [
      [0.7, [170, 130, 620, 280, 20]],
      [2.3, [365, 125, 230, 290, 28]],
      [4.1, [330, 215, 300, 110, 55]],
    ]) {
      const q = p(at, 0.65);
      state = state.map((v, i) => mix(v, next[i], q));
    }
    box(...state.slice(0, 4), ink, state[4]);
  }
  c.restore();
};
