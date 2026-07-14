/**
 * Volcengine Ark usage handler
 *
 * Uses `arkcli usage plan` subprocess to get normalized quota data
 * for all subscription buckets (AgentPlan / CodingPlan, personal + team).
 * Returns unified { quotas } format for the Quota Tracker.
 *
 * arkcli handles STS refresh + V4 signing + API normalization internally,
 * so we just parse its JSON output.
 */

import { execFile } from "child_process";
import { readFileSync, readdirSync } from "fs";
import { runArkcliSerialized } from "@/lib/volcengine/arkcliQueue.js";
import { syncTokensToEnv } from "@/lib/volcengine/ssoLogin.js";
import { getVolcengineArkOpenApiUsage } from "./volcengine-ark-openapi.js";
import { join } from "path";

/**
 * Check refresh_token expiry from token.json.
 * Volcengine refresh_tokens have a fixed 2-day lifetime and are NOT
 * rotated by the token endpoint. Once expired, the account must be
 * re-authorized manually.
 *
 * @returns {{expiringSoon: boolean, expired: boolean, hoursLeft: number} | null}
 */
function checkRefreshTokenExpiry(arkcliHome) {
  if (!arkcliHome) return null;
  try {
    const idDir = join(arkcliHome, ".arkcli", "identities");
    const entries = readdirSync(idDir, { withFileTypes: true });
    const idName = entries.find((e) => e.isDirectory())?.name;
    if (!idName) return null;

    const token = JSON.parse(
      readFileSync(join(idDir, idName, "token.json"), "utf8")
    );
    if (!token.refresh_token) return null;

    // Decode JWT payload to get exp
    const parts = token.refresh_token.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    );
    if (!payload.exp) return null;

    const expMs = payload.exp * 1000;
    const now = Date.now();
    const hoursLeft = (expMs - now) / 3600000;

    return {
      expiringSoon: hoursLeft < 6,   // warn within 6 hours
      expired: hoursLeft <= 0,
      hoursLeft: Math.round(hoursLeft * 10) / 10,
    };
  } catch {
    return null;
  }
}

/**
 * Run arkcli usage plan in an isolated HOME directory for the given connection.
 * Each connection has its own arkcli HOME at <DATA_DIR>/arkcli-accounts/<accountId>/
 * to prevent multi-account state from overwriting each other.
 */
function runArkcliUsagePlan(arkcliHome) {
  return runArkcliSerialized(() => new Promise((resolve) => {
    const env = arkcliHome
      ? {
          ...process.env,
          HOME: arkcliHome,
          ARKCLI_ALLOW_HEADLESS_ACTIVATION: "1",
          VOLC_INIT_REGION: "cn-beijing",
          VOLC_INIT_PROJECT_NAME: "default",
        }
      : {
          // Fallback to global HOME for backward compatibility
          ...process.env,
          ARKCLI_ALLOW_HEADLESS_ACTIVATION: "1",
          VOLC_INIT_REGION: "cn-beijing",
          VOLC_INIT_PROJECT_NAME: "default",
        };

    execFile(
      "arkcli",
      ["usage", "plan", "--all", "--format", "json"],
      { timeout: 30000, env, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ error: err.message, stdout, stderr });
          return;
        }
        try {
          const data = JSON.parse(stdout);
          // arkcli may return { ok: false, error: {...} } even on exit 0
          if (data?.ok === false && data?.error?.message) {
            resolve({ error: data.error.message, stdout, stderr });
            return;
          }
          resolve({ data });
        } catch (parseErr) {
          resolve({ error: `Failed to parse arkcli output: ${parseErr.message}`, stdout, stderr });
        }
      }
    );
  }));
}

/**
 * Build a quota entry from an arkcli period object
 * AgentPlan periods: { label, used, total, percent, reset_at }
 * CodingPlan periods: { label, percent, reset_at } (no used/total)
 */
function buildQuotaEntry(period, productLabel) {
  const label = period.label || "unknown";
  const name = `${productLabel} (${label})`;

  // AgentPlan: has used/total
  if (period.used !== undefined && period.total !== undefined && period.total > 0) {
    const used = Number(period.used) || 0;
    const total = Number(period.total) || 0;
    return {
      name,
      used,
      total,
      remaining: Math.max(total - used, 0),
      remainingPercentage: total > 0 ? Math.round(((total - used) / total) * 100) : 0,
      resetAt: period.reset_at || null,
      unlimited: false,
    };
  }

  // CodingPlan: only has percent
  const percent = Number(period.percent) || 0;
  const remainingPercentage = Math.max(0, Math.min(100, 100 - percent));
  return {
    name,
    used: percent,
    total: 100,
    remaining: Math.round(100 - percent),
    remainingPercentage,
    resetAt: period.reset_at || null,
    unlimited: false,
  };
}

