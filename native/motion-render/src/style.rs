//! CSS values a 2D canvas accepts: colours, composite operations, filters.
use skia_safe::{self as sk, image_filters, BlendMode, Color, ColorFilter, ImageFilter};

/// Parse a CSS colour the way a canvas does; returns the 8-bit colour Chrome keeps.
pub fn parse_color(s: &str) -> Option<Color> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    let lower = t.to_ascii_lowercase();
    if lower == "currentcolor" {
        return Some(Color::BLACK);
    }
    let c = csscolorparser::parse(&lower).ok()?;
    let [r, g, b, a] = c.to_rgba8();
    Some(Color::from_argb(a, r, g, b))
}

/// Chrome's serialisation: `#rrggbb` when opaque, otherwise `rgba(r, g, b, a)`.
pub fn serialize_color(c: Color) -> String {
    if c.a() == 255 {
        format!("#{:02x}{:02x}{:02x}", c.r(), c.g(), c.b())
    } else {
        let a = c.a() as f64 / 255.0;
        // Chrome prints the alpha with up to 3 significant decimals.
        let mut s = format!("{:.3}", a);
        while s.ends_with('0') {
            s.pop();
        }
        if s.ends_with('.') {
            s.pop();
        }
        if a == 0.0 {
            s = "0".into();
        }
        format!("rgba({}, {}, {}, {})", c.r(), c.g(), c.b(), s)
    }
}

/// globalCompositeOperation → Skia blend mode, and whether the operation is "unbounded"
/// (it also affects destination pixels outside the drawn shape, so it must be drawn through a
/// layer that covers the clip).
pub fn parse_composite(s: &str) -> Option<(BlendMode, bool)> {
    use BlendMode::*;
    Some(match s {
        "source-over" => (SrcOver, false),
        "source-in" => (SrcIn, true),
        "source-out" => (SrcOut, true),
        "source-atop" => (SrcATop, false),
        "destination-over" => (DstOver, false),
        "destination-in" => (DstIn, true),
        "destination-out" => (DstOut, false),
        "destination-atop" => (DstATop, true),
        "lighter" => (Plus, false),
        "copy" => (Src, true),
        "xor" => (Xor, false),
        "multiply" => (Multiply, false),
        "screen" => (Screen, false),
        "overlay" => (Overlay, false),
        "darken" => (Darken, false),
        "lighten" => (Lighten, false),
        "color-dodge" => (ColorDodge, false),
        "color-burn" => (ColorBurn, false),
        "hard-light" => (HardLight, false),
        "soft-light" => (SoftLight, false),
        "difference" => (Difference, false),
        "exclusion" => (Exclusion, false),
        "hue" => (Hue, false),
        "saturation" => (Saturation, false),
        "color" => (Color, false),
        "luminosity" => (Luminosity, false),
        _ => return None,
    })
}

fn color_matrix(m: [f32; 20], input: Option<ImageFilter>) -> Option<ImageFilter> {
    let cf: ColorFilter = sk::color_filters::matrix_row_major(&m, None);
    image_filters::color_filter(cf, input, None)
}

fn number_or_percent(arg: &str) -> Option<f32> {
    let a = arg.trim();
    if a.is_empty() {
        return None;
    }
    if let Some(p) = a.strip_suffix('%') {
        p.trim().parse::<f32>().ok().map(|v| v / 100.0)
    } else {
        a.parse::<f32>().ok()
    }
}

fn length_px(arg: &str) -> Option<f32> {
    let a = arg.trim();
    if a.is_empty() {
        return Some(0.0);
    }
    if let Some(v) = a.strip_suffix("px") {
        return v.trim().parse().ok();
    }
    if let Some(v) = a.strip_suffix("em") {
        return v.trim().parse::<f32>().ok().map(|v| v * 16.0);
    }
    if let Some(v) = a.strip_suffix("rem") {
        return v.trim().parse::<f32>().ok().map(|v| v * 16.0);
    }
    let v: f32 = a.parse().ok()?;
    if v == 0.0 {
        Some(0.0)
    } else {
        None
    }
}

fn angle_deg(arg: &str) -> Option<f32> {
    let a = arg.trim();
    if let Some(v) = a.strip_suffix("deg") {
        return v.trim().parse().ok();
    }
    if let Some(v) = a.strip_suffix("grad") {
        return v.trim().parse::<f32>().ok().map(|v| v * 0.9);
    }
    if let Some(v) = a.strip_suffix("rad") {
        return v.trim().parse::<f32>().ok().map(|v| v.to_degrees());
    }
    if let Some(v) = a.strip_suffix("turn") {
        return v.trim().parse::<f32>().ok().map(|v| v * 360.0);
    }
    let v: f32 = a.parse().ok()?;
    if v == 0.0 {
        Some(0.0)
    } else {
        None
    }
}

