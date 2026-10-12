//! Fonts and text: CSS font shorthand, @font-face registration (TTF/OTF/WOFF2), per-character font
//! selection with system fallback, Blink-style itemisation + HarfBuzz shaping (shape.rs), Blink's
//! baseline rules, and Chrome-on-macOS glyph rasterisation settings.
use crate::shape;
use skia_safe::{
    self as sk,
    font_style::{Slant, Weight, Width},
    Font, FontArguments, FontMgr, FontStyle, FourByteTag, Point, Rect, TextBlob, TextBlobBuilder, Typeface,
};
use std::collections::HashMap;
use std::rc::Rc;

#[derive(Clone, Debug)]
pub struct FontSpec {
    pub italic: bool,
    pub weight: i32,
    pub size: f32,
    pub families: Vec<String>,
    pub css: String,
}

impl Default for FontSpec {
    fn default() -> Self {
        parse_font("10px sans-serif").unwrap()
    }
}

fn split_families(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    for part in s.split(',') {
        let p = part.trim();
        let p = p.trim_matches(|c| c == '"' || c == '\'').trim();
        if !p.is_empty() {
            out.push(p.to_string());
        }
    }
    out
}

fn parse_size(tok: &str) -> Option<f32> {
    let t = tok.split('/').next()?;
    let kw = match t {
        "xx-small" => Some(9.0),
        "x-small" => Some(10.0),
        "small" => Some(13.0),
        "medium" => Some(16.0),
        "large" => Some(18.0),
        "x-large" => Some(24.0),
        "xx-large" => Some(32.0),
        "xxx-large" => Some(48.0),
        "smaller" => Some(8.333),
        "larger" => Some(12.0),
        _ => None,
    };
    if kw.is_some() {
        return kw;
    }
    let units: &[(&str, f32)] = &[("px", 1.0), ("pt", 4.0 / 3.0), ("pc", 16.0), ("rem", 16.0), ("em", 10.0), ("%", 0.1), ("in", 96.0), ("cm", 96.0 / 2.54), ("mm", 96.0 / 25.4), ("q", 96.0 / 101.6)];
    for (u, k) in units {
        if let Some(v) = t.strip_suffix(u) {
            if let Ok(n) = v.parse::<f32>() {
                if n >= 0.0 && n.is_finite() {
                    return Some(n * k);
                }
            }
            return None;
        }
    }
    None
}

/// CSS font shorthand: `[style] [variant] [weight] [stretch] size[/line-height] family[, family]*`.
pub fn parse_font(s: &str) -> Option<FontSpec> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let mut italic = false;
    let mut weight = 400;
    let mut rest = s;
    loop {
        let r = rest.trim_start();
        let end = r.find(char::is_whitespace).unwrap_or(r.len());
        let tok = &r[..end];
        let lower = tok.to_ascii_lowercase();
        if let Some(size) = parse_size(&lower) {
            let families = split_families(&r[end..]);
            if families.is_empty() {
                return None;
            }
            let fam_css: Vec<String> = families.iter().map(|f| if f.contains(' ') && !is_generic(f) { format!("\"{}\"", f) } else { f.clone() }).collect();
            let mut css = String::new();
            if italic {
                css.push_str("italic ");
            }
            if weight != 400 {
                css.push_str(&format!("{} ", weight));
            }
            css.push_str(&format!("{}px {}", size, fam_css.join(", ")));
            return Some(FontSpec { italic, weight, size, families, css });
        }
        match lower.as_str() {
            "normal" | "small-caps" | "ultra-condensed" | "extra-condensed" | "condensed" | "semi-condensed" | "semi-expanded" | "expanded" | "extra-expanded" | "ultra-expanded" => {}
            "italic" | "oblique" => italic = true,
            "bold" | "bolder" => weight = 700,
            "lighter" => weight = 100,
            _ => match lower.parse::<f32>() {
                Ok(w) if (1.0..=1000.0).contains(&w) => weight = w.round() as i32,
                _ => return None,
            },
        }
        if end >= r.len() {
            return None;
        }
        rest = &r[end..];
    }
}

fn is_generic(f: &str) -> bool {
    matches!(f.to_ascii_lowercase().as_str(), "serif" | "sans-serif" | "monospace" | "cursive" | "fantasy" | "system-ui" | "ui-sans-serif" | "ui-serif" | "ui-monospace" | "ui-rounded" | "emoji" | "math")
}

/// Chrome's macOS defaults for the generic families.
fn generic_to_family(f: &str) -> Option<&'static str> {
    Some(match f.to_ascii_lowercase().as_str() {
        "serif" => "Times",
        "sans-serif" => "Helvetica",
        "monospace" | "ui-monospace" => "Courier",
        "cursive" => "Apple Chancery",
        "fantasy" => "Papyrus",
        "system-ui" | "ui-sans-serif" => ".AppleSystemUIFont",
        "ui-serif" => "New York",
        "ui-rounded" => ".AppleSystemUIFontRounded",
        _ => return None,
    })
}

