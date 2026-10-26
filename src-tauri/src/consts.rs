//! Shared constants for the desktop shell.

pub(crate) const SERVER_PORT: &str = "20129";

/// URL of the dashboard, used when (re)creating the window.
pub(crate) const DASHBOARD_URL: &str = "http://127.0.0.1:20129/dashboard";

/// URL of the compact usage panel shown when left-clicking the tray icon.
pub(crate) const PANEL_URL: &str = "http://127.0.0.1:20129/quota-panel";

/// Webview window label of the usage panel.
pub(crate) const PANEL_LABEL: &str = "quota-panel";

/// Subdirectory of DATA_DIR holding Exa dashboard sync snapshots.
pub(crate) const EXA_SYNC_DIR: &str = "exa-sync";
