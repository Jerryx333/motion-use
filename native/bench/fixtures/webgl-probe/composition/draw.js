// WebGL probe for motion-render: setupFilm checks the WebGL 2 surface three.js-style code relies on
// and throws on the first mismatch (so `motion-render render` fails); drawFrame draws an animated
// scene (VAO, instancing, a uniform block, an image texture with UNPACK_FLIP_Y, MSAA, a half-float
// render target sampled back) and composites the WebGL canvas into the 2D frame for parity checks.
(() => {
  let gl, glc, prog, vao, tex, rt, rtTex, post, quad, ubo;
  const fail = (m) => {
    throw new Error("webgl-probe: " + m);
  };
  const ok = (c, m) => c || fail(m);
  const VS = `#version 300 es
layout(location = 0) in vec2 p;
layout(location = 1) in vec4 inst; // x, y, scale, hue
uniform Scene { vec4 time; vec4 tint; };
out vec2 uv; out float hue;
void main() {
  float a = time.x * (0.5 + inst.w) + inst.w * 6.2831;
  mat2 r = mat2(cos(a), sin(a), -sin(a), cos(a));
  vec2 q = r * p * inst.z + inst.xy;
  uv = p * 0.5 + 0.5; hue = inst.w;
  gl_Position = vec4(q * vec2(0.5625, 1.0), 0.5 - inst.w * 0.4, 1.0);
}`;
  const FS = `#version 300 es
precision highp float;
in vec2 uv; in float hue;
uniform sampler2D img;
uniform Scene { vec4 time; vec4 tint; };
layout(location = 0) out vec4 color;
layout(location = 1) out vec4 glow;
void main() {
  vec3 h = 0.5 + 0.5 * cos(6.2831 * (hue + vec3(0.0, 0.33, 0.67)));
  vec4 t = texture(img, uv);
  color = vec4(mix(h, t.rgb, t.a * 0.8) * tint.rgb, 1.0);
  glow = vec4(h * 2.5, 1.0); // > 1: needs a float target
}`;
  const PVS = `#version 300 es
in vec2 p; out vec2 uv; void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;
  const PFS = `#version 300 es
precision highp float; in vec2 uv; uniform sampler2D src; uniform float k; uniform float spread; out vec4 o;
void main() { vec4 c = vec4(0.0); for (int i = -4; i <= 4; i++) c += texture(src, uv + vec2(float(i) * spread, 0.0)); o = vec4(c.rgb / 9.0 * k, 1.0); }`;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  }
  function program(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) fail("link: " + gl.getProgramInfoLog(p));
    return p;
  }

  window.setupFilm = function (film, view) {
    glc = document.createElement("canvas");
    glc.width = 640;
    glc.height = 360;
    gl = glc.getContext("webgl2", { antialias: true, preserveDrawingBuffer: false });
    ok(gl, "no webgl2 context");
    ok(gl instanceof WebGL2RenderingContext && !(gl instanceof WebGLRenderingContext), "context classes");
    ok(glc.getContext("webgl2") === gl && glc.getContext("2d") === null, "getContext identity");
    ok(/^WebGL 2\.0/.test(gl.getParameter(gl.VERSION)), "VERSION");
    ok(/^WebGL GLSL ES 3\.00/.test(gl.getParameter(gl.SHADING_LANGUAGE_VERSION)), "SHADING_LANGUAGE_VERSION");
    const vp = gl.getParameter(gl.VIEWPORT);
    ok(vp instanceof Int32Array && vp[2] === 640 && vp[3] === 360, "initial VIEWPORT " + vp);
    const cm = gl.getParameter(gl.COLOR_WRITEMASK);
    ok(Array.isArray(cm) && cm.every((x) => x === true), "COLOR_WRITEMASK");
    ok(gl.getParameter(gl.MAX_TEXTURE_SIZE) >= 4096, "MAX_TEXTURE_SIZE");
    ok(gl.getParameter(gl.FRAMEBUFFER_BINDING) === null, "FRAMEBUFFER_BINDING null");
    ok(gl.getParameter(gl.STENCIL_WRITEMASK) === 0xffffffff, "STENCIL_WRITEMASK unsigned");
    ok(gl.getContextAttributes().antialias === true && gl.getParameter(gl.SAMPLES) > 0, "antialias");
    ok(gl.drawingBufferWidth === 640 && gl.drawingBufferHeight === 360, "drawingBuffer size");
    ok(gl.getExtension("EXT_color_buffer_float"), "EXT_color_buffer_float");
    ok(gl.getSupportedExtensions().includes("OES_texture_float_linear"), "OES_texture_float_linear listed");
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    ok(dbg && /ANGLE/.test(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)), "UNMASKED_RENDERER_WEBGL");
    const pf = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    ok(pf.precision >= 23, "highp float precision");
    // a broken shader reports, it does not throw
    const bad = compile(gl.FRAGMENT_SHADER, "#version 300 es\nprecision highp float; out vec4 o; void main() { o = nope; }");
    ok(gl.getShaderParameter(bad, gl.COMPILE_STATUS) === false && /nope/.test(gl.getShaderInfoLog(bad)), "compile error log");
    // WebGL validation comes from ANGLE: a draw with no program is INVALID_OPERATION
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    ok(gl.getError() === gl.INVALID_OPERATION, "INVALID_OPERATION on draw without program");
    ok(gl.getError() === gl.NO_ERROR, "error cleared");

    prog = program(VS, FS);
    // uniform block
    const bi = gl.getUniformBlockIndex(prog, "Scene");
    ok(bi !== gl.INVALID_INDEX, "uniform block index");
    ok(gl.getActiveUniformBlockParameter(prog, bi, gl.UNIFORM_BLOCK_DATA_SIZE) === 32, "block size");
    gl.uniformBlockBinding(prog, bi, 2);
    ubo = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
    gl.bufferData(gl.UNIFORM_BUFFER, 32, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 2, ubo);
    ok(gl.getIndexedParameter(gl.UNIFORM_BUFFER_BINDING, 2) === ubo, "indexed binding");
    // VAO with an instanced attribute
    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const inst = [];
    for (let i = 0; i < 24; i++) inst.push(Math.cos(i * 2.4) * (0.2 + i * 0.03), Math.sin(i * 2.4) * (0.2 + i * 0.03), 0.06 + (i % 5) * 0.02, i / 24);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, ib);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(inst), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    ok(gl.getVertexAttrib(1, gl.VERTEX_ATTRIB_ARRAY_DIVISOR) === 1, "divisor");
    ok(gl.getParameter(gl.VERTEX_ARRAY_BINDING) === vao, "VERTEX_ARRAY_BINDING");
    gl.bindVertexArray(null);
    // a texture from a 2D canvas, flipped on upload: red on top in the canvas → red at v=1
    const src = document.createElement("canvas");
    src.width = 64;
    src.height = 64;
    const c2 = src.getContext("2d");
    c2.fillStyle = "#e33";
    c2.fillRect(0, 0, 64, 32);
    c2.fillStyle = "rgba(40, 90, 255, 0.5)";
    c2.fillRect(0, 32, 64, 32);
    c2.fillStyle = "#fff";
    c2.font = "bold 28px sans-serif";
    c2.fillText("GL", 12, 44);
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    ok(gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) === false, "UNPACK_FLIP_Y_WEBGL state");
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    // read the texture back through a framebuffer: row 63 (top of the image after the flip) is red
    const rfb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, rfb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    ok(gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE, "texture fbo complete");
    const px = new Uint8Array(4);
    gl.readPixels(2, 62, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    ok(px[0] > 200 && px[1] < 80 && px[3] === 255, "flipY upload, top row red: " + px);
    gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    ok(px[2] > 200 && Math.abs(px[3] - 128) <= 1, "bottom row straight alpha blue: " + px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(rfb);
    ok(gl.getParameter(gl.FRAMEBUFFER_BINDING) === null, "binding after delete");
    // half-float MRT target with a depth renderbuffer
    rt = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt);
    rtTex = [0, 1].map((i) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, 640, 360);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
      return t;
    });
    const depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, 640, 360);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    ok(gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE, "float MRT complete");
    gl.clearBufferfv(gl.COLOR, 1, [3, 0.5, 0.25, 1]);
    const fpx = new Float32Array(4);
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, fpx);
    ok(fpx[0] === 3 && fpx[1] === 0.5, "float readback " + fpx);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    post = program(PVS, PFS);
    quad = gl.createVertexArray();
    gl.bindVertexArray(quad);
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    // the drawing buffer: clear and read back (through the MSAA resolve)
    gl.clearColor(0.2, 0.4, 0.6, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.readPixels(10, 10, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    ok(Math.abs(px[0] - 51) <= 1 && Math.abs(px[2] - 153) <= 1, "default framebuffer readback " + px);
    const e = gl.getError();
    ok(e === gl.NO_ERROR, "GL error after setup: 0x" + e.toString(16));
  };

  window.drawFrame = function (ctx, t, film, view) {
    const W = view.width, H = view.height;
    gl.viewport(0, 0, 640, 360);
    // scene into the float MRT target
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt);
    gl.clearBufferfv(gl.COLOR, 0, [0.05, 0.05, 0.08, 1]);
    gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 1]);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(prog);
    gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, new Float32Array([t, 0, 0, 0, 1, 0.95, 0.9, 1]));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(prog, "img"), 0);
    gl.bindVertexArray(vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 24);
    gl.disable(gl.DEPTH_TEST);
    // blurred glow from attachment 1 into the (multisampled) drawing buffer, then the scene over it
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(post);
    gl.bindVertexArray(quad);
    gl.bindTexture(gl.TEXTURE_2D, rtTex[1]);
    gl.uniform1f(gl.getUniformLocation(post, "k"), 0.35);
    gl.uniform1f(gl.getUniformLocation(post, "spread"), 0.004);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindTexture(gl.TEXTURE_2D, rtTex[0]);
    gl.uniform1f(gl.getUniformLocation(post, "k"), 1);
    gl.uniform1f(gl.getUniformLocation(post, "spread"), 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    ctx.fillStyle = "#101010";
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(glc, 0, 0, W, H);
    // the same canvas again, small, through a pattern
    ctx.save();
    ctx.translate(W * 0.72, H * 0.7);
    ctx.fillStyle = ctx.createPattern(glc, "no-repeat");
    ctx.scale(0.4, 0.4);
    ctx.fillRect(0, 0, 640, 360);
    ctx.restore();
  };
})();
