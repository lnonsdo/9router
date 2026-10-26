//! Exa dashboard sync windows.
//!
//! dashboard.exa.ai sits behind Vercel's bot challenge, so only a real browser
//! context can read its usage APIs. The injected script (see inject.rs) runs
//! inside that context, calls the same endpoints the dashboard itself calls,
//! and hands the JSON back over the Tauri event channel. Events (not custom
//! commands) because remote pages are blocked by the ACL — the same reason
//! `hide-to-tray` uses an event.

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Listener, Manager, WebviewWindowBuilder};

use crate::consts::EXA_SYNC_DIR;
use crate::inject::EXA_SYNC_JS_TEMPLATE;
use crate::logging::boot_log;

/// Connection ids are UUIDs; strip anything else before using one as a filename.
pub(crate) fn sanitize_connection_id(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

/// Open (or focus) the Exa dashboard window used by the sync button.
///
/// One window per connection: two Exa accounts can be synced side by side, and
/// each window's injected script carries its own expected key prefix.
/// `auto` windows start hidden so the quota page can refresh silently; if the
/// Exa session is gone the login page shows itself instead of hiding the fix.
fn open_exa_connect(app: &AppHandle, connection_id: &str, key_prefix: Option<&str>, auto: bool) {
    let conn = sanitize_connection_id(connection_id);
    if conn.is_empty() {
        boot_log("open_exa_connect: invalid connection id");
        return;
    }

    let label = format!("exa-connect-{conn}");
    if let Some(w) = app.get_webview_window(&label) {
        if !auto {
            let _ = w.show();
            let _ = w.set_focus();
        }
        return;
    }

    let prefix: String = key_prefix
        .unwrap_or("")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let script = EXA_SYNC_JS_TEMPLATE
        .replace("__CONNECTION_ID__", &conn)
        .replace("__KEY_PREFIX__", &prefix)
        .replace("__AUTO__", if auto { "1" } else { "0" });
    let script_for_load = script.clone();
    let url: tauri::Url = match "https://dashboard.exa.ai/billing".parse() {
        Ok(u) => u,
        Err(_) => return,
    };

    match WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::External(url))
        .title("Exa — 同步账户用量")
        .inner_size(1100.0, 820.0)
        .min_inner_size(800.0, 600.0)
        .center()
        .visible(!auto)
        .initialization_script(&script)
        // WKWebView does not reliably re-run js_init_script across cross-origin
        // navigations (login → dashboard), so eval it again on every page load.
        .on_page_load(move |webview, payload| {
            match payload.url().host_str() {
                Some("dashboard.exa.ai") => {
                    let _ = webview.eval(script_for_load.as_str());
                }
                // Hidden auto-sync hit the login page: surface it so the user
                // can sign in, then the script finishes on its own.
                Some("auth.exa.ai") if auto => {
                    let _ = webview.show();
                    let _ = webview.set_focus();
                }
                _ => {}
            }
        })
        .build()
    {
        Ok(_) => boot_log(&format!("open_exa_connect: window opened for {conn}")),
        Err(e) => boot_log(&format!("open_exa_connect: build failed: {e}")),
    }
}

/// Register the three Exa-sync event listeners (frontend ↔ Rust).
pub(crate) fn register(app: &AppHandle) {
    // Quota page "Sync Exa" button → open the dashboard webview. The
    // injected script reads the account's credits/volume from inside
    // that real browser context (the only place they are readable).
    let handle_for_exa_open = app.clone();
    app.listen("open-exa-connect", move |event| {
        let payload = serde_json::from_str::<serde_json::Value>(event.payload()).ok();
        let connection_id = payload
            .as_ref()
            .and_then(|v| v.get("connectionId"))
            .and_then(|c| c.as_str())
            .map(str::to_string);
        let key_prefix = payload
            .as_ref()
            .and_then(|v| v.get("keyPrefix"))
            .and_then(|c| c.as_str())
            .map(str::to_string);
        let auto = payload
            .as_ref()
            .and_then(|v| v.get("auto"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if let Some(id) = connection_id {
            let app = handle_for_exa_open.clone();
            let _ = handle_for_exa_open.run_on_main_thread(move || {
                open_exa_connect(&app, &id, key_prefix.as_deref(), auto)
            });
        } else {
            boot_log("open-exa-connect: missing connectionId");
        }
    });

    // Hidden auto-sync gave up (no session / wrong account): drop it.
    let handle_for_exa_abort = app.clone();
    app.listen("exa-sync-abort", move |event| {
        let id = serde_json::from_str::<serde_json::Value>(event.payload())
            .ok()
            .and_then(|v| v.get("connectionId").and_then(|c| c.as_str()).map(sanitize_connection_id))
            .unwrap_or_default();
        if id.is_empty() {
            return;
        }
        if let Some(w) = handle_for_exa_abort.get_webview_window(&format!("exa-connect-{id}")) {
            boot_log(&format!("exa-sync-abort: closing {id}"));
            let _ = w.close();
        }
    });

    // The Exa webview hands its JSON back over the event channel.
    // Persist it beside the DB so the quota handler can read it with no
    // extra API route, then tell the main window to refresh the card.
    let handle_for_exa_result = app.clone();
    app.listen("exa-sync-result", move |event| {
        let raw = event.payload().to_string();
        let parsed: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => {
                boot_log(&format!("exa-sync-result: bad payload: {e}"));
                return;
            }
        };
        let id = sanitize_connection_id(
            parsed.get("connectionId").and_then(|v| v.as_str()).unwrap_or(""),
        );
        if id.is_empty() {
            boot_log("exa-sync-result: missing connectionId");
            return;
        }
        if let Ok(home) = std::env::var("HOME") {
            let path = PathBuf::from(&home)
                .join(".9router")
                .join(EXA_SYNC_DIR)
                .join(format!("{id}.json"));
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            match std::fs::write(&path, raw.as_bytes()) {
                Ok(_) => boot_log(&format!("exa-sync-result: wrote {}", path.display())),
                Err(e) => boot_log(&format!("exa-sync-result: write failed: {e}")),
            }
        }
        if let Some(w) = handle_for_exa_result
            .get_webview_window(&format!("exa-connect-{id}"))
        {
            let _ = w.close();
        }
        if let Some(main) = handle_for_exa_result.get_webview_window("main") {
            let _ = main.emit("exa-sync-done", serde_json::json!({ "connectionId": id }));
        }
    });
}
