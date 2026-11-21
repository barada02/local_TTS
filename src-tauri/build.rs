fn main() {
    // The app icon is embedded into the exe by this build script. Cargo only
    // re-runs it when a tracked file changes, so a new icon was silently
    // ignored and the old one stayed in the exe, the window and the shortcut.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
