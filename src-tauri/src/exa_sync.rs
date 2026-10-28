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

/// Two kinds of window per connection: `exa-connect-*` is the hidden sync
/// window, `exa-login-*` is the visible sign-in window. Separate labels because
/// a failed silent sync is replaced by a sign-in window rather than revealed —
/// a window built hidden and shown later does not repaint reliably in WKWebView
/// (it looks frozen and ignores input).
fn window_label(conn: &str, interactive: bool) -> String {
    if interactive {
        format!("exa-login-{conn}")
    } else {
        format!("exa-connect-{conn}")
    }
}

/// Open (or leave alone) the Exa dashboard window used by the sync button.
///
/// One window per connection: two Exa accounts can be synced side by side, and
/// each window's injected script carries its own expected key prefix.
///
/// A silent sync is created with `visible(false)`, so it never puts a window
/// (or the app) in front of the user. tao only orders a window front when it is
/// created visible, so nothing here needs to hide it again — and it must not:
/// calling `hide()` right after build put WKWebView to sleep and the page never
/// loaded. `interactive` windows are the opposite: visible from the first frame,
/// loaded normally, and left to the user to sign in.
fn open_exa_connect(
    app: &AppHandle,
    connection_id: &str,
    key_prefix: Option<&str>,
    pasted_cookie: Option<&str>,
    auto: bool,
    interactive: bool,
) {
    let conn = sanitize_connection_id(connection_id);
    if conn.is_empty() {
        boot_log("open_exa_connect: invalid connection id");
        return;
    }

    // A sign-in window always wins: never stack a second window on top of a
    // login in progress (a refresh click must not disturb it), and never start
    // a sync while one is already running.
    if app.get_webview_window(&window_label(&conn, true)).is_some() {
        boot_log("open_exa_connect: sign-in window already open");
        return;
    }
    if !interactive && app.get_webview_window(&window_label(&conn, false)).is_some() {
        boot_log("open_exa_connect: sync already running");
        return;
    }

    let label = window_label(&conn, interactive);
    let prefix: String = key_prefix
        .unwrap_or("")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let script = EXA_SYNC_JS_TEMPLATE
        .replace("__CONNECTION_ID__", &conn)
        .replace("__KEY_PREFIX__", &prefix)
        .replace("__AUTO__", if auto { "1" } else { "0" })
        .replace("__INTERACTIVE__", if interactive { "1" } else { "0" });
    let script_for_load = script.clone();
    let conn_for_load = conn.clone();
    let landing: tauri::Url = match "https://dashboard.exa.ai/billing".parse() {
        Ok(u) => u,
        Err(_) => return,
    };
    // Only a cookie the user pasted is ever injected. The webview has its own
    // persistent WKWebsiteDataStore that keeps the dashboard session across
    // restarts (that is what makes refresh silent); pouring a *copy* of that
    // session back in only created a second, older cookie for the same name,
    // which NextAuth read first and treated as signed out. The pasted cookie is
    // the bootstrap for a webview that never had a session at all.
    let mut bootstrap_cookies = Vec::new();
    if let Some((name, value)) = parse_pasted_cookie(pasted_cookie) {
        bootstrap_cookies.push((name, value));
    }
    // Start on about:blank so the cookie can be poured in before the
    // dashboard's first request (an unauthenticated first request is what
    // bounced the window to the login page).
    let needs_cookie_preload = !bootstrap_cookies.is_empty();
    let start_url = if needs_cookie_preload {
        tauri::Url::parse("about:blank").unwrap_or_else(|_| landing.clone())
    } else {
        landing.clone()
    };
    let start_on_blank = needs_cookie_preload && start_url.as_str() == "about:blank";

    match WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::External(start_url))
        .title("Exa — 同步账户用量")
        .inner_size(1100.0, 820.0)
        .min_inner_size(800.0, 600.0)
        .center()
        .visible(interactive)
        // Do not let a background sync activate the app (the main window
        // flashing into view). Focus only decides who is key, not visibility.
        .focused(interactive)
        .initialization_script(&script)
        // WKWebView does not reliably re-run js_init_script across cross-origin
        // navigations (login → dashboard), so eval it again on every page load.
        .on_page_load(move |webview, payload| {
            let host = payload.url().host_str().unwrap_or("?");
            match host {
                "dashboard.exa.ai" => {
                    boot_log("exa-sync: dashboard loaded, injecting");
                    let _ = webview.eval(script_for_load.as_str());
                }
                // Exa wants a sign-in. A background sync must stay invisible:
                // close it and let the card prompt for a manual refresh. A
                // user-started sync asks the page to open a real sign-in
                // window instead (see the "manual" note in open_exa_connect).
                "auth.exa.ai" => {
                    if interactive {
                        boot_log("exa-sync: waiting for the user to sign in");
                    } else if auto {
                        boot_log("exa-sync: login required (silent)");
                        let _ = webview.close();
                        notify_needs_login(webview.app_handle(), &conn_for_load, false);
                    } else {
                        boot_log("exa-sync: login required, asking for a sign-in window");
                        let _ = webview.close();
                        let app = webview.app_handle().clone();
                        let id = conn_for_load.clone();
                        let _ = app.clone().run_on_main_thread(move || {
                            notify_needs_login(&app, &id, true);
                        });
                    }
                }
                other => boot_log(&format!("exa-sync: page {other}")),
            }
        })
        .build()
    {
        Ok(_) => {
            boot_log(&format!(
                "open_exa_connect: window opened for {conn} (interactive={interactive})"
            ));
            // Only a hidden sync needs the invisible-window treatment; a
            // sign-in window is the user's to see and close.
            if !interactive {
                if let Some(w) = app.get_webview_window(&label) {
                    show_transparent(&w);
                }
                close_stuck_window(app.clone(), label.clone(), conn.clone());
            }
            if start_on_blank {
                if let Some(w) = app.get_webview_window(&label) {
                    inject_cookies(&w, &bootstrap_cookies);
                    // Now that the cookie is loaded, do the real navigation.
                    let _ = w.navigate(landing);
                }
            }
        }
        Err(e) => boot_log(&format!("open_exa_connect: build failed: {e}")),
    }
}

