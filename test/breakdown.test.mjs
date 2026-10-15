import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { breakdownVideo, fitBeatGrid } from "../src/breakdown.mjs";
import { compareVideos } from "../src/compare.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "motion-use-breakdown-"));
const clip = path.join(tmp, "cuts.mp4");
const other = path.join(tmp, "other.mp4");
// Six 1 s flat colours with distinct luma, then 1 s of moving testsrc: hard cuts every 30 frames.
const colors = ["0x202020", "0xe0e0e0", "0x3020c0", "0xc0c040", "0x5010a0", "0xffa0a0"];
const inputs = colors.flatMap((c) => ["-f", "lavfi", "-i", `color=c=${c}:s=320x180:r=30:d=1`]);
inputs.push("-f", "lavfi", "-i", "testsrc=s=320x180:r=30:d=1,scroll=h=0.01");
const n = colors.length + 1;
execFileSync("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", `${Array.from({ length: n }, (_, i) => `[${i}:v]`).join("")}concat=n=${n}:v=1[v]`, "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "15", clip]);
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=640x480:r=25:d=3", "-pix_fmt", "yuv420p", other]);

test("breakdown finds cuts, beat grid, palette and writes its files", async () => {
  const out = path.join(tmp, "bd");
  const s = await breakdownVideo(clip, out);
  const times = s.transitions.map((t) => t.time);
  assert.equal(times.length, 6, `cuts: ${times}`);
  times.forEach((t, i) => assert.ok(Math.abs(t - (i + 1)) <= 1 / 30 + 1e-6, `cut ${i} at ${t}`));
  assert.ok(s.beat_grid, "beat grid fitted");
  assert.ok(Math.abs(s.beat_grid.step_frames - 30) <= 0.5, `step ${s.beat_grid.step_frames}`);
  assert.equal(s.beat_grid.inliers, 6);
  assert.equal(s.beat_grid.bpm_if_quarter, 60);
  assert.equal(s.segments.length, 7);
  assert.ok(s.segments[0].motion_area < 0.01, "flat colour has no motion");
  assert.ok(s.segments[6].motion_area > 0.2, `scrolling testsrc moves: ${s.segments[6].motion_area}`);
  assert.ok(s.palette.colors.length > 0 && s.palette.colors.every((c) => /^#[0-9a-f]{6}$/.test(c.hex)));
  assert.ok(s.palette.blue_purple.frames >= 1, "blue-purple segments flagged");
  assert.ok(s.contact_sheets.length >= 1 && s.contact_sheets[0].times[1] === 0.25);
  for (const f of ["breakdown.json", "breakdown.md", "transitions/T01.jpg", "transitions/T06.jpg", "heatmaps/seg01.png", "ref/seg07.png", s.contact_sheets[0].file]) assert.ok(fs.existsSync(path.join(out, f)), f);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "breakdown.json"), "utf8")).transitions.length, 6);
  // A directory motion-use did not create is refused.
  await assert.rejects(breakdownVideo(clip, tmp), /not created by motion-use/);
});

test("beat grid prefers the largest step and tolerates outliers", () => {
  const S = [10, 34, 58, 82, 106, 130, 154, 178, 190, 202];
  const g = fitBeatGrid(S, 30);
  assert.ok(Math.abs(g.step_frames - 24) < 0.2 || Math.abs(g.step_frames - 12) < 0.2, `step ${g.step_frames}`);
  assert.equal(fitBeatGrid([1, 2, 3], 30), null);
  assert.ok(g.inliers >= 8);
});

test("compare stacks frames side by side", () => {
  const out = path.join(tmp, "cmp.png");
  const r = compareVideos(clip, other, out, { times: [0.5, 1.5, 2.5], width: 320 });
  assert.ok(fs.existsSync(out));
  const [w, h] = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", out], { encoding: "utf8" }).trim().split(",").map(Number);
  assert.equal(w, 640);
  assert.equal(h, r.height);
  assert.throws(() => compareVideos(clip, other, out, { times: [5] }), /outside both videos/);
});

