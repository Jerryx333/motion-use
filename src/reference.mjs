// Study a published motion piece: fetch a gallery entry, keep its attribution and prompt for
// the agent to read, download the preview video and take it apart with breakdown.
// The prompt and video belong to their creators. They stay in a git-ignored folder and are
// paraphrased in the brief, never pasted into a deliverable or committed.
import fs from "node:fs";
import path from "node:path";

export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

const decode = (s) =>
  s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

const first = (re, s) => {
  const m = re.exec(s);
  return m ? decode(m[1]).trim() : null;
};

function jsonLd(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1]);
      out.push(...(Array.isArray(j) ? j : [j]));
    } catch {
      // A broken block is skipped; the HTML fields still parse.
    }
  }
  return out;
}

const meta = (html, prop) =>
  first(new RegExp(`<meta[^>]+(?:property|name)="${prop}"[^>]+content="([^"]*)"`, "i"), html) ??
  first(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${prop}"`, "i"), html);

// Any page with a schema.org VideoObject or og:video: title, creator, video, poster.
function parseGeneric(html, url) {
  const video = jsonLd(html).find((j) => j?.["@type"] === "VideoObject") ?? {};
  const creator = Array.isArray(video.creator) ? video.creator[0] : video.creator;
  const creatorUrl = creator?.url ?? null;
  const handle = creatorUrl?.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)/)?.[1] ?? null;
  return {
    source: "web",
    url,
    title: video.name ?? meta(html, "og:title") ?? first(/<title[^>]*>([\s\S]*?)<\/title>/i, html),
    description: video.description ?? meta(html, "og:description"),
    creator: creator || handle ? { name: creator?.name ?? null, handle, url: creatorUrl } : null,
    posted: video.uploadDate ?? null,
    video_url: video.contentUrl ?? meta(html, "og:video") ?? meta(html, "og:video:url"),
    poster_url: (Array.isArray(video.thumbnailUrl) ? video.thumbnailUrl[0] : video.thumbnailUrl) ?? meta(html, "og:image"),
  };
}

// prompt-motion.com entry pages: a prompt (or an agent skill) behind one video.
function parsePromptMotion(html, url) {
  const r = parseGeneric(html, url);
  r.source = "prompt-motion";
  r.title = first(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html) ?? r.title;
  const handle = r.creator?.handle;
  const post = html.match(/href="(https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status\/\d+)"/g)
    ?.map((h) => h.slice(6, -1))
    .find((h) => !handle || h.toLowerCase().includes(`/${handle.toLowerCase()}/`));
  r.post_url = post ?? null;
  const tags = html.match(/aria-label="Contains"[^>]*>([\s\S]*?)<\/ul>/i);
  r.tags = tags ? [...tags[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => decode(m[1]).trim()).filter(Boolean) : [];
  const dd = (label) => first(new RegExp(`<dt[^>]*>${label}</dt>\\s*<dd[^>]*>([\\s\\S]*?)</dd>`, "i"), html);
  r.model = dd("Model");
  r.effort = dd("Effort");
  r.posted = first(/<time[^>]+dateTime="([^"]+)"/i, html) ?? r.posted;
  const prompt = first(/<div[^>]+id="entry-prompt"[^>]*>([\s\S]*?)<\/div>/i, html);
  if (prompt) {
    r.kind = "prompt";
    r.prompt = prompt;
  } else {
    const skill = html.match(/>Skill<\/h2>([\s\S]*?)(?:<h2|<\/main>)/i)?.[1] ?? "";
    r.kind = skill ? "skill" : "unknown";
    r.skill = skill
      ? {
          description: first(/<p[^>]*>([\s\S]*?)<\/p>/i, skill),
          install: first(/<code[^>]*>([\s\S]*?)<\/code>/i, skill),
          repo: first(/href="(https:\/\/github\.com\/[^"]+)"/i, html),
        }
      : null;
  }
  return r;
}

// New galleries go here: a host test and a parser returning the same shape.
const SOURCES = [{ name: "prompt-motion", match: (u) => /(^|\.)prompt-motion\.com$/i.test(u.hostname), parse: parsePromptMotion }];

export function parseReference(html, url) {
  const u = new URL(url);
  const src = SOURCES.find((s) => s.match(u));
  const r = (src?.parse ?? parseGeneric)(html, u.toString());
  r.gallery = src ? `${u.protocol}//${u.host}` : null;
  r.slug = referenceSlug(r, u);
  return r;
}

export function referenceSlug(r, u) {
  const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
  const base = r.source === "web" ? `${u.hostname.replace(/^www\./, "")}-${last}` : `${r.source}-${last}`;
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "reference"
  );
}

