//! Usage panel: the compact popover window shown by left-clicking the tray
//! icon (menubar-popover style). The panel is a regular webview window that
//! loads the dedicated `/quota-panel` page of the local dashboard server; it
//! is hidden on focus loss instead of destroyed, so reopening is instant.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, WebviewWindowBuilder};

use crate::consts::{PANEL_LABEL, PANEL_URL, SERVER_PORT};
use crate::inject::PAGE_INIT_JS;
use crate::logging::boot_log;

const PANEL_WIDTH: f64 = 360.0;
/// The page sizes the window to fit its content, clamped to this range
/// (see quota-panel/page.js — the same bounds live there).
const PANEL_MIN_HEIGHT: f64 = 340.0;
const PANEL_MAX_HEIGHT: f64 = 640.0;
/// Gap between the tray icon and the panel edge.
const PANEL_GAP: f64 = 6.0;
/// A tray click that resigns the panel's focus must not immediately re-hide
/// what we just toggled, so blur handling is ignored for a short window.
const TRAY_TOGGLE_GUARD_MS: i64 = 300;

static TRAY_TOGGLE_AT_MS: AtomicI64 = AtomicI64::new(0);

/// Last known tray icon rect, stashed from every tray event (clicks, hover).
/// The right-click menu path has no rect in its event, so the menu-item
/// toggle anchors the panel to this instead of a screen corner.
static LAST_ANCHOR: Mutex<Option<tauri::Rect>> = Mutex::new(None);

/// Remember the tray icon rect carried by a tray event.
pub(crate) fn remember_anchor(rect: tauri::Rect) {
    if let Ok(mut guard) = LAST_ANCHOR.lock() {
        *guard = Some(rect);
    }
}

fn last_anchor() -> Option<tauri::Rect> {
    LAST_ANCHOR.lock().ok().and_then(|guard| *guard)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn mark_tray_toggle() {
    TRAY_TOGGLE_AT_MS.store(now_ms(), Ordering::Relaxed);
}

/// Hide the panel when it loses focus, unless a tray toggle just happened
/// (within TRAY_TOGGLE_GUARD_MS) — that focus loss was caused by the toggle
/// itself, and hiding then would make the panel flicker away right after
/// being shown.
pub(crate) fn handle_focus_lost(app: &AppHandle) {
    if now_ms() - TRAY_TOGGLE_AT_MS.load(Ordering::Relaxed) < TRAY_TOGGLE_GUARD_MS {
        return;
    }
    if let Some(win) = app.get_webview_window(PANEL_LABEL) {
        if win.is_visible().unwrap_or(false) {
            boot_log("panel: focus lost - hiding");
            let _ = win.hide();
        }
    }
}

/// The monitor containing the given physical point, falling back to the
/// primary monitor (needed to clamp the panel onto a screen and to convert
/// physical ↔ logical coordinates for multi-DPI setups).
fn monitor_containing(
    app: &AppHandle,
    x: f64,
    y: f64,
) -> Option<tauri::Monitor> {
    if let Ok(monitors) = app.available_monitors() {
        for m in monitors {
            let pos = m.position();
            let size = m.size();
            let left = pos.x as f64;
            let top = pos.y as f64;
            let right = left + size.width as f64;
            let bottom = top + size.height as f64;
            if x >= left && x < right && y >= top && y < bottom {
                return Some(m);
            }
        }
    }
    app.primary_monitor().ok().flatten()
}

/// Normalize a tray rect to physical pixels (x, y, w, h). Tray events report
/// physical rects on macOS; the logical branch is a fallback for other
/// platforms, converted with the primary monitor's scale.
fn rect_physical(app: &AppHandle, rect: &tauri::Rect) -> (f64, f64, f64, f64) {
    let scale_hint = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    let pos = rect.position.to_physical(scale_hint);
    let size = rect.size.to_physical(scale_hint);
    (pos.x, pos.y, size.width, size.height)
}

/// Logical (x, y) anchoring the panel to the top-right corner of the primary
/// monitor, just below the menu bar. Used when no tray rect is available
/// (right-click menu path).
fn fallback_position(app: &AppHandle) -> Option<(f64, f64)> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let scale = if scale > 0.0 { scale } else { 1.0 };
    let m_pos = monitor.position();
    let m_size = monitor.size();
    let menu_bar = 28.0 * scale;
    let x = m_pos.x as f64 + (m_size.width as f64 - PANEL_WIDTH * scale) / 2.0;
    let y = m_pos.y as f64 + menu_bar;
    Some((x / scale, y / scale))
}

