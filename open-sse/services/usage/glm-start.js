/**
 * Z.ai Start Plan usage — zcode.z.ai billing endpoints (reverse-engineered from
 * the official client and cross-verified against Ebony-Vinyl/dsh-our-free-model).
 *
 * Endpoint requirements (实测):
 *   - GET /api/v1/zcode-plan/billing/balance : Bearer zcode JWT + X-Device-Mid
 *     (401 without auth, 400 {"code":3001} without X-Device-Mid)
 *   - POST /api/v1/event/report              : no auth, X-Device-Mid in body
 *   - GET  /api/v1/zcode-plan/billing/preview: no auth
 *
 * The daily-grant Start Plan quota does NOT appear in balance buckets — it only
 * shows up in preview.plans AFTER app_launch/app_daily_active events are
 * reported (server gates the grant on client-activity signals). We report the
 * two idempotent events before preview so claimable amounts are truthful.
 * Claiming (POST /billing/claim) needs an aliyun captcha param and is NOT
 * implemented — read-only here.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import crypto from "node:crypto";

const ZCODE_ORIGIN = "https://zcode.z.ai";
const BALANCE_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/balance`;
const PREVIEW_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/preview`;
const EVENT_REPORT_URL = `${ZCODE_ORIGIN}/api/v1/event/report`;
const APP_VERSION = process.env.ZCODE_APP_VERSION || "3.16.3";

function osCategory(platform) {
  switch (platform) {
    case "darwin": return "macos";
    case "win32": return "windows";
    default: return "linux";
  }
}

// Must match the executor's deviceMid() derivation — one device id per JWT.
function deviceMid(jwt) {
  const hex = crypto.createHash("sha256").update(`zcode-device-mid:${jwt || "glm-start"}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function buildHeaders(jwt) {
  return {
    Accept: "application/json",
    ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    "User-Agent": `ZCode/${APP_VERSION}`,
    "HTTP-Referer": ZCODE_ORIGIN,
    "X-ZCode-App-Version": APP_VERSION,
    "X-Release-Channel": "production",
    "X-Client-Language": Intl.DateTimeFormat().resolvedOptions().locale || "unknown",
    "X-Client-Timezone": Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown",
    "X-Device-Mid": deviceMid(jwt),
    "X-Platform": `${process.platform}-${process.arch}`,
    "X-Os-Category": osCategory(process.platform),
  };
}

async function getJson(url, headers, proxyOptions, timeoutMs = 25_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await proxyAwareFetch(url, { method: "GET", headers, signal: controller.signal }, proxyOptions);
    if (!res.ok) return { status: res.status, json: null };
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  } catch (error) {
    return { status: 0, json: null, error };
  } finally {
    clearTimeout(timer);
  }
}

// Idempotent server-side (deduped per device_mid + date); failures are non-fatal.
async function reportActivation(jwt, mid, proxyOptions) {
  for (const event of ["app_launch", "app_daily_active"]) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      await proxyAwareFetch(EVENT_REPORT_URL, {
        method: "POST",
        headers: { ...buildHeaders(jwt), "Content-Type": "application/json" },
        body: JSON.stringify({ event, device_mid: mid, platform: `${process.platform}-${process.arch}`, app_version: APP_VERSION }),
        signal: controller.signal,
      }, proxyOptions).catch(() => null);
      clearTimeout(timer);
    } catch {}
  }
}

async function fetchClaimable(jwt, proxyOptions) {
  const url = `${PREVIEW_URL}?app_version=${encodeURIComponent(APP_VERSION)}&platform=win32`;
  const { json } = await getJson(url, buildHeaders(jwt), proxyOptions, 15_000);
  const plans = Array.isArray(json?.data?.plans) ? json.data.plans : [];
  const out = [];
  for (const plan of plans) {
    if (typeof plan?.plan_id !== "string" || !plan.plan_id) continue;
    const ent = Array.isArray(plan.entitlements) ? plan.entitlements[0] ?? {} : {};
    out.push({
      planId: plan.plan_id,
      ...(typeof plan.name === "string" ? { name: plan.name } : {}),
      ...(Number.isFinite(ent.grant_units) ? { grantUnits: ent.grant_units } : {}),
      ...(typeof ent.unit_type === "string" ? { unitType: ent.unit_type } : {}),
    });
  }
  return out;
}

/**
 * @param {Object} ctx - usage handler context from getUsageForProvider
 * @returns quota shape shared with the other usage providers:
 *   { plan, quotas: { label: { used, total, remaining, remainingPercentage, resetAt, unlimited } }, claimable? }
 */
