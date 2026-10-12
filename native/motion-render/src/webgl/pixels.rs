//! Pixel conversions WebGL does on the client side before an upload (what Blink's
//! WebGLImageConversion does): TexImageSource → RGBA8 with UNPACK_FLIP_Y / PREMULTIPLY_ALPHA
//! applied, then packed into the format/type the page asked for.
use super::gl::{self, types::*};

pub const HALF_FLOAT_OES: GLenum = 0x8D61;

/// Bytes per pixel of client data in `format`/`type`, if known.
pub fn bytes_per_pixel(format: GLenum, ty: GLenum) -> Option<usize> {
    let channels = match format {
        gl::RGBA | gl::RGBA_INTEGER => 4,
        gl::RGB | gl::RGB_INTEGER => 3,
        gl::RG | gl::RG_INTEGER | gl::LUMINANCE_ALPHA => 2,
        gl::RED | gl::RED_INTEGER | gl::ALPHA | gl::LUMINANCE | gl::DEPTH_COMPONENT => 1,
        gl::DEPTH_STENCIL => return Some(if ty == gl::FLOAT_32_UNSIGNED_INT_24_8_REV { 8 } else { 4 }),
        _ => return None,
    };
    let size = match ty {
        gl::UNSIGNED_BYTE | gl::BYTE => 1,
        gl::UNSIGNED_SHORT | gl::SHORT | gl::HALF_FLOAT | HALF_FLOAT_OES => 2,
        gl::UNSIGNED_INT | gl::INT | gl::FLOAT => 4,
        gl::UNSIGNED_SHORT_5_6_5 | gl::UNSIGNED_SHORT_4_4_4_4 | gl::UNSIGNED_SHORT_5_5_5_1 => return Some(2),
        gl::UNSIGNED_INT_2_10_10_10_REV | gl::UNSIGNED_INT_10F_11F_11F_REV | gl::UNSIGNED_INT_5_9_9_9_REV | gl::UNSIGNED_INT_24_8 => return Some(4),
        _ => return None,
    };
    Some(channels * size)
}

pub fn premultiply(px: &mut [u8]) {
    for p in px.chunks_exact_mut(4) {
        let a = p[3] as u32;
        if a == 255 {
            continue;
        }
        for c in &mut p[..3] {
            *c = ((*c as u32 * a + 127) / 255) as u8;
        }
    }
}

pub fn unpremultiply(px: &mut [u8]) {
    for p in px.chunks_exact_mut(4) {
        let a = p[3] as u32;
        if a == 255 {
            continue;
        }
        if a == 0 {
            p[0] = 0;
            p[1] = 0;
            p[2] = 0;
            continue;
        }
        for c in &mut p[..3] {
            *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
        }
    }
}

pub fn flip_rows(px: &mut [u8], row: usize, rows: usize) {
    let mut tmp = vec![0u8; row];
    for y in 0..rows / 2 {
        let (a, b) = (y * row, (rows - 1 - y) * row);
        tmp.copy_from_slice(&px[a..a + row]);
        px.copy_within(b..b + row, a);
        px[b..b + row].copy_from_slice(&tmp);
    }
}

fn f16(v: f32) -> u16 {
    // round-to-nearest-even conversion for values in [0, 1]
    let x = v.to_bits();
    let sign = ((x >> 16) & 0x8000) as u16;
    let exp = ((x >> 23) & 0xff) as i32 - 127 + 15;
    let mant = x & 0x7f_ffff;
    if v == 0.0 {
        return sign;
    }
    if exp <= 0 {
        // subnormal
        let m = (mant | 0x80_0000) >> (1 - exp);
        let r = (m >> 13) + (((m >> 12) & 1) & (((m & 0xfff) != 0) as u32 | ((m >> 13) & 1)));
        return sign | r as u16;
    }
    if exp >= 31 {
        return sign | 0x7c00;
    }
    let mut h = ((exp as u32) << 10) | (mant >> 13);
    let rest = mant & 0x1fff;
    if rest > 0x1000 || (rest == 0x1000 && (h & 1) == 1) {
        h += 1;
    }
    sign | h as u16
}

