// Only bounded operational metadata is allowed; never forward service output or scripts.
export function createProgress(mode = "none", write = (s) => process.stderr.write(s), now = () => performance.now(), observe = () => {}) {
  const started = now();
  const context = {};
  return (phase, event, data = {}) => {
    for (const k of ["lang", "format"]) if (data[k] !== undefined) context[k] = data[k];
    const row = { ...context, phase, event, elapsed_s: +((now() - started) / 1000).toFixed(3) };
    for (const k of ["lang", "format", "frames", "total", "output_seconds", "cache_hit"]) if (data[k] !== undefined) row[k] = data[k];
    observe(row);
    if (mode === "none") return;
    write(mode === "json" ? JSON.stringify(row) + "\n" : `[${row.elapsed_s}s] ${phase}: ${event}${row.lang ? ` ${row.lang}/${row.format}` : ""}${row.frames !== undefined ? ` ${row.frames}/${row.total} frames` : ""}\n`);
  };
}
