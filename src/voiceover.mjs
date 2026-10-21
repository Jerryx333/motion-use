// `motion-use voiceover`: turn each scene's `narration` into voiceover/<lang>/<scene-id>.mp3.
//
// Engines:
//   azure  Azure AI Speech REST API (AZURE_SPEECH_KEY, AZURE_SPEECH_REGION). Licensed for publishing.
//   edge   the `edge-tts` CLI, which uses the Microsoft Edge read-aloud service. Same voices,
//          but whether its audio may be published is not established: treat it as a preview.
//
// Files motion-use generates are recorded in <dir>/.motion-use-voiceover.json (hash, text,
// engine, voice). A file that is not recorded there, or changed since, is a recording the
// user made: it is never overwritten without --force.
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commandSpeech, speechCommandKey } from "./tts-command.mjs";
import { splitSentences } from "./caption-plan.mjs";

export const DEFAULT_VOICES = { zh: "zh-CN-YunxiNeural", en: "en-US-AndrewMultilingualNeural" };
export const MANIFEST = ".motion-use-voiceover.json";
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** SSML for one line. Exported for tests: narration text must never become markup. */
export function ssml(text, voice, rate = "+0%") {
  const lang = voice.split("-").slice(0, 2).join("-");
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${xml(lang)}"><voice name="${xml(voice)}"><prosody rate="${xml(rate)}">${xml(text)}</prosody></voice></speak>`;
}

export function pickEngine(requested) {
  if (requested && !["azure", "edge", "command"].includes(requested)) throw new Error("unknown voiceover engine");
  if (requested) return requested;
  return process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION ? "azure" : "edge";
}

