/**
 * Fork-only quota ranking + roll-up helpers (upstream has no such file, so this
 * never conflicts on a sync).
 *
 * Why this exists: CodeBuddy CN reports one recurring refill pack ("Monthly")
 * plus several one-shot bonus packs, most of them already spent, and the usage
 * handler returns them ordered by cycle end (soonest first). So the tracker's
 * list was really ordered by TIME, and an exhausted or expired bonus pack sat
 * ABOVE the pack that still worked. Rank by how much is left instead, and sink
 * the unusable rows.
 *
 * Kept out of `utils.js` / `QuotaTable.js` on purpose: both are upstream-owned
 * and churn every sync, so ordering and aggregation are computed here and handed
 * in from `ProviderLimits/index.js`. Nothing upstream calls these.
 */

import {
  calculatePercentage,
  getRemainingPercentage,
} from "./utils.js";

// A normalized quota row is one of four kinds. Render order: usable first,
// exhausted last.
export const QUOTA_TIER = {
  ACTIVE: "active",
  UNLIMITED: "unlimited",
  BALANCE: "balance",
  DEPLETED: "depleted",
};

const QUOTA_TIER_RANK = {
  [QUOTA_TIER.ACTIVE]: 0,
  [QUOTA_TIER.UNLIMITED]: 1,
  [QUOTA_TIER.BALANCE]: 2,
  [QUOTA_TIER.DEPLETED]: 3,
};

const hasShareSignal = (quota) =>
  quota?.percentage !== undefined ||
  quota?.remaining !== undefined ||
  quota?.remainingPercentage !== undefined;

/**
 * Reports no finite cap and no provider share. The table paints these "0 / ∞",
 * so they are uncapped rather than used up — they must neither sink as
 * exhausted nor lead the list as about to run out.
 */
export function isUncappedQuota(quota) {
  if (quota?.unlimited === true || quota?.isCreditBalance === true) return false;
  if (hasShareSignal(quota)) return false;
  const total = Number(quota?.total);
  return !Number.isFinite(total) || total <= 0;
}

/**
 * A one-shot pack (`recurring: false`) whose `resetAt` is a hard expiry that has
 * already passed. Its credits can no longer be spent even when `used < total`.
 * Only CodeBuddy emits `recurring`, so this is inert for every other provider.
 */
export function isExpiredQuota(quota, now = Date.now()) {
  if (quota?.unlimited === true || quota?.isCreditBalance === true) return false;
  if (quota?.recurring !== false) return false;
  const resetMs = Date.parse(quota?.resetAt ?? "");
  return Number.isFinite(resetMs) && resetMs <= now;
}

/**
 * Exhausted = provably no room left. Compares the RAW amounts rather than
 * getRemainingPercentage(), because that helper ROUNDS: 499/500 displays as 0%
 * while still having credit, and trusting the rounded value would sink a pack
 * that is nearly — but not actually — empty.
 *
 * A row with no finite cap is not exhausted either; calculatePercentage(used, 0)
 * returns 0, which would bury a row we simply have no data about.
 */
export function isDepletedQuota(quota, now = Date.now()) {
  if (quota?.unlimited === true || quota?.isCreditBalance === true) return false;
  if (isExpiredQuota(quota, now)) return true;

  if (!hasShareSignal(quota)) {
    const total = Number(quota?.total);
    const used = Number(quota?.used);
    if (!Number.isFinite(total) || total <= 0) return false;
    return Number.isFinite(used) ? used >= total : false;
  }

  return getRemainingPercentage(quota) <= 0;
}

export function getQuotaTier(quota, now = Date.now()) {
  if (quota?.unlimited === true) return QUOTA_TIER.UNLIMITED;
  if (quota?.isCreditBalance === true) return QUOTA_TIER.BALANCE;
  if (isUncappedQuota(quota)) return QUOTA_TIER.UNLIMITED;
  if (isDepletedQuota(quota, now)) return QUOTA_TIER.DEPLETED;
  return QUOTA_TIER.ACTIVE;
}

/**
 * Rank rows by remaining capacity, not by time. Exhaustion is the PRIMARY key,
 * so a fully-consumed or lapsed pack can never outrank a live one.
 *
 * `sortMode` still orders *within* the live tier, so upstream's per-provider sort
 * control keeps working: "default" preserves the provider's own order (CodeBuddy
 * = soonest expiry first, which is right for spendable credits), while
 * "remaining-asc"/"remaining-desc" rank by headroom.
 */