pub struct Shaped {
    pub blob: Option<TextBlob>,
    pub width: f32,
    /// glyph ink bounds relative to (left edge, alphabetic baseline)
    pub ink: Rect,
    /// primary font: hhea/CoreText ascent and descent (positive), Blink's normalised typo
    /// ascent/descent (they sum to the em size), and the ideographic baseline depth
    pub ascent: f32,
    pub descent: f32,
    pub typo_ascent: f32,
    pub typo_descent: f32,
    pub ideographic: f32,
}

const WGHT: FourByteTag = FourByteTag::from_chars('w', 'g', 'h', 't');

pub struct Fonts {
    system: FontMgr,
    /// @font-face / FontFace registrations by lower-case family
    registered: HashMap<String, Vec<Typeface>>,
    /// (family, weight, italic) → the face to use, with its wght axis set
    faces: HashMap<(String, i32, bool), Option<Typeface>>,
    /// (char, weight, italic) → system fallback face
    fallback: HashMap<(char, i32, bool), Option<Typeface>>,
    cache: HashMap<String, Rc<Shaped>>,
    metrics: HashMap<u32, (Option<(f32, f32)>, bool)>,
    /// document language: picks the script of script-neutral text and the fallback fonts
    pub lang: String,
}

fn has_wght(tf: &Typeface) -> bool {
    tf.variation_design_parameters().map(|axes| axes.iter().any(|a| a.tag == WGHT)).unwrap_or(false)
}

fn with_weight(tf: &Typeface, weight: i32) -> Typeface {
    if !has_wght(tf) {
        return tf.clone();
    }
    let coords = [sk::font_arguments::variation_position::Coordinate { axis: WGHT, value: weight as f32 }];
    let args = FontArguments::new().set_variation_design_position(sk::font_arguments::VariationPosition { coordinates: &coords });
    tf.clone_with_arguments(&args).unwrap_or_else(|| tf.clone())
}

impl Fonts {
    pub fn new() -> Self {
        Fonts { system: FontMgr::new(), registered: HashMap::new(), faces: HashMap::new(), fallback: HashMap::new(), cache: HashMap::new(), metrics: HashMap::new(), lang: "en".into() }
    }

    /// Register font file bytes (TTF/OTF, or WOFF/WOFF2 which are decompressed first) under `family`.
    pub fn register(&mut self, family: &str, bytes: &[u8]) -> bool {
        let data: Vec<u8> = if bytes.len() > 4 && &bytes[0..4] == b"wOF2" {
            match woff2_patched::decode::convert_woff2_to_ttf(&mut std::io::Cursor::new(bytes)) {
                Ok(v) => v,
                Err(_) => return false,
            }
        } else if bytes.len() > 4 && &bytes[0..4] == b"wOFF" {
            match woff1_to_sfnt(bytes) {
                Some(v) => v,
                None => return false,
            }
        } else {
            bytes.to_vec()
        };
        let Some(tf) = self.system.new_from_data(sk::Data::new_copy(&data), None) else {
            return false;
        };
        self.registered.entry(family.to_ascii_lowercase()).or_default().push(tf);
        self.faces.clear();
        self.cache.clear();
        true
    }

    pub fn has_family(&self, family: &str) -> bool {
        if self.registered.contains_key(&family.to_ascii_lowercase()) {
            return true;
        }
        let name = generic_to_family(family).unwrap_or(family);
        self.system.match_family(name).count() > 0
    }

    /// document.fonts.check(): every listed family is available (generic families always are).
    pub fn check(&self, css: &str) -> bool {
        match parse_font(css) {
            Some(spec) => spec.families.iter().all(|f| is_generic(f) || self.has_family(f)),
            None => false,
        }
    }

    fn style(weight: i32, italic: bool) -> FontStyle {
        FontStyle::new(Weight::from(weight), Width::NORMAL, if italic { Slant::Italic } else { Slant::Upright })
    }

    /// The face a family gives for this weight and style (registered first, then the system).
    fn face(&mut self, family: &str, weight: i32, italic: bool) -> Option<Typeface> {
        let key = (family.to_ascii_lowercase(), weight, italic);
        if let Some(v) = self.faces.get(&key) {
            return v.clone();
        }
        let tf = if let Some(list) = self.registered.get(&key.0) {
            // closest weight (variable faces cover every weight), then italic match
            let best = list
                .iter()
                .min_by_key(|t| {
                    let s = t.font_style();
                    let dw = if has_wght(t) { 0 } else { (*s.weight() - weight).abs() };
                    dw * 2 + ((s.slant() != Slant::Upright) != italic) as i32
                })
                .cloned();
            best.map(|t| with_weight(&t, weight))
        } else {
            let name = generic_to_family(family).unwrap_or(family);
            self.system.match_family_style(name, Self::style(weight, italic))
        };
        self.faces.insert(key, tf.clone());
        tf
    }

