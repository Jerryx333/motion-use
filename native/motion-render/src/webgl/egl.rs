//! ANGLE through EGL: find and load the libraries, open one display per process (Metal on macOS,
//! Vulkan on Linux, or SwiftShader on the CPU), and create WebGL-compatibility contexts — the
//! same kind of context Chrome's GPU process makes for a WebGL canvas.
use super::gl;
use libloading::Library;
use std::ffi::{c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::cell::Cell;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;

type P = *mut c_void;
const EGL_NONE: i32 = 0x3038;
const EGL_TRUE: i32 = 1;
const EGL_FALSE: i32 = 0;

#[cfg(target_os = "macos")]
const LIBS: (&str, &str) = ("libGLESv2.dylib", "libEGL.dylib");
#[cfg(target_os = "linux")]
const LIBS: (&str, &str) = ("libGLESv2.so", "libEGL.so");
#[cfg(target_os = "windows")]
const LIBS: (&str, &str) = ("libGLESv2.dll", "libEGL.dll");

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Backend {
    Metal,
    Vulkan,
    SwiftShader,
    D3D11,
}

impl Backend {
    pub fn name(self) -> &'static str {
        match self {
            Backend::Metal => "metal",
            Backend::Vulkan => "vulkan",
            Backend::SwiftShader => "swiftshader",
            Backend::D3D11 => "d3d11",
        }
    }
    /// The backends to try, in order. MOTION_RENDER_GL=metal|vulkan|swiftshader|d3d11 asks for one;
    /// unset or auto: the platform's GPU API, then SwiftShader (a machine with no usable GPU, such
    /// as a CI runner, still renders WebGL, on the CPU).
    fn candidates() -> Result<Vec<Backend>, String> {
        let default = if cfg!(target_os = "macos") {
            Backend::Metal
        } else if cfg!(target_os = "windows") {
            Backend::D3D11
        } else {
            Backend::Vulkan
        };
        let v = std::env::var("MOTION_RENDER_GL").unwrap_or_default().trim().to_ascii_lowercase();
        match v.as_str() {
            "" | "auto" => Ok(vec![default, Backend::SwiftShader]),
            "gpu" => Ok(vec![default]),
            "metal" => Ok(vec![Backend::Metal]),
            "vulkan" => Ok(vec![Backend::Vulkan]),
            "swiftshader" | "cpu" | "software" => Ok(vec![Backend::SwiftShader]),
            "d3d11" => Ok(vec![Backend::D3D11]),
            "off" | "none" => Err("WebGL is turned off (MOTION_RENDER_GL=off)".into()),
            other => Err(format!("MOTION_RENDER_GL={} is not one of auto, gpu, metal, vulkan, swiftshader, d3d11, off", other)),
        }
    }
}


pub struct Egl {
    _gles: Library,
    _egl: Library,
    platform: Vec<i32>,
    pub backend: Backend,
    pub dir: PathBuf,
    pub angle: gl::Angle,
    get_proc: unsafe extern "C" fn(*const std::ffi::c_char) -> P,
    create_context: unsafe extern "C" fn(P, P, P, *const i32) -> P,
    destroy_context: unsafe extern "C" fn(P, P) -> u32,
    make_current: unsafe extern "C" fn(P, P, P, P) -> u32,
    get_error: unsafe extern "C" fn() -> i32,
    get_display: unsafe extern "C" fn(u32, P, *const i32) -> P,
    initialize: unsafe extern "C" fn(P, *mut i32, *mut i32) -> u32,
}

// One EGL display per worker thread. Contexts on one ANGLE display share backend state (on Metal,
// internal resources and command-queue synchronisation): two threads rendering through one
// display gave run-to-run pixel differences, and serialising them deadlocked on a cross-context
// wait. ANGLE keys displays by their native display handle, which the Metal and surfaceless
// Vulkan platforms do not dereference, so each thread passes its own token.
static NEXT_DISPLAY: AtomicUsize = AtomicUsize::new(1);
thread_local! {
    static DPY: Cell<P> = const { Cell::new(std::ptr::null_mut()) };
}

