//! Lifecycle of the bundled Next.js standalone server.
//!
//! DEV vs BUILD server ownership:
//!   * Build/release: we OWN the server — spawn `custom-server.js` in setup()
//!     and kill it on exit.
//!   * Dev: `beforeDevCommand` (see tauri.conf.json) starts the server itself
//!     and Tauri waits for devUrl to become reachable. We must NOT spawn again
//!     (port clash), so spawning is gated behind `!cfg!(debug_assertions)`.
//!
//! NODE BINARY (Scheme A — user preinstalled Node):
//!   Tauri apps launch from a non-interactive context where nvm's PATH injection
//!   (normally done by ~/.nvm/nvm.sh in an interactive shell) is absent. So we
//!   resolve the node binary explicitly:
//!     1. $HOME/.nvm/alias/default  ->  <ver>  ->  ~/.nvm/versions/node/<ver>/bin/node
//!     2. fall back to `node` on PATH (system installs, fnm, etc.)
//!     3. last resort: literal "node" so the spawn error is clear.
//!   No hardcoded user paths — portable across machines and upstream pulls.
//!
//! DATA_DIR: upstream `.env` hardcodes DATA_DIR=/var/lib/9router (a Linux/
//! root assumption — Docker runs as root so it can write there). On macOS a
//! normal user cannot write /var/lib/9router, and src/lib/mitmAliasCache.js
//! reads process.env.DATA_DIR with NO fallback, causing
//!   EACCES: permission denied, mkdir '/var/lib/9router/mitm'
//! dataDir.js does fall back to ~/.9router when not writable, but that fallback
//! is not used by mitmAliasCache.js. So we OVERRIDE DATA_DIR to
//! $HOME/.9router in the spawned server's env. dotenv won't override an
//! already-set env var, so the upstream `.env` value is effectively ignored.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use crate::consts::SERVER_PORT;
use crate::logging::boot_log;
use crate::state::ServerChild;

/// Resolve the node binary, nvm-aware. Returns a path/name suitable for
/// Command::new.
pub(crate) fn node_binary() -> String {
    if let Ok(home) = std::env::var("HOME") {
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
fn standalone_entry(resources: &Path) -> PathBuf {
    resources.join("standalone").join("custom-server.js")
}

/// Replicate the env the upstream CLI builds for the child server.
/// We forward the user's HOME so ~/.9router/runtime (sql.js / better-sqlite3)
/// resolves exactly as it does for the CLI. NODE_PATH is left to the upstream
/// runtime's own self-heal (hooks/sqliteRuntime.js) which reads ~/.9router.
/// We also prepend the resolved node's bin dir to PATH so any child node
/// subprocess (e.g. the runtime self-heal npm install) finds the same node.
/// DATA_DIR is overridden to ~/.9router so the server never tries to write
/// to /var/lib/9router on macOS.
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
pub(crate) fn spawn_server(app: &AppHandle) -> std::io::Result<()> {
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
        .current_dir(resources.join("standalone"))
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
pub(crate) fn stop_server(app: &AppHandle) {
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
