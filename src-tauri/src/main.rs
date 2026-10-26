// 9Router desktop shell (Tauri).
//
// DESIGN — zero-conflict with upstream:
//   * We do NOT modify cli/, src/, or next.config.mjs.
//   * We spawn the EXISTING Next.js standalone server as a child process:
//       `node <resources>/app/custom-server.js`   (custom-server.js injects the
//        real socket IP, exactly like the Docker/CLI entrypoint).
//   * The Dashboard is rendered in a native WebView pointed at
//     http://127.0.0.1:20129/dashboard (the server's own port).
//   * The system tray is Tauri-native, replacing the upstream systray2 Go binary
//     (no antivirus false-positives, no chmod dance).
//   * On app exit we SIGKILL the child so the port is released for next launch.
//
// DEV vs BUILD server ownership:
//   * Build/release: main.rs OWNS the server — it spawns `custom-server.js`
//     (bundled in resources) in setup() and kills it on exit.
//   * Dev: `beforeDevCommand` (see tauri.conf.json) starts the server itself
//     (`node .next/standalone/app/custom-server.js`) and Tauri waits for
//     devUrl to become reachable. main.rs must NOT spawn again (port clash),
//     so spawning is gated behind `!cfg!(debug_assertions)`.
//
// NODE PATH: reuses upstream's runtime layout. The server resolves sql.js /
// better-sqlite3 via NODE_PATH (see cli/hooks/sqliteRuntime.js), which the
// upstream runtime installs into ~/.9router/runtime. We just forward the same
// env the CLI would, so the existing self-heal logic keeps working untouched.
//
// NODE BINARY (Scheme A — user preinstalled Node):
//   Tauri apps launch from a non-interactive context where nvm's PATH injection
//   (normally done by ~/.nvm/nvm.sh in an interactive shell) is absent. So we
//   resolve the node binary explicitly:
//     1. $HOME/.nvm/alias/default  ->  <ver>  ->  ~/.nvm/versions/node/<ver>/bin/node
//     2. fall back to `node` on PATH (system installs, fnm, etc.)
//     3. last resort: literal "node" so the spawn error is clear.
//   No hardcoded user paths — portable across machines and upstream pulls.
//
// DATA_DIR: upstream `.env` hardcodes DATA_DIR=/var/lib/9router (a Linux/
// root assumption — Docker runs as root so it can write there). On macOS a
// normal user cannot write /var/lib/9router, and src/lib/mitmAliasCache.js
// reads process.env.DATA_DIR with NO fallback, causing
//   EACCES: permission denied, mkdir '/var/lib/9router/mitm'
// dataDir.js does fall back to ~/.9router when not writable, but that fallback
// is not used by mitmAliasCache.js. So we OVERRIDE DATA_DIR to
// $HOME/.9router in the spawned server's env. dotenv won't override an
// already-set env var, so the upstream `.env` value is effectively ignored.
// (dev mode does the same override in the `dev:server` npm script.)
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu, CheckMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Listener, Manager, Emitter,
    WebviewWindowBuilder,
};

const SERVER_PORT: &str = "20129";

