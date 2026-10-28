"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchConnections, fetchQuotaEntry } from "@/shared/services/quotaClient";
import { emitDesktop, isDesktop, listenDesktop } from "@/shared/services/desktop";
import { useExaDesktopSync } from "@/shared/services/desktop/exaSync";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import Toggle from "@/shared/components/Toggle";
import {
  getConnectionLabel,
  getRemainingPercentage,
  getStatusColor,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils";

/**
 * Usage panel — the popover behind the tray icon (Tauri shell only).
 *
 * Design constraints:
 *  - Popover window (360×480, transparent, no decorations, no native menu):
 *    the page paints its own rounded card with a CSS shadow (the native
 *    window shadow draws a square halo around transparent windows), and the
 *    footer section hosts the former tray menu actions (Dashboard /
 *    Lightweight Mode / Quit).
 *  - Providers like CodeBuddy report many quota rows (recurring refill packs
 *    plus one-shot bonus packs), often with most rows exhausted — so rows are
 *    tiered: active rows first (most critical on top), exhausted rows
 *    collapsed into a chip line. Overflow of active rows collapses too.
 *  - Data comes cache-first (instant paint) then force-refreshes on every
 *    panel-shown event and on a 60s timer.
 */

const REFRESH_INTERVAL_MS = 60000;
// Active rows shown before the "more" toggle kicks in.
const VISIBLE_ACTIVE_ROWS = 4;
const UI_STATE_KEY = "quotaPanelUiState";
// The page grows/shrinks the popover window to fit its content (the Rust
// side clamps against the same bounds — see src-tauri/src/panel.rs).
const PANEL_WIDTH = 360;
const PANEL_MIN_HEIGHT = 340;
const PANEL_MAX_HEIGHT = 640;
// Console drawer
const CONSOLE_POLL_MS = 3000;
const CONSOLE_RENDER_MAX = 300;

const DOT_BG = {
  green: "bg-green-500",
  yellow: "bg-yellow-500",
  red: "bg-red-500",
};
const BAR_BG = DOT_BG;
const VALUE_TEXT = {
  green: "text-green-600 dark:text-green-400",
  yellow: "text-yellow-600 dark:text-yellow-400",
  red: "text-red-600 dark:text-red-400",
};

function fmtNum(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US");
}

function providerLabel(providerId) {
  return AI_PROVIDERS[providerId]?.name || providerId;
}

/**
 * Short relative reset/expiry label. `recurring: false` rows are one-shot
 * bonus packs whose resetAt is a hard expiry — word it as "expires", not
 * "resets".
 */
function relResetText(quota) {
  if (!quota?.resetAt) return null;
  const t = Date.parse(quota.resetAt);
  if (!Number.isFinite(t)) return null;
  const recurring = quota.recurring !== false;
  const diff = t - Date.now();
  if (diff <= 0) return recurring ? "reset" : "expired";
  const mins = Math.round(diff / 60000);
  const span =
    mins < 60
      ? `${mins}m`
      : mins < 60 * 48
        ? `${Math.round(mins / 60)}h`
        : `${Math.round(mins / (60 * 24))}d`;
  return recurring ? `resets in ${span}` : `expires in ${span}`;
}

/** Partition normalized quota rows into the panel's visual tiers. */
function splitQuotaRows(quotas = []) {
  const active = [];
  const depleted = [];
  const balances = [];
  const unlimited = [];
  for (const quota of quotas) {
    if (quota.unlimited === true) {
      unlimited.push(quota);
    } else if (quota.isCreditBalance === true) {
      balances.push(quota);
    } else {
      const pct = Math.min(100, Math.max(0, getRemainingPercentage(quota)));
      if (pct <= 0) depleted.push(quota);
      else active.push({ ...quota, pct });
    }
  }
  // Most critical (lowest remaining) first — the thing about to run out is
  // the thing the user opened the panel for.
  active.sort((a, b) => a.pct - b.pct);
  return { active, depleted, balances, unlimited };
}

/** Active quota row: name + percentage, mini progress bar, used/total + reset. */
function ActiveRow({ quota }) {
  const color = getStatusColor(quota.pct);
  const reset = relResetText(quota);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1">
          {quota.emoji ? <span className="text-[10px]">{quota.emoji}</span> : null}
          <span className="truncate text-[11px] font-medium text-text-primary">{quota.name}</span>
        </span>
        <span className={`shrink-0 text-[11px] font-semibold tabular-nums ${VALUE_TEXT[color]}`}>
          {quota.pct}%
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
        <div
          className={`h-full rounded-full transition-all duration-300 ${BAR_BG[color]}`}
          style={{ width: `${quota.pct}%` }}
        />
      </div>
      <div className="flex items-center justify-between gap-2 text-[10px] text-text-muted">
        <span className="truncate">
          {fmtNum(quota.used)} / {Number(quota.total) > 0 ? fmtNum(quota.total) : "∞"}
          {quota.unit ? ` ${quota.unit}` : ""}
        </span>
        {reset ? <span className="shrink-0">{reset}</span> : null}
      </div>
    </div>
  );
}

