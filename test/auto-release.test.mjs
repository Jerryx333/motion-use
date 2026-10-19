import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {nextVersion,prepareRelease,VERSION_FILES} from '../scripts/prepare-auto-release.mjs';
function fixture(t){
 const base=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'mu-auto-release-')),cwd=path.join(base,'work'),remote=path.join(base,'remote.git');fs.mkdirSync(cwd);
 t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 execFileSync('git',['init','--bare',remote],{stdio:'ignore'});git('init','-b','main');git('config','user.name','Test');git('config','user.email','test@example.invalid');git('remote','add','origin',remote);
 const write=(file,text)=>{fs.mkdirSync(path.dirname(path.join(cwd,file)),{recursive:true});fs.writeFileSync(path.join(cwd,file),text);};
 write('package.json',JSON.stringify({name:'fixture',version:'0.16.0'}));write('package-lock.json',JSON.stringify({version:'0.16.0',packages:{'':{version:'0.16.0'}}}));write('.claude-plugin/plugin.json',JSON.stringify({version:'0.16.0'}));write('native/motion-render/Cargo.toml','[package]\nname = "motion-render"\nversion = "0.16.0"\n');write('native/Cargo.lock','version = 4\n\n[[package]]\nname = "motion-render"\nversion = "0.16.0"\n');
 git('add','.');git('commit','-m','initial');git('tag','v0.16.0');git('push','--atomic','origin','main','v0.16.0');git('fetch','origin');
 const change=(message='fix: change')=>{write('source.txt',message);git('add','.');git('commit','-m',message);git('push','origin','main');return git('rev-parse','HEAD');};
 return{cwd,remote,git,write,change};
}
test('automatic version policy preserves prepared versions and selects conventional increments',()=>{
 assert.equal(nextVersion('0.17.0','0.16.0','feat: new'),'0.17.0');
 assert.equal(nextVersion('0.17.0','0.17.0','docs: update'),'0.17.1');
 assert.equal(nextVersion('0.17.0','0.17.0','feat(api): new'),'0.18.0');
 assert.equal(nextVersion('0.17.0','0.17.0','feat!: incompatible'),'1.0.0');
 assert.equal(nextVersion('0.17.0','0.17.0','fix: change\n\nBREAKING CHANGE: input contract'),'1.0.0');
 assert.throws(()=>nextVersion('0.15.0','0.16.0'),/behind/);
});
test('dry run leaves Git and versions untouched; published head is idempotent',t=>{
 const p=fixture(t),head=p.git('rev-parse','HEAD');
 assert.equal(prepareRelease({...p,expectedHead:head,releaseExists:()=>true}).ready,false);
 assert.equal(prepareRelease({...p,expectedHead:head,releaseExists:()=>false}).tag,'v0.16.0');
 const source=p.change('feat: new');const plan=prepareRelease({...p,expectedHead:source});
 assert.equal(plan.version,'0.17.0');assert.equal(plan.dryRun,true);assert.equal(p.git('status','--porcelain'),'');assert.equal(p.git('tag','--list','v0.17.0'),'');
});
test('publication atomically pushes synchronized versions and a pinned tag; retry does not bump again',t=>{
 const p=fixture(t),head=p.change('feat: new');
 const result=prepareRelease({...p,expectedHead:head,publish:true});
 assert.equal(result.version,'0.17.0');assert.notEqual(result.ref,head);
 assert.equal(p.git('rev-parse','origin/main'),result.ref);assert.equal(p.git('rev-parse','v0.17.0'),result.ref);
 assert.deepEqual(p.git('diff-tree','--no-commit-id','--name-only','-r','HEAD').split('\n').sort(),[...VERSION_FILES].sort());
 assert.match(fs.readFileSync(path.join(p.cwd,'native/Cargo.lock'),'utf8'),/name = "motion-render"\nversion = "0.17.0"/);
 const retry=prepareRelease({...p,expectedHead:result.ref,publish:true,releaseExists:()=>false});assert.equal(retry.ref,result.ref);assert.equal(retry.tag,result.tag);
});
test('prepared version releases without another bump or source commit',async t=>{
 const p=fixture(t);const {writeVersions}=await import('../scripts/prepare-auto-release.mjs');writeVersions(p.cwd,'0.17.0');p.git('add','.');p.git('commit','-m','feat: prepared');p.git('push','origin','main');const head=p.git('rev-parse','HEAD');
 const result=prepareRelease({...p,expectedHead:head,publish:true});assert.equal(result.ref,head);assert.equal(result.tag,'v0.17.0');
});
test('stale CI head, dirty source, mismatched versions and tag collisions cannot publish',t=>{
 const p=fixture(t),head=p.change();
 assert.throws(()=>prepareRelease({...p,expectedHead:'0'.repeat(40)}),/CI-tested SHA/);
 p.git('update-ref','refs/remotes/origin/main',p.git('rev-parse','HEAD^'));
 assert.equal(prepareRelease({...p,expectedHead:head}).ready,false);p.git('update-ref','refs/remotes/origin/main',head);
 p.write('extra','dirty');assert.throws(()=>prepareRelease({...p,expectedHead:head}),/clean/);fs.unlinkSync(path.join(p.cwd,'extra'));
 p.write('package.json',JSON.stringify({version:'9.0.0'}));p.git('add','.');p.git('commit','-m','mismatch');p.git('push','origin','main');assert.throws(()=>prepareRelease({...p,expectedHead:p.git('rev-parse','HEAD')}),/disagree/);
});
test('a racing main push rejects the whole tag+branch transaction without moving the remote',t=>{
 const p=fixture(t),head=p.change('fix: patch');
 // A pre-receive hook simulates a protected branch/remote race, rejecting all refs.
 fs.writeFileSync(path.join(p.remote,'hooks','pre-receive'),'#!/bin/sh\nexit 1\n',{mode:0o755});
 assert.throws(()=>prepareRelease({...p,expectedHead:head,publish:true}));
 assert.equal(execFileSync('git',['--git-dir',p.remote,'rev-parse','main'],{encoding:'utf8'}).trim(),head);
 assert.equal(execFileSync('git',['--git-dir',p.remote,'tag','--list','v0.16.1'],{encoding:'utf8'}).trim(),'');
});
test('an unmerged tag collision is refused without moving either existing tag or main',t=>{
 const p=fixture(t),head=p.change('fix: patch');
 p.git('checkout','-b','other','HEAD^');p.write('other.txt','other source');p.git('add','.');p.git('commit','-m','other');p.git('tag','v0.16.1');const tag=p.git('rev-parse','v0.16.1');p.git('checkout','main');
 assert.throws(()=>prepareRelease({...p,expectedHead:head,publish:true}),/already exists/);
 assert.equal(p.git('rev-parse','v0.16.1'),tag);assert.equal(p.git('rev-parse','origin/main'),head);
});
