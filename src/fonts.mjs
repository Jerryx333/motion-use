// Fonts ship with motion-use (SIL OFL) and are cut down to exactly the characters
// each video draws, so rendering never fetches anything and output is the same
// on every machine.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Blob, Face } from "harfbuzzjs";
import subsetFont from "subset-font";

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "fonts");
export const FONTS = {
  sans: path.join(FONT_DIR, "NotoSansSC[wght].ttf"),
  mono: path.join(FONT_DIR, "JetBrainsMono[wght].ttf"),
};

// Characters the templates draw themselves: prompt, digits for step numbers.
const TEMPLATE_TEXT = "$ 0123456789";
const ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("");

const coverage = new Map();
function covered(file) {
  if (!coverage.has(file)) coverage.set(file, new Set(new Face(new Blob(fs.readFileSync(file)), 0).collectUnicodes()));
  return coverage.get(file);
}

/** Characters in `text` that no available font can draw (bundled, plus the brief's own fonts). */
export function missingGlyphs(text, custom = {}) {
  const sets = [FONTS.sans, FONTS.mono, ...Object.values(custom).map((v) => v?.file)].filter(Boolean).map(covered);
  const missing = new Set();
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 32 || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue; // control, joiners, variation selectors
    if (!sets.some((s) => s.has(cp))) missing.add(ch);
  }
  return [...missing];
}

/**
 * Write subset WOFF2 files for `text` into `outDir`: the bundled fonts always (they are the
 * fallback for any character a brand font lacks), plus brand-sans / brand-mono when the brief
 * brings its own, each with its license file next to it. Returns sizes in bytes.
 */
export async function writeSubsets(text, outDir, custom = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const all = text + TEMPLATE_TEXT + ASCII;
  const sizes = {};
  const jobs = { ...FONTS };
  for (const k of Object.keys(custom)) if (custom[k]?.file) {
    jobs[`brand-${k}`] = custom[k].file;
    fs.copyFileSync(custom[k].license, path.join(outDir, `LICENSE-brand-${k}.txt`));
  }
  for (const [name, file] of Object.entries(jobs)) {
    const buf = await subsetFont(fs.readFileSync(file), all, { targetFormat: "woff2" });
    fs.writeFileSync(path.join(outDir, `${name}.woff2`), buf);
    sizes[name] = buf.length;
  }
  return sizes;
}
