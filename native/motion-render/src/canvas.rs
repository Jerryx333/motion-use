// gradient_shader is deprecated in skia-safe in favour of the gradient module; same Skia calls.
#![allow(deprecated)]
//! The Canvas 2D API over Skia (CPU raster). Semantics follow the HTML spec and Blink where they
//! differ in detail: the current path lives in the user space of the current transform (Blink
//! transforms it by the inverse of every transform change), shadows and filters are evaluated in
//! device pixels through a layer, unbounded composite operations go through a clip-sized layer.
use crate::style;
use crate::text::{self, FontSpec, Fonts};
use skia_safe::{
    self as sk, canvas::SaveLayerRec, gradient_shader, image_filters, paint::Cap, paint::Join, surfaces, AlphaType,
    BlendMode, ClipOp, Color, Color4f, ColorType, CubicResampler, FilterMode, ImageFilter, ImageInfo, Matrix,
    MipmapMode, Paint, PaintStyle, Path, PathBuilder, PathFillType, RRect, Rect, SamplingOptions, Surface,
    TileMode, Vector, M44,
};
use std::path::PathBuf;
use std::rc::Rc;

#[derive(Clone)]
pub enum Fill {
    Color(Color),
    Gradient(usize),
    Pattern(usize),
}

pub enum GradKind {
    Linear(f32, f32, f32, f32),
    Radial(f32, f32, f32, f32, f32, f32),
    Conic(f32, f32, f32),
}

pub struct Gradient {
    pub kind: GradKind,
    pub stops: Vec<(f32, Color)>,
}

#[derive(Clone)]
pub enum ImageSrc {
    Raster(sk::Image),
    Picture(sk::Picture, f32, f32),
}

impl ImageSrc {
    pub fn size(&self) -> (f32, f32) {
        match self {
            ImageSrc::Raster(i) => (i.width() as f32, i.height() as f32),
            ImageSrc::Picture(_, w, h) => (*w, *h),
        }
    }
}

pub struct Pattern {
    pub image: ImageSrc,
    pub rep: u8,
    pub matrix: Matrix,
}

#[derive(Clone)]
pub struct State {
    pub matrix: Matrix,
    pub fill: Fill,
    pub stroke: Fill,
    pub alpha: f32,
    pub blend: BlendMode,
    pub unbounded: bool,
    pub line_width: f32,
    pub cap: Cap,
    pub join: Join,
    pub miter: f32,
    pub dash: Vec<f32>,
    pub dash_offset: f32,
    pub shadow_blur: f32,
    pub shadow_color: Color,
    pub shadow_dx: f32,
    pub shadow_dy: f32,
    pub filter: Option<ImageFilter>,
    pub font: Rc<FontSpec>,
    pub align: u8,
    pub baseline: u8,
    pub smoothing: bool,
    pub quality: u8,
    pub letter_spacing: f32,
}

impl Default for State {
    fn default() -> Self {
        State {
            matrix: Matrix::new_identity(),
            fill: Fill::Color(Color::BLACK),
            stroke: Fill::Color(Color::BLACK),
            alpha: 1.0,
            blend: BlendMode::SrcOver,
            unbounded: false,
            line_width: 1.0,
            cap: Cap::Butt,
            join: Join::Miter,
            miter: 10.0,
            dash: vec![],
            dash_offset: 0.0,
            shadow_blur: 0.0,
            shadow_color: Color::TRANSPARENT,
            shadow_dx: 0.0,
            shadow_dy: 0.0,
            filter: None,
            font: Rc::new(FontSpec::default()),
            align: 0,
            baseline: 0,
            smoothing: true,
            quality: 0,
            letter_spacing: 0.0,
        }
    }
}

pub struct Canvas2D {
    pub surface: Option<Surface>,
    pub w: i32,
    pub h: i32,
    pub state: State,
    pub stack: Vec<State>,
    pub path: usize,
}

fn new_surface(w: i32, h: i32) -> Option<Surface> {
    if w <= 0 || h <= 0 || w > 16384 || h > 16384 {
        return None;
    }
    // Legacy (untagged) sRGB like Chrome's 2D canvas: blending happens on the encoded values.
    let info = ImageInfo::new((w, h), ColorType::N32, AlphaType::Premul, None);
    surfaces::raster(&info, None, None)
}

