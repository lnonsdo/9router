/**
 * Web Tools Adapter bridge — connects the open-sse serverToolEmulator to the
 * app-side pieces it cannot reach from the provider-agnostic engine:
 * credential lookup (providerConnections), the SSRF guard and the /v1/search
 * + /v1/web/fetch provider implementations.
 *
 * executeServerTool contract (consumed by open-sse/services/serverToolEmulator.js):
 *   ({ kind: "web_search", input: { query } })        => { ok: true, data: { results } } | { ok: false, error }
 *   ({ kind: "web_fetch",  input: { url } })          => { ok: true, data: { text, title, url } } | { ok: false, error }
 *
 * Fail-soft: every error path returns { ok:false, error } — the emulator turns
 * that into an error tool_result the model can react to, never a failed request.
 */
import { getProviderCredentials, markAccountUnavailable } from "./auth.js";
import { AI_PROVIDERS, resolveProviderId } from "@/shared/constants/providers.js";
import { assertPublicUrlResolved } from "@/shared/utils/ssrfGuard.js";
import { handleSearchCore, handleFetchCore } from "open-sse/services/webToolUsage.js";
import * as log from "../utils/logger.js";

const SEARCH_MAX_RESULTS = 8;

// Round-robin starting index per adapter kind. Global (not per request) so the
// pool usage spreads across requests, mirroring the capacity adapter's
// round-robin combo strategy. Failure still falls through to the next provider.
const roundRobinCounters = new Map();

function roundRobinStartIndex(kind, length) {
  const next = (roundRobinCounters.get(kind) || 0) % length;
  roundRobinCounters.set(kind, (roundRobinCounters.get(kind) || 0) + 1);
  return next;
}

async function runWithCredentials(providerId, provider, providerConfig, fn) {
  // No-auth providers (e.g. searxng via SEARXNG_URL) need no connection lookup.
  if (provider.noAuth) {
    const result = await fn(null);
    return result.success ? { ok: true, data: result.data } : { ok: false, error: result.error || `${providerId} error ${result.status || ""}` };
  }

  // Some search providers reuse a related chat provider's key (ollama-search →
  // ollama, glm web_search → glm) — same fallback the /v1/search handler does.
  const lockKey = `webtools:${providerId}`;
  let credentials = await getProviderCredentials(providerId, new Set(), lockKey);
  if (!credentials && provider.credentialFallback) {
    credentials = await getProviderCredentials(provider.credentialFallback, new Set(), lockKey);
    if (credentials) log.info("WEBTOOLS", `${providerId} reusing ${provider.credentialFallback} credentials`);
  }
  if (!credentials || credentials.allRateLimited) {
    return { ok: false, error: `no credentials for ${providerId}` };
  }

  const result = await fn(credentials);
  if (!result.success) {
    // Attribute the failure so the breaker excludes this connection next time.
    await markAccountUnavailable(credentials.connectionId, result.status || 502, result.error, providerId, lockKey).catch(() => { });
    return { ok: false, error: result.error || `${providerId} error ${result.status || 502}` };
  }
  return { ok: true, data: result.data };
}

export function createWebToolsExecutor({ adapterConfig }) {
  return {
    async execute({ kind, input }) {
      const key = kind === "web_fetch" ? "webFetch" : "webSearch";
      const entry = adapterConfig?.[key];
      if (!entry?.enabled || !Array.isArray(entry.providers) || entry.providers.length === 0) {
        return { ok: false, error: `web tools adapter: ${key} is not configured` };
      }

      let lastError = "no provider configured";
      const startIndex = entry.roundRobin && entry.providers.length > 1
        ? roundRobinStartIndex(kind, entry.providers.length)
        : 0;
      for (let i = 0; i < entry.providers.length; i++) {
        const rawId = entry.providers[(startIndex + i) % entry.providers.length];
        const providerId = resolveProviderId(rawId);
        const provider = AI_PROVIDERS[providerId];
        if (!provider) {
          lastError = `unknown web tools provider: ${rawId}`;
          continue;
        }
        try {
          if (kind === "web_fetch") {
            const providerConfig = provider.fetchConfig;
            if (!providerConfig) {
              lastError = `${providerId} does not support web fetch`;
              continue;
            }
            const url = String(input?.url || "");
            if (!url) return { ok: false, error: "web_fetch: url is required" };
            // Same SSRF protection as the /v1/web/fetch endpoint.
            await assertPublicUrlResolved(url);
            const res = await runWithCredentials(providerId, provider, providerConfig, credentials =>
              handleFetchCore({ url, provider: providerId, providerConfig, credentials, log: (msg) => log.debug("WEBTOOLS", String(msg)) }));
            if (res.ok) {
              return { ok: true, data: { text: res.data?.content?.text || "", title: res.data?.title || "", url: res.data?.url || url } };
            }
            lastError = res.error;
          } else {
            const providerConfig = provider.searchConfig;
            if (!providerConfig && !provider.searchViaChat) {
              lastError = `${providerId} does not support web search`;
              continue;
            }
            const query = String(input?.query || "").trim();
            if (!query) return { ok: false, error: "web_search: query is required" };
            const res = await runWithCredentials(providerId, provider, providerConfig, credentials =>
              handleSearchCore({ body: { query, max_results: SEARCH_MAX_RESULTS }, provider, providerConfig, credentials, log }));
            if (res.ok) {
              return { ok: true, data: { results: Array.isArray(res.data?.results) ? res.data.results : [] } };
            }
            lastError = res.error;
          }
        } catch (e) {
          lastError = e?.message || String(e);
        }
      }
      return { ok: false, error: lastError };
    },
  };
}
