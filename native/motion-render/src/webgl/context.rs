//! One WebGL context: an ANGLE context plus the drawing buffer a browser gives a WebGL canvas.
//! The context has no surface; its "default framebuffer" is a framebuffer object owned here
//! (colour RGBA8 or RGB8 for alpha:false, depth/stencil as asked, 4x MSAA for antialias:true
//! with a resolve target, like Blink's DrawingBuffer with explicit resolve). The page binding
//! `null` binds this object; reading the canvas resolves and reads it back.
use super::egl::Egl;
use super::gl::{self, types::*};
use std::ffi::c_void;

#[derive(Clone, Copy, Debug)]
pub struct Attrs {
    pub alpha: bool,
    pub depth: bool,
    pub stencil: bool,
    pub antialias: bool,
    pub premultiplied: bool,
    pub preserve: bool,
}

impl Attrs {
    pub fn from_bits(b: u32) -> Attrs {
        Attrs { alpha: b & 1 != 0, depth: b & 2 != 0, stencil: b & 4 != 0, antialias: b & 8 != 0, premultiplied: b & 16 != 0, preserve: b & 32 != 0 }
    }
}

pub struct GlCtx {
    pub egl: *mut c_void,
    pub version: u8,
    pub attrs: Attrs,
    pub w: i32,
    pub h: i32,
    pub samples: i32,
    /// the drawing buffer the page sees as framebuffer `null`
    pub fbo: GLuint,
    color: GLuint,
    depth: GLuint,
    /// single-sample copy of an antialiased buffer, for reads
    resolve_fbo: GLuint,
    resolve_color: GLuint,
    /// drawn into since the last read-back / since the frame began
    pub dirty: bool,
    pub drawn_this_frame: bool,
    /// slot in the 2D runtime's image table that holds the last read-back
    pub image_slot: Option<usize>,
    pub image_fresh: bool,
    pub syncs: Vec<Option<GLsync>>,
    /// pixel-pack buffer for read_back (ES 3) and its size
    pbo: GLuint,
    pbo_len: usize,
}

/// Saves the bits of GL state the drawing-buffer plumbing touches and puts them back on drop.
struct Saved {
    draw_fb: GLint,
    read_fb: GLint,
    rb: GLint,
    pack_buffer: GLint,
    pack: [GLint; 4],
    scissor: bool,
    discard: bool,
    color_mask: [GLboolean; 4],
    depth_mask: GLboolean,
    stencil_mask: [GLint; 2],
    clear_color: [f32; 4],
    clear_depth: f32,
    clear_stencil: GLint,
}

fn geti(p: GLenum) -> GLint {
    let mut v = 0;
    unsafe { gl::GetIntegerv(p, &mut v) };
    v
}

