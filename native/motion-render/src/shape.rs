//! Text shaping the way Chrome's canvas does it (Blink's CachingWordShaper + RunSegmenter), with
//! HarfBuzz per segment. It matters for CJK fonts: Noto Sans SC has different digit glyphs under
//! the `latn` script than under `hani`/DFLT, and Skia's paragraph module resolves script-neutral
//! characters (digits, punctuation, spaces) differently from Chrome.
//!
//!   1. Text whose characters all fit in Latin-1 is "8-bit": one Latin run per word.
//!   2. Otherwise text splits into words like Blink's NextWordEndIndex: spaces and tabs are words
//!      of their own; a non-CJK word ends at a space or a CJK character; a CJK word is one CJK
//!      character plus the marks, emoji components (digits included) and CJK symbols after it.
//!   3. In a word, Common/Inherited characters take the script around them (leading ones the first
//!      real script after them); a word with no real script stays Common (HarfBuzz's DFLT).
//!   4. Each character gets a typeface (first family with the glyph, else system fallback);
//!      maximal (word, typeface, script) segments are shaped with HarfBuzz and laid end to end.
//!
//! Chrome also caches shaped words across draws, so a word first drawn in Latin-1 text keeps its
//! Latin shape when it later appears in CJK text. That makes Chrome's pixels depend on what was
//! drawn before; we deliberately do not copy it (every frame stays a function of its time only).
use skia_safe::{
    self as sk,
    shaper::run_handler::{Buffer, RunHandler, RunInfo},
    Font, FourByteTag, GlyphId, Point, Shaper, Typeface,
};
use unicode_script::{Script, UnicodeScript};

pub struct Run {
    pub font: Font,
    pub glyphs: Vec<GlyphId>,
    pub positions: Vec<Point>,
}

#[derive(Default)]
struct Collect {
    runs: Vec<Run>,
    clusters: Vec<Vec<u32>>,
    glyphs: Vec<GlyphId>,
    positions: Vec<Point>,
    cl: Vec<u32>,
    x: f32,
}

impl RunHandler for Collect {
    fn begin_line(&mut self) {}
    fn run_info(&mut self, _info: &RunInfo) {}
    fn commit_run_info(&mut self) {}
    fn run_buffer(&mut self, info: &RunInfo) -> Buffer<'_> {
        self.glyphs = vec![0; info.glyph_count];
        self.positions = vec![Point::default(); info.glyph_count];
        self.cl = vec![0; info.glyph_count];
        Buffer { glyphs: &mut self.glyphs, positions: &mut self.positions, offsets: None, clusters: Some(&mut self.cl), point: Point::new(self.x, 0.0) }
    }
    fn commit_run_buffer(&mut self, info: &RunInfo) {
        self.runs.push(Run { font: info.font.clone(), glyphs: std::mem::take(&mut self.glyphs), positions: std::mem::take(&mut self.positions) });
        self.clusters.push(std::mem::take(&mut self.cl));
        self.x += info.advance.x;
    }
    fn commit_line(&mut self) {}
}

fn iso15924(s: Script) -> FourByteTag {
    let b = s.short_name().as_bytes();
    if b.len() == 4 {
        FourByteTag::from_chars(b[0] as char, b[1] as char, b[2] as char, b[3] as char)
    } else {
        FourByteTag::from_chars('Z', 'y', 'y', 'y')
    }
}

fn is_neutral(s: Script) -> bool {
    matches!(s, Script::Common | Script::Inherited | Script::Unknown)
}

/// A character of `script` put in front of a segment of script-neutral characters so HarfBuzz
/// shapes them with that script (Skia's script iterator would leave them Common); its glyphs are
/// dropped afterwards.
fn script_sample(s: Script) -> Option<char> {
    Some(match s {
        Script::Latin => 'a',
        Script::Han => '一',
        Script::Hiragana => 'あ',
        Script::Katakana => 'ア',
        Script::Hangul => '가',
        Script::Cyrillic => 'а',
        Script::Greek => 'α',
        Script::Arabic => 'ا',
        Script::Hebrew => 'א',
        Script::Thai => 'ก',
        _ => return None,
    })
}

/// Blink's Character::IsCJKIdeographOrSymbol (the ranges that matter for film text).
fn is_cjk(c: char) -> bool {
    let u = c as u32;
    matches!(u,
        0x1100..=0x11FF | 0x2E80..=0x2FDF | 0x2FF0..=0x303F | 0x3040..=0x31EF | 0x3200..=0x33FF |
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xA960..=0xA97F | 0xAC00..=0xD7FF | 0xF900..=0xFAFF |
        0xFE30..=0xFE4F | 0xFF00..=0xFFEF | 0x1F000..=0x1FAFF | 0x20000..=0x3FFFF |
        0x2600..=0x27BF | 0x2B00..=0x2BFF)
}

fn is_emoji_component(c: char) -> bool {
    let u = c as u32;
    c.is_ascii_digit() || c == '#' || c == '*' || matches!(u, 0x200D | 0x20E3 | 0xFE0F | 0x1F1E6..=0x1F1FF | 0x1F3FB..=0x1F3FF | 0x1F9B0..=0x1F9B3 | 0xE0020..=0xE007F)
}

fn is_delimiter(c: char) -> bool {
    c == ' ' || c == '\t'
}

