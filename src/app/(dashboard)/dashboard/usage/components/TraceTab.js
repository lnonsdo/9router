"use client";

import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Drawer from "@/shared/components/Drawer";
import Pagination from "@/shared/components/Pagination";
import { cn } from "@/shared/utils/cn";

const DATE_FMT = (iso) => {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
};

const num = (v) => (typeof v === "number" ? v.toLocaleString() : "0");

const pad2 = (n) => String(n).padStart(2, "0");

// Value accepted by <input type="datetime-local"> in the user's local timezone.
const toLocalInputValue = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

const QUICK_RANGES = [
  { value: "7d", label: "Last 7 days", days: 7 },
  { value: "30d", label: "Last 30 days", days: 30 },
  { value: "90d", label: "Last 90 days", days: 90 },
  { value: "all", label: "All time" },
  { value: "custom", label: "Custom" },
];

// Columns of the per-model breakdown popover. "sum" fields can show a share of
// the session total; hitRate is a ratio and only renders its own value.
const BREAKDOWN_FIELDS = [
  { key: "requests", label: "Requests", sum: true },
  { key: "cost", label: "Cost", sum: true },
  { key: "promptTokens", label: "Input", sum: true },
  { key: "completionTokens", label: "Output", sum: true },
  { key: "cachedTokens", label: "Cached", sum: true },
  { key: "cacheCreationTokens", label: "Cache Create", sum: true },
  { key: "hitRate", label: "Hit Rate", sum: false },
];

// Compact number formatting to avoid long token counts overflowing cards/columns.
// M = million, K = thousand. Keeps exact values in detailed drawers.
const fmtCompact = (v) => {
  const n = typeof v === "number" ? v : 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
};

// Cache hit rate = cached (cache-read) tokens / total input tokens. promptTokens
// is the canonical cache-INCLUSIVE input (new input + cache read + cache write),
// so this ratio reflects what fraction of input was served from cache.
const hitRate = (cached, prompt) => {
  const c = Number(cached) || 0;
  const p = Number(prompt) || 0;
  if (p <= 0) return "—";
  return `${((c / p) * 100).toFixed(1)}%`;
};

// Mirror of RequestDetailsTab's token helpers so session requests render consistently.
function getCachedTokens(tokens) {
  return (
    tokens?.cached_tokens ||
    tokens?.cache_read_input_tokens ||
    tokens?.prompt_tokens_details?.cached_tokens ||
    tokens?.input_tokens_details?.cached_tokens ||
    0
  );
}
function getInputTokens(tokens) {
  const prompt = tokens?.prompt_tokens || tokens?.input_tokens || 0;
  const cache = getCachedTokens(tokens);
  if (tokens?.cache_read_input_tokens === undefined && prompt < cache) return cache;
  return prompt;
}

function SessionSummary({ total }) {
  const items = [
    { label: "Sessions", value: num(total.sessions) },
    { label: "Requests", value: num(total.requests) },
    { label: "Input Tokens", value: fmtCompact(total.promptTokens) },
    { label: "Output Tokens", value: fmtCompact(total.completionTokens) },
    { label: "Cached Tokens", value: fmtCompact(total.cachedTokens) },
    { label: "Cache Creation", value: fmtCompact(total.cacheCreationTokens) },
    { label: "Cost", value: `$${Number(total.cost || 0).toFixed(4)}` },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
      {items.map((it) => (
        <div key={it.label} className="rounded-lg border border-black/5 bg-black/[0.02] p-3 dark:border-white/5 dark:bg-white/[0.02]">
          <div className="text-xs text-text-muted">{it.label}</div>
          <div className="mt-1 font-mono text-lg font-semibold text-text-main">{it.value}</div>
        </div>
      ))}
    </div>
  );
}

