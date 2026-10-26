//! Webview window management: main dashboard window, macOS Dock visibility,
//! and lightweight-mode helpers.

use tauri::{AppHandle, Manager, WebviewWindowBuilder};

use crate::consts::{DASHBOARD_URL, SERVER_PORT};
use crate::inject::PAGE_INIT_JS;
use crate::logging::boot_log;
use crate::state::LightweightMode;

/// The focused webview window, if any. Used by the Window menu so Cmd+W /
/// Cmd+M act on the Exa sync window when it is in front, not the dashboard.
pub(crate) fn focused_webview_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
}

/// Toggle the macOS Dock icon. When hiding the window to tray, set to
/// Accessory (no Dock icon); when showing, set to Regular (Dock icon visible).
#[cfg(target_os = "macos")]
pub(crate) fn set_dock_visible(visible: bool) {
    use objc::{msg_send, sel, sel_impl};
    unsafe {
        let cls = objc::runtime::Class::get("NSApplication").unwrap();
        let app: *mut objc::runtime::Object = msg_send![cls, sharedApplication];
        // 0 = NSApplicationActivationPolicyRegular (Dock + menu bar)
        // 1 = NSApplicationActivationPolicyAccessory (menu bar only, no Dock)
        let policy: i64 = if visible { 0 } else { 1 };
        let _: () = msg_send![app, setActivationPolicy: policy];
        // After changing policy, activate the app to refresh the Dock
        if visible {
            let _: () = msg_send![app, activateIgnoringOtherApps: true];
        }
    }
}

/// (Re)create the main webview window if it doesn't exist, then navigate
/// to the dashboard (or `target_path` when given). Used by the tray "Dashboard"
/// item and the usage panel's "open full dashboard" button.
pub(crate) fn show_dashboard(app: &AppHandle, target_path: Option<&str>) {
    #[cfg(target_os = "macos")]
    set_dock_visible(true);

    // Clear lightweight mode flag so normal close behavior resumes.
    if let Some(state) = app.try_state::<LightweightMode>() {
        state.0.store(false, std::sync::atomic::Ordering::Relaxed);
    }

    let nav_url = match target_path {
        Some(path) => format!("http://127.0.0.1:{SERVER_PORT}{path}"),
        None => DASHBOARD_URL.to_string(),
    };

    if app.get_webview_window("main").is_none() {
        boot_log("show_dashboard: creating new window (was destroyed)");
        let _ = WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
            .title("9Router")
            .inner_size(1280.0, 800.0)
            .min_inner_size(900.0, 600.0)
            .resizable(true)
            .center()
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .decorations(true)
            .transparent(true)
            .build();
        // After creating, wait for server and navigate + inject JS.
        let app2 = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if std::net::TcpStream::connect(format!("127.0.0.1:{SERVER_PORT}")).is_ok() {
                if let Some(w) = app2.get_webview_window("main") {
                    if let Ok(url) = nav_url.parse() {
                        let _ = w.navigate(url);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(2000));
                    let _ = w.eval(PAGE_INIT_JS);
                }
            }
        });
    } else if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}