export function sortQuotasByExhaustion(quotas, sortMode = "default", now = Date.now()) {
  const rows = (quotas || []).map((quota, index) => ({
    quota,
    index,
    tier: getQuotaTier(quota, now),
    remaining: getRemainingPercentage(quota),
  }));

  rows.sort((a, b) => {
    const tierDiff = QUOTA_TIER_RANK[a.tier] - QUOTA_TIER_RANK[b.tier];
    if (tierDiff !== 0) return tierDiff;

    if (a.tier === QUOTA_TIER.ACTIVE && sortMode !== "default") {
      const remainingDiff =
        sortMode === "remaining-desc" ? b.remaining - a.remaining : a.remaining - b.remaining;
      if (remainingDiff !== 0) return remainingDiff;
    }

    // Stable fallback: never reorder equal-rank rows.
    return a.index - b.index;
  });

  return rows.map((row) => row.quota);
}

/**
 * Aggregate a connection's packs into "total / consumed / remaining".
 *
 * Only live, measurable packs are summed. Unlimited ♾ and credit-balance 💰 rows
 * have no finite capacity; an unknown total would silently add 0 and understate
 * the account; and a lapsed one-shot pack's credits are unspendable, so counting
 * them would promise capacity that does not exist. Each excluded kind is still
 * tallied so the strip can say what it left out.
 *
 * `mixedUnits` guards against adding unlike quantities (requests + credits);
 * the UI then reports only the unit-free percentage.
 */
export function summarizeQuotas(quotas, now = Date.now()) {
  const rows = quotas || [];
  const summary = {
    rowCount: rows.length,
    counted: 0,
    unlimited: 0,
    balances: 0,
    depleted: 0,
    expired: 0,
    total: 0,
    used: 0,
    remaining: 0,
    remainingPercentage: 0,
    units: [],
    mixedUnits: false,
    hasData: false,
    nextResetAt: null,
  };

  for (const quota of rows) {
    const tier = getQuotaTier(quota, now);
    if (tier === QUOTA_TIER.UNLIMITED) {
      summary.unlimited += 1;
      continue;
    }
    if (tier === QUOTA_TIER.BALANCE) {
      summary.balances += 1;
      continue;
    }
    if (tier === QUOTA_TIER.DEPLETED) summary.depleted += 1;
    // Counted as unusable above, but never added to the absolutes.
    if (isExpiredQuota(quota, now)) {
      summary.expired += 1;
      continue;
    }

    const total = Number(quota.total);
    const used = Number(quota.used);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(used)) continue;

    summary.counted += 1;
    summary.total += total;
    summary.used += Math.max(0, used);
    if (quota.unit) summary.units.push(String(quota.unit));

    // Live rows only: an expiry has already passed, so it is never the next date.
    const resetMs = Date.parse(quota.resetAt ?? "");
    if (Number.isFinite(resetMs) && (!summary.nextResetAt || resetMs < summary.nextResetAt)) {
      summary.nextResetAt = resetMs;
    }
  }

  summary.remaining = Math.max(0, summary.total - summary.used);
  summary.remainingPercentage =
    summary.total > 0
      ? Math.max(0, Math.min(100, calculatePercentage(summary.used, summary.total)))
      : 0;
  summary.units = Array.from(new Set(summary.units));
  summary.mixedUnits = summary.units.length > 1;
  summary.hasData = summary.counted > 0;
  summary.nextResetAt = summary.nextResetAt ? new Date(summary.nextResetAt).toISOString() : null;
  return summary;
}

/** Whether a quota set still has anything usable (drives connection-level sink). */
export function hasUsableQuota(quotas, now = Date.now()) {
  return (quotas || []).some((quota) => getQuotaTier(quota, now) !== QUOTA_TIER.DEPLETED);
}

/**
 * Which providers' packs may be summed into one absolute.
 *
 * CodeBuddy hands back independent credit packs sharing one unit, so the sum IS
 * the account balance. Claude/Codex/Google report the SAME allowance nested in
 * overlapping windows (a 5h window inside a weekly one) — adding those totals
 * double-counts capacity, and the honest reading there is the bottleneck window,
 * which the sorted row list already shows. Grok and the 💰 providers mix a spend
 * cap with a wallet, which is likewise not a sum.
 */
const ADDITIVE_QUOTA_PROVIDERS = new Set(["codebuddy-cn", "codebuddy-intl"]);

export function isAdditiveQuotaProvider(provider) {
  return ADDITIVE_QUOTA_PROVIDERS.has(String(provider || "").toLowerCase());
}
