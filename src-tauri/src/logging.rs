//! File-based boot logging. Used to diagnose launch issues (e.g. white screen
//! when the .app is moved to /Applications) where the GUI process's
//! stdout/stderr is discarded and we can't see the server state.

/// Append a line to ~/.9router/tauri-boot.log.
pub(crate) fn boot_log(line: &str) {
    if let Ok(home) = std::env::var("HOME") {
        let path = std::path::Path::new(&home).join(".9router").join("tauri-boot.log");
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(std::path::Path::new("")));
        // Truncate if > 512KB to prevent unbounded growth.
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() > 512 * 1024 {
                let _ = std::fs::remove_file(&path);
            }
        }
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .and_then(|mut f| {
                use std::io::Write;
                writeln!(f, "[{ts}] {line}")
            });
    }
}