impl Saved {
    fn take(version: u8) -> Saved {
        unsafe {
            let mut color_mask = [0u8; 4];
            gl::GetBooleanv(gl::COLOR_WRITEMASK, color_mask.as_mut_ptr());
            let mut depth_mask = 0u8;
            gl::GetBooleanv(gl::DEPTH_WRITEMASK, &mut depth_mask);
            let mut clear_color = [0f32; 4];
            gl::GetFloatv(gl::COLOR_CLEAR_VALUE, clear_color.as_mut_ptr());
            let mut clear_depth = 0f32;
            gl::GetFloatv(gl::DEPTH_CLEAR_VALUE, &mut clear_depth);
            let es3 = version >= 2;
            Saved {
                draw_fb: geti(if es3 { gl::DRAW_FRAMEBUFFER_BINDING } else { gl::FRAMEBUFFER_BINDING }),
                read_fb: if es3 { geti(gl::READ_FRAMEBUFFER_BINDING) } else { 0 },
                rb: geti(gl::RENDERBUFFER_BINDING),
                pack_buffer: if es3 { geti(gl::PIXEL_PACK_BUFFER_BINDING) } else { 0 },
                pack: if es3 {
                    [geti(gl::PACK_ALIGNMENT), geti(gl::PACK_ROW_LENGTH), geti(gl::PACK_SKIP_ROWS), geti(gl::PACK_SKIP_PIXELS)]
                } else {
                    [geti(gl::PACK_ALIGNMENT), 0, 0, 0]
                },
                scissor: gl::IsEnabled(gl::SCISSOR_TEST) != 0,
                discard: es3 && gl::IsEnabled(gl::RASTERIZER_DISCARD) != 0,
                color_mask,
                depth_mask,
                stencil_mask: [geti(gl::STENCIL_WRITEMASK), geti(gl::STENCIL_BACK_WRITEMASK)],
                clear_color,
                clear_depth,
                clear_stencil: geti(gl::STENCIL_CLEAR_VALUE),
            }
        }
    }
    fn restore(&self, version: u8) {
        unsafe {
            let es3 = version >= 2;
            if es3 {
                gl::BindFramebuffer(gl::DRAW_FRAMEBUFFER, self.draw_fb as GLuint);
                gl::BindFramebuffer(gl::READ_FRAMEBUFFER, self.read_fb as GLuint);
                gl::BindBuffer(gl::PIXEL_PACK_BUFFER, self.pack_buffer as GLuint);
                gl::PixelStorei(gl::PACK_ROW_LENGTH, self.pack[1]);
                gl::PixelStorei(gl::PACK_SKIP_ROWS, self.pack[2]);
                gl::PixelStorei(gl::PACK_SKIP_PIXELS, self.pack[3]);
                if self.discard {
                    gl::Enable(gl::RASTERIZER_DISCARD);
                }
            } else {
                gl::BindFramebuffer(gl::FRAMEBUFFER, self.draw_fb as GLuint);
            }
            gl::BindRenderbuffer(gl::RENDERBUFFER, self.rb as GLuint);
            gl::PixelStorei(gl::PACK_ALIGNMENT, self.pack[0]);
            if self.scissor {
                gl::Enable(gl::SCISSOR_TEST);
            }
            gl::ColorMask(self.color_mask[0], self.color_mask[1], self.color_mask[2], self.color_mask[3]);
            gl::DepthMask(self.depth_mask);
            gl::StencilMaskSeparate(gl::FRONT, self.stencil_mask[0] as GLuint);
            gl::StencilMaskSeparate(gl::BACK, self.stencil_mask[1] as GLuint);
            gl::ClearColor(self.clear_color[0], self.clear_color[1], self.clear_color[2], self.clear_color[3]);
            gl::ClearDepthf(self.clear_depth);
            gl::ClearStencil(self.clear_stencil);
        }
    }
    /// Neutral state for our own clears, blits and reads.
    fn neutral(version: u8) {
        unsafe {
            gl::Disable(gl::SCISSOR_TEST);
            if version >= 2 {
                gl::Disable(gl::RASTERIZER_DISCARD);
                gl::BindBuffer(gl::PIXEL_PACK_BUFFER, 0);
                gl::PixelStorei(gl::PACK_ROW_LENGTH, 0);
                gl::PixelStorei(gl::PACK_SKIP_ROWS, 0);
                gl::PixelStorei(gl::PACK_SKIP_PIXELS, 0);
            }
            gl::PixelStorei(gl::PACK_ALIGNMENT, 1);
            gl::ColorMask(1, 1, 1, 1);
            gl::DepthMask(1);
            gl::StencilMask(0xFFFF_FFFF);
        }
    }
}

impl GlCtx {
    pub fn new(egl: &Egl, version: u8, attrs: Attrs, w: i32, h: i32) -> Result<GlCtx, String> {
        let ctx = egl.create_context(version)?;
        if !egl.make_current(ctx) {
            egl.destroy_context(ctx);
            return Err("ANGLE could not make the WebGL context current".into());
        }
        let mut c = GlCtx {
            egl: ctx,
            version,
            attrs,
            w: 0,
            h: 0,
            samples: 0,
            fbo: 0,
            color: 0,
            depth: 0,
            resolve_fbo: 0,
            resolve_color: 0,
            dirty: false,
            drawn_this_frame: false,
            image_slot: None,
            image_fresh: false,
            syncs: vec![],
            pbo: 0,
            pbo_len: 0,
        };
        // WebGL 1 (an ES 2 context) gets no multisampling here: say so through getContextAttributes
        if attrs.antialias && version >= 2 {
            c.samples = geti(gl::MAX_SAMPLES).min(4);
        }
        c.attrs.antialias = c.samples > 0;
        if version < 2 {
            // RGB8/RGBA8 renderbuffers on ES 2
            unsafe { (egl.angle.request_extension)("GL_OES_rgb8_rgba8\0".as_ptr() as *const std::ffi::c_char) };
            unsafe { (egl.angle.request_extension)("GL_OES_packed_depth_stencil\0".as_ptr() as *const std::ffi::c_char) };
            unsafe { (egl.angle.request_extension)("GL_OES_depth24\0".as_ptr() as *const std::ffi::c_char) };
        }
        unsafe {
            gl::GenFramebuffers(1, &mut c.fbo);
        }
        c.resize(w, h);
        unsafe {
            gl::BindFramebuffer(gl::FRAMEBUFFER, c.fbo);
            gl::Viewport(0, 0, c.w, c.h);
            gl::Scissor(0, 0, c.w, c.h);
        }
        Ok(c)
    }

