//! macOS native menu bar (App / Edit / Window).
//!
//! Without this, Cmd+C/Cmd+V/Cmd+A etc. do not work in text inputs because
//! macOS routes keyboard shortcuts through the menu bar. The predefined items
//! are handled by the OS automatically.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager,
};

use crate::logging::boot_log;
use crate::server::stop_server;
use crate::window::focused_webview_window;

pub(crate) fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        boot_log("build_menu: creating menus");
        let app_menu = Submenu::with_items(app, "9Router", true, &[
            &MenuItem::with_id(app, "about", "About 9Router", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            // Cmd+H = hide app, Cmd+Q = quit (standard macOS shortcuts)
            &MenuItem::with_id(app, "hide", "Hide 9Router", true, Some("CmdOrCtrl+H"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Quit 9Router", true, Some("CmdOrCtrl+Q"))?,
        ])?;

        let edit_menu = Submenu::with_items(app, "Edit", true, &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ])?;

        // Window menu: Cmd+W = close (intercepted by on_window_event to show
        // the quit/minimize-to-tray dialog), Cmd+M = minimize
        let window_menu = Submenu::with_items(app, "Window", true, &[
            &MenuItem::with_id(app, "minimize", "Minimize", true, Some("CmdOrCtrl+M"))?,
            &MenuItem::with_id(app, "close", "Close", true, Some("CmdOrCtrl+W"))?,
        ])?;

        let menu = Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])?;
        app.set_menu(menu)?;
        boot_log("build_menu: OK");
    }
    Ok(())
}

/// Handler for the builder's `.on_menu_event` (app menu bar items only; tray
/// menu items are handled inside tray.rs).
pub(crate) fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "quit" => {
            // stop_server waits up to 3s for graceful shutdown — run it off
            // the main thread so ⌘Q never freezes the UI.
            let handle = app.clone();
            std::thread::spawn(move || {
                stop_server(&handle);
                handle.exit(0);
            });
        }
        "hide" => {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.minimize();
            }
        }
        "minimize" => {
            // Follow focus: Cmd+M on the Exa sync window minimises that
            // window, not the dashboard behind it.
            if let Some(win) = focused_webview_window(app) {
                let _ = win.minimize();
            } else if let Some(win) = app.get_webview_window("main") {
                let _ = win.minimize();
            }
        }
        "close" => {
            // Same as clicking the red close button: emit "close-requested"
            // so the frontend shows the Quit/Minimize-to-tray dialog.
            // Child windows (Exa sync) just close normally.
            if let Some(win) = focused_webview_window(app) {
                if win.label() != "main" {
                    let _ = win.close();
                } else {
                    let _ = win.emit("close-requested", ());
                }
            }
        }
        _ => {}
    }
}
