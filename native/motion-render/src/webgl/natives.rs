//! `__native.gl*`: thin V8 bindings from webgl.js to ANGLE. Argument 0 is always the context id;
//! object arguments are GL names (0 for null). WebGL rules (validation, error codes, shader
//! language checks) are ANGLE's WebGL-compatibility mode, as in Chrome.
use super::context::{Attrs, GlCtx};
use super::gl::{self, types::*};
use super::{add_ctx, egl, pixels, remove_ctx, with_ctx};
use crate::canvas::ImageSrc;
use crate::js::with_rt;
use skia_safe as sk;
use std::ffi::{c_void, CStr, CString};

type Args<'a> = v8::FunctionCallbackArguments<'a>;

#[inline]
fn num(s: &mut v8::PinScope, a: &Args, i: i32) -> f64 {
    a.get(i).number_value(s).unwrap_or(f64::NAN)
}
#[inline]
fn ii(s: &mut v8::PinScope, a: &Args, i: i32) -> i32 {
    let v = num(s, a, i);
    if v.is_finite() {
        (v as i64) as i32
    } else {
        0
    }
}
#[inline]
fn uu(s: &mut v8::PinScope, a: &Args, i: i32) -> u32 {
    let v = num(s, a, i);
    if v.is_finite() {
        (v as i64) as u32
    } else {
        0
    }
}
#[inline]
fn ff(s: &mut v8::PinScope, a: &Args, i: i32) -> f32 {
    num(s, a, i) as f32
}
#[inline]
fn bb(s: &mut v8::PinScope, a: &Args, i: i32) -> u8 {
    a.get(i).boolean_value(s) as u8
}
#[inline]
fn pp(s: &mut v8::PinScope, a: &Args, i: i32) -> isize {
    let v = num(s, a, i);
    if v.is_finite() {
        v as isize
    } else {
        0
    }
}
fn string(s: &mut v8::PinScope, a: &Args, i: i32) -> String {
    a.get(i).to_string(s).map(|st| st.to_rust_string_lossy(s)).unwrap_or_default()
}
fn cstring(s: &mut v8::PinScope, a: &Args, i: i32) -> CString {
    CString::new(string(s, a, i).replace('\0', "")).unwrap()
}

/// The bytes of an ArrayBufferView or ArrayBuffer argument.
fn bytes<'a>(v: v8::Local<v8::Value>) -> Option<&'a mut [u8]> {
    if let Ok(view) = v8::Local::<v8::ArrayBufferView>::try_from(v) {
        let len = view.byte_length();
        let p = view.data();
        if len == 0 || p.is_null() {
            return Some(&mut []);
        }
        return Some(unsafe { std::slice::from_raw_parts_mut(p as *mut u8, len) });
    }
    if let Ok(ab) = v8::Local::<v8::ArrayBuffer>::try_from(v) {
        let len = ab.byte_length();
        return match ab.data() {
            Some(p) if len > 0 => Some(unsafe { std::slice::from_raw_parts_mut(p.as_ptr() as *mut u8, len) }),
            _ => Some(&mut []),
        };
    }
    None
}

fn numbers(s: &mut v8::PinScope, v: v8::Local<v8::Value>) -> Vec<f64> {
    let mut out = vec![];
    if let Ok(arr) = v8::Local::<v8::Array>::try_from(v) {
        for i in 0..arr.length() {
            if let Some(x) = arr.get_index(s, i) {
                out.push(x.number_value(s).unwrap_or(0.0));
            }
        }
    }
    out
}

fn strings(s: &mut v8::PinScope, v: v8::Local<v8::Value>) -> Vec<CString> {
    let mut out = vec![];
    if let Ok(arr) = v8::Local::<v8::Array>::try_from(v) {
        for i in 0..arr.length() {
            if let Some(x) = arr.get_index(s, i) {
                let st = x.to_string(s).map(|t| t.to_rust_string_lossy(s)).unwrap_or_default();
                out.push(CString::new(st.replace('\0', "")).unwrap());
            }
        }
    }
    out
}

fn ret_str(s: &mut v8::PinScope, rv: &mut v8::ReturnValue, v: &str) {
    let st = v8::String::new(s, v).unwrap();
    rv.set(st.into());
}

fn ret_nums(s: &mut v8::PinScope, rv: &mut v8::ReturnValue, v: &[f64]) {
    let elems: Vec<v8::Local<v8::Value>> = v.iter().map(|x| v8::Number::new(s, *x).into()).collect();
    let arr = v8::Array::new_with_elements(s, &elems);
    rv.set(arr.into());
}

fn gl_string(p: GLenum) -> String {
    unsafe {
        let s = gl::GetString(p);
        if s.is_null() {
            String::new()
        } else {
            CStr::from_ptr(s as *const std::ffi::c_char).to_string_lossy().into_owned()
        }
    }
}

fn mark(c: &mut GlCtx) {
    c.dirty = true;
    c.drawn_this_frame = true;
    c.image_fresh = false;
}

/// Unpack state reset for a client-converted upload (tightly packed rows, no PBO); restored by
/// the returned guard's `restore`.
struct Unpack {
    vals: [GLint; 6],
    pbo: GLint,
}
const UNPACK_PARAMS: [GLenum; 6] = [gl::UNPACK_ALIGNMENT, gl::UNPACK_ROW_LENGTH, gl::UNPACK_SKIP_ROWS, gl::UNPACK_SKIP_PIXELS, gl::UNPACK_IMAGE_HEIGHT, gl::UNPACK_SKIP_IMAGES];
impl Unpack {
    fn reset(es3: bool) -> Unpack {
        let mut u = Unpack { vals: [0; 6], pbo: 0 };
        unsafe {
            let n = if es3 { 6 } else { 1 };
            for (k, p) in UNPACK_PARAMS.iter().enumerate().take(n) {
                gl::GetIntegerv(*p, &mut u.vals[k]);
                gl::PixelStorei(*p, if k == 0 { 1 } else { 0 });
            }
            if es3 {
                gl::GetIntegerv(gl::PIXEL_UNPACK_BUFFER_BINDING, &mut u.pbo);
                gl::BindBuffer(gl::PIXEL_UNPACK_BUFFER, 0);
            }
        }
        u
    }
    fn restore(&self, es3: bool) {
        unsafe {
            let n = if es3 { 6 } else { 1 };
            for (k, p) in UNPACK_PARAMS.iter().enumerate().take(n) {
                gl::PixelStorei(*p, self.vals[k]);
            }
            if es3 {
                gl::BindBuffer(gl::PIXEL_UNPACK_BUFFER, self.pbo as GLuint);
            }
        }
    }
}

fn geti(p: GLenum) -> GLint {
    let mut v = 0;
    unsafe { gl::GetIntegerv(p, &mut v) };
    v
}

/// RGBA8 rows (top-down) of a TexImageSource, premultiplied or straight as asked.
/// kind: 0 decoded image, 1 2D canvas, 2 WebGL canvas, 3 ImageData (bytes + w, h)
fn source_pixels(kind: i32, src: usize, data: Option<&[u8]>, dw: i32, dh: i32, premul: bool) -> Option<(Vec<u8>, i32, i32)> {
    match kind {
        0 | 1 => with_rt(|r| {
            let img = if kind == 1 {
                let c = r.canvases.get_mut(src)?;
                ImageSrc::Raster(c.surface.as_mut()?.image_snapshot())
            } else {
                r.images.get(src)?.clone()?
            };
            let (raster, w, h) = match img {
                ImageSrc::Raster(i) => {
                    let (w, h) = (i.width(), i.height());
                    (i, w, h)
                }
                ImageSrc::Picture(pic, w, h) => {
                    let (w, h) = (w.ceil() as i32, h.ceil() as i32);
                    let mut surf = sk::surfaces::raster_n32_premul((w.max(1), h.max(1)))?;
                    surf.canvas().draw_picture(&pic, None, None);
                    (surf.image_snapshot(), w, h)
                }
            };
            let at = if premul { sk::AlphaType::Premul } else { sk::AlphaType::Unpremul };
            let info = sk::ImageInfo::new((w, h), sk::ColorType::RGBA8888, at, None);
            let mut out = vec![0u8; (w * h * 4) as usize];
            raster.read_pixels(&info, out.as_mut_slice(), (w * 4) as usize, (0, 0), sk::image::CachingHint::Allow).then_some((out, w, h))
        }),
        2 => {
            let (px, w, h, was_premul) = with_ctx(src, |c, egl| {
                let mut v = vec![];
                c.read_back(egl, &mut v);
                (v, c.w, c.h, c.attrs.premultiplied && c.attrs.alpha)
            })?;
            let mut px = px;
            if was_premul && !premul {
                pixels::unpremultiply(&mut px);
            } else if !was_premul && premul {
                pixels::premultiply(&mut px);
            }
            Some((px, w, h))
        }
        3 => {
            let d = data?;
            let n = (dw.max(0) * dh.max(0) * 4) as usize;
            if d.len() < n {
                return None;
            }
            let mut px = d[..n].to_vec();
            if premul {
                pixels::premultiply(&mut px);
            }
            Some((px, dw, dh))
        }
        _ => None,
    }
}

