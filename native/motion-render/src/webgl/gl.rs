//! OpenGL ES 3.0 entry points (generated) plus the ANGLE extensions WebGL needs: robust client
//! memory (bounds-checked uploads and reads, what Chrome's passthrough decoder uses) and
//! extension requests (a WebGL-compatibility context starts with every extension disabled).
#![allow(clippy::all, non_upper_case_globals, non_snake_case, dead_code, unused_imports)]

include!(concat!(env!("OUT_DIR"), "/gles_bindings.rs"));

use std::ffi::c_void;
use types::*;

pub const REQUESTABLE_EXTENSIONS_ANGLE: GLenum = 0x93A8;
pub const UNPACK_FLIP_Y_WEBGL: GLenum = 0x9240;

pub struct Angle {
    pub request_extension: unsafe extern "system" fn(*const std::ffi::c_char),
    pub read_pixels_robust: unsafe extern "system" fn(GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, GLsizei, *mut GLsizei, *mut GLsizei, *mut GLsizei, *mut c_void),
    pub tex_image_2d_robust: unsafe extern "system" fn(GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, GLsizei, *const c_void),
    pub tex_sub_image_2d_robust: unsafe extern "system" fn(GLenum, GLint, GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, GLsizei, *const c_void),
    pub tex_image_3d_robust: unsafe extern "system" fn(GLenum, GLint, GLint, GLsizei, GLsizei, GLsizei, GLint, GLenum, GLenum, GLsizei, *const c_void),
    pub tex_sub_image_3d_robust: unsafe extern "system" fn(GLenum, GLint, GLint, GLint, GLint, GLsizei, GLsizei, GLsizei, GLenum, GLenum, GLsizei, *const c_void),
}

impl Angle {
    /// # Safety
    /// `load` must return entry points of the ANGLE build the GL context belongs to.
    pub unsafe fn load(load: &dyn Fn(&str) -> *const c_void) -> Result<Angle, String> {
        macro_rules! f {
            ($n:literal) => {{
                let p = load($n);
                if p.is_null() {
                    return Err(format!("ANGLE lacks {}", $n));
                }
                std::mem::transmute(p)
            }};
        }
        Ok(Angle {
            request_extension: f!("glRequestExtensionANGLE"),
            read_pixels_robust: f!("glReadPixelsRobustANGLE"),
            tex_image_2d_robust: f!("glTexImage2DRobustANGLE"),
            tex_sub_image_2d_robust: f!("glTexSubImage2DRobustANGLE"),
            tex_image_3d_robust: f!("glTexImage3DRobustANGLE"),
            tex_sub_image_3d_robust: f!("glTexSubImage3DRobustANGLE"),
        })
    }
}
