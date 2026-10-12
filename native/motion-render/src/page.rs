//! What a renderer instance loads: a page (scripts in document order, the elements scripts look
//! up, @font-face rules), read from an HTML file or synthesised from an engine job.
use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Element {
    pub tag: String,
    pub id: String,
    pub attrs: Vec<(String, String)>,
    pub text: String,
}

#[derive(Clone, Debug)]
pub struct Script {
    pub name: String,
    pub code: String,
}

#[derive(Clone, Debug)]
pub enum FontSource {
    File(PathBuf),
    Bytes(&'static [u8]),
}

#[derive(Clone, Debug)]
pub struct FontFace {
    pub family: String,
    pub source: FontSource,
}

#[derive(Clone, Debug)]
pub struct Page {
    pub base: PathBuf,
    pub elements: Vec<Element>,
    pub scripts: Vec<Script>,
    pub fonts: Vec<FontFace>,
    /// the document language (<html lang>, or the job's language)
    pub lang: String,
    /// the page background the canvas is composited over in Chrome's screenshot (motion-use's
    /// film page: #151515; an overlay layer: transparent = None)
    pub background: Option<[u8; 3]>,
}

impl Page {
    pub fn elements_json(&self) -> String {
        let v: Vec<Value> = self
            .elements
            .iter()
            .map(|e| {
                let attrs: serde_json::Map<String, Value> = e.attrs.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect();
                json!({"tag": e.tag, "id": e.id, "attrs": attrs, "text": e.text})
            })
            .collect();
        serde_json::to_string(&v).unwrap()
    }
}

fn parse_attrs(s: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b'/') {
            i += 1;
        }
        let start = i;
        while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'=' && b[i] != b'>' && b[i] != b'/' {
            i += 1;
        }
        if start == i {
            i += 1;
            continue;
        }
        let name = s[start..i].to_ascii_lowercase();
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut value = String::new();
        if i < b.len() && b[i] == b'=' {
            i += 1;
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < b.len() && (b[i] == b'"' || b[i] == b'\'') {
                let q = b[i];
                i += 1;
                let vs = i;
                while i < b.len() && b[i] != q {
                    i += 1;
                }
                value = s[vs..i.min(b.len())].to_string();
                i += 1;
            } else {
                let vs = i;
                while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'>' {
                    i += 1;
                }
                value = s[vs..i].to_string();
            }
        }
        out.push((name, decode_entities(&value)));
    }
    out
}

