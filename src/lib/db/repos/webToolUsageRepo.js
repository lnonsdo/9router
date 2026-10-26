/**
 * Fork-only usage queries for web-tool providers.
 *
 * Kept out of `usageRepo.js` so the upstream repo file carries only the
 * one-line "caller supplied the cost" change. These queries read the same
 * `usageHistory` table the shared writer populates.
 */

import { getAdapter } from "../driver.js";

/**
 * Sum recorded spend (and request count) for one provider connection since a
 * date. Web-tool quota cards derive their "used" figure from per-request cost
 * recorded locally instead of a provider quota endpoint.
 */
export async function getProviderSpend({ provider, connectionId, startDate } = {}) {
  try {
    const db = await getAdapter();
    const conds = ["provider = ?"];
    const params = [provider];
    if (connectionId) { conds.push("connectionId = ?"); params.push(connectionId); }
    if (startDate) { conds.push("timestamp >= ?"); params.push(new Date(startDate).toISOString()); }

    const row = db.get(
      `SELECT COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS requests
         FROM usageHistory WHERE ${conds.join(" AND ")}`,
      params
    );
    return { cost: Number(row?.cost) || 0, requests: Number(row?.requests) || 0 };
  } catch {
    return { cost: 0, requests: 0 };
  }
}