pub struct Runtime {
    pub canvases: Vec<Canvas2D>,
    pub paths: Vec<PathBuilder>,
    pub gradients: Vec<Gradient>,
    pub patterns: Vec<Pattern>,
    pub images: Vec<Option<ImageSrc>>,
    pub fonts: Fonts,
    pub base: PathBuf,
}

/// Blink's angle canonicalisation for arc/ellipse.
fn arc_sweep(start: f64, end: f64, ccw: bool) -> (f64, f64) {
    let tau = std::f64::consts::TAU;
    let mut s = start % tau;
    if s < 0.0 {
        s += tau;
    }
    let mut e = end + (s - start);
    if !ccw && e - s >= tau {
        e = s + tau;
    } else if ccw && s - e >= tau {
        e = s - tau;
    } else if !ccw && s > e {
        e = s + (tau - ((s - e) % tau));
    } else if ccw && s < e {
        e = s - (tau - ((e - s) % tau));
    }
    (s, e - s)
}

fn add_arc(pb: &mut PathBuilder, oval: Rect, start: f64, sweep: f64) {
    let sd = start.to_degrees() as f32;
    let wd = sweep.to_degrees() as f32;
    if wd.abs() >= 359.999 {
        // Skia treats a 360° arcTo as a no-op sweep; draw it as two halves.
        let half = wd / 2.0;
        pb.arc_to(oval, sd, half, false);
        pb.arc_to(oval, sd + half, half, false);
    } else {
        pb.arc_to(oval, sd, wd, false);
    }
}

fn sampling(smoothing: bool, quality: u8) -> SamplingOptions {
    if !smoothing {
        return SamplingOptions::new(FilterMode::Nearest, MipmapMode::None);
    }
    match quality {
        0 => SamplingOptions::new(FilterMode::Linear, MipmapMode::None),
        1 => SamplingOptions::new(FilterMode::Linear, MipmapMode::Linear),
        _ => SamplingOptions::from(CubicResampler::mitchell()),
    }
}

impl Runtime {
    pub fn new(base: PathBuf) -> Self {
        Runtime { canvases: vec![], paths: vec![], gradients: vec![], patterns: vec![], images: vec![], fonts: Fonts::new(), base }
    }

    // ------------------------------------------------------------ canvases
    pub fn canvas_new(&mut self, w: i32, h: i32) -> usize {
        let path = self.path_new();
        self.canvases.push(Canvas2D { surface: new_surface(w, h), w, h, state: State::default(), stack: vec![], path });
        self.canvases.len() - 1
    }

    pub fn canvas_resize(&mut self, id: usize, w: i32, h: i32) {
        let path = self.canvases[id].path;
        self.paths[path] = PathBuilder::new();
        let c = &mut self.canvases[id];
        c.surface = new_surface(w, h);
        c.w = w;
        c.h = h;
        c.state = State::default();
        c.stack.clear();
    }

    pub fn reset_ctx(&mut self, id: usize) {
        let (w, h) = (self.canvases[id].w, self.canvases[id].h);
        self.canvas_resize(id, w, h);
    }

    pub fn path_new(&mut self) -> usize {
        self.paths.push(PathBuilder::new());
        self.paths.len() - 1
    }

    // ------------------------------------------------------------ state
    pub fn save(&mut self, id: usize) {
        let c = &mut self.canvases[id];
        if let Some(s) = c.surface.as_mut() {
            s.canvas().save();
        }
        c.stack.push(c.state.clone());
    }

    pub fn restore(&mut self, id: usize) {
        let c = &mut self.canvases[id];
        let Some(prev) = c.stack.pop() else { return };
        if let Some(s) = c.surface.as_mut() {
            s.canvas().restore();
        }
        let old = c.state.matrix;
        c.state = prev;
        let new = c.state.matrix;
        let p = c.path;
        Self::retransform(&mut self.paths[p], &old, &new);
    }

    /// Keep the current path where it was on screen when the transform changes from `old` to `new`.
    fn retransform(pb: &mut PathBuilder, old: &Matrix, new: &Matrix) {
        if old == new || pb.count_points() == 0 {
            return;
        }
        if let Some(inv) = new.invert() {
            let m = Matrix::concat(&inv, old);
            pb.transform(&m);
        }
    }