export async function getGlmStartUsage(ctx, proxyOptions = null) {
  const jwt = ctx?.providerSpecificData?.zcodeJwtToken;
  if (!jwt) return { message: "ZCode JWT not available. Re-run the Start Plan OAuth login." };
  const mid = deviceMid(jwt);

  const { status, json } = await getJson(BALANCE_URL, buildHeaders(jwt), proxyOptions);
  if (status === 401) return { message: "Start Plan credentials rejected (401). Re-run the OAuth login." };
  if (status === 400) return { message: "Start Plan balance request rejected (400 code 3001 — missing/invalid X-Device-Mid)." };
  if (!json) return { message: `Start Plan balance unavailable (HTTP ${status}).` };

  // Enterprise mode sends no numbers — don't render it as "used up".
  if (json?.data?.displayMode === "enterprise") {
    return { plan: "Enterprise", quotas: {}, claimable: [] };
  }

  // Activation events make the daily-grant plans visible in preview.
  await reportActivation(jwt, mid, proxyOptions);
  const claimable = await fetchClaimable(jwt, proxyOptions);

  const buckets = Array.isArray(json?.data?.balances) ? json.data.balances : [];
  // plan_id → display name (from the same response's active plans) so the two
  // tiers ("Start Plan" daily, "1024 Dev Day" one_time) stay distinguishable —
  // keyed by show_name alone they would overwrite each other (same model names).
  const planNames = {};
  for (const plan of (Array.isArray(json?.data?.plans) ? json.data.plans : [])) {
    if (plan && typeof plan.plan_id === "string" && typeof plan.name === "string" && plan.name) {
      planNames[plan.plan_id] = plan.name.replace(/^ZCode\s+/, "");
    }
  }
  const quotas = {};
  let planLabel;
  for (const bucket of buckets) {
    if (!bucket || typeof bucket !== "object") continue;
    const total = Number(bucket.total_units) || 0;
    const used = Number(bucket.used_units) || 0;
    const remaining = Number(bucket.available_units ?? bucket.remaining_units) || 0;
    const usedPercent = total > 0 ? Math.min(100, (used / total) * 100) : 0;
    const remainingPercent = total > 0 ? Math.max(0, 100 - usedPercent) : 0;
    const model = typeof bucket.show_name === "string" && bucket.show_name ? bucket.show_name : (bucket.plan_id || "Start Plan");
    const planName = planNames[bucket.plan_id];
    // One card per (model, plan tier) — a fresh account carries four buckets.
    const label = planName ? `${model} · ${planName}` : model;
    if (!planLabel) planLabel = model;
    quotas[label] = {
      // Token counts are huge; the dashboard renders percentages, so mirror
      // the glm provider's percent convention and carry absolutes in the label.
      used: usedPercent,
      total: 100,
      remaining: remainingPercent,
      remainingPercentage: remainingPercent,
      resetAt: Number(bucket.expires_at) > 0 ? new Date(Number(bucket.expires_at) * 1000).toISOString() : null,
      unlimited: false,
    };
  }

  return {
    plan: planLabel || "Zai Start Plan",
    quotas,
    // Daily-grant plans live outside the balance buckets (server-verified):
    // balance can be empty while a 100M-token daily grant is still claimable.
    ...(claimable.length > 0 ? { claimable } : {}),
  };
}
