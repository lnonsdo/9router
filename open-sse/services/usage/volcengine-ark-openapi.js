/**
 * Volcengine Ark OpenAPI usage handler — long-lived IAM AK/SK channel.
 *
 * This is meant to be attached to an EXISTING `volcengine-sso` connection. The
 * SSO flow stores a 2-day STS credential in providerSpecificData (volcAk/volcSk)
 * which cannot be renewed. To remove the re-auth pain, the user can bind their
 * own long-lived IAM AK/SK (volcIamAk/volcIamSk) here. When present we sign
 * requests with those keys (no expiry); otherwise we fall back to the STS creds
 * so behaviour matches the original ark-cli SSO flow.
 *
 * Verified against live API (2026-07):
 *   GetPersonalPlan (Plan=AgentPlan|CodingPlan, Version=2024-01-01, Service=ark)
 *     -> Result: { PlanType, Status, StartTime, EndTime, AutoRenew }
 *   ListBill (billing service, Version=2022-01-01) -> Result.List[]
 *
 * @param {object} connection
 * @param {object} providerSpecificData
 * @param {object} _proxyOptions
 * @returns {Promise<object>} { plan, quotas, message?, usingIam?, raw? }
 */

import { callArkOpenApi } from "../../lib/volcengine/signerV4.js";

const ACTION_VERSION = "2024-01-01";
const PLAN_LABELS = {
  AgentPlan: "Agent Plan",
  CodingPlan: "Coding Plan",
};
const PLAN_TYPE_LABELS = {
  Small: "Small",
  Medium: "Medium",
  Large: "Large",
  Max: "Max",
  Lite: "Lite",
  Pro: "Pro",
};

/**
 * Resolve signing credentials. Prefer long-lived IAM AK/SK; fall back to the
 * 2-day STS creds stored by the SSO flow. Returns { ak, sk, usingIam } or null.
 */
function resolveCredentials(psd) {
  const iamAk = psd?.volcIamAk;
  const iamSk = psd?.volcIamSk;
  if (iamAk && iamSk) return { ak: iamAk, sk: iamSk, usingIam: true };

  const stsAk = psd?.volcAk;
  const stsSk = psd?.volcSk;
  if (stsAk && stsSk) return { ak: stsAk, sk: stsSk, usingIam: false };

  return null;
}

function daysUntil(iso) {
  if (!iso) return null;
  const end = new Date(iso).getTime();
  if (Number.isNaN(end)) return null;
  return Math.ceil((end - Date.now()) / 86400000);
}

/**
 * Build a quota-like entry from a GetPersonalPlan result. Models the
 * subscription as a "time budget" (days remaining) so it slots into the UI as
 * a remaining%/total bar (total = subscription window in days).
 */
function buildPlanEntry(plan, detail) {
  const label = `${PLAN_LABELS[plan] || plan} · ${PLAN_TYPE_LABELS[detail?.PlanType] || detail?.PlanType || "?"}`;

  if (!detail || detail.Status === "Expired") {
    return {
      name: label,
      used: 0,
      total: 0,
      remaining: 0,
      remainingPercentage: 0,
      unlimited: false,
      meta: { status: detail?.Status || "unknown", expired: detail?.Status === "Expired" },
    };
  }

  const start = new Date(detail.StartTime).getTime();
  const end = new Date(detail.EndTime).getTime();
  const totalDays = Math.max(Math.round((end - start) / 86400000), 1);
  const daysLeft = daysUntil(detail.EndTime);
  const usedDays = Math.max(totalDays - daysLeft, 0);
  const pct = Math.max(0, Math.min(100, Math.round((daysLeft / totalDays) * 100)));

  return {
    name: label,
    used: usedDays,
    total: totalDays,
    remaining: daysLeft,
    remainingPercentage: pct,
    unlimited: false,
    meta: {
      status: detail.Status,
      startTime: detail.StartTime,
      endTime: detail.EndTime,
      autoRenew: detail.AutoRenew,
      unit: "天",
    },
  };
}

/**
 * Fetch subscription/plan info for one plan type.
 */
async function fetchPlan(ak, sk, plan) {
  const data = await callArkOpenApi({
    ak,
    sk,
    action: "GetPersonalPlan",
    version: ACTION_VERSION,
    payload: { Plan: plan },
  });
  return data?.Result || null;
}

/**
 * Fetch tier-level usage for a plan via its public OpenAPI:
 *   - Coding Plan: GetCodingPlanUsage  -> Result.QuotaUsage[] (Percent-based)
 *   - Agent Plan : GetAFPUsage         -> Result.{AFPFiveHour,AFPDaily,AFPWeekly,AFPMonthly}
 *                                                (Quota/Used absolute values)
 * Returns an array of normalized tier entries (or []).
 */