    /// (Re)allocate the drawing buffer at w×h, cleared. Bindings are kept.
    pub fn resize(&mut self, w: i32, h: i32) {
        let (w, h) = (w.max(1), h.max(1));
        let max = geti(gl::MAX_RENDERBUFFER_SIZE).max(1);
        let (w, h) = (w.min(max), h.min(max));
        if w == self.w && h == self.h && self.color != 0 {
            self.clear_buffer();
            return;
        }
        let saved = Saved::take(self.version);
        let es3 = self.version >= 2;
        unsafe {
            for rb in [self.color, self.depth, self.resolve_color] {
                if rb != 0 {
                    gl::DeleteRenderbuffers(1, &rb);
                }
            }
            self.color = 0;
            self.depth = 0;
            self.resolve_color = 0;
            let color_fmt = if self.attrs.alpha { gl::RGBA8 } else { gl::RGB8 };
            let ds_fmt = if self.attrs.stencil { Some(gl::DEPTH24_STENCIL8) } else if self.attrs.depth { Some(gl::DEPTH_COMPONENT24) } else { None };
            let storage = |rb: &mut GLuint, fmt: GLenum, samples: i32| {
                gl::GenRenderbuffers(1, rb);
                gl::BindRenderbuffer(gl::RENDERBUFFER, *rb);
                if samples > 0 {
                    gl::RenderbufferStorageMultisample(gl::RENDERBUFFER, samples, fmt, w, h);
                } else {
                    gl::RenderbufferStorage(gl::RENDERBUFFER, fmt, w, h);
                }
            };
            storage(&mut self.color, color_fmt, self.samples);
            if let Some(f) = ds_fmt {
                storage(&mut self.depth, f, self.samples);
            }
            let fb_target = if es3 { gl::DRAW_FRAMEBUFFER } else { gl::FRAMEBUFFER };
            gl::BindFramebuffer(fb_target, self.fbo);
            gl::FramebufferRenderbuffer(fb_target, gl::COLOR_ATTACHMENT0, gl::RENDERBUFFER, self.color);
            let (d, s) = match ds_fmt {
                Some(gl::DEPTH24_STENCIL8) => (self.depth, self.depth),
                Some(_) => (self.depth, 0),
                None => (0, 0),
            };
            gl::FramebufferRenderbuffer(fb_target, gl::DEPTH_ATTACHMENT, gl::RENDERBUFFER, d);
            gl::FramebufferRenderbuffer(fb_target, gl::STENCIL_ATTACHMENT, gl::RENDERBUFFER, s);
            if self.samples > 0 {
                if self.resolve_fbo == 0 {
                    gl::GenFramebuffers(1, &mut self.resolve_fbo);
                }
                storage(&mut self.resolve_color, color_fmt, 0);
                gl::BindFramebuffer(fb_target, self.resolve_fbo);
                gl::FramebufferRenderbuffer(fb_target, gl::COLOR_ATTACHMENT0, gl::RENDERBUFFER, self.resolve_color);
            }
        }
        self.w = w;
        self.h = h;
        saved.restore(self.version);
        self.clear_buffer();
    }

    /// Clear the drawing buffer to transparent black / depth 1 / stencil 0, page state untouched.
    pub fn clear_buffer(&mut self) {
        let saved = Saved::take(self.version);
        Saved::neutral(self.version);
        unsafe {
            gl::BindFramebuffer(gl::FRAMEBUFFER, self.fbo);
            gl::ClearColor(0.0, 0.0, 0.0, 0.0);
            gl::ClearDepthf(1.0);
            gl::ClearStencil(0);
            gl::Clear(gl::COLOR_BUFFER_BIT | gl::DEPTH_BUFFER_BIT | gl::STENCIL_BUFFER_BIT);
        }
        saved.restore(self.version);
        self.dirty = true;
        self.image_fresh = false;
    }

    /// For a page read of the default framebuffer (readPixels, copyTexImage): with MSAA, resolve
    /// into the single-sample buffer and bind it for reading. Returns what to rebind afterwards.
    pub fn begin_default_read(&mut self) -> Option<GLint> {
        if self.samples == 0 || self.version < 2 {
            return None;
        }
        let read = geti(gl::READ_FRAMEBUFFER_BINDING);
        if read as GLuint != self.fbo {
            return None;
        }
        self.resolve();
        unsafe { gl::BindFramebuffer(gl::READ_FRAMEBUFFER, self.resolve_fbo) };
        Some(read)
    }

    pub fn end_default_read(&self, prev: Option<GLint>) {
        if let Some(r) = prev {
            unsafe { gl::BindFramebuffer(gl::READ_FRAMEBUFFER, r as GLuint) };
        }
    }