    pub fn set_matrix(&mut self, id: usize, m: Matrix) {
        let c = &mut self.canvases[id];
        let old = c.state.matrix;
        c.state.matrix = m;
        if let Some(s) = c.surface.as_mut() {
            s.canvas().set_matrix(&M44::from(m));
        }
        let p = c.path;
        Self::retransform(&mut self.paths[p], &old, &m);
    }

    pub fn transform(&mut self, id: usize, m: Matrix) {
        let cur = self.canvases[id].state.matrix;
        self.set_matrix(id, Matrix::concat(&cur, &m));
    }

    // ------------------------------------------------------------ path building
    pub fn move_to(&mut self, p: usize, x: f32, y: f32) {
        if x.is_finite() && y.is_finite() {
            self.paths[p].move_to((x, y));
        }
    }
    fn ensure(pb: &mut PathBuilder, x: f32, y: f32) {
        if pb.count_points() == 0 {
            pb.move_to((x, y));
        }
    }
    pub fn line_to(&mut self, p: usize, x: f32, y: f32) {
        if !(x.is_finite() && y.is_finite()) {
            return;
        }
        let pb = &mut self.paths[p];
        if pb.count_points() == 0 {
            pb.move_to((x, y));
        } else {
            pb.line_to((x, y));
        }
    }
    pub fn quad_to(&mut self, p: usize, cx: f32, cy: f32, x: f32, y: f32) {
        if ![cx, cy, x, y].iter().all(|v| v.is_finite()) {
            return;
        }
        let pb = &mut self.paths[p];
        Self::ensure(pb, cx, cy);
        pb.quad_to((cx, cy), (x, y));
    }
    pub fn bezier_to(&mut self, p: usize, a: [f32; 6]) {
        if !a.iter().all(|v| v.is_finite()) {
            return;
        }
        let pb = &mut self.paths[p];
        Self::ensure(pb, a[0], a[1]);
        pb.cubic_to((a[0], a[1]), (a[2], a[3]), (a[4], a[5]));
    }
    pub fn close_path(&mut self, p: usize) {
        if self.paths[p].count_points() > 0 {
            self.paths[p].close();
        }
    }
    pub fn arc_to(&mut self, p: usize, x1: f32, y1: f32, x2: f32, y2: f32, r: f32) {
        if ![x1, y1, x2, y2, r].iter().all(|v| v.is_finite()) {
            return;
        }
        let pb = &mut self.paths[p];
        Self::ensure(pb, x1, y1);
        if r == 0.0 {
            pb.line_to((x1, y1));
        } else {
            pb.arc_to_tangent((x1, y1), (x2, y2), r);
        }
    }
    pub fn ellipse(&mut self, p: usize, x: f64, y: f64, rx: f64, ry: f64, rot: f64, a0: f64, a1: f64, ccw: bool) {
        if ![x, y, rx, ry, rot, a0, a1].iter().all(|v| v.is_finite()) {
            return;
        }
        let (start, sweep) = arc_sweep(a0, a1, ccw);
        let pb = &mut self.paths[p];
        if rx == 0.0 || ry == 0.0 {
            // A degenerate ellipse is the line along its arc's chord points.
            let px = |a: f64| (x + rx * a.cos() * rot.cos() - ry * a.sin() * rot.sin(), y + rx * a.cos() * rot.sin() + ry * a.sin() * rot.cos());
            let (sx, sy) = px(start);
            if pb.count_points() == 0 {
                pb.move_to((sx as f32, sy as f32));
            } else {
                pb.line_to((sx as f32, sy as f32));
            }
            let (ex, ey) = px(start + sweep);
            pb.line_to((ex as f32, ey as f32));
            return;
        }
        if rot == 0.0 {
            let oval = Rect::new((x - rx) as f32, (y - ry) as f32, (x + rx) as f32, (y + ry) as f32);
            add_arc(pb, oval, start, sweep);
        } else {
            let mut tmp = PathBuilder::new();
            let oval = Rect::new(-rx as f32, -ry as f32, rx as f32, ry as f32);
            add_arc(&mut tmp, oval, start, sweep);
            let mut m = Matrix::translate((x as f32, y as f32));
            m.pre_rotate(rot.to_degrees() as f32, None);
            let path = tmp.snapshot();
            let mode = if pb.count_points() == 0 { sk::path::AddPathMode::Append } else { sk::path::AddPathMode::Extend };
            pb.add_path_with_transform(&path, &m, mode);
        }
    }
    pub fn rect(&mut self, p: usize, x: f32, y: f32, w: f32, h: f32) {
        if ![x, y, w, h].iter().all(|v| v.is_finite()) {
            return;
        }
        let pb = &mut self.paths[p];
        pb.move_to((x, y));
        pb.line_to((x + w, y));
        pb.line_to((x + w, y + h));
        pb.line_to((x, y + h));
        pb.close();
        pb.move_to((x, y));
    }
    pub fn round_rect(&mut self, p: usize, x: f32, y: f32, w: f32, h: f32, r: [f32; 8]) {
        if ![x, y, w, h].iter().all(|v| v.is_finite()) || !r.iter().all(|v| v.is_finite()) {
            return;
        }
        // Negative sizes mirror the radii (spec), then the rect is normalised.
        let mut rr = [(r[0], r[1]), (r[2], r[3]), (r[4], r[5]), (r[6], r[7])]; // tl tr br bl
        let (mut x, mut y, mut w, mut h) = (x, y, w, h);
        if w < 0.0 {
            rr = [rr[1], rr[0], rr[3], rr[2]];
            x += w;
            w = -w;
        }
        if h < 0.0 {
            rr = [rr[3], rr[2], rr[1], rr[0]];
            y += h;
            h = -h;
        }
        let rect = Rect::from_xywh(x, y, w, h);
        let radii = [Vector::new(rr[0].0, rr[0].1), Vector::new(rr[1].0, rr[1].1), Vector::new(rr[2].0, rr[2].1), Vector::new(rr[3].0, rr[3].1)];
        let rrect = RRect::new_rect_radii(rect, &radii);
        let pb = &mut self.paths[p];
        pb.add_rrect(rrect, None, None);
        pb.move_to((x, y));
    }