/// JS injected into every page (placeholder + dashboard) for drag support
/// and external link interception. Also injected via eval() after navigation
/// because js_init_script may not re-run on WKWebView cross-origin navigation.
const PAGE_INIT_JS: &str = r#"
(function() {
  if (window.__9r_init) return; window.__9r_init = true;
  // Window dragging: click top 40px to drag (excludes buttons/links)
  window.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    var s = 'button, input, textarea, a, select, option, [role="button"], [contenteditable="true"]';
    if (e.target.closest && e.target.closest(s)) return;
    if (e.clientY <= 40 && window.__TAURI_INTERNALS__) {
      window.__TAURI_INTERNALS__.invoke("plugin:window|start_dragging");
    }
  }, true);
  // External link interception
  function _openExternal(url) {
    try {
      var u = new URL(url, location.href);
      if ((u.protocol === 'http:' || u.protocol === 'https:') &&
          u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
        if (window.__TAURI_INTERNALS__) {
          window.__TAURI_INTERNALS__.invoke('plugin:shell|open', { path: u.href });
        }
        return true;
      }
    } catch(e) {}
    return false;
  }
  document.addEventListener('click', function(e) {
    var a = e.target.closest && e.target.closest('a');
    if (!a || !a.href) return;
    if (_openExternal(a.href)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  var _origOpen = window.open;
  window.open = function(url) {
    if (url && _openExternal(url)) return null;
    return _origOpen ? _origOpen.apply(this, arguments) : null;
  };
})();
"#;

/// Injected into the Exa dashboard window opened by the quota page's
/// "Sync Exa" button.
///
/// dashboard.exa.ai sits behind Vercel's bot challenge, so only a real browser
/// context can read its usage APIs. This script runs inside that context, calls
/// the same endpoints the dashboard itself calls, and hands the JSON back over
/// the Tauri event channel. Events (not custom commands) because remote pages
/// are blocked by the ACL — the same reason `hide-to-tray` uses an event.
const EXA_SYNC_JS_TEMPLATE: &str = r#"
(function () {
  if (location.hostname !== "dashboard.exa.ai") return;
  if (window.__9r_exa_sync) return;
  window.__9r_exa_sync = true;

  var CONNECTION_ID = "__CONNECTION_ID__";
  var EXPECTED_PREFIX = "__KEY_PREFIX__";
  var sent = false;
  var banner = null;

  // The volume/keys endpoints take undocumented params (teamId + date range),
  // and the volume call may be a POST with a JSON body. Record the dashboard's
  // own request (url + method + body) and replay it first, instead of guessing.
  var seen = { volume: null, keys: null };
  (function () {
    function pickHeaders(headers) {
      if (!headers) return null;
      var picked = {};
      try {
        if (typeof Headers !== "undefined" && headers instanceof Headers) {
          headers.forEach(function (value, name) {
            var key = name.toLowerCase();
            if (key === "content-type" || key.indexOf("x-") === 0) picked[key] = value;
          });
        } else {
          Object.keys(headers).forEach(function (name) {
            var key = name.toLowerCase();
            if (key === "content-type" || key.indexOf("x-") === 0) picked[key] = headers[name];
          });
        }
      } catch (e) { return null; }
      return Object.keys(picked).length ? picked : null;
    }

    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        var url = (typeof input === "string" ? input : (input && input.url)) || "";
        var method = (init && init.method) || (input && input.method) || "GET";
        var body = init && typeof init.body === "string" ? init.body : null;
        var req = { url: url, method: method, body: body, headers: pickHeaders(init && init.headers) };
        if (url.indexOf("usage-traffic") !== -1) seen.volume = req;
        else if (url.indexOf("api-keys") !== -1) seen.keys = req;
      } catch (e) {}
      return origFetch.apply(this, arguments);
    };
  })();

  // Debug trail of every request this sync attempted (url/method/status), kept
  // in the snapshot so a failing endpoint can be diagnosed without a DevTools
  // session inside the app's webview.
  var attempts = [];

  function requestJSON(req) {
    if (!req || !req.url) return Promise.resolve(null);
    var headers = { accept: "application/json" };
    if (req.headers) {
      Object.keys(req.headers).forEach(function (k) { headers[k] = req.headers[k]; });
    }
    var opts = {
      method: req.method || "GET",
      credentials: "include",
      headers: headers
    };
    if (req.body != null) {
      if (!headers["content-type"]) headers["content-type"] = "application/json";
      opts.body = req.body;
    }
    return fetch(req.url, opts)
      .then(function (r) {
        attempts.push({ url: req.url, method: opts.method, status: r.status });
        return r.ok ? r.json() : null;
      })
      .catch(function () {
        attempts.push({ url: req.url, method: opts.method, status: "error" });
        return null;
      });
  }

  function getJSON(url) {
    return requestJSON({ url: url, method: "GET" });
  }

  function isKeys(json) {
    return !!json && typeof json === "object" && Array.isArray(json.apiKeys);
  }

  function isVolume(json) {
    return !!json && typeof json === "object" &&
      (Array.isArray(json.rows) || Array.isArray(json.data) || typeof json.total === "number");
  }

  function firstValid(candidates, accept) {
    var i = 0;
    function next() {
      if (i >= candidates.length) return Promise.resolve(null);
      var req = candidates[i++];
      if (!req) return next();
      return requestJSON(req).then(function (json) {
        return accept(json) ? json : next();
      });
    }
    return next();
  }

  // Verified against the live dashboard (2026-10):
  //   GET  /api/get-api-keys              -> { apiKeys: [...] }   (/api/api-keys is 404)
  //   POST /api/usage-traffic/volume      -> { window, groupBy, rows }
  //        body: { startDate, endDate, groupBy: "endpoint" }      (GET is 405; teamId is rejected)
  // Replay the dashboard's own captured request first, then fall back to the
  // contract above.
  function getKeys() {
    return firstValid([
      seen.keys,
      { url: "/api/get-api-keys", method: "GET" }
    ], isKeys);
  }

  function getVolume() {
    var now = new Date();
    var day = function (d) { return d.toISOString().slice(0, 10); };
    // 30-day window inclusive, matching the dashboard's default range.
    var startDate = day(new Date(now.getTime() - 29 * 24 * 3600 * 1000));
    var endDate = day(now);

    return firstValid([
      seen.volume,
      {
        url: "/api/usage-traffic/volume",
        method: "POST",
        body: JSON.stringify({ startDate: startDate, endDate: endDate, groupBy: "endpoint" })
      }
    ], isVolume);
  }

  function showBanner(text) {
    if (banner) { banner.textContent = text; return; }
    banner = document.createElement("div");
    banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:10px 16px;background:#7c2d12;color:#fff;font:13px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3)";
    banner.textContent = text;
    document.documentElement.appendChild(banner);
  }

  function clearBanner() {
    if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
    banner = null;
  }

  function tick() {
    if (sent) return;
    getJSON("/api/get-credits").then(function (credits) {
      // Not logged in yet — the login page also answers, just without credits.
      if (!credits || typeof credits.orbCreditsInCents !== "number") return;

      getJSON("/api/team-context").then(function (teamContext) {
        attempts = [];
        Promise.all([getKeys(), getVolume()]).then(function (results) {
          var keys = results[0];
          var volume = results[1];

          // Exa credits are team-level, so the logged-in account must own the
          // key behind this connection — otherwise the balance is someone else's.
          if (EXPECTED_PREFIX && isKeys(keys)) {
            var owns = keys.apiKeys.some(function (k) {
              return k && k.bearerPrefix === EXPECTED_PREFIX;
            });
            if (!owns) {
              showBanner("当前登录的 Exa 账户不拥有这个连接使用的 API Key。请在此页面切换到对应账户，检测到匹配后会自动完成同步。");
              return;
            }
          }
          clearBanner();
          sent = true;

          return window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
            event: "exa-sync-result",
            payload: {
              connectionId: CONNECTION_ID,
              credits: credits,
              volume: volume || null,
              teamContext: teamContext || null,
              apiKeys: keys || null,
              debug: attempts.slice(0, 40),
              syncedAt: new Date().toISOString()
            }
          });
        }).catch(function () { sent = false; });
      });
    });
  }

  setTimeout(tick, 600);
  setInterval(tick, 3000);
})();
"#;

