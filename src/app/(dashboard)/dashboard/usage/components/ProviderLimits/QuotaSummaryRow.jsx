/**
 * Fork-only summary strip for the quota tracker (upstream has no such file, so
 * this never conflicts on a sync). Rendered by `ProviderLimits/index.js` above
 * the upstream `QuotaTable`, which is left untouched.
 *
 * `.jsx` (not `.js`) so Vite/vitest transforms it natively — the tests can mount
 * the real component without patching the upstream `tests/vitest.config.js`.
 *
 * Shows totals the provider does not report: CodeBuddy hands back one refill
 * pack plus several bonus packs and no account-level balance, so the roll-up is
 * computed here from the same rows listed below.
 */

import { summarizeQuotas } from "./quotaExhaustion.js";

function fmtNum(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  // Credit packs are fractional (CodeBuddy reports 6.54 / 500); request packs are
  // integers. Two decimals max, so neither total nor remainder reads as an artifact.
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function remainingColor(pct) {
  if (pct > 70) return "text-green-600 dark:text-green-400";
  if (pct >= 30) return "text-yellow-600 dark:text-yellow-400";
  return "text-red-600 dark:text-red-400";
}

function Stat({ label, value, className, labelText, statText }) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1">
      <span className={`${labelText} uppercase tracking-wide text-text-muted`}>{label}</span>
      <span className={`${statText} font-semibold tabular-nums ${className}`}>{value}</span>
    </span>
  );
}

export default function QuotaSummaryRow({ quotas = [], compact = false, now }) {
  const summary = summarizeQuotas(quotas, now);
  if (!summary.hasData) return null;

  // Mixing unlike units ("requests" + "credits") into one absolute is
  // meaningless, so across mixed units only the unit-free share is reported.
  const showAbsolutes = !summary.mixedUnits;
  const suffix = showAbsolutes && summary.units[0] ? ` ${summary.units[0]}` : "";
  const labelText = compact ? "text-[9px]" : "text-[10px]";
  const statText = compact ? "text-[11px]" : "text-sm";

  const caveats = [];
  if (summary.unlimited > 0) caveats.push(`${summary.unlimited} unlimited ♾ excluded`);
  if (summary.balances > 0) caveats.push(`${summary.balances} credit balance 💰 excluded`);
  // A lapsed one-shot pack can still show credits on it yet be unspendable.
  if (summary.expired > 0) caveats.push(`${summary.expired} expired excluded`);
  if (summary.mixedUnits) caveats.push("mixed units — percentages only");

  return (
    <div
      className="rounded-md border border-black/10 bg-black/[0.02] px-2 py-1.5 dark:border-white/10 dark:bg-white/[0.03]"
      title={`Across all ${summary.rowCount} quota rows of this account`}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        {showAbsolutes ? (
          <>
            <Stat
              label="Total"
              value={`${fmtNum(summary.total)}${suffix}`}
              className="text-text-primary"
              labelText={labelText}
              statText={statText}
            />
            <Stat
              label="Consumed"
              value={`${fmtNum(summary.used)}${suffix}`}
              className="text-text-muted"
              labelText={labelText}
              statText={statText}
            />
          </>
        ) : null}
        <Stat
          label={showAbsolutes ? "Remaining" : "Remaining overall"}
          value={
            showAbsolutes
              ? `${fmtNum(summary.remaining)}${suffix} · ${summary.remainingPercentage}%`
              : `${summary.remainingPercentage}%`
          }
          className={remainingColor(summary.remainingPercentage)}
          labelText={labelText}
          statText={statText}
        />
        {summary.depleted > 0 ? (
          <span className={`${labelText} text-red-600 dark:text-red-400`}>
            {summary.depleted} depleted
          </span>
        ) : null}
      </div>

      {caveats.length > 0 ? (
        // State what the absolutes above leave out, so the strip never looks
        // like it silently under-counts the account.
        <div
          className={`mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-text-muted ${
            compact ? "text-[10px]" : "text-xs"
          }`}
        >
          <span className="material-symbols-outlined text-[11px]">info</span>
          {caveats.map((text) => (
            <span key={text}>{text}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
