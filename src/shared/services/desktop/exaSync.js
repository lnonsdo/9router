"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { emitDesktop, isDesktop, listenDesktop } from "./index";

// Desktop auto-sync: a stale Exa snapshot is refreshed from a hidden webview
// when the quota page opens. Manual sync still bypasses the throttle.
const EXA_AUTO_SYNC_MS = 30 * 60 * 1000;

/**
 * Desktop-only Exa sync: dashboard.exa.ai usage APIs are only readable from a
 * real browser context, so the shell opens it in a webview and the injected
 * script (src-tauri/src/inject.rs) hands the JSON back over events.
 *
 * The key prefix lets the injected script verify the logged-in Exa account
 * actually owns this connection's API key — credits are team-level, so a
 * shared browser session must not leak one account's balance onto another.
 *
 * `auto: true` runs the sync in a hidden window (silent refresh).
 */
export async function requestExaSync(connectionId, { auto = false } = {}) {
  try {
    const hintRes = await fetch(`/api/providers/${connectionId}/exa-key-hint`, {
      cache: "no-store",
    });
    const hint = hintRes.ok ? await hintRes.json().catch(() => null) : null;
    await emitDesktop("open-exa-connect", {
      connectionId,
      keyPrefix: hint?.prefix || null,
      auto,
    });
  } catch (error) {
    console.warn("[desktop/exaSync] Exa sync requires the desktop app:", error);
  }
}

/**
 * Fire `handler(connectionId | null)` once the shell has written a fresh Exa
 * snapshot. `null` means "sync finished without a connection id" — callers
 * should fall back to a full refresh. Returns an unlisten function.
 */
export function registerExaSyncDone(handler) {
  return listenDesktop("exa-sync-done", (event) => {
    handler(event?.payload?.connectionId || null);
  });
}

/**
 * Exa desktop-sync wiring for the Quota Tracker page, kept in one hook so the
 * page's own upstream delta stays minimal. Returns the same surface the page
 * previously managed inline: `{ isTauri, handleExaSync }`.
 */
export function useExaDesktopSync({ connections, quotaData, refreshProvider, refreshAll }) {
  // Exa's dashboard APIs are only reachable from a real browser context, so
  // the sync button only exists in the Tauri shell (window.__TAURI_INTERNALS__).
  const [isTauri, setIsTauri] = useState(false);
  const exaAutoSyncAt = useRef(new Map());

  useEffect(() => {
    setIsTauri(isDesktop());
  }, []);

  // Refresh the Exa card once the desktop sync window has written its snapshot.
  useEffect(() => {
    if (!isTauri) return undefined;
    let unlisten;
    let cancelled = false;

    registerExaSyncDone((connectionId) => {
      if (connectionId) refreshProvider(connectionId, "exa");
      else refreshAll(true);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [isTauri, refreshProvider, refreshAll]);

  const handleExaSync = useCallback((connectionId, { auto = false } = {}) => {
    requestExaSync(connectionId, { auto });
  }, []);

  // Auto-refresh a stale Exa snapshot in a hidden webview when this page loads.
  // Only in the desktop shell (the dashboard's APIs need a real browser context)
  // and throttled per connection so the page cannot open a window in a loop.
  useEffect(() => {
    if (!isTauri || connections.length === 0) return;

    const now = Date.now();
    for (const conn of connections) {
      if (conn.provider !== "exa") continue;

      const entry = quotaData[conn.id];
      if (!entry) continue; // quota not fetched yet; the next pass will see it

      const meta = entry.raw?.meta || {};
      const syncedAt = Date.parse(meta.syncedAt || "");
      // `staleVolume` marks a snapshot whose request-count window predates this
      // billing month (written before the sync script asked for calendar
      // months); the count is withheld, so re-sync instead of showing it empty.
      const fresh = meta.source === "dashboard-sync"
        && meta.staleVolume !== true
        && Number.isFinite(syncedAt)
        && now - syncedAt < EXA_AUTO_SYNC_MS;
      if (fresh) continue;

      const lastAttempt = exaAutoSyncAt.current.get(conn.id) || 0;
      if (now - lastAttempt < EXA_AUTO_SYNC_MS) continue;

      exaAutoSyncAt.current.set(conn.id, now);
      handleExaSync(conn.id, { auto: true });
    }
  }, [isTauri, connections, quotaData, handleExaSync]);

  return { isTauri, handleExaSync };
}