const EXA_SYNC_DIR: &str = "exa-sync";

/// The focused webview window, if any. Used by the Window menu so Cmd+W /
/// Cmd+M act on the Exa sync window when it is in front, not the dashboard.
fn focused_webview_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
}

/// Connection ids are UUIDs; strip anything else before using one as a filename.
fn sanitize_connection_id(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

/// Open (or focus) the Exa dashboard window used by the sync button.
///
/// One window per connection: two Exa accounts can be synced side by side, and
/// each window's injected script carries its own expected key prefix.
fn open_exa_connect(app: &AppHandle, connection_id: &str, key_prefix: Option<&str>) {
    let conn = sanitize_connection_id(connection_id);
    if conn.is_empty() {
        boot_log("open_exa_connect: invalid connection id");
        return;
    }

    let label = format!("exa-connect-{conn}");
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }

    let prefix: String = key_prefix
        .unwrap_or("")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let script = EXA_SYNC_JS_TEMPLATE
        .replace("__CONNECTION_ID__", &conn)
        .replace("__KEY_PREFIX__", &prefix);
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
        .initialization_script(&script)
        // WKWebView does not reliably re-run js_init_script across cross-origin
        // navigations (login → dashboard), so eval it again on every page load.
        .on_page_load(move |webview, payload| {
            if payload.url().host_str() == Some("dashboard.exa.ai") {
                let _ = webview.eval(script_for_load.as_str());
            }
        })
        .build()
    {
        Ok(_) => boot_log(&format!("open_exa_connect: window opened for {conn}")),
        Err(e) => boot_log(&format!("open_exa_connect: build failed: {e}")),
    }
}