    fn fallback_face(&mut self, c: char, weight: i32, italic: bool) -> Option<Typeface> {
        if let Some(v) = self.fallback.get(&(c, weight, italic)) {
            return v.clone();
        }
        let lang = self.lang.clone();
        let tf = self.system.match_family_style_character("", Self::style(weight, italic), &[lang.as_str()], c as i32);
        self.fallback.insert((c, weight, italic), tf.clone());
        tf
    }

    fn primary(&mut self, spec: &FontSpec) -> Option<Typeface> {
        for f in &spec.families {
            if let Some(tf) = self.face(f, spec.weight, spec.italic) {
                return Some(tf);
            }
        }
        self.face("serif", spec.weight, spec.italic)
    }

    /// OS/2 typo ascent/descent in em units (None when absent) and whether a BASE table exists.
    fn font_tables(&mut self, tf: &Typeface) -> (Option<(f32, f32)>, bool) {
        let id = u32::from(tf.unique_id());
        if let Some(v) = self.metrics.get(&id) {
            return *v;
        }
        let upem = tf.units_per_em().unwrap_or(1000) as f32;
        let typo = tf.copy_table_data(0x4F53_2F32).and_then(|d| {
            let b = d.as_bytes();
            if b.len() < 72 {
                return None;
            }
            let asc = i16::from_be_bytes([b[68], b[69]]) as f32 / upem;
            let desc = -(i16::from_be_bytes([b[70], b[71]]) as f32) / upem;
            (asc + desc > 0.0).then_some((asc, desc))
        });
        let base = tf.copy_table_data(0x4241_5345).is_some();
        self.metrics.insert(id, (typo, base));
        (typo, base)
    }

    pub fn shape(&mut self, spec: &FontSpec, letter_spacing: f32, text: &str) -> Rc<Shaped> {
        let key = format!("{}\u{1}{}\u{1}{}", spec.css, letter_spacing, text);
        if let Some(s) = self.cache.get(&key) {
            return s.clone();
        }
        // Canvas text replaces line breaks and tabs with spaces.
        let clean: String = text.chars().map(|c| if matches!(c, '\n' | '\r' | '\t' | '\u{c}') { ' ' } else { c }).collect();
        let primary = self.primary(spec);
        // per-character face: first family with the glyph, else the system's fallback
        let families = spec.families.clone();
        let mut picks: HashMap<char, Typeface> = HashMap::new();
        for c in clean.chars() {
            if picks.contains_key(&c) {
                continue;
            }
            let mut found = None;
            for f in &families {
                if let Some(tf) = self.face(f, spec.weight, spec.italic) {
                    if tf.unichar_to_glyph(c as i32) != 0 {
                        found = Some(tf);
                        break;
                    }
                }
            }
            if found.is_none() && !c.is_whitespace() && !c.is_control() {
                found = self.fallback_face(c, spec.weight, spec.italic);
            }
            if let Some(tf) = found.or_else(|| primary.clone()) {
                picks.insert(c, tf);
            }
        }
        let default = primary.clone().unwrap_or_else(|| self.system.legacy_make_typeface(None, FontStyle::normal()).unwrap());
        let lang = self.lang.clone();
        let (runs, mut width) = shape::shape(
            &clean,
            spec.size,
            &lang,
            |c| picks.get(&c).cloned().unwrap_or_else(|| default.clone()),
            |font| {
                // Chrome on macOS: grayscale AA, subpixel positions, CoreGraphics outline dilation
                // ("smoothing", which Skia allows only with hinting on), baseline snapped to pixels.
                font.set_edging(sk::font::Edging::AntiAlias);
                font.set_subpixel(true);
                font.set_hinting(sk::FontHinting::Normal);
                font.set_baseline_snap(true);
                font.set_linear_metrics(true);
            },
        );
        if std::env::var("MOTION_RENDER_DEBUG").as_deref() == Ok("text") {
            for r in &runs {
                eprintln!("{:?}: {} size={} hint={:?} sub={} snap={} lin={} glyphs={:?} pos={:?}", clean, r.font.typeface().family_name(), r.font.size(), r.font.hinting(), r.font.is_subpixel(), r.font.is_baseline_snap(), r.font.is_linear_metrics(), r.glyphs, r.positions);
            }
        }
        let mut ink = Rect::new_empty();
        let mut builder = TextBlobBuilder::new();
        let mut shift = 0.0f32;
        let mut count = 0usize;
        for run in &runs {
            if run.glyphs.is_empty() {
                continue;
            }
            let (g, p) = builder.alloc_run_pos(&run.font, run.glyphs.len(), None);
            g.copy_from_slice(&run.glyphs);
            for (dst, src) in p.iter_mut().zip(run.positions.iter()) {
                *dst = Point::new(src.x + shift, src.y);
                if letter_spacing != 0.0 {
                    shift += letter_spacing;
                    count += 1;
                }
            }
            // ink bounds from the outlines (unhinted), for measureText's actualBoundingBox
            let mut outline = run.font.clone();
            outline.set_hinting(sk::FontHinting::None);
            let mut bounds = vec![Rect::default(); run.glyphs.len()];
            outline.get_bounds(&run.glyphs, &mut bounds, None);
            for (b, q) in bounds.iter().zip(p.iter()) {
                if !b.is_empty() {
                    ink.join(b.with_offset(*q));
                }
            }
        }
        if letter_spacing != 0.0 {
            width += letter_spacing * count as f32;
        }
        let blob = builder.make();
        let (ascent, descent, typo_ascent, typo_descent, ideographic) = match &primary {
            Some(tf) => {
                let font = Font::from_typeface(tf, spec.size);
                let (_, m) = font.metrics();
                let asc = -m.ascent;
                let desc = m.descent;
                let (typo, base) = self.font_tables(tf);
                // Blink normalises the typo (else hhea) ascent/descent to sum to the em size, in
                // LayoutUnits (1/64 px).
                let (a, d) = match typo {
                    Some((a, d)) => (a * spec.size, d * spec.size),
                    None => (asc, desc),
                };
                let na = (a * spec.size / (a + d) * 64.0).round() / 64.0;
                let nd = spec.size - na;
                // ideographic: the BASE table's em-box bottom when present, else the descent
                (asc, desc, na, nd, if base { nd } else { desc })
            }
            None => (spec.size * 0.8, spec.size * 0.2, spec.size * 0.8, spec.size * 0.2, spec.size * 0.2),
        };
        let shaped = Rc::new(Shaped { blob, width, ink, ascent, descent, typo_ascent, typo_descent, ideographic });
        if self.cache.len() > 4096 {
            self.cache.clear();
        }
        self.cache.insert(key, shaped.clone());
        shaped
    }
}