/// Pack straight/premultiplied RGBA8 rows into `format`/`type` with no row padding.
pub fn pack(rgba: &[u8], format: GLenum, ty: GLenum) -> Option<Vec<u8>> {
    let pick: &[usize] = match format {
        gl::RGBA => &[0, 1, 2, 3],
        gl::RGB => &[0, 1, 2],
        gl::RG => &[0, 1],
        gl::RED | gl::LUMINANCE => &[0],
        gl::ALPHA => &[3],
        gl::LUMINANCE_ALPHA => &[0, 3],
        _ => return None,
    };
    let n = rgba.len() / 4;
    match ty {
        gl::UNSIGNED_BYTE => {
            if format == gl::RGBA {
                return Some(rgba.to_vec());
            }
            let mut out = Vec::with_capacity(n * pick.len());
            for p in rgba.chunks_exact(4) {
                for &c in pick {
                    out.push(p[c]);
                }
            }
            Some(out)
        }
        gl::FLOAT => {
            let mut out = Vec::with_capacity(n * pick.len() * 4);
            for p in rgba.chunks_exact(4) {
                for &c in pick {
                    out.extend_from_slice(&(p[c] as f32 / 255.0).to_ne_bytes());
                }
            }
            Some(out)
        }
        gl::HALF_FLOAT | HALF_FLOAT_OES => {
            let mut out = Vec::with_capacity(n * pick.len() * 2);
            for p in rgba.chunks_exact(4) {
                for &c in pick {
                    out.extend_from_slice(&f16(p[c] as f32 / 255.0).to_ne_bytes());
                }
            }
            Some(out)
        }
        gl::UNSIGNED_SHORT_5_6_5 if format == gl::RGB => {
            let mut out = Vec::with_capacity(n * 2);
            for p in rgba.chunks_exact(4) {
                let v = ((p[0] as u16 >> 3) << 11) | ((p[1] as u16 >> 2) << 5) | (p[2] as u16 >> 3);
                out.extend_from_slice(&v.to_ne_bytes());
            }
            Some(out)
        }
        gl::UNSIGNED_SHORT_4_4_4_4 if format == gl::RGBA => {
            let mut out = Vec::with_capacity(n * 2);
            for p in rgba.chunks_exact(4) {
                let v = ((p[0] as u16 >> 4) << 12) | ((p[1] as u16 >> 4) << 8) | ((p[2] as u16 >> 4) << 4) | (p[3] as u16 >> 4);
                out.extend_from_slice(&v.to_ne_bytes());
            }
            Some(out)
        }
        gl::UNSIGNED_SHORT_5_5_5_1 if format == gl::RGBA => {
            let mut out = Vec::with_capacity(n * 2);
            for p in rgba.chunks_exact(4) {
                let v = ((p[0] as u16 >> 3) << 11) | ((p[1] as u16 >> 3) << 6) | ((p[2] as u16 >> 3) << 1) | (p[3] as u16 >> 7);
                out.extend_from_slice(&v.to_ne_bytes());
            }
            Some(out)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn half_floats() {
        assert_eq!(f16(1.0), 0x3c00);
        assert_eq!(f16(0.5), 0x3800);
        assert_eq!(f16(0.0), 0);
        assert_eq!(f16(1.0 / 255.0), 0x1c04);
    }
    #[test]
    fn premul_roundtrip_opaque() {
        let mut p = vec![10, 20, 30, 255, 200, 100, 50, 128];
        premultiply(&mut p);
        assert_eq!(&p[..4], &[10, 20, 30, 255]);
        assert_eq!(&p[4..], &[100, 50, 25, 128]);
    }
    #[test]
    fn flips() {
        let mut p = vec![1, 1, 2, 2, 3, 3];
        flip_rows(&mut p, 2, 3);
        assert_eq!(p, vec![3, 3, 2, 2, 1, 1]);
    }
}
