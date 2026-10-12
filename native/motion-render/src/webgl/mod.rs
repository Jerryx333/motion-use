//! WebGL 1/2 for motion-render, on ANGLE — the same GLES implementation (and shader translator,
//! and WebGL validation) Chrome uses: Metal on macOS, Vulkan on Linux, SwiftShader on the CPU.
//! `src/js/webgl.js` builds `WebGL2RenderingContext` over the `__native.gl*` functions here.
//! Each worker thread owns its contexts; a context is made current on demand.
mod context;
mod egl;
mod gl;
mod natives;
mod pixels;

pub use natives::install;

use context::GlCtx;
use std::cell::RefCell;

pub(crate) struct State {
    ctxs: Vec<Option<GlCtx>>,
    current: usize,
}

thread_local! {
    static ST: RefCell<State> = const { RefCell::new(State { ctxs: Vec::new(), current: usize::MAX }) };
}

/// Run `f` with context `id` current. None if there is no such context.
pub(crate) fn with_ctx<R>(id: usize, f: impl FnOnce(&mut GlCtx, &'static egl::Egl) -> R) -> Option<R> {
    let egl = egl::egl().ok()?;
    ST.with(|st| {
        let mut st = st.borrow_mut();
        let ptr = st.ctxs.get(id)?.as_ref()?.egl;
        if st.current != id {
            if !egl.make_current(ptr) {
                return None;
            }
            st.current = id;
        }
        let c = st.ctxs[id].as_mut()?;
        Some(f(c, egl))
    })
}

pub(crate) fn add_ctx(c: GlCtx) -> usize {
    ST.with(|st| {
        let mut st = st.borrow_mut();
        st.ctxs.push(Some(c));
        // GlCtx::new left it current
        st.current = st.ctxs.len() - 1;
        st.current
    })
}

pub(crate) fn remove_ctx(id: usize) {
    let c = ST.with(|st| {
        let mut st = st.borrow_mut();
        st.current = usize::MAX;
        st.ctxs.get_mut(id).and_then(|c| c.take())
    });
    if let (Some(mut c), Ok(egl)) = (c, egl::egl()) {
        c.destroy(egl);
    }
}

/// Called after each frame: a context without preserveDrawingBuffer that was drawn into gets its
/// buffer cleared, as a browser does after presenting it.
pub fn end_frame() {
    let ids: Vec<usize> = ST.with(|st| {
        st.borrow().ctxs.iter().enumerate().filter_map(|(i, c)| c.as_ref().filter(|c| c.drawn_this_frame).map(|_| i)).collect()
    });
    for id in ids {
        with_ctx(id, |c, _| {
            c.drawn_this_frame = false;
            if !c.attrs.preserve {
                c.clear_buffer();
                c.dirty = false;
            }
        });
    }
}

/// Destroy this thread's contexts (the engine is going away).
pub fn reset() {
    let ctxs: Vec<GlCtx> = ST.with(|st| {
        let mut st = st.borrow_mut();
        st.current = usize::MAX;
        st.ctxs.drain(..).flatten().collect()
    });
    if ctxs.is_empty() {
        return;
    }
    if let Ok(egl) = egl::egl() {
        for mut c in ctxs {
            c.destroy(egl);
        }
    }
}

/// What `--capabilities` reports: the ANGLE backend and library folder WebGL would use, or why
/// WebGL is unavailable (no ANGLE next to the binary or in the cache, no display, turned off).
pub fn probe() -> Result<(String, String), String> {
    let e = egl::egl()?;
    Ok((e.backend.name().to_string(), e.dir.display().to_string()))
}
