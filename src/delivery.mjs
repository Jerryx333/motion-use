// Portable delivery directories. Packaging is local and never publishes anything.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { probeMedia } from './release.mjs';

export const DELIVERY_MANIFEST = 'delivery-manifest.json';
const MODES = ['videos', 'offline', 'site'];
const sha = file => {
  const h = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), buf = Buffer.alloc(1024 * 1024);
  try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null))) h.update(buf.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return h.digest('hex');
};
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const url = value => value.split('/').map(encodeURIComponent).join('/');

// Both lexical traversal and symlinks are forbidden, including links inside the root.
function localFile(root, relative) {
  if (typeof relative !== 'string' || !relative || /[\\\x00-\x1f]/.test(relative) || path.isAbsolute(relative) || relative.split('/').some(p => !p || p === '.' || p === '..'))
    throw new Error(`unsafe relative path: ${relative}`);
  let full = root;
  for (const component of relative.split('/')) {
    full = path.join(full, component);
    if (fs.lstatSync(full).isSymbolicLink()) throw new Error(`symlink is not a delivery dependency: ${relative}`);
  }
  if (!fs.statSync(full).isFile()) throw new Error(`not a file: ${relative}`);
  return full;
}

function decode(file) {
  const facts = probeMedia(file);
  if (!facts.width || !facts.height || !Number.isFinite(facts.duration) || facts.duration <= 0 || !facts.fps)
    throw new Error(`${path.basename(file)}: valid video stream required`);
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-err_detect', 'explode', '-i', file, '-map', '0:v:0', '-map', '0:a?', '-f', 'null', '-'], {stdio: ['ignore', 'ignore', 'pipe']});
  } catch (e) { throw new Error(`${path.basename(file)}: decode failed: ${e.stderr?.toString().trim() || e.message}`); }
  // Container duration can include AAC tail padding. Chapter bounds belong to
  // the video stream's presentation duration, not that longer audio/container.
  const timeline = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration,start_time,nb_frames,avg_frame_rate:format=duration', '-of', 'json', file], {encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const stream = timeline.streams?.[0];
  const streamDuration = Number(stream?.duration);
  const [n,d] = String(stream?.avg_frame_rate ?? '0/0').split('/').map(Number);
  const frameDuration = Number(stream?.nb_frames) * d / n;
  const videoDuration = Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : frameDuration;
  if (!Number.isFinite(videoDuration) || videoDuration <= 0) throw new Error(`${path.basename(file)}: video presentation duration unavailable; cannot bound chapters`);
  return {...facts, videoDuration, containerDuration:Number(timeline.format.duration), videoDurationSource:Number.isFinite(streamDuration) && streamDuration > 0 ? 'video-stream-duration' : 'video-frame-count/average-frame-rate'};
}

function chapters(value, duration) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('chapters must be an array');
  let previous = -1;
  return value.map(c => {
    if (!c || typeof c.title !== 'string' || !c.title.trim() || !Number.isFinite(c.start) || c.start < 0 || c.start <= previous || c.start >= duration)
      throw new Error('chapter needs a title and increasing start within the video');
    previous = c.start;
    return {title: c.title, start: c.start};
  });
}

const compatibility = [
  {environment: 'Desktop browser, complete local folder (offline mode)', status: 'expected', note: 'Requires local MP4 playback support; verify on the receiving device.'},
  {environment: 'HTTP(S) website (site mode)', status: 'expected', note: 'Serve the whole folder; test media MIME type and seeking on the target browser.'},
  {environment: 'iPad local HTML / offline PWA', status: 'unknown', note: 'No device acceptance claimed. This package is not a PWA.'},
  {environment: 'Cloud-drive HTML preview, including Quark', status: 'unsupported', note: 'Preview may copy HTML alone to a temporary folder. Download the complete folder or use videos mode.'},
];

