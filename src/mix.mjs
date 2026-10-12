// The film's sound without a browser: every entry of proj.mix (music, effects, voiceover, footage
// sound) placed and mixed by one ffmpeg run. It follows what HyperFrames does with the page's
// <audio> tags (hyperframes 0.8.123, engine audioMixer): each clip cut from mediaStart for its
// duration at 48 kHz stereo (a mono file goes to both sides at full level), a volume automation
// baked as a straight-line envelope that replaces the clip volume, then volume, fades, delay to its
// start, and all clips summed at unity (amix normalised, then multiplied back by the clip count).
import { execFileSync } from "node:child_process";

const num = (x) => {
  const s = Number(x).toFixed(6).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
};

function channels(file) {
  try {
    const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0", file], { encoding: "utf8" });
    return Number(out.trim()) || 2;
  } catch {
    return 2;
  }
}

/**
 * Volume over the clip's own time (0 = its start) from automation points in clip time
 * ({t, v}, absolute volumes): held before the first and after the last point, straight lines between.
 */
export function envelope(points, duration, base) {
  const pts = [...points].filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t);
  if (!pts.length) return null;
  const out = [];
  if (pts[0].t > 0) out.push({ t: 0, v: pts[0].v });
  for (const p of pts) {
    const t = Math.max(0, p.t);
    if (out.length && Math.abs(out.at(-1).t - t) < 1e-9) out.at(-1).v = p.v;
    else out.push({ t, v: p.v });
  }
  if (duration > out.at(-1).t) out.push({ t: duration, v: out.at(-1).v });
  if (out[0].t > 0) out.unshift({ t: 0, v: base });
  return out;
}

/** An ffmpeg volume expression for an envelope: if(lt(t,t1), v0+slope*(t-t0), …). */
export function envelopeExpr(env) {
  let expr = num(env.at(-1).v);
  for (let i = env.length - 2; i >= 0; i--) {
    const a = env[i],
      b = env[i + 1],
      slope = (b.v - a.v) / Math.max(1e-6, b.t - a.t);
    expr = `if(lt(t,${num(b.t)}),${num(a.v)}+(${num(slope)})*(t-${num(a.t)}),${expr})`;
  }
  return expr.replace(/,/g, "\\,");
}

/** The ffmpeg arguments that mix `tracks` into a `total`-second float WAV at `out`. */
export function mixArgs(tracks, total, out) {
  if (!tracks.length)
    return ["-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", num(total), "-c:a", "pcm_f32le", out];
  const inputs = [],
    parts = [];
  tracks.forEach((m, i) => {
    inputs.push("-ss", String(m.mediaStart ?? 0), "-t", String(m.duration), "-i", m.file);
    const d = m.duration;
    let fadeIn = m.fadeIn ?? 0,
      fadeOut = m.fadeOut ?? 0;
    if (fadeIn + fadeOut > d) {
      const k = d / (fadeIn + fadeOut);
      ((fadeIn *= k), (fadeOut *= k));
    }
    const env = m.automation ? envelope(m.automation, d, m.volume ?? 1) : null;
    const chain = [
      "aresample=48000",
      // HyperFrames' pan=stereo|FL=FL+FC|FR=FR+FC on a mono file: the one channel on both sides
      ...(m.channels === 1 ? ["pan=stereo|c0=c0|c1=c0"] : []),
      "aformat=sample_fmts=fltp:channel_layouts=stereo",
      `atrim=0:${num(d)}`,
      // short frames so a baked automation ramp moves every 5 ms, as the per-sample bake does
      ...(env ? ["asetnsamples=n=256:p=0", `volume='${envelopeExpr(env)}':eval=frame`] : [`volume=${num(m.volume ?? 1)}`]),
      ...(fadeIn > 0 ? [`afade=t=in:st=0:d=${num(fadeIn)}`] : []),
      ...(fadeOut > 0 ? [`afade=t=out:st=${num(Math.max(0, d - fadeOut))}:d=${num(fadeOut)}`] : []),
      `adelay=${Math.round(m.start * 1000)}|${Math.round(m.start * 1000)}`,
      "apad",
      "asetpts=N/SR/TB",
      `atrim=0:${num(total)}`,
    ];
    parts.push(`[${i}:a]${chain.join(",")}[a${i}]`);
  });
  parts.push(`${tracks.map((_, i) => `[a${i}]`).join("")}amix=inputs=${tracks.length}:duration=longest:dropout_transition=0:normalize=0[out]`);
  return ["-v", "error", "-y", ...inputs, "-filter_complex", parts.join(";"), "-map", "[out]", "-t", num(total), "-ar", "48000", "-c:a", "pcm_f32le", out];
}

/** Mix the cut's sound (proj.mix) into a float WAV of exactly `total` seconds. */
export function mixAudio(tracks, total, out) {
  const withChannels = tracks.map((m) => ({ ...m, channels: m.channels ?? channels(m.file) }));
  try {
    execFileSync("ffmpeg", mixArgs(withChannels, total, out), { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    throw new Error(`audio mix failed: ${e.code === "ENOENT" ? "ffmpeg not found" : e.stderr?.toString().trim().split("\n").slice(-3).join(" ")}`);
  }
  return out;
}