/// Accepts either `name=value` or a bare cookie value (NextAuth's default
/// name). A bare JWT can contain `=` padding, so the left side only counts as a
/// name when it looks like the session cookie's.
fn parse_pasted_cookie(raw: Option<&str>) -> Option<(String, String)> {
    let text = raw?.trim();
    if text.is_empty() {
        return None;
    }
    if let Some((name, value)) = text.split_once('=') {
        let name = name.trim();
        let value = value.trim();
        let looks_like_name = name.contains("session-token")
            || name.starts_with("next-auth")
            || name.starts_with("__Secure-");
        if looks_like_name && !value.is_empty() {
            return Some((name.to_string(), value.to_string()));
        }
    }
    Some(("next-auth.session-token".to_string(), text.to_string()))
}

/// Pour a pasted session cookie into the webview.
///
/// Every cookie with the same name is deleted first: a host-only copy of
/// `next-auth.session-token` sitting next to the dashboard's existing
/// `Domain=.exa.ai` one sends the server two values, and NextAuth reads the
/// first — which is how a "bootstrap" cookie turned into a signed-out webview.
fn inject_cookies(window: &tauri::WebviewWindow, cookies: &[(String, String)]) {
    if cookies.is_empty() {
        return;
    }
    let existing = window.cookies().unwrap_or_default();
    let mut applied = 0usize;
    for (name, value) in cookies {
        for old in existing.iter() {
            if old.name() == name.as_str() {
                let _ = window.delete_cookie(old.clone());
            }
        }
        let cookie = tauri::webview::cookie::Cookie::build((name.as_str(), value.as_str()))
            .domain("dashboard.exa.ai")
            .path("/")
            .secure(true)
            .http_only(true)
            .same_site(tauri::webview::cookie::SameSite::Lax)
            .build();
        if window.set_cookie(cookie).is_ok() {
            applied += 1;
        }
    }
    boot_log(&format!("exa-sync: injected {applied}/{} pasted cookies", cookies.len()));
}