/// Append a line to ~/.9router/tauri-boot.log. Used to diagnose launch issues
/// (e.g. white screen when the .app is moved to /Applications) where the GUI
/// process's stdout/stderr is discarded and we can't see the server state.
fn boot_log(line: &str) {
    if let Some(home) = std::env::var("HOME").ok() {
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

/// Tracks the server child we spawned (release mode only). In dev mode the
/// server is owned by `beforeDevCommand`, so this stays None and we never kill it.
struct ServerChild(Mutex<Option<Child>>);

/// Tracks lightweight mode state (shared between tray menu and event handlers).
struct LightweightMode(std::sync::atomic::AtomicBool);

/// Stores the check menu item so we can update its checked state.
struct LightweightMenuItem(std::sync::Mutex<Option<CheckMenuItem<tauri::Wry>>>);

/// Resolve the node binary, nvm-aware (see header note). Returns a path/name
/// suitable for Command::new.
fn node_binary() -> String {
    if let Some(home) = std::env::var("HOME").ok() {
        let nvm_root = PathBuf::from(&home).join(".nvm");
        // 1) nvm default alias -> version dir
        let alias = nvm_root.join("alias").join("default");
        if let Ok(ver) = std::fs::read_to_string(&alias) {
            let ver = ver.trim();
            if !ver.is_empty() {
                let candidate = nvm_root
                    .join("versions")
                    .join("node")
                    .join(ver)
                    .join("bin")
                    .join("node");
                if candidate.exists() {
                    return candidate.to_string_lossy().into_owned();
                }
            }
        }
        // 2) any installed nvm version (alphabetical, picks highest if sorted)
        let versions_dir = nvm_root.join("versions").join("node");
        if let Ok(mut entries) = std::fs::read_dir(&versions_dir) {
            let mut found: Vec<PathBuf> = Vec::new();
            while let Some(Ok(e)) = entries.next() {
                let p = e.path().join("bin").join("node");
                if p.exists() {
                    found.push(p);
                }
            }
            if !found.is_empty() {
                found.sort();
                return found.pop().unwrap().to_string_lossy().into_owned();
            }
        }
    }
    // 3) Common system installs (Homebrew on Apple Silicon & Intel, nodejs.org)
    //    When launched from Finder, PATH is minimal (/usr/bin:/bin:/usr/sbin:/sbin)
    //    so `node` is not found even if installed system-wide.
    for candidate in [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
    ] {
        if std::path::Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }
    // 4) PATH / literal fallback
    "node".to_string()
}

/// Path to the standalone entrypoint inside the app resources dir.
/// Tauri places the bundled standalone build under <resourcesDir>/standalone
/// (see tauri.conf.json `bundle.resources["../standalone-dist": "standalone"]`).
/// custom-server.js is copied to the standalone top level by `build:standalone`,
/// so its `require("./server.js")` resolves next to it.
fn standalone_entry(resources: &PathBuf) -> PathBuf {
    resources.join("standalone").join("custom-server.js")
}

/// Replicate the env the upstream CLI builds for the child server.
/// We forward the user's HOME so ~/.9router/runtime (sql.js / better-sqlite3)
/// resolves exactly as it does for the CLI. NODE_PATH is left to the upstream
/// runtime's own self-heal (hooks/sqliteRuntime.js) which reads ~/.9router.
/// We also prepend the resolved node's bin dir to PATH so any child node
/// subprocess (e.g. the runtime self-heal npm install) finds the same node.
/// DATA_DIR is overridden to ~/.9router (see header note) so the server
/// never tries to write to /var/lib/9router on macOS.
fn server_env(node_bin: &str) -> Vec<(String, String)> {
    let node_bin_dir = std::path::Path::new(node_bin)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();

    let mut path_val = node_bin_dir;
    if let Ok(existing) = std::env::var("PATH") {
        if !existing.is_empty() {
            path_val = format!("{path_val}:{existing}");
        }
    }

    let mut env: Vec<(String, String)> = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        env.push(("HOME".into(), home.clone()));
        // Override DATA_DIR so all runtime data (db, mitm cache) lands in a
        // writable location. dotenv won't override an already-set env var.
        env.push(("DATA_DIR".into(), format!("{home}/.9router")));
    }
    env.push(("PATH".into(), path_val));
    env.push(("PORT".into(), SERVER_PORT.into()));
    env.push(("HOSTNAME".into(), "127.0.0.1".into()));
    env.push(("NODE_ENV".into(), "production".into()));
    env.push(("NEXT_TELEMETRY_DISABLED".into(), "1".into()));
    // Override BASE_URL / NEXT_PUBLIC_BASE_URL: the bundled .env has port 20128
    // (the CLI default), but we run on 20129. Without this, internal API calls
    // (e.g. cloud sync) hit a dead port and can hang startup.
    let base = format!("http://127.0.0.1:{SERVER_PORT}");
    env.push(("BASE_URL".into(), base.clone()));
    env.push(("NEXT_PUBLIC_BASE_URL".into(), base));
    // Bind to loopback only - the WebView is local; no LAN exposure needed.
    env
}

/// Spawn the Next.js standalone server as a detached child and track it.
/// Returns Err if the entrypoint is missing (run `pnpm run build:standalone` first).
fn spawn_server(app: &AppHandle) -> std::io::Result<()> {
    let resources = app.path().resource_dir()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::NotFound, format!("resource dir: {e}")))?;
    let entry = standalone_entry(&resources);
    boot_log(&format!("resource_dir = {:?}", resources));
    boot_log(&format!("standalone entry = {:?} (exists={})", entry, entry.exists()));
    if !entry.exists() {
        boot_log("ERROR: standalone entry not found");
        eprintln!(
            "[9router] standalone entry not found at {:?}. Run `pnpm run build:standalone` first.",
            entry
        );
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "standalone build missing",
        ));
    }

    let node = node_binary();
    boot_log(&format!("node binary = {node}"));
    eprintln!("[9router] spawning server with node: {node}");

    // Redirect server stdout+stderr to a log file. When the app is launched
    // from Finder (e.g. from /Applications), stderr goes to the system log
    // which is hard to access. A file redirect (unlike a pipe) never deadlocks
    // because the OS writes directly to disk without a fixed-size buffer.
    let log_path = std::env::var("HOME")
        .map(|h| std::path::Path::new(&h).join(".9router").join("tauri-server.log"))
        .ok();
    let (stdout, stderr) = if let Some(ref p) = log_path {
        let _ = std::fs::create_dir_all(p.parent().unwrap());
        match std::fs::File::create(p) {
            Ok(f) => {
                let stdout = Stdio::from(f.try_clone().unwrap_or_else(|_| {
                    std::fs::OpenOptions::new().write(true).open(p).unwrap()
                }));
                let stderr = Stdio::from(f);
                boot_log(&format!("server logs -> {:?}", p));
                (stdout, stderr)
            }
            Err(_) => (Stdio::null(), Stdio::inherit()),
        }
    } else {
        (Stdio::null(), Stdio::inherit())
    };

    let child = Command::new(&node)
        .arg(&entry)
        .current_dir(&resources.join("standalone"))
        .envs(server_env(&node))
        .stdout(stdout)
        .stderr(stderr)
        .spawn()?;

    boot_log("server child spawned OK");
    app.manage(ServerChild(Mutex::new(Some(child))));
    Ok(())
}

