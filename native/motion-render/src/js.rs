//! One V8 isolate per worker thread with the browser shim, and the native functions the shim
//! calls (`__native.*`). Each thread owns its own Skia runtime in a thread-local.
use crate::canvas::{GradKind, Gradient, ImageSrc, Runtime};
use crate::page::{FontSource, Page};
use crate::style;
use crate::text;
use anyhow::{anyhow, Result};
use skia_safe::{self as sk, Matrix};
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Once;

thread_local! {
    static RT: RefCell<Option<Runtime>> = const { RefCell::new(None) };
}

fn with_rt<R>(f: impl FnOnce(&mut Runtime) -> R) -> R {
    RT.with(|r| f(r.borrow_mut().as_mut().expect("runtime not initialised")))
}

static INIT: Once = Once::new();
static mut PLATFORM: Option<v8::SharedRef<v8::Platform>> = None;

/// Initialise V8 once per process. Math.random gets a fixed seed so a page that uses it still
/// renders the same frames on every run.
pub fn init_v8() {
    INIT.call_once(|| {
        v8::V8::set_flags_from_string("--random-seed=20260101 --hash-seed=20260101 --no-freeze-flags-after-init");
        let platform = v8::new_default_platform(0, false).make_shared();
        v8::V8::initialize_platform(platform.clone());
        v8::V8::initialize();
        unsafe {
            PLATFORM = Some(platform);
        }
    });
}

#[allow(static_mut_refs)]
fn platform() -> &'static v8::SharedRef<v8::Platform> {
    unsafe { PLATFORM.as_ref().unwrap() }
}

// ---------------------------------------------------------------- argument helpers
type Args<'a> = v8::FunctionCallbackArguments<'a>;

#[inline]
fn num(s: &mut v8::PinScope, a: &Args, i: i32) -> f64 {
    let v = a.get(i);
    if v.is_number() {
        return v.number_value(s).unwrap_or(f64::NAN);
    }
    v.number_value(s).unwrap_or(f64::NAN)
}
#[inline]
fn f(s: &mut v8::PinScope, a: &Args, i: i32) -> f32 {
    num(s, a, i) as f32
}
#[inline]
fn idx(s: &mut v8::PinScope, a: &Args, i: i32) -> usize {
    num(s, a, i) as usize
}
fn string(s: &mut v8::PinScope, a: &Args, i: i32) -> String {
    let v = a.get(i);
    match v.to_string(s) {
        Some(st) => st.to_rust_string_lossy(s),
        None => String::new(),
    }
}
fn boolean(s: &mut v8::PinScope, a: &Args, i: i32) -> bool {
    a.get(i).boolean_value(s)
}

fn resolve(base: &Path, url: &str) -> PathBuf {
    let u = url.strip_prefix("file://").unwrap_or(url);
    let u = u.split(['?', '#']).next().unwrap_or(u);
    let decoded = percent_decode(u);
    let p = Path::new(&decoded);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        base.join(p)
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' | b'\n' | b'\r' | b' ' => continue,
            _ => return None,
        } as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// Bytes of a URL the page names: a local file (relative to the page) or a data: URL.
fn read_url(base: &Path, url: &str) -> Option<Vec<u8>> {
    if let Some(rest) = url.strip_prefix("data:") {
        let (meta, data) = rest.split_once(',')?;
        return if meta.ends_with(";base64") { b64_decode(data) } else { Some(percent_decode(data).into_bytes()) };
    }
    std::fs::read(resolve(base, url)).ok()
}

/// The (primaries, transfer) of a PNG's cICP chunk, if it has one before its image data.
fn png_cicp(b: &[u8]) -> Option<(u8, u8)> {
    if b.len() < 8 || &b[..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let mut i = 8;
    while i + 8 <= b.len() {
        let n = u32::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) as usize;
        let t = &b[i + 4..i + 8];
        if t == b"cICP" && n >= 2 && i + 10 <= b.len() {
            return Some((b[i + 8], b[i + 9]));
        }
        if t == b"IDAT" {
            return None;
        }
        i += 12 + n;
    }
    None
}

fn cicp_space(primaries: u8, transfer: u8) -> Option<sk::ColorSpace> {
    use sk::named_primaries::CicpId as P;
    use sk::named_transfer_fn::CicpId as T;
    let p = match primaries {
        1 => P::Rec709,
        9 => P::Rec2020,
        11 => P::SMPTE_RP_431_2,
        12 => P::SMPTE_EG_432_1,
        _ => return None,
    };
    let t = match transfer {
        1 => T::Rec709,
        6 => T::Rec601,
        8 => T::Linear,
        13 => T::IEC61966_2_1,
        14 => T::Rec2020_10bit,
        15 => T::Rec2020_12bit,
        _ => return None,
    };
    sk::ColorSpace::new_cicp(p, t)
}

