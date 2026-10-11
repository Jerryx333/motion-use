import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fetchReference, parseReference, referenceMarkdown } from "../src/reference.mjs";
import { main } from "../src/cli.mjs";
import { initFilm, validateFilm } from "../src/film.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = fs.readFileSync(path.join(here, "fixtures", "prompt-motion-entry.html"), "utf8");
const skill = fs.readFileSync(path.join(here, "fixtures", "prompt-motion-skill.html"), "utf8");
const ENTRY = "https://prompt-motion.com/fixture-maker-abc123";

test("parses a prompt-motion prompt entry: credits, tags, model, prompt, video", () => {
  const r = parseReference(entry, ENTRY);
  assert.equal(r.source, "prompt-motion");
  assert.equal(r.kind, "prompt");
  assert.equal(r.title, "Paper boat crossing");
  assert.deepEqual(r.creator, { name: "Fixture Maker", handle: "fixture_maker", url: "https://x.com/fixture_maker" });
  // The curator's own X link on the page is not the creator's post.
  assert.equal(r.post_url, "https://x.com/fixture_maker/status/1234567890123456789");
  assert.deepEqual(r.tags, ["Shapes", "Kinetic type"]);
  assert.equal(r.model, "Opus 5.5");
  assert.equal(r.effort, "High");
  assert.equal(r.posted, "2026-09-30");
  assert.match(r.prompt, /paper boat crossing a puddle & leaving a ripple that writes 'hello'\.\nkeep it calm\./);
  assert.equal(r.video_url, "https://media.example.test/fixture/video.mp4");
  assert.equal(r.slug, "prompt-motion-fixture-maker-abc123");
  assert.equal(r.gallery, "https://prompt-motion.com");
});

test("parses a skill entry: description, install command, repository", () => {
  const r = parseReference(skill, "https://prompt-motion.com/skill-author-def456");
  assert.equal(r.kind, "skill");
  assert.equal(r.prompt, undefined);
  assert.equal(r.skill.install, "npx skills add example/launch-skill");
  assert.equal(r.skill.repo, "https://github.com/example/launch-skill");
  assert.match(r.skill.description, /turns a product page into a short launch film/);
  assert.equal(r.post_url, "https://x.com/skill_author/status/2222222222222222222");
});

test("any page with a VideoObject falls back to the generic parser", () => {
  const r = parseReference(entry, "https://gallery.example.test/case/42");
  assert.equal(r.source, "web");
  assert.equal(r.title, "Paper boat crossing");
  assert.equal(r.video_url, "https://media.example.test/fixture/video.mp4");
  assert.equal(r.slug, "gallery-example-test-42");
});

test("REFERENCE.md credits the creator and says the prompt is for study only", () => {
  const md = referenceMarkdown(parseReference(entry, ENTRY));
  assert.match(md, /Fixture Maker \(@fixture_maker\)/);
  assert.match(md, /https:\/\/x\.com\/fixture_maker\/status\/1234567890123456789/);
  assert.match(md, /belong to their creator/);
  assert.match(md, /Never paste the prompt into a deliverable/);
  assert.match(md, /never commit this folder/);
});

test("reference writes a git-ignored folder, downloads the video and breaks it down", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "motion-use-reference-"));
  const clip = path.join(tmp, "clip.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=320x180:r=30:d=2", "-pix_fmt", "yuv420p", clip]);
  const server = http.createServer((req, res) => {
    if (req.url === "/entry") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(entry.replaceAll("https://media.example.test/fixture/video.mp4", `http://127.0.0.1:${server.address().port}/video.mp4`));
    } else if (req.url === "/video.mp4") {
      res.writeHead(200, { "content-type": "video/mp4", "content-length": fs.statSync(clip).size });
      fs.createReadStream(clip).pipe(res);
    } else res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/entry`;
    process.env.MOTION_USE_NO_UPDATE_CHECK = "1";
    const log = console.log;
    let out = "";
    console.log = (s) => (out += s + "\n");
    let code;
    try {
      code = await main(["reference", url, tmp, "--json"]);
    } finally {
      console.log = log;
    }
    assert.equal(code, 0, out);
    const res = JSON.parse(out);
    const dir = res.dir;
    assert.equal(fs.readFileSync(path.join(dir, ".gitignore"), "utf8").trim().split("\n").pop(), "*");
    assert.ok(fs.statSync(path.join(dir, "video.mp4")).size > 1000);
    assert.ok(fs.existsSync(path.join(dir, "breakdown", "breakdown.md")));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "reference.json"), "utf8"));
    assert.equal(saved.title, "Paper boat crossing");
    assert.ok(["green", "yellow", "red"].includes(saved.breakdown.motion));
    assert.match(fs.readFileSync(path.join(dir, "REFERENCE.md"), "utf8"), /breakdown\/breakdown\.md/);
  } finally {
    server.close();
  }
});

test("a video above the size limit is skipped with a warning, the reference is still written", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "motion-use-reference-big-"));
  const fake = async (u) =>
    String(u).endsWith(".mp4")
      ? new Response("x".repeat(64), { headers: { "content-length": "999999999" } })
      : new Response(entry);
  const r = await fetchReference(ENTRY, { outRoot: tmp, maxBytes: 1000, fetchImpl: fake });
  assert.equal(r.video, null);
  assert.match(r.warnings.join(" "), /above the 0 MB limit|limit/);
  assert.ok(fs.existsSync(path.join(r.dir, "REFERENCE.md")));
});

test("film brief fields: init fills them, validate flags TODOs and a length the shots do not cover", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "motion-use-brief-"));
  initFilm({ subject: "A paper boat app", purpose: "App Store preview", tone: "calm, precise", length: "30" }, dir);
  const film = JSON.parse(fs.readFileSync(path.join(dir, "film.json"), "utf8"));
  assert.equal(film.brief.subject, "A paper boat app");
  assert.equal(film.brief.length, 30);
  const { errors, warnings } = validateFilm(film, dir);
  assert.deepEqual(errors, []);
  const paths = warnings.map((w) => w.path);
  assert.ok(paths.includes("$.brief.audience"), "audience is still a TODO");
  assert.ok(!paths.includes("$.brief.subject"));
  assert.ok(paths.includes("$.brief.length"), "30 s asked, 18 s of shots");
});
