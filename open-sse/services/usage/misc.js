/**
 * Misc usage handlers (iFlow, Ollama, GLM, Vercel AI Gateway, Qoder)
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { PROVIDER_OAUTH } from "../../providers/index.js";
import { U } from "./shared.js";

export { getGlmUsage } from "./glm.js";


// Vercel AI Gateway credits endpoint
// Returns { balance: "95.50", total_used: "4.50" } (USD as decimal strings).
const VERCEL_AI_GATEWAY_CREDITS_URL = U("vercel-ai-gateway").url;

/**
 * iFlow Usage
 */
export async function getIflowUsage(accessToken) {
  try {
    // iFlow may have usage endpoint
    return { message: "iFlow connected. Usage tracked per request." };
  } catch (error) {
    return { message: "Unable to fetch iFlow usage." };
  }
}

const OLLAMA_LIMIT_WINDOWS = {
  session: "Session (5h)",
  weekly: "Weekly (7d)",
  monthly: "Monthly",
};

function addUtcMonths(date, months) {
  const total = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    year, month, Math.min(date.getUTCDate(), lastDay),
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(),
  ));
}

// Free plan: "usage resets monthly from the date you signed up" (ollama.com/pricing).
function nextMonthlyResetFromSignup(createdAt, now = new Date()) {
  const anchor = new Date(createdAt);
  if (Number.isNaN(anchor.getTime())) return null;
  const elapsedMonths = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12
    + (now.getUTCMonth() - anchor.getUTCMonth());
  for (let i = Math.max(0, elapsedMonths); i <= elapsedMonths + 1; i++) {
    const candidate = addUtcMonths(anchor, i);
    if (candidate > now) return candidate.toISOString();
  }
  return null;
}

/**
 * Ollama Cloud Usage
 * GET https://ollama.com/api/usage — `limits.<window>.usage` is a 0..1 ratio
 *   (1.0 = limit reached). Paid plans report session (5h) + weekly (7d); the
 *   free plan reports a single monthly window. No reset timestamp exposed;
 *   the free monthly reset is derived from the account's signup date.
 * POST https://ollama.com/api/me — plan label + CreatedAt (fail-open).
 * Auth: Authorization: Bearer <apiKey>
 */
const OLLAMA_USAGE_URL = "https://ollama.com/api/usage";
const OLLAMA_ME_URL = "https://ollama.com/api/me";
const OLLAMA_BALANCE_URL = "https://ollama.com/api/balance";

