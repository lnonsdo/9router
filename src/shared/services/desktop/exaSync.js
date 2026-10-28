"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emitDesktop, isDesktop, listenDesktop } from "./index";

// Desktop auto-sync: a stale Exa snapshot is refreshed from a hidden webview
// when the quota page opens. Manual sync still bypasses the throttle.
const EXA_AUTO_SYNC_MS = 30 * 60 * 1000;
// The shell closes a stuck sync window after 90s, so a card must not spin
// longer than that waiting for an event that will never come.
const EXA_SYNC_TIMEOUT_MS = 100 * 1000;

/**
 * Desktop-only Exa sync: dashboard.exa.ai usage APIs are only readable from a
 * real browser context, so the shell opens it in a webview and the injected
 * script (src-tauri/src/inject.rs) hands the JSON back over events.
 *
 * The key prefix lets the injected script verify the logged-in Exa account
 * actually owns this connection's API key — credits are team-level, so a
 * shared browser session must not leak one account's balance onto another.
 *
 * `auto: true` runs the sync in a hidden window (silent refresh). `login: true`
 * opens a visible window instead: the Exa session is known to be dead, so the
 * user has to sign in there (the app's webview has no password manager or
 * Google SSO, hence the cookie field in Edit Connection).
 */
export async function requestExaSync(connectionId, { auto = false, login = false } = {}) {
  try {
    const hintRes = await fetch(`/api/providers/${connectionId}/exa-key-hint`, {
      cache: "no-store",
    });
    const hint = hintRes.ok ? await hintRes.json().catch(() => null) : null;
    await emitDesktop("open-exa-connect", {
      connectionId,
      keyPrefix: hint?.prefix || null,
      // Optional cookie pasted from the user's normal browser. The shell pours
      // it in only to bootstrap a webview that has no Exa session of its own.
      sessionCookie: hint?.sessionCookie || null,
      auto,
      login,
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
 * previously managed inline: `{ isTauri, handleExaSync, needsLogin, syncNow,
 * syncing }`.
 *
 * `needsLogin` holds the ids of connections whose last silent sync found an
 * expired Exa session; `syncing` holds the ids with a webview sync in flight, so
 * the card can show its loading state instead of looking unresponsive.
 */
export function useExaDesktopSync({ connections, quotaData, refreshProvider, refreshAll }) {
  // Exa's dashboard APIs are only reachable from a real browser context, so
  // the sync button only exists in the Tauri shell (window.__TAURI_INTERNALS__).
  const [isTauri, setIsTauri] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(() => new Set());
  // Ids whose webview sync is in flight: the card shows its loading state for
  // these, because the read itself takes a few seconds and a silently unchanged
  // card looks broken.
  const [syncing, setSyncing] = useState(() => new Set());
  const syncTimers = useRef(new Map());
  const exaAutoSyncAt = useRef(new Map());

  const clearSyncing = useCallback((connectionId) => {
    const timers = syncTimers.current;
    const timer = timers.get(connectionId);
    if (timer) {
      clearTimeout(timer);
      timers.delete(connectionId);
    }
    setSyncing((prev) => {
      if (!prev.has(connectionId)) return prev;
      const next = new Set(prev);
      next.delete(connectionId);
      return next;
    });
  }, []);

  const markSyncing = useCallback((connectionId) => {
    setSyncing((prev) => (prev.has(connectionId) ? prev : new Set(prev).add(connectionId)));
    const timers = syncTimers.current;
    const previous = timers.get(connectionId);
    if (previous) clearTimeout(previous);
    timers.set(
      connectionId,
      setTimeout(() => {
        timers.delete(connectionId);
        setSyncing((prev) => {
          if (!prev.has(connectionId)) return prev;
          const next = new Set(prev);
          next.delete(connectionId);
          return next;
        });
      }, EXA_SYNC_TIMEOUT_MS),
    );
  }, []);

  // Never leave a timer behind on a page that is going away.
  useEffect(() => {
    const timers = syncTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  useEffect(() => {
    setIsTauri(isDesktop());
  }, []);

  // The listeners are registered once, so they read the latest callbacks
  // through refs: the page recreates `refreshAll` whenever its own refreshing
  // flag flips, and re-subscribing mid-sync could drop the completion event.
  const refreshProviderRef = useRef(refreshProvider);
  const refreshAllRef = useRef(refreshAll);
  useEffect(() => {
    refreshProviderRef.current = refreshProvider;
  }, [refreshProvider]);
  useEffect(() => {
    refreshAllRef.current = refreshAll;
  }, [refreshAll]);

  // The sync window wrote a fresh snapshot: re-read everything the page shows
  // (the Exa card's rows and time, and anything derived from the snapshot).
  useEffect(() => {
    if (!isTauri) return undefined;
    let unlisten;
    let cancelled = false;

    registerExaSyncDone((connectionId) => {
      if (connectionId) {
        clearSyncing(connectionId);
        setNeedsLogin((prev) => {
          if (!prev.has(connectionId)) return prev;
          const next = new Set(prev);
          next.delete(connectionId);
          return next;
        });
      }
      const refresh = refreshAllRef.current;
      if (refresh) refresh(true);
      else refreshProviderRef.current?.(connectionId, "exa");
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [isTauri, clearSyncing]);

  // The shell closed a silent sync that hit Exa's login page instead of
  // stealing focus; remember it so the card can offer a real sign-in. When the
  // failure came from a user-started refresh (`login: true`), reopen right away
  // in a visible window: that is what they asked for, and the reopened window
  // is created visible from the first frame (a hidden window revealed later
  // does not repaint reliably in WKWebView).
  useEffect(() => {
    if (!isTauri) return undefined;
    let unlisten;
    let cancelled = false;

    listenDesktop("exa-sync-needs-login", (event) => {
      const connectionId = event?.payload?.connectionId;
      if (!connectionId) return;
      // The hidden attempt is over: stop the spinner and show the note. A
      // follow-up sign-in window syncs in its own time (no card spinner while
      // the user types a password).
      clearSyncing(connectionId);
      setNeedsLogin((prev) => (prev.has(connectionId) ? prev : new Set(prev).add(connectionId)));
      // Pull the card again so the "sign-in expired" note the shell wrote next
      // to the snapshot shows up without waiting for the next poll.
      refreshProviderRef.current?.(connectionId, "exa");
      if (event?.payload?.login === true) {
        requestExaSync(connectionId, { login: true });
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [isTauri, clearSyncing]);

  const handleExaSync = useCallback((connectionId, { auto = false, login = false } = {}) => {
    if (!login) markSyncing(connectionId);
    requestExaSync(connectionId, { auto, login });
  }, [markSyncing]);

  // The shell writes the "sign-in expired" flag next to the snapshot, so it
  // survives a restart; merge it with the in-memory events the page received.
  const needsLoginIds = useMemo(() => {
    const merged = new Set(needsLogin);
    for (const [id, entry] of Object.entries(quotaData || {})) {
      if (entry?.raw?.meta?.needsLogin === true) merged.add(id);
    }
    return merged;
  }, [needsLogin, quotaData]);

  // Imperative paths (refresh button in the usage panel) need today's state
  // without re-creating the callbacks on every quota poll.
  const connectionsRef = useRef(connections);
  const needsLoginIdsRef = useRef(needsLoginIds);
  useEffect(() => {
    connectionsRef.current = connections;
  }, [connections]);
  useEffect(() => {
    needsLoginIdsRef.current = needsLoginIds;
  }, [needsLoginIds]);

  /**
   * Force a silent sync for every Exa connection right now. The automatic path
   * below is throttled (a page cannot open a window in a loop); an explicit
   * refresh click should not be.
   */
  const syncNow = useCallback(() => {
    const now = Date.now();
    for (const conn of connectionsRef.current || []) {
      if (conn.provider !== "exa") continue;
      // A dead session can only bounce off the login page again; the card
      // already asks the user to sign in.
      if (needsLoginIdsRef.current?.has(conn.id)) continue;
      exaAutoSyncAt.current.set(conn.id, now);
      handleExaSync(conn.id, { auto: true });
    }
  }, [handleExaSync]);

  // Auto-refresh a stale Exa snapshot in a hidden webview when this page loads.
  // Only in the desktop shell (the dashboard's APIs need a real browser context)
  // and throttled per connection so the page cannot open a window in a loop.
  useEffect(() => {
    if (!isTauri || connections.length === 0) return;

    const now = Date.now();
    for (const conn of connections) {
      if (conn.provider !== "exa") continue;
      // The session is known to be expired: a silent sync can only bounce off
      // the login page again, so wait for the user to refresh (and sign in).
      if (needsLoginIds.has(conn.id)) continue;

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
  }, [isTauri, connections, quotaData, handleExaSync, needsLoginIds]);

  return { isTauri, handleExaSync, needsLogin: needsLoginIds, syncNow, syncing };
}