    // ------------------------------------------------------------ paints
    fn shader_for(&self, fill: &Fill) -> Result<Option<sk::Shader>, ()> {
        match fill {
            Fill::Color(_) => Ok(None),
            Fill::Gradient(g) => {
                let g = &self.gradients[*g];
                if g.stops.is_empty() {
                    return Err(());
                }
                let colors: Vec<Color> = g.stops.iter().map(|s| s.1).collect();
                let pos: Vec<f32> = g.stops.iter().map(|s| s.0).collect();
                if colors.len() == 1 {
                    return Ok(Some(sk::shaders::color(colors[0])));
                }
                let shader = match g.kind {
                    GradKind::Linear(x0, y0, x1, y1) => {
                        if x0 == x1 && y0 == y1 {
                            return Err(());
                        }
                        gradient_shader::linear(((x0, y0), (x1, y1)), &colors[..], &pos[..], TileMode::Clamp, None, None)
                    }
                    GradKind::Radial(x0, y0, r0, x1, y1, r1) => {
                        if x0 == x1 && y0 == y1 && r0 == r1 {
                            return Err(());
                        }
                        gradient_shader::two_point_conical((x0, y0), r0, (x1, y1), r1, &colors[..], &pos[..], TileMode::Clamp, None, None)
                    }
                    GradKind::Conic(x, y, angle) => {
                        let m = Matrix::rotate_deg_pivot(angle.to_degrees(), (x, y));
                        gradient_shader::sweep((x, y), &colors[..], &pos[..], TileMode::Clamp, None, None, &m)
                    }
                };
                Ok(shader)
            }
            Fill::Pattern(p) => {
                let p = &self.patterns[*p];
                let (tx, ty) = match p.rep {
                    1 => (TileMode::Repeat, TileMode::Decal),
                    2 => (TileMode::Decal, TileMode::Repeat),
                    3 => (TileMode::Decal, TileMode::Decal),
                    _ => (TileMode::Repeat, TileMode::Repeat),
                };
                Ok(match &p.image {
                    ImageSrc::Raster(img) => img.to_shader((tx, ty), sampling(true, 0), &p.matrix),
                    ImageSrc::Picture(pic, w, h) => {
                        let r = Rect::from_wh(*w, *h);
                        Some(pic.to_shader((tx, ty), FilterMode::Linear, &p.matrix, &r))
                    }
                })
            }
        }
    }

