//! Global frontend → Rust event listeners that don't belong to a specific
//! feature module.
//!
//! Events are used instead of custom commands because events work on remote
//! URLs while custom commands get blocked by the ACL.

use tauri::{AppHandle, Emitter, Listener, Manager};

use crate::logging::boot_log;
use crate::server::stop_server;
use crate::state::LightweightMode;
use crate::window::show_dashboard;

pub(crate) fn register(app: &AppHandle) {
    // Listen for "hide-to-tray" event from the frontend. The frontend emits
    // this when the user chooses "Minimize to tray" in the close dialog.
    let handle_for_hide = app.clone();
    app.listen("hide-to-tray", move |_event| {
        boot_log("hide-to-tray: hiding window + Dock");
        #[cfg(target_os = "macos")]
        crate::window::set_dock_visible(false);
        if let Some(win) = handle_for_hide.get_webview_window("main") {
            let _ = win.hide();
        }
    });

    // Usage panel's "Dashboard" footer row: bring the main window back and
    // let the SPA route client-side. When the main window was destroyed
    // (lightweight mode), recreate it directly at the target path instead
    // (there is no live SPA to push a route onto).
    let handle_for_open = app.clone();
    app.listen("open-dashboard", move |event| {
        let path = serde_json::from_str::<serde_json::Value>(event.payload())
            .ok()
            .and_then(|v| v.get("path").and_then(|p| p.as_str()).map(str::to_string))
            .unwrap_or_else(|| "/dashboard".to_string());
        if handle_for_open.get_webview_window("main").is_some() {
            show_dashboard(&handle_for_open, None);
            if let Some(main) = handle_for_open.get_webview_window("main") {
                let _ = main.emit("navigate-dashboard", serde_json::json!({ "path": path }));
            }
        } else {
            show_dashboard(&handle_for_open, Some(&path));
        }
    });

    // Usage panel "Lightweight Mode" switch: same behavior the old tray menu
    // item had — ON frees the main window + Dock icon (server keeps running),
    // OFF recreates the window.
    let handle_for_lw = app.clone();
    app.listen("toggle-lightweight", move |_| {
        if let Some(state) = handle_for_lw.try_state::<LightweightMode>() {
            let was_on = state.0.swap(
                !state.0.load(std::sync::atomic::Ordering::Relaxed),
                std::sync::atomic::Ordering::Relaxed,
            );
            if !was_on {
                boot_log("lightweight: ON - closing window + hiding Dock");
                #[cfg(target_os = "macos")]
                crate::window::set_dock_visible(false);
                if let Some(win) = handle_for_lw.get_webview_window("main") {
                    let _ = win.close();
                }
            } else {
                boot_log("lightweight: OFF - recreating window");
                show_dashboard(&handle_for_lw, None);
            }
            crate::panel::emit_state(&handle_for_lw);
        }
    });

    // Usage panel "Quit" row. stop_server waits up to 3s for graceful
    // shutdown — run it off the main thread so the UI never freezes.
    let handle_for_quit = app.clone();
    app.listen("quit-app", move |_| {
        boot_log("quit-app: stopping server and exiting");
        let handle = handle_for_quit.clone();
        std::thread::spawn(move || {
            stop_server(&handle);
            handle.exit(0);
        });
    });
}
