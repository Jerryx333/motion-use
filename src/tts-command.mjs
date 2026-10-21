// A vendor-neutral TTS bridge. No shell interpolation or automatic paid retries.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";

export function speechCommandKey(command, base) {
  return crypto.createHash("sha256").update(JSON.stringify(command.map(a => [
    base && path.isAbsolute(a) && path.relative(base,a) && !path.relative(base,a).startsWith("..") && !path.isAbsolute(path.relative(base,a)) ? path.relative(base,a) : a,
    path.isAbsolute(a) && fs.statSync(a, { throwIfNoEntry: false })?.isFile()
      ? crypto.createHash("sha256").update(fs.readFileSync(a)).digest("hex") : null,
  ]))).digest("hex");
}

export function commandSpeech(config, request, { allowCode = false } = {}) {
  if (!allowCode) throw new Error("command TTS executes project code; pass --allow-code only for a bridge you wrote or trust");
  if (!Array.isArray(config.command) || !config.command.length || !config.model)
    throw new Error("command TTS requires voiceover.command and an explicit model");
  const r = spawnSync(config.command[0], config.command.slice(1), {
    cwd: config.commandCwd, input: JSON.stringify({ schemaVersion: 1, ...request }),
    encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024,
  });
  // Provider logs can contain credentials. Do not echo stdout/stderr or retry.
  if (r.error || r.status !== 0) throw new Error(`command TTS failed (${r.error?.code ?? `exit ${r.status}`}); inspect the trusted bridge privately; no automatic retry`);
  probeSpeech(request.output, true);
}

export function probeSpeech(file, requireMp3 = false) {
  const p = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name", "-of", "json", file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  const seconds = Number(p.format?.duration);
  if (!p.streams?.some(s => s.codec_type === "audio") || !(seconds > 0)) throw new Error("TTS bridge did not write playable audio");
  if (requireMp3 && !p.streams.some(s => s.codec_type === "audio" && s.codec_name === "mp3")) throw new Error("TTS bridge must encode the requested output as MP3; import WAV as a voiceover track instead");
  return seconds;
}
