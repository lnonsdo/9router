// 9Router desktop shell (Tauri).
//
// DESIGN — zero-conflict with upstream:
//   * We do NOT modify cli/, or next.config.mjs.
//   * We spawn the EXISTING Next.js standalone server as a child process:
//       `node <resources>/standalone/custom-server.js`   (custom-server.js
//        injects the real socket IP, exactly like the Docker/CLI entrypoint).
//   * The Dashboard is rendered in a native WebView pointed at
//     http://127.0.0.1:20129/dashboard (the server's own port).
//   * The system tray is Tauri-native, replacing the upstream systray2 Go binary
//     (no antivirus false-positives, no chmod dance).
//   * On app exit we SIGKILL the child so the port is released for next launch.
//   * Left-clicking the tray icon toggles a compact usage panel popover
//     (panel.rs) that loads the /quota-panel page of the same server.
//
// MODULE LAYOUT (one concern per module):
//   consts.rs    shared constants           state.rs     managed app state
//   logging.rs   boot log                   inject.rs    injected JS snippets
//   server.rs    standalone server process  window.rs    main window / Dock
//   tray.rs      tray icon + tray menu      menu.rs      macOS menu bar
//   exa_sync.rs  Exa dashboard sync         events.rs    misc FE→Rust listeners
//   panel.rs     usage panel popover
//
// NODE PATH: reuses upstream's runtime layout. The server resolves sql.js /
// better-sqlite3 via NODE_PATH (see cli/hooks/sqliteRuntime.js), which the
// upstream runtime installs into ~/.9router/runtime. We just forward the same
// env the CLI would, so the existing self-heal logic keeps working untouched.

mod consts;
mod events;
mod exa_sync;
mod inject;
mod logging;
mod menu;
mod panel;
mod server;
mod state;
mod tray;
mod window;

use tauri::{Emitter, Manager, WindowEvent};

use consts::PANEL_LABEL;
use logging::boot_log;
use server::stop_server;

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
        // Remember window position and size across launches. The usage panel
        // is excluded: it is anchored to the tray icon on every open.
        //
        // Every `exa-*` window is excluded as well, and that is load-bearing:
        // the plugin restores state for each new window it sees, and its
        // restore path ends in `show() + set_focus()` (`should_show` starts as
        // true), so it silently overrode `.visible(false)` on the Exa sync
        // window — a "silent" refresh popped a window up for a few seconds
        // every time. Its labels carry a connection UUID, hence the filter
        // instead of `with_denylist`.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_filter(|label| !label.starts_with("exa-"))
                .with_denylist(&[PANEL_LABEL])
                .build(),
        )
        // Shell plugin: provides `open` command for opening URLs in the system
        // browser. Used by the injected JS for external link interception.
        .plugin(tauri_plugin_shell::init())
        // Drag region + external link interception: js_init_script runs on
        // the initial page; for the navigated dashboard page we also eval()
        // the same JS after navigate() completes (see poller below).
        .plugin(
            tauri::plugin::Builder::<_, ()>::new("drag-helper")
                .js_init_script(inject::PAGE_INIT_JS.to_string())
                .build()
        )
        .setup(|app| {
            let handle = app.handle();
            app.manage(state::LightweightMode(std::sync::atomic::AtomicBool::new(false)));

            // In release/build mode we own the server (spawn + kill). In dev mode
            // `beforeDevCommand` already started it, so skip to avoid a port clash.
            #[cfg(not(debug_assertions))]
            {
                if let Err(e) = server::spawn_server(handle) {
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
                        let addr = format!("127.0.0.1:{}", consts::SERVER_PORT);
                        let url = format!("http://127.0.0.1:{}/dashboard", consts::SERVER_PORT);
                        boot_log("poller: waiting for server port");
                        for _ in 0..300 {
                            if std::net::TcpStream::connect(&addr).is_ok() {
                                if let Some(w) = handle2.get_webview_window("main") {
                                    boot_log("poller: server up - navigating webview");
                                    eprintln!("[9router] server up - navigating webview");
                                    let _ = w.navigate(url.parse().unwrap_or_else(|_| {
                                        format!("http://127.0.0.1:{}/dashboard", consts::SERVER_PORT)
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
                                            let _ = w.eval(inject::PAGE_INIT_JS);
                                        }
                                    });
                                }
                                // Start a health-check watchdog: if the server
                                // crashes at runtime, show an error in the webview
                                // instead of leaving the user on a dead page.
                                let handle3 = handle2.clone();
                                std::thread::spawn(move || {
                                    let addr = format!("127.0.0.1:{}", consts::SERVER_PORT);
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

            if let Err(e) = menu::build_menu(handle) {
                boot_log(&format!("build_menu FAILED: {e}"));
                eprintln!("[9router] menu init failed (non-fatal): {e}");
            }
            if let Err(e) = tray::build_tray(handle) {
                eprintln!("[9router] tray init failed (non-fatal): {e}");
            }

            events::register(handle);
            exa_sync::register(handle);

            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                // Only the main window has the quit/minimize-to-tray dialog.
                // Child webviews (Exa sync, usage panel) close normally, and
                // emitting "close-requested" from them would broadcast to the
                // main window and trigger its quit dialog instead.
                //
                // In lightweight mode, let the window close to free memory.
                if let Some(state) = window.app_handle().try_state::<state::LightweightMode>() {
                    if state.0.load(std::sync::atomic::Ordering::Relaxed) {
                        return; // allow close
                    }
                }
                api.prevent_close();
                let _ = window.emit("close-requested", ());
            }
            // Usage panel: hide (not destroy) when it loses focus, so it
            // behaves like a menubar popover and reopens instantly.
            WindowEvent::Focused(false) if window.label() == PANEL_LABEL => {
                panel::handle_focus_lost(window.app_handle());
            }
            _ => {}
        })
        .on_menu_event(|app, event| menu::handle_menu_event(app, event.id().as_ref()))
        // Tray clicks are handled app-level (global listeners fire for every
        // event unconditionally) — see tray::handle_tray_event.
        .on_tray_icon_event(tray::handle_tray_event)
        .build(tauri::generate_context!())
        .expect("error while running 9Router desktop")
        .run(|app, event| {
            match event {
                tauri::RunEvent::ExitRequested { code, api, .. } => {
                    // Stay alive in the tray only when the last window closed
                    // by itself (lightweight mode). An explicit exit — panel
                    // Quit, ⌘Q — carries a Some(code) and must always be
                    // honored, otherwise quitting from lightweight mode would
                    // leave the app running with a dead server.
                    if code.is_none() && app.get_webview_window("main").is_none() {
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
