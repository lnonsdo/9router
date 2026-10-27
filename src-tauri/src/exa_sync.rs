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

/// Open (or leave alone) the Exa dashboard window used by the sync button.
///
/// One window per connection: two Exa accounts can be synced side by side, and
/// each window's injected script carries its own expected key prefix.
///
/// Every window is created with `visible(false)`, so a sync never puts a window
/// (or the app) in front of the user. tao only orders a window front when it is
/// created visible, so nothing here needs to hide it again — and it must not:
/// calling `hide()` right after build put WKWebView to sleep and the page never
/// loaded. A window is only shown for a sync the user started, when Exa needs
/// them (login page / wrong account).
fn open_exa_connect(
    app: &AppHandle,
    connection_id: &str,
    key_prefix: Option<&str>,
    pasted_cookie: Option<&str>,
    auto: bool,
) {
    let conn = sanitize_connection_id(connection_id);
    if conn.is_empty() {
        boot_log("open_exa_connect: invalid connection id");
        return;
    }

    let label = format!("exa-connect-{conn}");
    if app.get_webview_window(&label).is_some() {
        // A sync is already running (or waiting for a login): leave it alone
        // rather than dragging a hidden window onto the screen.
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
    let conn_for_load = conn.clone();
    let landing: tauri::Url = match "https://dashboard.exa.ai/billing".parse() {
        Ok(u) => u,
        Err(_) => return,
    };
    // A cookiejar saved after a successful sync wins: it is the freshest
    // credential. The pasted cookie is the bootstrap used before any sync has
    // worked (no password manager / Google SSO inside the app's webview).
    let mut saved_cookies = load_cookies(&conn);
    if let Some((name, value)) = parse_pasted_cookie(pasted_cookie) {
        if saved_cookies.is_empty() {
            saved_cookies.push((name, value));
        }
    }
    // Start on about:blank so the saved jar can be poured in before the
    // dashboard's first request (an unauthenticated first request is what
    // bounced the window to the login page and lost the session).
    let needs_cookie_preload = !saved_cookies.is_empty();
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
        .visible(false)
        // Do not let a background sync activate the app (the main window
        // flashing into view). Focus only decides who is key, not visibility.
        .focused(false)
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
                // user-started sync surfaces the login page instead.
                "auth.exa.ai" => {
                    if auto {
                        boot_log("exa-sync: login required (silent)");
                        let _ = webview.close();
                        notify_needs_login(webview.app_handle(), &conn_for_load, true);
                    } else {
                        boot_log("exa-sync: login required (showing window)");
                        let _ = webview.show();
                        let _ = webview.set_focus();
                    }
                }
                other => boot_log(&format!("exa-sync: page {other}")),
            }
        })
        .build()
    {
        Ok(_) => {
            boot_log(&format!("open_exa_connect: window opened for {conn}"));
            if start_on_blank {
                if let Some(w) = app.get_webview_window(&label) {
                    inject_cookies(&w, &saved_cookies);
                    // Now that the jar is loaded, do the real navigation.
                    let _ = w.navigate(landing);
                }
            }
            close_stuck_window(app.clone(), label.clone(), conn.clone());
        }
        Err(e) => boot_log(&format!("open_exa_connect: build failed: {e}")),
    }
}

/// Cookies are what keep this sync silent: WKWebView sometimes drops the
/// dashboard session (leaving a valid server-side session behind), and a fresh
/// login window is then the only alternative. We keep a copy ourselves and
/// pour it back in before the first navigation.
fn cookie_file(connection_id: &str) -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(
        PathBuf::from(home)
            .join(".9router")
            .join(EXA_SYNC_DIR)
            .join(format!("{}.cookies.json", sanitize_connection_id(connection_id))),
    )
}

