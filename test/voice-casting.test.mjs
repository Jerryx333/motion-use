import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { validateBrief } from "../src/brief.mjs";
import { generateVoiceover, narrationFreshness, MANIFEST } from "../src/voiceover.mjs";
import { auditionVoices } from "../src/voice-audition.mjs";
import { filmInputs } from "../src/snapshot.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "motion-casting-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bridge = path.join(dir, "bridge.mjs");
  fs.copyFileSync(new URL("./fixtures/fake-tts.mjs", import.meta.url), bridge);
  fs.mkdirSync(path.join(dir, "voiceover"));
  const data = { version: 1, name: "test", languages: ["zh"], voiceover: {
    dir: "voiceover", engine: "command", command: [process.execPath, "bridge.mjs"], model: "model-a",
    voices: { zh: "voice_42" }, instructions: "像同事解释问题，短句，结尾收住。",
  }, scenes: [{ id: "sample", type: "title", title: "Test", narration: "两个项目，直接沟通。" }] };
  const load = () => { const c = validateBrief(data, dir); assert.deepEqual(c.errors, []); return c.brief; };
  return { dir, bridge, data, load };
}

test("external TTS is explicit, forwards performance settings, and invalidates on model/style/bridge changes", async t => {
  const p = fixture(t), brief = p.load();
  const refused = await generateVoiceover(brief);
  assert.equal(refused.rows[0].status, "error");
  assert.match(refused.rows[0].error, /allow-code/);
  assert.equal(fs.existsSync(path.join(p.dir, "last-request.json")), false);
  const generated = await generateVoiceover(brief, { allowCode: true });
  assert.equal(generated.rows[0].status, "generated");
  const req = JSON.parse(fs.readFileSync(path.join(p.dir, "last-request.json")));
  assert.equal(req.model, "model-a"); assert.equal(req.voice, "voice_42");
  assert.equal(req.instructions, p.data.voiceover.instructions);
  assert.equal(req.text, brief.scenes[0].narration.zh);
  const file = generated.rows[0].file;
  assert.equal((await generateVoiceover(brief, { allowCode: true })).rows[0].status, "unchanged");
  for (const [key, value] of [["model", "model-b"], ["instructions", "更克制，避免播音腔。"]]) {
    p.data.voiceover[key] = value;
    const next = p.load();
    assert.equal(narrationFreshness(next.voiceover.dir, file, req.text, next.voiceover, "zh").current, false);
    assert.equal((await generateVoiceover(next, { allowCode: true })).rows[0].status, "generated");
  }
  fs.appendFileSync(p.bridge, "\n// bridge version changed\n");
  const next = p.load();
  assert.equal(narrationFreshness(next.voiceover.dir, file, req.text, next.voiceover, "zh").current, false);
  assert.equal((await generateVoiceover(next, { allowCode: true })).rows[0].status, "generated");
  assert.ok(filmInputs({dir:p.dir, narrationConfig:next.voiceover}, path.join(p.dir,"film.json")).some(x => x.role === "voiceover-engine" && x.file === p.bridge));
  const relocated = path.join(p.dir,"relocated");
  fs.mkdirSync(relocated);
  fs.copyFileSync(p.bridge,path.join(relocated,"bridge.mjs"));
  fs.cpSync(path.join(p.dir,"voiceover"),path.join(relocated,"voiceover"),{recursive:true});
  const copied = validateBrief(p.data,relocated).brief;
  assert.equal((await generateVoiceover(copied,{allowCode:true})).rows[0].status,"unchanged");
  const before = fs.readFileSync(file), manifest = fs.readFileSync(path.join(next.voiceover.dir, MANIFEST));
  for (const model of ["fail", "invalid"]) {
    p.data.voiceover.model = model;
    const failed = await generateVoiceover(p.load(), { allowCode: true });
    assert.equal(failed.rows[0].status, "error");
    assert.equal(failed.rows[0].error.includes("provider secret"), false);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(fs.readFileSync(path.join(next.voiceover.dir, MANIFEST)), manifest);
  }
});

test("same-script audition isolates candidates, retains partial failures and never selects a winner", async t => {
  const p = fixture(t), plan = path.join(p.dir, "plan.json"), out = path.join(p.dir, "audition");
  const candidates = ["model-a", "fail"].map((model, i) => ({ id: `candidate-${i}`, label: i ? "Failure" : "Voice <A>", voiceover: {...p.data.voiceover, model} }));
  fs.writeFileSync(plan, JSON.stringify({version:1,lang:"zh",text:"同一段稿子。",candidates}));
  await assert.rejects(() => auditionVoices(plan, out), /allow-code/);
  assert.equal(fs.existsSync(out), false);
  const run = spawnSync(process.execPath, [new URL("../bin/motion-use.mjs", import.meta.url).pathname, "voiceover", "audition", plan, "--out", out, "--allow-code", "--json"], {
    encoding:"utf8",env:{...process.env,MOTION_USE_NO_UPDATE_CHECK:"1"},
  });
  assert.equal(run.status,1,run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.ok, false); assert.equal(result.selected, null);
  assert.equal(result.listeningReview, "UNREVIEWED"); assert.equal(result.qualityRanking, null);
  assert.ok(result.candidates[0].seconds > 0); assert.equal(result.candidates[1].status, "error");
  assert.match(fs.readFileSync(result.review,"utf8"), /Voice &lt;A&gt;/);
  assert.equal(fs.existsSync(path.join(p.dir,"voiceover",MANIFEST)), false);
  await assert.rejects(() => auditionVoices(plan, out, {allowCode:true}), /exists/);
  const invalid = path.join(p.dir,"invalid-plan.json");
  candidates[1].id = candidates[0].id;
  fs.writeFileSync(invalid, JSON.stringify({version:1,lang:"zh",text:"同一段稿子。",candidates}));
  await assert.rejects(() => auditionVoices(invalid, path.join(p.dir,"invalid"), {allowCode:true}), /unique/);
  assert.equal(fs.existsSync(path.join(p.dir,"invalid")), false);
});


test("bridge controls cannot be silently ignored by Azure/Edge and invalid plans do not execute", t => {
  const p = fixture(t);
  for (const patch of [{command:"node bridge.mjs"},{model:""},{instructions:42},{voices:{zh:""}}]) {
    const checked = validateBrief({...p.data,voiceover:{...p.data.voiceover,...patch}},p.dir);
    assert.ok(checked.errors.some(e=>e.path.startsWith("$.voiceover")));
  }
  const checked = validateBrief({...p.data,voiceover:{dir:"voiceover",engine:"edge",instructions:"whisper"}},p.dir);
  assert.ok(checked.errors.some(e=>e.path==="$.voiceover.instructions"));
  assert.equal(fs.existsSync(path.join(p.dir,"last-request.json")),false);
});
