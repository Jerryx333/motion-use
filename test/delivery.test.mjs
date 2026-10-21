import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { packageDelivery, checkDelivery, DELIVERY_MANIFEST } from '../src/delivery.mjs';

const available = (() => { try { execFileSync('ffmpeg',['-version'],{stdio:'ignore'}); execFileSync('ffprobe',['-version'],{stdio:'ignore'}); return true; } catch { return false; } })();
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'motion-delivery-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=red:s=64x64:r=10:d=0.4','-c:v','libx264','-pix_fmt','yuv420p',path.join(dir,'source.mp4')]);
  const config = path.join(dir,'delivery.json');
  fs.writeFileSync(config,JSON.stringify({title:'中文数学 <课程>',mode:'offline',courses:[{title:'A01 加法 <题>',file:'source.mp4',chapters:[{title:'读题',start:0},{title:'答案',start:0.2}]}]}));
  return {dir, config};
}

test('delivery creates three portable modes with decodable media and truthful review status', {skip:!available}, t=> {
  const {dir,config} = fixture(t);
  for (const mode of ['videos','offline','site']) {
    const out = path.join(dir,mode);
    const result = packageDelivery(config,{out,mode});
    assert.equal(result.ok,true);
    const manifest = JSON.parse(fs.readFileSync(result.manifest));
    assert.equal(manifest.verification.decode,'PASS');
    assert.equal(manifest.verification.targetDevice,'UNREVIEWED');
    assert.equal(manifest.verification.humanAudiovisual,'UNREVIEWED');
    assert.equal(manifest.compatibility.find(c=>c.environment.startsWith('iPad')).status,'unknown');
    assert.equal(fs.existsSync(path.join(out,'index.html')),mode !== 'videos');
    if (mode !== 'videos') {
      const html = fs.readFileSync(path.join(out,'index.html'),'utf8').replace(/<script>[\s\S]*?<\/script>/g,'');
      assert.match(html,/A01 加法 &lt;题&gt;/);
      assert.match(html,/读题/);
      assert.match(html,/<video/);
    }
    fs.renameSync(out,path.join(dir,mode+' moved'));
  }
  fs.rmSync(path.join(dir,'source.mp4')); fs.rmSync(config);
  for (const mode of ['videos','offline','site']) assert.equal(checkDelivery(path.join(dir,mode+' moved')).ok,true);
});

test('delivery check detects missing, changed, and escaped dependencies', {skip:!available}, t=> {
  const {dir,config} = fixture(t), out = path.join(dir,'package');
  const {manifest: mf} = packageDelivery(config,{out});
  const manifest = JSON.parse(fs.readFileSync(mf));
  const video = path.join(out,manifest.courses[0].file), saved = fs.readFileSync(video);
  fs.writeFileSync(video,'damaged');
  let result = checkDelivery(out);
  assert.equal(result.ok,false); assert.match(result.errors.join(' '),/hash mismatch/);
  fs.writeFileSync(video,saved); fs.rmSync(path.join(out,'index.html'));
  assert.equal(checkDelivery(out).ok,false);
  manifest.files[0].file = '../source.mp4';
  fs.writeFileSync(mf,JSON.stringify(manifest));
  result = checkDelivery(out);
  assert.equal(result.ok,false); assert.match(result.errors.join(' '),/unsafe relative path/);
});

test('delivery rejects source traversal, symlinks, stale hashes, bad chapters and existing output', {skip:!available}, t=> {
  const {dir,config} = fixture(t), original = JSON.parse(fs.readFileSync(config));
  const write = c => fs.writeFileSync(config,JSON.stringify(c));
  write({...original,courses:[{title:'bad',file:'../source.mp4'}]});
  assert.throws(()=>packageDelivery(config,{out:path.join(dir,'bad')}),/unsafe relative path/);
  fs.symlinkSync(path.join(dir,'source.mp4'),path.join(dir,'link.mp4'));
  write({...original,courses:[{title:'bad',file:'link.mp4'}]});
  assert.throws(()=>packageDelivery(config,{out:path.join(dir,'bad')}),/symlink/);
  write({...original,courses:[{...original.courses[0],sha256:'0'.repeat(64)}]});
  assert.throws(()=>packageDelivery(config,{out:path.join(dir,'bad')}),/input hash mismatch/);
  write({...original,courses:[{...original.courses[0],chapters:[{title:'late',start:5}]}]});
  assert.throws(()=>packageDelivery(config,{out:path.join(dir,'bad')}),/chapter/);
  write(original);
  assert.throws(()=>packageDelivery(config,{out:dir}),/already exists/);
  assert.equal(fs.existsSync(path.join(dir,'bad')),false);
});

test('delivery does not accept an MP4 suffix as decode evidence', {skip:!available}, t=> {
  const {dir,config} = fixture(t);
  fs.writeFileSync(path.join(dir,'source.mp4'),'not an mp4');
  assert.throws(()=>packageDelivery(config,{out:path.join(dir,'bad')}));
  assert.equal(fs.existsSync(path.join(dir,'bad')),false);
});

test('delivery chapter bounds use video duration instead of a longer AAC/container tail', {skip:!available}, t=> {
  const {dir,config} = fixture(t);
  const source = path.join(dir,'tailed.mp4');
  // Exactly 30 video frames (1 s), with an AAC audio tail extending the container.
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=red:s=64x64:r=30:d=1','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1.08','-c:v','libx264','-c:a','aac',source]);
  const course = {title:'tail',file:'tailed.mp4',chapters:[{title:'inside video',start:0.9}]};
  fs.writeFileSync(config,JSON.stringify({title:'timeline',mode:'videos',courses:[course]}));
  const out = path.join(dir,'valid');
  const r = packageDelivery(config,{out});
  const manifest = JSON.parse(fs.readFileSync(r.manifest));
  assert.equal(manifest.courses[0].media.videoDuration,1);
  assert.ok(manifest.courses[0].media.containerDuration > 1.05);
  assert.equal(manifest.courses[0].media.videoDurationSource,'video-stream-duration');
  course.chapters = [{title:'AAC tail is not a chapter',start:1.03}];
  fs.writeFileSync(config,JSON.stringify({title:'timeline',mode:'videos',courses:[course]}));
  assert.throws(()=>packageDelivery(config,{out:path.join(dir,'bad-tail')}),/chapter/);
  // The checker independently probes the real media rather than trusting stored facts.
  manifest.courses[0].chapters = course.chapters;
  manifest.courses[0].media.videoDuration = 99;
  fs.writeFileSync(path.join(out,DELIVERY_MANIFEST),JSON.stringify(manifest));
  const checked = checkDelivery(out);
  assert.equal(checked.ok,false);
  assert.match(checked.errors.join(' '),/chapter/);
});
