// Same-script voice casting in an isolated output; never changes production narration.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { validateBrief } from "./brief.mjs";
import { generateVoiceover } from "./voiceover.mjs";
import { probeSpeech } from "./tts-command.mjs";

const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
export async function auditionVoices(planFile, out, options = {}) {
  if (!out) throw new Error("voiceover audition requires --out <fresh-directory>");
  planFile = path.resolve(planFile); out = path.resolve(out);
  if (fs.existsSync(out)) throw new Error("audition output exists; choose a fresh directory");
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  if (plan.version !== 1 || !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(plan.lang ?? "") ||
      typeof plan.text !== "string" || !plan.text.trim() || plan.text.length > 1200 ||
      !Array.isArray(plan.candidates) || !plan.candidates.length || plan.candidates.length > 8)
    throw new Error("audition plan needs version:1, lang, text (1–1200 characters), and 1–8 candidates");
  const ids = new Set();
  const candidates = plan.candidates.map(c => {
    if (!c || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(c.id ?? "") || ids.has(c.id)) throw new Error("candidate IDs must be unique lowercase slugs");
    ids.add(c.id);
    if (typeof c.label !== "string" || !c.label.trim() || c.label.length > 200 || !c.voiceover?.engine)
      throw new Error(`candidate ${c.id} needs a label and an explicit voiceover.engine`);
    const checked = validateBrief({ version: 1, name: "audition", languages: [plan.lang],
      voiceover: { ...c.voiceover, dir: undefined }, scenes: [{ id: "sample", type: "title", title: "Sample", narration: plan.text }] }, path.dirname(planFile));
    const errors = checked.errors.filter(e => e.path.startsWith("$.voiceover"));
    if (errors.length) throw new Error(`${c.id}: ${errors.map(e => `${e.path}: ${e.message}`).join("; ")}`);
    if (checked.brief.voiceover.engine === "command" && !options.allowCode)
      throw new Error("command TTS requires --allow-code for a trusted bridge; no samples generated");
    return { ...c, config: checked.brief.voiceover };
  });
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.mkdirSync(out);
  const report = { version: 1, text: plan.text, lang: plan.lang, selected: null,
    listeningReview: "UNREVIEWED", qualityRanking: null, candidates: [] };
  for (const c of candidates) {
    const dir = path.join(out, c.id);
    const result = await generateVoiceover({ languages: [plan.lang], voiceover: { ...c.config, dir },
      scenes: [{ id: "sample", narration: { [plan.lang]: plan.text } }] }, options);
    const row = result.rows[0];
    const entry = { id: c.id, label: c.label, engine: result.engine, voice: row.voice,
      model: row.model ?? null, instructions: row.instructions ?? null, status: row.status,
      listeningReview: "UNREVIEWED", useRights: "needs-review" };
    if (row.status === "error") entry.error = row.error;
    else {
      try {
        entry.seconds = probeSpeech(row.file);
        entry.file = path.relative(out, row.file).split(path.sep).join("/");
        entry.sha256 = crypto.createHash("sha256").update(fs.readFileSync(row.file)).digest("hex");
      } catch { entry.status = "error"; entry.error = "sample is not playable audio"; }
    }
    report.candidates.push(entry);
  }
  report.ok = report.candidates.every(c => c.status !== "error");
  fs.writeFileSync(path.join(out, "audition.json"), JSON.stringify(report, null, 2) + "\n");
  fs.writeFileSync(path.join(out, "index.html"), `<!doctype html><meta charset="utf-8"><title>Voice audition</title>
<style>body{font:18px system-ui;max-width:850px;margin:40px auto;padding:20px;background:#f5f2eb;color:#18231d}article{padding:20px;border-bottom:1px solid #bbb}audio{width:100%}</style>
<h1>Same-script voice audition</h1><p>${esc(plan.text)}</p><p>Listening UNREVIEWED. No automatic winner. Compare diction, pronunciation, pauses, energy and fatigue with the intended picture/music; record the listener and selected sample in SOURCES.md.</p>
${report.candidates.map(c => `<article><h2>${esc(c.label)}</h2><p>${esc([c.engine,c.model,c.voice].filter(Boolean).join(" / "))}</p>${c.file ? `<audio controls preload="none" src="${esc(c.file)}"></audio>` : `<p>${esc(c.error)}</p>`}</article>`).join("\n")}`);
  return { ...report, out, review: path.join(out, "index.html") };
}
