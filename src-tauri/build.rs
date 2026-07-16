// Tauri build hook. Keep minimal — the actual frontend build is delegated to
// `npm run build` via `beforeBuildCommand` in tauri.conf.json. This file just
// invokes tauri-build so it can collect the window/tray metadata from config.
fn main() {
    tauri_build::build();
}
