import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { initFilm, checkFilm } from '../src/film.mjs';
import { createSnapshot } from '../src/snapshot.mjs';
import { checkNarration, narrationItems, COMPARATOR_VERSION } from '../src/narration-check.mjs';

// Integration uses generated local audio and prefilled mock recognition evidence.
// MOTION_USE_ASR=off prevents model downloads and external recognition calls.
const cli = (...args) => spawnSync(process.execPath, ['bin/motion-use.mjs', ...args], {
  encoding:'utf8', env:{...process.env,MOTION_USE_NO_UPDATE_CHECK:'1',MOTION_USE_ASR:'off',MOTION_USE_ASR_MODEL:'small'}
});
function fixture(t, { heard = '1加5是6', model = 'medium', fallbackModel = null } = {}) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'mu-asr-cli-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  initFilm({lang:'zh',format:'square'},dir);
  const file = path.join(dir,'film.json'), data = JSON.parse(fs.readFileSync(file));
  Object.assign(data,{duration:2,music:'none',voiceover:{dir:'voiceover',engine:'azure'},narrationCheck:{model,...(fallbackModel ? {fallbackModel} : {})},shots:[{id:'a',start:0,end:2,purpose:'math',action:'move a number',narration:{zh:'一加五是六'}}]});
  const vo = path.join(dir,'voiceover'); fs.mkdirSync(path.join(vo,'zh'),{recursive:true});
  const audio = path.join(vo,'zh','a.mp3');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=duration=0.6','-y',audio]);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(audio)).digest('hex');
  fs.writeFileSync(path.join(vo,'.motion-use-voiceover.json'),JSON.stringify({'zh/a.mp3':{text:'一加五是六',sha,engine:'azure',voice:'zh-CN-YunxiNeural',rate:'+0%'}}));
  fs.writeFileSync(file,JSON.stringify(data));
  const checked = checkFilm(dir,{phase:'narration'});
  assert.equal(checked.ok,true,JSON.stringify(checked.report));
  const items = narrationItems(checked.film);
  assert.equal(items.length,1);
  const run = ({items}) => ({items:items.map((it)=>({file:it.file,text:heard}))});
  checkNarration(items,{dir:vo,model,run});
  return {dir,file,data,audio,vo,items};
}

test('CLI uses pinned model over environment and exposes automatic versus listening status in static HTML', t=>{
  const p = fixture(t);
  const html = path.join(p.dir,'review','index.html');
  const r = cli('voiceover','check',p.dir,'--out',html,'--json');
  assert.equal(r.status,0,r.stdout+r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.status,'PASS');
  assert.equal(result.human_review,'UNREVIEWED');
  assert.equal(result.config.model,'medium');
  assert.deepEqual(result.cache,{hits:1,misses:0});
  const content = fs.readFileSync(html,'utf8');
  const src = content.match(/<audio controls src="([^"]+)"/)[1];
  assert.equal(path.resolve(path.dirname(html),decodeURIComponent(src)),p.audio);
  assert.match(content,/Human review: UNREVIEWED/);
});

test('release rejects failed math even with skip waiver and records review evidence before rejection', t=>{
  const p = fixture(t,{heard:'1加56'});
  const r = cli('render',p.dir,'--allow-code','--release','--allow-asr-skip','offline review reason','--json');
  assert.equal(r.status,1,r.stdout+r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.narration_check.status,'FAIL');
  assert.match(result.error,/flagged/);
  assert.ok(fs.existsSync(result.narration_check.review_html));
});

test('gate rejects explicit no-ASR on narrated project without a waiver', t=>{
  const p = fixture(t);
  const r = cli('render',p.dir,'--allow-code','--gate','--no-asr','--json');
  assert.equal(r.status,1,r.stdout+r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.narration_check.status,'SKIPPED');
  assert.match(result.error,/allow-asr-skip/);
});

test('CLI validation rejects malformed project narration check configuration', t=>{
  const p=fixture(t);
  for(const invalid of [null,[],{unknown:'x'},{params:null}]) {
    p.data.narrationCheck=invalid; fs.writeFileSync(p.file,JSON.stringify(p.data));
    const r=cli('validate',p.dir,'--json');
    assert.equal(r.status,1,r.stdout+r.stderr);
    assert.match(r.stdout,/narrationCheck/);
  }
});


test('snapshot replay freezes ASR model and parameters over project, CLI and environment defaults', t=>{
  const p=fixture(t);
  const out=path.join(p.dir,'out');
  const film=checkFilm(p.dir).film;
  const frozen={model:'large-v3',fallbackModel:null,params:{beam_size:3,vad_filter:false,condition_on_previous_text:false},comparatorVersion:'2'};
  const snapshot=createSnapshot(film,p.file,out,{renderOptions:{narrationCheck:frozen,noAsr:false,asrWaiver:null}});
  const r=cli('render',p.dir,'--allow-code','--release','--snapshot',snapshot.id,'--asr-model','small','--out',out,'--json');
  assert.equal(r.status,1,r.stdout+r.stderr);
  const result=JSON.parse(r.stdout);
  assert.equal(result.narration_check.status,'SKIPPED');
  assert.deepEqual(result.narration_check.config,{...frozen,comparatorVersion:COMPARATOR_VERSION});
});
