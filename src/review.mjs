// Frame feedback is tied to immutable image bytes and a source revision. Marking
// a note addressed is an agent statement; it never means human visual approval.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { checkFilm, resolveProject } from "./film.mjs";
import { filmInputs } from "./snapshot.mjs";
import { acquireOutputLock } from "./output-lock.mjs";
import { esc } from "./html.mjs";

const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");
const LIMIT = 20 * 1024 * 1024;
const inside = (root, file) => { const r = path.relative(root, file); return r && r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r); };
function hashFile(file) {
  const hash = crypto.createHash("sha256"), fd = fs.openSync(file, "r"), buf = Buffer.alloc(1024 * 1024);
  try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null))) hash.update(buf.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return hash.digest("hex");
}
export function reviewContext(input) {
  const file = fs.realpathSync(resolveProject(input)), root = path.dirname(file);
  const checked = checkFilm(file, { skipGeneratedVoiceover: true });
  if (!checked.ok) throw new Error(checked.report.errors.map((e) => `${e.path}: ${e.message}`).join("\n"));
  const inputs = filmInputs(checked.film, file).map((entry) => ({ path: path.relative(root, entry.file), sha256: hashFile(entry.file) })).sort((a, b) => a.path.localeCompare(b.path));
  return { file, root, film: checked.film, revision: sha(JSON.stringify(inputs)), inputs };
}
function store(context, create = false) {
  const dirs = [path.join(context.root, ".motion-use"), path.join(context.root, ".motion-use", "review")];
  for (const dir of dirs) {
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error(`review metadata must be a real directory: ${dir}`);
    if (!stat && create) fs.mkdirSync(dir);
  }
  return dirs[1];
}
function read(context) {
  const file = path.join(store(context), "notes.json");
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return { schemaVersion: 1, notes: [] };
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("review notes must be a regular file");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (data.schemaVersion !== 1 || !Array.isArray(data.notes)) throw new Error("unsupported review notes format");
  return data;
}
function png(bytes) {
  if (bytes.length > LIMIT || bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("frame must be a PNG, at most 20 MiB");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 16384 || height > 16384 || width * height > 64e6) throw new Error("invalid PNG frame dimensions (at most 64 megapixels)");
  try {
    execFileSync("ffmpeg", ["-v", "error", "-err_detect", "explode", "-i", "pipe:0", "-frames:v", "1", "-f", "null", "-"], { input: bytes, timeout: 15000, maxBuffer: 1024 * 1024, stdio: ["pipe", "ignore", "pipe"] });
  } catch { throw new Error("could not decode PNG frame; use a complete still and check that ffmpeg is installed"); }
  return { bytes, sha256: sha(bytes), width, height };
}
function frame(context, options) {
  if (options.frameData !== undefined) {
    if (typeof options.frameData !== "string" || options.frameData.length > Math.ceil(LIMIT * 4 / 3) + 32 || !/^[A-Za-z0-9+/]*={0,2}$/.test(options.frameData)) throw new Error("invalid base64 PNG frame");
    return png(Buffer.from(options.frameData, "base64"));
  }
  if (typeof options.frame !== "string" || !options.frame) throw new Error("--frame needs a PNG still from this project");
  const file = fs.realpathSync(path.resolve(context.root, options.frame));
  if (!inside(context.root, file) || fs.statSync(file).size > LIMIT) throw new Error("frame must stay inside the project and be at most 20 MiB");
  return png(fs.readFileSync(file));
}
function placement(context, options, image) {
  const t = Number(options.at);
  if (!Number.isFinite(t) || t < 0 || t >= context.film.duration) throw new Error("--at must be inside the film");
  const shot = context.film.shots.find((s) => t >= s.start && t < s.end);
  if (options.shot && options.shot !== shot.id) throw new Error("selected shot does not contain --at");
  const point = options.x === undefined && options.y === undefined ? null : { x: Number(options.x), y: Number(options.y) };
  if (point && (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x >= image.width || point.y >= image.height)) throw new Error("--x/--y must both be pixel coordinates inside the PNG");
  if (options.object !== undefined && (typeof options.object !== "string" || !options.object.trim() || options.object.length > 200)) throw new Error("--object must be a nonempty object ID, at most 200 characters");
  return { t, shot: shot.id, point, object: options.object ?? null };
}
function noteText(text) {
  if (typeof text !== "string" || !text.trim() || text.length > 8000) throw new Error("--note needs 1–8000 characters");
  return text.trim();
}
function writeFrame(dir, image) {
  const file = path.join(dir, image.sha256 + ".png");
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat && (stat.isSymbolicLink() || !stat.isFile() || hashFile(file) !== image.sha256)) throw new Error("stored review frame was changed");
  if (!stat) fs.writeFileSync(file, image.bytes, { flag: "wx" });
  return { file: path.basename(file), sha256: image.sha256, width: image.width, height: image.height, timeEvidence: "author-declared" };
}
function mutate(context, expected, fn) {
  const dir = store(context, true), unlock = acquireOutputLock(dir);
  let temp;
  try {
    if (reviewContext(context.file).revision !== expected) throw new Error("source revision changed; reopen/list the current revision before retrying");
    const data = read(context), result = fn(data, dir);
    temp = path.join(dir, `notes-${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
    fs.renameSync(temp, path.join(dir, "notes.json"));
    return result;
  } finally { if (temp) fs.rmSync(temp, { force: true }); unlock(); }
}
export function listReview(input) {
  const context = reviewContext(input), data = read(context);
  return { ok: true, revision: context.revision, acceptance: "UNREVIEWED", notes: data.notes.map((n) => ({ ...n, stale: (n.addressed?.revision ?? n.revision) !== context.revision })) };
}
export function addReview(input, options) {
  const context = reviewContext(input);
  if (options.revision !== undefined && options.revision !== context.revision) throw new Error("source revision changed since the frame review page was exported; export a fresh page");
  const text = noteText(options.note), image = frame(context, options), position = placement(context, options, image);
  return mutate(context, context.revision, (data, dir) => {
    const entry = { id: crypto.randomUUID(), note: text, ...position, revision: context.revision,
      frame: writeFrame(dir, image), created: new Date().toISOString(), status: "pending", history: [] };
    data.notes.push(entry);
    return { ok: true, revision: context.revision, acceptance: "UNREVIEWED", entry };
  });
}
export function updateReview(input, id, action, options) {
  if (!["done", "reopen"].includes(action)) throw new Error("review action must be done or reopen");
  const context = reviewContext(input), text = noteText(options.note);
  if (!options.revision || options.revision !== context.revision) throw new Error("--revision must match review list's current revision");
  const image = action === "done" ? frame(context, options) : null;
  return mutate(context, context.revision, (data, dir) => {
    const entry = data.notes.find((n) => n.id === id);
    if (!entry) throw new Error(`no review note ${id}`);
    if (action === "done" && entry.status !== "pending") throw new Error("only pending notes can be marked addressed");
    const position = image ? placement(context, { at: options.at ?? entry.t }, image) : null;
    const event = { action, note: text, revision: context.revision, at: new Date().toISOString(), ...(image ? { frame: writeFrame(dir, image), position } : {}) };
    entry.history.push(event);
    entry.status = action === "done" ? "addressed" : "pending";
    if (action === "done") entry.addressed = event;
    else delete entry.addressed;
    return { ok: true, revision: context.revision, acceptance: "UNREVIEWED", entry };
  });
}

export function writeFrameReviewPage(input, options) {
  const context = reviewContext(input), image = frame(context, options), position = placement(context, options, image);
  if (!options.out) throw new Error("review page requires --out <fresh.html>");
  const file = path.resolve(options.out);
  const payload = { schemaVersion: 1, revision: context.revision, at: position.t, shot: position.shot, frameData: image.bytes.toString("base64") };
  const data = JSON.stringify(payload).replace(/</g, "\\u003c");
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(context.film.name)} · 单帧批注</title>
<style>:root{font-family:"PingFang SC","Microsoft YaHei",sans-serif;color:#202b31;background:#e8edf0}*{box-sizing:border-box}body{margin:0}header{padding:20px 28px;background:#fff;border-bottom:1px solid #b7c5cd;display:flex;justify-content:space-between;gap:20px;align-items:baseline}h1{font-size:22px;margin:0}header p{margin:0;color:#435b69}main{display:grid;grid-template-columns:minmax(0,1fr) 320px;min-height:calc(100vh - 76px)}.viewer{padding:28px;display:flex;align-items:center;justify-content:center}.frame{position:relative;line-height:0;max-width:100%;box-shadow:0 4px 24px #152f4520}.frame img{display:block;max-width:100%;max-height:80vh;cursor:crosshair}.pin{position:absolute;width:18px;height:18px;transform:translate(-50%,-50%);border:3px solid white;border-radius:50%;background:#ba421b;box-shadow:0 0 0 2px #ba421b;pointer-events:none}aside{background:#fff;padding:28px;border-left:1px solid #b7c5cd}label{display:block;margin-top:24px;margin-bottom:8px;font-weight:600}textarea,input,button{font:inherit;width:100%;padding:10px;border:1px solid #9aadb8}textarea{height:160px;resize:vertical}button{margin-top:24px;background:#175976;color:white;border:0;cursor:pointer}button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid #e8a63e;outline-offset:3px}.hint{line-height:1.7;color:#435b69}#point{min-height:24px;font-variant-numeric:tabular-nums}#status{line-height:1.6;color:#175976}details{margin-top:28px;overflow-wrap:anywhere;font-size:13px}@media(max-width:850px){main{grid-template-columns:1fr}.viewer{padding:16px}aside{border-left:0;border-top:1px solid #b7c5cd}header{display:block}header p{margin-top:8px}}</style>
<header><h1>${esc(context.film.name)}</h1><p>${position.t}s / ${esc(position.shot)}</p></header><main><section class="viewer" aria-label="待评审画面"><div class="frame"><img id="frame" tabindex="0" role="button" aria-label="点击画面定位，或按 Enter 标记中央" alt="${esc(context.film.name)} ${position.t} 秒画面"><span id="pin" class="pin" hidden></span></div></section><aside><h2>这帧哪里需要改？</h2><p class="hint">点击画面定位，再写下具体意见。导出的批注含截图和本次源码版本，交给 Agent 导入。</p><p id="point" aria-live="polite">尚未选择位置，也可评论整帧</p><label for="note">修改意见</label><textarea id="note" placeholder="例如：把这个数字放大，留出更长阅读时间"></textarea><details><summary>补充定位信息（可选）</summary><label for="object">对象 ID</label><input id="object" maxlength="200" placeholder="已知对象 ID 时填写"></details><button id="download" disabled>导出批注</button><p id="status" role="status"></p><details><summary>使用与版本</summary><p>时间由导出时声明，不代表已验证的渲染时间。源码变化后请重新导出。</p><p>Agent：motion-use review add &lt;film&gt; --input &lt;批注.json&gt;</p><p>源码版本：${context.revision}</p><p>此批注不代表视觉验收通过。</p></details></aside></main><script id="review-data" type="application/json">${data}</script><script>
const base=JSON.parse(document.getElementById('review-data').textContent),img=document.getElementById('frame'),pin=document.getElementById('pin'),note=document.getElementById('note'),download=document.getElementById('download');let point=null;img.src='data:image/png;base64,'+base.frameData;
img.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();const r=img.getBoundingClientRect();img.dispatchEvent(new MouseEvent('click',{clientX:r.left+r.width/2,clientY:r.top+r.height/2}));}});
img.addEventListener('click',e=>{const r=img.getBoundingClientRect();point={x:Math.max(0,Math.min(img.naturalWidth-1,Math.floor((e.clientX-r.left)/r.width*img.naturalWidth))),y:Math.max(0,Math.min(img.naturalHeight-1,Math.floor((e.clientY-r.top)/r.height*img.naturalHeight)))};pin.hidden=false;pin.style.left=(point.x/img.naturalWidth*100)+'%';pin.style.top=(point.y/img.naturalHeight*100)+'%';document.getElementById('point').textContent='画面像素：'+point.x+', '+point.y;});
note.addEventListener('input',()=>{download.disabled=!note.value.trim()||note.value.length>8000;});
download.addEventListener('click',()=>{const object=document.getElementById('object').value.trim(),payload={...base,note:note.value.trim(),...(point||{}),...(object?{object}:{} )};const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='frame-comment.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);document.getElementById('status').textContent='批注已导出；交给 Agent 导入后才会加入项目记录。';});
</script></html>`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html, { flag: "wx" });
  return { ok: true, page: file, revision: context.revision, ...position, frame: { sha256: image.sha256, width: image.width, height: image.height }, acceptance: "UNREVIEWED" };
}