    /// Blit the multisampled buffer into the resolve buffer (page state untouched).
    fn resolve(&mut self) {
        let saved = Saved::take(self.version);
        Saved::neutral(self.version);
        unsafe {
            gl::BindFramebuffer(gl::READ_FRAMEBUFFER, self.fbo);
            gl::BindFramebuffer(gl::DRAW_FRAMEBUFFER, self.resolve_fbo);
            gl::BlitFramebuffer(0, 0, self.w, self.h, 0, 0, self.w, self.h, gl::COLOR_BUFFER_BIT, gl::NEAREST);
        }
        saved.restore(self.version);
    }

    /// The drawing buffer as top-down RGBA (premultiplied when premultipliedAlpha is on).
    pub fn read_back(&mut self, egl: &Egl, out: &mut Vec<u8>) {
        out.resize((self.w * self.h * 4) as usize, 0);
        self.read_back_into(egl, out);
    }

    /// read_back into `out`, exactly w*h*4 bytes, every byte written.
    pub fn read_back_into(&mut self, egl: &Egl, out: &mut [u8]) {
        let (w, h) = (self.w, self.h);
        if self.samples > 0 && self.version >= 2 {
            self.resolve();
        }
        let saved = Saved::take(self.version);
        Saved::neutral(self.version);
        let n = (w * h * 4) as usize;
        let row = (w * 4) as usize;
        debug_assert_eq!(out.len(), n);
        // GL rows run bottom-up
        let flip = |src: &[u8], out: &mut [u8]| {
            for y in 0..h as usize {
                let s = (h as usize - 1 - y) * row;
                out[y * row..(y + 1) * row].copy_from_slice(&src[s..s + row]);
            }
        };
        unsafe {
            let src = if self.samples > 0 && self.version >= 2 { self.resolve_fbo } else { self.fbo };
            if self.version >= 2 {
                gl::BindFramebuffer(gl::READ_FRAMEBUFFER, src);
                // Through a pixel-pack buffer: the GPU copies the (losslessly compressed) colour
                // buffer out. A plain glReadPixels makes Metal decompress it on the CPU, which took
                // most of a three.js frame's CPU time (Apple M5 Pro, AGX processCompressedRegion2D).
                if self.pbo == 0 {
                    gl::GenBuffers(1, &mut self.pbo);
                }
                gl::BindBuffer(gl::PIXEL_PACK_BUFFER, self.pbo);
                if self.pbo_len != n {
                    gl::BufferData(gl::PIXEL_PACK_BUFFER, n as isize, std::ptr::null(), gl::STREAM_READ);
                    self.pbo_len = n;
                }
                gl::ReadPixels(0, 0, w, h, gl::RGBA, gl::UNSIGNED_BYTE, std::ptr::null_mut());
                let p = gl::MapBufferRange(gl::PIXEL_PACK_BUFFER, 0, n as isize, gl::MAP_READ_BIT) as *const u8;
                if p.is_null() {
                    out.fill(0);
                } else {
                    flip(std::slice::from_raw_parts(p, n), out);
                }
                gl::UnmapBuffer(gl::PIXEL_PACK_BUFFER);
            } else {
                gl::BindFramebuffer(gl::FRAMEBUFFER, src);
                let mut tmp = vec![0u8; n];
                let mut len = 0;
                (egl.angle.read_pixels_robust)(0, 0, w, h, gl::RGBA, gl::UNSIGNED_BYTE, n as GLsizei, &mut len, std::ptr::null_mut(), std::ptr::null_mut(), tmp.as_mut_ptr() as *mut c_void);
                flip(&tmp, out);
            }
        }
        saved.restore(self.version);
        if !self.attrs.alpha {
            for p in out.chunks_exact_mut(4) {
                p[3] = 255;
            }
        }
        self.dirty = false;
    }

    pub fn destroy(&mut self, egl: &Egl) {
        if egl.make_current(self.egl) {
            unsafe {
                for rb in [self.color, self.depth, self.resolve_color] {
                    if rb != 0 {
                        gl::DeleteRenderbuffers(1, &rb);
                    }
                }
                for fb in [self.fbo, self.resolve_fbo] {
                    if fb != 0 {
                        gl::DeleteFramebuffers(1, &fb);
                    }
                }
                if self.pbo != 0 {
                    gl::DeleteBuffers(1, &self.pbo);
                }
                for s in self.syncs.drain(..).flatten() {
                    gl::DeleteSync(s);
                }
            }
        }
        egl.make_current(std::ptr::null_mut());
        egl.destroy_context(self.egl);
    }
}
