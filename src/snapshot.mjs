// Render snapshots: every render keeps the exact inputs it used (film.json, drawing code, the
// voiceover clips and their manifest, footage and images) in a content-addressed store, so the
// same cut can be rendered again after the narration or the film changed. In the iphone-use
// promo (2026-10) the published cut could not be re-rendered at higher quality because its
// voiceover had been regenerated in place.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MANIFEST as VO_MANIFEST } from "./voiceover.mjs";

const BIG = 200e6; // larger inputs are recorded by hash only
const isInside = (base, f) => {
  const r = path.relative(base, f);
  return Boolean(r) && !r.startsWith("..") && !path.isAbsolute(r);
};

const hashFile = (f) => {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(f, "r"),
    buf = Buffer.alloc(1 << 20);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
};

/** Every file a film render reads, as [{ role, file }], deduplicated. */
export function filmInputs(film, filmFile) {
  const list = [
    { role: "film", file: filmFile },
    { role: "composition", file: film.source },
    ...Object.values(film.fonts ?? {}).flatMap((font) => [{ role: "font", file: font.file }, { role: "font-license", file: font.license }]),
    ...(film.libraries ?? []).map((file) => ({ role: "composition", file })),
    ...Object.values(film.fileAssets ?? {}).map((file) => ({ role: "asset", file })),
    ...Object.values(film.files ?? {}).map((file) => ({ role: "file", file })),
    // An external engine's command is in film.json; the files it names inside the project
    // (scene.py, scene.blend) are inputs like the drawing code.
    ...(film.engine?.command ?? [])
      .filter((a) => path.isAbsolute(a) && film.dir && isInside(film.dir, a) && fs.statSync(a, { throwIfNoEntry: false })?.isFile())
      .map((file) => ({ role: "engine", file })),
    ...Object.values(film.videos ?? {}).map((v) => ({ role: "footage", file: v.file })),
    ...(film.musicFile ? [{ role: "music", file: film.musicFile }] : []),
    ...(film.tracks ?? []).map((a) => ({ role: a.role === "voiceover" ? "voiceover" : "audio", file: a.file, lang: a.lang, id: a.id })),
  ];
  const dir = film.narrationConfig?.dir;
  if (dir && fs.existsSync(path.join(dir, VO_MANIFEST))) list.push({ role: "voiceover-manifest", file: path.join(dir, VO_MANIFEST) });
  const seen = new Set();
  return list.filter((x) => x.file && fs.existsSync(x.file) && !seen.has(x.file) && seen.add(x.file));
}

/**
 * Store the inputs of this render under <out>/.snapshots and return its record.
 * Blobs are shared between snapshots (named by sha256), so an unchanged clip costs nothing.
 */
export function createSnapshot(film, filmFile, out, { version, renderOptions } = {}) {
  const store = path.join(out, ".snapshots"),
    blobs = path.join(store, "blobs");
  fs.mkdirSync(blobs, { recursive: true });
  const base = film.dir;
  const files = filmInputs(film, filmFile).map((x) => {
    const sha = hashFile(x.file),
      bytes = fs.statSync(x.file).size;
    const rel = path.relative(base, x.file);
    const inside = rel && !rel.startsWith("..") && !path.isAbsolute(rel);
    const stored = bytes <= BIG;
    const blob = path.join(blobs, sha);
    if (stored && !fs.existsSync(blob)) {
      const tmp = `${blob}.partial`;
      fs.copyFileSync(x.file, tmp);
      fs.renameSync(tmp, blob);
    }
    return { role: x.role, path: inside ? rel : x.file, sha256: sha, bytes, stored, ...(x.lang ? { lang: x.lang } : {}), ...(x.id ? { id: x.id } : {}) };
  });
  files.sort((a, b) => a.path.localeCompare(b.path));
  const id = crypto
    .createHash("sha256")
    .update(JSON.stringify(files.map((f) => [f.path, f.sha256])))
    .update(renderOptions && Object.values(renderOptions).some(Boolean) ? JSON.stringify(renderOptions) : "")
    .digest("hex")
    .slice(0, 12);
  const record = { id, film: path.relative(base, filmFile), created: new Date().toISOString(), motion_use: version, project: base, ...(renderOptions ? { renderOptions } : {}), ...(film.engine ? { engine: { command: film.engine.command, cwd: film.engine.cwd } } : {}), files };
  const file = path.join(store, `${id}.json`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  return record;
}

/** Find a snapshot by id (or prefix), by its JSON path, or by a release manifest naming one. */
export function findSnapshot(ref, out) {
  const store = path.join(out, ".snapshots");
  if (fs.existsSync(ref) && fs.statSync(ref).isFile()) {
    const j = JSON.parse(fs.readFileSync(ref, "utf8"));
    if (j.files && j.id) return { record: j, store: path.dirname(path.resolve(ref)) };
    if (j.snapshot) {
      const relStore = path.join(path.dirname(path.resolve(ref)), "..", ".snapshots");
      return findSnapshot(j.snapshot, fs.existsSync(relStore) ? path.dirname(relStore) : out);
    }
    throw new Error(`${ref} is neither a snapshot nor a release manifest`);
  }
  const ids = fs.existsSync(store) ? fs.readdirSync(store).filter((f) => f.endsWith(".json") && f.startsWith(ref)) : [];
  if (ids.length !== 1)
    throw new Error(ids.length ? `snapshot "${ref}" is ambiguous: ${ids.join(", ")}` : `no snapshot "${ref}" under ${store}`);
  return { record: JSON.parse(fs.readFileSync(path.join(store, ids[0]), "utf8")), store };
}

/**
 * Recreate a snapshot's project under <store>/restore/<id> and return the film.json path.
 * A file too large to have been stored is taken from the current project only when its
 * hash still matches; otherwise the restore fails rather than render a different cut.
 */
export function restoreSnapshot({ record, store }) {
  const dir = path.join(store, "restore", record.id);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of record.files) {
    const target = path.isAbsolute(f.path) ? null : path.join(dir, f.path);
    const blob = path.join(store, "blobs", f.sha256);
    let source = f.stored && fs.existsSync(blob) ? blob : null;
    if (!source) {
      const current = path.isAbsolute(f.path) ? f.path : path.join(record.project, f.path);
      if (fs.existsSync(current) && hashFile(current) === f.sha256) source = current;
      else throw new Error(`snapshot ${record.id}: ${f.path} is not stored and has changed since; restore it first`);
    }
    if (!target) {
      if (source !== f.path) throw new Error(`snapshot ${record.id}: ${f.path} lies outside the project`);
      continue; // outside the project and unchanged: the film still points at it
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Small files are copied (a render may rewrite the voiceover manifest in place, which
    // through a hard link would alter the stored blob); large footage is linked.
    if (f.bytes < 20e6) fs.copyFileSync(source, target);
    else
      try {
        fs.linkSync(source, target);
      } catch {
        fs.copyFileSync(source, target);
      }
  }
  return path.join(dir, record.film);
}