/// Where the ANGLE libraries are: MOTION_RENDER_ANGLE_DIR, next to the binary (or ../lib), then
/// native/scripts/fetch-angle.sh's cache (~/.cache/motion-render/angle/<version>/).
pub fn find_dir() -> Option<PathBuf> {
    let has = |d: &Path| d.join(LIBS.0).is_file() && d.join(LIBS.1).is_file();
    if let Ok(d) = std::env::var("MOTION_RENDER_ANGLE_DIR") {
        let d = PathBuf::from(d);
        return has(&d).then_some(d);
    }
    if let Ok(exe) = std::env::current_exe() {
        let exe = exe.canonicalize().unwrap_or(exe);
        if let Some(dir) = exe.parent() {
            for d in [dir.to_path_buf(), dir.join("angle"), dir.join("../lib/motion-render")] {
                if has(&d) {
                    return Some(d);
                }
            }
        }
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    let cache = PathBuf::from(home).join(".cache/motion-render/angle");
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(&cache).ok()?.filter_map(|e| e.ok().map(|e| e.path())).filter(|d| has(d)).collect();
    // newest version last (v43.7.9-darwin-arm64 …): compare numerically
    let key = |p: &PathBuf| -> Vec<u64> {
        let n = p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        n.trim_start_matches('v').split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty()).map(|s| s.parse().unwrap_or(0)).collect()
    };
    dirs.sort_by_key(key);
    dirs.pop()
}

static EGL: OnceLock<Result<Egl, String>> = OnceLock::new();

pub fn egl() -> Result<&'static Egl, String> {
    EGL.get_or_init(open).as_ref().map_err(|e| e.clone())
}