fn decode_image(bytes: &[u8], name: &str) -> Option<ImageSrc> {
    let head = &bytes[..bytes.len().min(512)];
    let looks_svg = name.to_ascii_lowercase().ends_with(".svg") || String::from_utf8_lossy(head).contains("<svg");
    if looks_svg {
        let dom = sk::svg::Dom::from_bytes(bytes, sk::FontMgr::new()).ok()?;
        let mut dom = dom;
        let root = dom.root();
        let size = root.intrinsic_size();
        let (mut w, mut h) = (size.width, size.height);
        if !(w > 0.0 && h > 0.0) {
            if let Some(vb) = root.view_box() {
                w = vb.width();
                h = vb.height();
            } else {
                w = 300.0;
                h = 150.0;
            }
        }
        dom.set_container_size((w, h));
        let mut rec = sk::PictureRecorder::new();
        let canvas = rec.begin_recording(sk::Rect::from_wh(w, h), false);
        dom.render(canvas);
        let pic = rec.finish_recording_as_picture(None)?;
        return Some(ImageSrc::Picture(pic, w, h));
    }
    let data = sk::Data::new_copy(bytes);
    let img = sk::Image::from_encoded(data)?;
    // Decode now: a lazy image would decode on every draw from a different thread state.
    let img = img.make_raster_image(None, sk::image::CachingHint::Allow).unwrap_or(img);
    // Like Chrome, convert tagged images (ICC, cICP: Display P3 screenshots…) to sRGB at decode;
    // the canvas itself is untagged sRGB, so Skia would otherwise draw the raw values.
    // A PNG cICP chunk (e.g. BT.709 primaries with the BT.709 transfer curve, what some screen
    // recorders write) wins over gAMA/cHRM in Chrome; Skia's codec may not read it.
    let img = match png_cicp(bytes).and_then(|(p, t)| cicp_space(p, t)) {
        Some(cs) => img.reinterpret_color_space(cs).unwrap_or(img),
        None => img,
    };
    let img = match img.color_space() {
        Some(cs) if !cs.is_srgb() => img.make_color_space(None, sk::ColorSpace::new_srgb(), sk::image::RequiredProperties::default()).unwrap_or(img),
        _ => img,
    };
    Some(ImageSrc::Raster(img))
}

