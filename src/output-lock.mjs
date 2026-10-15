import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// Exclusive creation also covers aliases of the output folder. Never steal a lock:
// a dead owner's metadata remains available for inspection after a crash.
export function acquireOutputLock(out) {
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(fs.realpathSync(out), ".motion-use.lock");
  const owner = { pid: process.pid, host: os.hostname(), run: crypto.randomUUID(), started: new Date().toISOString() };
  let fd;
  try { fd = fs.openSync(file, "wx"); }
  catch (e) {
    if (e.code !== "EEXIST") throw e;
    let previous;
    try { previous = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    let dead = false;
    if (previous?.host === os.hostname() && Number.isInteger(previous.pid) && previous.pid > 0) {
      try { process.kill(previous.pid, 0); } catch (e) { dead = e.code === "ESRCH"; }
    }
    throw new Error(`another job owns this output (PID ${previous?.pid ?? "unknown"}, run ${previous?.run ?? "unknown"}); wait or use --out <fresh-dir>.${dead ? ` Owner is no longer running; inspect and remove ${file} before retrying.` : ""}`);
  }
  try { fs.writeFileSync(fd, JSON.stringify(owner) + "\n"); }
  finally { fs.closeSync(fd); }
  return () => {
    try { if (JSON.parse(fs.readFileSync(file, "utf8")).run === owner.run) fs.unlinkSync(file); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
  };
}
