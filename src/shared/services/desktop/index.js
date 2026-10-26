"use client";

/**
 * Desktop shell (Tauri) bridge.
 *
 * The web app runs unchanged in the browser: every helper here degrades to a
 * no-op when `window.__TAURI_INTERNALS__` is absent. All Tauri APIs are
 * imported dynamically so the browser bundle never loads them up front, and
 * every call is failure-tolerant by design.
 *
 * Events (not custom commands) are the only frontend→Rust channel: custom
 * commands are blocked by the Tauri ACL on remote URLs, events are not.
 */

export function isDesktop() {
  return typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
}

async function getEventApi() {
  if (!isDesktop()) return null;
  try {
    return await import("@tauri-apps/api/event");
  } catch {
    return null;
  }
}

/**
 * Listen for a desktop event. Returns an unlisten function (a no-op outside
 * the shell).
 */
export async function listenDesktop(event, handler) {
  const api = await getEventApi();
  if (!api) return () => {};
  try {
    return await api.listen(event, handler);
  } catch {
    return () => {};
  }
}

/** Emit a desktop event to the Rust shell (best effort). */
export async function emitDesktop(event, payload) {
  const api = await getEventApi();
  if (!api) return;
  try {
    await api.emit(event, payload);
  } catch {
    /* not in Tauri — best effort */
  }
}

/** Destroy the current webview window (quit path of the close dialog). */
export async function destroyCurrentWindow() {
  if (!isDesktop()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().destroy();
  } catch {
    /* not in Tauri */
  }
}
