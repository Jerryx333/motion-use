#!/usr/bin/env node
// A frame-engine page (window.setupEngine(job) / window.renderFrame(t)) rendered by headless
// Chrome, software GL (SwiftShader, motion-use's default) unless --gpu (Metal). Same protocol as
// drama-use's scripts/gpu-engine.mjs, kept here so the CPU path can be compared too.
//   node native/bench/chrome-engine.mjs <page.html> --job <job.json> [--gpu]
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const argv = process.argv.slice(2);
const job = JSON.parse(fs.readFileSync(argv[argv.indexOf("--job") + 1], "utf8"));
const pageFile = path.resolve(job.film.dir, argv.find((a) => a.endsWith(".html")));
const root = job.film.dir;
const gpu = argv.includes("--gpu");
fs.mkdirSync(job.out, { recursive: true });
const server = http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(req.url.split("?")[0]));
  fs.readFile(f, (e, d) => (e ? (res.writeHead(404), res.end()) : (res.writeHead(200, { "content-type": f.endsWith(".html") ? "text/html" : f.endsWith(".js") ? "text/javascript" : "application/octet-stream" }), res.end(d))));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const shell = path.join(os.homedir(), ".cache/hyperframes/chrome/chrome-headless-shell");
const ver = fs.readdirSync(shell).sort().at(-1);
const exe = path.join(shell, ver, fs.readdirSync(path.join(shell, ver)).find((d) => d.startsWith("chrome-headless-shell")), "chrome-headless-shell");
const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  args: gpu ? ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
try {
  const tab = await browser.newPage();
  await tab.setViewport({ width: job.width, height: job.height });
  await tab.goto(`http://127.0.0.1:${server.address().port}/${path.relative(root, pageFile)}`, { waitUntil: "load" });
  await tab.evaluate(async (j) => {
    const c = document.querySelector("canvas");
    c.width = j.width;
    c.height = j.height;
    if (window.setupEngine) await window.setupEngine(j);
  }, job);
  for (let f = job.frames.from; f <= job.frames.to; f++) {
    const b64 = await tab.evaluate(async (t) => {
      await window.renderFrame(t);
      return document.querySelector("canvas").toDataURL("image/png").split(",")[1];
    }, f / job.fps);
    fs.writeFileSync(path.join(job.out, String(f).padStart(5, "0") + ".png"), Buffer.from(b64, "base64"));
  }
} finally {
  await browser.close();
  server.close();
}
