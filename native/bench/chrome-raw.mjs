#!/usr/bin/env node
// Chrome's raw drawing speed on a built page, without screenshots or encoding: the same
// headless Chrome HyperFrames uses, the page's own hf-seek, then a full-canvas getImageData
// (the RGBA readback motion-render also pays). --gpu uses ANGLE/Metal like `--browser-gpu`.
//   node native/bench/chrome-raw.mjs <page dir> <frames> [--gpu]   → {draw_ms, readback_ms}
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const [dir, framesArg, gpuFlag] = process.argv.slice(2);
const frames = +framesArg;
const gpu = gpuFlag === "--gpu";
const shell = path.join(os.homedir(), ".cache/hyperframes/chrome/chrome-headless-shell");
const ver = fs.readdirSync(shell).sort().at(-1);
const exe = path.join(shell, ver, fs.readdirSync(path.join(shell, ver)).find((d) => d.startsWith("chrome-headless-shell")), "chrome-headless-shell");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".woff2": "font/woff2", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".wav": "audio/wav" };
const server = http.createServer((req, res) => {
  const f = path.join(dir, decodeURIComponent(req.url.split("?")[0]));
  fs.readFile(f, (e, d) => (e ? (res.writeHead(404), res.end()) : (res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" }), res.end(d))));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const config = JSON.parse(/<script id="film-config" type="application\/json">(.*?)<\/script>/s.exec(fs.readFileSync(path.join(dir, "index.html"), "utf8"))[1]);
const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  args: gpu ? ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
try {
  const tab = await browser.newPage();
  const m = /data-width="(\d+)" data-height="(\d+)"/.exec(fs.readFileSync(path.join(dir, "index.html"), "utf8"));
  await tab.setViewport({ width: +m[1], height: +m[2] });
  await tab.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: "load" });
  const r = await tab.evaluate(
    async (frames, fps) => {
      await window.__hf.buildReady["motion-use-film"];
      const c = document.getElementById("film-canvas"), ctx = c.getContext("2d");
      const seek = (t) =>
        new Promise((resolve, reject) => {
          let p = null;
          window.dispatchEvent(new CustomEvent("hf-seek", { detail: { time: t, waitUntil: (x) => (p = x) } }));
          (p ?? Promise.resolve()).then(resolve, reject);
        });
      await seek(0);
      ctx.getImageData(0, 0, 1, 1); // flush
      let draw = 0, read = 0;
      for (let k = 1; k <= frames; k++) {
        const t0 = performance.now();
        await seek(k / fps);
        ctx.getImageData(0, 0, 1, 1); // force the GPU to finish this frame
        const t1 = performance.now();
        ctx.getImageData(0, 0, c.width, c.height);
        draw += t1 - t0;
        read += performance.now() - t1;
      }
      return { draw_ms: draw / frames, readback_ms: read / frames };
    },
    frames,
    config.fps,
  );
  console.log(JSON.stringify({ ...r, gpu }));
} finally {
  await browser.close();
  server.close();
}
