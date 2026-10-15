// Local, exact-time human review. Preview never renders or captures finished film frames.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { buildFilm, checkFilm, isFilm, resolveProject, safeBox, FILM_FORMATS } from "./film.mjs";
import { mixAudio } from "./mix.mjs";
import { esc } from "./html.mjs";

const localized = (value, lang) => typeof value === "string" ? value : value?.[lang] ?? "";

/** All authored text stays in escaped HTML; the script reads numeric metadata from the DOM. */
export function previewPage(film, lang, format, hasAudio = false) {
  const [width, height] = FILM_FORMATS[format];
  const safe = safeBox(width, height);
  const percent = (value, total) => Number((value / total * 100).toFixed(6));
  const rows = film.shots.map((s) => `<tr data-start="${esc(s.start)}" data-end="${esc(s.end)}"><td><button class="shot" type="button">${esc(s.id)}</button></td><td>${esc(s.start)}–${esc(s.end)} s</td>${["action", "text", "narration"].map((key) => `<td>${esc(localized(s[key], lang))}</td>`).join("")}</tr>`).join("\n");
  return `<!doctype html>
<html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'">
<title>${esc(film.name)} — Preview</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:20px;background:#171717;color:#eee;font:15px/1.5 system-ui,sans-serif}h1{font-size:22px}button,input{font:inherit}button{cursor:pointer;padding:6px 12px}main{display:grid;grid-template-columns:minmax(0,2fr) minmax(240px,1fr);gap:20px}.viewport{height:65vh;display:flex;justify-content:center;align-items:center;background:#090909}.stage{position:relative;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%;pointer-events:none}.mask{position:absolute;background:#ff643d66;pointer-events:none}.top,.bottom{left:0;right:0}.top{top:0;height:${percent(safe.y, height)}%}.bottom{bottom:0;height:${percent(height - safe.y - safe.h, height)}%}.left,.right{top:${percent(safe.y, height)}%;height:${percent(safe.h, height)}%}.left{left:0;width:${percent(safe.x, width)}%}.right{right:0;width:${percent(width - safe.x - safe.w, width)}%}.guides[hidden]{display:none}.controls{display:flex;gap:12px;align-items:center;margin:12px 0}#progress{flex:1;min-width:40px}#shots{display:flex;flex-wrap:wrap;gap:8px}.active{background:#4a4520}table{width:100%;border-collapse:collapse}td,th{padding:10px;border:1px solid #555;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere}.storyboard{overflow:auto}.error{color:#ff9a82}@media(max-width:800px){main{grid-template-columns:1fr}}
</style></head><body>
<h1>${esc(film.name)} — Preview</h1>${film.narrationPending?.some(p => p.lang === lang) ? '<p class="error">Some narration recordings are missing or outdated. Run motion-use voiceover before reviewing narration.</p>' : ""}<p>Review picture, pacing and narration before rendering. Refresh to rebuild changed inputs. This is not delivery verification.</p>
<main><section id="player" data-duration="${esc(film.duration)}" data-fps="${esc(film.fps)}" data-width="${width}" data-height="${height}">
<div class="viewport"><div class="stage"><iframe src="/build/index.html" title="Film preview" sandbox="allow-scripts allow-same-origin"></iframe>${height > width ? '<div class="guides" hidden><div class="mask top"></div><div class="mask bottom"></div><div class="mask left"></div><div class="mask right"></div></div>' : ""}</div></div>
${hasAudio ? '<audio id="clock" preload="auto" src="/build/preview.wav"></audio>' : ""}
<div class="controls"><button id="play" type="button">Play</button><input id="progress" aria-label="Timeline" type="range" min="0" max="${esc(film.duration)}" step="${1 / film.fps}" value="0"><output id="time"></output></div>
${height > width ? '<label><input id="platform-guides" type="checkbox"> Platform occlusion (approximate)</label>' : ""}
<p>Space: play/pause · ← / →: one frame</p><p id="status" class="error" role="status"></p>
</section><aside><h2>Shots</h2><nav id="shots" aria-label="Shots"></nav></aside></main>
<h2>Storyboard</h2><div class="storyboard"><table id="storyboard"><thead><tr><th>Shot</th><th>Start–end</th><th>Action</th><th>Text</th><th>Narration</th></tr></thead><tbody>${rows}</tbody></table></div>
<script>
(() => {
  const player = document.querySelector('#player'), frame = document.querySelector('iframe');
  const stage = document.querySelector('.stage'), viewport = document.querySelector('.viewport');
  const audio = document.querySelector('#clock'), play = document.querySelector('#play');
  const progress = document.querySelector('#progress'), output = document.querySelector('#time');
  const status = document.querySelector('#status'), rows = [...document.querySelectorAll('tbody tr')];
  const duration = Number(player.dataset.duration), fps = Number(player.dataset.fps);
  const width = Number(player.dataset.width), height = Number(player.dataset.height);
  let time = 0, playing = false, ready = false, previous = null;
  const buttons = rows.map(row => {
    const button = document.createElement('button');
    button.textContent = row.querySelector('.shot').textContent;
    button.onclick = () => seek(Number(row.dataset.start));
    row.querySelector('.shot').onclick = button.onclick;
    document.querySelector('#shots').append(button);
    return button;
  });
  function draw() {
    progress.value = time;
    output.textContent = time.toFixed(3) + ' s · frame ' + Math.min(Math.round(time * fps), Math.ceil(duration * fps) - 1);
    rows.forEach((row, i) => {
      const active = time >= Number(row.dataset.start) && (time < Number(row.dataset.end) || time === duration && i === rows.length - 1);
      row.classList.toggle('active', active); buttons[i].classList.toggle('active', active);
      buttons[i].setAttribute('aria-current', String(active));
    });
    if (ready) {
      const win = frame.contentWindow;
      win.dispatchEvent(new win.CustomEvent('hf-seek', {detail: {time: Math.min(time, duration - 1 / fps), waitUntil: promise => Promise.resolve(promise).catch(error => { status.textContent = error.message; stop(); })}}));
    }
  }
  function seek(value) {
    time = Math.max(0, Math.min(duration, value));
    if (audio) audio.currentTime = time;
    previous = null; draw();
  }
  function stop() { playing = false; previous = null; if (audio) audio.pause(); play.textContent = 'Play'; }
  async function toggle() {
    if (playing) return stop();
    if (!ready) return;
    if (time >= duration) seek(0);
    try {
      if (audio) await audio.play();
      playing = true; previous = null; play.textContent = 'Pause';
    } catch (error) { status.textContent = error.message; }
  }
  function tick(now) {
    if (playing) {
      if (audio) time = Math.min(duration, audio.currentTime);
      else if (previous !== null) time = Math.min(duration, time + (now - previous) / 1000);
      previous = now; draw(); if (time >= duration) stop();
    }
    requestAnimationFrame(tick);
  }
  frame.addEventListener('load', async () => {
    ready = false;
    try {
      await Promise.all(Object.values(frame.contentWindow.__hf?.buildReady ?? {}));
      frame.contentDocument.querySelectorAll('audio,video').forEach(media => { media.pause(); media.muted = true; });
      ready = true; draw();
    } catch (error) { status.textContent = error.message; }
  });
  play.onclick = toggle; progress.oninput = () => seek(Number(progress.value));
  if (audio) { audio.onended = () => { time = duration; stop(); draw(); }; audio.onerror = () => { stop(); status.textContent = 'Preview audio could not be loaded. Refresh to rebuild.'; }; }
  document.addEventListener('keydown', event => {
    if (event.target.matches('input,textarea,select')) return;
    if (event.code === 'Space') { event.preventDefault(); toggle(); }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); stop(); seek((Math.round(time * fps) + (event.key === 'ArrowRight' ? 1 : -1)) / fps);
    }
  });
  const guides = document.querySelector('#platform-guides');
  if (guides) guides.onchange = () => { document.querySelector('.guides').hidden = !guides.checked; };
  new ResizeObserver(() => {
    const scale = Math.min(viewport.clientWidth / width, viewport.clientHeight / height);
    stage.style.width = width * scale + 'px'; stage.style.height = height * scale + 'px';
    frame.style.width = width + 'px'; frame.style.height = height + 'px';
    frame.style.transformOrigin = 'top left'; frame.style.transform = 'scale(' + scale + ')';
  }).observe(viewport);
  draw(); requestAnimationFrame(tick);
})();
</script></body></html>`;
}

