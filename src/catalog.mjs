// Original motion-use cards and studies; upstream workflow references are in production.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initFilm } from "./film.mjs";
import { esc } from "./html.mjs";
import { fitForCard, recommendCards } from "./catalog-fit.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const card = (
  kind,
  id,
  title,
  use,
  palette,
  mechanism,
  pitfalls,
  parameters,
) => ({
  kind,
  id,
  title,
  use,
  palette,
  mechanism,
  pitfalls,
  parameters,
  fit: fitForCard(id),
  duration: 6,
  implementation: "src/catalog-study.js",
  preview:
    "Procedural motion study; illustrative objects, not a real product recording.",
});
export const CARDS = [
  card("shot", "tutorial-steps", "手把手步骤 · Tutorial steps", "Explain a real screenshot step by step.", "paper", "Focus on a source-pixel box, mark it, switch screenshots by shot-duration ratio.", ["Replace the illustrative screenshot with real evidence.", "Keep content above the subtitle area."], { maxZoom:3, frameAt:[0,.5] }),
  card(
    "style",
    "whiteboard",
    "白板推理 · Whiteboard",
    "Explain a causal chain on one accumulating board.",
    "whiteboard",
    "Draw a route by arc length, then send one signal along it; keep the earlier marks.",
    [
      "A paper filter alone is not handwriting.",
      "Hold after the last mark, not while it is still being drawn.",
    ],
    { lineWidth: 5, drawSeconds: 2.2, signalSeconds: 1.8 },
  ),
  card(
    "style",
    "editorial",
    "纸面证据 · Editorial",
    "Explain a document or screenshot with one marked detail.",
    "wood",
    "Place the evidence first, reveal a short underline, then move a margin annotation into place.",
    [
      "Use real evidence in a production film; the study uses a deliberately synthetic document.",
      "Keep the main document readable and the texture static.",
    ],
    { documentWidth: 560, markSeconds: 0.55, annotationSeconds: 0.4 },
  ),
  card(
    "style",
    "kinetic",
    "动态文字 · Kinetic type",
    "Land one short message with a clear visual beat.",
    "poster",
    "Anticipate, scale into the word, settle, then let an underline carry the next beat.",
    [
      "A title on every cut becomes a slide deck.",
      "Do not bounce opacity or continuously move reading text.",
    ],
    { enterSeconds: 0.5, underlineSeconds: 0.45, holdSeconds: 1.5 },
  ),
  card(
    "style",
    "data-story",
    "数据叙事 · Data story",
    "Compare quantities and identify one consequence.",
    "paper",
    "Grow zero-baseline bars in sequence, then isolate the bar that answers the question.",
    [
      "Study values are illustrative, not a performance claim.",
      "Keep all bars on the same zero baseline and scale.",
    ],
    { values: [3, 5, 8], staggerSeconds: 0.45, growSeconds: 0.9 },
  ),
  card(
    "style",
    "print",
    "套色印刷 · Two-colour print",
    "Use a tactile graphic treatment for an object-led message.",
    "bauhaus",
    "Reveal separate colour plates; keep fixed registration offsets and a fixed halftone grid.",
    [
      "Changing random grain every frame looks like noise.",
      "This is a two-colour print study, not a faithful simulation of every printmaking medium.",
    ],
    { registrationPx: 4, dotSpacing: 14, revealSeconds: 1.6 },
  ),
  card(
    "style",
    "product",
    "产品聚焦 · Product focus",
    "Guide attention to one region of a real interface.",
    "snow",
    "Start with the whole interface, frame a meaningful region, and move a pointer to its action.",
    [
      "Replace the schematic interface with a real screenshot when claiming product behaviour.",
      "Never blur the active reading layer.",
    ],
    { focusSeconds: 0.45, pointerSeconds: 0.6, focusWidth: 270 },
  ),
  card(
    "shot",
    "focus-handoff",
    "焦点交接 · Focus handoff",
    "Transfer attention from an input to its resulting output.",
    "paper",
    "Keep both objects visible; send a signal and highlight the receiving object on arrival.",
    [
      "The output must react after arrival.",
      "Avoid a whole-frame flash to express a local event.",
    ],
    { travelSeconds: 1.4, arrivalSeconds: 0.35 },
  ),
  card(
    "shot",
    "parallax-tour",
    "视差巡览 · Parallax tour",
    "Give a group of flat screenshots a readable sense of depth.",
    "wood",
    "Move three layers by one eased drive with different multipliers, then stop on the subject.",
    [
      "Do not animate independent random drifts.",
      "Production screenshots must stay sharp on the reading layer.",
    ],
    { depth: [0.3, 0.7, 1.3], moveSeconds: 2.4 },
  ),
  card(
    "shot",
    "before-after",
    "前后对比 · Before / after",
    "Show a visible change from the same framing.",
    "paper",
    "Wipe between two aligned states; keep landmarks fixed so the change is attributable.",
    [
      "Different zoom levels make a comparison misleading.",
      "Both states need a verifiable source in a product film.",
    ],
    { wipeSeconds: 1.7, initialHoldSeconds: 1 },
  ),
  card(
    "shot",
    "exploded-view",
    "结构展开 · Exploded view",
    "Explain how one object consists of several parts.",
    "snow",
    "Separate three layers on a shared axis, expose their relationship, then assemble again.",
    [
      "Retain the alignment axis.",
      "Do not imply a real internal architecture from a decorative illustration.",
    ],
    { spreadPx: 105, moveSeconds: 0.9, returnAt: 4.4 },
  ),
  card(
    "shot",
    "shared-shape",
    "形状接力 · Shared shape",
    "Carry continuity through a button, capsule and panel.",
    "poster",
    "Retarget one rounded rectangle; keep a single identity through each size and position change.",
    [
      "Content needs a separate visibility window during a morph.",
      "Do not recreate a new unrelated card at every state.",
    ],
    { changeAt: [0.7, 2.3, 4.1], moveSeconds: 0.65 },
  ),
  card(
    "shot",
    "chart-reveal",
    "证据落点 · Chart reveal",
    "Make one comparative result legible before adding an annotation.",
    "paper",
    "Grow the series from zero; add an accent rule only after the highlighted value settles.",
    [
      "Do not make the tallest bar exceed the data ratio.",
      "A number landing is the start of its reading hold.",
    ],
    { values: [3, 5, 8], growSeconds: 0.9, annotationAt: 3.5 },
  ),
];