export async function getOllamaUsage(apiKey, providerSpecificData, proxyOptions = null) {
  if (!apiKey) {
    return { message: "Ollama Cloud API key not available." };
  }

  try {
    const response = await proxyAwareFetch(OLLAMA_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (response?.status === 401 || response?.status === 403) {
      return { message: "Ollama Cloud API key invalid or expired." };
    }

    if (response && !response.ok) {
      return { message: `Ollama Cloud usage API error (${response.status}).` };
    }

    let data;
    try {
      data = response ? await response.json() : null;
    } catch {
      return { message: "Ollama Cloud usage response was not JSON." };
    }

    // Best-effort plan label from /api/me
    const me = await proxyAwareFetch(OLLAMA_ME_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Length": "0",
      },
    }, proxyOptions).then((r) => (r && r.ok ? r.json() : null)).catch(() => null);

    const planRaw = typeof me?.Plan === "string" ? me.Plan : "";
    const plan = planRaw
      ? planRaw.charAt(0).toUpperCase() + planRaw.slice(1).toLowerCase()
      : "Ollama Cloud";

    const limits = data?.limits && typeof data.limits === "object" ? data.limits : {};

    // Ollama `usage` is a 0..1 ratio (1.0 = limit reached). Convert to a 0..100
    // bar. Do NOT set absolute `remaining` — QuotaTable reads remainingPercentage.
    function ratioQuota(usageRatio, resetAt = null) {
      const ratio = Math.max(0, Math.min(1, Number(usageRatio) || 0));
      const usedPct = Math.round(ratio * 100);
      return { used: usedPct, total: 100, remainingPercentage: 100 - usedPct, resetAt, unlimited: false };
    }

    const monthlyResetAt = planRaw.toLowerCase() === "free" && me?.CreatedAt
      ? nextMonthlyResetFromSignup(me.CreatedAt)
      : null;

    const quotas = {};
    for (const [key, label] of Object.entries(OLLAMA_LIMIT_WINDOWS)) {
      const raw = limits[key]?.usage;
      if (raw === undefined || raw === null) continue;
      const ratio = Number(raw);
      if (Number.isNaN(ratio)) continue;
      quotas[label] = ratioQuota(ratio, key === "monthly" ? monthlyResetAt : null);
    }

    // Modern Ollama Cloud API reports limits and remaining credits via /api/balance
    if (Object.keys(quotas).length === 0) {
      let balanceResponse = null;
      try {
        balanceResponse = await proxyAwareFetch(OLLAMA_BALANCE_URL, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
          },
        }, proxyOptions);
      } catch {
        balanceResponse = null;
      }

      if (balanceResponse && balanceResponse.ok) {
        let balanceData = null;
        try {
          balanceData = await balanceResponse.json();
        } catch {
          balanceData = null;
        }
        const inc = balanceData?.included;

        if (inc?.session) {
          const rem = Number(inc.session.remaining_percent);
          const remPct = Number.isFinite(rem) ? Math.max(0, Math.min(100, rem)) : 100;
          quotas["Session (5h)"] = {
            used: Math.round((100 - remPct) * 100) / 100,
            total: 100,
            remainingPercentage: remPct,
            resetAt: inc.session.resets_at || null,
            unlimited: false,
          };
        }
        if (inc?.weekly) {
          const rem = Number(inc.weekly.remaining_percent);
          const remPct = Number.isFinite(rem) ? Math.max(0, Math.min(100, rem)) : 100;
          quotas["Weekly (7d)"] = {
            used: Math.round((100 - remPct) * 100) / 100,
            total: 100,
            remainingPercentage: remPct,
            resetAt: inc.weekly.resets_at || null,
            unlimited: false,
          };
        }
        if (inc?.allowance_usd !== undefined && inc?.balance_usd !== undefined) {
          const allowance = Number(inc.allowance_usd) || 0;
          const balance = Number(inc.balance_usd) || 0;
          const used = Math.max(0, Math.round((allowance - balance) * 100) / 100);
          const remPct = allowance > 0 ? Math.round((balance / allowance) * 10000) / 100 : 0;
          quotas["Allowance ($)"] = {
            used,
            total: allowance,
            remainingPercentage: remPct,
            resetAt: inc.period?.until || null,
            unlimited: false,
            unit: "USD",
          };
        }
        if (Number(balanceData?.purchased?.balance_usd) > 0) {
          quotas["Purchased Credits"] = {
            used: 0,
            total: Number(balanceData.purchased.balance_usd),
            remainingPercentage: 100,
            isCreditBalance: true,
            currency: "$",
          };
        }
      }
    }

    if (Object.keys(quotas).length === 0) {
      return {
        plan,
        message: "Ollama Cloud connected. No usage limits reported.",
        quotas: {},
      };
    }

    return { plan, quotas };
  } catch (error) {
    return { message: `Ollama Cloud error: ${error.message}` };
  }
}



/**
 * Vercel AI Gateway usage — credit balance for the API key
 *
 * Calls GET /v1/credits which returns:
 *   { "balance": "95.50", "total_used": "4.50" }   (USD as decimal strings)
 *
 * We surface this as a single "Balance ($)" quota row so the existing
 * QuotaTable / progress-bar UI can render it. used = total_used,
 * total = balance + total_used (the original credit allotment), so the
 * remaining percentage equals balance / total.
 *
 * Docs: https://vercel.com/docs/ai-gateway/usage
 */