/// Logical (x, y) for the panel so its right edge sits under the tray icon,
/// clamped to the screen. Tray event rects are in physical pixels.
fn anchored_position(app: &AppHandle, rect: &tauri::Rect) -> Option<(f64, f64)> {
    let (ix, iy, iw, ih) = rect_physical(app, rect);
    let monitor = monitor_containing(app, ix, iy)?;
    let scale = monitor.scale_factor();
    let scale = if scale > 0.0 { scale } else { 1.0 };
    let panel_w = PANEL_WIDTH * scale;
    // Clamp against the tallest possible panel so flip-above still fits.
    let panel_h = PANEL_MAX_HEIGHT * scale;
    let gap = PANEL_GAP * scale;
    let margin = 8.0 * scale;

    let m_pos = monitor.position();
    let m_size = monitor.size();
    let m_left = m_pos.x as f64;
    let m_top = m_pos.y as f64;
    let m_right = m_left + m_size.width as f64;
    let m_bottom = m_top + m_size.height as f64;

    // Horizontally centered under the icon (menubar-popover convention),
    // clamped to the screen so the panel never hangs off an edge.
    let icon_center_x = ix + iw / 2.0;
    let icon_bottom = iy + ih;
    let icon_top = iy;

    let mut x = icon_center_x - panel_w / 2.0;
    let mut y = icon_bottom + gap;
    // Not enough room below the icon (rare): flip above it.
    if y + panel_h > m_bottom {
        y = icon_top - gap - panel_h;
    }
    if x < m_left + margin {
        x = m_left + margin;
    }
    if x + panel_w > m_right - margin {
        x = m_right - margin - panel_w;
        if x < m_left + margin {
            x = m_left + margin;
        }
    }
    if y < m_top + margin {
        y = m_top + margin;
    }
    Some((x / scale, y / scale))
}

/// Push the lightweight-mode flag to the panel page (drives its switch).
pub(crate) fn emit_state(app: &AppHandle) {
    let lightweight = app
        .try_state::<crate::state::LightweightMode>()
        .map(|s| s.0.load(Ordering::Relaxed))
        .unwrap_or(false);
    let _ = app.emit_to(
        PANEL_LABEL,
        "panel-state",
        serde_json::json!({ "lightweight": lightweight }),
    );
}

/// Show the panel (anchored under the tray icon) or hide it if already
/// visible — clicking the tray icon toggles the popover.
pub(crate) fn toggle_panel(app: &AppHandle, icon_rect: Option<tauri::Rect>) {
    mark_tray_toggle();
    // Menu-item clicks carry no rect; fall back to the stashed tray rect so
    // the panel still opens under the icon instead of in a screen corner.
    let icon_rect = icon_rect.or_else(last_anchor);

    if let Some(win) = app.get_webview_window(PANEL_LABEL) {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
            return;
        }
        // Hidden but alive: re-anchor to the current tray icon position
        // (menu bar icons can move) and reveal without reloading.
        let position = icon_rect
            .as_ref()
            .and_then(|rect| anchored_position(app, rect))
            .or_else(|| fallback_position(app));
        if let Some((x, y)) = position {
            let _ = win.set_position(tauri::LogicalPosition::new(x, y));
        }
        let _ = win.show();
        let _ = win.set_focus();
        let _ = app.emit_to(PANEL_LABEL, "panel-shown", ());
        emit_state(app);
        return;
    }

    // First open: create the window hidden, wait for the local server,
    // navigate, inject the init script, then reveal — so the popover never
    // flashes a blank frame.
    let mut builder =
        WebviewWindowBuilder::new(app, PANEL_LABEL, tauri::WebviewUrl::App("index.html".into()))
            .title("9Router Usage")
            .inner_size(PANEL_WIDTH, PANEL_MIN_HEIGHT)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            // Native shadows draw a square halo around the whole window rect
            // (visible as dark edges around the rounded card) — the page
            // paints its own CSS shadow instead.
            .shadow(false)
            .visible(false)
            .focused(false);
    if let Some(position) = icon_rect
        .as_ref()
        .and_then(|rect| anchored_position(app, rect))
        .or_else(|| fallback_position(app))
    {
        builder = builder.position(position.0, position.1);
    }
    if let Err(e) = builder.build() {
        boot_log(&format!("panel: build failed: {e}"));
        return;
    }
    boot_log("panel: window created, waiting for server");

    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if std::net::TcpStream::connect(format!("127.0.0.1:{SERVER_PORT}")).is_ok() {
            if let Some(w) = app2.get_webview_window(PANEL_LABEL) {
                if let Ok(url) = PANEL_URL.parse() {
                    let _ = w.navigate(url);
                }
                std::thread::sleep(std::time::Duration::from_millis(2000));
                let _ = w.eval(PAGE_INIT_JS);
                let _ = w.show();
                let _ = w.set_focus();
                let _ = app2.emit_to(PANEL_LABEL, "panel-shown", ());
                emit_state(&app2);
                boot_log("panel: shown");
            }
        } else {
            boot_log("panel: server not reachable, panel stays hidden");
        }
    });
}