/// Put the sync window on screen without letting the user see it.
///
/// A window created with `visible(false)` is *ordered out*, and WKWebView
/// suspends the page of a windowless webview: the injected script's very first
/// request hangs and its own 12s timeout never fires, so the sync dies silently
/// (observed in tauri-boot.log: `start tries:0`, then nothing). The window has
/// to be ordered front for WebKit to run it at full speed, so it is made fully
/// transparent and click-through instead: invisible on screen, still "visible"
/// to AppKit. `orderFront` (not `makeKey`) keeps keyboard focus where it was.
#[cfg(target_os = "macos")]
fn show_transparent(window: &tauri::WebviewWindow) {
    use objc::{msg_send, sel, sel_impl};
    let Ok(raw) = window.ns_window() else {
        boot_log("exa-sync: no ns_window, sync will run in a hidden window");
        return;
    };
    unsafe {
        let ns = raw as *mut objc::runtime::Object;
        let _: () = msg_send![ns, setAlphaValue: 0.0f64];
        let _: () = msg_send![ns, setIgnoresMouseEvents: true];
        let _: () = msg_send![ns, orderFrontRegardless];
    }
    boot_log("exa-sync: sync window on screen, alpha 0 + click-through");
}

#[cfg(not(target_os = "macos"))]
fn show_transparent(_window: &tauri::WebviewWindow) {}

/// A sync window that is still around after the script should have finished
/// means the page never ran (bot challenge, dead host, WebKit stall). Close it
/// so no leftover webview blocks the next sync ("sync already running"), and
/// flag the connection as needing attention.
///
/// No visibility check: the silent window is transparent but *visible* on
/// purpose (see `show_transparent`), and a sign-in window lives under its own
/// label, which is checked first.
fn close_stuck_window(app: AppHandle, label: String, connection_id: String) {
    std::thread::spawn(move || {
        // The script gives up on its own after two 12s requests (~30s); leave
        // room for a slow page load before stepping in.
        std::thread::sleep(std::time::Duration::from_secs(90));
        // The user may already be signing in (the silent window was replaced):
        // that window owns the session now, do not report a second failure.
        if app
            .get_webview_window(&window_label(&connection_id, true))
            .is_some()
        {
            return;
        }
        if let Some(w) = app.get_webview_window(&label) {
            boot_log(&format!("exa-sync: closing stuck window {label}"));
            let _ = w.close();
            notify_needs_login(&app, &connection_id, false);
        }
    });
}

/// Tell the quota page that the Exa session behind a connection is gone, so it
/// can ask for a manual refresh instead of silently showing stale numbers.
/// `login` asks the frontend to open a sign-in window: the frontend owns the
/// key prefix and pasted cookie, and Rust would otherwise have to remember them
/// across the window's lifetime.
fn notify_needs_login(app: &AppHandle, connection_id: &str, login: bool) {
    write_login_status(connection_id, true);
    // Broadcast: both the dashboard and the tray usage panel keep their own
    // copy of the snapshot on screen and each listens for this.
    let _ = app.emit(
        "exa-sync-needs-login",
        serde_json::json!({ "connectionId": connection_id, "login": login }),
    );
}

