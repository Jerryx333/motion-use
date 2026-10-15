// 动态文字海报：每个词砸下来就是一拍，配乐只给"砸"和"推"的冲击，词停住时音乐也停住。
window.scoreFilm = function (film, S) {
  S.why("Kinetic poster: dry synth kit locked to each word landing; dead silence on HOLD, a riser into SLAM, a falling square stab when 'slideshow' is crossed out. A minor, 120 bpm.");
  S.tempo(120);
  const a = S.scale("A", "minor", 2);
  S.track("kick", { reverb: 0.05 });
  S.track("square", { gain: 0.8, reverb: 0.15 });
  S.track("bass", { gain: 0.9 });
  // HOLD: one hit, then nothing.
  S.note("kick", 0.4, "hard", { vel: 1 });
  S.note("bass", 0.4, a(0, 1), { dur: 0.5, vel: 0.8 });
  // PUSH: the camera snaps closer — pulse starts.
  for (const t of S.grid(S.at("push"), S.end("push"), 0.5)) S.note("bass", t, a(0, 1), { dur: S.beats(0.4), vel: 0.6 });
  S.note("kick", S.at("push", 0.4), "hard", { vel: 1 });
  S.chord("square", S.at("push", 0.4), S.chordOf(a, 0, 3, 3), { dur: 0.3, vel: 0.5 });
  S.note("riser", S.end("push", -1.2), "up", { dur: 1.2, vel: 0.8 });
  // SLAM: everything lands at once.
  S.note("kick", S.at("slam", 0.4), "hard", { vel: 1.2 });
  S.chord("square", S.at("slam", 0.4), S.chordOf(a, 3, 3, 3), { dur: 0.6, vel: 0.7 });
  for (const t of S.grid(S.at("slam", 0.4), S.end("slam"), 1)) { S.note("kick", t, "soft", { vel: 0.8 }); S.note("hat", t + S.beats(0.5), "closed", { vel: 0.5 }); }
  // NOT A SLIDESHOW: words rise in turn, then the stroke — a falling stab.
  S.chord("square", S.at("not", 2.7), [a(4, 3), a(2, 3), a(0, 3)], { strum: 0.09, dur: 0.25, vel: 0.6 });
  S.note("kick", S.at("not", 2.7), "hard", { vel: 1 });
  S.note("bass", S.at("not", 2.7), a(0, 0), { dur: 1.2, vel: 0.9 });
};
