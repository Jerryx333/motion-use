//! End-to-end WebGL checks through the binary: an engine page draws with WebGL 2 and composites
//! the canvas into its 2D output. Skipped (with a note) when ANGLE is not installed
//! (native/scripts/fetch-angle.sh).
use std::path::{Path, PathBuf};
use std::process::Command;

fn angle_present() -> bool {
    if let Ok(d) = std::env::var("MOTION_RENDER_ANGLE_DIR") {
        return Path::new(&d).is_dir();
    }
    let home = std::env::var("HOME").unwrap_or_default();
    std::fs::read_dir(Path::new(&home).join(".cache/motion-render/angle")).map(|mut r| r.next().is_some()).unwrap_or(false)
}

const PAGE: &str = r##"<!doctype html><html><body><canvas></canvas><script>
let gl, glc, prog;
window.setupEngine = (job) => {
  glc = document.createElement("canvas"); glc.width = 64; glc.height = 64;
  gl = glc.getContext("webgl2", { antialias: false });
  if (!gl) throw new Error("no webgl2");
  const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x);
    if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
  prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, "#version 300 es\nin vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }"));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, "#version 300 es\nprecision highp float; uniform float t; out vec4 o; void main(){ o = vec4(t, 0.5, 1.0, 1.0); }"));
  gl.linkProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  // a square over the middle half
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
};
window.renderFrame = (t) => {
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(prog);
  gl.uniform1f(gl.getUniformLocation(prog, "t"), t);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  if (gl.getError() !== gl.NO_ERROR) throw new Error("gl error");
  const c = document.querySelector("canvas").getContext("2d");
  c.fillStyle = "#ff0000"; c.fillRect(0, 0, 64, 64);
  c.drawImage(glc, 0, 0);
};
</script></body></html>"##;

fn render(dir: &Path, out: &str, workers: &str) -> Vec<u8> {
    let job = dir.join("job.json");
    let status = Command::new(env!("CARGO_BIN_EXE_motion-render"))
        .args(["render", dir.join("page.html").to_str().unwrap(), "--engine", "--job", job.to_str().unwrap(), "--frames", "0-3", "--fps", "4", "--format", "rgba", "--out"])
        .arg(dir.join(out))
        .args(["--workers", workers])
        .status()
        .unwrap();
    assert!(status.success(), "motion-render failed");
    let mut all = vec![];
    for k in 0..4 {
        all.extend(std::fs::read(dir.join(out).join(format!("{:05}.rgba", k))).unwrap());
    }
    all
}

/// The frames as one --stream to stdout; MOTION_RENDER_PROCESSES `procs` picks processes or threads.
fn stream(dir: &Path, workers: &str, procs: &str) -> Vec<u8> {
    let job = dir.join("job.json");
    let out = Command::new(env!("CARGO_BIN_EXE_motion-render"))
        .args(["render", dir.join("page.html").to_str().unwrap(), "--engine", "--job", job.to_str().unwrap(), "--frames", "0-3", "--fps", "4", "--stream", "-", "--workers", workers])
        .env("MOTION_RENDER_PROCESSES", procs)
        .output()
        .unwrap();
    assert!(out.status.success(), "motion-render failed: {}", String::from_utf8_lossy(&out.stderr));
    out.stdout
}

#[test]
fn webgl_draws_into_2d_and_repeats() {
    if !angle_present() {
        eprintln!("skipped: ANGLE not installed (native/scripts/fetch-angle.sh)");
        return;
    }
    let dir: PathBuf = std::env::temp_dir().join(format!("motion-render-webgl-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("page.html"), PAGE).unwrap();
    std::fs::write(dir.join("job.json"), r#"{"width": 64, "height": 64, "fps": 4}"#).unwrap();
    let a = render(&dir, "a", "1");
    let frame = 64 * 64 * 4;
    assert_eq!(a.len(), frame * 4);
    let px = |f: usize, x: usize, y: usize| &a[f * frame + (y * 64 + x) * 4..f * frame + (y * 64 + x) * 4 + 4];
    // outside the square the WebGL canvas is transparent: the red 2D fill shows
    assert_eq!(px(0, 2, 2), &[255, 0, 0, 255]);
    // inside: the shader colour, t = 0.75 at frame 3 → red ≈ 191
    assert_eq!(px(0, 32, 32), &[0, 128, 255, 255]);
    let r = px(3, 32, 32)[0];
    assert!((190..=192).contains(&r), "frame 3 red {}", r);
    // same input, same pixels: again, and across workers
    assert_eq!(a, render(&dir, "b", "1"));
    assert_eq!(a, render(&dir, "c", "2"));
    // frames back in order through --stream from worker processes and from threads
    assert_eq!(a, stream(&dir, "3", "1"));
    assert_eq!(a, stream(&dir, "3", "0"));
    std::fs::remove_dir_all(&dir).ok();
}