/// Kill the server child (best-effort) so the port is freed. No-op if we don't
/// own the server (dev mode — it's owned by beforeDevCommand).
fn stop_server(app: &AppHandle) {
    if let Some(state) = app.try_state::<ServerChild>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(mut child) = guard.take() {
                let pid = child.id();
                boot_log(&format!("stop_server: sending SIGTERM to pid {pid}"));
                // Send SIGTERM for graceful shutdown (Node catches it and exits
                // cleanly, flushing SQLite writes etc.)
                let _ = std::process::Command::new("kill")
                    .arg("-TERM")
                    .arg(pid.to_string())
                    .spawn();
                // Wait up to 3 seconds for graceful exit.
                let mut exited = false;
                for _ in 0..30 {
                    match child.try_wait() {
                        Ok(Some(_)) => { exited = true; break; }
                        Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
                        Err(_) => break,
                    }
                }
                if !exited {
                    boot_log("stop_server: SIGTERM timeout, sending SIGKILL");
                    let _ = child.kill();
                    let _ = child.wait();
                } else {
                    boot_log("stop_server: graceful exit confirmed");
                }
            }
        }
    }
}

/// Build a Tauri-native tray menu (replaces upstream systray2 tray.js).
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    // All items are CheckMenuItem so macOS reserves the check column for
    // every row -> text stays aligned whether or not a check is shown.
    let show_item = CheckMenuItem::with_id(app, "show", "Dashboard", true, false, None::<&str>)?;
    let lightweight_item = CheckMenuItem::with_id(app, "lightweight", "Lightweight Mode", true, false, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let quit_item = CheckMenuItem::with_id(app, "quit", "Quit", true, false, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show_item, &sep2, &lightweight_item, &sep1, &quit_item])?;

    let _tray = TrayIconBuilder::with_id("9router-tray")
        .tooltip("9Router")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .icon(app.default_window_icon().cloned().unwrap_or_else(|| {
            tauri::image::Image::from_bytes(include_bytes!("../../public/icons/32x32.png")).unwrap()
        }))
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                show_dashboard(app);
            }
            "lightweight" => {
                if let Some(state) = app.try_state::<LightweightMode>() {
                    let was_on = state.0.swap(!state.0.load(std::sync::atomic::Ordering::Relaxed), std::sync::atomic::Ordering::Relaxed);
                    if !was_on {
                        // Turned ON: close window + hide Dock
                        boot_log("lightweight: ON - closing window + hiding Dock");
                        #[cfg(target_os = "macos")]
                        set_dock_visible(false);
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.close();
                        }
                    } else {
                        // Turned OFF: recreate window
                        boot_log("lightweight: OFF - recreating window");
                        show_dashboard(app);
                    }
                }
            }
            "quit" => {
                stop_server(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_dashboard(tray.app_handle());
            }
        })
        .build(app)?;

    // Store the lightweight check item so show_dashboard can uncheck it.
    app.manage(LightweightMenuItem(std::sync::Mutex::new(Some(lightweight_item))));

    Ok(())
}