/**
 * Main usage handler
 *
 * @param {object} connection - Provider connection with volcIdentityDir
 * @param {object} _providerSpecificData - (unused)
 * @param {object} _proxyOptions - (unused)
 * @returns {Promise<object>} { plan, quotas } or { message }
 */
/**
 * When ark-cli cannot serve usage data (not installed / STS expired / no
 * subscription), fall back to the long-lived IAM AK/SK OpenAPI channel so the
 * user still sees plan + quota info without re-authorizing every 2 days.
 * Returns the OpenAPI result, or null if it cannot serve either.
 */
async function fallbackToOpenApi(connection) {
  try {
    const res = await getVolcengineArkOpenApiUsage(connection, connection.providerSpecificData, null);
    if (res && res.quotas && Object.keys(res.quotas).length > 0) {
      return { ...res, source: "openapi" };
    }
  } catch {
    // ignore — caller will show the original ark-cli message
  }
  return null;
}

export async function getVolcengineArkUsage(connection, _providerSpecificData, _proxyOptions) {
  const psd = connection.providerSpecificData || {};
  if (!psd.volcIdentityDir && !psd.volcAccountId) {
    const fb = await fallbackToOpenApi(connection);
    if (fb) return fb;
    return { message: "Volcengine SSO credentials not found. Please re-login." };
  }

  // Use the isolated arkcli HOME for this account
  const arkcliHome = psd.volcArkcliHome;
  const result = await runArkcliUsagePlan(arkcliHome);

  // After arkcli call (success or failure), sync the latest refresh_token
  // from token.json back to .env. arkcli may have rotated the refresh_token
  // during STS refresh and only written it to token.json. Without this sync,
  // .env retains the old token and future refreshes fail once it expires
  // (refresh_token has a 2-day lifetime).
  // On failure, syncing may also recover a valid refresh_token from token.json
  // when .env's copy was lost/corrupted by a previous failed refresh.
  if (arkcliHome) {
    syncTokensToEnv(arkcliHome, join(arkcliHome, ".arkcli", "identities")).catch(() => {});
  }

  if (result.error) {
    const fb = await fallbackToOpenApi(connection);
    if (fb) return fb;
    return { message: `Volcengine: ${result.error}` };
  }

  const items = result.data?.items || [];
  if (items.length === 0) {
    const fb = await fallbackToOpenApi(connection);
    if (fb) return fb;
    return { message: "Volcengine connected. No active subscriptions found." };
  }

  // Check for STS refresh_token failures (expired/invalid token)
  // Matches both English ("refresh_token", "token invalid") and Chinese
  // ("无 refresh_token 可用", "STS 续期失败", "未找到 refresh_token") errors.
  const stsError = items.find(i => i.error && /refresh_token|STS.*续期|token.*invalid/i.test(i.error));
  if (stsError) {
    const fb = await fallbackToOpenApi(connection);
    if (fb) return fb;
    return { message: "Volcengine SSO token expired. Please re-authorize this account." };
  }

  // Check refresh_token expiry proactively.
  // Volcengine refresh_tokens expire after 2 days and cannot be auto-renewed.
  const tokenStatus = checkRefreshTokenExpiry(arkcliHome);
  if (tokenStatus?.expired) {
    const fb = await fallbackToOpenApi(connection);
    if (fb) return fb;
    return { message: "Volcengine SSO authorization has expired (refresh_token past its 2-day lifetime). Please re-authorize this account." };
  }

  const quotas = {};
  const planParts = [];

  for (const item of items) {
    if (!item.subscribed || !item.periods?.length) continue;

    const product = item.product || "";
    const tier = item.tier || "";
    let label = "";

    // Build label based on product type
    if (product.includes("agent-plan")) {
      label = tier ? `AFP ${tier}` : "AFP";
      if (!planParts.includes("AgentPlan")) planParts.push("AgentPlan");
    } else if (product.includes("coding-plan")) {
      label = "Coding";
      if (!planParts.includes("CodingPlan")) planParts.push("CodingPlan");
    } else {
      label = product;
    }

    // Add edition suffix for team
    if (item.edition === "team") {
      label = `Team ${label}`;
    }

    for (const period of item.periods) {
      const entry = buildQuotaEntry(period, label);
      if (entry) quotas[entry.name] = entry;
    }
  }

  if (Object.keys(quotas).length === 0) {
    const fb = await fallbackToOpenApi(connection);
    if (fb) return fb;
    return { message: "Volcengine connected. No active subscriptions found." };
  }

  return {
    plan: planParts.join(" + ") || null,
    quotas,
    // Warn user when refresh_token will expire soon (must re-authorize within hours)
    warning: tokenStatus?.expiringSoon
      ? `SSO authorization expires in ${tokenStatus.hoursLeft}h. Please re-authorize this account soon to avoid losing access.`
      : undefined,
  };
}
