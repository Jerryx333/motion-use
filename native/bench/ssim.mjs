// SSIM between two images of the same size (ffmpeg's ssim filter on RGB; "All" is the mean of
// the three channels), and a diff picture for inspection.
import { spawnSync } from "node:child_process";

export function ssim(a, b) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "info", "-i", a, "-i", b, "-lavfi", "[0:v]format=rgb24,setsar=1[x];[1:v]format=rgb24,setsar=1[y];[x][y]ssim", "-f", "null", "-"], { encoding: "utf8" });
  const m = /All:([\d.]+)/.exec(r.stderr);
  if (!m) throw new Error(`ssim failed for ${a} vs ${b}: ${r.stderr.split("\n").slice(-4).join(" ")}`);
  return +m[1];
}

/** |a-b| amplified 4x, for looking at where two frames differ. */
export function diff(a, b, out) {
  spawnSync("ffmpeg", ["-v", "error", "-y", "-i", a, "-i", b, "-lavfi", "[0:v]format=rgb24[x];[1:v]format=rgb24[y];[x][y]blend=all_mode=difference,lutrgb=r=val*4:g=val*4:b=val*4", "-frames:v", "1", out]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [a, b, out] = process.argv.slice(2);
  console.log(ssim(a, b));
  if (out) diff(a, b, out);
}