// Unique evolving chord and beat pattern: repeated stationary tones cannot establish an offset.
const song = path.join(tmp, "song.wav");
const voice = path.join(tmp, "voice.wav");
const speechGate = "between(t,1,3)+between(t,5,7)+between(t,8,9)";
const songExpr = "(0.06*sin(2*PI*(330*t+0.71*t*t))+0.05*sin(2*PI*(470*t+0.31*t*t))+0.04*sin(2*PI*(620*t+0.17*t*t)))*(0.65+0.35*sin(2*PI*1.73*t))* (0.8+0.2*sin(2*PI*0.137*t))";
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `aevalsrc='${songExpr}':s=8000:d=24`, "-c:a", "pcm_f32le", song]);
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `aevalsrc='0.2*sin(2*PI*200*t)*(0.8+0.2*sin(2*PI*3*t))*(${speechGate})':s=8000:d=10`, "-c:a", "pcm_f32le", voice]);

const { analyzeAudio, matchMusic } = await import("../src/breakdown-audio.mjs");
const { decodeMono } = await import("../src/beats.mjs");
function rms(samples, windows) {
  let power = 0, count = 0;
  for (const [from, to] of windows) for (let i = from * 2000; i < to * 2000; i++) { power += samples[i] ** 2; count++; }
  return Math.sqrt(power / count);
}
for (const duck of [false, true]) test(`audio matches song, pitch and levels (duck=${duck})`, async () => {
  const ref = path.join(tmp, `audio-${duck}.mp4`);
  const musicGain = duck ? `0.4*(1-0.5*(${speechGate}))` : "0.4";
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=s=64x64:r=10:d=10", "-i", song, "-i", voice, "-filter_complex", `[1:a]atrim=start=7.5:duration=10,asetpts=PTS-STARTPTS,aeval='val(0)*(${musicGain})'[m];[m][2:a]amix=inputs=2:normalize=0[a]`, "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "128k", ref]);
  const a = analyzeAudio(ref, [song, voice]);
  assert.ok(Math.abs(a.matches[0].offset_seconds - 7.5) <= 0.05, JSON.stringify(a.matches));
  assert.ok(a.matches[0].ncc > 0.85, `NCC ${a.matches[0].ncc}`);
  assert.equal(a.selected_music, song);
  assert.ok(Math.abs(a.pitch_median_hz - 200) < 20, `pitch ${a.pitch_median_hz}`);
  const talk = [[1, 3], [5, 7], [8, 9]];
  const original = decodeMono(song, { rate: 2000, from: 7.5, length: 10 });
  const narration = decodeMono(voice, { rate: 2000 });
  const expected = 20 * Math.log10(rms(narration, talk) / (rms(original, talk) * (duck ? 0.2 : 0.4)));
  assert.ok(Math.abs(a.levels.music_below_voice_db - expected) <= 2, `${JSON.stringify(a.levels)} expected ${expected}`);
  assert.equal(a.levels.ducked, duck, JSON.stringify(a.levels));
  assert.equal(a.film_music.duck, duck);
  assert.ok(a.speech_windows.length >= 3 && a.pause_windows.length >= 3);
  if (!duck) {
    const out = path.join(tmp, "bd-audio");
    const summary = await breakdownVideo(ref, out, { music: [song] });
    assert.equal(summary.audio.selected_music, song);
    assert.match(fs.readFileSync(path.join(out, "breakdown.md"), "utf8"), /film.json music:.*"duck":false/);
    const cli = JSON.parse(execFileSync(process.execPath, ["bin/motion-use.mjs", "breakdown", ref, "--music", song, "--music", voice, "--out", path.join(tmp, "cli-audio"), "--json"], { encoding: "utf8" }));
    assert.equal(cli.audio.matches.length, 2);
    assert.equal(cli.audio.film_music.from, 7.5);
  }
});

test("audio handles no candidate, no match, negative offset and silence", () => {
  const a = analyzeAudio(voice);
  assert.ok(Math.abs(a.pitch_median_hz - 200) < 20);
  assert.equal(a.levels, null);
  assert.match(a.notes.join(" "), /No --music/);
  const unmatched = analyzeAudio(voice, [song]);
  assert.equal(unmatched.matches[0].matched, false);
  assert.equal(unmatched.film_music, null);
  const original = decodeMono(song, { rate: 2000, length: 10 });
  const delayed = new Float32Array(original.length + 4000);
  delayed.set(original, 4000);
  const result = matchMusic(delayed, original);
  assert.equal(result.offset_seconds, -2);
  assert.ok(result.ncc > 0.99);
  assert.equal(matchMusic(new Float32Array(4000), original).ncc, 0);
  assert.equal(analyzeAudio(clip).available, false);
});