/// Sidecar next to the snapshot (`<id>.status.json`) so the quota handler can
/// say "sign in" under the card without a round-trip through the shell. The
/// file is removed again by the next successful sync.
fn write_login_status(connection_id: &str, needs_login: bool) {
    let Ok(home) = std::env::var("HOME") else { return };
    let path = PathBuf::from(home)
        .join(".9router")
        .join(EXA_SYNC_DIR)
        .join(format!("{}.status.json", sanitize_connection_id(connection_id)));
    if !needs_login {
        let _ = std::fs::remove_file(&path);
        return;
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = std::fs::write(&path, format!("{{\"needsLogin\":true,\"at\":{at}}}"));
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
        let pasted_cookie = payload
            .as_ref()
            .and_then(|v| v.get("sessionCookie"))
            .and_then(|c| c.as_str())
            .map(str::to_string);
        // A user-started refresh on a connection whose Exa session is known to
        // be dead opens the sign-in window straight away: retrying the dead jar
        // silently would only make them wait ~30s for the same outcome.
        let login = payload
            .as_ref()
            .and_then(|v| v.get("login"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if let Some(id) = connection_id {
            let app = handle_for_exa_open.clone();
            let _ = handle_for_exa_open.run_on_main_thread(move || {
                open_exa_connect(
                    &app,
                    &id,
                    key_prefix.as_deref(),
                    pasted_cookie.as_deref(),
                    auto,
                    login,
                )
            });
        } else {
            boot_log("open-exa-connect: missing connectionId");
        }
    });

    // In-page progress trail (start / no-credits / wrong-account / done). A
    // silent webview is otherwise a black box: the log is the only witness.
    app.listen("exa-sync-progress", move |event| {
        let raw = event.payload();
        let line: String = raw.chars().take(160).collect();
        boot_log(&format!("exa-sync: progress {line}"));
    });

    // The script gave up (no session / wrong account). A background sync is
    // closed and reported; a user-started one is replaced by a sign-in window.
    let handle_for_exa_abort = app.clone();
    app.listen("exa-sync-abort", move |event| {
        let payload = serde_json::from_str::<serde_json::Value>(event.payload()).ok();
        let id = payload
            .as_ref()
            .and_then(|v| v.get("connectionId").and_then(|c| c.as_str()).map(sanitize_connection_id))
            .unwrap_or_default();
        if id.is_empty() {
            return;
        }
        let auto = payload
            .as_ref()
            .and_then(|v| v.get("auto"))
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        // "auth" means the session is genuinely dead (safe to drop the jar);
        // "timeout" is a hidden webview being throttled and says nothing about
        // the session.
        let reason = payload
            .as_ref()
            .and_then(|v| v.get("reason"))
            .and_then(|v| v.as_str())
            .unwrap_or("auth");
        let interactive = payload
            .as_ref()
            .and_then(|v| v.get("interactive"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let label = window_label(&id, interactive);
        let Some(w) = handle_for_exa_abort.get_webview_window(&label) else {
            return;
        };
        if interactive {
            // A sign-in window belongs to the user; the script keeps retrying.
            boot_log(&format!("exa-sync-abort: leaving the sign-in window for {id} open"));
            return;
        }
        boot_log(&format!("exa-sync-abort: closing {id} (auto={auto}, reason={reason})"));
        let _ = w.close();
        if reason == "timeout" && auto {
            // A throttled hidden read must not poison the connection: no
            // needs-login flag, the next page load retries from scratch.
            return;
        }
        // A background sync only flags the failure; a user-started one reopens
        // in a visible window they can act in (the frontend owns the key prefix
        // and pasted cookie, so it re-issues the open).
        notify_needs_login(&handle_for_exa_abort, &id, !auto);
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
        // Fresh data means the session is fine again.
        write_login_status(&id, false);
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
        // Close the window that ran the sync — it may be the hidden one or the
        // sign-in one the user just completed.
        for interactive in [false, true] {
            if let Some(w) =
                handle_for_exa_result.get_webview_window(&window_label(&id, interactive))
            {
                let _ = w.close();
            }
        }
        // Broadcast so the tray usage panel refreshes too, not just the
        // dashboard window that opened the sync.
        let _ = handle_for_exa_result.emit(
            "exa-sync-done",
            serde_json::json!({ "connectionId": id }),
        );
    });
}