/** Recursive mtime snapshot, including additions/deletions; never follow directory symlinks. */
export function inputStamp(files) {
  const entries = new Map();
  function visit(file) {
    if (entries.has(file)) return;
    let stat;
    try { stat = fs.lstatSync(file, { bigint: true }); }
    catch (error) { if (error.code !== "ENOENT") throw error; entries.set(file, null); return; }
    entries.set(file, `${stat.mtimeNs}:${stat.size}`);
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
  }
  [...new Set(files.filter(Boolean))].sort().forEach(visit);
  return JSON.stringify([...entries]);
}

function audioInputs(film, lang) {
  return [film.musicFile, ...film.tracks.filter(t => !t.lang || t.lang === lang).map(t => t.file),
    ...Object.values(film.videos ?? {}).filter(v => v.audio && v.volume > 0).map(v => v.file)];
}

/** Lazy rebuild on document requests, serialized so refreshes cannot race a build. */
export function createPreview(input, options = {}, dependencies = {}) {
  const build = dependencies.buildFilm ?? buildFilm, mix = dependencies.mixAudio ?? mixAudio;
  const file = resolveProject(input);
  let current = null, stamp = null, sound = null, pending = null;
  async function update() {
    if (!isFilm(file)) throw new Error("preview supports film.json + composition only; brief.json is not supported");
    // Validate again after every refresh, picking up new audio sources and narration manifests too.
    const checked = checkFilm(file, options);
    if (!checked.ok) throw new Error(checked.report.errors.map(e => `${e.path}: ${e.message}`).join("\n"));
    const film = checked.film;
    if (!film.source || film.engine) throw new Error("preview requires a browser composition; external command engines require rendering film frames, which preview does not perform");
    const lang = options.lang ?? checked.langs[0], format = options.format ?? checked.formats[0];
    if (lang.includes(",") || format.includes(",")) throw new Error("preview selects one --lang and one --format at a time");
    const inputs = [file, path.dirname(film.source), ...film.libraries, ...Object.values(film.fileAssets),
      ...Object.values(film.files), ...Object.values(film.videos).map(v => v.file), ...audioInputs(film, lang), film.narrationConfig?.dir];
    const nextStamp = inputStamp(inputs);
    if (current && stamp === nextStamp) return current;
    const dir = path.join(checked.dir, "out", ".build", `preview-${film.name}-${lang}-${format}`);
    // Keep the previous WAV across buildFilm's claimDir cleanup when only picture inputs changed.
    const previousAudio = current?.audio && fs.existsSync(path.join(current.dir, "preview.wav"))
      ? fs.readFileSync(path.join(current.dir, "preview.wav")) : null;
    const proj = await build(film, lang, format, dir);
    const nextSound = JSON.stringify({ total: proj.total, music: film.music, bpm: film.bpm, mix: proj.mix.map(({ file: _file, ...track }) => track), sources: inputStamp(audioInputs(film, lang)) });
    if (proj.mix.length) {
      if (sound === nextSound && previousAudio) fs.writeFileSync(path.join(dir, "preview.wav"), previousAudio);
      else mix(proj.mix, proj.total, path.join(dir, "preview.wav"));
    }
    current = { dir, film, lang, format, audio: proj.mix.length > 0 };
    stamp = nextStamp; sound = nextSound;
    return current;
  }
  return { refresh() {
    if (!pending) pending = update().finally(() => { pending = null; });
    return pending;
  } };
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".woff2": "font/woff2", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".wasm": "application/wasm" };