    /// The paint for a fill or stroke style with globalAlpha; None means "draw nothing".
    fn paint_for(&self, id: usize, stroke: bool) -> Option<Paint> {
        let st = &self.canvases[id].state;
        let fill = if stroke { &st.stroke } else { &st.fill };
        let mut paint = Paint::default();
        paint.set_anti_alias(true);
        match fill {
            Fill::Color(c) => {
                let c4 = Color4f::from(*c);
                paint.set_color4f(Color4f::new(c4.r, c4.g, c4.b, c4.a * st.alpha), None);
            }
            _ => {
                let shader = self.shader_for(fill).ok()?;
                paint.set_shader(shader);
                // Chrome dithers gradients (and other shaders) in 2D canvas.
                paint.set_dither(true);
                paint.set_alpha_f(st.alpha);
            }
        }
        if stroke {
            paint.set_style(PaintStyle::Stroke);
            paint.set_stroke_width(st.line_width);
            paint.set_stroke_cap(st.cap);
            paint.set_stroke_join(st.join);
            paint.set_stroke_miter(st.miter);
            if !st.dash.is_empty() && st.dash.iter().any(|v| *v > 0.0) {
                paint.set_path_effect(sk::PathEffect::dash(&st.dash, st.dash_offset));
            }
        }
        Some(paint)
    }

    /// Draw through shadow / filter / unbounded-composite layers as needed. `bounds` is the local
    /// bounds of what `f` draws (used to size the layer), None for "everything".
    fn draw_with(&mut self, id: usize, mut paint: Paint, bounds: Option<Rect>, f: impl Fn(&sk::Canvas, &Paint)) {
        let c = &mut self.canvases[id];
        let st = &c.state;
        let Some(surface) = c.surface.as_mut() else { return };
        let canvas = surface.canvas();
        let shadow = st.shadow_color.a() > 0 && (st.shadow_blur > 0.0 || st.shadow_dx != 0.0 || st.shadow_dy != 0.0);
        if !shadow && st.filter.is_none() && !st.unbounded {
            paint.set_blend_mode(st.blend);
            f(canvas, &paint);
            return;
        }
        let mut filter = st.filter.clone();
        if shadow {
            let sigma = st.shadow_blur / 2.0;
            filter = image_filters::drop_shadow((st.shadow_dx, st.shadow_dy), (sigma, sigma), Color4f::from(st.shadow_color), None, filter, None);
        }
        let mut lp = Paint::default();
        lp.set_blend_mode(st.blend);
        if let Some(f) = filter {
            lp.set_image_filter(f);
        }
        let device_bounds = if st.unbounded {
            None
        } else {
            bounds.map(|b| {
                let mut r = st.matrix.map_rect(b).0;
                r.outset((2.0, 2.0));
                r
            })
        };
        canvas.save();
        canvas.reset_matrix();
        let mut rec = SaveLayerRec::default().paint(&lp);
        if let Some(b) = device_bounds.as_ref() {
            rec = rec.bounds(b);
        }
        canvas.save_layer(&rec);
        canvas.set_matrix(&M44::from(st.matrix));
        paint.set_blend_mode(BlendMode::SrcOver);
        f(canvas, &paint);
        canvas.restore();
        canvas.restore();
    }

    fn path_with_rule(&self, p: usize, evenodd: bool) -> Path {
        let mut path = self.paths[p].snapshot();
        path.set_fill_type(if evenodd { PathFillType::EvenOdd } else { PathFillType::Winding });
        path
    }

    pub fn fill(&mut self, id: usize, p: usize, evenodd: bool) {
        let Some(paint) = self.paint_for(id, false) else { return };
        let path = self.path_with_rule(p, evenodd);
        let b = path.bounds().to_owned();
        self.draw_with(id, paint, Some(b), |c, paint| {
            c.draw_path(&path, paint);
        });
    }

    fn stroke_bounds(&self, id: usize, b: Rect) -> Rect {
        let st = &self.canvases[id].state;
        let mut out = b;
        let w = st.line_width * if st.join == Join::Miter { st.miter.max(1.0) } else { 1.0 } + 2.0;
        out.outset((w, w));
        out
    }

    pub fn stroke(&mut self, id: usize, p: usize) {
        let Some(paint) = self.paint_for(id, true) else { return };
        let path = self.paths[p].snapshot();
        let b = self.stroke_bounds(id, path.bounds().to_owned());
        self.draw_with(id, paint, Some(b), |c, paint| {
            c.draw_path(&path, paint);
        });
    }

