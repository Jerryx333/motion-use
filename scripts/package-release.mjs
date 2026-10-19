// Build dist/motion-use-vX.Y.Z.tar.gz (+ .sha256) from the files a release needs.
// node_modules is not included: install.sh runs `npm ci` from the bundled lockfile.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const name = `motion-use-v${pkg.version}`;
const dist = path.join(root, "dist");
const stage = path.join(dist, name);
const SKIP = new Set(["out", "node_modules", ".DS_Store", "dist", ".env", ".motion-use", ".motion-use-asr.json", ".motion-use-asr.json.lock"]);

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
const copy = (rel) => {
  const from = path.join(root, rel);
  if (SKIP.has(path.basename(rel)) || path.basename(rel).startsWith(".env")) return;
  // Generated voices are local artifacts, not redistributable release assets.
  if(path.basename(rel)===".motion-use-voiceover.json"||rel.split(path.sep).includes("voiceover")&&!fs.statSync(from).isDirectory()&&path.basename(rel)!=="README.txt")return;
  if (fs.statSync(from).isDirectory()) return fs.readdirSync(from).forEach((f) => copy(path.join(rel, f)));
  fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
  fs.copyFileSync(from, path.join(stage, rel));
};
for (const rel of [...pkg.files, "package.json", "package-lock.json", "README.md", "README.zh-CN.md", "CONTRIBUTING.md", "install.sh", ".claude-plugin"]) copy(rel);

const archive = path.join(dist, `${name}.tar.gz`);
execFileSync("tar", ["-czf", archive, "-C", dist, name], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
const sum = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
fs.writeFileSync(`${archive}.sha256`, `${sum}  ${path.basename(archive)}\n`);
fs.rmSync(stage, { recursive: true, force: true });
console.log(`${archive}\n${sum}`);