macro_rules! native {
    ($scope:ident, $obj:ident, $( $name:literal => |$s:ident, $a:ident, $rv:ident| $body:block ),* $(,)?) => {
        $(
            {
                #[allow(unused_variables, unused_mut)]
                fn cb($s: &mut v8::PinScope, $a: v8::FunctionCallbackArguments, mut $rv: v8::ReturnValue) {
                    #[allow(unused_variables)]
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

fn ret_str(s: &mut v8::PinScope, rv: &mut v8::ReturnValue, v: &str) {
    let st = v8::String::new(s, v).unwrap();
    rv.set(st.into());
}

fn install_natives(scope: &mut v8::PinScope, global: v8::Local<v8::Object>) {
    let obj = v8::Object::new(scope);
    native!(scope, obj,
        "log" => |s, a, rv| {
            let level = num(s, &a, 0) as i32;
            let msg = string(s, &a, 1);
            if level >= 1 || std::env::var("MOTION_RENDER_DEBUG").is_ok() {
                eprintln!("motion-render: page {}: {}", ["debug", "log", "warn", "error"][level.clamp(0, 3) as usize], msg);
            }
        },
        "now" => |s, a, rv| {
            // performance.now(): real time since start (pages should not depend on it)
            thread_local! { static T0: std::time::Instant = std::time::Instant::now(); }
            rv.set_double(T0.with(|t| t.elapsed().as_secs_f64() * 1000.0));
        },
        "readFile" => |s, a, rv| {
            let url = string(s, &a, 0);
            let base = with_rt(|r| r.base.clone());
            match read_url(&base, &url) {
                Some(bytes) => {
                    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes).make_shared();
                    let ab = v8::ArrayBuffer::with_backing_store(s, &store);
                    rv.set(ab.into());
                }
                None => rv.set_null(),
            }
        },
        "utf8Decode" => |s, a, rv| {
            let v = a.get(0);
            if let Ok(ab) = v8::Local::<v8::ArrayBuffer>::try_from(v) {
                let len = ab.byte_length();
                let bytes = match ab.data() { Some(p) => unsafe { std::slice::from_raw_parts(p.as_ptr() as *const u8, len) }.to_vec(), None => vec![] };
                let st = String::from_utf8_lossy(&bytes).into_owned();
                ret_str(s, &mut rv, &st);
            }
        },
        "utf8Encode" => |s, a, rv| {
            let st = string(s, &a, 0);
            let store = v8::ArrayBuffer::new_backing_store_from_vec(st.into_bytes()).make_shared();
            let ab = v8::ArrayBuffer::with_backing_store(s, &store);
            rv.set(ab.into());
        },
        // ---------------------------------------------------------------- canvases
        "canvasNew" => |s, a, rv| {
            let (w, h) = (num(s, &a, 0) as i32, num(s, &a, 1) as i32);
            rv.set_int32(with_rt(|r| r.canvas_new(w, h)) as i32);
        },
        "canvasResize" => |s, a, rv| {
            let (id, w, h) = (idx(s, &a, 0), num(s, &a, 1) as i32, num(s, &a, 2) as i32);
            with_rt(|r| r.canvas_resize(id, w, h));
        },
        "resetCtx" => |s, a, rv| { let id = idx(s, &a, 0); with_rt(|r| r.reset_ctx(id)); },
        "ctxPath" => |s, a, rv| { let id = idx(s, &a, 0); rv.set_int32(with_rt(|r| r.canvases[id].path) as i32); },
        "save" => |s, a, rv| { let id = idx(s, &a, 0); with_rt(|r| r.save(id)); },
        "restore" => |s, a, rv| { let id = idx(s, &a, 0); with_rt(|r| r.restore(id)); },
        "transform" => |s, a, rv| {
            let id = idx(s, &a, 0);
            let m = [f(s, &a, 1), f(s, &a, 2), f(s, &a, 3), f(s, &a, 4), f(s, &a, 5), f(s, &a, 6)];
            if m.iter().all(|v| v.is_finite()) {
                with_rt(|r| r.transform(id, Matrix::new_all(m[0], m[2], m[4], m[1], m[3], m[5], 0.0, 0.0, 1.0)));
            }
        },
        "setTransform" => |s, a, rv| {
            let id = idx(s, &a, 0);
            let m = [f(s, &a, 1), f(s, &a, 2), f(s, &a, 3), f(s, &a, 4), f(s, &a, 5), f(s, &a, 6)];
            if m.iter().all(|v| v.is_finite()) {
                with_rt(|r| r.set_matrix(id, Matrix::new_all(m[0], m[2], m[4], m[1], m[3], m[5], 0.0, 0.0, 1.0)));
            }
        },
        "getTransform" => |s, a, rv| {
            let id = idx(s, &a, 0);
            let m = with_rt(|r| r.canvases[id].state.matrix);
            let vals = [m.scale_x(), m.skew_y(), m.skew_x(), m.scale_y(), m.translate_x(), m.translate_y()];
            let elems: Vec<v8::Local<v8::Value>> = vals.iter().map(|v| v8::Number::new(s, *v as f64).into()).collect();
            let arr = v8::Array::new_with_elements(s, &elems);
            rv.set(arr.into());
        },
        // ---------------------------------------------------------------- paths
        "pathNew" => |s, a, rv| { rv.set_int32(with_rt(|r| r.path_new()) as i32); },
        "beginPath" => |s, a, rv| { let p = idx(s, &a, 0); with_rt(|r| r.paths[p] = sk::PathBuilder::new()); },
        "closePath" => |s, a, rv| { let p = idx(s, &a, 0); with_rt(|r| r.close_path(p)); },
        "moveTo" => |s, a, rv| { let (p, x, y) = (idx(s, &a, 0), f(s, &a, 1), f(s, &a, 2)); with_rt(|r| r.move_to(p, x, y)); },
        "lineTo" => |s, a, rv| { let (p, x, y) = (idx(s, &a, 0), f(s, &a, 1), f(s, &a, 2)); with_rt(|r| r.line_to(p, x, y)); },
        "quadTo" => |s, a, rv| {
            let (p, cx, cy, x, y) = (idx(s, &a, 0), f(s, &a, 1), f(s, &a, 2), f(s, &a, 3), f(s, &a, 4));
            with_rt(|r| r.quad_to(p, cx, cy, x, y));
        },
        "bezierTo" => |s, a, rv| {
            let p = idx(s, &a, 0);
            let v = [f(s, &a, 1), f(s, &a, 2), f(s, &a, 3), f(s, &a, 4), f(s, &a, 5), f(s, &a, 6)];
            with_rt(|r| r.bezier_to(p, v));
        },
        "arc" => |s, a, rv| {
            let p = idx(s, &a, 0);
            let (x, y, rr, a0, a1, ccw) = (num(s, &a, 1), num(s, &a, 2), num(s, &a, 3), num(s, &a, 4), num(s, &a, 5), boolean(s, &a, 6));
            with_rt(|r| r.ellipse(p, x, y, rr, rr, 0.0, a0, a1, ccw));
        },
        "ellipse" => |s, a, rv| {
            let p = idx(s, &a, 0);
            let v: Vec<f64> = (1..8).map(|i| num(s, &a, i)).collect();
            let ccw = boolean(s, &a, 8);
            with_rt(|r| r.ellipse(p, v[0], v[1], v[2], v[3], v[4], v[5], v[6], ccw));
        },
        "arcTo" => |s, a, rv| {
            let p = idx(s, &a, 0);
            let v = [f(s, &a, 1), f(s, &a, 2), f(s, &a, 3), f(s, &a, 4), f(s, &a, 5)];
            with_rt(|r| r.arc_to(p, v[0], v[1], v[2], v[3], v[4]));
        },
        "rect" => |s, a, rv| {
            let p = idx(s, &a, 0);
            let v = [f(s, &a, 1), f(s, &a, 2), f(s, &a, 3), f(s, &a, 4)];
            with_rt(|r| r.rect(p, v[0], v[1], v[2], v[3]));
        },
        "roundRect" => |s, a, rv| {
            let p = idx(s, &a, 0);
            let v = [f(s, &a, 1), f(s, &a, 2), f(s, &a, 3), f(s, &a, 4)];
            let mut rr = [0f32; 8];
            for (k, x) in rr.iter_mut().enumerate() { *x = f(s, &a, 5 + k as i32); }
            with_rt(|r| r.round_rect(p, v[0], v[1], v[2], v[3], rr));
        },
        "pathAdd" => |s, a, rv| {
            let (dst, src) = (idx(s, &a, 0), idx(s, &a, 1));
            let m = [f(s, &a, 2), f(s, &a, 3), f(s, &a, 4), f(s, &a, 5), f(s, &a, 6), f(s, &a, 7)];
            with_rt(|r| {
                let path = r.paths[src].snapshot();
                let mx = Matrix::new_all(m[0], m[2], m[4], m[1], m[3], m[5], 0.0, 0.0, 1.0);
                r.paths[dst].add_path_with_transform(&path, &mx, sk::path::AddPathMode::Append);
            });
        },
        "pathSvg" => |s, a, rv| {
            let p = idx(s, &a, 0);
            let d = string(s, &a, 1);
            if let Some(path) = sk::Path::from_svg(&d) {
                with_rt(|r| { r.paths[p].add_path(&path, sk::path::AddPathMode::Append); });
            }
        },
        // ---------------------------------------------------------------- drawing
        "fill" => |s, a, rv| { let (id, p, eo) = (idx(s, &a, 0), idx(s, &a, 1), num(s, &a, 2) == 1.0); with_rt(|r| r.fill(id, p, eo)); },
        "stroke" => |s, a, rv| { let (id, p) = (idx(s, &a, 0), idx(s, &a, 1)); with_rt(|r| r.stroke(id, p)); },
        "clip" => |s, a, rv| { let (id, p, eo) = (idx(s, &a, 0), idx(s, &a, 1), num(s, &a, 2) == 1.0); with_rt(|r| r.clip(id, p, eo)); },
        "isPointInPath" => |s, a, rv| {
            let (id, p, x, y, eo) = (idx(s, &a, 0), idx(s, &a, 1), f(s, &a, 2), f(s, &a, 3), num(s, &a, 4) == 1.0);
            rv.set_bool(with_rt(|r| r.is_point_in_path(id, p, x, y, eo)));
        },
        "isPointInStroke" => |s, a, rv| {
            let (id, p, x, y) = (idx(s, &a, 0), idx(s, &a, 1), f(s, &a, 2), f(s, &a, 3));
            rv.set_bool(with_rt(|r| r.is_point_in_stroke(id, p, x, y)));
        },
        "fillRect" => |s, a, rv| { let (id, x, y, w, h) = (idx(s, &a, 0), f(s, &a, 1), f(s, &a, 2), f(s, &a, 3), f(s, &a, 4)); with_rt(|r| r.fill_rect(id, x, y, w, h)); },
        "strokeRect" => |s, a, rv| { let (id, x, y, w, h) = (idx(s, &a, 0), f(s, &a, 1), f(s, &a, 2), f(s, &a, 3), f(s, &a, 4)); with_rt(|r| r.stroke_rect(id, x, y, w, h)); },
        "clearRect" => |s, a, rv| { let (id, x, y, w, h) = (idx(s, &a, 0), f(s, &a, 1), f(s, &a, 2), f(s, &a, 3), f(s, &a, 4)); with_rt(|r| r.clear_rect(id, x, y, w, h)); },
        "fillText" => |s, a, rv| {
            let (id, t, x, y, mw) = (idx(s, &a, 0), string(s, &a, 1), f(s, &a, 2), f(s, &a, 3), f(s, &a, 4));
            with_rt(|r| r.draw_text(id, &t, x, y, mw, false));
        },
        "strokeText" => |s, a, rv| {
            let (id, t, x, y, mw) = (idx(s, &a, 0), string(s, &a, 1), f(s, &a, 2), f(s, &a, 3), f(s, &a, 4));
            with_rt(|r| r.draw_text(id, &t, x, y, mw, true));
        },
        "measureText" => |s, a, rv| {
            let (id, t) = (idx(s, &a, 0), string(s, &a, 1));
            let m = with_rt(|r| r.measure_text(id, &t));
            let elems: Vec<v8::Local<v8::Value>> = m.iter().map(|v| v8::Number::new(s, *v).into()).collect();
            let arr = v8::Array::new_with_elements(s, &elems);
            rv.set(arr.into());
        },
        "drawImage" => |s, a, rv| {
            let (id, kind, src, argc) = (idx(s, &a, 0), num(s, &a, 1) as i32, idx(s, &a, 2), idx(s, &a, 3));
            let mut v = [0f32; 8];
            for k in 0..argc.min(8) { v[k] = f(s, &a, 4 + k as i32); }
            with_rt(|r| r.draw_image(id, kind, src, argc, v));
        },
        "getImageData" => |s, a, rv| {
            let (id, x, y, w, h) = (idx(s, &a, 0), num(s, &a, 1) as i32, num(s, &a, 2) as i32, num(s, &a, 3) as i32, num(s, &a, 4) as i32);
            if let Ok(view) = v8::Local::<v8::ArrayBufferView>::try_from(a.get(5)) {
                let len = view.byte_length();
                if len >= (w * h * 4) as usize && w > 0 && h > 0 {
                    let out = unsafe { std::slice::from_raw_parts_mut(view.data() as *mut u8, len) };
                    with_rt(|r| r.get_image_data(id, x, y, w, h, out));
                }
            }
        },
        "putImageData" => |s, a, rv| {
            let id = idx(s, &a, 0);
            let (iw, ih) = (num(s, &a, 2) as i32, num(s, &a, 3) as i32);
            let v: Vec<i32> = (4..10).map(|i| num(s, &a, i) as i32).collect();
            if let Ok(view) = v8::Local::<v8::ArrayBufferView>::try_from(a.get(1)) {
                let len = view.byte_length();
                if len >= (iw * ih * 4) as usize && iw > 0 && ih > 0 {
                    let data = unsafe { std::slice::from_raw_parts(view.data() as *const u8, len) };
                    with_rt(|r| r.put_image_data(id, data, iw, ih, v[0], v[1], v[2], v[3], v[4], v[5]));
                }
            }
        },
        // ---------------------------------------------------------------- styles
        "setFillStyle" => |s, a, rv| {
            let (id, kind, i, st) = (idx(s, &a, 0), num(s, &a, 1) as i32, idx(s, &a, 2), string(s, &a, 3));
            if let Some(norm) = with_rt(|r| r.set_style(id, false, kind, i, &st)) { ret_str(s, &mut rv, &norm); }
        },
        "setStrokeStyle" => |s, a, rv| {
            let (id, kind, i, st) = (idx(s, &a, 0), num(s, &a, 1) as i32, idx(s, &a, 2), string(s, &a, 3));
            if let Some(norm) = with_rt(|r| r.set_style(id, true, kind, i, &st)) { ret_str(s, &mut rv, &norm); }
        },
        "setGlobalAlpha" => |s, a, rv| { let (id, v) = (idx(s, &a, 0), f(s, &a, 1)); with_rt(|r| r.canvases[id].state.alpha = v); },
        "setLineWidth" => |s, a, rv| { let (id, v) = (idx(s, &a, 0), f(s, &a, 1)); with_rt(|r| r.canvases[id].state.line_width = v); },
        "setMiterLimit" => |s, a, rv| { let (id, v) = (idx(s, &a, 0), f(s, &a, 1)); with_rt(|r| r.canvases[id].state.miter = v); },
        "setLineDashOffset" => |s, a, rv| { let (id, v) = (idx(s, &a, 0), f(s, &a, 1)); with_rt(|r| r.canvases[id].state.dash_offset = v); },
        "setShadowBlur" => |s, a, rv| { let (id, v) = (idx(s, &a, 0), f(s, &a, 1)); with_rt(|r| r.canvases[id].state.shadow_blur = v); },
        "setShadowOffset" => |s, a, rv| {
            let (id, x, y) = (idx(s, &a, 0), f(s, &a, 1), f(s, &a, 2));
            with_rt(|r| { let st = &mut r.canvases[id].state; st.shadow_dx = x; st.shadow_dy = y; });
        },
        "setShadowColor" => |s, a, rv| {
            let (id, st) = (idx(s, &a, 0), string(s, &a, 1));
            if let Some(c) = style::parse_color(&st) {
                with_rt(|r| r.canvases[id].state.shadow_color = c);
                ret_str(s, &mut rv, &style::serialize_color(c));
            }
        },
        "setLineCap" => |s, a, rv| {
            let (id, v) = (idx(s, &a, 0), num(s, &a, 1) as i32);
            let cap = [sk::paint::Cap::Butt, sk::paint::Cap::Round, sk::paint::Cap::Square][v.clamp(0, 2) as usize];
            with_rt(|r| r.canvases[id].state.cap = cap);
        },
        "setLineJoin" => |s, a, rv| {
            let (id, v) = (idx(s, &a, 0), num(s, &a, 1) as i32);
            let join = [sk::paint::Join::Miter, sk::paint::Join::Round, sk::paint::Join::Bevel][v.clamp(0, 2) as usize];
            with_rt(|r| r.canvases[id].state.join = join);
        },
        "setLineDash" => |s, a, rv| {
            let id = idx(s, &a, 0);
            let mut dash = vec![];
            if let Ok(arr) = v8::Local::<v8::Array>::try_from(a.get(1)) {
                for i in 0..arr.length() {
                    if let Some(v) = arr.get_index(s, i) { dash.push(v.number_value(s).unwrap_or(0.0) as f32); }
                }
            }
            with_rt(|r| r.canvases[id].state.dash = dash);
        },
        "setTextAlign" => |s, a, rv| { let (id, v) = (idx(s, &a, 0), num(s, &a, 1) as u8); with_rt(|r| r.canvases[id].state.align = v); },
        "setTextBaseline" => |s, a, rv| { let (id, v) = (idx(s, &a, 0), num(s, &a, 1) as u8); with_rt(|r| r.canvases[id].state.baseline = v); },
        "setSmoothing" => |s, a, rv| {
            let (id, on, q) = (idx(s, &a, 0), boolean(s, &a, 1), num(s, &a, 2) as u8);
            with_rt(|r| { let st = &mut r.canvases[id].state; st.smoothing = on; st.quality = q; });
        },
        "setLetterSpacing" => |s, a, rv| { let (id, v) = (idx(s, &a, 0), f(s, &a, 1)); with_rt(|r| r.canvases[id].state.letter_spacing = v); },
        "setComposite" => |s, a, rv| {
            let (id, st) = (idx(s, &a, 0), string(s, &a, 1));
            match style::parse_composite(&st) {
                Some((mode, unbounded)) => {
                    with_rt(|r| { let s = &mut r.canvases[id].state; s.blend = mode; s.unbounded = unbounded; });
                    rv.set_bool(true);
                }
                None => rv.set_bool(false),
            }
        },
        "setFilter" => |s, a, rv| {
            let (id, st) = (idx(s, &a, 0), string(s, &a, 1));
            match style::parse_filter(&st) {
                Ok(fl) => { with_rt(|r| r.canvases[id].state.filter = fl); rv.set_bool(true); }
                Err(_) => rv.set_bool(false),
            }
        },
        "setFont" => |s, a, rv| {
            let (id, st) = (idx(s, &a, 0), string(s, &a, 1));
            if let Some(spec) = text::parse_font(&st) {
                let css = spec.css.clone();
                with_rt(|r| r.canvases[id].state.font = Rc::new(spec));
                ret_str(s, &mut rv, &css);
            }
        },
        // ---------------------------------------------------------------- gradients, patterns
        "gradientNew" => |s, a, rv| {
            let kind = num(s, &a, 0) as i32;
            let v: Vec<f32> = (1..7).map(|i| f(s, &a, i)).collect();
            let k = match kind {
                0 => GradKind::Linear(v[0], v[1], v[3], v[4]),
                1 => GradKind::Radial(v[0], v[1], v[2], v[3], v[4], v[5]),
                _ => GradKind::Conic(v[0], v[1], v[2]),
            };
            rv.set_int32(with_rt(|r| { r.gradients.push(Gradient { kind: k, stops: vec![] }); r.gradients.len() - 1 }) as i32);
        },
        "gradientStop" => |s, a, rv| {
            let (g, off, st) = (idx(s, &a, 0), f(s, &a, 1), string(s, &a, 2));
            match style::parse_color(&st) {
                Some(c) => {
                    with_rt(|r| {
                        let stops = &mut r.gradients[g].stops;
                        // keep stops sorted, later equal offsets after earlier ones
                        let pos = stops.iter().position(|(o, _)| *o > off).unwrap_or(stops.len());
                        stops.insert(pos, (off, c));
                    });
                    rv.set_bool(true);
                }
                None => rv.set_bool(false),
            }
        },
        "patternNew" => |s, a, rv| {
            let (kind, src, rep) = (num(s, &a, 0) as i32, idx(s, &a, 1), num(s, &a, 2) as u8);
            rv.set_int32(with_rt(|r| r.pattern_new(kind, src, rep)));
        },
        "patternTransform" => |s, a, rv| {
            let p = idx(s, &a, 0);
            let m = [f(s, &a, 1), f(s, &a, 2), f(s, &a, 3), f(s, &a, 4), f(s, &a, 5), f(s, &a, 6)];
            with_rt(|r| r.patterns[p].matrix = Matrix::new_all(m[0], m[2], m[4], m[1], m[3], m[5], 0.0, 0.0, 1.0));
        },
        // ---------------------------------------------------------------- images, fonts
        "imageLoad" => |s, a, rv| {
            let url = string(s, &a, 0);
            let base = with_rt(|r| r.base.clone());
            let img = read_url(&base, &url).and_then(|b| decode_image(&b, &url));
            match img {
                Some(img) => {
                    let (w, h) = img.size();
                    let id = with_rt(|r| { r.images.push(Some(img)); r.images.len() - 1 });
                    let elems: Vec<v8::Local<v8::Value>> = vec![v8::Integer::new(s, id as i32).into(), v8::Number::new(s, w as f64).into(), v8::Number::new(s, h as f64).into()];
                    let arr = v8::Array::new_with_elements(s, &elems);
                    rv.set(arr.into());
                }
                None => rv.set_null(),
            }
        },
        "imageFree" => |s, a, rv| {
            let id = idx(s, &a, 0);
            with_rt(|r| if id < r.images.len() { r.images[id] = None; });
        },
        "fontLoadUrl" => |s, a, rv| {
            let (family, url) = (string(s, &a, 0), string(s, &a, 1));
            let base = with_rt(|r| r.base.clone());
            let ok = match read_url(&base, &url) { Some(b) => with_rt(|r| r.fonts.register(&family, &b)), None => false };
            rv.set_bool(ok);
        },
        "fontLoadBytes" => |s, a, rv| {
            let family = string(s, &a, 0);
            let mut ok = false;
            if let Ok(ab) = v8::Local::<v8::ArrayBuffer>::try_from(a.get(1)) {
                let len = ab.byte_length();
                if let Some(p) = ab.data() {
                    let bytes = unsafe { std::slice::from_raw_parts(p.as_ptr() as *const u8, len) }.to_vec();
                    ok = with_rt(|r| r.fonts.register(&family, &bytes));
                }
            }
            rv.set_bool(ok);
        },
        "fontCheck" => |s, a, rv| { let st = string(s, &a, 0); rv.set_bool(with_rt(|r| r.fonts.check(&st))); },
    );
    let key = v8::String::new(scope, "__native").unwrap();
    global.set(scope, key.into(), obj.into());
}

pub const DOM_JS: &str = include_str!("js/dom.js");

/// What drives frames: motion-use's film runtime (hf-seek) or a frame-engine page.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Mode {
    Film,
    Engine,
}

pub struct Engine {
    isolate: v8::OwnedIsolate,
    context: v8::Global<v8::Context>,
    output: usize,
    mode: Mode,
    background: Option<[u8; 3]>,
}

/// Composite straight RGBA over an opaque colour in place (what the page background does under
/// a canvas with transparent pixels). Opaque frames are left untouched.
fn flatten(px: &mut [u8], bg: [u8; 3]) {
    for p in px.chunks_exact_mut(4) {
        let a = p[3] as u32;
        if a == 255 {
            continue;
        }
        for k in 0..3 {
            p[k] = ((p[k] as u32 * a + bg[k] as u32 * (255 - a) + 127) / 255) as u8;
        }
        p[3] = 255;
    }
}

fn exception_text(tc: &mut v8::PinnedRef<'_, v8::TryCatch<v8::HandleScope>>) -> String {
    let Some(exc) = tc.exception() else { return "unknown error".into() };
    let mut msg = exc.to_string(tc).map(|s| s.to_rust_string_lossy(tc)).unwrap_or_default();
    if let Ok(obj) = v8::Local::<v8::Object>::try_from(exc) {
        let key = v8::String::new(tc, "stack").unwrap();
        if let Some(stack) = obj.get(tc, key.into()) {
            if stack.is_string() {
                msg = stack.to_rust_string_lossy(tc);
            }
        }
    }
    if let Some(m) = tc.message() {
        let file = m.get_script_resource_name(tc).map(|s| s.to_rust_string_lossy(tc)).unwrap_or_default();
        let line = m.get_line_number(tc).unwrap_or(0);
        if !msg.contains(&file) || file.is_empty() {
            msg = format!("{}:{}: {}", file, line, msg);
        }
    }
    msg
}

impl Engine {
    pub fn new(page: &Page, mode: Mode, size: Option<(i32, i32)>) -> Result<Engine> {
        init_v8();
        let mut rt = Runtime::new(page.base.clone());
        rt.fonts.lang = page.lang.clone();
        for face in &page.fonts {
            let bytes = match &face.source {
                FontSource::File(p) => std::fs::read(p).map_err(|e| anyhow!("font {}: {}", p.display(), e))?,
                FontSource::Bytes(b) => b.to_vec(),
            };
            if !rt.fonts.register(&face.family, &bytes) {
                return Err(anyhow!("font {} could not be loaded", face.family));
            }
        }
        RT.with(|r| *r.borrow_mut() = Some(rt));
        let mut isolate = v8::Isolate::new(v8::CreateParams::default());
        isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
        let context = {
            v8::scope!(let hs, &mut isolate);
            let ctx = v8::Context::new(hs, Default::default());
            let cs = &mut v8::ContextScope::new(hs, ctx);
            let global = ctx.global(cs);
            install_natives(cs, global);
            v8::Global::new(cs, ctx)
        };
        let mut e = Engine { isolate, context, output: 0, mode, background: page.background };
        e.eval("dom.js", DOM_JS)?;
        let size_js = match size {
            Some((w, h)) => format!("[{},{}]", w, h),
            None => "null".into(),
        };
        e.eval("init", &format!("__mr.init({}, {})", page.elements_json(), size_js))?;
        for s in &page.scripts {
            e.eval(&s.name, &s.code)?;
            e.settle("loading scripts", false)?;
        }
        Ok(e)
    }

    /// Run a script; Err carries the exception with file and line.
    pub fn eval(&mut self, name: &str, code: &str) -> Result<String> {
        v8::scope!(let hs, &mut self.isolate);
        let ctx = v8::Local::new(hs, &self.context);
        let cs = &mut v8::ContextScope::new(hs, ctx);
        v8::tc_scope!(let tc, cs);
        let src = v8::String::new(tc, code).ok_or_else(|| anyhow!("script too large"))?;
        let fname = v8::String::new(tc, name).unwrap();
        let origin = v8::ScriptOrigin::new(tc, fname.into(), 0, 0, false, 0, None, false, false, false, None);
        let Some(script) = v8::Script::compile(tc, src, Some(&origin)) else {
            return Err(anyhow!("{}", exception_text(tc)));
        };
        match script.run(tc) {
            Some(v) => Ok(if v.is_undefined() { String::new() } else { v.to_rust_string_lossy(tc) }),
            None => Err(anyhow!("{}", exception_text(tc))),
        }
    }

    fn checkpoint(&mut self) {
        self.isolate.perform_microtask_checkpoint();
        while v8::Platform::pump_message_loop(platform(), &self.isolate, false) {}
    }

    /// Drain microtasks and the virtual-clock timers until the driver's promise settles.
    fn settle(&mut self, what: &str, require: bool) -> Result<()> {
        for _ in 0..200 {
            self.checkpoint();
            let state = self.eval("state", "__mr.state()")?;
            if let Some(err) = state.strip_prefix("error: ") {
                return Err(anyhow!("{}: {}", what, err));
            }
            if state != "pending" {
                return Ok(());
            }
            let ran = self.eval("timers", "__mr.runTimers()")?;
            if ran == "0" {
                self.checkpoint();
                let state = self.eval("state", "__mr.state()")?;
                if state == "pending" {
                    if require {
                        return Err(anyhow!("{}: a promise never settled (the page waits for something motion-render does not provide)", what));
                    }
                    return Ok(());
                }
            }
        }
        Err(anyhow!("{}: did not settle", what))
    }

    pub fn setup(&mut self, job: Option<&str>) -> Result<()> {
        match self.mode {
            Mode::Film => {
                self.eval("setup", "__mr.filmSetup()")?;
                self.settle("film setup (fonts, images, setupFilm)", true)?;
                self.output = self.eval("output", "__mr.filmOutput()")?.parse()?;
            }
            Mode::Engine => {
                self.eval("setup", &format!("__mr.engineSetup({})", job.unwrap_or("{}")))?;
                self.settle("setupEngine", true)?;
                self.output = self.eval("output", "__mr.engineOutput()")?.parse()?;
            }
        }
        Ok(())
    }

    /// Draw page time `t` and read the frame as straight RGBA.
    pub fn render(&mut self, t: f64, out: &mut Vec<u8>) -> Result<(i32, i32)> {
        let call = match self.mode {
            Mode::Film => format!("__mr.filmSeek({})", t),
            Mode::Engine => format!("__mr.engineFrame({})", t),
        };
        self.eval("frame", &call)?;
        self.settle(&format!("frame at {:.4}s", t), true)?;
        let size = with_rt(|r| r.read_rgba(self.output, out));
        if let Some(bg) = self.background {
            flatten(out, bg);
        }
        Ok(size)
    }

    /// Run motion-use's text probe (film pages only) over `times` (a JSON array of seconds).
    pub fn text_probe(&mut self, times: &str) -> Result<String> {
        self.eval("probe", &format!("__mr.textProbe({})", times))?;
        self.settle("text probe", true)?;
        self.eval("probe result", "__mr.probeResult")
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        RT.with(|r| *r.borrow_mut() = None);
    }
}