/// Word boundaries (char indices, end-exclusive) as Blink's CachingWordShapeIterator finds them.
fn words(chars: &[char], eight_bit: bool) -> Vec<(usize, usize)> {
    let mut out = vec![];
    let n = chars.len();
    let mut s = 0;
    while s < n {
        let e = if s + 1 == n || is_delimiter(chars[s]) {
            s + 1
        } else if eight_bit {
            (s + 1..n).find(|&i| is_delimiter(chars[i])).unwrap_or(n)
        } else if !is_cjk(chars[s]) {
            (s + 1..n).find(|&i| is_delimiter(chars[i]) || is_cjk(chars[i])).unwrap_or(n)
        } else {
            let mut has_script = !is_neutral(chars[s].script());
            let mut e = n;
            for (i, &c) in chars.iter().enumerate().skip(s + 1) {
                if c.script() == Script::Inherited || is_emoji_component(c) {
                    continue;
                }
                if is_cjk(c) {
                    if is_neutral(c.script()) {
                        continue;
                    }
                    if !has_script {
                        has_script = true;
                        continue;
                    }
                }
                e = i;
                break;
            }
            e
        };
        out.push((s, e));
        s = e;
    }
    out
}

/// Scripts within one word: neutral characters join the script around them; a word with no real
/// script is Common, or Latin in 8-bit text.
fn word_scripts(chars: &[char], eight_bit: bool) -> Vec<Script> {
    if eight_bit {
        return vec![Script::Latin; chars.len()];
    }
    let raw: Vec<Script> = chars.iter().map(|c| c.script()).collect();
    let mut out = raw.clone();
    let mut current: Option<Script> = None;
    let mut pending = 0usize;
    for (i, s) in raw.iter().enumerate() {
        if is_neutral(*s) {
            match current {
                Some(c) => out[i] = c,
                None => pending += 1,
            }
        } else {
            if current.is_none() {
                for o in out.iter_mut().take(pending) {
                    *o = *s;
                }
            }
            current = Some(*s);
        }
    }
    if current.is_none() {
        for o in out.iter_mut() {
            *o = Script::Common;
        }
    }
    out
}

/// Shape `text` with per-character typefaces from `pick`; returns runs (positions relative to the
/// start of the text, on the baseline) and the total advance.
pub fn shape(text: &str, size: f32, lang: &str, mut pick: impl FnMut(char) -> Typeface, tweak: impl Fn(&mut Font)) -> (Vec<Run>, f32) {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return (vec![], 0.0);
    }
    let eight_bit = chars.iter().all(|c| (*c as u32) <= 0xFF);
    // typefaces: combining marks and joiners stay with the previous character
    let mut faces: Vec<Typeface> = Vec::with_capacity(chars.len());
    for (i, c) in chars.iter().enumerate() {
        let joins = i > 0 && (c.script() == Script::Inherited || matches!(*c as u32, 0x200c | 0x200d | 0xfe00..=0xfe0f));
        if joins {
            let prev = faces[i - 1].clone();
            faces.push(prev);
        } else {
            faces.push(pick(*c));
        }
    }
    let byte_of: Vec<usize> = text.char_indices().map(|(b, _)| b).chain(std::iter::once(text.len())).collect();
    let shaper = sk::shapers::hb::shape_dont_wrap_or_reorder(None).unwrap_or_else(sk::shapers::primitive::primitive_text);
    let mut collect = Collect::default();
    for (ws, we) in words(&chars, eight_bit) {
        let scripts = word_scripts(&chars[ws..we], eight_bit);
        let mut start = ws;
        while start < we {
            let script = scripts[start - ws];
            let mut end = start + 1;
            while end < we && scripts[end - ws] == script && faces[end].unique_id() == faces[start].unique_id() {
                end += 1;
            }
            let seg = &text[byte_of[start]..byte_of[end]];
            let mut font = Font::from_typeface(&faces[start], size);
            tweak(&mut font);
            let neutral = chars[start..end].iter().all(|c| is_neutral(c.script()));
            let prefix = if neutral && script != Script::Common { script_sample(script).filter(|c| faces[start].unichar_to_glyph(*c as i32) != 0) } else { None };
            let owned;
            let (shaped_text, skip) = match prefix {
                Some(p) => {
                    owned = format!("{}{}", p, seg);
                    (owned.as_str(), p.len_utf8() as u32)
                }
                None => (seg, 0),
            };
            let first_run = collect.runs.len();
            let start_x = collect.x;
            let mut fi = Shaper::new_trivial_font_run_iterator(&font, shaped_text.len());
            let mut bi = sk::shapers::primitive::trivial_bidi_run_iterator(0, shaped_text.len());
            let mut si = sk::shapers::hb::script_run_iterator(shaped_text, iso15924(script));
            let mut li = Shaper::new_trivial_language_run_iterator(lang, shaped_text.len());
            shaper.shape_with_iterators(shaped_text, &mut fi, &mut bi, &mut si, &mut li, f32::MAX, &mut collect);
            if skip > 0 {
                // drop the lead character's glyphs; the segment starts at its first own glyph
                let mut delta = None;
                for (run, cl) in collect.runs[first_run..].iter_mut().zip(collect.clusters[first_run..].iter()) {
                    let keep: Vec<usize> = (0..run.glyphs.len()).filter(|&i| cl[i] >= skip).collect();
                    if delta.is_none() {
                        if let Some(&k) = keep.first() {
                            delta = Some(run.positions[k].x - start_x);
                        }
                    }
                    run.glyphs = keep.iter().map(|&i| run.glyphs[i]).collect();
                    run.positions = keep.iter().map(|&i| run.positions[i]).collect();
                }
                let d = delta.unwrap_or(collect.x - start_x);
                for run in collect.runs[first_run..].iter_mut() {
                    for p in run.positions.iter_mut() {
                        p.x -= d;
                    }
                }
                collect.x -= d;
            }
            start = end;
        }
    }
    let width = collect.x;
    (collect.runs, width)
}