/** Single-line row for unlimited quotas and credit balances. */
function MiniRow({ quota }) {
  const isBalance = quota.isCreditBalance === true;
  return (
    <div className="flex items-center justify-between gap-2 text-[11px]">
      <span className="flex min-w-0 items-center gap-1">
        <span className="text-[10px]">{quota.emoji || (isBalance ? "💰" : "♾")}</span>
        <span className="truncate font-medium text-text-primary">{quota.name}</span>
      </span>
      <span
        className={`shrink-0 font-semibold tabular-nums ${
          isBalance ? "text-blue-600 dark:text-blue-400" : "text-green-600 dark:text-green-400"
        }`}
      >
        {isBalance
          ? `Credit: ${Number.isFinite(Number(quota.total)) ? Number(quota.total).toFixed(2) : "—"} ${quota.currency || ""}`.trim()
          : `${fmtNum(quota.used)} used · Unlimited`}
      </span>
    </div>
  );
}

function ConnectionGroup({ connection, entry }) {
  const connId = connection.id;
  const [showMoreActive, setShowMoreActive] = useState(false);
  const [showDepleted, setShowDepleted] = useState(false);
  const hydratedRef = useRef(false);

  // Persist the expand state per connection so the panel reopens the way
  // the user left it.
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    try {
      const saved = JSON.parse(window.localStorage.getItem(UI_STATE_KEY) || "{}");
      setShowMoreActive(Boolean(saved.more?.[connId]));
      setShowDepleted(Boolean(saved.depleted?.[connId]));
    } catch {
      /* corrupt state — defaults are fine */
    }
  }, [connId]);

  const persist = (patch) => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(UI_STATE_KEY) || "{}");
      saved.more = saved.more || {};
      saved.depleted = saved.depleted || {};
      if ("more" in patch) saved.more[connId] = patch.more;
      if ("depleted" in patch) saved.depleted[connId] = patch.depleted;
      window.localStorage.setItem(UI_STATE_KEY, JSON.stringify(saved));
    } catch {
      /* best effort */
    }
  };

  const quotas = entry?.quotas || [];
  const { active, depleted, balances, unlimited } = useMemo(
    () => splitQuotaRows(quotas),
    [quotas],
  );

  // Group health: the dot mirrors the most critical active row; a group with
  // nothing usable left is straight red.
  const usableCount = active.length + unlimited.length + balances.length;
  const dotColor =
    usableCount === 0 && depleted.length > 0
      ? "red"
      : getStatusColor(active[0]?.pct ?? 100);
  const worstReset = relResetText(active[0]);

  const visibleActive = showMoreActive ? active : active.slice(0, VISIBLE_ACTIVE_ROWS);
  const hiddenActiveCount = active.length - Math.min(active.length, VISIBLE_ACTIVE_ROWS);

  if (quotas.length === 0 && !entry?.message) return null;

  return (
    <section className="space-y-2 rounded-lg border border-black/10 bg-black/[0.015] p-2.5 dark:border-white/10 dark:bg-white/[0.02]">
      <header className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_BG[dotColor]}`} />
          <h3 className="truncate text-xs font-semibold text-text-primary">
            {providerLabel(connection.provider)}
          </h3>
          {getConnectionLabel(connection) ? (
            <span className="truncate text-[10px] text-text-muted">
              · {getConnectionLabel(connection)}
            </span>
          ) : null}
        </div>
        {worstReset ? (
          <span className="shrink-0 text-[10px] text-text-muted">{worstReset}</span>
        ) : null}
      </header>

      {entry?.message ? (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">⚠ {entry.message}</p>
      ) : null}

      <div className="space-y-2.5">
        {visibleActive.map((quota) => (
          <ActiveRow key={`${quota.modelKey || quota.name}-${quota.resetAt || ""}`} quota={quota} />
        ))}

        {unlimited.map((quota) => (
          <MiniRow key={`unl-${quota.name}`} quota={quota} />
        ))}
        {balances.map((quota) => (
          <MiniRow key={`bal-${quota.name}`} quota={quota} />
        ))}
      </div>

      {hiddenActiveCount > 0 ? (
        <button
          type="button"
          onClick={() => {
            const next = !showMoreActive;
            setShowMoreActive(next);
            persist({ more: next });
          }}
          className="block w-full text-left text-[10px] text-text-muted transition-colors hover:text-text-primary"
        >
          {showMoreActive ? "▴ Collapse" : `▾ ${hiddenActiveCount} more`}
        </button>
      ) : null}

      {depleted.length > 0 ? (
        showDepleted ? (
          <div className="space-y-1.5">
            <button
              type="button"
              onClick={() => {
                setShowDepleted(false);
                persist({ depleted: false });
              }}
              className="block w-full text-left text-[10px] text-text-muted transition-colors hover:text-text-primary"
            >
              ▴ Hide {depleted.length} depleted
            </button>
            <div className="flex flex-wrap gap-1">
              {depleted.map((quota) => {
                const reset = relResetText(quota);
                return (
                  <span
                    key={`${quota.modelKey || quota.name}-${quota.resetAt || ""}`}
                    title={reset ? `${quota.name} · ${reset}` : quota.name}
                    className="inline-flex max-w-full items-center gap-1 rounded-full bg-black/5 px-2 py-0.5 text-[10px] text-text-muted dark:bg-white/5"
                  >
                    <span className="truncate">{quota.name}</span>
                    {reset ? <span className="shrink-0 opacity-70">{reset}</span> : null}
                  </span>
                );
              })}
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setShowDepleted(true);
              persist({ depleted: true });
            }}
            className="block w-full text-left text-[10px] text-text-muted transition-colors hover:text-text-primary"
          >
            ▾ {depleted.length} depleted
          </button>
        )
      ) : null}
    </section>
  );
}

/** Footer row of the embedded tray-menu section. */
function MenuRow({ icon, label, onClick, trailing = null, danger = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick && !trailing}
      className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11px] transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${
        danger ? "text-red-600 dark:text-red-400" : "text-text-primary"
      }`}
    >
      <span
        className={`material-symbols-outlined ${danger ? "" : "text-text-muted"}`}
        style={{ fontSize: 13 }}
      >
        {icon}
      </span>
      <span className="flex-1">{label}</span>
      {trailing}
    </button>
  );
}