// Drawer that shows one request's full payload (reuses RequestDetailsTab layout style).
function RequestDetailDrawer({ detail, onClose }) {
  if (!detail) return null;
  return (
    <Drawer isOpen={!!detail} onClose={onClose} title="Request Detail" width="lg">
      <div className="space-y-6">
        <div className="grid min-w-0 grid-cols-1 gap-4 text-sm sm:grid-cols-2">
          <div>
            <span className="text-text-muted">ID:</span>{" "}
            <span className="break-all font-mono text-text-main">{detail.id}</span>
          </div>
          <div>
            <span className="text-text-muted">Timestamp:</span>{" "}
            <span className="text-text-main">{DATE_FMT(detail.timestamp)}</span>
          </div>
          <div>
            <span className="text-text-muted">Model:</span>{" "}
            <span className="font-mono text-text-main">{detail.model}</span>
          </div>
          <div>
            <span className="text-text-muted">Status:</span>{" "}
            <span className={cn("font-medium", detail.status === "success" ? "text-green-600" : "text-red-600")}>
              {detail.status}
            </span>
          </div>
          <div>
            <span className="text-text-muted">Input Tokens:</span>{" "}
            <span className="font-mono text-text-main">{num(getInputTokens(detail.tokens))}</span>
          </div>
          <div>
            <span className="text-text-muted">Output Tokens:</span>{" "}
            <span className="font-mono text-text-main">{num(detail.tokens?.completion_tokens || 0)}</span>
          </div>
        </div>

        <div className="space-y-4">
          {detail.request && (
            <CollapsibleSection title="1. Client Request (Input)" defaultOpen icon="input">
              <pre className="max-h-[300px] max-w-full overflow-auto rounded-lg border border-black/5 bg-black/5 p-3 font-mono text-xs text-text-main dark:border-white/5 dark:bg-white/5">
                {JSON.stringify(detail.request, null, 2)}
              </pre>
            </CollapsibleSection>
          )}
          {detail.response?.content && (
            <CollapsibleSection title="2. Client Response (Content)" defaultOpen icon="output">
              <pre className="max-h-[300px] max-w-full overflow-auto rounded-lg border border-black/5 bg-black/5 p-3 font-mono text-xs text-text-main dark:border-white/5 dark:bg-white/5">
                {detail.response.content}
              </pre>
            </CollapsibleSection>
          )}
        </div>
      </div>
    </Drawer>
  );
}

function CollapsibleSection({ title, children, defaultOpen = false, icon = null }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <div className="border border-black/5 dark:border-white/5 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-3 bg-black/[0.02] dark:bg-white/[0.02] hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors"
      >
        <div className="flex items-center gap-2">
          {icon && <span className="material-symbols-outlined text-[18px] text-text-muted">{icon}</span>}
          <span className="font-semibold text-sm text-text-main">{title}</span>
        </div>
        <span className={cn("material-symbols-outlined text-[20px] text-text-muted transition-transform duration-200", isOpen ? "rotate-90" : "")}>
          chevron_right
        </span>
      </button>
      {isOpen && <div className="p-4 border-t border-black/5 dark:border-white/5">{children}</div>}
    </div>
  );
}

// A session stat field. When per-model stats exist the label becomes clickable
// and toggles the breakdown popover anchored at the click position.
function StatField({ label, value, field, onToggle }) {
  if (!onToggle) {
    return (
      <div>
        <span className="text-text-muted">{label}:</span>{" "}
        <span className="font-mono text-text-main">{value}</span>
      </div>
    );
  }
  return (
    <div>
      <button
        type="button"
        onClick={(e) => onToggle(field, e)}
        className="group cursor-pointer text-left"
        title="Click for per-model breakdown"
      >
        <span className="text-text-muted underline decoration-dotted decoration-black/30 underline-offset-2 group-hover:text-text-main dark:decoration-white/30">
          {label}:
        </span>{" "}
        <span className="font-mono text-text-main">{value}</span>
      </button>
    </div>
  );
}

const BREAKDOWN_CELLS = {
  requests: (m) => num(m.requests),
  cost: (m) => `$${Number(m.cost || 0).toFixed(4)}`,
  promptTokens: (m) => num(m.promptTokens),
  completionTokens: (m) => num(m.completionTokens),
  cachedTokens: (m) => num(m.cachedTokens),
  cacheCreationTokens: (m) => num(m.cacheCreationTokens),
  hitRate: (m) => hitRate(m.cachedTokens, m.promptTokens),
};