fn open() -> Result<Egl, String> {
    let candidates = Backend::candidates()?;
    let dir = find_dir().ok_or_else(|| {
        "WebGL needs ANGLE (libEGL + libGLESv2), which was not found: run native/scripts/fetch-angle.sh, or set MOTION_RENDER_ANGLE_DIR to a folder holding them".to_string()
    })?;
    unsafe {
        // libGLESv2 first: libEGL looks for it beside itself, and it carries the GL entry points
        let gles = Library::new(dir.join(LIBS.0)).map_err(|e| format!("loading {}: {}", dir.join(LIBS.0).display(), e))?;
        let egl = Library::new(dir.join(LIBS.1)).map_err(|e| format!("loading {}: {}", dir.join(LIBS.1).display(), e))?;
        let get_proc: unsafe extern "C" fn(*const std::ffi::c_char) -> P = *egl.get(b"eglGetProcAddress\0").map_err(|e| e.to_string())?;
        let sym = |name: &str| -> P {
            let c = CString::new(name).unwrap();
            let p = get_proc(c.as_ptr());
            if !p.is_null() {
                return p;
            }
            let s: Result<libloading::Symbol<P>, _> = gles.get(c.as_bytes_with_nul());
            s.map(|s| *s).unwrap_or(std::ptr::null_mut())
        };
        macro_rules! egl_fn {
            ($n:literal) => {{
                let p = sym($n);
                if p.is_null() {
                    return Err(format!("ANGLE's EGL lacks {}", $n));
                }
                std::mem::transmute(p)
            }};
        }
        let get_display: unsafe extern "C" fn(u32, P, *const i32) -> P = egl_fn!("eglGetPlatformDisplayEXT");
        let initialize: unsafe extern "C" fn(P, *mut i32, *mut i32) -> u32 = egl_fn!("eglInitialize");
        let query_string: unsafe extern "C" fn(P, i32) -> *const std::ffi::c_char = egl_fn!("eglQueryString");
        let get_error: unsafe extern "C" fn() -> i32 = egl_fn!("eglGetError");
        // the first backend whose display opens and can make a WebGL context
        let mut tried = vec![];
        let mut chosen = None;
        let last = candidates.len() - 1;
        for (k, backend) in candidates.into_iter().enumerate() {
            let mut platform: Vec<i32> = match backend {
                // EGL_PLATFORM_ANGLE_TYPE_ANGLE = …
                Backend::Metal => vec![0x3203, 0x3489],
                Backend::Vulkan => vec![0x3203, 0x3450],
                Backend::D3D11 => vec![0x3203, 0x3208],
                // Vulkan on the SwiftShader device: Chrome's software WebGL
                Backend::SwiftShader => vec![0x3203, 0x3450, 0x3209, 0x3487],
            };
            if cfg!(target_os = "linux") {
                // EGL_PLATFORM_ANGLE_NATIVE_PLATFORM_TYPE_ANGLE = EGL_PLATFORM_SURFACELESS_MESA: no X11/Wayland
                platform.extend([0x348F, 0x31DD]);
            }
            platform.push(EGL_NONE);
            match open_display(get_display, initialize, &platform, 0).map(|p| (p, probe_context(&sym, p))) {
                // A virtual machine's Metal device (AppleParavirtDevice: CI runners, Tart, UTM)
                // lacks what ANGLE's Metal backend calls and aborts the process mid-frame; take
                // the next backend (SwiftShader) when there is one.
                Ok((_, Some(r))) if backend == Backend::Metal && r.contains("Paravirtual") && k < last => {
                    tried.push(format!("metal: {} (a virtual machine's GPU, skipped)", r));
                }
                Ok((p, Some(_))) => {
                    chosen = Some((backend, platform, p));
                    break;
                }
                Ok((_, None)) => tried.push(format!("{}: no WebGL context", backend.name())),
                Err(e) => tried.push(format!("{}: {} (EGL error 0x{:x})", backend.name(), e, get_error())),
            }
        }
        let Some((backend, platform, probe)) = chosen else {
            return Err(format!("ANGLE could not open a display ({})", tried.join("; ")));
        };
        let exts = CStr::from_ptr(query_string(probe, 0x3055)).to_string_lossy().into_owned();
        for need in ["EGL_ANGLE_create_context_webgl_compatibility", "EGL_KHR_surfaceless_context", "EGL_ANGLE_robust_resource_initialization", "EGL_KHR_no_config_context"] {
            if !exts.split(' ').any(|e| e == need) {
                return Err(format!("ANGLE display lacks {}", need));
            }
        }
        let loader = |name: &str| -> *const c_void { sym(name) as *const c_void };
        gl::load_with(|name| loader(name));
        let angle = gl::Angle::load(&loader)?;
        Ok(Egl {
            create_context: egl_fn!("eglCreateContext"),
            destroy_context: egl_fn!("eglDestroyContext"),
            make_current: egl_fn!("eglMakeCurrent"),
            get_error,
            get_proc,
            angle,
            platform,
            get_display,
            initialize,
            backend,
            dir,
            _gles: gles,
            _egl: egl,
        })
    }
}

/// Make (and drop) a WebGL 2 context on this display; its GL_RENDERER, or None when that fails
/// (some backends initialise and then cannot make a context).
unsafe fn probe_context(sym: &dyn Fn(&str) -> P, dpy: P) -> Option<String> {
    let (create, destroy, current, get_string) = (sym("eglCreateContext"), sym("eglDestroyContext"), sym("eglMakeCurrent"), sym("glGetString"));
    if create.is_null() || destroy.is_null() || current.is_null() || get_string.is_null() {
        return None;
    }
    let create: unsafe extern "C" fn(P, P, P, *const i32) -> P = std::mem::transmute(create);
    let destroy: unsafe extern "C" fn(P, P) -> u32 = std::mem::transmute(destroy);
    let current: unsafe extern "C" fn(P, P, P, P) -> u32 = std::mem::transmute(current);
    let get_string: unsafe extern "system" fn(u32) -> *const std::ffi::c_char = std::mem::transmute(get_string);
    let attrs = [0x3098, 3, 0x30FB, 0, 0x33AC, EGL_TRUE, 0x3483, EGL_FALSE, EGL_NONE];
    let ctx = create(dpy, std::ptr::null_mut(), std::ptr::null_mut(), attrs.as_ptr());
    if ctx.is_null() {
        return None;
    }
    let mut renderer = String::new();
    if current(dpy, std::ptr::null_mut(), std::ptr::null_mut(), ctx) != 0 {
        let r = get_string(0x1F01);
        if !r.is_null() {
            renderer = CStr::from_ptr(r).to_string_lossy().into_owned();
        }
        current(dpy, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut());
    }
    destroy(dpy, ctx);
    Some(renderer)
}