export function catalog(kind, id) {
  if (kind && !["styles", "shots"].includes(kind))
    throw new Error("catalog [styles|shots] [id]");
  const cards = CARDS.filter(
    (c) => !kind || c.kind === (kind === "styles" ? "style" : "shot"),
  );
  if (!id) return cards;
  const found = cards.find((c) => c.id === id);
  if (!found) throw new Error(`Unknown catalog card: ${id}`);
  return [found];
}

export const recommendCatalog = (options) => recommendCards(CARDS, options);

// All exporting commands use a fresh directory. No --force removes someone else's work.
export function freshDirectory(dir) {
  const out = path.resolve(dir);
  if (fs.existsSync(out))
    throw new Error(`${out} already exists; choose a fresh output directory`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  return out;
}

export function writeGallery(dir, cards = CARDS) {
  const out = freshDirectory(dir);
  fs.mkdirSync(out);
  fs.copyFileSync(
    path.join(ROOT, "src", "catalog-study.js"),
    path.join(out, "study.js"),
  );
  fs.writeFileSync(
    path.join(out, "cards.json"),
    JSON.stringify(cards, null, 2) + "\n",
  );
  const tiles = cards
    .map(
      (c) =>
        `<article data-kind="${c.kind}"><canvas width="960" height="540" data-study="${c.id}" aria-label="${esc(c.title)} motion study"></canvas><h2>${esc(c.title)}</h2><p>${esc(c.use)}</p><details><summary>Selection, mechanism, parameters & limits</summary><p>${esc(c.fit.chooseWhen)}</p><p>Product: ${esc(c.fit.productTypes.join(", "))}<br>Material: ${esc(c.fit.materials.join(", "))}<br>Basis: authored guidance; the study is illustrative.</p><p>${esc(c.mechanism)}</p><pre>${esc(JSON.stringify(c.parameters, null, 2))}</pre><ul>${c.pitfalls.map((p) => `<li>${esc(p)}</li>`).join("")}</ul><p>${esc(c.preview)}</p><code>motion-use study ${c.id} ./study-${c.id}</code></details></article>`,
    )
    .join("\n");
  fs.writeFileSync(
    path.join(out, "index.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>motion-use studies</title><style>body{margin:32px auto;padding:0 20px;max-width:1400px;background:#f4f0e8;color:#242824;font:16px/1.6 system-ui}h1{font-size:36px}header{margin-bottom:30px}button{font:inherit;padding:8px 18px;background:#fff;border:1px solid #8b8b80;border-radius:6px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr));gap:28px}article{padding:16px;background:#fff;border:1px solid #d4cdbf;border-radius:10px}canvas{width:100%;height:auto}h2{font-size:21px}pre{white-space:pre-wrap}code{overflow-wrap:anywhere}</style><header><h1>motion-use · Motion studies</h1><p>6-second procedural studies. Objects and data are illustrative. These demonstrate mechanisms, not finished film quality.</p><button id="pause">Pause</button> <label>Time <input id="time" type="range" min="0" max="6" step="0.01" value="0"></label></header><main>${tiles}</main><script src="study.js"></script><script>
const canvases=[...document.querySelectorAll('canvas')],slider=document.getElementById('time'),button=document.getElementById('pause');let playing=!matchMedia('(prefers-reduced-motion: reduce)').matches,start=performance.now(),held=0;
function paint(t){for(const c of canvases)window.motionStudy(c.getContext('2d'),t,c.width,c.height,c.dataset.study);slider.value=t;}
button.textContent=playing?'Pause':'Play';button.onclick=()=>{held=+slider.value;playing=!playing;start=performance.now()-held*1000;button.textContent=playing?'Pause':'Play';};slider.oninput=()=>{playing=false;held=+slider.value;button.textContent='Play';paint(held);};function tick(now){if(playing)paint(((now-start)/1000)%6);requestAnimationFrame(tick);}paint(0);requestAnimationFrame(tick);
</script></html>`,
  );
  return {
    ok: true,
    gallery: path.join(out, "index.html"),
    cards: cards.length,
  };
}

export function initStudy(id, dir) {
  const c = CARDS.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown study: ${id}`);
  const out = freshDirectory(dir);
  initFilm({ name: `study-${id}`, lang: "en", format: "landscape" }, out);
  const file = path.join(out, "film.json");
  const film = JSON.parse(fs.readFileSync(file, "utf8"));
  Object.assign(film, {
    duration: 6,
    fps: 30,
    voiceover: false,
    music: "none",
    motionBlur: { samples: 1, shutter: 0 },
    brief: {
      subject: c.title,
      purpose: "A motion mechanism study, not a finished film",
      audience: "Motion designers",
      tone: "Legible and deliberate",
      length: 6,
      reference: "Original motion-use study",
    },
    look: { style: c.mechanism, palette: c.palette, character: "none" },
    copy: { en: { label: "STUDY" } },
    data: {},
    shots: [
      {
        id: "study",
        start: 0,
        end: 6,
        purpose: c.use,
        action: c.mechanism,
        camera: "hold",
      },
    ],
  });
  fs.writeFileSync(file, JSON.stringify(film, null, 2) + "\n");
  fs.writeFileSync(
    path.join(out, "composition", "draw.js"),
    fs.readFileSync(path.join(ROOT, "src", "catalog-study.js"), "utf8") +
      `\nwindow.drawFrame = (c,t,film,view) => window.motionStudy(c,t,view.width,view.height,${JSON.stringify(id)});\n`,
  );
  fs.writeFileSync(
    path.join(out, "DIRECTOR.md"),
    `# ${c.title}\n\n${c.preview}\n\n${c.mechanism}\n\nParameters: ${JSON.stringify(c.parameters)}\n\n${c.pitfalls.map((p) => `- ${p}`).join("\n")}\n\nRender: \`motion-use render . --allow-code --quality draft\`. Study parameters are implemented in composition/draw.js; this is a starting point to inspect, not a product film template.\n`,
  );
  return { ok: true, film: file, study: id };
}