// Click-triggered popover listing per-model usage for one session. Rendered via
// portal with a fixed overlay (above the z-50 Drawer) so clicks outside close it
// and drawer scroll containers can't clip it.
function ModelBreakdownPopover({ modelStats, field, anchor, onClose }) {
  const totals = modelStats.reduce(
    (acc, m) => {
      for (const f of BREAKDOWN_FIELDS) {
        if (f.sum) acc[f.key] = (acc[f.key] || 0) + (m[f.key] || 0);
      }
      return acc;
    },
    {}
  );
  const fieldDef = BREAKDOWN_FIELDS.find((f) => f.key === field);
  const share = (m) => {
    const t = totals[field] || 0;
    if (!fieldDef?.sum || t <= 0) return null;
    return `${Math.round(((m[field] || 0) / t) * 100)}%`;
  };

  const width = 660;
  const left = Math.max(8, Math.min(anchor.x - width / 2, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(anchor.y + 10, window.innerHeight - 360));

  return createPortal(
    <>
      <div className="fixed inset-0 z-[60]" onClick={onClose} aria-hidden="true" />
      <div
        className="fixed z-[70] overflow-hidden rounded-xl border border-black/10 bg-surface shadow-xl dark:border-white/10"
        style={{ left, top, width }}
      >
        <div className="flex items-center justify-between border-b border-black/5 px-3 py-2 dark:border-white/5">
          <span className="text-xs font-semibold text-text-main">Usage by Model — {fieldDef.label}</span>
          <button type="button" onClick={onClose} className="cursor-pointer text-text-muted hover:text-text-main" aria-label="Close">
            <span className="material-symbols-outlined text-[16px]">close</span>
          </button>
        </div>
        <div className="max-h-[320px] overflow-y-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-black/5 dark:border-white/5">
                <th className="text-left px-3 py-1.5 font-semibold text-text-main">Model</th>
                {BREAKDOWN_FIELDS.map((f) => (
                  <th
                    key={f.key}
                    className={cn(
                      "text-right px-3 py-1.5 font-semibold",
                      f.key === field ? "bg-primary/5 text-text-main" : "text-text-main"
                    )}
                  >
                    {f.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {modelStats.map((m) => (
                <tr key={m.model} className="border-b border-black/5 last:border-b-0 dark:border-white/5">
                  <td className="max-w-[180px] truncate px-3 py-1.5 font-mono text-text-main" title={m.model}>
                    {m.model}
                  </td>
                  {BREAKDOWN_FIELDS.map((f) => (
                    <td
                      key={f.key}
                      className={cn(
                        "whitespace-nowrap px-3 py-1.5 text-right font-mono",
                        f.key === field ? "bg-primary/5 font-semibold text-text-main" : "text-text-main"
                      )}
                    >
                      {BREAKDOWN_CELLS[f.key](m)}
                      {f.key === field && share(m) && (
                        <span className="ml-1 text-text-muted">({share(m)})</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>,
    document.body
  );
}

// Inner drawer: aggregate + the requests that make up this session.
function SessionDrawer({ session, onClose, onViewRequest }) {
  const [requests, setRequests] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, totalItems: 0, totalPages: 0 });
  const [loading, setLoading] = useState(false);
  const [breakdown, setBreakdown] = useState(null); // { field, x, y } | null
  const [fetchedStats, setFetchedStats] = useState([]);
  // The "unclassified" bucket (rows with NULL sessionId) is queried via IS NULL.
  const isUnclassified = !session?.sessionId;
  // The sessions list omits modelStats to keep the tab light, so fetch them for
  // this session when the drawer opens; fall back to inline stats if present.
  const modelStats = fetchedStats.length ? fetchedStats : (session?.modelStats || []);
  // The drawer stays mounted across sessions — drop any open popover on switch/close.
  useEffect(() => { setBreakdown(null); }, [session]);
  useEffect(() => {
    setFetchedStats([]);
    if (!session) return;
    let cancelled = false;
    const params = new URLSearchParams();
    if (isUnclassified) params.append("unclassified", "1");
    else params.append("sessionId", session.sessionId);
    fetch(`/api/usage/sessions?${params}`)
      .then((res) => res.json())
      .then((data) => { if (!cancelled) setFetchedStats(data.session?.modelStats || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [session?.sessionId, isUnclassified]);
  const toggleBreakdown = useCallback((field, e) => {
    setBreakdown((b) => (b && b.field === field ? null : { field, x: e.clientX, y: e.clientY }));
  }, []);
  // Only the stat fields get the popover; when there is no per-model data they render as plain text.
  const onToggle = modelStats.length > 0 ? toggleBreakdown : undefined;

  const fetchRequests = useCallback(async (page = 1) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "20" });
      if (isUnclassified) {
        params.append("unclassified", "1");
      } else {
        params.append("sessionId", session.sessionId);
      }
      const res = await fetch(`/api/usage/session-requests?${params}`);
      const data = await res.json();
      setRequests(data.details || []);
      setPagination((prev) => ({ ...prev, ...data.pagination }));
    } catch (e) {
      console.error("Failed to fetch session requests:", e);
    } finally {
      setLoading(false);
    }
  }, [session?.sessionId, isUnclassified]);

  useEffect(() => {
    fetchRequests(1);
  }, [fetchRequests]);

  if (!session) return null;

  return (
    <Drawer isOpen={!!session} onClose={onClose} title="Session Trace" width="xl">
      <div className="space-y-6">
        <div className="grid min-w-0 grid-cols-1 gap-4 text-sm sm:grid-cols-2">
          <div>
            <span className="text-text-muted">Session ID:</span>{" "}
            <span className="break-all font-mono text-text-main">{session.sessionId || "未归类"}</span>
          </div>
          <div>
            <span className="text-text-muted">Connection:</span>{" "}
            <span className="font-mono text-text-main">{session.connectionId || "—"}</span>
          </div>
          <div>
            <span className="text-text-muted">First Seen:</span>{" "}
            <span className="text-text-main">{DATE_FMT(session.firstSeen)}</span>
          </div>
          <div>
            <span className="text-text-muted">Last Seen:</span>{" "}
            <span className="text-text-main">{DATE_FMT(session.lastSeen)}</span>
          </div>
          <StatField label="Requests" field="requests" onToggle={onToggle} value={num(session.requests)} />
          <StatField label="Cost" field="cost" onToggle={onToggle} value={`$${Number(session.cost || 0).toFixed(4)}`} />
          <StatField label="Input Tokens" field="promptTokens" onToggle={onToggle} value={num(session.promptTokens)} />
          <StatField label="Output Tokens" field="completionTokens" onToggle={onToggle} value={num(session.completionTokens)} />
          <StatField label="Cached Tokens" field="cachedTokens" onToggle={onToggle} value={num(session.cachedTokens)} />
          <StatField label="Cache Creation" field="cacheCreationTokens" onToggle={onToggle} value={num(session.cacheCreationTokens)} />
          <StatField label="Hit Rate" field="hitRate" onToggle={onToggle} value={hitRate(session.cachedTokens, session.promptTokens)} />
        </div>

        <div className="flex flex-wrap gap-2">
          <div>
            <div className="mb-1 text-xs text-text-muted">Providers</div>
            <div className="flex flex-wrap gap-2">
              {(session.providers || []).length ? (
                session.providers.map((p) => (
                  <span key={p} className="rounded bg-black/[0.04] px-2 py-0.5 font-mono text-xs text-text-main dark:bg-white/[0.06]">{p}</span>
                ))
              ) : <span className="text-text-muted">—</span>}
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs text-text-muted">Models</div>
            <div className="flex flex-wrap gap-2">
              {(session.models || []).length ? (
                session.models.map((m) => (
                  <span key={m} className="rounded bg-black/[0.04] px-2 py-0.5 font-mono text-xs text-text-main dark:bg-white/[0.06]">{m}</span>
                ))
              ) : <span className="text-text-muted">—</span>}
            </div>
          </div>
          {onToggle && (
            <div className="ml-auto self-end text-xs text-text-muted">
              <span className="material-symbols-outlined mr-1 align-[-3px] text-[14px]">touch_app</span>
              Click a metric above for per-model breakdown
            </div>
          )}
        </div>

        <div>
          <div className="mb-2 font-semibold text-sm text-text-main">Requests in this session</div>
          <Card padding="none">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px]">
                <thead>
                  <tr className="border-b border-black/5 dark:border-white/5">
                    <th className="text-left p-3 text-sm font-semibold text-text-main">Timestamp</th>
                    <th className="text-left p-3 text-sm font-semibold text-text-main">Model</th>
                    <th className="text-right p-3 text-sm font-semibold text-text-main">Input</th>
                    <th className="text-right p-3 text-sm font-semibold text-text-main">Output</th>
                    <th className="text-right p-3 text-sm font-semibold text-text-main">Cached</th>
                    <th className="text-right p-3 text-sm font-semibold text-text-main">Latency</th>
                    <th className="text-center p-3 text-sm font-semibold text-text-main">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={7} className="p-6 text-center text-text-muted">
                        <div className="flex items-center justify-center gap-2">
                          <span className="material-symbols-outlined animate-spin text-[20px]">progress_activity</span>
                          Loading...
                        </div>
                      </td>
                    </tr>
                  ) : requests.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="p-6 text-center text-text-muted">No requests found</td>
                    </tr>
                  ) : (
                    requests.map((r, i) => (
                      <tr key={`${r.id}-${i}`} className="border-b border-black/5 dark:border-white/5 last:border-b-0 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]">
                        <td className="whitespace-nowrap p-3 text-sm text-text-muted">{DATE_FMT(r.timestamp)}</td>
                        <td className="max-w-[200px] truncate p-3 font-mono text-sm text-text-main">{r.model}</td>
                        <td className="p-3 text-sm text-right font-mono text-text-main">{num(getInputTokens(r.tokens))}</td>
                        <td className="p-3 text-sm text-right font-mono text-text-main">{num(r.tokens?.completion_tokens || 0)}</td>
                        <td className="p-3 text-sm text-right font-mono text-text-main">{num(getCachedTokens(r.tokens))}</td>
                        <td className="p-3 text-sm text-text-muted font-mono">{r.latency?.total || 0}ms</td>
                        <td className="p-3 text-center">
                          <Button variant="outline" size="sm" onClick={() => onViewRequest(r)}>Detail</Button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
          {!loading && requests.length > 0 && (
            <div className="border-t border-black/5 dark:border-white/5">
              <Pagination
                currentPage={pagination.page}
                pageSize={pagination.pageSize}
                totalItems={pagination.totalItems}
                onPageChange={(p) => fetchRequests(p)}
              />
            </div>
          )}
        </div>

        {breakdown && modelStats.length > 0 && (
          <ModelBreakdownPopover
            modelStats={modelStats}
            field={breakdown.field}
            anchor={breakdown}
            onClose={() => setBreakdown(null)}
          />
        )}
      </div>
    </Drawer>
  );
}

export default function TraceTab() {
  const [sessions, setSessions] = useState([]);
  const [total, setTotal] = useState({ sessions: 0, requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 });
  const [unclassified, setUnclassified] = useState(0);
  const [loading, setLoading] = useState(false);
  const [providers, setProviders] = useState([]);
  const [selected, setSelected] = useState(null);
  const [activeRequest, setActiveRequest] = useState(null);

  const [filters, setFilters] = useState({ connectionId: "", startDate: "", endDate: "", search: "" });
  // Default to the last 7 days so the list stays manageable; "custom" is set
  // automatically when the user edits the raw date inputs.
  const [timeRange, setTimeRange] = useState("7d");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const fetchProviders = useCallback(async () => {
    try {
      const res = await fetch("/api/usage/providers");
      const data = await res.json();
      setProviders(data.providers || []);
    } catch { /* ignore */ }
  }, []);

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      // Per-model stats are lazy-loaded per session in the drawer; skipping them
      // here keeps the list payload small even with thousands of sessions.
      params.append("includeModelStats", "false");
      if (filters.connectionId) params.append("connectionId", filters.connectionId);
      if (filters.startDate) params.append("startDate", filters.startDate);
      if (filters.endDate) params.append("endDate", filters.endDate);
      const res = await fetch(`/api/usage/sessions?${params.toString()}`);
      const data = await res.json();
      setSessions(data.sessions || []);
      setTotal(data.total || { sessions: 0, requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 });
      setUnclassified(data.unclassifiedCount || 0);
    } catch (error) {
      console.error("Failed to fetch sessions:", error);
    } finally {
      setLoading(false);
    }
  }, [filters.connectionId, filters.startDate, filters.endDate]);

  useEffect(() => { fetchProviders(); }, [fetchProviders]);
  useEffect(() => { fetchSessions(); }, [fetchSessions]);

  // Quick ranges drive startDate/endDate; editing the raw inputs switches to "custom".
  useEffect(() => {
    if (timeRange === "custom") return;
    if (timeRange === "all") {
      setFilters((f) => ({ ...f, startDate: "", endDate: "" }));
      return;
    }
    const days = QUICK_RANGES.find((r) => r.value === timeRange)?.days || 7;
    setFilters((f) => ({ ...f, startDate: toLocalInputValue(new Date(Date.now() - days * 86400000)), endDate: "" }));
  }, [timeRange]);

  const visibleSessions = filters.search
    ? sessions.filter((s) =>
        (s.sessionId || "").toLowerCase().includes(filters.search.toLowerCase()) ||
        (s.connectionId || "").toLowerCase().includes(filters.search.toLowerCase()) ||
        (s.providers || []).some((p) => p.toLowerCase().includes(filters.search.toLowerCase())) ||
        (s.models || []).some((m) => m.toLowerCase().includes(filters.search.toLowerCase()))
      )
    : sessions;

  // Client-side pagination over the filtered list (sessions are fetched in full).
  // safePage keeps the view in range when a refresh shrinks the result set.
  const safePage = Math.max(1, Math.min(page, Math.ceil(visibleSessions.length / pageSize) || 1));
  const pagedSessions = visibleSessions.slice((safePage - 1) * pageSize, safePage * pageSize);
  useEffect(() => { setPage(1); }, [filters.connectionId, filters.startDate, filters.endDate, filters.search, pageSize]);

  // The "unclassified" bucket (rows with NULL sessionId) is not a real session.
  const realSessionCount = unclassified > 0 ? sessions.length - 1 : sessions.length;

  const handleClearFilters = () => {
    setFilters({ connectionId: "", startDate: "", endDate: "", search: "" });
    setTimeRange("7d");
  };
  const handleView = (s) => { setSelected(s); setActiveRequest(null); };
  const handleCloseSession = () => setSelected(null);
  const handleViewRequest = (r) => setActiveRequest(r);
  const handleCloseRequest = () => setActiveRequest(null);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <SessionSummary total={{ ...total, sessions: realSessionCount }} />

      <Card padding="md">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="trace-range" className="text-sm font-medium text-text-main">Time Range</label>
            <select
              id="trace-range"
              value={timeRange}
              onChange={(e) => setTimeRange(e.target.value)}
              className={cn("h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20 w-full min-w-0 cursor-pointer")}
              style={{ colorScheme: "auto" }}
            >
              {QUICK_RANGES.map((r) => (<option key={r.value} value={r.value}>{r.label}</option>))}
            </select>
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="trace-conn-filter" className="text-sm font-medium text-text-main">Connection</label>
            <select
              id="trace-conn-filter"
              value={filters.connectionId}
              onChange={(e) => setFilters({ ...filters, connectionId: e.target.value })}
              className={cn("h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20 w-full min-w-0 cursor-pointer")}
              style={{ colorScheme: "auto" }}
            >
              <option value="">All Connections</option>
              {providers.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
            </select>
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="trace-start" className="text-sm font-medium text-text-main">Start Date</label>
            <input id="trace-start" type="datetime-local" value={filters.startDate}
              onChange={(e) => { setTimeRange("custom"); setFilters({ ...filters, startDate: e.target.value }); }}
              className="h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface w-full min-w-0 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20" />
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="trace-end" className="text-sm font-medium text-text-main">End Date</label>
            <input id="trace-end" type="datetime-local" value={filters.endDate}
              onChange={(e) => { setTimeRange("custom"); setFilters({ ...filters, endDate: e.target.value }); }}
              className="h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface w-full min-w-0 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20" />
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="trace-search" className="text-sm font-medium text-text-main">Search</label>
            <div className="flex gap-2">
              <input id="trace-search" type="text" placeholder="session / model / provider"
                value={filters.search}
                onChange={(e) => setFilters({ ...filters, search: e.target.value })}
                className="h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface w-full min-w-0 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20" />
              <Button variant="ghost" onClick={handleClearFilters}
                disabled={!filters.connectionId && !filters.search && timeRange === "7d"}
                className="shrink-0">Clear</Button>
            </div>
          </div>
        </div>
      </Card>

      {unclassified > 0 && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-300">
          有未归类请求（历史数据或客户端未发送 session），已合并显示为一行。
        </div>
      )}

      <Card padding="none">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px]">
            <thead>
              <tr className="border-b border-black/5 dark:border-white/5">
                <th className="text-left p-4 text-sm font-semibold text-text-main">Session</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">First Seen</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">Last Seen</th>
                <th className="text-right p-4 text-sm font-semibold text-text-main">Requests</th>
                <th className="text-right p-4 text-sm font-semibold text-text-main">Input Tokens</th>
                <th className="text-right p-4 text-sm font-semibold text-text-main">Output Tokens</th>
                <th className="text-right p-4 text-sm font-semibold text-text-main">Cached</th>
                <th className="text-right p-4 text-sm font-semibold text-text-main">Cache Create</th>
                <th className="text-right p-4 text-sm font-semibold text-text-main">Hit Rate</th>
                <th className="text-right p-4 text-sm font-semibold text-text-main">Cost</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">Providers / Models</th>
                <th className="text-center p-4 text-sm font-semibold text-text-main">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={12} className="p-8 text-center text-text-muted">
                    <div className="flex items-center justify-center gap-2">
                      <span className="material-symbols-outlined animate-spin text-[20px]">progress_activity</span>
                      Loading...
                    </div>
                  </td>
                </tr>
              ) : visibleSessions.length === 0 ? (
                <tr>
                  <td colSpan={12} className="p-8 text-center text-text-muted">暂无会话数据</td>
                </tr>
              ) : (
                pagedSessions.map((s, i) => (
                  <tr
                    key={`${(s.sessionId) || "unclassified"}-${(safePage - 1) * pageSize + i}`}
                    className="border-b border-black/5 dark:border-white/5 last:border-b-0 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="max-w-[240px] truncate p-4 font-mono text-sm text-text-main" title={s.sessionId || ""}>
                      {s.sessionId
                        ? s.sessionId
                        : <span className="text-text-muted">未归类</span>}
                    </td>
                    <td className="whitespace-nowrap p-4 text-sm text-text-muted">{DATE_FMT(s.firstSeen)}</td>
                    <td className="whitespace-nowrap p-4 text-sm text-text-muted">{DATE_FMT(s.lastSeen)}</td>
                    <td className="p-4 text-sm text-text-main text-right font-mono">{num(s.requests)}</td>
                    <td className="p-4 text-sm text-text-main text-right font-mono">{fmtCompact(s.promptTokens)}</td>
                    <td className="p-4 text-sm text-text-main text-right font-mono">{fmtCompact(s.completionTokens)}</td>
                    <td className="p-4 text-sm text-text-main text-right font-mono">{fmtCompact(s.cachedTokens)}</td>
                    <td className="p-4 text-sm text-text-main text-right font-mono">{fmtCompact(s.cacheCreationTokens)}</td>
                    <td className="p-4 text-sm text-text-main text-right font-mono whitespace-nowrap">{hitRate(s.cachedTokens, s.promptTokens)}</td>
                    <td className="p-4 text-sm text-text-main text-right font-mono">${Number(s.cost || 0).toFixed(4)}</td>
                    <td className="max-w-[260px] p-4 text-xs text-text-muted">
                      <div className="flex flex-col gap-0.5">
                        <span className="truncate" title={(s.providers || []).join(", ")}>{(s.providers || []).join(", ") || "—"}</span>
                        <span className="truncate" title={(s.models || []).join(", ")}>{(s.models || []).join(", ") || "—"}</span>
                      </div>
                    </td>
                    <td className="p-4 text-center">
                      <Button variant="outline" size="sm" onClick={() => handleView(s)}>Detail</Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {!loading && visibleSessions.length > 0 && (
          <div className="border-t border-black/5 dark:border-white/5">
            <Pagination
              currentPage={safePage}
              pageSize={pageSize}
              totalItems={visibleSessions.length}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
            />
          </div>
        )}
      </Card>

      <SessionDrawer session={selected} onClose={handleCloseSession} onViewRequest={handleViewRequest} />
      <RequestDetailDrawer detail={activeRequest} onClose={handleCloseRequest} />
    </div>
  );
}