macro_rules! arg {
    (u, $s:ident, $a:ident, $i:expr) => {
        uu($s, &$a, $i)
    };
    (i, $s:ident, $a:ident, $i:expr) => {
        ii($s, &$a, $i)
    };
    (f, $s:ident, $a:ident, $i:expr) => {
        ff($s, &$a, $i)
    };
    (b, $s:ident, $a:ident, $i:expr) => {
        bb($s, &$a, $i)
    };
    (p, $s:ident, $a:ident, $i:expr) => {
        pp($s, &$a, $i)
    };
}

macro_rules! natives {
    ($scope:ident, $obj:ident, $( $name:literal => |$s:ident, $a:ident, $rv:ident| $body:block ),* $(,)?) => {
        $(
            {
                #[allow(unused_variables, unused_mut)]
                fn cb($s: &mut v8::PinScope, $a: v8::FunctionCallbackArguments, mut $rv: v8::ReturnValue) {
                    let _ = &$a;
                    $body
                }
                let key = v8::String::new($scope, $name).unwrap();
                let func = v8::Function::new($scope, cb).unwrap();
                $obj.set($scope, key.into(), func.into());
            }
        )*
    };
}

/// `name => GlFunction(arg kinds…)`: u GLuint/GLenum, i GLint/GLsizei, f GLfloat, b GLboolean,
/// p GLintptr. `draw` marks the drawing buffer as changed.
macro_rules! simple {
    ($scope:ident, $obj:ident, $( $name:literal => $f:ident ( $($t:ident),* ) $($kind:ident)? ;)* ) => {
        $(
            {
                #[allow(unused_variables, unused_mut, unused_assignments)]
                fn cb(s: &mut v8::PinScope, a: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
                    let id = num(s, &a, 0) as usize;
                    let mut k = 0i32;
                    let r = with_ctx(id, |c, _| {
                        simple!(@mark c $($kind)?);
                        unsafe { gl::$f($( { k += 1; arg!($t, s, a, k) } ),*) }
                    });
                    simple!(@ret rv r $($kind)?);
                }
                let key = v8::String::new($scope, $name).unwrap();
                let func = v8::Function::new($scope, cb).unwrap();
                $obj.set($scope, key.into(), func.into());
            }
        )*
    };
    (@mark $c:ident draw) => { mark($c) };
    (@mark $c:ident $other:ident) => { };
    (@mark $c:ident) => { };
    (@ret $rv:ident $r:ident enum) => { if let Some(v) = $r { $rv.set_uint32(v as u32) } };
    (@ret $rv:ident $r:ident bool) => { $rv.set_bool(matches!($r, Some(v) if v != 0)) };
    (@ret $rv:ident $r:ident $other:ident) => { let _ = $r; };
    (@ret $rv:ident $r:ident) => { let _ = $r; };
}

