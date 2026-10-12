// OpenGL ES 3.0 entry points for the WebGL backend (ANGLE), generated from Khronos' gl.xml.
use gl_generator::{Api, Fallbacks, GlobalGenerator, Profile, Registry};
use std::fs::File;
use std::path::PathBuf;

fn main() {
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let mut f = File::create(out.join("gles_bindings.rs")).unwrap();
    Registry::new(Api::Gles2, (3, 0), Profile::Core, Fallbacks::None, [])
        .write_bindings(GlobalGenerator, &mut f)
        .unwrap();
    println!("cargo:rerun-if-changed=build.rs");
}
