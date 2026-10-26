//! Managed shared state (held by Tauri's app state store).

use std::process::Child;
use std::sync::Mutex;

/// Tracks the server child we spawned (release mode only). In dev mode the
/// server is owned by `beforeDevCommand`, so this stays None and we never kill it.
pub(crate) struct ServerChild(pub(crate) Mutex<Option<Child>>);

/// Tracks lightweight mode state (shared between the usage panel and the
/// window/close event handlers).
pub(crate) struct LightweightMode(pub(crate) std::sync::atomic::AtomicBool);
