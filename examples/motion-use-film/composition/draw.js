// motion-use promo: an editing bench. Real films play as prints, the real code and the real
// tool output sit on dark cards, and one orange tape carries the eye from station to station.
window.drawFrame = function (c, t, film, view, M) {
  const { width: W, height: H } = view,
    u = M.unit,
    p = film.copy,
    d = film.data,
    k = M.palette(),
    en = p.lang === "en",
    img = (name) => window.filmAssets[name],
    tw = (at, dur, e = "cubicOut") => M.tween(t, at, dur, e);

  // ---- stations on a snaking world path; each beat lives at one ----
  const SX = 2100 * u,
    SY = 1400 * u,
    st = {
      A: [W / 2, H / 2],
      B: [W / 2 + SX, H / 2],
      L: [W / 2 + 2 * SX, H / 2],
      C: [W / 2 + 2 * SX, H / 2 + SY],
      D: [W / 2 + SX, H / 2 + SY],
      E: [W / 2, H / 2 + SY],
      F: [W / 2, H / 2 + 2 * SY],
      G: [W / 2 + SX, H / 2 + 2 * SY],
    },
    order = ["A", "B", "L", "C", "D", "E", "F", "G"],
    beats = [0, 7.4, 16.35, 22.75, 31.2, 37.0, 46.4, 54.0];

  const whip = (at, s, z = 1, dur = 0.75) => ({ at: at - 0.3, kind: "to", x: st[s][0], y: st[s][1], z, dur, ease: "expoInOut" });
  const nudge = (at, x, y, z, dur = 0.5) => ({ at, kind: "to", x, y, z, dur, ease: "cubicInOut" });
  const A = st.A, B = st.B, L = st.L, C = st.C, D = st.D, E = st.E, F = st.F, G = st.G;
  const camera = [
    { at: 0, kind: "to", x: A[0], y: A[1] + 20 * u, z: 1.06, dur: 4.0, ease: "sineInOut" },
    nudge(4.4, A[0] - 300 * u, A[1] - 40 * u, 1.16, 0.6),
    nudge(6.0, A[0], A[1] + 30 * u, 1, 0.5),
    whip(7.4, "B"),
    nudge(10.4, B[0] + 40 * u, B[1] - 40 * u, 1.05, 0.55),
    nudge(12.2, B[0], B[1] + 50 * u, 1.0, 0.55),
    whip(16.35, "L"),
    nudge(20.0, L[0], L[1] + 50 * u, 1.04, 0.5),
    whip(22.75, "C"),
    nudge(26.4, C[0] - 60 * u, C[1], 1.06, 0.5),
    whip(31.2, "D"),
    nudge(33.6, D[0] - 120 * u, D[1] - 30 * u, 1.06, 0.55),
    whip(37.0, "E"),
    nudge(38.5, E[0] - 20 * u, E[1] - 20 * u, 1.05, 0.5),
    nudge(41.0, E[0] + 20 * u, E[1], 1.04, 0.55),
    nudge(43.6, E[0], E[1], 1, 0.5),
    whip(46.4, "F"),
    whip(54.0, "G"),
    { at: 54.0 + 0.5, kind: "slam" },
  ];

  // Paper in screen space; the dot grid lives in the world so whips read as travel.
  M.paper(c);

  // ---- helpers ----
  // Each clip in film.json runs until its station has left the frame, so no print goes empty.
  const frameOf = (name) => M.video(name, t);
  // A print: a crop of a footage frame (or an image) with a black border and a soft shadow.
  function print(src, crop, x, y, w, h, { rot = 0, alpha = 1, border = 9 * u } = {}) {
    if (alpha <= 0) return;
    c.save();
    c.globalAlpha *= alpha;
    c.translate(x, y);
    c.rotate(rot);
    c.shadowColor = "rgba(23,20,15,0.28)";
    c.shadowBlur = 34 * u;
    c.shadowOffsetY = 16 * u;
    c.fillStyle = k.ink;
    c.fillRect(-w / 2 - border, -h / 2 - border, w + 2 * border, h + 2 * border);
    c.shadowColor = "transparent";
    if (src) {
      const [sx, sy, sw, sh, fw] = crop;
      const s = src.width / fw;
      c.drawImage(src, sx * s, sy * s, sw * s, sh * s, -w / 2, -h / 2, w, h);
    } else {
      c.fillStyle = k.surface;
      c.fillRect(-w / 2, -h / 2, w, h);
    }
    c.restore();
  }
  function cardDark(x, y, w, h, title) {
    c.save();
    c.shadowColor = "rgba(23,20,15,0.3)";
    c.shadowBlur = 40 * u;
    c.shadowOffsetY = 18 * u;
    M.round(c, x, y, w, h, 22 * u, k.surface);
    c.restore();
    ["#FF5F57", "#FEBC2E", "#28C840"].forEach((col, i) => {
      c.fillStyle = col;
      c.beginPath();
      c.arc(x + 32 * u + i * 26 * u, y + 30 * u, 7.5 * u, 0, Math.PI * 2);
      c.fill();
    });
    if (title) M.text(c, title, x + w / 2, y + 31 * u, 22 * u, k.sub, 500, "center", w - 220 * u, true);
  }
  const typed = (s, at, cps = 55) => s.slice(0, Math.max(0, Math.min(s.length, Math.floor((t - at) * cps))));
  function label(text, x, y, size, color = k.ink, weight = 800, align = "center", maxW = 900 * u, at = -1) {
    const a = at < 0 ? 1 : tw(at, 0.35);
    if (a <= 0) return;
    c.save();
    c.globalAlpha *= a;
    M.text(c, text, x, y + (1 - a) * 18 * u, size, color, weight, align, maxW);
    c.restore();
  }
  function light(x, y, on, text) {
    const g = M.clamp(on);
    c.save();
    c.fillStyle = g > 0 ? k.accent2 : "rgba(23,20,15,0.12)";
    c.beginPath();
    c.arc(x, y, 30 * u * (1 + 0.3 * Math.sin(Math.PI * g)), 0, Math.PI * 2);
    c.fill();
    if (g > 0) {
      c.strokeStyle = k.surface;
      c.lineWidth = 6 * u;
      c.lineCap = "round";
      c.beginPath();
      c.moveTo(x - 12 * u, y + 1 * u);
      c.lineTo(x - 3 * u, y + 10 * u);
      c.lineTo(x + 14 * u, y - 10 * u);
      c.stroke();
    }
    c.restore();
    M.text(c, text, x + 56 * u, y, 38 * u, k.ink, 800, "left", 420 * u);
  }

  if (view.vertical) return drawVertical();

  // ---- the world ----
  M.shoot(c, t, camera, (cam) => {
    // Dot grid around the visible area.
    const vw = W / cam.z / 2 + 120 * u,
      vh = H / cam.z / 2 + 120 * u,
      gs = 90 * u;
    c.fillStyle = "rgba(23,20,15,0.13)";
    for (let gx = Math.floor((cam.x - vw) / gs) * gs; gx < cam.x + vw; gx += gs)
      for (let gy = Math.floor((cam.y - vh) / gs) * gs; gy < cam.y + vh; gy += gs) c.fillRect(gx - 2 * u, gy - 2 * u, 4 * u, 4 * u);

    // The tape runs under each station and turns outside the frame between rows, so it never
    // crosses a station's content. Its head arrives under each station as that beat begins.
    const ty = 495 * u,
      turn = 1010 * u,
      way = [
        [A[0] - 1300 * u, A[1] + ty],
        [L[0] + turn, L[1] + ty],
        [C[0] + turn, C[1] + ty],
        [E[0] - turn, E[1] + ty],
        [F[0] - turn, F[1] + ty],
        [G[0] + 1400 * u, G[1] + ty],
      ],
      cum = [0];
    for (let i = 1; i < way.length; i++) cum.push(cum[i - 1] + Math.hypot(way[i][0] - way[i - 1][0], way[i][1] - way[i - 1][1]));
    // Arc length of the point under a station: it sits on one of the horizontal runs.
    const arcUnder = (s) => {
      const [x, y] = st[s];
      for (let i = 1; i < way.length; i++) {
        const [x0, y0] = way[i - 1], [x1, y1] = way[i];
        if (Math.abs(y0 - (y + ty)) < 1 && Math.abs(y1 - y0) < 1 && (x - x0) * (x - x1) <= 0) return cum[i - 1] + Math.abs(x - x0);
      }
      return 0;
    };
    let head = arcUnder("A") + 900 * u;
    for (let i = 1; i < order.length; i++) {
      const f = M.easings.cubicInOut(M.clamp((t - (beats[i] - 0.45)) / 0.8));
      head = M.mix(head, arcUnder(order[i]) + 900 * u, f);
    }
    c.save();
    c.lineCap = "round";
    c.lineJoin = "round";
    const path = () => {
      c.beginPath();
      c.moveTo(way[0][0], way[0][1]);
      for (let i = 1; i < way.length; i++) {
        if (head >= cum[i]) {
          c.lineTo(way[i][0], way[i][1]);
          continue;
        }
        const f = (head - cum[i - 1]) / (cum[i] - cum[i - 1]);
        c.lineTo(M.mix(way[i - 1][0], way[i][0], f), M.mix(way[i - 1][1], way[i][1], f));
        break;
      }
    };
    path();
    c.strokeStyle = k.accent;
    c.lineWidth = 30 * u;
    c.stroke();
    path();
    c.setLineDash([16 * u, 26 * u]);
    c.lineDashOffset = -t * 120 * u;
    c.strokeStyle = k.bg;
    c.lineWidth = 7 * u;
    c.stroke();
    c.restore();

    // --- A: six real films on the bench ---
    if (t < 9) {
      const wall = frameOf("wall"),
        tWd = 470 * u,
        tHt = tWd * 9 / 16,
        gap = 34 * u;
      // Already laid out on frame 0 (the cover); the camera pulls back from the iPhone film.
      for (let i = 0; i < 6; i++) {
        const col = i % 3,
          row = Math.floor(i / 3),
          x = A[0] + (col - 1) * (tWd + gap),
          y = A[1] + 30 * u + (row - 0.5) * (tHt + gap),
          rot = (i % 2 ? 0.008 : -0.008) * Math.cos(t * 0.6 + i);
        print(wall, [col * 960, row * 540, 960, 540, 2880], x, y, tWd, tHt, { rot });
      }
    }

    // --- B: the code and the film it draws ---
    if (t > 6.6 && t < 17.2) {
      const cx = B[0], cy = B[1];
      cardDark(cx - 880 * u, cy - 380 * u, 820 * u, 470 * u, "composition/draw.js");
      d.code.forEach((line, i) => {
        const at = 7.9 + i * 0.32;
        if (t < at) return;
        M.text(c, typed(line, at, 90), cx - 850 * u, cy - 300 * u + i * 52 * u, 25 * u, i === 0 ? k.accent : "#E9E3D6", 500, "left", 780 * u, true);
      });
      // The film this code draws, playing; the counter is its own clock.
      const ip = frameOf("ip"),
        half = p.lang === "zh" ? 0 : 960,
        fx = cx + 470 * u,
        fy = cy - 110 * u,
        enter = tw(7.7, 0.6, "backOut");
      print(ip, [half, 0, 960, 540, 1920], fx, fy + (1 - enter) * 60 * u, 760 * u, 427.5 * u, { alpha: enter });
      const ft = 5 + Math.min(9.48, Math.max(0, t - 7.4)); // the clip starts at source 5 s
      M.round(c, fx - 380 * u, fy + 236 * u, 760 * u, 10 * u, 5 * u, "rgba(23,20,15,0.15)");
      M.round(c, fx - 380 * u, fy + 236 * u, (760 * u * ft) / 55.5 + 10 * u, 10 * u, 5 * u, k.accent);
      M.text(c, `t = ${ft.toFixed(2)} s`, fx - 380 * u, fy - 262 * u, 34 * u, k.ink, 700, "left", 400 * u, true);
      label(p.fnTitle, fx + 380 * u, fy - 262 * u, 34 * u, k.accent, 800, "right", 380 * u, 8.2);
      // Source size against the MP4 it makes, to scale.
      if (t > 11.2) {
        const bx = cx - 840 * u, by = cy + 180 * u, full = 1460 * u, mp4 = d.mp4MB * 1e6,
          src = d.drawBytes + d.filmBytes,
          g1 = tw(11.4, 0.9), g2 = tw(12.0, 1.1, "expoOut");
        label(`${p.src}  draw.js + film.json`, bx, by - 34 * u, 28 * u, k.sub, 700, "left", 900 * u, 11.3);
        M.round(c, bx, by, Math.max(8 * u, (full * src * g1) / mp4), 34 * u, 6 * u, k.accent);
        M.counter(c, t, [bx + 30 * u, by + 17 * u], { value: Math.round(src / 1000), from: 0, at: 11.4, dur: 0.9, suffix: " KB", align: "left", size: 34 * u, color: k.ink });
        label(`${p.mp4}  ${p.film55}`, bx, by + 82 * u, 28 * u, k.sub, 700, "left", 900 * u, 11.9);
        M.round(c, bx, by + 116 * u, full * g2, 34 * u, 6 * u, k.ink);
        if (g2 > 0.6) M.text(c, `${d.mp4MB} MB`, bx + full * g2 + 20 * u, by + 133 * u, 34 * u, k.ink, 800, "left", 300 * u);
        label(p.notTimeline, cx + 850 * u, by + 82 * u, 40 * u, k.accent, 900, "right", 700 * u, 14.0);
      }
    }

    // --- L: four films, four looks ---
    if (t > 15.6 && t < 23.6) {
      const wall = frameOf("wall"),
        tiles = [[0, 0, p.lYarn], [1, 1, p.lBoard], [2, 1, p.lKinetic], [0, 1, p.lData]],
        tWd = 400 * u, tHt = tWd * 9 / 16, gap = 34 * u;
      tiles.forEach(([col, row, name], i) => {
        const a = tw(16.4 + i * 0.22, 0.6, "expoOut"),
          x = L[0] + (i - 1.5) * (tWd + gap) + (1 - a) * 900 * u,
          y = L[1] - 60 * u,
          rot = (1 - a) * 0.12 + (i % 2 ? 0.01 : -0.01);
        print(wall, [col * 960, row * 540, 960, 540, 2880], x, y, tWd, tHt, { rot, alpha: M.clamp(a * 2) });
        label(name, x, y + tHt / 2 + 52 * u, 40 * u, k.ink, 900, "center", tWd, 17.4 + i * 0.35);
      });
      label(p.noTpl, L[0], L[1] + 250 * u, 34 * u, k.sub, 700, "center", 1400 * u, 20.0);
    }

    // --- C: the real verify output ---
    if (t > 22.0 && t < 32.0) {
      const cx = C[0] - 220 * u, cy = C[1];
      cardDark(cx - 640 * u, cy - 320 * u, 1180 * u, 560 * u, `${p.real} · motion-use 0.6.0`);
      const times = d.verify.map((_, i) => 23.3 + i * 0.85);
      d.verify.forEach((line, i) => {
        if (t < times[i]) return;
        const green = / green$/.test(line);
        M.text(c, typed(line, times[i], 70), cx - 600 * u, cy - 240 * u + i * 66 * u, 30 * u, i === 0 ? k.accent : green ? "#5FD08D" : "#E9E3D6", i === 0 ? 700 : 500, "left", 1110 * u, true);
      });
      const lx = C[0] + 470 * u;
      light(lx, cy - 170 * u, (t - times[3] - 0.4) * 3, p.lMotion);
      light(lx, cy, (t - times[2] - 0.4) * 3, p.lLoud);
      light(lx, cy + 170 * u, (t - times[4] - 0.4) * 3, p.lBlank);
    }

    // --- D: the vertical safe area, a real still --guides frame ---
    if (t > 30.4 && t < 38) {
      const g = img("guides"),
        h = 660 * u, w = h * 1080 / 1920,
        a = tw(31.3, 0.7, "expoOut"),
        x = D[0] - 300 * u, y = D[1] - 60 * u + (1 - a) * 300 * u;
      print(g, [0, 0, 1080, 1920, 1080], x, y, w, h, { alpha: M.clamp(a * 2) });
      // A scan line checks the frame top to bottom.
      const s = M.clamp((t - 32.2) / 2.2);
      if (s > 0 && s < 1) {
        c.fillStyle = k.accent;
        c.fillRect(x - w / 2 - 20 * u, y - h / 2 + h * s - 3 * u, w + 40 * u, 6 * u);
      }
      label(p.safe, D[0] - 20 * u, D[1] - 110 * u, 66 * u, k.ink, 900, "left", 700 * u, 31.8);
      c.fillStyle = "rgba(200,30,30,0.55)";
      if (t > 32.6) c.fillRect(D[0] - 20 * u, D[1] - 10 * u, 44 * u, 44 * u);
      label(p.safeNote, D[0] + 44 * u, D[1] + 12 * u, 36 * u, k.ink, 700, "left", 640 * u, 32.6);
    }

    // --- E: two real defects from the last film ---
    if (t > 36.2 && t < 47.2) {
      const cx = E[0] - 470 * u, cy = E[1] - 60 * u,
        w = 760 * u, h = w * 620 / 1040,
        flip = M.clamp((t - 42.4) / 0.5),
        sx = Math.abs(Math.cos(Math.PI * flip)),
        showAfter = flip > 0.5;
      c.save();
      c.translate(cx, cy);
      c.scale(Math.max(0.02, sx), 1);
      print(img(showAfter ? "clipAfter" : "clipBefore"), [0, 0, 1040, 620, 1040], 0, 0, w, h);
      c.restore();
      // The crop's right edge is the frame edge: box the callout that runs past it.
      if (!showAfter && t > 38.6) {
        const b = tw(38.6, 0.4, "backOut");
        c.save();
        c.strokeStyle = k.accent;
        c.lineWidth = 7 * u;
        c.strokeRect(cx - 0.05 * w, cy - 0.005 * h, 0.58 * w * b, 0.165 * h);
        c.restore();
      }
      label("✕ " + p.cClip, cx, cy - h / 2 - 44 * u, 40 * u, k.accent, 900, "center", 700 * u, 38.8);
      label(showAfter ? "✓ " + p.after : p.before, cx - w / 2, cy + h / 2 + 50 * u, 34 * u, showAfter ? k.accent2 : k.sub, 800, "left", 400 * u);
      // The voiceover check: what the script said, what the voice was heard saying, the fix.
      const ax = E[0] + 10 * u, ay = cy - h / 2, aw = 820 * u;
      cardDark(ax, ay, aw, en ? 560 * u : 470 * u, `${p.real} · motion-use 0.7.0`);
      label("✕ " + p.cAsr, ax + aw / 2, ay - 44 * u, 40 * u, k.accent, 900, "center", 700 * u, 39.6);
      d.asr.forEach((row, i) => {
        const at = 40.0 + i * 1.3, yy = ay + 100 * u + i * (en ? 220 : 175) * u;
        if (t < at) return;
        M.text(c, `${p.script}  ${row.script}`, ax + 36 * u, yy, 30 * u, "#E9E3D6", 500, "left", aw - 72 * u, true);
        if (t > at + 0.45) M.text(c, `${p.heard}  ${row.heard}`, ax + 36 * u, yy + 52 * u, 30 * u, "#FF8A5C", 700, "left", aw - 72 * u, true);
        if (t > at + 0.45 && en) M.text(c, `        ${row.note.en}`, ax + 36 * u, yy + 96 * u, 26 * u, "#BDB5A6", 500, "left", aw - 72 * u, true);
        if (t > at + 0.9) M.text(c, `${p.fixedTo}  ${row.fixed[p.lang]}`, ax + 36 * u, yy + (en ? 146 : 104) * u, 30 * u, "#5FD08D", 700, "left", aw - 72 * u, true);
      });
    }

    // --- F: one source, four real cuts ---
    if (t > 45.6 && t < 55) {
      const f = frameOf("formats"),
        s = tw(47.0, 0.9, "expoInOut"),
        fy = F[1] - 60 * u,
        lw = M.mix(1000 * u, 520 * u, s), lh = lw * 9 / 16,
        lx = M.mix(F[0], F[0] - 520 * u, s),
        vh = 2 * 292.5 * u + 34 * u, vw = vh * 608 / 1080,
        v1 = F[0] + 130 * u + vw / 2, v2 = v1 + vw + 50 * u;
      print(f, [0, 0, 960, 540, 2176], lx, M.mix(fy, fy - (lh / 2 + 17 * u), s), lw, lh);
      if (s > 0) {
        print(f, [0, 540, 960, 540, 2176], lx, fy + (lh / 2 + 17 * u), lw, lh, { alpha: s });
        print(f, [960, 0, 608, 1080, 2176], v1 + (1 - s) * 300 * u, fy, vw, vh, { alpha: s });
        print(f, [1568, 0, 608, 1080, 2176], v2 + (1 - s) * 500 * u, fy, vw, vh, { alpha: s });
        const ly = fy + vh / 2 + 44 * u;
        label(`${p.fZh} / ${p.fEn} · ${p.fL}`, lx, ly, 30 * u, k.sub, 800, "center", 700 * u, 48.0);
        label(`${p.fZh} · ${p.fV}`, v1, ly, 30 * u, k.sub, 800, "center", vw + 40 * u, 48.3);
        label(`${p.fEn} · ${p.fV}`, v2, ly, 30 * u, k.sub, 800, "center", vw + 40 * u, 48.5);
        label(p.masters, v2 + vw / 2, fy - vh / 2 - 44 * u, 36 * u, k.accent, 900, "right", 1000 * u, 50.0);
      }
    }

    // --- G: the name, written on the bench ---
    if (t > 53.4) {
      const a = tw(53.95, 0.5, "backOut");
      c.save();
      c.globalAlpha = M.clamp(a * 1.5);
      M.text(c, p.brand, G[0], G[1] - 150 * u, 168 * u * (0.9 + 0.1 * a), k.ink, 900, "center", 1500 * u);
      c.restore();
      M.stroke(c, t, [[G[0] - 420 * u, G[1] - 50 * u], [G[0] + 420 * u, G[1] - 64 * u]], { at: 54.7, dur: 0.6, width: 14 * u, color: k.accent });
      label(p.promise, G[0], G[1] + 30 * u, 48 * u, k.ink, 800, "center", 1400 * u, 55.0);
      const pa = tw(55.6, 0.4);
      if (pa > 0) {
        c.save();
        c.globalAlpha = pa;
        M.round(c, G[0] - 760 * u, G[1] + 110 * u, 1520 * u, 84 * u, 16 * u, k.surface);
        M.text(c, typed(d.install, 55.8, 110), G[0] - 730 * u, G[1] + 152 * u, 28 * u, "#E9E3D6", 500, "left", 1460 * u, true);
        c.restore();
      }
      label(`${d.repo}  ·  ${p.oss}`, G[0], G[1] + 250 * u, 32 * u, k.sub, 700, "center", 1500 * u, 56.4);
    }
  });

  // ---- screen-space titles: the point first, then one per beat ----
  const head = (text, at, until, color = k.ink) => M.caption(c, t, text, at, until, { x: 0.05, align: "left", y: 0.1, size: 60 * u, color, weight: 900, maxWidth: W * 0.62 });
  if (t < 7.2) {
    const a = 1;
    c.save();
    c.globalAlpha = a;
    c.fillStyle = k.bg;
    c.fillRect(0, 0, W, 200 * u * a);
    M.text(c, p.hook1 + " ", W / 2 - 18 * u, 92 * u, 84 * u, k.ink, 900, "right", W * 0.6);
    M.text(c, p.hook2, W / 2 + 0 * u, 92 * u, 84 * u, k.accent, 900, "left", W * 0.4);
    c.restore();
    label(p.hookSub, W / 2, 162 * u, 34 * u, k.sub, 700, "center", W * 0.8);
  }
  head(p.looks, 16.6, 22.4);
  head(p.local, 23.0, 30.9);
  head(p.catch, 43.6, 46.2);
  head(p.formats, 46.7, 53.7);
  M.captions(c, t, undefined, { lines: 2 });
  M.vignette(c);

  // ---- portrait: the same bench and timing, each station stacked inside view.safe ----
  // Platform UI covers the top, the bottom quarter and a right-hand column, so every word and
  // every print sits in the safe box; only the tape runs low, under the author row.
  function drawVertical() {
    const SXv = 1500 * u,
      SYv = 2300 * u,
      sv = {
        A: [W / 2, H / 2],
        B: [W / 2 + SXv, H / 2],
        L: [W / 2 + 2 * SXv, H / 2],
        C: [W / 2 + 2 * SXv, H / 2 + SYv],
        D: [W / 2 + SXv, H / 2 + SYv],
        E: [W / 2, H / 2 + SYv],
        F: [W / 2, H / 2 + 2 * SYv],
        G: [W / 2 + SXv, H / 2 + 2 * SYv],
      };
    // Design coordinates on the 1080×1920 frame, placed at a station.
    const at = (s, x, y) => [sv[s][0] + (x - 540) * u, sv[s][1] + (y - 960) * u];
    const wv = (time, s, z = 1, dur = 0.75) => ({ at: time - 0.3, kind: "to", x: sv[s][0], y: sv[s][1], z, dur, ease: "expoInOut" });
    const nv = (time, s, dx, dy, z, dur = 0.5) => ({ at: time, kind: "to", x: sv[s][0] + dx * u, y: sv[s][1] + dy * u, z, dur, ease: "cubicInOut" });
    const camV = [
      { at: 0, kind: "to", x: sv.A[0], y: sv.A[1] + 10 * u, z: 1.04, dur: 4.0, ease: "sineInOut" },
      nv(4.4, "A", 0, -10, 1.05, 0.6),
      nv(6.0, "A", 0, 10, 1),
      wv(7.4, "B"),
      nv(10.4, "B", 0, -20, 1.02, 0.55),
      nv(12.2, "B", 0, 20, 1.0, 0.55),
      wv(16.35, "L"),
      nv(20.0, "L", 0, 20, 1.02),
      wv(22.75, "C"),
      nv(26.4, "C", 0, 0, 1.02),
      wv(31.2, "D"),
      nv(33.6, "D", 0, -10, 1.03, 0.55),
      wv(37.0, "E"),
      nv(38.5, "E", 0, -10, 1.02),
      nv(41.0, "E", 0, 0, 1.02, 0.55),
      nv(43.6, "E", 0, 0, 1),
      wv(46.4, "F"),
      wv(54.0, "G"),
      { at: 54.5, kind: "slam" },
    ];
    const ordV = ["A", "B", "L", "C", "D", "E", "F", "G"];
    // Each station's words fade out just before the whip leaves and fade in as it lands, so no
    // text is carried through the platform's covered zones by the camera.
    const stage = (i, draw) => {
      const fin = i === 0 ? 1 : tw(beats[i] + 0.05, 0.25),
        fout = i === 7 ? 1 : 1 - tw(beats[i + 1] - 0.42, 0.22),
        a = Math.min(fin, fout);
      if (a <= 0) return;
      c.save();
      c.globalAlpha *= a;
      draw();
      c.restore();
    };

    M.paper(c);
    M.shoot(c, t, camV, (cam) => {
      const vw = W / cam.z / 2 + 120 * u,
        vh = H / cam.z / 2 + 120 * u,
        gs = 90 * u;
      c.fillStyle = "rgba(23,20,15,0.13)";
      for (let gx = Math.floor((cam.x - vw) / gs) * gs; gx < cam.x + vw; gx += gs)
        for (let gy = Math.floor((cam.y - vh) / gs) * gs; gy < cam.y + vh; gy += gs) c.fillRect(gx - 2 * u, gy - 2 * u, 4 * u, 4 * u);

      // The tape runs low (under the platform's author row) and turns outside the frame.
      const ty = 580 * u,
        turn = 760 * u,
        way = [
          [sv.A[0] - 900 * u, sv.A[1] + ty],
          [sv.L[0] + turn, sv.L[1] + ty],
          [sv.C[0] + turn, sv.C[1] + ty],
          [sv.E[0] - turn, sv.E[1] + ty],
          [sv.F[0] - turn, sv.F[1] + ty],
          [sv.G[0] + 1000 * u, sv.G[1] + ty],
        ],
        cum = [0];
      for (let i = 1; i < way.length; i++) cum.push(cum[i - 1] + Math.hypot(way[i][0] - way[i - 1][0], way[i][1] - way[i - 1][1]));
      const arcUnder = (s) => {
        const [x, y] = sv[s];
        for (let i = 1; i < way.length; i++) {
          const [x0, y0] = way[i - 1], [x1, y1] = way[i];
          if (Math.abs(y0 - (y + ty)) < 1 && Math.abs(y1 - y0) < 1 && (x - x0) * (x - x1) <= 0) return cum[i - 1] + Math.abs(x - x0);
        }
        return 0;
      };
      let head = arcUnder("A") + 700 * u;
      for (let i = 1; i < ordV.length; i++) {
        const f = M.easings.cubicInOut(M.clamp((t - (beats[i] - 0.45)) / 0.8));
        head = M.mix(head, arcUnder(ordV[i]) + 700 * u, f);
      }
      c.save();
      c.lineCap = "round";
      c.lineJoin = "round";
      const path = () => {
        c.beginPath();
        c.moveTo(way[0][0], way[0][1]);
        for (let i = 1; i < way.length; i++) {
          if (head >= cum[i]) {
            c.lineTo(way[i][0], way[i][1]);
            continue;
          }
          const f = (head - cum[i - 1]) / (cum[i] - cum[i - 1]);
          c.lineTo(M.mix(way[i - 1][0], way[i][0], f), M.mix(way[i - 1][1], way[i][1], f));
          break;
        }
      };
      path();
      c.strokeStyle = k.accent;
      c.lineWidth = 30 * u;
      c.stroke();
      path();
      c.setLineDash([16 * u, 26 * u]);
      c.lineDashOffset = -t * 120 * u;
      c.strokeStyle = k.bg;
      c.lineWidth = 7 * u;
      c.stroke();
      c.restore();

      // --- A: six real films, two columns of three ---
      stage(0, () => {
      if (t < 9) {
        const wall = frameOf("wall"),
          tWd = 404 * u,
          tHt = tWd * 9 / 16;
        for (let i = 0; i < 6; i++) {
          const [x, y] = at("A", i % 2 ? 712 : 282, 607 + Math.floor(i / 2) * 253),
            rot = (i % 2 ? 0.008 : -0.008) * Math.cos(t * 0.6 + i);
          print(wall, [(i % 3) * 960, Math.floor(i / 3) * 540, 960, 540, 2880], x, y, tWd, tHt, { rot });
        }
      }
      });

      // --- B: the film on top, the code (then its size) below ---
      stage(1, () => {
      if (t > 6.6 && t < 17.2) {
        const ip = frameOf("ip"),
          half = p.lang === "zh" ? 0 : 960,
          [fx, fy] = at("B", 497, 545),
          enter = tw(7.7, 0.6, "backOut");
        // Cropped above the film's own subtitles, so only one subtitle track is on screen.
        print(ip, [half, 0, 960, 455, 1920], fx, fy + (1 - enter) * 60 * u, 840 * u, 398 * u, { alpha: enter });
        const ft = 5 + Math.min(9.48, Math.max(0, t - 7.4));
        M.round(c, fx - 420 * u, fy + 222 * u, 840 * u, 10 * u, 5 * u, "rgba(23,20,15,0.15)");
        M.round(c, fx - 420 * u, fy + 222 * u, (840 * u * ft) / 55.5 + 10 * u, 10 * u, 5 * u, k.accent);
        M.text(c, `t = ${ft.toFixed(2)} s`, fx - 420 * u, fy - 250 * u, 32 * u, k.ink, 700, "left", 400 * u, true);
        label(p.fnTitle, fx + 420 * u, fy - 250 * u, 32 * u, k.accent, 800, "right", 420 * u, 8.2);
        // The code card leaves before the size bars arrive in its place.
        const out = 1 - tw(10.9, 0.3);
        if (out > 0) {
          const [cx0, cy0] = at("B", 65, 850);
          c.save();
          c.globalAlpha *= out;
          cardDark(cx0, cy0, 864 * u, 340 * u, "composition/draw.js");
          d.code.forEach((line, i) => {
            const t0 = 7.9 + i * 0.32;
            if (t < t0) return;
            M.text(c, typed(line, t0, 90), cx0 + 30 * u, cy0 + 74 * u + i * 38 * u, 25 * u, i === 0 ? k.accent : "#E9E3D6", 500, "left", 810 * u, true);
          });
          c.restore();
        }
        if (t > 11.2) {
          const [bx, by] = at("B", 92, 900), full = 820 * u, mp4 = d.mp4MB * 1e6,
            src = d.drawBytes + d.filmBytes,
            g1 = tw(11.4, 0.9), g2 = tw(12.0, 1.1, "expoOut");
          label(`${p.src}  draw.js + film.json`, bx, by - 34 * u, 28 * u, k.sub, 700, "left", 840 * u, 11.3);
          M.round(c, bx, by, Math.max(8 * u, (full * src * g1) / mp4), 34 * u, 6 * u, k.accent);
          M.counter(c, t, [bx + 30 * u, by + 17 * u], { value: Math.round(src / 1000), from: 0, at: 11.4, dur: 0.9, suffix: " KB", align: "left", size: 32 * u, color: k.ink });
          label(`${p.mp4}  ${p.film55}`, bx, by + 82 * u, 28 * u, k.sub, 700, "left", 840 * u, 11.9);
          M.round(c, bx, by + 116 * u, full * g2, 34 * u, 6 * u, k.ink);
          if (g2 > 0.6) M.text(c, `${d.mp4MB} MB`, bx + full * g2 - 20 * u, by + 133 * u, 30 * u, k.bg, 800, "right", 300 * u);
          const [nx, ny] = at("B", 497, 1130);
          label(p.notTimeline, nx, ny, 40 * u, k.accent, 900, "center", 864 * u, 14.0);
        }
      }
      });

      // --- L: four films, four looks, two by two ---
      stage(2, () => {
      if (t > 15.6 && t < 23.6) {
        const wall = frameOf("wall"),
          tiles = [[0, 0, p.lYarn], [1, 1, p.lBoard], [2, 1, p.lKinetic], [0, 1, p.lData]],
          tWd = 404 * u, tHt = tWd * 9 / 16;
        tiles.forEach(([col, row, name], i) => {
          const a = tw(16.4 + i * 0.22, 0.6, "expoOut"),
            [x0, y] = at("L", i % 2 ? 712 : 282, i < 2 ? 470 : 830),
            x = x0 + (1 - a) * 700 * u,
            rot = (1 - a) * 0.12 + (i % 2 ? 0.01 : -0.01);
          print(wall, [col * 960, row * 540, 960, 540, 2880], x, y, tWd, tHt, { rot, alpha: M.clamp(a * 2) });
          label(name, x, y + tHt / 2 + 46 * u, 38 * u, k.ink, 900, "center", tWd, 17.4 + i * 0.35);
        });
        const [nx, ny] = at("L", 497, 1110);
        label(p.noTpl, nx, ny, 32 * u, k.sub, 700, "center", 864 * u, 20.0);
      }
      });

      // --- C: the real verify output, lights below ---
      stage(3, () => {
      if (t > 22.0 && t < 32.0) {
        const [cx0, cy0] = at("C", 75, 330);
        cardDark(cx0, cy0, 840 * u, 490 * u, `${p.real} · motion-use 0.6.0`);
        const times = d.verify.map((_, i) => 23.3 + i * 0.85);
        d.verify.forEach((line, i) => {
          if (t < times[i]) return;
          const green = / green$/.test(line);
          M.text(c, typed(line, times[i], 70), cx0 + 30 * u, cy0 + 80 * u + i * 58 * u, 28 * u, i === 0 ? k.accent : green ? "#5FD08D" : "#E9E3D6", i === 0 ? 700 : 500, "left", 790 * u, true);
        });
        const [lx, ly] = at("C", 140, 900);
        // Lights wait for the whip to land, so their labels never cross the subtitles.
        const la = tw(23.1, 0.3);
        if (la > 0) {
          c.save();
          c.globalAlpha *= la;
          light(lx, ly, (t - times[3] - 0.4) * 3, p.lMotion);
          light(lx, ly + 110 * u, (t - times[2] - 0.4) * 3, p.lLoud);
          light(lx, ly + 220 * u, (t - times[4] - 0.4) * 3, p.lBlank);
          c.restore();
        }
      }
      });

      // --- D: the vertical safe area, a real still --guides frame ---
      stage(4, () => {
      if (t > 30.4 && t < 38) {
        const g = img("guides"),
          h = 680 * u, w = h * 1080 / 1920,
          a = tw(31.3, 0.7, "expoOut"),
          [x, y0] = at("D", 497, 730),
          y = y0 + (1 - a) * 300 * u;
        print(g, [0, 0, 1080, 1920, 1080], x, y, w, h, { alpha: M.clamp(a * 2) });
        const s = M.clamp((t - 32.2) / 2.2);
        if (s > 0 && s < 1) {
          c.fillStyle = k.accent;
          c.fillRect(x - w / 2 - 20 * u, y - h / 2 + h * s - 3 * u, w + 40 * u, 6 * u);
        }
        const [tx, tyy] = at("D", 497, 300);
        label(p.safe, tx, tyy, 60 * u, k.ink, 900, "center", 864 * u, 31.8);
        const [rx, ry] = at("D", 120, 1140);
        c.fillStyle = "rgba(200,30,30,0.55)";
        if (t > 32.6) c.fillRect(rx, ry - 22 * u, 44 * u, 44 * u);
        label(p.safeNote, rx + 62 * u, ry, 32 * u, k.ink, 700, "left", 740 * u, 32.6);
      }
      });

      // --- E: the clipped callout on top, the voiceover check below ---
      stage(5, () => {
      if (t > 36.2 && t < 47.2) {
        const [cx, cy] = at("E", 497, 480),
          w = 700 * u, h = w * 620 / 1040,
          flip = M.clamp((t - 42.4) / 0.5),
          showAfter = flip > 0.5;
        // Before fades out, then after fades in (a flip hid the comparison; a dissolve muddled
        // the two callouts together).
        const outB = 1 - M.clamp((t - 42.4) / 0.2), inA = M.clamp((t - 42.6) / 0.2);
        if (outB > 0) print(img("clipBefore"), [0, 0, 1040, 620, 1040], cx, cy, w, h, { alpha: outB });
        if (inA > 0) print(img("clipAfter"), [0, 0, 1040, 620, 1040], cx, cy, w, h, { alpha: inA });
        if (t < 42.4 && t > 38.6) {
          const b = tw(38.6, 0.4, "backOut");
          c.save();
          c.strokeStyle = k.accent;
          c.lineWidth = 7 * u;
          c.strokeRect(cx - 0.05 * w, cy - 0.005 * h, 0.58 * w * b, 0.165 * h);
          c.restore();
        }
        if (!showAfter) label("✕ " + p.cClip, cx, cy - h / 2 - 36 * u, 40 * u, k.accent, 900, "center", 864 * u, 38.8);
        label(showAfter ? "✓ " + p.after : p.before, cx - w / 2, cy + h / 2 + 34 * u, 32 * u, showAfter ? k.accent2 : k.sub, 800, "left", 400 * u);
        const [ax, ay] = at("E", 65, 805), aw = 864 * u;
        label("✕ " + p.cAsr, ax + aw / 2, ay - 36 * u, 38 * u, k.accent, 900, "center", 864 * u, 39.6);
        cardDark(ax, ay, aw, (en ? 425 : 395) * u, `${p.real} · motion-use 0.7.0`);
        const fs = (en ? 26 : 28) * u;
        d.asr.forEach((row, i) => {
          const t0 = 40.0 + i * 1.3, yy = ay + 100 * u + i * (en ? 165 : 160) * u;
          if (t < t0) return;
          M.text(c, `${p.script}  ${row.script}`, ax + 30 * u, yy, fs, "#E9E3D6", 500, "left", aw - 60 * u, true);
          if (t > t0 + 0.45) M.text(c, `${p.heard}  ${row.heard}`, ax + 30 * u, yy + (en ? 46 : 52) * u, fs, "#FF8A5C", 700, "left", aw - 60 * u, true);
          if (t > t0 + 0.45 && en) M.text(c, `        ${row.note.en}`, ax + 30 * u, yy + 86 * u, 24 * u, "#BDB5A6", 500, "left", aw - 60 * u, true);
          if (t > t0 + 0.9) M.text(c, `${p.fixedTo}  ${row.fixed[p.lang]}`, ax + 30 * u, yy + (en ? 128 : 104) * u, fs, "#5FD08D", 700, "left", aw - 60 * u, true);
        });
      }
      });

      // --- F: one source opens into four real cuts ---
      stage(6, () => {
      if (t > 45.6 && t < 55) {
        const f = frameOf("formats"),
          s = tw(47.0, 0.9, "expoInOut"),
          [c0x, c0y] = at("F", 497, 640),
          [lAx, lAy] = at("F", 282, 410),
          [lBx] = at("F", 712, 410),
          lw = M.mix(840 * u, 404 * u, s), lh = lw * 9 / 16;
        print(f, [0, 0, 960, 455, 2176], M.mix(c0x, lAx, s), M.mix(c0y, lAy, s), lw, lw * 455 / 960);
        if (s > 0) {
          const vh = 520 * u, vw = vh * 608 / 760,
            [v1, vy] = at("F", 285, 865),
            [v2] = at("F", 709, 865);
          print(f, [0, 540, 960, 455, 2176], lBx + (1 - s) * 300 * u, lAy, 404 * u, 191.5 * u, { alpha: s });
          print(f, [960, 0, 608, 760, 2176], v1, vy + (1 - s) * 400 * u, vw, vh, { alpha: s });
          print(f, [1568, 0, 608, 760, 2176], v2, vy + (1 - s) * 500 * u, vw, vh, { alpha: s });
          const ly = lAy + 95.8 * u + 38 * u, vly = vy + vh / 2 + 38 * u;
          label(`${p.fZh} · ${p.fL}`, lAx, ly, 28 * u, k.sub, 800, "center", 404 * u, 48.0);
          label(`${p.fEn} · ${p.fL}`, lBx, ly, 28 * u, k.sub, 800, "center", 404 * u, 48.1);
          label(`${p.fZh} · ${p.fV}`, v1, vly, 28 * u, k.sub, 800, "center", vw + 20 * u, 48.3);
          label(`${p.fEn} · ${p.fV}`, v2, vly, 28 * u, k.sub, 800, "center", vw + 20 * u, 48.5);
          const [mx, my] = at("F", 497, 1210);
          label(p.masters, mx, my, 34 * u, k.accent, 900, "center", 864 * u, 50.0);
        }
      }
      });

      // --- G: the name, then the install command on three lines ---
      stage(7, () => {
      if (t > 53.4) {
        const [gx, gy] = at("G", 497, 560),
          a = tw(53.95, 0.5, "backOut");
        c.save();
        c.globalAlpha *= M.clamp(a * 1.5);
        M.text(c, p.brand, gx, gy, 140 * u * (0.9 + 0.1 * a), k.ink, 900, "center", 864 * u);
        c.restore();
        M.stroke(c, t, [[gx - 330 * u, gy + 92 * u], [gx + 330 * u, gy + 80 * u]], { at: 54.7, dur: 0.6, width: 14 * u, color: k.accent });
        label(p.promise, gx, gy + 180 * u, 44 * u, k.ink, 800, "center", 864 * u, 55.0);
        const pa = tw(55.6, 0.4);
        if (pa > 0) {
          // film.json's install command broken after the host and before the pipe.
          const s1 = d.install.indexOf("leeguooooo"), s2 = d.install.indexOf(" | sh"),
            parts = [d.install.slice(0, s1), d.install.slice(s1, s2), d.install.slice(s2 + 1)],
            [bx, by] = at("G", 65, 800);
          c.save();
          c.globalAlpha *= pa;
          M.round(c, bx, by, 864 * u, 170 * u, 16 * u, k.surface);
          let t0 = 55.8;
          parts.forEach((line, i) => {
            M.text(c, typed(line, t0, 110), bx + 30 * u, by + 42 * u + i * 46 * u, 30 * u, "#E9E3D6", 500, "left", 810 * u, true);
            t0 += line.length / 110;
          });
          c.restore();
        }
        const [rx, ry] = at("G", 497, 1040);
        label(d.repo, rx, ry, 34 * u, k.ink, 800, "center", 864 * u, 56.4);
        label(p.oss, rx, ry + 52 * u, 32 * u, k.sub, 700, "center", 864 * u, 56.6);
      }
      });
    });

    // Screen-space titles at the top of the safe box.
    const sf = view.safe,
      headV = (text, from, until) => M.caption(c, t, text, from, until, { x: sf.x / W, align: "left", y: 0.135, size: 56 * u, color: k.ink, weight: 900, maxWidth: sf.w });
    if (t < 7.2) {
      const cx = sf.x + sf.w / 2;
      c.fillStyle = k.bg;
      c.fillRect(0, 0, W, 470 * u);
      M.text(c, p.hook1, cx, 275 * u, 76 * u, k.ink, 900, "center", sf.w);
      M.text(c, p.hook2, cx, 372 * u, 104 * u, k.accent, 900, "center", sf.w);
      label(p.hookSub, cx, 442 * u, 30 * u, k.sub, 700, "center", sf.w);
    }
    headV(p.looks, 16.6, 22.4);
    headV(p.local, 23.0, 30.9);
    headV(p.formats, 46.7, 53.7);
    // Narration subtitles; a cue ends where the next begins so two never show at once.
    const cues = film.captions ?? [];
    M.captions(c, t, cues.map((q, i) => [q.text, q.start, Math.min(q.end, cues[i + 1]?.start ?? Infinity)]), {
      lines: 3,
      x: (sf.x + sf.w / 2) / W,
      y: (sf.y + sf.h) / H - 0.03,
      size: 50 * u,
      weight: 700,
      color: "#ffffff",
      plate: "rgba(0,0,0,.55)",
      maxWidth: sf.w,
    });
    M.vignette(c);
  }
};
