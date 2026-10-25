import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {initFilm,validateFilm} from '../src/film.mjs';
import {compareNarration,checkNarration} from '../src/narration-check.mjs';
import {redactImage} from '../src/redact.mjs';
import {reviewScript,reviewRisks,scriptReviewPrompt,requestScriptReview} from '../src/script-review.mjs';
const require=createRequire(import.meta.url), sharp=createRequire(require.resolve('hyperframes/package.json'))('sharp');
const temp=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'mu-99-101-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};
test('#99 canonicalizes traditional script, currency and spoken storage units',()=>{
  for(const [a,b,lang] of [['没货，机器在东方','沒貨，機器在東方','zh'],['十 T B','10 TB','zh'],['zero dollars','$0','en'],['两百六十八','268','zh']])assert.equal(compareNarration(a,b,lang).flagged,false,`${a} / ${b}`);
  for(const [a,b]of [['十 TB','11TB'],['没有货','有货'],['一加五是六','1加56'],['十点五','10.6']])assert.equal(compareNarration(a,b,'zh').flagged,true);
});
test('#99 accent warnings preserve negation, names, low similarity and human review state',t=>{
  const lex={chars:{林:['lin'],陵:['ling']},tones:{林:['lin2'],陵:['ling2']},accent:'zh-TW'};
  const script='现在请打开林先生的账户页面',heard='现在请打开陵先生的账户页面';
  assert.equal(compareNarration(script,heard,'zh',lex).warning?.startsWith('accent'),true);
  assert.equal(compareNarration(script,heard,'zh',{...lex,terms:['林先生']}).flagged,true);
  assert.equal(compareNarration('林','陵','zh',lex).flagged,true);
  assert.equal(compareNarration('不要拿走林先生的账户','要拿走陵先生的账户','zh',lex).flagged,true);
  const dir=temp(t), file=path.join(dir,'a.wav');fs.writeFileSync(file,'audio');
  const run=()=>({items:[{file,text:'九个'}]});
  const result=checkNarration([{file,id:'a',lang:'zh',text:'十个'}],{dir,run,allowNarrationFlags:'作者确认这一句，保留其余识别'});
  assert.equal(result.status,'WARNING');assert.equal(result.lines[0].waiver.heard,'九个');assert.equal(result.human_review,'UNREVIEWED');
  const missing=checkNarration([{file,id:'a',lang:'zh',text:'十个'}],{dir,run:()=>({items:[]}),force:true,allowNarrationFlags:'reason'});
  assert.equal(missing.status,'UNREVIEWED');assert.equal(missing.lines[0].waiver,undefined);
});
test('#100 focusShot clamps edges, stays deterministic and steps follow duration ratios',()=>{
  const env={window:{}};vm.runInNewContext(fs.readFileSync(new URL('../src/film-kit.js',import.meta.url),'utf8'),env);
  const M=env.window.__filmKit({width:1080,height:1920,vertical:true,safe:{x:65,y:192,w:864,h:1267}},{});
  const c=new Proxy({measureText:()=>({width:100})},{get:(o,k)=>k in o?o[k]:(()=>{})});
  const img={width:640,height:480},r=M.tutorialLayout();
  assert.ok(r.y+r.h<1459-150);
  for(const box of [[0,0,80,80],[560,400,80,80]]){
    const a=M.focusShot(c,2,img,box,r);M.focusShot(c,0,img,box,r);const b=M.focusShot(c,2,img,box,r);
    assert.equal(JSON.stringify(a),JSON.stringify(b));assert.ok(a.image.x<=r.x && a.image.y<=r.y);assert.ok(a.image.x+a.image.w>=r.x+r.w-.001);
  }
  const step={n:1,title:'Setup',frames:[{img,at:0,box:[0,0,80,80]},{img,at:.5,box:[400,200,80,80]}]};
  assert.equal(M.steps(c,4,step,{duration:10}).index,0);assert.equal(M.steps(c,8,step,{duration:20}).index,0);assert.equal(M.steps(c,12,step,{duration:20}).index,1);
  assert.throws(()=>M.focusShot(c,1,img,[-1,0,10,10]),/in-bounds/);
});
test('#100 tutorial scaffolds validate; redaction changes only selected source pixels',async t=>{
  const dir=temp(t);initFilm({mode:'tutorial',lang:'en'},dir);
  const film=JSON.parse(fs.readFileSync(path.join(dir,'film.json')));assert.deepEqual(validateFilm(film,dir).errors,[]);assert.equal(film.formats[0],'vertical');
  const source=path.join(dir,'in.png'),out=path.join(dir,'out.png');
  const pixels=Buffer.alloc(100*100*3);for(let y=0;y<100;y++)for(let x=0;x<100;x++)pixels.fill((x%2)*255,(y*100+x)*3,(y*100+x)*3+3);
  await sharp(pixels,{raw:{width:100,height:100,channels:3}}).png().toFile(source);
  await redactImage(source,{out,boxes:[[20,20,40,40]]});const result=await sharp(out).removeAlpha().raw().toBuffer();
  assert.deepEqual(result.subarray(0,300),pixels.subarray(0,300));assert.notEqual(result[(40*100+40)*3],pixels[(40*100+40)*3]);
  await assert.rejects(redactImage(source,{out:path.join(dir,'bad.png'),boxes:[[-1,0,10,10]]}),/integer source pixels/);assert.equal(fs.existsSync(path.join(dir,'bad.png')),false);
  await assert.rejects(redactImage(source,{out:source,boxes:[[1,1,2,2]]}),/different/);
});
test('#101 imports review with fact/platform risks without changing the script',async t=>{
  const dir=temp(t);initFilm({lang:'en'},dir);const file=path.join(dir,'film.json');const film=JSON.parse(fs.readFileSync(file));film.brief.facts=['闲置 7 天会回收'];film.brief.platforms=['抖音'];fs.writeFileSync(file,JSON.stringify(film));
  const before=fs.readFileSync(path.join(dir,'SCRIPT.md'),'utf8');const response=path.join(dir,'answer.json');
  fs.writeFileSync(response,JSON.stringify({issues:['钩子弱'],rewrite:'永久免费，实体信用卡，评论区扣套件。闲置 7 天会回收。',alternatives:['先看证据']}));
  const result=await reviewScript(dir,{response});assert.equal(result.status,'UNREVIEWED');
  for(const kind of ['exaggeration','platform','new-fact-candidate','changed-sentence-review'])assert.ok(result.risks.some(x=>x.kind===kind));
  assert.equal(fs.readFileSync(path.join(dir,'SCRIPT.md'),'utf8'),before);assert.match(fs.readFileSync(result.file,'utf8'),/问题清单[\s\S]*修改稿[\s\S]*备选开头和标题/);
  await assert.rejects(reviewScript(dir,{response}),/already exists/);
  assert.match(scriptReviewPrompt(before,film.brief),/闲置 7 天/);assert.match(scriptReviewPrompt(before,{platforms:['YouTube']}),/海外/);
  assert.ok(reviewRisks('新增无数字的承诺。',before,[],[]).some(x=>x.kind==='changed-sentence-review'));
});
test('#101 API transports use provider request/response schemas and never leak service errors',async()=>{
  const answer=JSON.stringify({issues:[],rewrite:'Keep facts.',alternatives:[]});
  for(const reviewer of ['gemini','chatgpt','claude']){
    let sent;
    const fetchImpl=async(url,options)=>{sent={url,...options};return {ok:true,json:async()=>reviewer==='gemini'?{candidates:[{content:{parts:[{text:answer}]}}]}:reviewer==='claude'?{content:[{type:'text',text:answer}]}:{choices:[{message:{content:answer}}]}};};
    assert.equal(await requestScriptReview('prompt',{reviewer,transport:'api',model:'test',env:{GEMINI_API_KEY:'secret',OPENAI_API_KEY:'secret',ANTHROPIC_API_KEY:'secret'},fetchImpl}),answer);assert.match(sent.body,/prompt/);assert.equal(sent.redirect,'error');
  }
  await assert.rejects(requestScriptReview('p',{reviewer:'gemini',transport:'api',model:'x',env:{GEMINI_API_KEY:'secret'},fetchImpl:async()=>({ok:false,status:429})}),/^Error: review API returned HTTP 429$/);
});
test('#101 browser invokes a fresh chrome-use session once and cleans it up',async()=>{
  const calls=[];const answer='{"issues":[],"rewrite":"review","alternatives":[]}';
  const execImpl=async(file,args)=>{calls.push({file,args});return {stdout:JSON.stringify({data:[{response:answer}]})};};
  assert.equal(await requestScriptReview('prompt',{reviewer:'gemini',transport:'browser',execImpl}),answer);
  assert.equal(calls.length,2);assert.ok(calls[0].args.includes('gemini/ask'));assert.equal(calls[0].args[1],calls[1].args[1]);assert.equal(calls[1].args.at(-1),'done');
});
