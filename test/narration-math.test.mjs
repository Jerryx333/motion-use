import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { checkNarration, compareNarration, resolveNarrationCheckConfig, writeNarrationReview } from '../src/narration-check.mjs';

// Texts reported by the 26-course feedback. These are transcript regression fixtures,
// not original audio recordings or proof that any real recording was correct.
test('math differences survive homophone tolerance and high line similarity', () => {
  for (const [script, heard] of [
    ['一加五是六', '1加56'],
    ['1-1', '1 1'],
    ['-1', '1'],
    ['1/2', '1 2'],
    ['六减二等于四', '六加二等于四'],
    ['这道题先不要拿走三个红点，数完再开始。', '这道题先要拿走三个红点，数完再开始。'],
    ['十个点拿走三个还剩七个', '十个点拿走四个还剩七个'],
    ['结果是6', '结果是七'],
    ['结果是六', '结果是7'],
    ['6减', '六简'],
    ['从后数', '从后说'],
  ]) assert.equal(compareNarration(script, heard, 'zh', { chars: { 减: ['jian'], 简: ['jian'] }, tones: { 减: ['jian3'], 简: ['jian3'] } }).flagged, true, `${script} / ${heard}`);
  assert.equal(compareNarration('一加五是六', '1加5是6', 'zh').flagged, false);
  assert.equal(compareNarration('两百六十八加二等于两百七十', '268加2等于270', 'zh').flagged, false);
});

test('flagged-only fallback preserves primary evidence; automatic pass is not listening approval', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-asr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const items = ['a', 'b'].map((id) => { const file = path.join(dir, `${id}.wav`); fs.writeFileSync(file, id); return { id, file, lang: 'zh', text: '一加五是六' }; });
  const calls = [];
  const run = ({model,items}) => { calls.push({model,files:items.map((i)=>i.file)}); return {items:items.map((i)=>({file:i.file,text:model==='small' && i.file.endsWith('a.wav')?'1加56':'1加5是6'}))}; };
  const result = checkNarration(items, { dir, run, model: 'small', fallbackModel: 'medium' });
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.cache, { hits: 0, misses: 3 });
  assert.equal(result.human_review, 'UNREVIEWED');
  assert.equal(result.lines[0].attempts[0].status, 'FAIL');
  assert.equal(result.lines[0].attempts[1].status, 'PASS');
  assert.deepEqual(calls.map((c)=>[c.model,c.files.length]), [['small',2],['medium',1]]);
  checkNarration(items, { dir, run, model: 'medium' });
  const cached = checkNarration(items, { dir, run, model: 'small', fallbackModel: 'medium' });
  assert.deepEqual(cached.cache, { hits: 3, misses: 0 });
  assert.equal(calls.length, 3, 'only the previously clean primary clip needs medium on model switch');
  const changed = checkNarration([{...items[0],text:'一加五是七'}], {dir,run,model:'small',fallbackModel:'medium'});
  assert.equal(changed.status, 'FAIL', 'script changes must recompare cached transcripts');
  assert.equal(calls.length, 3);
  const html = path.join(dir, 'reviews', 'asr.html');
  writeNarrationReview(result, html);
  const content = fs.readFileSync(html, 'utf8');
  assert.match(content, /src="..\/a.wav"/);
  assert.match(content, /small — FAIL/);
  assert.match(content, /medium — PASS/);
});

test('content cache separates language and params and never caches partial results as silence', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-asr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'a.wav'); fs.writeFileSync(file,'clip');
  const item = {id:'a',file,lang:'zh',text:'一'}; let calls=0;
  const run = ({items}) => { calls++; return {items:items.map((i)=>({file:i.file,text:'一'}))}; };
  checkNarration([item],{dir,run});
  checkNarration([item],{dir,run,params:{beam_size:3}});
  checkNarration([{...item,lang:'zh-CN'}],{dir,run});
  const copy = path.join(dir,'copy.wav'); fs.copyFileSync(file,copy);
  checkNarration([{...item,file:copy}],{dir,run});
  assert.equal(calls,3,'identical bytes in a different file reuse recognition');
  const missing = checkNarration([item],{dir,force:true,run:()=>({items:[]})});
  assert.equal(missing.status,'UNREVIEWED');
  assert.equal(missing.ok,false);
  const skipped = checkNarration([item],{dir,force:true,run:()=>({skipped:'offline'})});
  assert.equal(skipped.status,'SKIPPED');
  assert.deepEqual(skipped.cache,{hits:0,misses:1});
  assert.deepEqual(checkNarration([], {dir,run}).cache,{hits:0,misses:0});
  assert.equal(skipped.human_review,'UNREVIEWED');
});

test('project configuration is pinned, validated and overridable',()=>{
  assert.deepEqual(resolveNarrationCheckConfig({narrationCheck:{model:'medium',fallbackModel:'large',params:{beam_size:3}}},{},{MOTION_USE_ASR_MODEL:'small'}),{
    model:'medium',fallbackModel:'large',params:{beam_size:3,vad_filter:false,condition_on_previous_text:false},comparatorVersion:'4'
  });
  assert.equal(resolveNarrationCheckConfig({narrationCheck:{model:'medium'}},{model:'small'}).model,'small');
  assert.throws(()=>resolveNarrationCheckConfig({narrationCheck:{params:{initial_prompt:'expected answer'}}}),/unsupported/);
});


test('malformed project check configuration fails explicitly', () => {
  for (const narrationCheck of [null, 'medium', [], 7, { typo: 'medium' }, { params: null }, { params: [] }, { params: 'fast' }]) {
    assert.throws(() => resolveNarrationCheckConfig({ narrationCheck }), /narrationCheck/);
  }
});

test('concurrent checks merge disjoint records atomically', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-asr-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const id of ['a', 'b']) fs.writeFileSync(path.join(dir, `${id}.wav`), id);
  const moduleURL = new URL('../src/narration-check.mjs', import.meta.url).href;
  const jobs = ['a', 'b'].map((id) => new Promise((resolve, reject) => {
    const source = `
      import fs from 'node:fs';
      import path from 'node:path';
      import { checkNarration } from ${JSON.stringify(moduleURL)};
      const dir=${JSON.stringify(dir)}, id=${JSON.stringify(id)};
      const file=path.join(dir,id+'.wav');
      checkNarration([{id,file,lang:'zh',text:'一'}],{dir,run:()=>{
        fs.writeFileSync(path.join(dir,id+'.ready'),'ready');
        const until=Date.now()+5000;
        while(!fs.existsSync(path.join(dir,(id==='a'?'b':'a')+'.ready'))){
          if(Date.now()>until)throw new Error('barrier timeout');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
        }
        return {items:[{file,text:'一'}]};
      }});
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  }));
  await Promise.all(jobs);
  const cache = JSON.parse(fs.readFileSync(path.join(dir, '.motion-use-asr.json'), 'utf8'));
  assert.equal(Object.keys(cache.records).length, 2);
  assert.equal(fs.existsSync(path.join(dir, '.motion-use-asr.json.lock')), false);
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
});