export default function QuotaPanelPage() {
  const [connections, setConnections] = useState([]);
  const [quotaById, setQuotaById] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [error, setError] = useState(null);
  const [lightweight, setLightweight] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consolePaused, setConsolePaused] = useState(false);
  const [consoleLines, setConsoleLines] = useState([]);
  const connectionsRef = useRef([]);
  const headerRef = useRef(null);
  const contentRef = useRef(null);
  const logRef = useRef(null);
  const consoleScrollRef = useRef(null);
  const footerRef = useRef(null);
  const lastSentHeight = useRef(0);

  const loadAll = useCallback(async ({ force = false, quiet = false } = {}) => {
    if (!quiet) setRefreshing(true);
    try {
      let conns = connectionsRef.current;
      if (conns.length === 0 || force) {
        conns = await fetchConnections();
        connectionsRef.current = conns;
        setConnections(conns);
      }
      const pairs = await Promise.all(
        conns.map(async (conn) => {
          try {
            const entry = await fetchQuotaEntry(conn, { force });
            return [conn.id, entry];
          } catch (err) {
            return [conn.id, { quotas: [], message: err?.message || "Failed to load", raw: null }];
          }
        }),
      );
      setQuotaById(Object.fromEntries(pairs));
      setLastUpdated(new Date());
      setError(null);
    } catch (err) {
      setError(err?.message || "Failed to load");
    } finally {
      setLoading(false);
      if (!quiet) setRefreshing(false);
    }
  }, []);

  // Exa's balance only moves after the dashboard is re-read from a real
  // browser context (hidden webview in the shell). Reuse the tracker's hook so
  // the panel's own polls pick up a fresh snapshot: a stale Exa entry triggers
  // one throttled silent sync, and an explicit refresh click forces one.
  const refreshPanel = useCallback(() => loadAll({ force: true, quiet: true }), [loadAll]);
  const { syncNow: syncExaNow, syncing: exaSyncing } = useExaDesktopSync({
    connections,
    quotaData: quotaById,
    refreshProvider: refreshPanel,
    refreshAll: refreshPanel,
  });

  // Initial load: cache-first for an instant paint (the panel-shown handler
  // below force-refreshes right after, since Rust also emits it on first open).
  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Popover anatomy: the window itself is transparent, so the page must not
  // paint html/body backgrounds — the rounded card below is the only surface.
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    html.style.background = "transparent";
    body.style.background = "transparent";
    body.style.overflow = "hidden";
  }, []);

  // Tell the shell this page is mounted so the first open can reveal the
  // popover immediately (card + loading state visible, no dead silence).
  useEffect(() => {
    if (isDesktop()) emitDesktop("panel-ready");
  }, []);

  // The popover window outlives its openings, so the palette it booted with
  // would stick even after the dashboard switches theme. Re-apply the stored
  // theme whenever the shell reveals it (and whenever the OS scheme changes).
  useEffect(() => {
    const applyStoredTheme = () => {
      let theme = "system";
      try {
        const raw = window.localStorage.getItem("theme");
        if (raw) theme = JSON.parse(raw)?.state?.theme || "system";
      } catch {
        // Corrupt payload: fall back to the system scheme.
      }
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      const dark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
    };

    applyStoredTheme();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", applyStoredTheme);
    // Same-origin windows share localStorage; the event may not cross webviews.
    const onStorage = (event) => {
      if (!event.key || event.key === "theme") applyStoredTheme();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", applyStoredTheme);

    let unlisten;
    let cancelled = false;
    listenDesktop("panel-shown", applyStoredTheme).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      media.removeEventListener("change", applyStoredTheme);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", applyStoredTheme);
    };
  }, []);

  // Refresh every time the shell reveals the popover.
  useEffect(() => {
    let unlisten;
    let cancelled = false;
    listenDesktop("panel-shown", () => loadAll({ force: true, quiet: true })).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [loadAll]);

  // Console drawer: hydrate the persisted open state, poll while open,
  // keep the view pinned to the newest line.
  const fetchConsole = useCallback(async () => {
    try {
      const res = await fetch("/api/translator/console-logs", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (data?.success && Array.isArray(data.logs)) setConsoleLines(data.logs);
    } catch {
      /* server hiccup — next poll retries */
    }
  }, []);

  const clearConsole = useCallback(async () => {
    try {
      await fetch("/api/translator/console-logs", { method: "DELETE" });
      setConsoleLines([]);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(UI_STATE_KEY) || "{}");
      if (saved.console) setConsoleOpen(true);
    } catch {
      /* defaults are fine */
    }
  }, []);

  useEffect(() => {
    if (!consoleOpen || consolePaused) return undefined;
    fetchConsole();
    const timer = setInterval(fetchConsole, CONSOLE_POLL_MS);
    return () => clearInterval(timer);
  }, [consoleOpen, consolePaused, fetchConsole]);

  useEffect(() => {
    const el = consoleScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [consoleLines, consoleOpen]);

  // Lightweight-mode switch state, pushed by Rust on show and after toggles.
  useEffect(() => {
    let unlisten;
    let cancelled = false;
    listenDesktop("panel-state", (event) => {
      setLightweight(Boolean(event?.payload?.lightweight));
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Steady-state refresh while the popover stays open.
  useEffect(() => {
    const timer = setInterval(() => loadAll({ force: true, quiet: true }), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [loadAll]);

  // Esc closes the popover (hide, not destroy — reopening is instant).
  useEffect(() => {
    const onKeyDown = async (event) => {
      if (event.key !== "Escape") return;
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().hide();
      } catch {
        /* not in Tauri */
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Connections with nothing usable left sink to the bottom of the list;
  // healthy/most-critical ones stay on top in API (priority) order.
  const sortedGroups = useMemo(() => {
    const usableCount = (entry) => {
      const s = splitQuotaRows(entry?.quotas || []);
      return s.active.length + s.unlimited.length + s.balances.length;
    };
    return connections
      .filter((conn) => {
        const entry = quotaById[conn.id];
        return entry && (entry.quotas?.length > 0 || entry.message);
      })
      .sort((a, b) => {
        const ua = usableCount(quotaById[a.id]);
        const ub = usableCount(quotaById[b.id]);
        if (ua === 0 && ub > 0) return 1;
        if (ub === 0 && ua > 0) return -1;
        return 0;
      });
  }, [connections, quotaById]);

  // Adaptive height: measure the natural content height (header + rows +
  // footer — never the viewport-capped card, or tall content would never
  // grow the window) and resize the window to wrap it, clamped to [MIN, MAX].
  useEffect(() => {
    if (!isDesktop()) return undefined;
    const apply = async () => {
      const natural =
        (headerRef.current?.offsetHeight || 0) +
        (contentRef.current?.offsetHeight || 0) +
        (logRef.current?.offsetHeight || 0) +
        (footerRef.current?.offsetHeight || 0) +
        // scroll-area vertical padding (24) + card ring (2) + page padding (20)
        46;
      const clamped = Math.max(PANEL_MIN_HEIGHT, Math.min(PANEL_MAX_HEIGHT, natural));
      if (Math.abs(clamped - lastSentHeight.current) < 2) return;
      lastSentHeight.current = clamped;
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const { LogicalSize } = await import("@tauri-apps/api/dpi");
        await getCurrentWindow().setSize(new LogicalSize(PANEL_WIDTH, clamped));
      } catch {
        /* resize unavailable — fixed window height still works */
      }
    };
    const observer = new ResizeObserver(() => {
      apply();
    });
    if (contentRef.current) observer.observe(contentRef.current);
    apply();
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html: "html, body { background: transparent !important; overflow: hidden; }",
        }}
      />
      <div className="w-full p-2.5">
        <div className="flex max-h-[calc(100vh-20px)] flex-col overflow-hidden rounded-2xl bg-bg ring-1 ring-black/[0.06] dark:ring-white/10 [box-shadow:0_3px_10px_-2px_rgba(0,0,0,0.20),0_1px_3px_-1px_rgba(0,0,0,0.10)]">
          {/* Header */}
          <div
            ref={headerRef}
            className="flex shrink-0 items-center justify-between border-b border-black/10 px-3.5 py-2.5 dark:border-white/10"
          >
            <h2 className="text-[13px] font-semibold text-text-primary">⚡ 9Router · Usage</h2>
            <div className="flex items-center gap-1.5">
              {lastUpdated ? (
                <span className="text-[10px] tabular-nums text-text-muted">
                  {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  // Force the providers that can only be read from a browser
                  // context (Exa) before re-reading the snapshots.
                  syncExaNow();
                  loadAll({ force: true });
                }}
                disabled={refreshing}
                aria-label="Refresh usage"
                className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-black/5 dark:hover:bg-white/5"
              >
                <span
                  className={`material-symbols-outlined text-text-muted ${
                    refreshing || exaSyncing.size > 0 ? "animate-spin" : ""
                  }`}
                  style={{ fontSize: 15 }}
                >
                  refresh
                </span>
              </button>
            </div>
          </div>

          {/* Groups */}
          <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
            <div ref={contentRef} className="space-y-2.5">
              {loading ? (
                <p className="py-8 text-center text-xs text-text-muted">Loading…</p>
              ) : error ? (
                <div className="space-y-2 py-8 text-center">
                  <p className="text-xs text-red-600 dark:text-red-400">⚠ {error}</p>
                  <button
                    type="button"
                    onClick={() => loadAll({ force: true })}
                    className="text-xs text-primary hover:underline"
                  >
                    Retry
                  </button>
                </div>
              ) : sortedGroups.length === 0 ? (
                <p className="py-8 text-center text-xs text-text-muted">No quota to display</p>
              ) : (
                sortedGroups.map((conn) => (
                  <ConnectionGroup key={conn.id} connection={conn} entry={quotaById[conn.id]} />
                ))
              )}
            </div>
          </div>

          {/* Console drawer (server console via /api/translator/console-logs) */}
          <div ref={logRef} className="shrink-0 border-t border-black/10 dark:border-white/10">
            <div className="flex w-full items-center px-1.5 py-0.5">
              <button
                type="button"
                onClick={() => {
                  setConsoleOpen((v) => {
                    try {
                      const saved = JSON.parse(window.localStorage.getItem(UI_STATE_KEY) || "{}");
                      saved.console = !v;
                      window.localStorage.setItem(UI_STATE_KEY, JSON.stringify(saved));
                    } catch {
                      /* best effort */
                    }
                    return !v;
                  });
                }}
                className="flex items-center gap-0.5 rounded-md px-1 py-0.5 text-[10px] text-text-muted transition-colors hover:text-text-primary"
              >
                <span
                  className="material-symbols-outlined"
                  style={{ fontSize: 13 }}
                >
                  {consoleOpen ? "keyboard_arrow_down" : "keyboard_arrow_right"}
                </span>
                Console
              </button>
              {consoleOpen ? (
                <div className="ml-auto flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setConsolePaused((v) => !v)}
                    aria-label={consolePaused ? "Resume console refresh" : "Pause console refresh"}
                    title={consolePaused ? "Refresh paused — click to resume" : "Pause refresh"}
                    className={`flex h-5 w-5 items-center justify-center rounded-md transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${
                      consolePaused ? "text-amber-500" : "text-text-muted hover:text-text-primary"
                    }`}
                  >
                    <span
                      className="material-symbols-outlined"
                      style={{ fontSize: 12 }}
                    >
                      {consolePaused ? "lock" : "lock_open"}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={clearConsole}
                    aria-label="Clear console"
                    className="flex h-5 w-5 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-black/5 hover:text-text-primary dark:hover:bg-white/5"
                  >
                    <span
                      className="material-symbols-outlined"
                      style={{ fontSize: 12 }}
                    >
                      delete
                    </span>
                  </button>
                </div>
              ) : null}
            </div>
            {consoleOpen ? (
              <div
                ref={consoleScrollRef}
                className="custom-scrollbar mx-1.5 mb-1.5 h-40 overflow-y-auto rounded-md bg-black/80 px-2 py-1.5"
              >
                <pre className="whitespace-pre-wrap break-all font-mono text-[10px] leading-4 text-zinc-300">
                  {consoleLines.length > 0
                    ? consoleLines.slice(-CONSOLE_RENDER_MAX).join("\n")
                    : "No logs yet"}
                </pre>
              </div>
            ) : null}
          </div>

          {/* Footer: the former tray menu, embedded */}
          <div
            ref={footerRef}
            className="shrink-0 space-y-0.5 border-t border-black/10 px-1 py-1 dark:border-white/10"
          >
            <MenuRow
              icon="dashboard"
              label="Dashboard"
              onClick={() => emitDesktop("open-dashboard", { path: "/dashboard" })}
            />
            <MenuRow
              icon="dark_mode"
              label="Lightweight Mode"
              trailing={
                <Toggle
                  size="sm"
                  checked={lightweight}
                  onChange={() => {
                    setLightweight((v) => !v); // optimistic; Rust confirms via panel-state
                    emitDesktop("toggle-lightweight");
                  }}
                />
              }
            />
            <MenuRow
              icon="power_settings_new"
              label="Quit"
              danger
              onClick={() => emitDesktop("quit-app")}
            />
          </div>
        </div>
      </div>
    </>
  );
}