    pub fn clip(&mut self, id: usize, p: usize, evenodd: bool) {
        let path = self.path_with_rule(p, evenodd);
        if let Some(s) = self.canvases[id].surface.as_mut() {
            s.canvas().clip_path(&path, ClipOp::Intersect, true);
        }
    }

    pub fn is_point_in_path(&self, id: usize, p: usize, x: f32, y: f32, evenodd: bool) -> bool {
        let path = self.path_with_rule(p, evenodd);
        let Some(inv) = self.canvases[id].state.matrix.invert() else { return false };
        let pt = inv.map_point((x, y));
        path.contains(pt)
    }

    pub fn is_point_in_stroke(&self, id: usize, p: usize, x: f32, y: f32) -> bool {
        let Some(paint) = self.paint_for(id, true) else { return false };
        let path = self.paths[p].snapshot();
        let Some(inv) = self.canvases[id].state.matrix.invert() else { return false };
        let pt = inv.map_point((x, y));
        let mut outline = PathBuilder::new();
        sk::path_utils::fill_path_with_paint(&path, &paint, &mut outline, None, None);
        outline.snapshot().contains(pt)
    }

    pub fn fill_rect(&mut self, id: usize, x: f32, y: f32, w: f32, h: f32) {
        if ![x, y, w, h].iter().all(|v| v.is_finite()) || w == 0.0 || h == 0.0 {
            return;
        }
        let Some(paint) = self.paint_for(id, false) else { return };
        let r = Rect::from_xywh(x, y, w, h).sorted();
        self.draw_with(id, paint, Some(r), |c, paint| {
            c.draw_rect(r, paint);
        });
    }

    pub fn stroke_rect(&mut self, id: usize, x: f32, y: f32, w: f32, h: f32) {
        if ![x, y, w, h].iter().all(|v| v.is_finite()) {
            return;
        }
        let Some(paint) = self.paint_for(id, true) else { return };
        let mut pb = PathBuilder::new();
        if w == 0.0 || h == 0.0 {
            pb.move_to((x, y));
            pb.line_to((x + w, y + h));
        } else {
            pb.move_to((x, y));
            pb.line_to((x + w, y));
            pb.line_to((x + w, y + h));
            pb.line_to((x, y + h));
            pb.close();
        }
        let path = pb.snapshot();
        let b = self.stroke_bounds(id, path.bounds().to_owned());
        self.draw_with(id, paint, Some(b), |c, paint| {
            c.draw_path(&path, paint);
        });
    }

    pub fn clear_rect(&mut self, id: usize, x: f32, y: f32, w: f32, h: f32) {
        if ![x, y, w, h].iter().all(|v| v.is_finite()) {
            return;
        }
        let c = &mut self.canvases[id];
        let Some(s) = c.surface.as_mut() else { return };
        let mut p = Paint::default();
        p.set_blend_mode(BlendMode::Clear);
        p.set_anti_alias(true);
        // A full-canvas clear under the identity is the common case: skip AA work.
        s.canvas().draw_rect(Rect::from_xywh(x, y, w, h).sorted(), &p);
    }

    // ------------------------------------------------------------ text
    pub fn draw_text(&mut self, id: usize, s: &str, x: f32, y: f32, max_width: f32, stroke: bool) {
        if !x.is_finite() || !y.is_finite() || max_width.is_nan() || max_width <= 0.0 {
            return;
        }
        let (spec, ls, align, baseline) = {
            let st = &self.canvases[id].state;
            (st.font.clone(), st.letter_spacing, st.align, st.baseline)
        };
        let shaped = self.fonts.shape(&spec, ls, s);
        let Some(blob) = shaped.blob.clone() else { return };
        let Some(paint) = self.paint_for(id, stroke) else { return };
        let w = shaped.width;
        // start/end are left/right for ltr text
        let dx = match align {
            1 | 3 => -w,
            4 => -w / 2.0,
            _ => 0.0,
        };
        let by = y + text::baseline_offset(baseline, &shaped);
        let scale = if max_width.is_finite() && w > max_width && w > 0.0 { max_width / w } else { 1.0 };
        let mut bounds = shaped.ink;
        if stroke {
            let lw = self.canvases[id].state.line_width;
            bounds.outset((lw * 2.0, lw * 2.0));
        }
        let local = Rect::new(x + (dx + bounds.left) * scale, by + bounds.top, x + (dx + bounds.right) * scale, by + bounds.bottom);
        self.draw_with(id, paint, Some(local), |c, paint| {
            if scale != 1.0 {
                c.save();
                c.translate((x, by));
                c.scale((scale, 1.0));
                c.draw_text_blob(&blob, (dx, 0.0), paint);
                c.restore();
            } else {
                c.draw_text_blob(&blob, (x + dx, by), paint);
            }
        });
    }