export async function startPreview(input, options = {}, dependencies = {}) {
  const port = Number(options.port ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer from 0 to 65535");
  const preview = createPreview(input, options, dependencies);
  let state = await preview.refresh();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
      if (url.pathname === "/" || url.pathname === "/build/index.html") state = await preview.refresh();
      if (url.pathname === "/") {
        res.setHeader("Content-Type", MIME[".html"]);
        res.end(req.method === "HEAD" ? undefined : previewPage(state.film, state.lang, state.format, state.audio)); return;
      }
      if (!url.pathname.startsWith("/build/")) { res.writeHead(404).end(); return; }
      // Resolve both paths from the same canonical root (macOS /var aliases /private/var).
      const root = fs.realpathSync(state.dir) + path.sep;
      const file = path.resolve(root, decodeURIComponent(url.pathname.slice(7)));
      if (!file.startsWith(root) || !fs.realpathSync(file).startsWith(root) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
      const stat = fs.statSync(file);
      res.setHeader("Content-Type", MIME[path.extname(file)] ?? "application/octet-stream");
      // Seeking the premixed WAV must work without downloading it from the beginning again.
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      let start = 0, end = stat.size - 1;
      if (range) {
        start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), end) : end;
        if (start > end) { res.writeHead(416, { "Content-Range": `bytes */${stat.size}` }).end(); return; }
        res.statusCode = 206; res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      }
      res.setHeader("Accept-Ranges", "bytes"); res.setHeader("Content-Length", end - start + 1);
      if (req.method === "HEAD") res.end();
      else fs.createReadStream(file, { start, end }).on("error", () => res.destroy()).pipe(res);
    } catch (error) {
      res.writeHead(error.code === "ENOENT" ? 404 : 500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(error.message);
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}/`, preview };
}

export function openPreview(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (!command) return;
  const child = spawn(command, [url], { stdio: "ignore" });
  child.on("error", error => console.error(`Could not open preview: ${error.message}`));
  child.unref();
}