fn open_display(get_display: unsafe extern "C" fn(u32, P, *const i32) -> P, initialize: unsafe extern "C" fn(P, *mut i32, *mut i32) -> u32, platform: &[i32], token: usize) -> Result<P, String> {
    let (mut major, mut minor) = (0, 0);
    unsafe {
        // EGL_PLATFORM_ANGLE_ANGLE
        let dpy = get_display(0x3202, token as P, platform.as_ptr());
        if dpy.is_null() || initialize(dpy, &mut major, &mut minor) == 0 {
            return Err("eglInitialize failed".into());
        }
        Ok(dpy)
    }
}

impl Egl {
    /// This thread's display, opened on first use.
    fn dpy(&self) -> P {
        DPY.with(|d| {
            if d.get().is_null() {
                let token = NEXT_DISPLAY.fetch_add(1, Ordering::Relaxed);
                if let Ok(p) = open_display(self.get_display, self.initialize, &self.platform, token) {
                    d.set(p);
                }
            }
            d.get()
        })
    }

    /// A WebGL-compatibility context (ES 3.0 for webgl2, ES 2.0 for webgl) with robust resource
    /// initialisation, no client arrays and no bind-generates-resource — Chrome's settings.
    pub fn create_context(&self, version: u8) -> Result<P, String> {
        let attrs = [
            0x3098, if version >= 2 { 3 } else { 2 }, // EGL_CONTEXT_MAJOR_VERSION
            0x30FB, 0, // EGL_CONTEXT_MINOR_VERSION
            0x33AC, EGL_TRUE, // EGL_CONTEXT_WEBGL_COMPATIBILITY_ANGLE
            0x3453, EGL_TRUE, // EGL_ROBUST_RESOURCE_INITIALIZATION_ANGLE
            0x33AD, EGL_FALSE, // EGL_CONTEXT_BIND_GENERATES_RESOURCE_CHROMIUM
            0x3452, EGL_FALSE, // EGL_CONTEXT_CLIENT_ARRAYS_ENABLED_ANGLE
            0x3483, EGL_FALSE, // EGL_CONTEXT_OPENGL_BACKWARDS_COMPATIBLE_ANGLE: exactly the version asked
            EGL_NONE,
        ];
        // EGL_KHR_no_config_context: no config, no surface
        let ctx = unsafe { (self.create_context)(self.dpy(), std::ptr::null_mut(), std::ptr::null_mut(), attrs.as_ptr()) };
        if ctx.is_null() {
            return Err(format!("ANGLE could not create a WebGL {} context (EGL error 0x{:x})", version, unsafe { (self.get_error)() }));
        }
        Ok(ctx)
    }

    pub fn make_current(&self, ctx: P) -> bool {
        unsafe { (self.make_current)(self.dpy(), std::ptr::null_mut(), std::ptr::null_mut(), ctx) != 0 }
    }

    pub fn destroy_context(&self, ctx: P) {
        unsafe {
            (self.destroy_context)(self.dpy(), ctx);
        }
    }

    #[allow(dead_code)]
    pub fn proc_address(&self, name: &str) -> P {
        let c = CString::new(name).unwrap();
        unsafe { (self.get_proc)(c.as_ptr()) }
    }
}
