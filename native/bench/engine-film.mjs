#!/usr/bin/env node
// Make a scratch copy of a bundled film that motion-use renders through motion-render's
// external-engine job contract: `composition` moves into the engine command, narration off (no
// network), everything else unchanged.
//   node native/bench/engine-film.mjs <example name> <out dir> [--browser]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const [name, out] = process.argv.slice(2);
const bin = process.env.MOTION_RENDER || path.join(ROOT, "native/target/release/motion-render");
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, "examples", name), out, { recursive: true, filter: (f) => !/[\\/](out|voiceover)([\\/]|$)/.test(path.relative(path.join(ROOT, "examples", name), f)) });
const film = JSON.parse(fs.readFileSync(path.join(out, "film.json"), "utf8"));
const browser = process.argv.includes("--browser"); // keep the browser engine, for comparison
const draw = film.composition;
if (!browser) delete film.composition;
film.voiceover = false;
for (const s of film.shots) delete s.narration;
delete film.narration;
if (!browser) film.engine = { type: "command", command: [bin, draw] };
fs.writeFileSync(path.join(out, "film.json"), JSON.stringify(film, null, 2) + "\n");
console.log(path.join(out, "film.json"));
