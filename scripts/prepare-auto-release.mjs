// Main CI is the gate. Never use a bot tag push as a workflow trigger: GITHUB_TOKEN
// pushes do not trigger another push workflow. The caller invokes Release directly.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
export const VERSION_FILES=['package.json','package-lock.json','.claude-plugin/plugin.json','native/motion-render/Cargo.toml','native/Cargo.lock'];
const parse=v=>{if(!/^\d+\.\d+\.\d+$/.test(v))throw Error(`stable semver required: ${v}`);return v.split('.').map(Number);};
const compare=(a,b)=>{const x=parse(a),y=parse(b);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2];};
export function nextVersion(current,latest,messages='') {
  parse(current);
  if(!latest || compare(current,latest)>0)return current;
  if(compare(current,latest)<0)throw Error(`package version ${current} is behind ${latest}`);
  const parts=parse(current);
  const major=/^BREAKING[ -]CHANGE:\s*\S/m.test(messages)||/^[a-z]+(?:\([^\n)]*\))?!:/m.test(messages);
  const minor=/^feat(?:\([^\n)]*\))?:/m.test(messages);
  return major?`${parts[0]+1}.0.0`:minor?`${parts[0]}.${parts[1]+1}.0`:`${parts[0]}.${parts[1]}.${parts[2]+1}`;
}
function versions(cwd) {
  const read=f=>fs.readFileSync(path.join(cwd,f),'utf8');
  const pkg=JSON.parse(read(VERSION_FILES[0])),lock=JSON.parse(read(VERSION_FILES[1])),plugin=JSON.parse(read(VERSION_FILES[2]));
  const crate=read(VERSION_FILES[3]).match(/^version = "([^"]+)"$/m)?.[1];
  const rust=read(VERSION_FILES[4]).match(/\[\[package\]\]\nname = "motion-render"\nversion = "([^"]+)"/)?.[1];
  const all=[pkg.version,lock.version,lock.packages?.['']?.version,plugin.version,crate,rust];
  if(all.some(v=>v!==pkg.version))throw Error(`version files disagree: ${JSON.stringify(all)}`);
  parse(pkg.version); return pkg.version;
}
export function writeVersions(cwd,version) {
  parse(version);versions(cwd);
  for(const file of VERSION_FILES.slice(0,3)) {
    const full=path.join(cwd,file),data=JSON.parse(fs.readFileSync(full,'utf8'));
    data.version=version;if(file==='package-lock.json')data.packages[''].version=version;
    fs.writeFileSync(full,JSON.stringify(data,null,2)+'\n');
  }
  for(const file of VERSION_FILES.slice(3)) {
    const full=path.join(cwd,file),text=fs.readFileSync(full,'utf8');
    fs.writeFileSync(full,file.endsWith('Cargo.toml')?text.replace(/^version = "[^"]+"$/m,`version = "${version}"`):text.replace(/(\[\[package\]\]\nname = "motion-render"\nversion = ")[^"]+("\n)/,`$1${version}$2`));
  }
  versions(cwd);
}
export function prepareRelease({cwd=process.cwd(),expectedHead,publish=false,releaseExists=tag=>{
  const result=JSON.parse(execFileSync('gh',['api',`repos/${process.env.GITHUB_REPOSITORY}/releases`,'--paginate','--slurp'],{encoding:'utf8'}));
  return result.flat().some(r=>r.tag_name===tag&&!r.draft);
}}={}) {
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
  const head=git('rev-parse','HEAD');
  if(!/^[a-f0-9]{40}$/.test(expectedHead??'')||head!==expectedHead)throw Error('checkout must match the CI-tested SHA');
  if(git('rev-parse','origin/main')!==head)return {ready:false,reason:'main advanced; its own CI will release the newer head'};
  if(git('status','--porcelain'))throw Error('release checkout must be clean');
  const tags=git('tag','--merged','HEAD','--list','v*').split('\n').filter(t=>/^v\d+\.\d+\.\d+$/.test(t)).sort((a,b)=>compare(a.slice(1),b.slice(1)));
  const latestTag=tags.at(-1),current=versions(cwd);
  const messages=git('log',...(latestTag?[`${latestTag}..HEAD`]:['HEAD']),'--format=%B');
  if(latestTag && git('rev-list','--count',`${latestTag}..HEAD`)==='0') {
    if(current!==latestTag.slice(1))throw Error('tag and package version disagree');
    return {ready:!releaseExists(latestTag),tag:latestTag,version:current,ref:head,reason:'existing tag; only retry an unpublished release'};
  }
  const version=nextVersion(current,latestTag?.slice(1),messages),tag=`v${version}`;
  // Never move any existing tag, including an unmerged branch's tag.
  if(git('tag','--list',tag))throw Error(`tag ${tag} already exists; refusing to move it`);
  if(!publish)return {ready:true,version,tag,ref:head,needsVersionCommit:version!==current,dryRun:true};
  if(version!==current) {
    writeVersions(cwd,version);
    git('add','--',...VERSION_FILES);
    git('-c','user.name=github-actions[bot]','-c','user.email=41898282+github-actions[bot]@users.noreply.github.com','commit','-m',`chore(release): ${tag} [skip ci]`);
  }
  const ref=git('rev-parse','HEAD');
  git('tag',tag,ref);
  // Branch race or denied protection fails atomically; no force pushes or partial tags.
  git('push','--atomic','origin','HEAD:refs/heads/main',`refs/tags/${tag}`);
  return {ready:true,version,tag,ref};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const result=prepareRelease({expectedHead:process.env.TESTED_SHA,publish:process.argv.includes('--publish')});
  if(process.env.GITHUB_OUTPUT)for(const key of ['ready','version','tag','ref'])if(result[key]!==undefined)fs.appendFileSync(process.env.GITHUB_OUTPUT,`${key}=${result[key]}\n`);
  console.log(JSON.stringify(result,null,2));
}
