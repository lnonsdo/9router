/**
 * Exa usage — two sources, in priority order.
 *
 * 1. Desktop sync snapshot. The Tauri shell can open dashboard.exa.ai in a real
 *    browser context (the only place its usage APIs are reachable, since the
 *    dashboard sits behind Vercel's bot challenge), read `/api/get-credits` and
 *    `/api/usage-traffic/volume`, and drop the JSON in
 *    `<DATA_DIR>/exa-sync/<connectionId>.json`. That snapshot is authoritative
 *    and includes the account's credit balance.
 *
 * 2. Local estimate. Without a snapshot, sum the `costDollars.total` that Exa
 *    reports on calls routed through this 9Router instance and compare against
 *    the $10 monthly grant. This never sees traffic from Exa's own dashboard or
 *    hosted MCP, so it is labelled as an estimate.
 */

import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "@/lib/dataDir.js";
import { getProviderSpend } from "@/lib/db/repos/webToolUsageRepo.js";

export const EXA_FREE_MONTHLY_CREDITS_USD = 10;
const SNAPSHOT_DIR_NAME = "exa-sync";

function currentMonthWindow(now = new Date()) {
  return {
    start: new Date(now.getFullYear(), now.getMonth(), 1),
    next: new Date(now.getFullYear(), now.getMonth() + 1, 1),
  };
}

export function exaSnapshotDir(baseDir = DATA_DIR) {
  return path.join(baseDir, SNAPSHOT_DIR_NAME);
}

/**
 * Read the snapshot written by the Tauri shell. Returns null when the file is
 * missing or unreadable (web deployments never have one).
 */
export function readExaSnapshot(connectionId, dir = exaSnapshotDir()) {
  if (!connectionId) return null;
  const safe = String(connectionId).replace(/[^A-Za-z0-9_-]/g, "");
  if (!safe) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, `${safe}.json`), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function shortDate(iso) {
  const date = new Date(iso);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "soon";
}