export function referenceMarkdown(r, { video = null, breakdown = null } = {}) {
  const who = r.creator ? `${r.creator.name ?? ""}${r.creator.handle ? ` (@${r.creator.handle})` : ""}`.trim() : "unknown";
  const lines = [
    `# Reference: ${r.title ?? r.url}`,
    "",
    `- Creator: ${who}${r.creator?.url ? ` — ${r.creator.url}` : ""}`,
    r.post_url ? `- Original post: ${r.post_url}` : null,
    `- Gallery entry: ${r.url}`,
    r.model ? `- Model: ${r.model}${r.effort ? `, effort ${r.effort}` : ""}` : null,
    r.tags?.length ? `- Tags: ${r.tags.join(", ")}` : null,
    r.posted ? `- Posted: ${r.posted}` : null,
    "",
    "> The prompt, video and look below belong to their creator. Study them: what the piece does",
    "> second by second, its pacing, camera and type. Write your own brief in your own words and",
    "> credit the creator when you borrow a technique. Never paste the prompt into a deliverable,",
    "> and never commit this folder: it is git-ignored on purpose.",
    "",
  ];
  if (r.prompt) lines.push("## Prompt (creator's text, for study only)", "", "```text", r.prompt, "```", "");
  if (r.skill)
    lines.push(
      "## Skill behind it",
      "",
      r.skill.description ? r.skill.description : "",
      r.skill.install ? `\nInstall: \`${r.skill.install}\`` : "",
      r.skill.repo ? `\nRepository: ${r.skill.repo} (check its license before reusing code)` : "",
      "",
    );
  if (video) lines.push(`## Video`, "", `${video}`, "");
  if (breakdown)
    lines.push(
      "## Measured",
      "",
      `${breakdown.transitions} transitions, ${breakdown.segments} segments${breakdown.beat ? `, beat grid ${breakdown.beat}s` : ""}; motion ${breakdown.motion}. Details: breakdown/breakdown.md`,
      "",
    );
  lines.push(
    "## Use it",
    "",
    "1. Watch the video and read breakdown/breakdown.md (cuts, beat grid, contact sheets, heatmaps).",
    "2. Note what to borrow (timing, framing, a transition) in DIRECTOR.md under the reference line, with the creator's handle.",
    "3. Write the film's own brief fields; nothing in film.json or the drawing code quotes this prompt.",
    "",
  );
  return lines.filter((l) => l !== null).join("\n");
}

async function download(url, file, maxBytes, fetchImpl = fetch) {
  const res = await fetchImpl(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`video download failed: HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length"));
  if (len > maxBytes) throw new Error(`video is ${Math.round(len / 1e6)} MB, above the ${Math.round(maxBytes / 1e6)} MB limit`);
  const out = fs.createWriteStream(file);
  let n = 0;
  try {
    for await (const chunk of res.body) {
      n += chunk.length;
      if (n > maxBytes) throw new Error(`video exceeds ${Math.round(maxBytes / 1e6)} MB`);
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
    }
  } catch (e) {
    out.destroy();
    fs.rmSync(file, { force: true });
    throw e;
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  return n;
}

// Fetch → parse → (video → breakdown) → reference.json + REFERENCE.md in outDir/<slug>.
export async function fetchReference(url, { outRoot, video = true, maxBytes = MAX_VIDEO_BYTES, breakdown = null, fetchImpl = fetch } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`not a URL: ${url}`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error("reference needs an http(s) URL");
  const res = await fetchImpl(u, { redirect: "follow", headers: { "user-agent": "motion-use reference (+https://github.com/leeguooooo/motion-use)" } });
  if (!res.ok) throw new Error(`${u}: HTTP ${res.status}`);
  const r = parseReference(await res.text(), res.url || u.toString());
  const dir = path.join(outRoot, r.slug);
  fs.mkdirSync(dir, { recursive: true });
  // The whole folder holds someone else's prompt and video: keep it out of every repository.
  fs.writeFileSync(path.join(dir, ".gitignore"), "# third-party prompt and video for study; do not commit\n*\n");
  const warnings = [];
  let videoFile = null,
    measured = null;
  if (video && r.video_url) {
    try {
      videoFile = path.join(dir, "video.mp4");
      r.video_bytes = await download(r.video_url, videoFile, maxBytes, fetchImpl);
    } catch (e) {
      warnings.push(e.message);
      videoFile = null;
    }
  } else if (video) warnings.push("the page exposes no video URL; breakdown skipped");
  if (videoFile && breakdown) {
    try {
      measured = await breakdown(videoFile, path.join(dir, "breakdown"));
    } catch (e) {
      warnings.push(`breakdown failed: ${e.message}`);
    }
  }
  fs.writeFileSync(path.join(dir, "reference.json"), JSON.stringify({ ...r, breakdown: measured, warnings }, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "REFERENCE.md"), referenceMarkdown(r, { video: videoFile ? "video.mp4" : r.video_url, breakdown: measured }));
  return { ok: true, dir, reference: r, video: videoFile, breakdown: measured, warnings };
}