/// Offset of the alphabetic baseline below the anchor y for each textBaseline (Blink's rules).
pub fn baseline_offset(baseline: u8, s: &Shaped) -> f32 {
    match baseline {
        1 => s.typo_ascent,                          // top: em box top
        2 => s.ascent * 0.8,                         // hanging
        3 => (s.typo_ascent - s.typo_descent) / 2.0, // middle: em box centre
        4 => -s.ideographic,                         // ideographic
        5 => -s.typo_descent,                        // bottom: em box bottom
        _ => 0.0,                                    // alphabetic
    }
}

/// Minimal WOFF 1.0 → SFNT for uncompressed tables (compressed WOFF 1 is reported as a failure).
fn woff1_to_sfnt(b: &[u8]) -> Option<Vec<u8>> {
    let be16 = |o: usize| -> Option<u16> { Some(u16::from_be_bytes([*b.get(o)?, *b.get(o + 1)?])) };
    let be32 = |o: usize| -> Option<u32> { Some(u32::from_be_bytes([*b.get(o)?, *b.get(o + 1)?, *b.get(o + 2)?, *b.get(o + 3)?])) };
    let flavor = be32(4)?;
    let num = be16(12)? as usize;
    let mut tables = Vec::new();
    for i in 0..num {
        let o = 44 + i * 20;
        let (tag, off, comp, orig, csum) = (be32(o)?, be32(o + 4)? as usize, be32(o + 8)? as usize, be32(o + 12)? as usize, be32(o + 16)?);
        if comp < orig {
            return None;
        }
        tables.push((tag, csum, b.get(off..off + comp)?.to_vec()));
    }
    let mut out = Vec::new();
    out.extend_from_slice(&flavor.to_be_bytes());
    out.extend_from_slice(&(num as u16).to_be_bytes());
    let mut es = 0u16;
    while (1usize << (es + 1)) <= num {
        es += 1;
    }
    let sr = (1u16 << es) * 16;
    out.extend_from_slice(&sr.to_be_bytes());
    out.extend_from_slice(&es.to_be_bytes());
    out.extend_from_slice(&((num as u16) * 16 - sr).to_be_bytes());
    let mut body = Vec::new();
    for (tag, csum, data) in &tables {
        out.extend_from_slice(&tag.to_be_bytes());
        out.extend_from_slice(&csum.to_be_bytes());
        out.extend_from_slice(&((12 + 16 * num + body.len()) as u32).to_be_bytes());
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        body.extend_from_slice(data);
        while body.len() % 4 != 0 {
            body.push(0);
        }
    }
    out.extend_from_slice(&body);
    Some(out)
}
