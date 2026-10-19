import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { concatParts } from "../src/concat.mjs";

test("concat chapters use video frame boundaries, embed Unicode titles and preserve reused source identity", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mu-chapters-"));
  try {
    const source = path.join(dir, "source.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30000/1001", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.15", "-frames:v", "31", "-c:v", "libx264", "-c:a", "aac", source], { stdio: "pipe" });
    const config = path.join(dir, "parts.json");
    const provenance = { reused: true, project: "original-lesson", chapter: "Q02" };
    fs.writeFileSync(config, JSON.stringify({ name: "lessons", parts: [
      { file: "source.mp4", title: "第一题：一加五是六", source: provenance },
      { file: "source.mp4", from: 1 / (30000 / 1001), to: 17 / (30000 / 1001), title: "第二题 = #测试; \\保留" },
    ] }));
    const r = concatParts(config, { out: path.join(dir, "joined"), release: true, "allow-static": "Frame boundary fixture", "allow-blue-purple": "Synthetic pattern" });
    assert.equal(r.ok, true);
    assert.equal(r.chaptersEmbedded, true);
    const manifest = JSON.parse(fs.readFileSync(r.release_manifest));
    assert.equal(manifest.files.filter((entry) => entry.kind === "chapters").length, 3);
    assert.equal(manifest.chapters.json, "chapters.json");
    assert.equal(path.dirname(r.chapterFiles.json), path.dirname(r.file));
    assert.deepEqual(r.parts.map((p) => p.frames), [31, 16]);
    assert.deepEqual(r.parts.map((p) => [p.startFrame, p.endFrame]), [[0, 31], [31, 47]]);
    assert.deepEqual(r.parts[0].source, provenance);
    const chapters = JSON.parse(fs.readFileSync(r.chapterFiles.json));
    assert.equal(chapters.frames, 47);
    assert.equal(chapters.frameRate, "30000/1001");
    assert.equal(chapters.videoDuration, 47 * 1001 / 30000);
    assert.deepEqual(chapters.chapters[0].source.provenance, provenance);
    assert.match(fs.readFileSync(r.chapterFiles.srt, "utf8"), /00:00:01,034 --> 00:00:01,568/);
    assert.match(fs.readFileSync(r.chapterFiles.text, "utf8"), /第一题/);
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_chapters", "-show_streams", "-of", "json", r.file], { encoding: "utf8" }));
    assert.equal(Number(probe.streams.find((s) => s.codec_type === "video").nb_read_frames), 47);
    assert.equal(probe.chapters.length, 2);
    assert.equal(probe.chapters[0].tags.title, "第一题：一加五是六");
    assert.equal(probe.chapters[1].tags.title, "第二题 = #测试; \\保留");
    assert.ok(Math.abs(Number(probe.chapters[1].start_time) - 31 * 1001 / 30000) < .001);
    assert.ok(Math.abs(Number(probe.chapters[1].end_time) - 47 * 1001 / 30000) < .001);
    // Legacy configs still work and do not silently add an MP4 chapter track.
    fs.writeFileSync(config, JSON.stringify({ name: "legacy", parts: [{ file: "source.mp4" }, { file: "source.mp4" }] }));
    const legacy = concatParts(config, { out: path.join(dir, "legacy") });
    assert.equal(legacy.chaptersEmbedded, false);
    assert.equal(legacy.parts[1].endFrame, 62);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