/// Split a drop-shadow argument list: lengths and a colour in any order.
fn split_shadow(arg: &str) -> Option<(f32, f32, f32, Color)> {
    let mut tokens = Vec::new();
    let mut depth = 0;
    let mut cur = String::new();
    for ch in arg.chars() {
        match ch {
            '(' => {
                depth += 1;
                cur.push(ch)
            }
            ')' => {
                depth -= 1;
                cur.push(ch)
            }
            c if c.is_whitespace() && depth == 0 => {
                if !cur.is_empty() {
                    tokens.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        tokens.push(cur);
    }
    let mut lengths = Vec::new();
    let mut color = Color::BLACK;
    for t in tokens {
        if let Some(l) = length_px(&t) {
            lengths.push(l);
        } else {
            color = parse_color(&t)?;
        }
    }
    if lengths.len() < 2 {
        return None;
    }
    Some((lengths[0], lengths[1], *lengths.get(2).unwrap_or(&0.0), color))
}

/// A CSS filter list as one Skia image filter (functions applied left to right), in device
/// pixels. `Ok(None)` is `none`; `Err` is an invalid value (the canvas keeps the old filter).
pub fn parse_filter(s: &str) -> Result<Option<ImageFilter>, ()> {
    let t = s.trim();
    if t.is_empty() || t == "none" {
        return Ok(None);
    }
    let mut out: Option<ImageFilter> = None;
    let mut rest = t;
    let mut any = false;
    while !rest.trim().is_empty() {
        let r = rest.trim_start();
        let open = r.find('(').ok_or(())?;
        let name = r[..open].trim().to_ascii_lowercase();
        // matching close paren (allow nested for colours)
        let mut depth = 0;
        let mut close = None;
        for (i, ch) in r[open..].char_indices() {
            match ch {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        close = Some(open + i);
                        break;
                    }
                }
                _ => {}
            }
        }
        let close = close.ok_or(())?;
        let arg = r[open + 1..close].trim();
        rest = &r[close + 1..];
        any = true;
        let amount = |default: f32| -> Result<f32, ()> {
            if arg.is_empty() {
                Ok(default)
            } else {
                number_or_percent(arg).ok_or(())
            }
        };
        out = match name.as_str() {
            "blur" => {
                let sigma = length_px(arg).ok_or(())?;
                if sigma <= 0.0 {
                    out
                } else {
                    image_filters::blur((sigma, sigma), sk::TileMode::Decal, out, None)
                }
            }
            "brightness" => {
                let a = amount(1.0)?;
                color_matrix([a, 0., 0., 0., 0., 0., a, 0., 0., 0., 0., 0., a, 0., 0., 0., 0., 0., 1., 0.], out)
            }
            "contrast" => {
                let a = amount(1.0)?;
                let o = 0.5 - 0.5 * a;
                color_matrix([a, 0., 0., 0., o, 0., a, 0., 0., o, 0., 0., a, 0., o, 0., 0., 0., 1., 0.], out)
            }
            "grayscale" => {
                let a = 1.0 - amount(1.0)?.clamp(0.0, 1.0);
                color_matrix(
                    [
                        0.2126 + 0.7874 * a, 0.7152 - 0.7152 * a, 0.0722 - 0.0722 * a, 0., 0.,
                        0.2126 - 0.2126 * a, 0.7152 + 0.2848 * a, 0.0722 - 0.0722 * a, 0., 0.,
                        0.2126 - 0.2126 * a, 0.7152 - 0.7152 * a, 0.0722 + 0.9278 * a, 0., 0.,
                        0., 0., 0., 1., 0.,
                    ],
                    out,
                )
            }
            "sepia" => {
                let a = 1.0 - amount(1.0)?.clamp(0.0, 1.0);
                color_matrix(
                    [
                        0.393 + 0.607 * a, 0.769 - 0.769 * a, 0.189 - 0.189 * a, 0., 0.,
                        0.349 - 0.349 * a, 0.686 + 0.314 * a, 0.168 - 0.168 * a, 0., 0.,
                        0.272 - 0.272 * a, 0.534 - 0.534 * a, 0.131 + 0.869 * a, 0., 0.,
                        0., 0., 0., 1., 0.,
                    ],
                    out,
                )
            }
            "saturate" => {
                let s = amount(1.0)?;
                color_matrix(
                    [
                        0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0., 0.,
                        0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0., 0.,
                        0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0., 0.,
                        0., 0., 0., 1., 0.,
                    ],
                    out,
                )
            }
            "invert" => {
                let a = amount(1.0)?.clamp(0.0, 1.0);
                let k = 1.0 - 2.0 * a;
                color_matrix([k, 0., 0., 0., a, 0., k, 0., 0., a, 0., 0., k, 0., a, 0., 0., 0., 1., 0.], out)
            }
            "opacity" => {
                let a = amount(1.0)?.clamp(0.0, 1.0);
                color_matrix([1., 0., 0., 0., 0., 0., 1., 0., 0., 0., 0., 0., 1., 0., 0., 0., 0., 0., a, 0.], out)
            }
            "hue-rotate" => {
                let d = if arg.is_empty() { 0.0 } else { angle_deg(arg).ok_or(())? };
                let (s, c) = d.to_radians().sin_cos();
                color_matrix(
                    [
                        0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928, 0., 0.,
                        0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283, 0., 0.,
                        0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072, 0., 0.,
                        0., 0., 0., 1., 0.,
                    ],
                    out,
                )
            }
            "drop-shadow" => {
                let (dx, dy, blur, color) = split_shadow(arg).ok_or(())?;
                image_filters::drop_shadow((dx, dy), (blur, blur), sk::Color4f::from(color), None, out, None)
            }
            _ => return Err(()),
        };
    }
    if !any {
        return Err(());
    }
    Ok(out)
}
