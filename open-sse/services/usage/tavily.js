/**
 * Tavily usage — GET https://api.tavily.com/usage
 * Auth: Bearer <apiKey>
 *
 * The response reports both the per-key bucket and the account plan bucket for
 * the current billing cycle:
 *   key:     { usage, limit, search_usage, extract_usage, ... }
 *   account: { current_plan, plan_usage, plan_limit, paygo_usage, paygo_limit, ... }
 *
 * `limit` / `plan_limit` are null when the bucket is uncapped. The endpoint
 * exposes no cycle end date, so resetAt is left null and the UI shows the
 * configured emptyMessage instead.
 */

import crypto from "node:crypto";

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { toFiniteNumber } from "./shared.js";

const USAGE_URL = "https://api.tavily.com/usage";
const CYCLE_LABEL = "Current billing cycle";
// The dashboard re-reads every card on a 60s timer, and Tavily answers a burst
// of `/usage` reads with 429 ("excessive requests"), which blanked the card.
// Usage moves slowly, so reuse the last reading instead of re-asking.
const CACHE_TTL_MS = 5 * 60 * 1000;
// A manual refresh (the card's button, refresh-all) still goes to the network,
// but never faster than this, so clicking repeatedly cannot trip the limiter.
const FORCE_FLOOR_MS = 60 * 1000;
// After a 429, stay off the endpoint for a while: retrying on every 60s poll
// keeps the block alive (and Tavily's block message asks for exactly that).
const RATE_LIMIT_BACKOFF_MS = 2 * 60 * 1000;
const CACHE_MAX_ENTRIES = 50;
const cache = new Map();

function cacheKeyFor(apiKey) {
  return crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 24);
}

function ageLabel(age) {
  if (!Number.isFinite(age)) return "";
  const minutes = Math.max(1, Math.round(age / 60000));
  return minutes < 60 ? ` (${minutes}m ago)` : ` (${Math.round(minutes / 60)}h ago)`;
}

/** Keep showing the last good numbers when Tavily refuses to answer. */
function staleUsage(cached, age, reason) {
  if (!cached) return { plan: "Tavily", message: `${reason} Try again in a few minutes.` };
  return {
    ...cached.usage,
    message: `${reason} Showing the last reading${ageLabel(age)}.`,
  };
}

function remember(cacheKey, usage, { blocked = false } = {}) {
  cache.set(cacheKey, { at: Date.now(), usage, blocked });
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
  if (oldest) cache.delete(oldest[0]);
}

function bucket(used, limit) {
  const usage = toFiniteNumber(used, 0);
  const cap = toFiniteNumber(limit, null);

  if (cap === null) {
    return { used: usage, total: 0, unlimited: true, resetAt: null, emptyMessage: CYCLE_LABEL };
  }
  return { used: usage, total: cap, resetAt: null, emptyMessage: CYCLE_LABEL };
}

/**
 * @param {string|null|undefined} apiKey
 * @param {object|null} proxyOptions
 * @param {{ force?: boolean }} options - `force` comes from /api/usage?force=1
 */
export async function getTavilyUsage(apiKey, proxyOptions = null, options = {}) {
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return { message: "Tavily API key not available. Add a key to view usage." };
  }

  const key = apiKey.trim();
  const cacheKey = cacheKeyFor(key);
  const cached = cache.get(cacheKey);
  const age = cached ? Date.now() - cached.at : Number.POSITIVE_INFINITY;
  const ttl = cached?.blocked
    ? RATE_LIMIT_BACKOFF_MS
    : options.force === true
      ? FORCE_FLOOR_MS
      : CACHE_TTL_MS;
  if (cached && age < ttl) return cached.usage;

  try {
    const response = await proxyAwareFetch(
      USAGE_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );

    if (response.status === 429) {
      await response.text().catch(() => "");
      const result = staleUsage(cached, age, "Tavily rate-limited the usage API (429).");
      remember(cacheKey, result, { blocked: true });
      return result;
    }

    if (response.status === 401 || response.status === 403) {
      return { plan: "Tavily", message: "Tavily authentication failed. Check the API key." };
    }

    if (!response.ok) {
      await response.text().catch(() => "");
      // A 5xx is transient: keep the numbers we already have on screen.
      if (response.status >= 500) {
        return staleUsage(cached, age, `Tavily usage API error (${response.status}).`);
      }
      return { plan: "Tavily", message: `Tavily usage API error (${response.status}).` };
    }

    const data = await response.json().catch(() => null);
    if (!data || typeof data !== "object") {
      return { plan: "Tavily", message: "Tavily usage response was not JSON." };
    }

    const account = data.account && typeof data.account === "object" ? data.account : {};
    const keyUsage = data.key && typeof data.key === "object" ? data.key : {};
    const plan = typeof account.current_plan === "string" && account.current_plan.trim()
      ? account.current_plan.trim()
      : "Tavily";

    // An empty payload would otherwise render as two "Unlimited / 0 used"
    // rows, which reads as a real state instead of "nothing reported yet".
    const hasReported = account.plan_limit != null || keyUsage.limit != null
      || toFiniteNumber(account.plan_usage, 0) > 0 || toFiniteNumber(keyUsage.usage, 0) > 0;
    if (!hasReported) {
      return {
        plan,
        message: "Tavily connected. No usage data reported for this key yet.",
        quotas: {},
      };
    }

    const quotas = {};
    quotas[`Plan credits (${plan})`] = bucket(account.plan_usage, account.plan_limit);
    quotas["This key"] = bucket(keyUsage.usage, keyUsage.limit);

    const paygoLimit = toFiniteNumber(account.paygo_limit, 0);
    if (paygoLimit > 0) {
      quotas["Pay-as-you-go"] = bucket(account.paygo_usage, paygoLimit);
    }

    const usage = { plan, quotas };
    remember(cacheKey, usage);
    return usage;
  } catch (error) {
    return staleUsage(cached, age, `Tavily request failed: ${error.message}.`);
  }
}
