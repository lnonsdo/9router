"use client";

import {
  getQuotaCache,
  parseQuotaData,
  setQuotaCache,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils";

const CONNECTIONS_PAGE_SIZE = 100;

/**
 * Data access for usage quota, shared by desktop surfaces (usage panel).
 * Reads the same endpoints as the Quota Tracker page:
 *   GET /api/providers/client        → connection list
 *   GET /api/usage/[connectionId]    → normalized per-connection quota
 * and the same localStorage cache (`quotaCacheData`), so the panel and the
 * tracker stay consistent with each other.
 */

/**
 * Connection list, sorted by provider priority (same as the tracker).
 * Returns an empty array on failure — callers render their own empty state.
 */
export async function fetchConnections() {
  const params = new URLSearchParams({
    page: "1",
    pageSize: String(CONNECTIONS_PAGE_SIZE),
    accountStatus: "all",
    sort: "priority",
  });
  const response = await fetch(`/api/providers/client?${params.toString()}`);
  if (!response.ok) throw new Error("Failed to fetch connections");
  const data = await response.json();
  return data.connections || [];
}

/**
 * Normalized quota entry for one connection: `{ quotas, plan, message, raw }`,
 * where `quotas` are the parsed per-provider rows (see parseQuotaData).
 *
 * Cache-first: without `force` a cached entry (if any) is returned so callers
 * can paint instantly; with `force` the endpoint is re-fetched and the cache
 * updated. 404 (connection gone) resolves to null; auth/API errors resolve to
 * a message-only entry so the UI can surface them as a row.
 */
export async function fetchQuotaEntry(connection, { force = false } = {}) {
  const { id, provider } = connection;
  if (!force) {
    const cached = getQuotaCache()[id];
    if (cached) return cached;
  }

  const response = await fetch(`/api/usage/${id}${force ? "?force=1" : ""}`);
  if (!response.ok) {
    if (response.status === 404) return null;
    const errorData = await response.json().catch(() => ({}));
    const entry = {
      quotas: [],
      plan: null,
      message: errorData.error || response.statusText,
      raw: null,
    };
    setQuotaCache(id, entry);
    return entry;
  }

  const data = await response.json();
  const entry = {
    quotas: parseQuotaData(provider, data),
    plan: data.plan || null,
    message: data.message || null,
    raw: data,
  };
  setQuotaCache(id, entry);
  return entry;
}