async function fetchPlanUsage(ak, sk, plan) {
  if (plan === "CodingPlan") {
    try {
      const data = await callArkOpenApi({
        ak, sk, action: "GetCodingPlanUsage", version: ACTION_VERSION, payload: { Plan: plan },
      });
      return buildTierEntriesFromQuotaUsage(data?.Result);
    } catch {
      return [];
    }
  }
  if (plan === "AgentPlan") {
    try {
      const data = await callArkOpenApi({
        ak, sk, action: "GetAFPUsage", version: ACTION_VERSION, payload: {},
      });
      return buildTierEntriesFromAfp(data?.Result);
    } catch {
      return [];
    }
  }
  return [];
}

const TIER_LABELS = {
  session: "会话",
  weekly: "本周",
  monthly: "本月",
  fivehour: "5 小时",
  daily: "今日",
};

/**
 * Coding Plan: QuotaUsage[] = [{ Level, Percent, ResetTimestamp }]
 */
function buildTierEntriesFromQuotaUsage(usage) {
  if (!usage?.QuotaUsage?.length) return [];
  return usage.QuotaUsage.map((tier) => {
    const level = tier.Level || "unknown";
    const percent = Math.round((Number(tier.Percent) || 0) * 100) / 100;
    const remaining = Math.max(0, Math.round((100 - percent) * 100) / 100);
    const resetAt = tier.ResetTimestamp && tier.ResetTimestamp > 0
      ? new Date(tier.ResetTimestamp * 1000).toISOString()
      : null;
    return {
      name: `Coding Plan · ${TIER_LABELS[level] || level}`,
      used: percent,
      total: 100,
      remaining,
      remainingPercentage: remaining,
      unlimited: false,
      meta: { tier: level, resetAt, isTier: true },
    };
  });
}

/**
 * Agent Plan: GetAFPUsage -> { AFPFiveHour, AFPDaily, AFPWeekly, AFPMonthly }
 * each { Quota, Used, SubscribeTime, ResetTime } with epoch-millis timestamps.
 */
function buildTierEntriesFromAfp(result) {
  if (!result) return [];
  const map = [
    ["AFPFiveHour", "fivehour"],
    ["AFPDaily", "daily"],
    ["AFPWeekly", "weekly"],
    ["AFPMonthly", "monthly"],
  ];
  const out = [];
  for (const [key, level] of map) {
    const t = result[key];
    if (!t || !Number(t.Quota)) continue;
    const quota = Number(t.Quota);
    const used = Number(t.Used) || 0;
    const remaining = Math.max(0, quota - used);
    const percent = Math.round((used / quota) * 10000) / 100;
    const resetAt = t.ResetTime && t.ResetTime > 0
      ? new Date(t.ResetTime).toISOString()
      : null;
    out.push({
      name: `Agent Plan · ${TIER_LABELS[level] || level}`,
      used: Math.round(used * 100) / 100,
      total: quota,
      remaining,
      remainingPercentage: Math.max(0, Math.round((remaining / quota) * 10000) / 100),
      unlimited: false,
      meta: { tier: level, resetAt, isTier: true, isAfp: true, percent },
    });
  }
  return out;
}

/**
 * Main entry. Returns subscription info plus a `usingIam` flag so the UI can
 * show whether the long-lived key is in effect.
 */
export async function getVolcengineArkOpenApiUsage(connection, providerSpecificData, _proxyOptions) {
  const psd = providerSpecificData || connection?.providerSpecificData || {};
  const creds = resolveCredentials(psd);

  if (!creds) {
    return {
      message:
        "未配置火山方舟密钥。请在 SSO 连接设置中绑定长效 IAM AK/SK（推荐），或先完成 SSO 登录以使用临时凭证。",
    };
  }

  const { ak, sk, usingIam } = creds;
  const plans = ["AgentPlan", "CodingPlan"];
  const quotas = {};
  const planLabels = [];
  const details = {};

  for (const plan of plans) {
    try {
      const detail = await fetchPlan(ak, sk, plan);
      if (!detail) continue;
      details[plan] = detail;
      if (detail.Status === "Running") planLabels.push(plan);
      const entry = buildPlanEntry(plan, detail);
      quotas[entry.name] = entry;

      // Tier-level detail (Coding Plan: GetCodingPlanUsage; Agent Plan: GetAFPUsage)
      const tiers = await fetchPlanUsage(ak, sk, plan);
      for (const tier of tiers) {
        quotas[tier.name] = tier;
      }
    } catch (err) {
      // ResourceNotFound.Plan => user does not own this plan; skip silently
      if (!/ResourceNotFound/.test(err.message)) {
        return { message: `火山方舟 OpenAPI 调用失败：${err.message}`, usingIam };
      }
    }
  }

  if (Object.keys(quotas).length === 0) {
    return {
      message: usingIam
        ? "当前 IAM 密钥未查询到 Agent Plan / Coding Plan 订阅。"
        : "当前 SSO 临时凭证未查询到订阅（可能已过期，建议绑定长效 IAM AK/SK）。",
      usingIam,
    };
  }

  return {
    plan: planLabels.map((p) => PLAN_LABELS[p] || p).join(" + ") || null,
    quotas,
    usingIam,
    accountId: psd.volcAccountId || null,
    raw: { channel: usingIam ? "iam-openapi" : "sts-openapi", details },
  };
}