fn load_cookies(connection_id: &str) -> Vec<(String, String)> {
    let Some(path) = cookie_file(connection_id) else { return Vec::new() };
    let Ok(raw) = std::fs::read_to_string(path) else { return Vec::new() };
    let Ok(parsed) = serde_json::from_str::<Vec<serde_json::Value>>(&raw) else {
        return Vec::new();
    };
    parsed
        .into_iter()
        .filter_map(|entry| {
            let name = entry.get("name")?.as_str()?.to_string();
            let value = entry.get("value")?.as_str()?.to_string();
            if name.is_empty() || value.is_empty() { None } else { Some((name, value)) }
        })
        .collect()
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

fn inject_cookies(window: &tauri::WebviewWindow, cookies: &[(String, String)]) {
    if cookies.is_empty() {
        return;
    }
    let mut applied = 0usize;
    for (name, value) in cookies {
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
    boot_log(&format!("exa-sync: injected {applied}/{} saved cookies", cookies.len()));
}

/// Keep the dashboard cookies after a successful read so the next sync can
/// start logged in even if the webview's own store lost them.
fn save_cookies(window: &tauri::WebviewWindow, connection_id: &str) {
    // `cookies()` rather than `cookies_for_url`: that helper drops
    // `Domain=.exa.ai` cookies, because it compares the domain for equality.
    let Ok(cookies) = window.cookies() else { return };
    let payload: Vec<serde_json::Value> = cookies
        .iter()
        .filter(|c| {
            c.domain()
                .map(|d| d.trim_start_matches('.').ends_with("exa.ai"))
                .unwrap_or(false)
        })
        .map(|c| serde_json::json!({ "name": c.name(), "value": c.value() }))
        .collect();
    if payload.is_empty() {
        return;
    }
    let Some(path) = cookie_file(connection_id) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let body = serde_json::Value::Array(payload).to_string();
    if std::fs::write(&path, body).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        boot_log(&format!("exa-sync: saved cookies for {connection_id}"));
    }
}

/// A hidden sync window that is still around after the script's own give-up
/// timer means the page never ran (bot challenge, dead host, WebKit stall).
/// Close it so no invisible webview is left behind, and mark the connection as
/// needing a sign-in: reopening it visibly is the only way forward. Visible
/// windows are the login prompts a user asked for, so they are never touched.
fn close_stuck_window(app: AppHandle, label: String, connection_id: String) {
    std::thread::spawn(move || {
        // Hidden webviews get their timers throttled, so a single in-page
        // request can take ~25s; leave room for the script's own give-up path
        // before stepping in.
        std::thread::sleep(std::time::Duration::from_secs(180));
        if let Some(w) = app.get_webview_window(&label) {
            if !w.is_visible().unwrap_or(false) {
                boot_log(&format!("exa-sync: closing stuck window {label}"));
                let _ = w.close();
                notify_needs_login(&app, &connection_id, false);
            }
        }
    });
}

/// Tell the quota page that the Exa session behind a connection is gone, so it
/// can ask for a manual refresh instead of silently showing stale numbers.
/// `drop_cookies` clears the saved jar when the failure is an auth rejection —
/// re-injecting a dead jar on every sync would only repeat the failure.
fn notify_needs_login(app: &AppHandle, connection_id: &str, drop_cookies: bool) {
    write_login_status(connection_id, true);
    if drop_cookies {
        if let Some(path) = cookie_file(connection_id) {
            let _ = std::fs::remove_file(path);
        }
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit(
            "exa-sync-needs-login",
            serde_json::json!({ "connectionId": connection_id }),
        );
    }
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

        if let Some(id) = connection_id {
            let app = handle_for_exa_open.clone();
            let _ = handle_for_exa_open.run_on_main_thread(move || {
                open_exa_connect(&app, &id, key_prefix.as_deref(), pasted_cookie.as_deref(), auto)
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
    // closed and reported; a user-started one is revealed so they can act.
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
        if let Some(w) = handle_for_exa_abort.get_webview_window(&format!("exa-connect-{id}")) {
            if auto {
                boot_log(&format!("exa-sync-abort: closing {id}"));
                let _ = w.close();
                notify_needs_login(&handle_for_exa_abort, &id, true);
            } else {
                boot_log(&format!("exa-sync-abort: revealing {id}"));
                let _ = w.show();
                let _ = w.set_focus();
            }
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
        // Fresh data means the session is fine again.
        write_login_status(&id, false);
        if let Some(w) = handle_for_exa_result.get_webview_window(&format!("exa-connect-{id}")) {
            save_cookies(&w, &id);
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