export async function getVercelAiGatewayUsage(apiKey, proxyOptions = null) {
  if (!apiKey) {
    return { message: "Vercel AI Gateway API key not available." };
  }

  try {
    const response = await proxyAwareFetch(VERCEL_AI_GATEWAY_CREDITS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      return { message: "Vercel AI Gateway API key invalid or expired." };
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const trimmed = errorText ? `: ${errorText.slice(0, 200)}` : "";
      return { message: `Vercel AI Gateway credits API error (${response.status})${trimmed}` };
    }

    const data = await response.json();

    // Vercel returns numeric strings; coerce safely.
    const balance = Number(data?.balance) || 0;
    const totalUsed = Number(data?.total_used) || 0;

    // Vercel gives $5/month free credit. The API doesn't return the
    // monthly allocation so we use the known constant as the denominator.
    const MONTHLY_CREDIT = 5;
    const remainingPercentage = (balance / MONTHLY_CREDIT) * 100;

    if (balance <= 0 && totalUsed <= 0) {
      return {
        plan: "Pay-as-you-go",
        message: "Vercel AI Gateway connected. No credit allocation found (BYOK or unfunded account).",
        quotas: {},
      };
    }

    // "Used (USD)": how much has been spent this month (no fixed cap → unlimited).
    // "Remaining (USD)": balance remaining out of the $5 monthly allocation.
    return {
      plan: "Pay-as-you-go",
      quotas: {
        "Used (USD)": {
          used: totalUsed,
          total: 0,
          remaining: 0,
          remainingPercentage: 100,
          unlimited: true,
        },
        "Remaining (USD)": {
          used: balance,
          total: MONTHLY_CREDIT,
          remaining: balance,
          remainingPercentage,
          unlimited: false,
        },
      },
    };
  } catch (error) {
    return { message: `Vercel AI Gateway error: ${error.message}` };
  }
}

export async function getQoderUsage(accessToken, proxyOptions = null, providerId = "qoder") {
  if (!accessToken) {
    return { message: "Qoder usage unavailable: no access token" };
  }
  try {
    const response = await proxyAwareFetch(
      U(providerId).url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );
    if (!response.ok) {
      return { message: `Qoder connected. Usage fetch returned ${response.status}.` };
    }
    const body = await response.json().catch(() => null);
    if (!body) {
      return { message: "Qoder connected. Usage response was not JSON." };
    }
    // Quota records live under `quotas`; scalar metadata
    // (totalUsagePercentage, isQuotaExceeded, expiresAt) are surfaced as
    // siblings so the dashboard parser doesn't try to render them as rows.
    const userQuota = body.userQuota || {};
    const orgQuota = body.orgResourcePackage || {};
    // Add-on credits (free grants / promos). Qoder emits this block only when
    // the account actually holds a grant — an account that never redeemed one,
    // or consumed it, omits the key entirely. Verified against both regions:
    // qoder CN returns it (e.g. 2200 total) after redeeming the free-credit
    // promo, while an intl account without a grant has no such key. Gating on
    // total > 0 keeps the intl/no-grant shape byte-identical to before.
    const addOnQuota = body.addOnQuota || {};
    const addOnTotal = Number(addOnQuota.total) || 0;
    // Qoder publishes a single absolute reset timestamp (`expiresAt` in ms);
    // surface it on every quota record as ISO so the table can render
    // "resets at" alongside used/total. 253402214400000 (9999-12-31T00:00:00Z)
    // is Qoder's "never expires" sentinel, returned by both regions for
    // open-ended plans — rendering a reset date in the year 9999 is noise, so
    // flag it instead and let the tracker word it as "Never expires".
    const expiresAtMs = Number.isFinite(Number(body.expiresAt)) && Number(body.expiresAt) > 0
      ? Number(body.expiresAt)
      : null;
    const NO_RESET_SENTINEL_MS = 253402214400000;
    const neverExpires = expiresAtMs === NO_RESET_SENTINEL_MS;
    const resetAt = expiresAtMs && !neverExpires ? new Date(expiresAtMs).toISOString() : null;
    const quotas = {
      user: {
        total: Number(userQuota.total) || 0,
        used: Number(userQuota.used) || 0,
        remaining: Number(userQuota.remaining) || 0,
        unit: userQuota.unit || "credits",
        resetAt,
        neverExpires,
      },
      organization: {
        total: Number(orgQuota.total) || 0,
        used: Number(orgQuota.used) || 0,
        remaining: Number(orgQuota.remaining) || 0,
        unit: orgQuota.unit || "credits",
        resetAt,
        neverExpires,
      },
    };
    if (addOnTotal > 0) {
      quotas.addOn = {
        total: addOnTotal,
        used: Number(addOnQuota.used) || 0,
        remaining: Number(addOnQuota.remaining) || 0,
        unit: addOnQuota.unit || "credits",
        // The add-on block carries no expiry of its own in this API. Qoder's
        // web console lists every redeemed resource package with its own
        // deadline (check-in bonuses do expire, typically ~30 days), but
        // openapi only exposes the account-level `expiresAt` sentinel above,
        // which describes the plan, not the grants — reusing it here would
        // advertise "never expires" for credits that actually expire. So
        // leave the reset date unset and let the row link to Qoder's own
        // usage page (detailUrl) where the per-package dates live.
        resetAt: null,
        neverExpires: false,
        detailUrl: addOnQuota.detailUrl || null,
      };
    }
    return {
      quotas,
      totalUsagePercentage: Number(body.totalUsagePercentage) || 0,
      isQuotaExceeded: !!body.isQuotaExceeded,
      expiresAt: expiresAtMs,
    };
  } catch (error) {
    return { message: `Qoder connected. Unable to fetch usage: ${error.message}` };
  }
}