pub fn install(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>) {
    simple!(scope, obj,
        "glActiveTexture" => ActiveTexture(u);
        "glAttachShader" => AttachShader(u, u);
        "glBeginQuery" => BeginQuery(u, u);
        "glBeginTransformFeedback" => BeginTransformFeedback(u);
        "glBindBuffer" => BindBuffer(u, u);
        "glBindBufferBase" => BindBufferBase(u, u, u);
        "glBindBufferRange" => BindBufferRange(u, u, u, p, p);
        "glBindRenderbuffer" => BindRenderbuffer(u, u);
        "glBindSampler" => BindSampler(u, u);
        "glBindTexture" => BindTexture(u, u);
        "glBindTransformFeedback" => BindTransformFeedback(u, u);
        "glBindVertexArray" => BindVertexArray(u);
        "glBlendColor" => BlendColor(f, f, f, f);
        "glBlendEquation" => BlendEquation(u);
        "glBlendEquationSeparate" => BlendEquationSeparate(u, u);
        "glBlendFunc" => BlendFunc(u, u);
        "glBlendFuncSeparate" => BlendFuncSeparate(u, u, u, u);
        "glBlitFramebuffer" => BlitFramebuffer(i, i, i, i, i, i, i, i, u, u) draw;
        "glClear" => Clear(u) draw;
        "glClearColor" => ClearColor(f, f, f, f);
        "glClearDepth" => ClearDepthf(f);
        "glClearStencil" => ClearStencil(i);
        "glClearBufferfi" => ClearBufferfi(u, i, f, i) draw;
        "glColorMask" => ColorMask(b, b, b, b);
        "glCompileShader" => CompileShader(u);
        "glCopyBufferSubData" => CopyBufferSubData(u, u, p, p, p);
        "glCullFace" => CullFace(u);
        "glDepthFunc" => DepthFunc(u);
        "glDepthMask" => DepthMask(b);
        "glDepthRange" => DepthRangef(f, f);
        "glDetachShader" => DetachShader(u, u);
        "glDisable" => Disable(u);
        "glDisableVertexAttribArray" => DisableVertexAttribArray(u);
        "glDrawArrays" => DrawArrays(u, i, i) draw;
        "glDrawArraysInstanced" => DrawArraysInstanced(u, i, i, i) draw;
        "glEnable" => Enable(u);
        "glEnableVertexAttribArray" => EnableVertexAttribArray(u);
        "glEndQuery" => EndQuery(u);
        "glEndTransformFeedback" => EndTransformFeedback();
        "glFinish" => Finish();
        "glFlush" => Flush();
        "glFramebufferRenderbuffer" => FramebufferRenderbuffer(u, u, u, u);
        "glFramebufferTexture2D" => FramebufferTexture2D(u, u, u, u, i);
        "glFramebufferTextureLayer" => FramebufferTextureLayer(u, u, u, i, i);
        "glFrontFace" => FrontFace(u);
        "glGenerateMipmap" => GenerateMipmap(u);
        "glHint" => Hint(u, u);
        "glLineWidth" => LineWidth(f);
        "glLinkProgram" => LinkProgram(u);
        "glPauseTransformFeedback" => PauseTransformFeedback();
        "glResumeTransformFeedback" => ResumeTransformFeedback();
        "glPixelStorei" => PixelStorei(u, i);
        "glPolygonOffset" => PolygonOffset(f, f);
        "glReadBuffer" => ReadBuffer(u);
        "glRenderbufferStorage" => RenderbufferStorage(u, u, i, i);
        "glRenderbufferStorageMultisample" => RenderbufferStorageMultisample(u, i, u, i, i);
        "glSampleCoverage" => SampleCoverage(f, b);
        "glSamplerParameteri" => SamplerParameteri(u, u, i);
        "glSamplerParameterf" => SamplerParameterf(u, u, f);
        "glScissor" => Scissor(i, i, i, i);
        "glStencilFunc" => StencilFunc(u, i, u);
        "glStencilFuncSeparate" => StencilFuncSeparate(u, u, i, u);
        "glStencilMask" => StencilMask(u);
        "glStencilMaskSeparate" => StencilMaskSeparate(u, u);
        "glStencilOp" => StencilOp(u, u, u);
        "glStencilOpSeparate" => StencilOpSeparate(u, u, u, u);
        "glTexParameteri" => TexParameteri(u, u, i);
        "glTexParameterf" => TexParameterf(u, u, f);
        "glTexStorage2D" => TexStorage2D(u, i, u, i, i);
        "glTexStorage3D" => TexStorage3D(u, i, u, i, i, i);
        "glUniform1f" => Uniform1f(i, f);
        "glUniform2f" => Uniform2f(i, f, f);
        "glUniform3f" => Uniform3f(i, f, f, f);
        "glUniform4f" => Uniform4f(i, f, f, f, f);
        "glUniform1i" => Uniform1i(i, i);
        "glUniform2i" => Uniform2i(i, i, i);
        "glUniform3i" => Uniform3i(i, i, i, i);
        "glUniform4i" => Uniform4i(i, i, i, i, i);
        "glUniform1ui" => Uniform1ui(i, u);
        "glUniform2ui" => Uniform2ui(i, u, u);
        "glUniform3ui" => Uniform3ui(i, u, u, u);
        "glUniform4ui" => Uniform4ui(i, u, u, u, u);
        "glUniformBlockBinding" => UniformBlockBinding(u, u, u);
        "glUseProgram" => UseProgram(u);
        "glValidateProgram" => ValidateProgram(u);
        "glVertexAttrib1f" => VertexAttrib1f(u, f);
        "glVertexAttrib2f" => VertexAttrib2f(u, f, f);
        "glVertexAttrib3f" => VertexAttrib3f(u, f, f, f);
        "glVertexAttrib4f" => VertexAttrib4f(u, f, f, f, f);
        "glVertexAttribI4i" => VertexAttribI4i(u, i, i, i, i);
        "glVertexAttribI4ui" => VertexAttribI4ui(u, u, u, u, u);
        "glVertexAttribDivisor" => VertexAttribDivisor(u, u);
        "glViewport" => Viewport(i, i, i, i);
        "glCheckFramebufferStatus" => CheckFramebufferStatus(u) enum;
        "glGetError" => GetError() enum;
        "glIsEnabled" => IsEnabled(u) bool;
        "glIsBuffer" => IsBuffer(u) bool;
        "glIsFramebuffer" => IsFramebuffer(u) bool;
        "glIsProgram" => IsProgram(u) bool;
        "glIsRenderbuffer" => IsRenderbuffer(u) bool;
        "glIsShader" => IsShader(u) bool;
        "glIsTexture" => IsTexture(u) bool;
        "glIsQuery" => IsQuery(u) bool;
        "glIsSampler" => IsSampler(u) bool;
        "glIsTransformFeedback" => IsTransformFeedback(u) bool;
        "glIsVertexArray" => IsVertexArray(u) bool;
    );

    natives!(scope, obj,
        // ------------------------------------------------------------ contexts
        // glCreate(width, height, version, attribute bits) → [id, attribute bits, samples] | "error"
        "glCreate" => |s, a, rv| {
            let (w, h, version, bits) = (ii(s, &a, 0), ii(s, &a, 1), uu(s, &a, 2) as u8, uu(s, &a, 3));
            let r = egl::egl().and_then(|e| GlCtx::new(e, version, Attrs::from_bits(bits), w, h));
            match r {
                Ok(c) => {
                    let at = c.attrs;
                    let bits = at.alpha as u32 | (at.depth as u32) << 1 | (at.stencil as u32) << 2 | (at.antialias as u32) << 3 | (at.premultiplied as u32) << 4 | (at.preserve as u32) << 5;
                    let samples = c.samples;
                    let id = add_ctx(c);
                    ret_nums(s, &mut rv, &[id as f64, bits as f64, samples as f64]);
                }
                Err(e) => ret_str(s, &mut rv, &e),
            }
        },
        "glDestroy" => |s, a, rv| { let id = num(s, &a, 0) as usize; remove_ctx(id); },
        "glResize" => |s, a, rv| {
            let (id, w, h) = (num(s, &a, 0) as usize, ii(s, &a, 1), ii(s, &a, 2));
            if let Some((w, h)) = with_ctx(id, |c, _| { c.resize(w, h); (c.w, c.h) }) {
                ret_nums(s, &mut rv, &[w as f64, h as f64]);
            }
        },
        // The drawing buffer as an image in the 2D runtime's image table (drawImage, createPattern).
        "glSnapshot" => |s, a, rv| {
            let id = num(s, &a, 0) as usize;
            let r = with_ctx(id, |c, egl| {
                if c.image_fresh {
                    if let Some(slot) = c.image_slot { return Some((slot, None)); }
                }
                // read straight into the image's pixels: a fresh Data, owned here alone, which
                // read_back_into fills completely (SkData::writable_data is this same cast)
                let n = (c.w * c.h * 4) as usize;
                let data = unsafe { sk::Data::new_uninitialized(n) };
                let px = unsafe { std::slice::from_raw_parts_mut(data.as_bytes().as_ptr() as *mut u8, n) };
                c.read_back_into(egl, px);
                // all opaque: Skia draws it as a copy instead of blending every pixel
                let at = if !c.attrs.alpha || crate::canvas::all_opaque(px) { sk::AlphaType::Opaque } else if c.attrs.premultiplied { sk::AlphaType::Premul } else { sk::AlphaType::Unpremul };
                let info = sk::ImageInfo::new((c.w, c.h), sk::ColorType::RGBA8888, at, None);
                let img = sk::images::raster_from_data(&info, data, (c.w * 4) as usize)?;
                c.image_fresh = true;
                Some((c.image_slot.unwrap_or(usize::MAX), Some(img)))
            }).flatten();
            match r {
                Some((slot, None)) => rv.set_int32(slot as i32),
                Some((slot, Some(img))) => {
                    let slot = with_rt(|r| {
                        if slot < r.images.len() { r.images[slot] = Some(ImageSrc::Raster(img)); slot } else { r.images.push(Some(ImageSrc::Raster(img))); r.images.len() - 1 }
                    });
                    with_ctx(id, |c, _| c.image_slot = Some(slot));
                    rv.set_int32(slot as i32);
                }
                None => rv.set_int32(-1),
            }
        },
        // [requestable GL extensions, enabled GL extensions, GL_RENDERER, GL_VENDOR, GL_VERSION, backend]
        "glInfo" => |s, a, rv| {
            let id = num(s, &a, 0) as usize;
            let r = with_ctx(id, |_, egl| [gl_string(super::gl::REQUESTABLE_EXTENSIONS_ANGLE), gl_string(gl::EXTENSIONS), gl_string(gl::RENDERER), gl_string(gl::VENDOR), gl_string(gl::VERSION), egl.backend.name().to_string()]);
            if let Some(v) = r {
                let elems: Vec<v8::Local<v8::Value>> = v.iter().map(|x| v8::String::new(s, x).unwrap().into()).collect();
                let arr = v8::Array::new_with_elements(s, &elems);
                rv.set(arr.into());
            }
        },
        "glRequestExtension" => |s, a, rv| {
            let (id, name) = (num(s, &a, 0) as usize, cstring(s, &a, 1));
            let ok = with_ctx(id, |_, egl| unsafe {
                (egl.angle.request_extension)(name.as_ptr());
                let _ = gl::GetError();
                gl_string(gl::EXTENSIONS).split(' ').any(|e| e.as_bytes() == name.as_bytes())
            }).unwrap_or(false);
            rv.set_bool(ok);
        },
        // ------------------------------------------------------------ objects
        // glCreate*: 0 buffer, 1 texture, 2 framebuffer, 3 renderbuffer, 4 vertex array, 5 query,
        // 6 sampler, 7 transform feedback, 8 program, 9 shader (arg 2 = type)
        "glCreateObject" => |s, a, rv| {
            let (id, kind, ty) = (num(s, &a, 0) as usize, ii(s, &a, 1), uu(s, &a, 2));
            let n = with_ctx(id, |_, _| unsafe {
                let mut n: GLuint = 0;
                match kind {
                    0 => gl::GenBuffers(1, &mut n),
                    1 => gl::GenTextures(1, &mut n),
                    2 => gl::GenFramebuffers(1, &mut n),
                    3 => gl::GenRenderbuffers(1, &mut n),
                    4 => gl::GenVertexArrays(1, &mut n),
                    5 => gl::GenQueries(1, &mut n),
                    6 => gl::GenSamplers(1, &mut n),
                    7 => gl::GenTransformFeedbacks(1, &mut n),
                    8 => n = gl::CreateProgram(),
                    9 => n = gl::CreateShader(ty),
                    _ => {}
                }
                n
            }).unwrap_or(0);
            rv.set_uint32(n);
        },
        "glDeleteObject" => |s, a, rv| {
            let (id, kind, n) = (num(s, &a, 0) as usize, ii(s, &a, 1), uu(s, &a, 2));
            with_ctx(id, |c, _| unsafe {
                match kind {
                    0 => gl::DeleteBuffers(1, &n),
                    1 => gl::DeleteTextures(1, &n),
                    2 => {
                        gl::DeleteFramebuffers(1, &n);
                        // deleting the bound framebuffer reverts to 0, which for the page means
                        // the drawing buffer
                        if c.version >= 2 {
                            if geti(gl::DRAW_FRAMEBUFFER_BINDING) == 0 { gl::BindFramebuffer(gl::DRAW_FRAMEBUFFER, c.fbo); }
                            if geti(gl::READ_FRAMEBUFFER_BINDING) == 0 { gl::BindFramebuffer(gl::READ_FRAMEBUFFER, c.fbo); }
                        } else if geti(gl::FRAMEBUFFER_BINDING) == 0 {
                            gl::BindFramebuffer(gl::FRAMEBUFFER, c.fbo);
                        }
                    }
                    3 => gl::DeleteRenderbuffers(1, &n),
                    4 => gl::DeleteVertexArrays(1, &n),
                    5 => gl::DeleteQueries(1, &n),
                    6 => gl::DeleteSamplers(1, &n),
                    7 => gl::DeleteTransformFeedbacks(1, &n),
                    8 => gl::DeleteProgram(n),
                    9 => gl::DeleteShader(n),
                    _ => {}
                }
            });
        },
        // bindFramebuffer(target, 0) binds the drawing buffer
        "glBindFramebuffer" => |s, a, rv| {
            let (id, target, n) = (num(s, &a, 0) as usize, uu(s, &a, 1), uu(s, &a, 2));
            with_ctx(id, |c, _| unsafe { gl::BindFramebuffer(target, if n == 0 { c.fbo } else { n }) });
        },
        // the GL name of the drawing buffer's framebuffer (so the page's binding queries can map it to null)
        "glDefaultFramebuffer" => |s, a, rv| {
            let id = num(s, &a, 0) as usize;
            rv.set_uint32(with_ctx(id, |c, _| c.fbo).unwrap_or(0));
        },
        // ------------------------------------------------------------ shaders, programs
        "glShaderSource" => |s, a, rv| {
            let (id, sh, src) = (num(s, &a, 0) as usize, uu(s, &a, 1), cstring(s, &a, 2));
            with_ctx(id, |_, _| unsafe { gl::ShaderSource(sh, 1, &src.as_ptr(), std::ptr::null()) });
        },
        "glGetShaderiv" => |s, a, rv| {
            let (id, sh, pname) = (num(s, &a, 0) as usize, uu(s, &a, 1), uu(s, &a, 2));
            if let Some(v) = with_ctx(id, |_, _| unsafe { let mut v = 0; gl::GetShaderiv(sh, pname, &mut v); v }) { rv.set_int32(v); }
        },
        "glGetProgramiv" => |s, a, rv| {
            let (id, p, pname) = (num(s, &a, 0) as usize, uu(s, &a, 1), uu(s, &a, 2));
            if let Some(v) = with_ctx(id, |_, _| unsafe { let mut v = 0; gl::GetProgramiv(p, pname, &mut v); v }) { rv.set_int32(v); }
        },
        "glGetShaderInfoLog" => |s, a, rv| {
            let (id, sh) = (num(s, &a, 0) as usize, uu(s, &a, 1));
            let log = with_ctx(id, |_, _| unsafe {
                let mut n = 0;
                gl::GetShaderiv(sh, gl::INFO_LOG_LENGTH, &mut n);
                let mut buf = vec![0u8; n.max(1) as usize];
                let mut len = 0;
                gl::GetShaderInfoLog(sh, n.max(1), &mut len, buf.as_mut_ptr() as *mut std::ffi::c_char);
                String::from_utf8_lossy(&buf[..len.max(0) as usize]).into_owned()
            }).unwrap_or_default();
            ret_str(s, &mut rv, &log);
        },
        "glGetProgramInfoLog" => |s, a, rv| {
            let (id, p) = (num(s, &a, 0) as usize, uu(s, &a, 1));
            let log = with_ctx(id, |_, _| unsafe {
                let mut n = 0;
                gl::GetProgramiv(p, gl::INFO_LOG_LENGTH, &mut n);
                let mut buf = vec![0u8; n.max(1) as usize];
                let mut len = 0;
                gl::GetProgramInfoLog(p, n.max(1), &mut len, buf.as_mut_ptr() as *mut std::ffi::c_char);
                String::from_utf8_lossy(&buf[..len.max(0) as usize]).into_owned()
            }).unwrap_or_default();
            ret_str(s, &mut rv, &log);
        },
        "glGetTranslatedShaderSource" => |s, a, rv| {
            // WEBGL_debug_shaders: ANGLE_translated_shader_source
            let (id, sh) = (num(s, &a, 0) as usize, uu(s, &a, 1));
            let src = with_ctx(id, |_, egl| unsafe {
                let f = egl.proc_address("glGetTranslatedShaderSourceANGLE");
                if f.is_null() { return String::new(); }
                let f: unsafe extern "system" fn(GLuint, GLsizei, *mut GLsizei, *mut std::ffi::c_char) = std::mem::transmute(f);
                let mut n = 0;
                gl::GetShaderiv(sh, 0x93A0, &mut n);
                let mut buf = vec![0u8; n.max(1) as usize];
                let mut len = 0;
                f(sh, n.max(1), &mut len, buf.as_mut_ptr() as *mut std::ffi::c_char);
                String::from_utf8_lossy(&buf[..len.max(0) as usize]).into_owned()
            }).unwrap_or_default();
            ret_str(s, &mut rv, &src);
        },
        "glGetAttachedShaders" => |s, a, rv| {
            let (id, p) = (num(s, &a, 0) as usize, uu(s, &a, 1));
            let v = with_ctx(id, |_, _| unsafe {
                let mut out = [0u32; 8];
                let mut n = 0;
                gl::GetAttachedShaders(p, 8, &mut n, out.as_mut_ptr());
                out[..n.max(0) as usize].iter().map(|x| *x as f64).collect::<Vec<_>>()
            }).unwrap_or_default();
            ret_nums(s, &mut rv, &v);
        },
        // location lookups by name: 0 attrib, 1 uniform, 2 frag data, 3 uniform block index
        "glGetLocation" => |s, a, rv| {
            let (id, kind, p, name) = (num(s, &a, 0) as usize, ii(s, &a, 1), uu(s, &a, 2), cstring(s, &a, 3));
            let v = with_ctx(id, |_, _| unsafe {
                match kind {
                    0 => gl::GetAttribLocation(p, name.as_ptr()),
                    1 => gl::GetUniformLocation(p, name.as_ptr()),
                    2 => gl::GetFragDataLocation(p, name.as_ptr()),
                    _ => gl::GetUniformBlockIndex(p, name.as_ptr()) as i32,
                }
            }).unwrap_or(-1);
            rv.set_int32(v);
        },
        "glBindAttribLocation" => |s, a, rv| {
            let (id, p, i, name) = (num(s, &a, 0) as usize, uu(s, &a, 1), uu(s, &a, 2), cstring(s, &a, 3));
            with_ctx(id, |_, _| unsafe { gl::BindAttribLocation(p, i, name.as_ptr()) });
        },
        // getActiveAttrib / getActiveUniform / getTransformFeedbackVarying → [name, size, type] | null
        "glGetActive" => |s, a, rv| {
            let (id, kind, p, i) = (num(s, &a, 0) as usize, ii(s, &a, 1), uu(s, &a, 2), uu(s, &a, 3));
            let r = with_ctx(id, |_, _| unsafe {
                let mut buf = vec![0u8; 512];
                let (mut len, mut size, mut ty) = (0, 0, 0u32);
                let before = gl::GetError();
                let _ = before;
                match kind {
                    0 => gl::GetActiveAttrib(p, i, 512, &mut len, &mut size, &mut ty, buf.as_mut_ptr() as *mut std::ffi::c_char),
                    1 => gl::GetActiveUniform(p, i, 512, &mut len, &mut size, &mut ty, buf.as_mut_ptr() as *mut std::ffi::c_char),
                    _ => gl::GetTransformFeedbackVarying(p, i, 512, &mut len, &mut size, &mut ty, buf.as_mut_ptr() as *mut std::ffi::c_char),
                }
                if ty == 0 { return None; }
                Some((String::from_utf8_lossy(&buf[..len.max(0) as usize]).into_owned(), size, ty))
            }).flatten();
            match r {
                Some((name, size, ty)) => {
                    let elems: Vec<v8::Local<v8::Value>> = vec![v8::String::new(s, &name).unwrap().into(), v8::Integer::new(s, size).into(), v8::Number::new(s, ty as f64).into()];
                    let arr = v8::Array::new_with_elements(s, &elems);
                    rv.set(arr.into());
                }
                None => rv.set_null(),
            }
        },
        "glGetActiveUniformBlockName" => |s, a, rv| {
            let (id, p, i) = (num(s, &a, 0) as usize, uu(s, &a, 1), uu(s, &a, 2));
            let r = with_ctx(id, |_, _| unsafe {
                let mut buf = vec![0u8; 512];
                let mut len = 0;
                gl::GetActiveUniformBlockName(p, i, 512, &mut len, buf.as_mut_ptr() as *mut std::ffi::c_char);
                (len > 0).then(|| String::from_utf8_lossy(&buf[..len as usize]).into_owned())
            }).flatten();
            match r { Some(n) => ret_str(s, &mut rv, &n), None => rv.set_null() }
        },
        "glGetActiveUniformBlockParameter" => |s, a, rv| {
            let (id, p, i, pname) = (num(s, &a, 0) as usize, uu(s, &a, 1), uu(s, &a, 2), uu(s, &a, 3));
            let r = with_ctx(id, |_, _| unsafe {
                if pname == gl::UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES {
                    let mut n = 0;
                    gl::GetActiveUniformBlockiv(p, i, gl::UNIFORM_BLOCK_ACTIVE_UNIFORMS, &mut n);
                    let mut v = vec![0i32; n.max(0) as usize];
                    if n > 0 { gl::GetActiveUniformBlockiv(p, i, pname, v.as_mut_ptr()); }
                    v.iter().map(|x| *x as u32 as f64).collect::<Vec<_>>()
                } else {
                    let mut v = 0;
                    gl::GetActiveUniformBlockiv(p, i, pname, &mut v);
                    vec![v as f64]
                }
            }).unwrap_or_default();
            ret_nums(s, &mut rv, &r);
        },
        "glGetUniformIndices" => |s, a, rv| {
            let (id, p) = (num(s, &a, 0) as usize, uu(s, &a, 1));
            let names = strings(s, a.get(2));
            let r = with_ctx(id, |_, _| unsafe {
                let ptrs: Vec<*const std::ffi::c_char> = names.iter().map(|n| n.as_ptr()).collect();
                let mut out = vec![0u32; names.len()];
                gl::GetUniformIndices(p, names.len() as i32, ptrs.as_ptr(), out.as_mut_ptr());
                out.iter().map(|x| *x as f64).collect::<Vec<_>>()
            }).unwrap_or_default();
            ret_nums(s, &mut rv, &r);
        },
        "glGetActiveUniforms" => |s, a, rv| {
            let (id, p) = (num(s, &a, 0) as usize, uu(s, &a, 1));
            let idx: Vec<u32> = numbers(s, a.get(2)).iter().map(|x| *x as u32).collect();
            let pname = uu(s, &a, 3);
            let r = with_ctx(id, |_, _| unsafe {
                let mut out = vec![0i32; idx.len()];
                gl::GetActiveUniformsiv(p, idx.len() as i32, idx.as_ptr(), pname, out.as_mut_ptr());
                out.iter().map(|x| *x as f64).collect::<Vec<_>>()
            }).unwrap_or_default();
            ret_nums(s, &mut rv, &r);
        },
        "glTransformFeedbackVaryings" => |s, a, rv| {
            let (id, p) = (num(s, &a, 0) as usize, uu(s, &a, 1));
            let names = strings(s, a.get(2));
            let mode = uu(s, &a, 3);
            with_ctx(id, |_, _| unsafe {
                let ptrs: Vec<*const std::ffi::c_char> = names.iter().map(|n| n.as_ptr()).collect();
                gl::TransformFeedbackVaryings(p, names.len() as i32, ptrs.as_ptr(), mode);
            });
        },
        // ------------------------------------------------------------ buffers
        "glBufferDataSize" => |s, a, rv| {
            let (id, target, size, usage) = (num(s, &a, 0) as usize, uu(s, &a, 1), pp(s, &a, 2), uu(s, &a, 3));
            with_ctx(id, |_, _| unsafe { gl::BufferData(target, size, std::ptr::null(), usage) });
        },
        "glBufferData" => |s, a, rv| {
            let (id, target, usage) = (num(s, &a, 0) as usize, uu(s, &a, 1), uu(s, &a, 3));
            let Some(data) = bytes(a.get(2)) else { return };
            with_ctx(id, |_, _| unsafe { gl::BufferData(target, data.len() as isize, data.as_ptr() as *const c_void, usage) });
        },
        "glBufferSubData" => |s, a, rv| {
            let (id, target, off) = (num(s, &a, 0) as usize, uu(s, &a, 1), pp(s, &a, 2));
            let Some(data) = bytes(a.get(3)) else { return };
            with_ctx(id, |_, _| unsafe { gl::BufferSubData(target, off, data.len() as isize, data.as_ptr() as *const c_void) });
        },
        "glGetBufferSubData" => |s, a, rv| {
            let (id, target, off) = (num(s, &a, 0) as usize, uu(s, &a, 1), pp(s, &a, 2));
            let Some(out) = bytes(a.get(3)) else { return };
            with_ctx(id, |_, _| unsafe {
                if out.is_empty() { return; }
                let p = gl::MapBufferRange(target, off, out.len() as isize, gl::MAP_READ_BIT);
                if !p.is_null() {
                    std::ptr::copy_nonoverlapping(p as *const u8, out.as_mut_ptr(), out.len());
                    gl::UnmapBuffer(target);
                }
            });
        },
        // ------------------------------------------------------------ vertex attributes, draws
        "glVertexAttribPointer" => |s, a, rv| {
            let id = num(s, &a, 0) as usize;
            let (i, size, ty, norm, stride, off) = (uu(s, &a, 1), ii(s, &a, 2), uu(s, &a, 3), bb(s, &a, 4), ii(s, &a, 5), pp(s, &a, 6));
            with_ctx(id, |_, _| unsafe { gl::VertexAttribPointer(i, size, ty, norm, stride, off as *const c_void) });
        },
        "glVertexAttribIPointer" => |s, a, rv| {
            let id = num(s, &a, 0) as usize;
            let (i, size, ty, stride, off) = (uu(s, &a, 1), ii(s, &a, 2), uu(s, &a, 3), ii(s, &a, 4), pp(s, &a, 5));
            with_ctx(id, |_, _| unsafe { gl::VertexAttribIPointer(i, size, ty, stride, off as *const c_void) });
        },
        "glDrawElements" => |s, a, rv| {
            let id = num(s, &a, 0) as usize;
            let (mode, count, ty, off) = (uu(s, &a, 1), ii(s, &a, 2), uu(s, &a, 3), pp(s, &a, 4));
            with_ctx(id, |c, _| { mark(c); unsafe { gl::DrawElements(mode, count, ty, off as *const c_void) } });
        },
        "glDrawElementsInstanced" => |s, a, rv| {
            let id = num(s, &a, 0) as usize;
            let (mode, count, ty, off, n) = (uu(s, &a, 1), ii(s, &a, 2), uu(s, &a, 3), pp(s, &a, 4), ii(s, &a, 5));
            with_ctx(id, |c, _| { mark(c); unsafe { gl::DrawElementsInstanced(mode, count, ty, off as *const c_void, n) } });
        },
        "glDrawRangeElements" => |s, a, rv| {
            let id = num(s, &a, 0) as usize;
            let (mode, start, end, count, ty, off) = (uu(s, &a, 1), uu(s, &a, 2), uu(s, &a, 3), ii(s, &a, 4), uu(s, &a, 5), pp(s, &a, 6));
            with_ctx(id, |c, _| { mark(c); unsafe { gl::DrawRangeElements(mode, start, end, count, ty, off as *const c_void) } });
        },
        "glDrawBuffers" => |s, a, rv| {
            let id = num(s, &a, 0) as usize;
            let bufs: Vec<u32> = numbers(s, a.get(1)).iter().map(|x| *x as u32).collect();
            with_ctx(id, |_, _| unsafe { gl::DrawBuffers(bufs.len() as i32, bufs.as_ptr()) });
        },
        "glInvalidateFramebuffer" => |s, a, rv| {
            let (id, target) = (num(s, &a, 0) as usize, uu(s, &a, 1));
            let att: Vec<u32> = numbers(s, a.get(2)).iter().map(|x| *x as u32).collect();
            let sub: Vec<i32> = (3..7).map(|i| ii(s, &a, i)).collect();
            let whole = a.length() < 7;
            with_ctx(id, |_, _| unsafe {
                if whole { gl::InvalidateFramebuffer(target, att.len() as i32, att.as_ptr()) } else { gl::InvalidateSubFramebuffer(target, att.len() as i32, att.as_ptr(), sub[0], sub[1], sub[2], sub[3]) }
            });
        },
        // ------------------------------------------------------------ uniforms (typed arrays)
        // glUniformv(kind 0 f / 1 i / 2 ui, components, location, view)
        "glUniformv" => |s, a, rv| {
            let (id, kind, n, loc) = (num(s, &a, 0) as usize, ii(s, &a, 1), ii(s, &a, 2), ii(s, &a, 3));
            let Some(d) = bytes(a.get(4)) else { return };
            let count = (d.len() / 4) as i32 / n.max(1);
            let p = d.as_ptr();
            with_ctx(id, |_, _| unsafe {
                match (kind, n) {
                    (0, 1) => gl::Uniform1fv(loc, count, p as *const f32),
                    (0, 2) => gl::Uniform2fv(loc, count, p as *const f32),
                    (0, 3) => gl::Uniform3fv(loc, count, p as *const f32),
                    (0, 4) => gl::Uniform4fv(loc, count, p as *const f32),
                    (1, 1) => gl::Uniform1iv(loc, count, p as *const i32),
                    (1, 2) => gl::Uniform2iv(loc, count, p as *const i32),
                    (1, 3) => gl::Uniform3iv(loc, count, p as *const i32),
                    (1, 4) => gl::Uniform4iv(loc, count, p as *const i32),
                    (2, 1) => gl::Uniform1uiv(loc, count, p as *const u32),
                    (2, 2) => gl::Uniform2uiv(loc, count, p as *const u32),
                    (2, 3) => gl::Uniform3uiv(loc, count, p as *const u32),
                    (2, 4) => gl::Uniform4uiv(loc, count, p as *const u32),
                    _ => {}
                }
            });
        },
        // glUniformMatrix(cols, rows, location, transpose, view)
        "glUniformMatrix" => |s, a, rv| {
            let (id, cols, rows, loc, tr) = (num(s, &a, 0) as usize, ii(s, &a, 1), ii(s, &a, 2), ii(s, &a, 3), bb(s, &a, 4));
            let Some(d) = bytes(a.get(5)) else { return };
            let count = (d.len() / 4) as i32 / (cols * rows).max(1);
            let p = d.as_ptr() as *const f32;
            with_ctx(id, |_, _| unsafe {
                match (cols, rows) {
                    (2, 2) => gl::UniformMatrix2fv(loc, count, tr, p),
                    (3, 3) => gl::UniformMatrix3fv(loc, count, tr, p),
                    (4, 4) => gl::UniformMatrix4fv(loc, count, tr, p),
                    (2, 3) => gl::UniformMatrix2x3fv(loc, count, tr, p),
                    (3, 2) => gl::UniformMatrix3x2fv(loc, count, tr, p),
                    (2, 4) => gl::UniformMatrix2x4fv(loc, count, tr, p),
                    (4, 2) => gl::UniformMatrix4x2fv(loc, count, tr, p),
                    (3, 4) => gl::UniformMatrix3x4fv(loc, count, tr, p),
                    (4, 3) => gl::UniformMatrix4x3fv(loc, count, tr, p),
                    _ => {}
                }
            });
        },
        // glGetUniform(kind 0 f / 1 i / 2 ui, program, location, components) → numbers
        "glGetUniform" => |s, a, rv| {
            let (id, kind, p, loc, n) = (num(s, &a, 0) as usize, ii(s, &a, 1), uu(s, &a, 2), ii(s, &a, 3), ii(s, &a, 4));
            let v = with_ctx(id, |_, _| unsafe {
                let n = n.clamp(1, 16) as usize;
                match kind {
                    0 => { let mut v = [0f32; 16]; gl::GetUniformfv(p, loc, v.as_mut_ptr()); v[..n].iter().map(|x| *x as f64).collect::<Vec<_>>() }
                    1 => { let mut v = [0i32; 16]; gl::GetUniformiv(p, loc, v.as_mut_ptr()); v[..n].iter().map(|x| *x as f64).collect() }
                    _ => { let mut v = [0u32; 16]; gl::GetUniformuiv(p, loc, v.as_mut_ptr()); v[..n].iter().map(|x| *x as f64).collect() }
                }
            }).unwrap_or_default();
            ret_nums(s, &mut rv, &v);
        },
        // glVertexAttribv(kind 0 f / 1 i / 2 ui, components, index, view)
        "glVertexAttribv" => |s, a, rv| {
            let (id, kind, n, i) = (num(s, &a, 0) as usize, ii(s, &a, 1), ii(s, &a, 2), uu(s, &a, 3));
            let Some(d) = bytes(a.get(4)) else { return };
            if d.len() < (n as usize) * 4 { return; }
            let p = d.as_ptr();
            with_ctx(id, |_, _| unsafe {
                match (kind, n) {
                    (0, 1) => gl::VertexAttrib1fv(i, p as *const f32),
                    (0, 2) => gl::VertexAttrib2fv(i, p as *const f32),
                    (0, 3) => gl::VertexAttrib3fv(i, p as *const f32),
                    (0, 4) => gl::VertexAttrib4fv(i, p as *const f32),
                    (1, 4) => gl::VertexAttribI4iv(i, p as *const i32),
                    (2, 4) => gl::VertexAttribI4uiv(i, p as *const u32),
                    _ => {}
                }
            });
        },
        // glClearBufferv(kind 0 f / 1 i / 2 ui, buffer, drawbuffer, view)
        "glClearBufferv" => |s, a, rv| {
            let (id, kind, buffer, db) = (num(s, &a, 0) as usize, ii(s, &a, 1), uu(s, &a, 2), ii(s, &a, 3));
            let Some(d) = bytes(a.get(4)) else { return };
            let need = if buffer == gl::COLOR { 16 } else { 4 };
            if d.len() < need { return; }
            let p = d.as_ptr();
            with_ctx(id, |c, _| unsafe {
                mark(c);
                match kind {
                    0 => gl::ClearBufferfv(buffer, db, p as *const f32),
                    1 => gl::ClearBufferiv(buffer, db, p as *const i32),
                    _ => gl::ClearBufferuiv(buffer, db, p as *const u32),
                }
            });
        },
        // ------------------------------------------------------------ textures
        // glTexImage(fn 0 texImage2D / 1 texSubImage2D / 2 texImage3D / 3 texSubImage3D,
        //   target, level, internalformat, x, y, z, w, h, d, border, format, type,
        //   data: view | null | PBO offset, flipY, premultiply)
        "glTexImage" => |s, a, rv| {
            let id = num(s, &a, 0) as usize;
            let f = ii(s, &a, 1);
            let v: Vec<i32> = (2..14).map(|i| ii(s, &a, i)).collect();
            let (target, level, ifmt, x, y, z, w, h, d, border, format, ty) = (v[0] as u32, v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], v[9], v[10] as u32, v[11] as u32);
            let src = a.get(14);
            let (flip, premul) = (bb(s, &a, 15) != 0, bb(s, &a, 16) != 0);
            let view = bytes(src);
            let pbo_offset = if view.is_none() && src.is_number() { Some(pp(s, &a, 14)) } else { None };
            // UNPACK_FLIP_Y / PREMULTIPLY_ALPHA on client data: Blink converts on the CPU first
            let mut owned: Option<Vec<u8>> = None;
            if let Some(data) = &view {
                if (flip || premul) && !data.is_empty() {
                    let unpack_align = with_ctx(id, |_, _| geti(gl::UNPACK_ALIGNMENT)).unwrap_or(4).max(1) as usize;
                    if let Some(bpp) = pixels::bytes_per_pixel(format, ty) {
                        let row = (bpp * w.max(0) as usize).div_ceil(unpack_align) * unpack_align;
                        let rows = (h.max(0) * d.max(1)) as usize;
                        if row * rows <= data.len() {
                            let mut buf = data[..row * rows].to_vec();
                            if premul && format == gl::RGBA && ty == gl::UNSIGNED_BYTE && row == w as usize * 4 {
                                pixels::premultiply(&mut buf);
                            }
                            if flip {
                                for k in 0..d.max(1) as usize {
                                    let slice = &mut buf[k * row * h as usize..(k + 1) * row * h as usize];
                                    pixels::flip_rows(slice, row, h as usize);
                                }
                            }
                            owned = Some(buf);
                        }
                    }
                }
            }
            let (ptr, size): (*const c_void, i32) = match (&owned, &view, pbo_offset) {
                (Some(b), _, _) => (b.as_ptr() as *const c_void, b.len() as i32),
                (None, Some(b), _) => (if b.is_empty() { std::ptr::null() } else { b.as_ptr() as *const c_void }, b.len() as i32),
                (None, None, Some(off)) => (off as *const c_void, 0),
                _ => (std::ptr::null(), 0),
            };
            let is_pbo = pbo_offset.is_some();
            with_ctx(id, |_, egl| unsafe {
                let ag = &egl.angle;
                match (f, is_pbo) {
                    (0, false) => (ag.tex_image_2d_robust)(target, level, ifmt, w, h, border, format, ty, size, ptr),
                    (1, false) => (ag.tex_sub_image_2d_robust)(target, level, x, y, w, h, format, ty, size, ptr),
                    (2, false) => (ag.tex_image_3d_robust)(target, level, ifmt, w, h, d, border, format, ty, size, ptr),
                    (3, false) => (ag.tex_sub_image_3d_robust)(target, level, x, y, z, w, h, d, format, ty, size, ptr),
                    (0, true) => gl::TexImage2D(target, level, ifmt, w, h, border, format, ty, ptr),
                    (1, true) => gl::TexSubImage2D(target, level, x, y, w, h, format, ty, ptr),
                    (2, true) => gl::TexImage3D(target, level, ifmt, w, h, d, border, format, ty, ptr),
                    _ => gl::TexSubImage3D(target, level, x, y, z, w, h, d, format, ty, ptr),
                }
            });
        },
        // glTexImageSource(fn as above, target, level, internalformat, x, y, z, w, h, d, format, type,
        //   source kind (0 image, 1 2D canvas, 2 WebGL canvas, 3 ImageData), source id | bytes,
        //   ImageData w, h, flipY, premultiply) → [w, h] of the source, or null if it had no pixels
        "glTexImageSource" => |s, a, rv| {
            let id = num(s, &a, 0) as usize;
            let f = ii(s, &a, 1);
            let v: Vec<i32> = (2..13).map(|i| ii(s, &a, i)).collect();
            let (target, level, ifmt, x, y, z, w, h, d, format, ty) = (v[0] as u32, v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], v[9] as u32, v[10] as u32);
            let kind = ii(s, &a, 13);
            let src_v = a.get(14);
            let data = bytes(src_v);
            let src_id = if data.is_none() { num(s, &a, 14) as usize } else { 0 };
            let (dw, dh, flip, premul) = (ii(s, &a, 15), ii(s, &a, 16), bb(s, &a, 17) != 0, bb(s, &a, 18) != 0);
            let Some((mut px, sw, sh)) = source_pixels(kind, src_id, data.as_deref(), dw, dh, premul) else { rv.set_null(); return };
            // explicit sizes (WebGL 2 overloads) take the top-left w×h of the source
            let (uw, uh) = if w > 0 && h > 0 { (w.min(sw), h.min(sh)) } else { (sw, sh) };
            if (uw, uh) != (sw, sh) {
                let mut cropped = Vec::with_capacity((uw * uh * 4) as usize);
                for row in 0..uh as usize { cropped.extend_from_slice(&px[row * sw as usize * 4..row * sw as usize * 4 + uw as usize * 4]); }
                px = cropped;
            }
            if flip { pixels::flip_rows(&mut px, uw as usize * 4, uh as usize); }
            let Some(packed) = pixels::pack(&px, format, ty) else {
                with_ctx(id, |_, _| ());
                eprintln!("motion-render: texImage from an image source to format 0x{:x} type 0x{:x} is not supported", format, ty);
                rv.set_null();
                return;
            };
            // 3D uploads from an image: the image is the slices stacked vertically
            let (h3, d3) = if f >= 2 { let d = d.max(1); (uh / d, d) } else { (uh, 1) };
            with_ctx(id, |_, egl| unsafe {
                let es3 = geti(gl::MAJOR_VERSION) >= 3;
                let un = Unpack::reset(es3);
                let ag = &egl.angle;
                let p = packed.as_ptr() as *const c_void;
                let n = packed.len() as i32;
                match f {
                    0 => (ag.tex_image_2d_robust)(target, level, ifmt, uw, uh, 0, format, ty, n, p),
                    1 => (ag.tex_sub_image_2d_robust)(target, level, x, y, uw, uh, format, ty, n, p),
                    2 => (ag.tex_image_3d_robust)(target, level, ifmt, uw, h3, d3, 0, format, ty, n, p),
                    _ => (ag.tex_sub_image_3d_robust)(target, level, x, y, z, uw, h3, d3, format, ty, n, p),
                }
                un.restore(es3);
            });
            ret_nums(s, &mut rv, &[sw as f64, sh as f64]);
        },
        // glCompressedTexImage(fn 0 2D / 1 sub2D / 2 3D / 3 sub3D, target, level, internalformat|format,
        //   x, y, z, w, h, d, view | (PBO offset, size))
        "glCompressedTexImage" => |s, a, rv| {
            let id = num(s, &a, 0) as usize;
            let f = ii(s, &a, 1);
            let v: Vec<i32> = (2..11).map(|i| ii(s, &a, i)).collect();
            let (target, level, fmt, x, y, z, w, h, d) = (v[0] as u32, v[1], v[2] as u32, v[3], v[4], v[5], v[6], v[7], v[8]);
            let src = a.get(11);
            let view = bytes(src);
            let (ptr, size, data_size): (*const c_void, i32, i32) = match &view {
                Some(b) => (b.as_ptr() as *const c_void, b.len() as i32, b.len() as i32),
                None => (pp(s, &a, 11) as *const c_void, ii(s, &a, 12), 0),
            };
            let _ = data_size;
            // compressed uploads read exactly imageSize bytes, which is the view's length
            with_ctx(id, |_, _| unsafe {
                match f {
                    0 => gl::CompressedTexImage2D(target, level, fmt, w, h, 0, size, ptr),
                    1 => gl::CompressedTexSubImage2D(target, level, x, y, w, h, fmt, size, ptr),
                    2 => gl::CompressedTexImage3D(target, level, fmt, w, h, d, 0, size, ptr),
                    _ => gl::CompressedTexSubImage3D(target, level, x, y, z, w, h, d, fmt, size, ptr),
                }
            });
        },
        // copyTexImage2D / copyTexSubImage2D / copyTexSubImage3D: the default framebuffer is
        // resolved first when it is multisampled
        "glCopyTexImage2D" => |s, a, rv| {
            let id = num(s, &a, 0) as usize;
            let v: Vec<i32> = (1..9).map(|i| ii(s, &a, i)).collect();
            with_ctx(id, |c, _| unsafe {
                let prev = c.begin_default_read();
                gl::CopyTexImage2D(v[0] as u32, v[1], v[2] as u32, v[3], v[4], v[5], v[6], v[7]);
                c.end_default_read(prev);
            });
        },
        "glCopyTexSubImage2D" => |s, a, rv| {
            let id = num(s, &a, 0) as usize;
            let v: Vec<i32> = (1..9).map(|i| ii(s, &a, i)).collect();
            with_ctx(id, |c, _| unsafe {
                let prev = c.begin_default_read();
                gl::CopyTexSubImage2D(v[0] as u32, v[1], v[2], v[3], v[4], v[5], v[6], v[7]);
                c.end_default_read(prev);
            });
        },
        "glCopyTexSubImage3D" => |s, a, rv| {
            let id = num(s, &a, 0) as usize;
            let v: Vec<i32> = (1..10).map(|i| ii(s, &a, i)).collect();
            with_ctx(id, |c, _| unsafe {
                let prev = c.begin_default_read();
                gl::CopyTexSubImage3D(v[0] as u32, v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8]);
                c.end_default_read(prev);
            });
        },
        // glReadPixels(x, y, w, h, format, type, view | PBO offset)
        "glReadPixels" => |s, a, rv| {
            let id = num(s, &a, 0) as usize;
            let v: Vec<i32> = (1..7).map(|i| ii(s, &a, i)).collect();
            let view = bytes(a.get(7));
            let off = if view.is_none() { pp(s, &a, 7) } else { 0 };
            with_ctx(id, |c, egl| unsafe {
                let prev = c.begin_default_read();
                match view {
                    Some(out) => {
                        let mut len = 0;
                        (egl.angle.read_pixels_robust)(v[0], v[1], v[2], v[3], v[4] as u32, v[5] as u32, out.len() as i32, &mut len, std::ptr::null_mut(), std::ptr::null_mut(), out.as_mut_ptr() as *mut c_void);
                    }
                    None => gl::ReadPixels(v[0], v[1], v[2], v[3], v[4] as u32, v[5] as u32, off as *mut c_void),
                }
                c.end_default_read(prev);
            });
        },
        // ------------------------------------------------------------ queries of state
        // glGet(kind 0 int / 1 float / 2 bool / 3 int64, pname, count) → number[]
        "glGet" => |s, a, rv| {
            let (id, kind, pname, n) = (num(s, &a, 0) as usize, ii(s, &a, 1), uu(s, &a, 2), ii(s, &a, 3).clamp(1, 16) as usize);
            let v = with_ctx(id, |_, _| unsafe {
                match kind {
                    0 => { let mut v = [0i32; 16]; gl::GetIntegerv(pname, v.as_mut_ptr()); v[..n].iter().map(|x| *x as f64).collect::<Vec<_>>() }
                    1 => { let mut v = [0f32; 16]; gl::GetFloatv(pname, v.as_mut_ptr()); v[..n].iter().map(|x| *x as f64).collect() }
                    2 => { let mut v = [0u8; 16]; gl::GetBooleanv(pname, v.as_mut_ptr()); v[..n].iter().map(|x| *x as f64).collect() }
                    _ => { let mut v = [0i64; 16]; gl::GetInteger64v(pname, v.as_mut_ptr()); v[..n].iter().map(|x| *x as f64).collect() }
                }
            }).unwrap_or_default();
            ret_nums(s, &mut rv, &v);
        },
        "glGetString" => |s, a, rv| {
            let (id, pname) = (num(s, &a, 0) as usize, uu(s, &a, 1));
            let v = with_ctx(id, |_, _| gl_string(pname)).unwrap_or_default();
            ret_str(s, &mut rv, &v);
        },
        // glGetIndexed(kind 0 int / 1 int64, pname, index)
        "glGetIndexed" => |s, a, rv| {
            let (id, kind, pname, i) = (num(s, &a, 0) as usize, ii(s, &a, 1), uu(s, &a, 2), uu(s, &a, 3));
            let v = with_ctx(id, |_, _| unsafe {
                if kind == 0 { let mut v = 0; gl::GetIntegeri_v(pname, i, &mut v); v as f64 } else { let mut v = 0i64; gl::GetInteger64i_v(pname, i, &mut v); v as f64 }
            }).unwrap_or(0.0);
            rv.set_double(v);
        },
        // glGetObjectParameter(which, a, b, c) → number:
        //  0 texture (target, pname, float?)  1 buffer (target, pname)  2 renderbuffer (target, pname)
        //  3 framebuffer attachment (target, attachment, pname)  4 sampler (sampler, pname, float?)
        //  5 query object (query, pname)  6 query (target, pname)  7 vertex attrib (index, pname)
        //  8 vertex attrib offset (index, pname)  9 sync (sync index, pname)
        "glGetObjectParameter" => |s, a, rv| {
            let (id, which, x, y, z) = (num(s, &a, 0) as usize, ii(s, &a, 1), uu(s, &a, 2), uu(s, &a, 3), uu(s, &a, 4));
            let v = with_ctx(id, |c, _| unsafe {
                let mut i = 0i32;
                let mut fl = 0f32;
                match which {
                    0 if z != 0 => { gl::GetTexParameterfv(x, y, &mut fl); return fl as f64; }
                    0 => gl::GetTexParameteriv(x, y, &mut i),
                    1 => { let mut l = 0i64; gl::GetBufferParameteri64v(x, y, &mut l); return l as f64; }
                    2 => gl::GetRenderbufferParameteriv(x, y, &mut i),
                    3 => gl::GetFramebufferAttachmentParameteriv(x, y, z, &mut i),
                    4 if z != 0 => { gl::GetSamplerParameterfv(x, y, &mut fl); return fl as f64; }
                    4 => gl::GetSamplerParameteriv(x, y, &mut i),
                    5 => { let mut u = 0u32; gl::GetQueryObjectuiv(x, y, &mut u); return u as f64; }
                    6 => gl::GetQueryiv(x, y, &mut i),
                    7 => gl::GetVertexAttribiv(x, y, &mut i),
                    8 => { let mut p: *mut c_void = std::ptr::null_mut(); gl::GetVertexAttribPointerv(x, y, &mut p); return p as usize as f64; }
                    9 => {
                        if let Some(Some(sync)) = c.syncs.get(x as usize) { let mut len = 0; gl::GetSynciv(*sync, y, 1, &mut len, &mut i); }
                    }
                    _ => {}
                }
                i as f64
            }).unwrap_or(0.0);
            rv.set_double(v);
        },
        "glGetVertexAttribCurrent" => |s, a, rv| {
            // CURRENT_VERTEX_ATTRIB as [f, f, f, f] (kind 0), ints (1) or uints (2)
            let (id, i, kind) = (num(s, &a, 0) as usize, uu(s, &a, 1), ii(s, &a, 2));
            let v = with_ctx(id, |_, _| unsafe {
                match kind {
                    1 => { let mut v = [0i32; 4]; gl::GetVertexAttribIiv(i, gl::CURRENT_VERTEX_ATTRIB, v.as_mut_ptr()); v.iter().map(|x| *x as f64).collect::<Vec<_>>() }
                    2 => { let mut v = [0u32; 4]; gl::GetVertexAttribIuiv(i, gl::CURRENT_VERTEX_ATTRIB, v.as_mut_ptr()); v.iter().map(|x| *x as f64).collect() }
                    _ => { let mut v = [0f32; 4]; gl::GetVertexAttribfv(i, gl::CURRENT_VERTEX_ATTRIB, v.as_mut_ptr()); v.iter().map(|x| *x as f64).collect() }
                }
            }).unwrap_or_default();
            ret_nums(s, &mut rv, &v);
        },
        "glGetInternalformatParameter" => |s, a, rv| {
            let (id, target, ifmt, pname) = (num(s, &a, 0) as usize, uu(s, &a, 1), uu(s, &a, 2), uu(s, &a, 3));
            let v = with_ctx(id, |_, _| unsafe {
                let mut n = 0;
                gl::GetInternalformativ(target, ifmt, gl::NUM_SAMPLE_COUNTS, 1, &mut n);
                if pname == gl::NUM_SAMPLE_COUNTS { return vec![n as f64]; }
                let mut v = vec![0i32; n.max(0) as usize];
                if n > 0 { gl::GetInternalformativ(target, ifmt, pname, n, v.as_mut_ptr()); }
                v.iter().map(|x| *x as f64).collect()
            }).unwrap_or_default();
            ret_nums(s, &mut rv, &v);
        },
        "glGetShaderPrecisionFormat" => |s, a, rv| {
            let (id, sh, p) = (num(s, &a, 0) as usize, uu(s, &a, 1), uu(s, &a, 2));
            let v = with_ctx(id, |_, _| unsafe {
                let mut range = [0i32; 2];
                let mut prec = 0;
                gl::GetShaderPrecisionFormat(sh, p, range.as_mut_ptr(), &mut prec);
                vec![range[0] as f64, range[1] as f64, prec as f64]
            }).unwrap_or_default();
            ret_nums(s, &mut rv, &v);
        },
        // ------------------------------------------------------------ syncs
        "glFenceSync" => |s, a, rv| {
            let (id, cond, flags) = (num(s, &a, 0) as usize, uu(s, &a, 1), uu(s, &a, 2));
            let v = with_ctx(id, |c, _| unsafe {
                let sy = gl::FenceSync(cond, flags);
                if sy.is_null() { return -1; }
                c.syncs.push(Some(sy));
                c.syncs.len() as i32 - 1
            }).unwrap_or(-1);
            rv.set_int32(v);
        },
        "glDeleteSync" => |s, a, rv| {
            let (id, k) = (num(s, &a, 0) as usize, num(s, &a, 1) as usize);
            with_ctx(id, |c, _| unsafe { if let Some(sy) = c.syncs.get_mut(k).and_then(|x| x.take()) { gl::DeleteSync(sy); } });
        },
        "glClientWaitSync" => |s, a, rv| {
            let (id, k, flags, timeout) = (num(s, &a, 0) as usize, num(s, &a, 1) as usize, uu(s, &a, 2), num(s, &a, 3) as u64);
            let v = with_ctx(id, |c, _| unsafe {
                match c.syncs.get(k) { Some(Some(sy)) => gl::ClientWaitSync(*sy, flags, timeout), _ => gl::WAIT_FAILED }
            }).unwrap_or(gl::WAIT_FAILED);
            rv.set_uint32(v);
        },
        "glWaitSync" => |s, a, rv| {
            let (id, k, flags) = (num(s, &a, 0) as usize, num(s, &a, 1) as usize, uu(s, &a, 2));
            with_ctx(id, |c, _| unsafe { if let Some(Some(sy)) = c.syncs.get(k) { gl::WaitSync(*sy, flags, gl::TIMEOUT_IGNORED) } });
        },
    );
}
