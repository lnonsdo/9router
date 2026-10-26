//! Tauri-native system tray (replaces upstream systray2 tray.js).
//!
//! The tray has NO native menu: any click toggles the compact usage panel
//! (popover anchored under the icon), which embeds the former menu actions
//! (Dashboard / Lightweight Mode / Quit) as its own footer section.

use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle,
};

use crate::logging::boot_log;
use crate::panel;

pub(crate) fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let _tray = TrayIconBuilder::with_id("9router-tray")
        .tooltip("9Router")
        .show_menu_on_left_click(false)
        .icon(app.default_window_icon().cloned().unwrap_or_else(|| {
            tauri::image::Image::from_bytes(include_bytes!("../../public/icons/32x32.png")).unwrap()
        }))
        .build(app)?;

    Ok(())
}

/// App-level tray event handler (registered via `Builder::on_tray_icon_event`).
///
/// Global listeners fire for EVERY tray event unconditionally; the
/// builder-level per-icon listener is keyed by tray id and has proven flaky
/// on newer macOS releases, so the click logic lives here. Clicks are logged
/// so tray issues can be diagnosed from ~/.9router/tauri-boot.log.
pub(crate) fn handle_tray_event(app: &AppHandle, event: TrayIconEvent) {
    // Every event kind (clicks, hover) carries the icon rect — stash it so
    // the panel can anchor itself under the icon.
    if let TrayIconEvent::Click { rect, .. }
    | TrayIconEvent::Enter { rect, .. }
    | TrayIconEvent::Move { rect, .. }
    | TrayIconEvent::Leave { rect, .. } = &event
    {
        panel::remember_anchor(*rect);
    }
    if let TrayIconEvent::Click { button, button_state, .. } = &event {
        boot_log(&format!("tray click: {button:?} {button_state:?}"));
    }
    // One physical click emits Click(Down) then Click(Up); act on Up only,
    // otherwise a single click would toggle the panel twice. Both buttons
    // toggle: the panel itself hosts the former menu actions.
    if let TrayIconEvent::Click {
        rect,
        button: MouseButton::Left | MouseButton::Right,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        panel::toggle_panel(app, Some(rect));
    }
}