    pub fn measure_text(&mut self, id: usize, s: &str) -> [f64; 12] {
        let (spec, ls, align, baseline) = {
            let st = &self.canvases[id].state;
            (st.font.clone(), st.letter_spacing, st.align, st.baseline)
        };
        let sh = self.fonts.shape(&spec, ls, s);
        let w = sh.width;
        let dx = match align {
            1 | 3 => w,
            4 => w / 2.0,
            _ => 0.0,
        };
        let b = text::baseline_offset(baseline, &sh);
        let ink = if sh.ink.is_empty() { Rect::new(0.0, 0.0, 0.0, 0.0) } else { sh.ink };
        [
            w as f64,
            (dx - ink.left) as f64,
            (ink.right - dx) as f64,
            (-ink.top - b) as f64,
            (ink.bottom + b) as f64,
            (sh.ascent - b) as f64,
            (sh.descent + b) as f64,
            (sh.typo_ascent - b) as f64,
            (sh.typo_descent + b) as f64,
            (sh.ascent * 0.8 - b) as f64,
            (-b) as f64,
            (-sh.ideographic - b) as f64,
        ]
    }

    // ------------------------------------------------------------ images
    fn image_of(&mut self, kind: i32, src: usize) -> Option<ImageSrc> {
        if kind == 1 {
            let c = self.canvases.get_mut(src)?;
            let s = c.surface.as_mut()?;
            Some(ImageSrc::Raster(s.image_snapshot()))
        } else {
            self.images.get(src)?.clone()
        }
    }

    pub fn draw_image(&mut self, id: usize, kind: i32, src: usize, argc: usize, a: [f32; 8]) {
        let Some(img) = self.image_of(kind, src) else { return };
        let (iw, ih) = img.size();
        if iw <= 0.0 || ih <= 0.0 {
            return;
        }
        let (mut s, mut d) = match argc {
            2 => (Rect::from_wh(iw, ih), Rect::from_xywh(a[0], a[1], iw, ih)),
            4 => (Rect::from_wh(iw, ih), Rect::from_xywh(a[0], a[1], a[2], a[3])),
            _ => (Rect::from_xywh(a[0], a[1], a[2], a[3]), Rect::from_xywh(a[4], a[5], a[6], a[7])),
        };
        if ![s.left, s.top, s.right, s.bottom, d.left, d.top, d.right, d.bottom].iter().all(|v| v.is_finite()) {
            return;
        }
        s.sort();
        d.sort();
        if s.is_empty() || d.is_empty() {
            return;
        }
        // Clip the source to the image, shrinking the destination in proportion (Blink).
        let bounds = Rect::from_wh(iw, ih);
        if !sk::Contains::contains(&bounds, s) {
            let Some(clipped) = Rect::intersects2(s, bounds).then(|| {
                let mut r = s;
                r.intersect(bounds);
                r
            }) else {
                return;
            };
            let sx = d.width() / s.width();
            let sy = d.height() / s.height();
            d = Rect::new(d.left + (clipped.left - s.left) * sx, d.top + (clipped.top - s.top) * sy, d.left + (clipped.right - s.left) * sx, d.top + (clipped.bottom - s.top) * sy);
            s = clipped;
        }
        let st = &self.canvases[id].state;
        let samp = sampling(st.smoothing, st.quality);
        let mut paint = Paint::default();
        paint.set_anti_alias(true);
        paint.set_alpha_f(st.alpha);
        let whole = s == bounds;
        self.draw_with(id, paint, Some(d), move |c, paint| match &img {
            ImageSrc::Raster(image) => {
                let constraint = if whole { sk::canvas::SrcRectConstraint::Fast } else { sk::canvas::SrcRectConstraint::Strict };
                c.draw_image_rect_with_sampling_options(image, Some((&s, constraint)), d, samp, paint);
            }
            ImageSrc::Picture(pic, _, _) => {
                c.save();
                c.clip_rect(d, None, true);
                let m = Matrix::rect_2_rect(s, d, None).unwrap_or_default();
                c.concat(&m);
                let alpha = paint.alpha_f();
                if alpha < 1.0 || paint.blend_mode_or(BlendMode::SrcOver) != BlendMode::SrcOver {
                    let mut lp = Paint::default();
                    lp.set_alpha_f(alpha);
                    lp.set_blend_mode(paint.blend_mode_or(BlendMode::SrcOver));
                    c.save_layer(&SaveLayerRec::default().paint(&lp).bounds(&s));
                    c.draw_picture(pic, None, None);
                    c.restore();
                } else {
                    c.draw_picture(pic, None, None);
                }
                c.restore();
            }
        });
    }

