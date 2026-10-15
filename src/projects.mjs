import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export const projectRoot = (env = process.env) =>
  path.resolve(
    env.MOTION_USE_PROJECTS || path.join(os.homedir(), "motion-use"),
  );
export function projectTarget(input = "film", env = process.env) {
  if (
    input === "." ||
    input === ".." ||
    input.includes("/") ||
    input.includes("\\") ||
    path.isAbsolute(input)
  )
    return path.resolve(input);
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(input))
    throw Error(
      "project name must be a lowercase slug, or pass an explicit path",
    );
  return path.join(projectRoot(env), input);
}
export function listProjects(env = process.env) {
  const root = projectRoot(env);
  if (!fs.existsSync(root)) return { root, projects: [] };
  const projects = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const file = ["film.json", "brief.json"]
      .map((n) => path.join(dir, n))
      .find((f) => fs.existsSync(f));
    if (!file) continue;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      let release = null;
      const manifest = path.join(
        dir,
        "out",
        "release",
        "release-manifest.json",
      );
      if (fs.existsSync(manifest)) {
        const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
        const master = m.files?.find((f) => f.kind === "master");
        if (
          master?.file &&
          !path.isAbsolute(master.file) &&
          !path
            .relative(
              path.dirname(manifest),
              path.resolve(path.dirname(manifest), master.file),
            )
            .startsWith("..")
        )
          release = {
            file: path.resolve(path.dirname(manifest), master.file),
            created: m.created ?? null,
            exists: fs.existsSync(
              path.resolve(path.dirname(manifest), master.file),
            ),
          };
      }
      projects.push({
        name: data.name ?? entry.name,
        dir,
        duration: data.duration ?? null,
        release,
      });
    } catch (e) {
      projects.push({ dir, error: e.message });
    }
  }
  return { root, projects };
}

// Bare names refer to saved projects only when no local path/prefix exists.
// An explicit ./path always remains local, including when it is missing.
export function projectInput(input, env = process.env) {
  const local = path.resolve(input);
  const prefix = input.split(/[\\/]/)[0];
  if (fs.existsSync(local) || fs.existsSync(path.resolve(prefix))) return local;
  if (!/^[a-z0-9][a-z0-9-]{0,39}(?:[\\/](?:film|brief)\.json)?$/.test(input))
    return local;
  const stored = path.join(projectRoot(env), input);
  return fs.existsSync(stored) ? stored : local;
}