function catalog(title, courses) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{font:18px system-ui;max-width:960px;margin:auto;padding:24px}video{width:100%;max-height:70vh}article{margin:3em 0}li{margin:.5em 0}a{overflow-wrap:anywhere}</style><h1>${escape(title)}</h1><p>请保留完整目录。网盘 HTML 预览不能代替网站托管；iPad 本地网页播放尚未实机验收。</p><nav><ol>${courses.map((c,i) => `<li><a href="#course-${i}">${escape(c.title)}</a> · <a href="${url(c.file)}">MP4</a></li>`).join('')}</ol></nav>${courses.map((c,i) => `<article id="course-${i}"><h2>${escape(c.title)}</h2><video id="video-${i}" controls preload="metadata" src="${url(c.file)}"><a href="${url(c.file)}">下载 MP4</a></video><p><a href="${url(c.file)}" download>下载 ${escape(c.title)}</a></p><ol>${c.chapters.map(ch => `<li><a href="${url(c.file)}#t=${ch.start}" data-video="video-${i}" data-start="${ch.start}">${escape(ch.title)} (${ch.start}s)</a></li>`).join('')}</ol></article>`).join('')}<script>document.querySelectorAll('[data-video]').forEach(a=>a.addEventListener('click',e=>{const v=document.getElementById(a.dataset.video);if(v){e.preventDefault();v.currentTime=Number(a.dataset.start);v.scrollIntoView();}}));</script></html>\n`;
}

/** config: {title, mode: videos|offline|site, courses:[{title,file,sha256?,chapters?}]}.
 * Input files are relative to config. options.out must name a fresh directory. */
export function packageDelivery(configFile, options = {}) {
  const configPath = path.resolve(configFile), base = path.dirname(configPath);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const mode = options.mode ?? config.mode;
  if (!MODES.includes(mode) || typeof config.title !== 'string' || !config.title.trim() || !Array.isArray(config.courses) || !config.courses.length)
    throw new Error('delivery needs title, mode (videos|offline|site), and nonempty courses');
  if (!options.out) throw new Error('delivery requires an explicit fresh output directory');
  const out = path.resolve(options.out);
  if (fs.existsSync(out)) throw new Error(`output already exists: ${out}`);
  // Validate every dependency before creating output. Never modify or re-encode originals.
  const inputs = config.courses.map((c,i) => {
    if (!c || typeof c.title !== 'string' || !c.title.trim() || !/\.mp4$/i.test(c.file ?? '')) throw new Error('course needs title and MP4 file');
    const input = localFile(base, c.file), digest = sha(input), facts = decode(input);
    if (c.sha256 !== undefined && c.sha256 !== digest) throw new Error(`input hash mismatch: ${c.file}`);
    const name = `${String(i + 1).padStart(3, '0')} ${c.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0,80) || 'video'}.mp4`;
    return {input, source: c.file, sha256: digest, title: c.title, file: mode === 'videos' ? name : `videos/${name}`, media: facts, chapters: chapters(c.chapters, facts.videoDuration)};
  });
  fs.mkdirSync(path.dirname(out), {recursive:true});
  const staging = fs.mkdtempSync(path.join(path.dirname(out), '.delivery-'));
  try {
    for (const c of inputs) {
      const target = path.join(staging, c.file);
      fs.mkdirSync(path.dirname(target), {recursive:true}); fs.copyFileSync(c.input, target);
      if (sha(target) !== c.sha256) throw new Error(`copy hash mismatch: ${c.source}`);
    }
    const courses = inputs.map(({input, ...c}) => c);
    if (mode !== 'videos') fs.writeFileSync(path.join(staging, 'index.html'), catalog(config.title, courses));
    fs.writeFileSync(path.join(staging, 'README.txt'), `${config.title}\nMode: ${mode}\n${mode === 'videos' ? 'Open each MP4 with a video player.' : mode === 'offline' ? 'Download/extract the complete folder, then open index.html in a desktop browser.' : 'Upload the complete folder to an HTTP(S) static host. No automatic publication was performed.'}\nKeep the whole directory together. Cloud-drive HTML previews are not static hosting.\nNo iPad local playback or full human audiovisual review is claimed.\n`);
    const files = [...courses.map(c => c.file), 'README.txt', ...(mode === 'videos' ? [] : ['index.html'])].map(file => ({file, sha256: sha(path.join(staging,file))}));
    const manifest = {schemaVersion:1, title:config.title, mode, created:new Date().toISOString(), courses, files, compatibility, verification:{decode:'PASS', integrity:'PASS', humanAudiovisual:'UNREVIEWED', targetDevice:'UNREVIEWED'}};
    fs.writeFileSync(path.join(staging, DELIVERY_MANIFEST), JSON.stringify(manifest,null,2)+'\n');
    const checked = checkDelivery(staging);
    if (!checked.ok) throw new Error(checked.errors.join('; '));
    // A second producer may have finished while input decoding was running.
    if (fs.existsSync(out)) throw new Error(`output already exists: ${out}`);
    fs.renameSync(staging,out);
    return {ok:true, out, manifest:path.join(out,DELIVERY_MANIFEST), mode, courses:courses.length, verification:manifest.verification};
  } catch (e) { fs.rmSync(staging,{recursive:true,force:true}); throw e; }
}

/** Verify a portable package without requiring its original source directory. */
export function checkDelivery(directory) {
  const root = path.resolve(directory), errors = [];
  let manifest;
  try {
    const mf = localFile(root, DELIVERY_MANIFEST);
    manifest = JSON.parse(fs.readFileSync(mf,'utf8'));
    if (manifest.schemaVersion !== 1 || !MODES.includes(manifest.mode) || !Array.isArray(manifest.files) || !Array.isArray(manifest.courses) || !manifest.courses.length) throw new Error('invalid delivery manifest');
    const listed = new Set();
    for (const entry of manifest.files) {
      if (listed.has(entry.file)) throw new Error(`duplicate manifest path: ${entry.file}`);
      listed.add(entry.file);
      const file = localFile(root,entry.file);
      if (!/^[a-f0-9]{64}$/.test(entry.sha256) || sha(file) !== entry.sha256) errors.push(`hash mismatch: ${entry.file}`);
    }
    for (const c of manifest.courses) {
      if (!listed.has(c.file)) throw new Error(`unlisted course: ${c.file}`);
      const file = localFile(root,c.file);
      if (sha(file) !== c.sha256) errors.push(`course hash mismatch: ${c.file}`);
      try { const media = decode(file); chapters(c.chapters,media.videoDuration); }
      catch (e) { errors.push(e.message); }
    }
    for (const required of ['README.txt', ...(manifest.mode === 'videos' ? [] : ['index.html'])])
      if (!listed.has(required)) errors.push(`missing required dependency: ${required}`);
    if (manifest.mode !== 'videos' && listed.has('index.html')) {
      const html = fs.readFileSync(localFile(root,'index.html'),'utf8');
      // The generated catalog's only dependencies are media URLs and internal anchors.
      for (const match of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
        if (match[1].startsWith('#')) continue;
        const target = decodeURIComponent(match[1].split('#')[0]);
        localFile(root,target);
        if (!listed.has(target)) errors.push(`unlisted HTML dependency: ${target}`);
      }
    }
  } catch (e) { errors.push(e.message); }
  return {ok:errors.length === 0, errors, mode:manifest?.mode ?? null, verification:{integrity:errors.length ? 'FAIL':'PASS', decode:errors.length ? 'UNVERIFIED':'PASS', targetDevice:'UNREVIEWED', humanAudiovisual:'UNREVIEWED'}};
}