async function azure(text, voice, rate, out) {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) throw new Error("the azure engine needs AZURE_SPEECH_KEY and AZURE_SPEECH_REGION");
  const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3",
      "User-Agent": "motion-use",
    },
    body: ssml(text, voice, rate),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Azure Speech returned ${res.status}${res.status === 429 ? "; rate limited: wait before retrying voiceover" : ""}`);
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
}

// Word boundaries require the Speech SDK; the audio-only REST endpoint supplies none.
function azureTimed(text, voice, rate, out) {
  const script = new URL("../scripts/azure-word-timing.py", import.meta.url);
  const r = spawnSync("uv", ["run", "--quiet", "--no-project", "--python", "3.12", "--with", "azure-cognitiveservices-speech==1.52.0", fileURLToPath(script)], {
    input: JSON.stringify({ ssml: ssml(text, voice, rate), out }), encoding: "utf8", timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) throw new Error(r.error?.code === "ENOENT" ? "--word-timing needs uv (and the optional pinned Azure Speech SDK)" : "Azure word timing failed; check the resource, voice, SDK and connection");
  return JSON.parse(r.stdout).words;
}

// Since 2026-10-12 the legacy Edge read-aloud host answers 403 (rany2/edge-tts#490). Run the
// installed edge-tts through scripts/edge-tts.py, which tries the new host first, with the
// Python interpreter from the edge-tts launcher's shebang; fall back to the plain CLI.
function edgeCommand(args) {
  const script = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "scripts", "edge-tts.py");
  const which = spawnSync("which", ["edge-tts"], { encoding: "utf8" });
  const bin = which.status === 0 ? which.stdout.trim() : "";
  const py = bin ? (fs.readFileSync(bin, "utf8").split("\n")[0].match(/^#!\s*(\S+python\S*)\s*$/) || [])[1] : null;
  return py && fs.existsSync(script) ? [py, [script, ...args]] : ["edge-tts", args];
}

function edge(text, voice, rate, out) {
  const srt = `${out}.srt`;
  const [cmd, args] = edgeCommand(["--voice", voice, `--rate=${rate}`, "--text", text, "--write-media", out, "--write-subtitles", srt]);
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.error?.code === "ENOENT") throw new Error("edge-tts is not installed (pip install edge-tts, or uv tool install edge-tts)");
  if (r.status !== 0) throw new Error(sanitizeSpeechError(`edge-tts failed: ${(r.stderr || r.stdout).trim().split("\n").pop()}`));
  // Sentence cues timed by the voice service; subtitles use them instead of an estimate.
  try {
    return parseSrt(fs.readFileSync(srt, "utf8"));
  } catch {
    return null;
  } finally {
    fs.rmSync(srt, { force: true });
  }
}

export function parseSrt(text) {
  const sec = (s) => {
    const [h, m, rest] = s.trim().split(":");
    return +h * 3600 + +m * 60 + Number(rest.replace(",", "."));
  };
  return String(text)
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.trim().split("\n");
      const i = lines.findIndex((l) => l.includes("-->"));
      if (i < 0) return null;
      const [a, b] = lines[i].split("-->");
      return { text: lines.slice(i + 1).join(" ").trim(), start: +sec(a).toFixed(3), end: +sec(b).toFixed(3) };
    })
    .filter((c) => c && c.text && c.end > c.start);
}

// Without service timing, split narration into sentence-sized cues and share the spoken
// window by character count. Marked estimated: it is not word-accurate.
export function estimateCues(text, start, end) {
  const parts = [];
  for (const sentence of splitSentences(text)) {
    const cjk = /[\u2e80-\u9fff]/.test(sentence),
      limit = cjk ? 18 : 42;
    if (sentence.trim().length <= limit) parts.push(sentence.trim());
    else for (const piece of sentence.match(/[^，,、：:]+[，,、：:]*/g) ?? [sentence]) if (piece.trim()) parts.push(piece.trim());
  }
  const total = parts.reduce((n, x) => n + x.length, 0) || 1;
  let at = start;
  return parts.map((text) => {
    const d = ((end - start) * text.length) / total,
      cue = { text, start: +at.toFixed(3), end: +(at + d).toFixed(3), estimated: true };
    at += d;
    return cue;
  });
}

export function readVoManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Generate missing or outdated narration audio. Returns one row per scene × language.
 * A scene without narration text for a language is skipped (a recording can still go there).
 */
export async function generateVoiceover(brief, { langs = brief.languages, engine: requested, force = false, log = () => {}, wordTiming = false, allowCode = false } = {}) {
  const vo = brief.voiceover;
  if (!vo?.dir) throw new Error('the brief has no voiceover folder; add "voiceover": {"dir": "voiceover"}');
  const engine = pickEngine(requested ?? vo.engine);
  if (wordTiming && engine !== "azure") throw new Error("--word-timing currently requires --engine azure; imported cue timestamps remain available for other voices");
  const manifest = readVoManifest(vo.dir);
  const rows = [];
  for (const lang of langs) {
    const voice = vo.voices[lang] ?? (engine === "command" ? null : DEFAULT_VOICES[lang]);
    const rate = vo.rates[lang] ?? "+0%";
    for (const scene of brief.scenes) {
      const text = scene.narration?.[lang];
      if (!text) continue;
      const rel = path.join(lang, `${scene.id}.mp3`);
      const out = path.join(vo.dir, rel);
      const row = { scene: scene.id, lang, file: out, engine, voice, ...(engine === "command" ? { model: vo.model, instructions: vo.instructions ?? "" } : {}) };
      if (!voice) {
        rows.push({ ...row, status: "error", error: `no voice for "${lang}"; set voiceover.voices.${lang}` });
        continue;
      }
      // Another recording for this scene (e.g. scene.wav) would be picked up instead of the mp3.
      const other = [".wav", ".m4a", ".aac", ".ogg"].map((e) => path.join(vo.dir, lang, scene.id + e)).find((f) => fs.existsSync(f));
      if (other && !force) {
        rows.push({ ...row, file: other, status: "kept", reason: `${path.basename(other)} already exists for this scene` });
        continue;
      }
      const rec = manifest[rel];
      const want = { text, engine, voice, rate, ...(engine === "command" ? {
        model: vo.model, instructions: vo.instructions ?? "", commandKey: speechCommandKey(vo.command ?? [], vo.commandCwd),
      } : {}) };
      if (fs.existsSync(out)) {
        const mine = rec && rec.sha === sha(fs.readFileSync(out));
        if (!mine && !force) {
          rows.push({ ...row, status: "kept", reason: "a recording that motion-use did not make (use --force to replace it)" });
          continue;
        }
        if (mine && Object.entries(want).every(([k,v]) => rec[k] === v) && (!wordTiming || rec.words?.length)) {
          rows.push({ ...row, status: "unchanged" });
          continue;
        }
      }
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const tmp = `${out}.partial.mp3`;
      let cues = null, words = null;
      try {
        log(`${lang}/${scene.id}: ${engine} ${voice}`);
        const generate = async () => {
          fs.rmSync(tmp, { force: true });
          if (engine === "azure") { if (wordTiming) words = azureTimed(text, voice, rate, tmp); else await azure(text, voice, rate, tmp); }
          else if (engine === "command") commandSpeech(vo, { text, lang, voice, model: vo.model, instructions: vo.instructions ?? "", rate, output: tmp }, { allowCode });
          else cues = edge(text, voice, rate, tmp);
        };
        if (engine === "command") await generate();
        else await retrySpeech(generate);
        if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) throw new Error("no audio was written");
        fs.renameSync(tmp, out);
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        rows.push({ ...row, status: "error", error: sanitizeSpeechError(e.message), stale: fs.existsSync(out) });
        continue;
      }
      manifest[rel] = { ...want, sha: sha(fs.readFileSync(out)), ...(cues?.length ? { cues } : {}), ...(words?.length ? { words } : {}) };
      rows.push({ ...row, status: "generated" });
    }
  }
  fs.writeFileSync(path.join(vo.dir, MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
  return { engine, rows };
}

/** Voiceover files in use that came from the edge engine (for the publish warning in render). */
export function edgeGenerated(brief, lang) {
  if (!brief.voiceover?.dir) return [];
  const manifest = readVoManifest(brief.voiceover.dir);
  return brief.scenes
    .map((s) => s.voiceover?.[lang])
    .filter(Boolean)
    .filter((f) => {
      const rec = manifest[path.relative(brief.voiceover.dir, f)];
      return rec?.engine === "edge" && fs.existsSync(f) && rec.sha === sha(fs.readFileSync(f));
    });
}

export function edgeAvailable() {
  try {
    execFileSync("edge-tts", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function sanitizeSpeechError(message) {
  return String(message).replace(/(?:https?|wss?):\/\/[^\s'"<>]+/gi, "[service URL redacted]") + (/\b429\b/.test(message) ? "; rate limited: wait before retrying voiceover" : "");
}

// Imported recordings remain supported. A tracked generated clip must match both
// the current script/settings and the bytes; stale generation never becomes timing.
export function narrationFreshness(dir, file, text, config = {}, lang) {
  const record = readVoManifest(dir)[path.relative(dir, file)];
  if (!record) return { current: false, imported: true };
  const current = record.text === text && record.sha === sha(fs.readFileSync(file)) &&
    record.voice === (config.voices?.[lang] ?? (config.engine === "command" ? null : DEFAULT_VOICES[lang])) &&
    record.rate === (config.rates?.[lang] ?? "+0%") &&
    (!config.engine || record.engine === config.engine) &&
    (config.engine !== "command" || (record.model === config.model && record.instructions === (config.instructions ?? "") && record.commandKey === speechCommandKey(config.command ?? [], config.commandCwd)));
  return { current, imported: false };
}

export async function retrySpeech(run, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await run(); }
    catch (e) {
      if (attempt >= 2 || !/\b429\b/.test(e.message)) throw e;
      await sleep(1000 * 2 ** attempt);
    }
  }
}
