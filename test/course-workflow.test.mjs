import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { initFilm, validateFilm, filmWords, filmCaptions } from '../src/film.mjs';
import { retimeFilm } from '../src/retime.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'mu-course-'));
  initFilm({lang:'zh',format:'square'},dir);
  const file=path.join(dir,'film.json'), data=JSON.parse(fs.readFileSync(file));
  Object.assign(data,{duration:2,music:'none',voiceover:{dir:'voiceover',engine:'azure'},shots:[{id:'a',start:0,end:2,duration:'narration',tail:.4,purpose:'math',action:'move the number',narration:{zh:{say:'一百六十次',text:'160 次'}}}]});
  const vo=path.join(dir,'voiceover'); fs.mkdirSync(path.join(vo,'zh'),{recursive:true});
  const clip=path.join(vo,'zh','a.mp3');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=duration=0.6','-y',clip]);
  const rec={text:'一百六十次',sha:crypto.createHash('sha256').update(fs.readFileSync(clip)).digest('hex'),engine:'azure',voice:'zh-CN-YunxiNeural',rate:'+0%',words:[{text:'一百六十次',start:.1,end:.5}],cues:[{text:'一百六十次',start:0,end:.6}]};
  fs.writeFileSync(path.join(vo,'.motion-use-voiceover.json'),JSON.stringify({'zh/a.mp3':rec}));
  fs.writeFileSync(file,JSON.stringify(data));
  return {dir,file,data,clip};
}

test('#76 spoken word boundaries survive display-only revisions, stale audio still invalidates them',()=>{
  const p=fixture();
  for(const text of ['160 次','一百六十（160）次']) {
    p.data.shots[0].narration.zh.text=text;
    const c=validateFilm(p.data,p.dir); assert.deepEqual(c.errors,[]);
    const tracks=c.film.tracks.filter(t=>t.role==='voiceover');
    const words=filmWords(c.film,'zh',tracks);
    assert.equal(words.length,1); assert.equal(words[0].text,'一百六十次'); assert.equal(words[0].estimated,false);
    assert.ok(filmCaptions(c.film,'zh',tracks).every(c=>c.estimated));
  }
  fs.appendFileSync(p.clip,'changed');
  const c=validateFilm(p.data,p.dir);
  assert.deepEqual(filmWords(c.film,'zh',c.film.tracks.filter(t=>t.role==='voiceover')),[]);
});

test('#77 each retime iteration returns fresh proposal and preserves every previous output',()=>{
  const p=fixture(), first=retimeFilm(p.dir);
  const previous=fs.readFileSync(first.film);
  p.data.shots[0].tail=1; fs.writeFileSync(p.file,JSON.stringify(p.data));
  const second=retimeFilm(p.dir);
  assert.notEqual(first.film,second.film); assert.match(second.film,/retimed-2.json$/);
  assert.ok(second.duration>first.duration);
  assert.deepEqual(fs.readFileSync(first.film),previous);
  assert.equal(JSON.parse(fs.readFileSync(p.file)).shots[0].tail,1);
  assert.throws(()=>retimeFilm(p.dir,{out:first.film}),/old timeline/);
});

test('narration phase defers missing music and picture while full validation still rejects them',()=>{
  const p=fixture();
  p.data.music={file:'not-yet-composed.wav'};
  p.data.assets={figure:'not-yet-drawn.png'};
  fs.writeFileSync(p.file,JSON.stringify(p.data));
  assert.deepEqual(validateFilm(p.data,p.dir,{phase:'narration'}).errors,[]);
  assert.ok(validateFilm(p.data,p.dir).errors.some(e=>e.path==='$.music.file'));
  const withoutPicture = {...p.data,assets:{}}; fs.writeFileSync(p.file,JSON.stringify(withoutPicture));
  assert.ok(retimeFilm(p.dir).ok);
  fs.writeFileSync(p.file,JSON.stringify(p.data));
  const r=spawnSync(process.execPath,['bin/motion-use.mjs','voiceover',p.dir,'--engine','azure','--json'],{encoding:'utf8',env:{...process.env,AZURE_SPEECH_KEY:'',MOTION_USE_NO_UPDATE_CHECK:'1'}});
  assert.equal(r.status,0,r.stderr+r.stdout);
  assert.equal(JSON.parse(r.stdout).files[0].status,'unchanged');
  assert.equal(JSON.parse(fs.readFileSync(p.file)).music.file,'not-yet-composed.wav');
});
