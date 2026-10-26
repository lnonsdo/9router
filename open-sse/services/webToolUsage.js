/**
 * Fork-only web-tool usage bridge.
 *
 * Wraps the upstream search/fetch cores so every successful call is recorded
 * exactly once, keeping the accounting out of upstream files. Upstream only
 * gains one small anchor: a `provider_cost_usd` field in each response's usage
 * envelope, carrying the amount the provider itself reported (Exa's
 * `costDollars.total`). Everything else lives here or in the sibling fork
 * modules (`webToolQuota.js`, `usage/{exa,tavily}.js`).
 */

import { handleSearchCore as handleSearchCoreUpstream } from "../handlers/search/index.js";
import { handleFetchCore as handleFetchCoreUpstream } from "../handlers/fetch/index.js";
import { saveRequestUsage } from "@/lib/usageDb.js";

/**
 * Record one web-tool call as a usage entry.
 *
 * Web tools bill per request rather than per token and have no entry in the
 * model pricing table, so the billed amount is supplied by the caller.
 *
 * @param {object} params
 * @param {string} params.provider            Provider id (exa, tavily, brave-search, ...)
 * @param {"search"|"fetch"} params.operation
 * @param {string} [params.connectionId]
 * @param {string} [params.apiKey]            Client-facing API key, never the provider's
 * @param {number|null} [params.costUsd]      Billed amount for this call
 */
export function recordWebToolUsage({ provider, operation, connectionId, apiKey, costUsd }) {
  if (!provider || !operation) return Promise.resolve();

  const cost = Number.isFinite(costUsd) ? Math.max(0, costUsd) : 0;

  return saveRequestUsage({
    provider,
    model: `web-${operation}`,
    tokens: { prompt_tokens: 0, completion_tokens: 0 },
    cost,
    timestamp: new Date().toISOString(),
    connectionId: connectionId || undefined,
    apiKey: apiKey || undefined,
    endpoint: operation === "search" ? "/v1/search" : "/v1/web/fetch",
  }).catch(() => {});
}

// Prefer the provider-reported amount; fall back to the registry's per-query price.
function resolveCost(usage, providerConfig) {
  const billed = usage?.provider_cost_usd;
  return Number.isFinite(billed) ? billed : providerConfig?.costPerQuery;
}

/**
 * Drop-in replacement for `handleSearchCore` that records usage on success.
 * @param {object} args Same arguments as the upstream core handler.
 */
export async function handleSearchCore(args) {
  const result = await handleSearchCoreUpstream(args);

  if (result?.success) {
    recordWebToolUsage({
      provider: result.data?.provider,
      operation: "search",
      connectionId: args.credentials?.connectionId,
      apiKey: args.clientApiKey,
      costUsd: resolveCost(result.data?.usage, args.providerConfig),
    });
  }

  return result;
}

/**
 * Drop-in replacement for `handleFetchCore` that records usage on success.
 * @param {object} args Same arguments as the upstream core handler.
 */
export async function handleFetchCore(args) {
  const result = await handleFetchCoreUpstream(args);

  if (result?.success) {
    recordWebToolUsage({
      provider: result.data?.provider,
      operation: "fetch",
      connectionId: args.credentials?.connectionId,
      apiKey: args.clientApiKey,
      costUsd: resolveCost(result.data?.usage, args.providerConfig),
    });
  }

  return result;
}
