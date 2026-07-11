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

/**
 * Run arkcli usage plan in an isolated HOME directory for the given connection.
 * Each connection has its own arkcli HOME at <DATA_DIR>/arkcli-accounts/<accountId>/
 * to prevent multi-account state from overwriting each other.
 */
function runArkcliUsagePlan(arkcliHome) {
  return new Promise((resolve) => {
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
  });
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
export async function getVolcengineArkUsage(connection, _providerSpecificData, _proxyOptions) {
  const psd = connection.providerSpecificData || {};
  if (!psd.volcIdentityDir && !psd.volcAccountId) {
    return { message: "Volcengine SSO credentials not found. Please re-login." };
  }

  // Use the isolated arkcli HOME for this account
  const arkcliHome = psd.volcArkcliHome;
  const result = await runArkcliUsagePlan(arkcliHome);

  if (result.error) {
    return { message: `Volcengine: ${result.error}` };
  }

  const items = result.data?.items || [];
  if (items.length === 0) {
    return { message: "Volcengine connected. No active subscriptions found." };
  }

  // Check for STS refresh_token failures (expired/invalid token)
  const stsError = items.find(i => i.error && /refresh_token|STS.*续期|token.*invalid/i.test(i.error));
  if (stsError) {
    return { message: "Volcengine SSO token expired. Please re-authorize this account." };
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
    return { message: "Volcengine connected. No active subscriptions found." };
  }

  return {
    plan: planParts.join(" + ") || null,
    quotas,
  };
}