/// Build the macOS native menu bar. Without this, Cmd+C/Cmd+V/Cmd+A etc.
/// do not work in text inputs because macOS routes keyboard shortcuts through
/// the menu bar. The predefined items are handled by the OS automatically.
fn build_menu(app: &AppHandle) -> tauri::Result<()> {
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

/// Toggle the macOS Dock icon. When hiding the window to tray, set to
/// Accessory (no Dock icon); when showing, set to Regular (Dock icon visible).
#[cfg(target_os = "macos")]
fn set_dock_visible(visible: bool) {
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

/// URL of the dashboard, used when (re)creating the window.
const DASHBOARD_URL: &str = "http://127.0.0.1:20129/dashboard";

/// (Re)create the main webview window if it doesn't exist, then navigate
/// to the dashboard. Used by "Open Dashboard" when the window was destroyed
/// in lightweight mode.
fn show_dashboard(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    set_dock_visible(true);

    // Clear lightweight mode flag so normal close behavior resumes.
    if let Some(state) = app.try_state::<LightweightMode>() {
        state.0.store(false, std::sync::atomic::Ordering::Relaxed);
    }
    // Uncheck the lightweight menu item.
    if let Some(state) = app.try_state::<LightweightMenuItem>() {
        if let Ok(guard) = state.0.lock() {
            if let Some(check) = guard.as_ref() {
                let _ = check.set_checked(false);
            }
        }
    }

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
            if std::net::TcpStream::connect("127.0.0.1:20129").is_ok() {
                if let Some(w) = app2.get_webview_window("main") {
                    let _ = w.navigate(DASHBOARD_URL.parse().unwrap());
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

/// Destroy the main window to free WebView memory. The server keeps running.
/// Called by "Enter Lightweight Mode" tray menu item.
fn close_window_for_lightweight(app: &AppHandle) {
    boot_log("close_window_for_lightweight: closing window to free memory");
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.close();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
fn main() {
    tauri::Builder::default()
        // Single-instance lock: if a second instance is launched, focus the
        // existing window instead of spawning a duplicate server (which would
        // fail with EADDRINUSE on port 20129).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        // Remember window position and size across launches.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // Shell plugin: provides `open` command for opening URLs in the system
        // browser. Used by the injected JS for external link interception.
        .plugin(tauri_plugin_shell::init())
        // Drag region + external link interception: js_init_script runs on
        // the initial page; for the navigated dashboard page we also eval()
        // the same JS after navigate() completes (see poller below).
        .plugin(
            tauri::plugin::Builder::<_, ()>::new("drag-helper")
                .js_init_script(PAGE_INIT_JS.to_string())
                .build()
        )
        .setup(|app| {
            let handle = app.handle();
            app.manage(LightweightMode(std::sync::atomic::AtomicBool::new(false)));

            // In release/build mode we own the server (spawn + kill). In dev mode
            // `beforeDevCommand` already started it, so skip to avoid a port clash.
            #[cfg(not(debug_assertions))]
            {
                if let Err(e) = spawn_server(handle) {
                    boot_log(&format!("ERROR: failed to start server: {e}"));
                    eprintln!("[9router] failed to start server: {e}");
                    // Show error in the webview placeholder page so the user
                    // isn't left with a blank screen.
                    if let Some(w) = handle.get_webview_window("main") {
                        let msg = e.to_string().replace('\'', "\\'");
                        let js = format!(
                            "var s=document.querySelector('.sub');if(s){{s.textContent='Server error: {msg}'}}\
                             var l=document.querySelector('.logo');if(l){{l.textContent='!'}}"
                        );
                        let _ = w.eval(&js);
                    }
                } else {
                    // Wait for the spawned server to bind, then navigate the
                    // webview to it from Rust. We must NOT rely on the file://
                    // frontend to do this: a file:// page executing fetch() /
                    // location.replace() / navigate() to an http:// origin is
                    // blocked by the WebView's same-origin policy (opaque
                    // origin), which is exactly why the window stayed blank.
                    // Rust's native WebviewWindow::navigate() is not subject to
                    // that JS restriction, so we probe the port here and jump.
                    let handle2 = handle.clone();
                    std::thread::spawn(move || {
                        let addr = format!("127.0.0.1:{SERVER_PORT}");
                        let url = format!("http://127.0.0.1:{SERVER_PORT}/dashboard");
                        boot_log("poller: waiting for server port");
                        for _ in 0..300 {
                            if std::net::TcpStream::connect(&addr).is_ok() {
                                if let Some(w) = handle2.get_webview_window("main") {
                                    boot_log("poller: server up - navigating webview");
                                    eprintln!("[9router] server up - navigating webview");
                                    let _ = w.navigate(url.parse().unwrap_or_else(|_| {
                                        format!("http://127.0.0.1:{SERVER_PORT}/dashboard")
                                            .parse().unwrap()
                                    }));
                                    // Inject page init JS after a short delay so
                                    // the dashboard DOM is ready. The js_init_script
                                    // from the plugin may not re-run on cross-origin
                                    // navigation (file:// -> http://), so we eval()
                                    // it manually here. The JS is idempotent (guards
                                    // with window.__9r_init).
                                    let handle4 = handle2.clone();
                                    std::thread::spawn(move || {
                                        std::thread::sleep(std::time::Duration::from_millis(2000));
                                        if let Some(w) = handle4.get_webview_window("main") {
                                            boot_log("injecting PAGE_INIT_JS via eval");
                                            let _ = w.eval(PAGE_INIT_JS);
                                        }
                                    });
                                }
                                // Start a health-check watchdog: if the server
                                // crashes at runtime, show an error in the webview
                                // instead of leaving the user on a dead page.
                                let handle3 = handle2.clone();
                                std::thread::spawn(move || {
                                    let addr = format!("127.0.0.1:{SERVER_PORT}");
                                    loop {
                                        std::thread::sleep(std::time::Duration::from_secs(30));
                                        if std::net::TcpStream::connect(&addr).is_err() {
                                            boot_log("watchdog: server port unreachable - server may have crashed");
                                            if let Some(w) = handle3.get_webview_window("main") {
                                                let _ = w.eval(
                                                    "var s=document.querySelector('.sub');if(s){s.textContent='Server connection lost. The proxy server may have crashed. Please restart 9Router.'}\
                                                     var l=document.querySelector('.logo');if(l){l.textContent='!'}"
                                                );
                                            }
                                            break;
                                        }
                                    }
                                });
                                return;
                            }
                            std::thread::sleep(std::time::Duration::from_millis(100));
                        }
                        boot_log("ERROR: server did not come up within ~30s");
                        eprintln!("[9router] server did not come up within ~30s");
                        // Show timeout error in the webview.
                        if let Some(w) = handle2.get_webview_window("main") {
                            let _ = w.eval(
                                "var s=document.querySelector('.sub');if(s){s.textContent='Server failed to start within 30s. Check ~/.9router/tauri-boot.log for details.'}\
                                 var l=document.querySelector('.logo');if(l){l.textContent='!'}"
                            );
                        }
                    });
                }
            }
            #[cfg(debug_assertions)]
            {
                eprintln!("[9router] dev mode — server assumed running via beforeDevCommand");
            }

            if let Err(e) = build_menu(handle) {
                boot_log(&format!("build_menu FAILED: {e}"));
                eprintln!("[9router] menu init failed (non-fatal): {e}");
            }
            if let Err(e) = build_tray(handle) {
                eprintln!("[9router] tray init failed (non-fatal): {e}");
            }

            // Listen for "hide-to-tray" event from the frontend. We use events
            // (not custom commands) because events work on remote URLs while
            // custom commands get blocked by the ACL. The frontend emits this
            // when the user chooses "Minimize to tray" in the close dialog.
            let handle_for_hide = handle.clone();
            handle.listen("hide-to-tray", move |_event| {
                boot_log("hide-to-tray: hiding window + Dock");
                #[cfg(target_os = "macos")]
                set_dock_visible(false);
                if let Some(win) = handle_for_hide.get_webview_window("main") {
                    let _ = win.hide();
                }
            });

            // Quota page "Sync Exa" button → open the dashboard webview. The
            // injected script reads the account's credits/volume from inside
            // that real browser context (the only place they are readable).
            let handle_for_exa_open = handle.clone();
            handle.listen("open-exa-connect", move |event| {
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

                if let Some(id) = connection_id {
                    let app = handle_for_exa_open.clone();
                    let _ = handle_for_exa_open
                        .run_on_main_thread(move || open_exa_connect(&app, &id, key_prefix.as_deref()));
                } else {
                    boot_log("open-exa-connect: missing connectionId");
                }
            });

            // The Exa webview hands its JSON back over the event channel.
            // Persist it beside the DB so the quota handler can read it with no
            // extra API route, then tell the main window to refresh the card.
            let handle_for_exa_result = handle.clone();
            handle.listen("exa-sync-result", move |event| {
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

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Only the main window has the quit/minimize-to-tray dialog.
                // Child webviews (Exa sync) must close normally, and emitting
                // "close-requested" from them would broadcast to the main
                // window and trigger its quit dialog instead.
                if window.label() != "main" {
                    return;
                }
                // In lightweight mode, let the window close to free memory.
                if let Some(state) = window.app_handle().try_state::<LightweightMode>() {
                    if state.0.load(std::sync::atomic::Ordering::Relaxed) {
                        return; // allow close
                    }
                }
                api.prevent_close();
                let _ = window.emit("close-requested", ());
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quit" => {
                stop_server(app);
                app.exit(0);
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
        })
        .build(tauri::generate_context!())
        .expect("error while running 9Router desktop")
        .run(|app, event| {
            match event {
                tauri::RunEvent::ExitRequested { api, .. } => {
                    // Prevent exit when window is closed in lightweight mode.
                    // The app stays alive with just the tray icon.
                    if app.get_webview_window("main").is_none() {
                        api.prevent_exit();
                    }
                }
                tauri::RunEvent::Exit => {
                    stop_server(app);
                }
                _ => {}
            }
        });

}