// Open Design (AMR) console — the runtime API key (sk-amr-…) is inference-only:
// every /api/v1 wallet and billing route answers 401 for it (probed: Bearer,
// x-api-key, x-amr-api-key, query param, all 401). Two console credentials do
// work, in order of preference:
//   • providerSpecificData.amrControlKey — minted by the browser device login
//     (same flow as `vela login`); sent as `Authorization: Bearer`.
//   • providerSpecificData.amrSessionCookie — the console's
//     `__Secure-better-auth.session_token` replayed as a Cookie header.
// Routes:
//   GET /workspaces/current                          → workspaceId + tier
//   GET /workspaces/{id}/billing/coding-plan-usage   → credits windows
//   GET /workspaces/{id}/wallet/balance              → balanceUsd + expiresAt
//   GET /wallet/balance                              → legacy fallback (control key)
const OPEN_DESIGN_API = PROVIDER_OAUTH["open-design"]?.apiBaseUrl || "https://amr-api.open-design.ai/api/v1";
const OPEN_DESIGN_SESSION_COOKIE = "__Secure-better-auth.session_token";

const OPEN_DESIGN_WINDOW_LABELS = {
  18000: "Session (5h)",
  86400: "Daily",
  604800: "Weekly (7d)",
  2592000: "Monthly",
};

function openDesignCookie(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return null;
  // Accept either the full `name=value` pair or just the value pasted from the
  // DevTools cookie table.
  return value.includes("=") ? value : `${OPEN_DESIGN_SESSION_COOKIE}=${value}`;
}