function relativeTime(iso) {
  const at = Date.parse(iso || "");
  if (!Number.isFinite(at)) return "just now";
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function sumExpiringBuckets(credits) {
  if (!Array.isArray(credits?.expiringCredits) || credits.expiringCredits.length === 0) return null;
  let totalCents = 0;
  let expiresAt = null;
  for (const bucket of credits.expiringCredits) {
    const cents = Number(bucket?.balanceCents);
    if (!Number.isFinite(cents)) continue;
    totalCents += cents;
    const at = typeof bucket?.expiresAt === "string" ? bucket.expiresAt : null;
    if (at && (!expiresAt || at < expiresAt)) expiresAt = at;
  }
  return { totalCents, expiresAt };
}

/**
 * Summarize `/api/usage-traffic/volume`.
 *
 * Documented-by-observation shape (2026-10):
 *   { window: { startDate, endDate }, groupBy: "endpoint",
 *     rows: [{ day: "2026-10-07", group: "/search", count: 16 }, ...] }
 *
 * Older/other shapes (explicit totals, daily series) are kept as fallbacks so a
 * dashboard change degrades to "no count" rather than a wrong one.
 */
export function summarizeVolume(volume) {
  if (!volume || typeof volume !== "object") return null;

  if (Array.isArray(volume.rows)) {
    let total = 0;
    const byEndpoint = {};
    let found = false;
    for (const row of volume.rows) {
      const count = Number(row?.count);
      if (!Number.isFinite(count)) continue;
      total += count;
      found = true;
      const group = typeof row?.group === "string" && row.group
        ? row.group.replace(/^\//, "")
        : "other";
      byEndpoint[group] = (byEndpoint[group] || 0) + count;
    }
    if (found) return { total, byEndpoint };
  }

  for (const key of ["totalRequests", "totalCount", "total", "count", "requests"]) {
    if (Number.isFinite(volume[key])) return { total: volume[key], byEndpoint: {} };
  }

  for (const key of ["data", "volumes", "series", "buckets", "traffic"]) {
    const rows = volume[key];
    if (!Array.isArray(rows)) continue;
    let sum = 0;
    let found = false;
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      for (const field of ["total", "count", "requests", "volume", "value"]) {
        if (Number.isFinite(row[field])) {
          sum += row[field];
          found = true;
          break;
        }
      }
    }
    if (found) return { total: sum, byEndpoint: {} };
  }

  return null;
}

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function dayString(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Keep a budget estimate honest: no false precision on a number this rough. */
function roundEstimate(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value >= 1000) return Math.floor(value / 100) * 100;
  if (value >= 100) return Math.floor(value / 10) * 10;
  return Math.floor(value);
}

/**
 * The request count must cover the current billing month only. Snapshots
 * written before the sync script asked for a calendar-month window carry a
 * rolling 30-day range; presenting that as "this month" would fold the previous
 * cycle's calls back in. Returns true when there is no window to judge.
 */
export function volumeCoversCurrentMonth(volume, now = new Date()) {
  const start = volume?.window?.startDate;
  if (typeof start !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return true;
  return start >= dayString(new Date(now.getFullYear(), now.getMonth(), 1));
}

/**
 * Identify the Exa account a snapshot was taken from.
 * `/api/team-context` carries the team name/plan; `users[]` carries the owner.
 */
export function resolveSnapshotAccount(snapshot) {
  const team = Array.isArray(snapshot?.teamContext?.teams) ? snapshot.teamContext.teams[0] : null;
  const owner = Array.isArray(team?.users) ? team.users[0] : null;
  return {
    teamId: team?.id || null,
    teamName: team?.name || null,
    email: owner?.email || null,
  };
}

/**
 * Exa credits are team-level, so a snapshot is only valid for the connection
 * whose API key belongs to the logged-in account. The dashboard identifies keys
 * by `bearerPrefix` (first 6 chars), which we can compare with the connection's
 * key. Returns true when unverifiable (older snapshot / missing key list).
 */
export function snapshotMatchesConnection(snapshot, connection) {
  const keys = snapshot?.apiKeys?.apiKeys;
  if (!Array.isArray(keys) || keys.length === 0) return true;

  const apiKey = typeof connection?.apiKey === "string" ? connection.apiKey.trim() : "";
  if (!apiKey) return true;

  const prefix = apiKey.slice(0, 6);
  return keys.some((entry) => entry && entry.bearerPrefix === prefix);
}

/**
 * Map a dashboard snapshot to the Quota Tracker shape.
 * Returns null when the snapshot has no usable credits payload.
 */
export function buildSyncedUsage(snapshot, { grantUsd = EXA_FREE_MONTHLY_CREDITS_USD, now = new Date() } = {}) {
  const credits = snapshot?.credits;
  const balanceCents = Number(credits?.orbCreditsInCents);
  if (!Number.isFinite(balanceCents)) return null;

  const expiring = sumExpiringBuckets(credits);
  const quotas = {
    "Credits balance": {
      // A balance has no cap: the UI renders it as a currency row, not a bar.
      used: 0,
      total: Math.round(balanceCents) / 100,
      isCreditBalance: true,
      currency: "USD",
      resetAt: null,
      emptyMessage: expiring?.expiresAt
        ? `Grant expires ${shortDate(expiring.expiresAt)}`
        : "From Exa dashboard",
    },
  };

  if (expiring && expiring.totalCents > 0 && grantUsd > 0) {
    const remainingUsd = expiring.totalCents / 100;
    quotas["Monthly grant"] = {
      used: Math.max(0, Math.round((grantUsd - remainingUsd) * 100) / 100),
      total: grantUsd,
      unit: "USD",
      resetAt: expiring.expiresAt,
    };
  }

  const volumeIsCurrentMonth = volumeCoversCurrentMonth(snapshot.volume, now);
  const volume = volumeIsCurrentMonth ? summarizeVolume(snapshot.volume) : null;
  const endpointSummary = volume
    ? Object.entries(volume.byEndpoint)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${capitalize(name)} ${count}`)
        .join(" / ")
    : "";

  // "Requests left" is a money-budget estimate: this month's average cost per
  // request (grant spent ÷ requests served) applied to the grant still in the
  // cycle. Search and Contents are priced differently, so treat it as a range.
  const remainingUsd = expiring ? expiring.totalCents / 100 : 0;
  const spentUsd = Math.max(0, grantUsd - remainingUsd);
  const avgCostUsd = volume?.total > 0 && spentUsd > 0 ? spentUsd / volume.total : null;
  const remainingRequests = avgCostUsd ? roundEstimate(remainingUsd / avgCostUsd) : null;

  // Rendered as a normal quota row so it keeps the table's progress format:
  // used = calls served this month, total = used + what the money left can buy.
  if (volume && remainingRequests !== null) {
    quotas.Requests = {
      used: volume.total,
      total: Math.max(volume.total, roundEstimate(volume.total + remainingRequests)),
      emoji: "📊",
      resetAt: expiring?.expiresAt || null,
      emptyMessage: `${avgCostUsd.toFixed(4)}/request avg this month`,
    };
  }

  const account = resolveSnapshotAccount(snapshot);
  const accountSuffix = account.teamName ? ` (${account.teamName})` : "";

  return {
    plan: "Exa",
    quotas,
    // The request count lives in `meta` so the card can show it under the quota
    // rows; the note stays a one-liner about where the numbers came from.
    message: `Synced from Exa dashboard${accountSuffix} ${relativeTime(snapshot.syncedAt)}`,
    meta: {
      source: "dashboard-sync",
      syncedAt: snapshot.syncedAt || null,
      requests: volume?.total ?? null,
      byEndpoint: volume?.byEndpoint ?? null,
      endpointSummary: endpointSummary || null,
      // Budget-based ballpark for how many more calls fit in this cycle.
      remainingRequests,
      avgCostUsd,
      // Set when a request-count window was dropped for covering the previous
      // billing month; the card uses it to trigger an immediate re-sync.
      staleVolume: !volumeIsCurrentMonth,
      account,
      estimated: false,
    },
  };
}

/**
 * The desktop shell drops `<id>.status.json` beside the snapshot when a silent
 * sync found Exa's session gone, so the card can say so in plain text instead
 * of only reacting to a hover. A successful sync deletes the file.
 */
export function readExaLoginStatus(connectionId, dir = exaSnapshotDir()) {
  if (!connectionId) return null;
  const safe = String(connectionId).replace(/[^A-Za-z0-9_-]/g, "");
  if (!safe) return null;
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dir, `${safe}.status.json`), "utf8"),
    );
    return parsed && parsed.needsLogin === true ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} connection Provider connection (needs id + providerSpecificData)
 */
export async function getExaUsage(connection) {
  const connectionId = connection?.connectionId || connection?.id;

  const configuredBudget = Number(connection?.providerSpecificData?.exaMonthlyBudgetUsd);
  const grantUsd = Number.isFinite(configuredBudget) && configuredBudget > 0
    ? configuredBudget
    : EXA_FREE_MONTHLY_CREDITS_USD;

  const snapshot = readExaSnapshot(connectionId);
  let mismatchNote = null;

  if (snapshot) {
    if (!snapshotMatchesConnection(snapshot, connection)) {
      const account = resolveSnapshotAccount(snapshot);
      mismatchNote = `Last Exa sync was for ${account.teamName || "another Exa account"}, which does not own this connection's API key. Re-sync while logged into the matching account.`;
    } else {
      const synced = buildSyncedUsage(snapshot, { grantUsd });
      if (synced) {
        const loginStatus = readExaLoginStatus(connectionId);
        if (loginStatus) {
          return {
            ...synced,
            message: `${synced.message} · Exa sign-in expired, so the last sync could not refresh — press refresh and sign in`,
            // The card uses this to send the next refresh through the visible
            // login window instead of another doomed silent attempt.
            meta: { ...synced.meta, needsLogin: true },
          };
        }
        return synced;
      }
    }
  }

  const { start, next } = currentMonthWindow();
  const spend = await getProviderSpend({ provider: "exa", connectionId, startDate: start });

  // Only calls that went through this 9Router instance are visible: Exa's own
  // dashboard/MCP traffic never reaches us, and the dashboard's credit API is
  // behind Vercel's bot challenge. Say so instead of implying "$0 used".
  const localNote = spend.requests > 0
    ? `${spend.requests} request${spend.requests === 1 ? "" : "s"} recorded by 9Router this month (estimated from Exa's per-call cost)`
    : "No Exa calls recorded by 9Router yet. Calls made through Exa's dashboard or the hosted Exa MCP are not visible here. Use the refresh button in the desktop app to import the dashboard balance.";
  const message = mismatchNote ? `${mismatchNote} ${localNote}` : localNote;

  return {
    plan: "Exa (estimated)",
    quotas: {
      "Est. spend this month": {
        used: Math.round(spend.cost * 10000) / 10000,
        total: grantUsd,
        unit: "USD",
        resetAt: next.toISOString(),
        emptyMessage: "Resets monthly",
      },
    },
    message,
    meta: { requests: spend.requests, source: "local", estimated: true },
  };
}