    pub fn pattern_new(&mut self, kind: i32, src: usize, rep: u8) -> i32 {
        let Some(img) = self.image_of(kind, src) else { return -1 };
        let (w, h) = img.size();
        if w <= 0.0 || h <= 0.0 {
            return -1;
        }
        self.patterns.push(Pattern { image: img, rep, matrix: Matrix::new_identity() });
        (self.patterns.len() - 1) as i32
    }

    // ------------------------------------------------------------ pixels
    pub fn get_image_data(&mut self, id: usize, x: i32, y: i32, w: i32, h: i32, out: &mut [u8]) {
        let c = &mut self.canvases[id];
        let Some(s) = c.surface.as_mut() else { return };
        let info = ImageInfo::new((w, h), ColorType::RGBA8888, AlphaType::Unpremul, None);
        // read_pixels leaves pixels outside the canvas untouched (zero, transparent black).
        s.read_pixels(&info, out, (w * 4) as usize, (x, y));
    }

    pub fn put_image_data(&mut self, id: usize, data: &[u8], iw: i32, ih: i32, dx: i32, dy: i32, rx: i32, ry: i32, rw: i32, rh: i32) {
        let c = &mut self.canvases[id];
        let Some(s) = c.surface.as_mut() else { return };
        // dirty rectangle, normalised and clipped to the image data
        let (mut x0, mut y0, mut x1, mut y1) = (rx, ry, rx + rw, ry + rh);
        if x0 > x1 {
            std::mem::swap(&mut x0, &mut x1);
        }
        if y0 > y1 {
            std::mem::swap(&mut y0, &mut y1);
        }
        x0 = x0.max(0);
        y0 = y0.max(0);
        x1 = x1.min(iw);
        y1 = y1.min(ih);
        if x0 >= x1 || y0 >= y1 {
            return;
        }
        let info = ImageInfo::new((x1 - x0, y1 - y0), ColorType::RGBA8888, AlphaType::Unpremul, None);
        let row = (iw * 4) as usize;
        let start = (y0 as usize) * row + (x0 as usize) * 4;
        let _ = s.canvas().write_pixels(&info, &data[start..], row, (dx + x0, dy + y0));
    }

    /// The output frame: straight (unpremultiplied) RGBA, row-major, no padding.
    pub fn read_rgba(&mut self, id: usize, out: &mut Vec<u8>) -> (i32, i32) {
        let c = &mut self.canvases[id];
        let (w, h) = (c.w, c.h);
        out.resize((w * h * 4) as usize, 0);
        if let Some(s) = c.surface.as_mut() {
            let info = ImageInfo::new((w, h), ColorType::RGBA8888, AlphaType::Unpremul, None);
            s.read_pixels(&info, out.as_mut_slice(), (w * 4) as usize, (0, 0));
        }
        (w, h)
    }

    // ------------------------------------------------------------ setters
    pub fn set_style(&mut self, id: usize, stroke: bool, kind: i32, idx: usize, s: &str) -> Option<String> {
        let fill = match kind {
            1 => Fill::Gradient(idx),
            2 => Fill::Pattern(idx),
            _ => Fill::Color(style::parse_color(s)?),
        };
        let out = if let Fill::Color(c) = &fill { Some(style::serialize_color(*c)) } else { Some(String::new()) };
        let st = &mut self.canvases[id].state;
        if stroke {
            st.stroke = fill;
        } else {
            st.fill = fill;
        }
        out
    }
}