export async function getOpenDesignUsage(providerSpecificData, proxyOptions = null) {
  const controlKey = typeof providerSpecificData?.amrControlKey === "string"
    ? providerSpecificData.amrControlKey.trim()
    : "";
  const cookie = openDesignCookie(providerSpecificData?.amrSessionCookie);
  if (!controlKey && !cookie) {
    return {
      message: "Open Design usage needs a browser login (or the console session cookie) — reconnect the account.",
    };
  }

  const headers = controlKey
    ? { Authorization: `Bearer ${controlKey}`, Accept: "application/json" }
    : { Cookie: cookie, Accept: "application/json" };
  const get = async (path) => {
    const response = await proxyAwareFetch(`${OPEN_DESIGN_API}${path}`, { method: "GET", headers }, proxyOptions);
    if (response.status === 401 || response.status === 403) return { unauthorized: true };
    if (!response.ok) return { error: `${path} returned ${response.status}` };
    return { body: await response.json().catch(() => null) };
  };

  try {
    let workspaceId = typeof providerSpecificData?.amrWorkspaceId === "string"
      ? providerSpecificData.amrWorkspaceId.trim()
      : "";
    let tier = "";

    const current = await get("/workspaces/current");
    if (current.unauthorized) {
      return {
        message: controlKey
          ? "Open Design control key rejected — sign in again from the provider page."
          : "Open Design session cookie expired or invalid — copy a fresh one from the console.",
      };
    }
    if (current.body) {
      workspaceId = workspaceId || current.body.workspaceId || current.body.activeWorkspaceId || "";
      tier = current.body.personalMembershipTier || current.body.planId || "";
    }
    if (!workspaceId) {
      // Control-plane keys are workspace-scoped; when /workspaces/current is not
      // exposed to them the workspace list still is.
      const list = await get("/workspaces");
      const items = Array.isArray(list.body?.items) ? list.body.items : [];
      const first = items.find((w) => typeof w?.workspaceId === "string") || items[0];
      workspaceId = typeof first?.workspaceId === "string" ? first.workspaceId : "";
    }
    if (!workspaceId) {
      return { message: "Open Design workspace not found for this account." };
    }

    const usagePath = `/workspaces/${encodeURIComponent(workspaceId)}/billing/coding-plan-usage`;
    // Console sessions can read coding-plan-usage directly; the control key that
    // the device login issues is rejected there (401) and must go through
    // billing/preflight instead (same numbers, plus balance and funding).
    const preflightPath = `/workspaces/${encodeURIComponent(workspaceId)}/billing/preflight`;
    const [usage, preflight, wallet, legacyWallet] = await Promise.all([
      get(usagePath),
      get(preflightPath),
      get(`/workspaces/${encodeURIComponent(workspaceId)}/wallet/balance`),
      // The daemon reads the control-plane's legacy wallet route with the same
      // bearer control key, so keep it as a fallback when the workspace-scoped
      // route is not exposed to this credential.
      get("/wallet/balance"),
    ]);
    const planBody = Array.isArray(usage.body?.windows) && usage.body.windows.length > 0
      ? usage.body
      : preflight.body?.codingPlan || {};
    const balanceBody = wallet.body?.balanceUsd !== undefined
      ? wallet.body
      : legacyWallet.body?.balanceUsd !== undefined
        ? legacyWallet.body
        : preflight.body
          ? { balanceUsd: preflight.body.balanceUsd, expiresAt: wallet.body?.expiresAt || null }
          : null;
    tier = tier
      || (typeof planBody.tier === "string" ? planBody.tier : "")
      || (typeof preflight.body?.tier === "string" ? preflight.body.tier : "");

    const quotas = {};

    for (const window of planBody.windows || []) {
      const total = Number(window.limitCredits);
      const used = Number(window.usedCredits);
      if (!Number.isFinite(total) || total <= 0) continue;
      const seconds = Number(window.durationSeconds);
      const name = OPEN_DESIGN_WINDOW_LABELS[seconds] || `${Math.round(seconds / 86400)}d window`;
      quotas[name] = {
        used: Number.isFinite(used) ? used : 0,
        total,
        remainingPercentage: Math.max(0, Math.min(100, ((total - (used || 0)) / total) * 100)),
        resetAt: window.resetsAt || null,
        unit: "credits",
      };
    }

    const balance = Number(balanceBody?.balanceUsd);
    if (balanceBody && Number.isFinite(balance)) {
      quotas["Wallet balance"] = {
        used: 0,
        total: balance,
        remainingPercentage: 100,
        resetAt: balanceBody.expiresAt || null,
        isCreditBalance: true,
        currency: "USD",
      };
    }

    if (Object.keys(quotas).length === 0) {
      const reason = usage.error || preflight.error || wallet.error || legacyWallet.error || "no usage data reported";
      return { message: `Open Design connected. ${reason}.` };
    }

    return {
      plan: tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : "Open Design",
      quotas,
    };
  } catch (error) {
    return { message: `Open Design usage error: ${error.message}` };
  }
}
