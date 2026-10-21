// Transport fixture only: tones cannot establish voice quality or pronunciation.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const request = JSON.parse(fs.readFileSync(0, "utf8"));
fs.writeFileSync(new URL("./last-request.json", import.meta.url), JSON.stringify(request));
if (request.model === "fail") { console.error("provider secret should never appear in reports"); process.exit(7); }
if (request.model === "invalid") fs.writeFileSync(request.output, "not audio");
else execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.35", "-b:a", "192k", request.output]);
