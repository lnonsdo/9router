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

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { toFiniteNumber } from "./shared.js";

const USAGE_URL = "https://api.tavily.com/usage";
const CYCLE_LABEL = "Current billing cycle";

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
 */
export async function getTavilyUsage(apiKey, proxyOptions = null) {
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return { message: "Tavily API key not available. Add a key to view usage." };
  }

  try {
    const response = await proxyAwareFetch(
      USAGE_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );

    if (response.status === 401 || response.status === 403) {
      return { plan: "Tavily", message: "Tavily authentication failed. Check the API key." };
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return {
        plan: "Tavily",
        message: `Tavily usage API error (${response.status})${errText ? `: ${errText.slice(0, 120)}` : ""}`,
      };
    }

    const data = await response.json().catch(() => null);
    if (!data || typeof data !== "object") {
      return { plan: "Tavily", message: "Tavily usage response was not JSON." };
    }

    const account = data.account && typeof data.account === "object" ? data.account : {};
    const key = data.key && typeof data.key === "object" ? data.key : {};
    const plan = typeof account.current_plan === "string" && account.current_plan.trim()
      ? account.current_plan.trim()
      : "Tavily";

    // An empty payload would otherwise render as two "Unlimited / 0 used"
    // rows, which reads as a real state instead of "nothing reported yet".
    const hasReported = account.plan_limit != null || key.limit != null
      || toFiniteNumber(account.plan_usage, 0) > 0 || toFiniteNumber(key.usage, 0) > 0;
    if (!hasReported) {
      return {
        plan,
        message: "Tavily connected. No usage data reported for this key yet.",
        quotas: {},
      };
    }

    const quotas = {};
    quotas[`Plan credits (${plan})`] = bucket(account.plan_usage, account.plan_limit);
    quotas["This key"] = bucket(key.usage, key.limit);

    const paygoLimit = toFiniteNumber(account.paygo_limit, 0);
    if (paygoLimit > 0) {
      quotas["Pay-as-you-go"] = bucket(account.paygo_usage, paygoLimit);
    }

    return { plan, quotas };
  } catch (error) {
    return { message: `Tavily error: ${error.message}` };
  }
}
