"use client";

/**
 * Web Tools Adapter settings UI — fork-only (Web Tools Adapter is not upstream).
 *
 * Extracted from dashboard/combos/page.js so this fork's edit to that upstream
 * file stays at "import + one render line", which keeps upstream syncs clean.
 */
import { useMemo } from "react";
import { Card, Select, Toggle } from "@/shared/components";
import { resolveProviderId, AI_PROVIDERS } from "@/shared/constants/providers";

// Emulate Anthropic server tools (web_search / web_fetch) on targets that cannot
// run them natively, executing them locally via the chosen search/fetch
// providers and replaying the results to the model.
export const WEB_TOOLS_CAPS = [
  { key: "webSearch", label: "Web Search", icon: "travel_explore", desc: "web_search server tool", providerFilter: (p) => !!(p.searchConfig || p.searchViaChat) },
  { key: "webFetch", label: "Web Fetch", icon: "language", desc: "web_fetch server tool", providerFilter: (p) => !!p.fetchConfig },
];
export const EMPTY_WEB_TOOLS_ENTRY = { enabled: false, roundRobin: false, providers: [] };
export const EMPTY_WEB_TOOLS_ADAPTER = { webSearch: { ...EMPTY_WEB_TOOLS_ENTRY }, webFetch: { ...EMPTY_WEB_TOOLS_ENTRY } };

export function normalizeWebToolsAdapter(raw) {
  const out = {};
  for (const cap of WEB_TOOLS_CAPS) {
    const entry = raw?.[cap.key];
    out[cap.key] = entry && typeof entry === "object"
      ? {
          enabled: entry.enabled === true,
          roundRobin: entry.roundRobin === true,
          providers: Array.isArray(entry.providers) ? entry.providers.filter(Boolean) : [],
        }
      : { ...EMPTY_WEB_TOOLS_ENTRY };
  }
  return out;
}

export default function WebToolsAdapterSection({ webToolsAdapter, onChange, activeProviders }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium">Web Tools Adapter</p>
          <p className="text-xs text-text-muted mt-0.5">
            Target model can&apos;t run Anthropic web_search / web_fetch server tools? 9Router executes them
            locally via the providers below and replays the results to the model.
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-4">
        {WEB_TOOLS_CAPS.map((cap) => (
          <WebToolsCapCard
            key={cap.key}
            cap={cap}
            entry={webToolsAdapter[cap.key] || { ...EMPTY_WEB_TOOLS_ENTRY }}
            onChange={(entry) => onChange({ ...webToolsAdapter, [cap.key]: entry })}
            activeProviders={activeProviders}
          />
        ))}
      </div>
    </div>
  );
}

function WebToolsCapCard({ cap, entry, onChange, activeProviders }) {
  const { enabled, roundRobin, providers } = entry;
  const patch = (p) => onChange({ ...entry, ...p });

  const candidates = useMemo(() => {
    return Object.entries(AI_PROVIDERS || {})
      .filter(([, p]) => cap.providerFilter(p))
      .map(([id, p]) => ({ value: id, label: p.display?.name || id }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [cap]);

  // A selected provider only works once it has a connection (API key) configured.
  const connected = useMemo(() => {
    return new Set((activeProviders || []).map((c) => resolveProviderId(c.provider)).filter(Boolean));
  }, [activeProviders]);

  const handleAdd = (e) => {
    const id = e.target.value;
    if (!id || providers.includes(id)) return;
    patch({ providers: [...providers, id] });
  };

  const handleRemove = (index) => {
    patch({ providers: providers.filter((_, i) => i !== index) });
  };

  const handleMove = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= providers.length) return;
    const next = [...providers];
    [next[index], next[target]] = [next[target], next[index]];
    patch({ providers: next });
  };

  const available = candidates.filter((c) => !providers.includes(c.value));

  return (
    <Card padding="sm" className={`group ${!enabled ? "opacity-50" : ""}`}>
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Master toggle + icon + label */}
        <div className="flex min-w-0 flex-1 items-start gap-2.5 sm:items-center">
          <Toggle
            checked={enabled}
            onChange={(v) => patch({ enabled: v })}
            aria-label={`Enable ${cap.label} adapter`}
          />
          <div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-primary text-[18px]">{cap.icon}</span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <code className="font-mono text-sm font-medium">{cap.label}</code>
              <span className="text-[10px] text-text-muted">— {cap.desc}</span>
            </div>
          </div>
        </div>

        {/* Actions: Round-robin toggle + Add provider (priority order = list order) */}
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:gap-3 sm:shrink-0">
          <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer select-none">
            <Toggle
              checked={roundRobin}
              onChange={(v) => patch({ roundRobin: v })}
              disabled={!enabled}
              aria-label={`Round-robin ${cap.label} adapter`}
            />
            <span>Round</span>
          </label>
          <div className="w-full sm:w-[220px]">
            <Select
              options={available}
              value=""
              onChange={handleAdd}
              placeholder={available.length ? "Add provider…" : "All providers added"}
              disabled={!enabled || available.length === 0}
              selectClassName="py-1.5 text-xs"
            />
          </div>
        </div>
      </div>

      {providers.length === 0 ? (
        <div className="mt-3 py-2 text-center text-xs text-text-muted italic">
          No provider selected — pick at least one to activate emulation
        </div>
      ) : (
        <div className="mt-3 overflow-hidden rounded-lg border border-border/50">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border/40 bg-black/[0.02] text-text-muted dark:bg-white/[0.02]">
                <th className="w-12 px-3 py-1.5 font-medium text-center">#</th>
                <th className="px-3 py-1.5 font-medium">Provider</th>
                <th className="w-24 px-3 py-1.5 font-medium text-center">Order</th>
                <th className="w-12 px-3 py-1.5 font-medium text-right"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30 font-mono">
              {providers.map((providerId, index) => (
                <tr key={`${providerId}-${index}`} className="hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
                  <td className="px-3 py-2 text-center text-text-muted text-[11px] font-sans">
                    #{index + 1}
                  </td>
                  <td className="px-3 py-2 text-text-main">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="truncate">{AI_PROVIDERS?.[resolveProviderId(providerId)]?.display?.name || providerId}</span>
                      {connected.has(resolveProviderId(providerId)) ? (
                        <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-sans text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                          ready
                        </span>
                      ) : (
                        <span className="rounded bg-amber-500/10 px-1.5 py-0.5 font-sans text-[10px] font-medium text-amber-600 dark:text-amber-400">
                          needs key
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleMove(index, -1)}
                        disabled={!enabled || index === 0}
                        className={`p-1 rounded transition-colors ${
                          !enabled || index === 0
                            ? "text-text-muted/20 cursor-not-allowed"
                            : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"
                        }`}
                        title="Move up"
                      >
                        <span className="material-symbols-outlined text-[16px] leading-none">arrow_upward</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMove(index, 1)}
                        disabled={!enabled || index === providers.length - 1}
                        className={`p-1 rounded transition-colors ${
                          !enabled || index === providers.length - 1
                            ? "text-text-muted/20 cursor-not-allowed"
                            : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"
                        }`}
                        title="Move down"
                      >
                        <span className="material-symbols-outlined text-[16px] leading-none">arrow_downward</span>
                      </button>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => handleRemove(index)}
                      disabled={!enabled}
                      className={`p-1 rounded transition-colors ${
                        !enabled
                          ? "text-text-muted/20 cursor-not-allowed"
                          : "text-text-muted hover:text-red-500 hover:bg-red-500/10"
                      }`}
                      title="Remove provider"
                    >
                      <span className="material-symbols-outlined text-[16px] leading-none">close</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
