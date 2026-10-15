// The music of the starter study. Replace it with this film's own: pick instruments and a mode that
// belong to the subject, decide where it peaks, and land accents on the picture's events.
// `motion-use instruments` lists what can play; `motion-use music . --allow-code` renders it alone.
window.scoreFilm = function (film, S) {
  S.why("Starter study: plucked string and pad in D dorian at 96 bpm, sparse while the gap is shown, building as the connections multiply, one bell when the name is written. Replace for the film's subject.");
  S.tempo(96);
  const d = S.scale("D", "dorian", 3);
  S.track("string-pluck", { gain: 0.9, reverb: 0.3 });
  S.track("pad", { gain: 0.6 });
  // Quiet at the problem, fullest when the network expands, a held resolve at the end.
  S.arc([["problem", 0.45], ["signal", 0.6], ["expand", 1], ["brand", 0.8]]);
  const motif = S.motif([0, 2, 4, 2, 3, 1], [1, 0.5, 0.5, 1, 0.5, 0.5]);
  // One chord per bar under everything.
  const chords = [0, 5, 3, 4];
  S.grid(0, film.duration, 4).forEach((t, i) => S.chord("pad", t, S.chordOf(d, chords[i % 4], 3, 1), { dur: S.bars(1) }));
  // The motif answers itself shot by shot: stated, raised, inverted, then resolved.
  S.phrase("string-pluck", S.at("problem", 0.4), motif, d, { oct: 1, vel: 0.55 });
  S.phrase("string-pluck", S.at("signal", 0.2), motif.transpose(2), d, { oct: 1, vel: 0.6 });
  S.phrase("string-pluck", S.at("response", 0.3), motif.invert(), d, { oct: 1 });
  for (const t of S.grid(S.at("expand"), S.end("expand"), 0.5)) S.note("string-pluck", t, d(S.pick([0, 2, 4, 5]), 2), { dur: S.beats(0.5), vel: 0.45 });
  for (const t of S.grid(S.at("signal"), S.end("expand"), 4)) S.note("kick", t, "soft", { vel: 0.6 });
  S.phrase("string-pluck", S.at("brand", 0.3), S.motif([4, 2, 1, 0], [0.5, 0.5, 0.5, 2.5]), d, { oct: 1 });
  S.note("bell", S.at("brand", 0.52), d(0, 2), { vel: 0.8 });
};
