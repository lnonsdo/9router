/**
 * Fork-only usage dispatcher for web-tool providers.
 *
 * Upstream `getUsageForProvider` keeps its provider→handler map private and has
 * no registration hook, so this wraps it instead: Exa/Tavily resolve to the fork
 * handlers under `usage/`, every other provider falls through unchanged. Only
 * the quota route imports from here, which keeps `open-sse/services/usage.js`
 * untouched for upstream merges.
 */

import { getUsageForProvider as getUsageForProviderUpstream } from "./usage.js";
import { getExaUsage } from "./usage/exa.js";
import { getTavilyUsage } from "./usage/tavily.js";

/**
 * @param {object} connection     Provider connection from the DB
 * @param {object|null} proxyOptions
 * @param {object} [options]      `{ force }`
 */
export async function getUsageForProvider(connection, proxyOptions = null, options = {}) {
  switch (connection?.provider) {
    case "exa":
      return getExaUsage({ ...connection, connectionId: connection.id });
    case "tavily":
      return getTavilyUsage(connection.apiKey, proxyOptions, options);
    default:
      return getUsageForProviderUpstream(connection, proxyOptions, options);
  }
}