fn decode_entities(s: &str) -> String {
    s.replace("&quot;", "\"").replace("&#39;", "'").replace("&apos;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

fn find_ci(hay: &str, needle: &str, from: usize) -> Option<usize> {
    hay[from..].to_ascii_lowercase().find(needle).map(|i| i + from)
}

fn url_in(s: &str) -> Option<String> {
    let i = s.find("url(")?;
    let rest = &s[i + 4..];
    let j = rest.find(')')?;
    Some(rest[..j].trim().trim_matches(|c| c == '"' || c == '\'').to_string())
}

/// @font-face rules in a stylesheet: family and the first url() of src.
fn font_faces(css: &str, base: &Path) -> Vec<FontFace> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(i) = find_ci(css, "@font-face", from) {
        let Some(open) = css[i..].find('{').map(|o| o + i) else { break };
        let Some(close) = css[open..].find('}').map(|c| c + open) else { break };
        let body = &css[open + 1..close];
        let mut family = None;
        let mut src = None;
        for decl in body.split(';') {
            let Some((k, v)) = decl.split_once(':') else { continue };
            match k.trim().to_ascii_lowercase().as_str() {
                "font-family" => family = Some(v.trim().trim_matches(|c| c == '"' || c == '\'').to_string()),
                "src" => src = url_in(v),
                _ => {}
            }
        }
        if let (Some(f), Some(s)) = (family, src) {
            if !s.starts_with("data:") {
                out.push(FontFace { family: f, source: FontSource::File(base.join(s)) });
            }
        }
        from = close + 1;
    }
    out
}

/// `html,body{...background:#rrggbb...}` → Some(Some(rgb)); `transparent` → Some(None).
fn body_background(css: &str) -> Option<Option<[u8; 3]>> {
    let lower = css.to_ascii_lowercase();
    let at = lower.find("body")?;
    let rule = &lower[at..];
    let open = rule.find('{')?;
    let close = rule[open..].find('}')? + open;
    for decl in rule[open + 1..close].split(';') {
        let Some((k, v)) = decl.split_once(':') else { continue };
        if k.trim() == "background" || k.trim() == "background-color" {
            let v = v.trim();
            if v == "transparent" {
                return Some(None);
            }
            let c = csscolorparser::parse(v).ok()?.to_rgba8();
            return Some(if c[3] == 255 { Some([c[0], c[1], c[2]]) } else { None });
        }
    }
    None
}

/// Read an HTML page: scripts in order (inline and src), canvases and other id'd elements,
/// JSON script blocks (as elements with text), @font-face rules from <style>.
pub fn load_html(path: &Path) -> Result<Page> {
    let html = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let base = path.parent().unwrap_or(Path::new(".")).to_path_buf();
    let mut page = Page { base: base.clone(), elements: vec![], scripts: vec![], fonts: vec![], lang: "en".into(), background: None };
    let lower = html.to_ascii_lowercase();
    let mut i = 0;
    while let Some(lt) = lower[i..].find('<').map(|p| p + i) {
        if lower[lt..].starts_with("<!--") {
            i = lower[lt..].find("-->").map(|p| p + lt + 3).unwrap_or(lower.len());
            continue;
        }
        let Some(gt) = lower[lt..].find('>').map(|p| p + lt) else { break };
        let tag_src = &html[lt + 1..gt];
        let name_end = tag_src.find(|c: char| c.is_ascii_whitespace() || c == '/').unwrap_or(tag_src.len());
        let tag = tag_src[..name_end].to_ascii_lowercase();
        let attrs = parse_attrs(&tag_src[name_end..]);
        let get = |k: &str| attrs.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        i = gt + 1;
        match tag.as_str() {
            "html" => {
                if let Some(l) = get("lang") {
                    page.lang = l;
                }
            }
            "script" => {
                let end = lower[i..].find("</script").map(|p| p + i).unwrap_or(lower.len());
                let body = html[i..end].to_string();
                i = lower[end..].find('>').map(|p| p + end + 1).unwrap_or(lower.len());
                let ty = get("type").unwrap_or_default().to_ascii_lowercase();
                if let Some(src) = get("src") {
                    let file = base.join(&src);
                    let code = std::fs::read_to_string(&file).with_context(|| format!("script {}", file.display()))?;
                    page.scripts.push(Script { name: file.display().to_string(), code });
                } else if ty.is_empty() || ty.contains("javascript") || ty == "module" {
                    if ty == "module" {
                        return Err(anyhow!("{}: <script type=\"module\"> is not supported; bundle it into a classic script", path.display()));
                    }
                    page.scripts.push(Script { name: format!("{}#inline{}", path.display(), page.scripts.len()), code: body });
                } else {
                    page.elements.push(Element { tag: "script".into(), id: get("id").unwrap_or_default(), attrs: attrs.clone(), text: body });
                }
            }
            "style" => {
                let end = lower[i..].find("</style").map(|p| p + i).unwrap_or(lower.len());
                page.fonts.extend(font_faces(&html[i..end], &base));
                if let Some(bg) = body_background(&html[i..end]) {
                    page.background = bg;
                }
                i = end;
            }
            "canvas" | "img" | "div" | "audio" | "video" | "span" | "p" | "section" | "main" => {
                page.elements.push(Element { tag: tag.clone(), id: get("id").unwrap_or_default(), attrs: attrs.clone(), text: String::new() });
            }
            _ => {}
        }
    }
    Ok(page)
}

/// The film runtime and drawing kit this binary was built with (motion-use's own files).
pub const RUNTIME_JS: &str = include_str!("../../../src/film-runtime.js");
pub const KIT_JS: &str = include_str!("../../../src/film-kit.js");
#[cfg(feature = "embed-fonts")]
pub const SANS_TTF: &[u8] = include_bytes!("../../../assets/fonts/NotoSansSC[wght].ttf");
#[cfg(feature = "embed-fonts")]
pub const MONO_TTF: &[u8] = include_bytes!("../../../assets/fonts/JetBrainsMono[wght].ttf");

/// Film Sans / Film Mono for a synthesised page: motion-use's fonts folder when we can find it
/// (MOTION_USE_ROOT, or next to this binary in a checkout), else the copies built into the binary.
fn bundled_fonts() -> Result<Vec<FontFace>> {
    let mut roots: Vec<PathBuf> = vec![];
    if let Ok(r) = std::env::var("MOTION_USE_ROOT") {
        roots.push(PathBuf::from(r));
    }
    if let Ok(exe) = std::env::current_exe() {
        for a in exe.ancestors().skip(1).take(6) {
            roots.push(a.to_path_buf());
        }
    }
    for r in roots {
        let sans = r.join("assets/fonts/NotoSansSC[wght].ttf");
        let mono = r.join("assets/fonts/JetBrainsMono[wght].ttf");
        if sans.exists() && mono.exists() {
            return Ok(vec![
                FontFace { family: "Film Sans".into(), source: FontSource::File(sans) },
                FontFace { family: "Film Mono".into(), source: FontSource::File(mono) },
            ]);
        }
    }
    #[cfg(feature = "embed-fonts")]
    {
        return Ok(vec![
            FontFace { family: "Film Sans".into(), source: FontSource::Bytes(SANS_TTF) },
            FontFace { family: "Film Mono".into(), source: FontSource::Bytes(MONO_TTF) },
        ]);
    }
    #[allow(unreachable_code)]
    Err(anyhow!("cannot find motion-use's fonts: set MOTION_USE_ROOT to the motion-use folder"))
}

/// A film page for the external-engine job contract: the config motion-use's buildFilm would
/// write, from the job (this language/format's copy, captions, assets) and film.json (libraries,
/// motion blur), drawing code from `draw`.
pub fn from_job(job: &Value, draw: &Path) -> Result<Page> {
    let film = &job["film"];
    let dir = PathBuf::from(film["dir"].as_str().ok_or_else(|| anyhow!("job.film.dir missing"))?);
    let film_json: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("film.json")).context("reading film.json")?)?;
    let w = job["width"].as_i64().ok_or_else(|| anyhow!("job.width missing"))?;
    let h = job["height"].as_i64().ok_or_else(|| anyhow!("job.height missing"))?;
    if film_json.get("videos").map(|v| v.as_object().map(|o| !o.is_empty()).unwrap_or(false)).unwrap_or(false) {
        return Err(anyhow!("film.json declares videos: footage is not supported by motion-render's job mode yet (render the page motion-use builds instead)"));
    }
    let config = json!({
        "captions": film["captions"],
        "name": film["name"],
        "duration": film["duration"],
        "fps": film["fps"],
        "bpm": film["bpm"],
        "lang": job["lang"],
        "format": job["format"],
        "copy": film["copy"],
        "shots": film["shots"],
        "motionBlur": film_json.get("motionBlur").cloned().unwrap_or(json!({"samples": 1, "shutter": 0})),
        "look": film["look"],
        "data": film["data"],
        "offset": 0,
        "guides": false,
        "videos": {},
        "assets": film.get("assets").cloned().unwrap_or(json!({})),
        "files": film.get("files").cloned().unwrap_or(json!({})),
        "overlay": false,
    });
    let mut scripts = vec![];
    if let Some(libs) = film_json.get("libraries").and_then(|l| l.as_array()) {
        for l in libs {
            let f = dir.join(l.as_str().unwrap_or_default());
            scripts.push(Script { name: f.display().to_string(), code: std::fs::read_to_string(&f).with_context(|| format!("library {}", f.display()))? });
        }
    }
    scripts.push(Script { name: "kit.js".into(), code: KIT_JS.into() });
    let draw = if draw.is_absolute() { draw.to_path_buf() } else { dir.join(draw) };
    scripts.push(Script { name: draw.display().to_string(), code: std::fs::read_to_string(&draw).with_context(|| format!("drawing {}", draw.display()))? });
    scripts.push(Script { name: "runtime.js".into(), code: RUNTIME_JS.into() });
    Ok(Page {
        base: dir,
        elements: vec![
            Element { tag: "canvas".into(), id: "film-canvas".into(), attrs: vec![("id".into(), "film-canvas".into()), ("width".into(), w.to_string()), ("height".into(), h.to_string())], text: String::new() },
            Element { tag: "script".into(), id: "film-config".into(), attrs: vec![("id".into(), "film-config".into()), ("type".into(), "application/json".into())], text: config.to_string() },
        ],
        scripts,
        fonts: bundled_fonts()?,
        lang: job["lang"].as_str().unwrap_or("en").to_string(),
        background: Some([0x15, 0x15, 0x15]),
    })
}
