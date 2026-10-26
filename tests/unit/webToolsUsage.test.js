import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/db/repos/webToolUsageRepo.js", () => ({
  getProviderSpend: vi.fn(),
}));
vi.mock("@/lib/dataDir.js", () => ({
  DATA_DIR: "/tmp/9router-exa-usage-test",
}));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));
vi.mock("../../src/shared/utils/ssrfGuard.js", () => ({
  fetchPublic: vi.fn(),
}));

import REGISTRY from "../../open-sse/providers/registry/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchPublic } from "../../src/shared/utils/ssrfGuard.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { saveRequestUsage } from "@/lib/usageDb.js";
import { getProviderSpend } from "@/lib/db/repos/webToolUsageRepo.js";
import { getTavilyUsage } from "../../open-sse/services/usage/tavily.js";
import {
  getExaUsage,
  buildSyncedUsage,
  readExaSnapshot,
  summarizeVolume,
  snapshotMatchesConnection,
  volumeCoversCurrentMonth,
  exaSnapshotDir,
  EXA_FREE_MONTHLY_CREDITS_USD,
} from "../../open-sse/services/usage/exa.js";
import { getUsageForProvider } from "../../open-sse/services/webToolQuota.js";
import { handleSearchCore, handleFetchCore } from "../../open-sse/services/webToolUsage.js";
import { USAGE_APIKEY_PROVIDERS, USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers.js";
import { getRemainingPercentage, parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const jsonResponse = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "content-type": "application/json" },
});

const exaSearchConfig = REGISTRY.find((entry) => entry.id === "exa").searchConfig;
const exaFetchConfig = REGISTRY.find((entry) => entry.id === "exa").fetchConfig;

beforeEach(() => {
  vi.clearAllMocks();
  saveRequestUsage.mockResolvedValue();
  // Keep the @/lib/dataDir.js mock clean between tests (and between runs).
  fs.rmSync("/tmp/9router-exa-usage-test", { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web tool quota registration", () => {
  it("flags exa and tavily as usage-capable apikey providers", () => {
    for (const id of ["exa", "tavily"]) {
      const entry = REGISTRY.find((candidate) => candidate.id === id);
      expect(entry.features).toMatchObject({ usage: true, usageApikey: true });
      expect(USAGE_SUPPORTED_PROVIDERS).toContain(id);
      expect(USAGE_APIKEY_PROVIDERS).toContain(id);
    }
  });
});

describe("Tavily usage handler", () => {
  it("maps plan, per-key and pay-as-you-go buckets", async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse({
      key: { usage: 150, limit: 1000 },
      account: {
        current_plan: "Bootstrap",
        plan_usage: 500,
        plan_limit: 4000,
        paygo_usage: 0,
        paygo_limit: null,
      },
    }));

    const result = await getTavilyUsage("tvly-map");

    expect(result.plan).toBe("Bootstrap");
    expect(result.quotas["Plan credits (Bootstrap)"]).toMatchObject({ used: 500, total: 4000 });
    expect(result.quotas["This key"]).toMatchObject({ used: 150, total: 1000 });
    expect(result.quotas["Pay-as-you-go"]).toBeUndefined();
    expect(proxyAwareFetch.mock.calls[0][0]).toBe("https://api.tavily.com/usage");
  });

  it("marks uncapped buckets as unlimited", async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse({
      key: { usage: 12, limit: null },
      account: { current_plan: "Pay as you go", plan_usage: 12, plan_limit: null },
    }));

    const result = await getTavilyUsage("tvly-uncapped");

    expect(result.quotas["Plan credits (Pay as you go)"]).toMatchObject({ used: 12, unlimited: true });
    expect(result.quotas["This key"]).toMatchObject({ used: 12, unlimited: true });
  });

  it("surfaces auth failures without throwing", async () => {
    proxyAwareFetch.mockResolvedValue(new Response("nope", { status: 401 }));

    const result = await getTavilyUsage("bad-key");

    expect(result.quotas).toBeUndefined();
    expect(result.message).toMatch(/authentication failed/i);
  });

  it("reuses a recent reading instead of re-asking every poll", async () => {
    proxyAwareFetch.mockResolvedValue(jsonResponse({
      key: { usage: 5, limit: 1000 },
      account: { current_plan: "Bootstrap", plan_usage: 5, plan_limit: 4000 },
    }));

    // The dashboard polls all cards on a 60s timer; only one call may leave.
    await getTavilyUsage("tvly-cache");
    await getTavilyUsage("tvly-cache");
    await getTavilyUsage("tvly-cache");

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the numbers on screen when Tavily rate-limits the usage API", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      key: { usage: 42, limit: 1000 },
      account: { current_plan: "Bootstrap", plan_usage: 42, plan_limit: 4000 },
    }));

    await getTavilyUsage("tvly-429");
    now.mockReturnValue(1_000_000 + 10 * 60_000); // cache expired
    proxyAwareFetch.mockResolvedValueOnce(new Response("blocked", { status: 429 }));

    const result = await getTavilyUsage("tvly-429");

    expect(result.quotas["This key"]).toMatchObject({ used: 42, total: 1000 });
    expect(result.message).toMatch(/rate-limited/i);
    expect(result.message).toMatch(/last reading/i);
    now.mockRestore();
  });

  it("reports a rate limit plainly when nothing is cached yet", async () => {
    proxyAwareFetch.mockResolvedValue(new Response("blocked", { status: 429 }));

    const result = await getTavilyUsage("tvly-429-cold");

    expect(result.quotas).toBeUndefined();
    expect(result.message).toMatch(/rate-limited/i);
    expect(result.message).toMatch(/try again/i);
  });

  it("backs off after a 429 instead of retrying on every poll", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(3_000_000);
    proxyAwareFetch.mockResolvedValueOnce(new Response("blocked", { status: 429 }));

    const first = await getTavilyUsage("tvly-backoff");
    expect(first.message).toMatch(/rate-limited/i);

    // The next 60s poll must not touch the endpoint while the block is warm.
    now.mockReturnValue(3_000_000 + 60_000);
    const second = await getTavilyUsage("tvly-backoff");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(second.message).toMatch(/rate-limited/i);

    // Once the backoff expires it asks again, and recovers on success.
    now.mockReturnValue(3_000_000 + 121_000);
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      key: { usage: 9, limit: 1000 },
      account: { current_plan: "Bootstrap", plan_usage: 9, plan_limit: 4000 },
    }));
    const third = await getTavilyUsage("tvly-backoff");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(third.quotas["This key"]).toMatchObject({ used: 9, total: 1000 });
    now.mockRestore();
  });

  it("lets a manual refresh through, but not more than once a minute", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    proxyAwareFetch.mockResolvedValue(jsonResponse({
      key: { usage: 7, limit: 1000 },
      account: { current_plan: "Bootstrap", plan_usage: 7, plan_limit: 4000 },
    }));

    await getTavilyUsage("tvly-force");
    now.mockReturnValue(2_000_000 + 30_000);
    await getTavilyUsage("tvly-force", null, { force: true });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);

    now.mockReturnValue(2_000_000 + 61_000);
    await getTavilyUsage("tvly-force", null, { force: true });
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });
});

describe("Exa usage handler", () => {
  it("sums this month's locally recorded spend against the free grant", async () => {
    getProviderSpend.mockResolvedValue({ cost: 1.23456, requests: 12 });

    const result = await getExaUsage({ id: "conn-1", providerSpecificData: {} });

    expect(getProviderSpend).toHaveBeenCalledWith(expect.objectContaining({
      provider: "exa",
      connectionId: "conn-1",
    }));
    expect(result.quotas["Est. spend this month"]).toMatchObject({
      used: 1.2346,
      total: EXA_FREE_MONTHLY_CREDITS_USD,
      unit: "USD",
    });
    expect(Number.isNaN(Date.parse(result.quotas["Est. spend this month"].resetAt))).toBe(false);
    expect(result.meta).toMatchObject({ requests: 12, estimated: true });
    expect(result.message).toContain("12 requests");
  });

  it("uses the per-connection budget override when configured", async () => {
    getProviderSpend.mockResolvedValue({ cost: 2, requests: 3 });

    const result = await getExaUsage({
      id: "conn-1",
      providerSpecificData: { exaMonthlyBudgetUsd: 25 },
    });

    expect(result.quotas["Est. spend this month"].total).toBe(25);
  });

  it("explains that Exa traffic outside 9Router is not counted", async () => {
    getProviderSpend.mockResolvedValue({ cost: 0, requests: 0 });

    const result = await getExaUsage({ id: "conn-1", providerSpecificData: {} });

    expect(result.quotas["Est. spend this month"].used).toBe(0);
    expect(result.message).toMatch(/No Exa calls recorded by 9Router/i);
  });
});

describe("Exa dashboard snapshot (desktop sync)", () => {
  // The sync script asks for the current calendar month; a fixture with a
  // rolling window would be treated as stale (see volumeCoversCurrentMonth).
  const currentMonthStart = (() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  })();

  const snapshot = {
    credits: {
      orbCreditsInCents: 1949.1,
      expiringCredits: [{ balanceCents: 949, expiresAt: "2026-11-01T07:00:00+00:00" }],
    },
    volume: {
      window: { startDate: currentMonthStart, endDate: new Date().toISOString().slice(0, 10) },
      groupBy: "endpoint",
      rows: [
        { day: "2026-10-07", group: "/search", count: 16 },
        { day: "2026-10-09", group: "/contents", count: 4 },
        { day: "2026-10-26", group: "/search", count: 13 },
      ],
    },
    teamContext: {
      teams: [{
        id: "team-1",
        name: "Phoebe Chibi's Personal",
        users: [{ email: "owner@example.com" }],
      }],
    },
    apiKeys: {
      apiKeys: [{ publicId: "key_test", bearerPrefix: "97b1f1", teamId: "team-1" }],
    },
    syncedAt: new Date().toISOString(),
  };

  it("maps credits to a balance row plus the monthly grant", () => {
    const usage = buildSyncedUsage(snapshot, { grantUsd: 10 });

    expect(usage.plan).toBe("Exa");
    expect(usage.quotas["Credits balance"]).toMatchObject({
      total: 19.49,
      isCreditBalance: true,
      currency: "USD",
    });
    expect(usage.quotas["Monthly grant"]).toMatchObject({
      used: 0.51,
      total: 10,
      resetAt: "2026-11-01T07:00:00+00:00",
    });
    expect(usage.message).toBe(
      "Synced from Exa dashboard (Phoebe Chibi's Personal) just now",
    );
    // The note deliberately carries no request count or date range: Exa bills
    // monthly, so a rolling window would mix in the previous cycle's calls. The
    // count is its own "Requests" quota row instead (asserted below).
    expect(usage.message).not.toMatch(/requests|Sep 27|Oct 26/);
    expect(usage.meta).toMatchObject({
      requests: 33,
      byEndpoint: { search: 29, contents: 4 },
      endpointSummary: "Search 29 / Contents 4",
      // $0.51 spent over 33 requests → $0.0155/request, so the $9.49 left in the
      // cycle buys roughly 610 more (deliberately rounded to a round number).
      remainingRequests: 610,
      staleVolume: false,
      account: { teamId: "team-1", teamName: "Phoebe Chibi's Personal" },
      estimated: false,
    });
    expect(usage.meta.avgCostUsd).toBeCloseTo(0.015455, 5);
    // Rendered as a regular quota row so it keeps the table's progress format:
    // 33 served, capacity 33 + ~610 left → "33 / 640", 95% remaining.
    expect(usage.quotas.Requests).toMatchObject({
      used: 33,
      total: 640,
      emoji: "📊",
      resetAt: "2026-11-01T07:00:00+00:00",
    });
  });

  it("skips the requests-left estimate until some money has been spent", () => {
    const fresh = {
      ...snapshot,
      credits: {
        orbCreditsInCents: 1000,
        expiringCredits: [{ balanceCents: 1000, expiresAt: "2026-11-01T07:00:00+00:00" }],
      },
    };

    const usage = buildSyncedUsage(fresh);

    expect(usage.meta.requests).toBe(33);
    expect(usage.meta.remainingRequests).toBeNull();
    expect(usage.meta.avgCostUsd).toBeNull();
    // No money spent yet, so there is no per-request cost to project forward.
    expect(usage.quotas.Requests).toBeUndefined();
  });

  it("drops a rolling 30-day window left behind by an older sync", () => {
    const stale = {
      ...snapshot,
      volume: {
        ...snapshot.volume,
        window: { startDate: "2026-09-27", endDate: "2026-10-26" },
      },
    };

    const usage = buildSyncedUsage(stale);

    // The balance is still valid; only the request count is withheld, because it
    // would include the previous billing cycle.
    expect(usage.quotas["Credits balance"].total).toBe(19.49);
    expect(usage.meta.requests).toBeNull();
    expect(usage.meta.endpointSummary).toBeNull();
    expect(usage.meta.staleVolume).toBe(true);
    expect(volumeCoversCurrentMonth(stale.volume)).toBe(false);
    expect(volumeCoversCurrentMonth({ window: { startDate: currentMonthStart } })).toBe(true);
    expect(volumeCoversCurrentMonth({})).toBe(true);
  });

  it("accepts a snapshot only for the key it belongs to", () => {
    expect(snapshotMatchesConnection(snapshot, { apiKey: "97b1f1deadbeef" })).toBe(true);
    expect(snapshotMatchesConnection(snapshot, { apiKey: "zzzzzzdeadbeef" })).toBe(false);
    // No key list / no connection key: cannot verify, so keep the old behavior.
    expect(snapshotMatchesConnection({}, { apiKey: "97b1f1" })).toBe(true);
    expect(snapshotMatchesConnection(snapshot, {})).toBe(true);
  });

  it("summarizes the real dashboard volume rows by endpoint", () => {
    const summary = summarizeVolume({
      window: { startDate: "2026-09-27", endDate: "2026-10-26" },
      groupBy: "endpoint",
      rows: [
        { day: "2026-10-07", group: "/search", count: 16 },
        { day: "2026-10-08", group: "/search", count: 3 },
        { day: "2026-10-09", group: "/contents", count: 4 },
        { day: "2026-10-09", group: "/search", count: 5 },
        { day: "2026-10-10", group: "/contents", count: 1 },
        { day: "2026-10-10", group: "/search", count: 2 },
        { day: "2026-10-12", group: "/contents", count: 1 },
        { day: "2026-10-14", group: "/contents", count: 3 },
        { day: "2026-10-16", group: "/contents", count: 1 },
        { day: "2026-10-16", group: "/search", count: 1 },
        { day: "2026-10-18", group: "/contents", count: 1 },
        { day: "2026-10-18", group: "/search", count: 4 },
        { day: "2026-10-19", group: "/search", count: 4 },
        { day: "2026-10-20", group: "/search", count: 4 },
        { day: "2026-10-21", group: "/contents", count: 3 },
        { day: "2026-10-21", group: "/search", count: 11 },
        { day: "2026-10-22", group: "/search", count: 3 },
        { day: "2026-10-23", group: "/contents", count: 1 },
        { day: "2026-10-23", group: "/search", count: 2 },
        { day: "2026-10-24", group: "/search", count: 2 },
        { day: "2026-10-25", group: "/contents", count: 2 },
        { day: "2026-10-25", group: "/search", count: 3 },
        { day: "2026-10-26", group: "/contents", count: 1 },
        { day: "2026-10-26", group: "/search", count: 13 },
      ],
    });

    expect(summary.total).toBe(91);
    expect(summary.byEndpoint).toEqual({ search: 73, contents: 18 });
  });

  it("ignores snapshots without a credits payload", () => {
    expect(buildSyncedUsage({ credits: {}, volume: null })).toBeNull();
    expect(buildSyncedUsage(null)).toBeNull();
  });

  it("reads the file the desktop shell writes, with a sanitized id", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-exa-"));
    fs.writeFileSync(path.join(dir, "conn-x.json"), JSON.stringify(snapshot));

    expect(readExaSnapshot("conn-x", dir)).toMatchObject({
      credits: { orbCreditsInCents: 1949.1 },
    });
    // Path separators are stripped, so traversal collapses to a missing name.
    expect(readExaSnapshot("../../etc/passwd", dir)).toBeNull();
    expect(readExaSnapshot(null, dir)).toBeNull();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("prefers a snapshot over the local estimate", async () => {
    // Same base path as the @/lib/dataDir.js mock above, plus the exa-sync dir.
    const snapshotDir = exaSnapshotDir();
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(path.join(snapshotDir, "conn-1.json"), JSON.stringify(snapshot));
    getProviderSpend.mockResolvedValue({ cost: 99, requests: 99 });

    const result = await getExaUsage({ id: "conn-1", providerSpecificData: {} });

    expect(result.meta.source).toBe("dashboard-sync");
    expect(result.quotas["Credits balance"].total).toBe(19.49);
    expect(getProviderSpend).not.toHaveBeenCalled();
  });

  it("rejects a snapshot belonging to another Exa account", async () => {
    const snapshotDir = exaSnapshotDir();
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(path.join(snapshotDir, "conn-9.json"), JSON.stringify(snapshot));
    getProviderSpend.mockResolvedValue({ cost: 0.2, requests: 2 });

    const result = await getExaUsage({
      id: "conn-9",
      apiKey: "zzzzzzdeadbeef",
      providerSpecificData: {},
    });

    // Never show another account's balance; fall back and explain why.
    expect(result.meta.source).toBe("local");
    expect(result.quotas["Credits balance"]).toBeUndefined();
    expect(result.message).toContain("does not own this connection's API key");
    expect(result.message).toContain("Phoebe Chibi's Personal");
  });
});

describe("web tool usage recording", () => {
  it("records Exa search cost from costDollars.total", async () => {
    fetchPublic.mockResolvedValue(jsonResponse({
      results: [{ title: "Result", url: "https://example.com", highlights: ["snippet"] }],
      costDollars: { total: 0.012 },
    }));

    const result = await handleSearchCore({
      body: { query: "harness engineering" },
      provider: { id: "exa" },
      providerConfig: exaSearchConfig,
      credentials: { apiKey: "exa-provider-key", connectionId: "conn-1" },
      clientApiKey: "client-key",
    });

    expect(result.success).toBe(true);
    expect(result.data.usage.provider_cost_usd).toBe(0.012);
    expect(saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "exa",
      model: "web-search",
      cost: 0.012,
      connectionId: "conn-1",
      apiKey: "client-key",
      endpoint: "/v1/search",
    }));
  });

  it("falls back to the registry cost when a provider reports none", async () => {
    fetchPublic.mockResolvedValue(jsonResponse({
      results: [{ title: "Result", url: "https://example.com", highlights: ["snippet"] }],
    }));

    await handleSearchCore({
      body: { query: "harness engineering" },
      provider: { id: "exa" },
      providerConfig: exaSearchConfig,
      credentials: { apiKey: "exa-provider-key", connectionId: "conn-1" },
      clientApiKey: "client-key",
    });

    expect(saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      cost: exaSearchConfig.costPerQuery,
    }));
  });

  it("records Exa fetch cost from costDollars.total", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse({
      results: [{ title: "Page", text: "Body" }],
      costDollars: { total: 0.001 },
    }))));

    const result = await handleFetchCore({
      url: "https://example.com/article",
      provider: "exa",
      providerConfig: exaFetchConfig,
      credentials: { apiKey: "exa-provider-key", connectionId: "conn-1" },
      clientApiKey: "client-key",
    });

    expect(result.success).toBe(true);
    expect(result.data.usage.provider_cost_usd).toBe(0.001);
    expect(saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "exa",
      model: "web-fetch",
      cost: 0.001,
      connectionId: "conn-1",
      endpoint: "/v1/web/fetch",
    }));
  });
});

describe("usage dispatcher", () => {
  it("routes exa and tavily through getUsageForProvider with the connection id", async () => {
    getProviderSpend.mockResolvedValue({ cost: 0, requests: 0 });
    proxyAwareFetch.mockResolvedValue(jsonResponse({
      key: { usage: 1, limit: 1000 },
      account: { current_plan: "Bootstrap", plan_usage: 1, plan_limit: 1000 },
    }));

    const exa = await getUsageForProvider({ id: "conn-exa", provider: "exa", apiKey: "exa-key" });
    expect(exa.quotas["Est. spend this month"]).toBeDefined();
    expect(getProviderSpend).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "conn-exa" }));

    const tavily = await getUsageForProvider({ id: "conn-tv", provider: "tavily", apiKey: "tvly-key" });
    expect(tavily.plan).toBe("Bootstrap");
    expect(proxyAwareFetch).toHaveBeenCalled();
  });
});

describe("quota normalization", () => {
  it("forwards money units and unlimited flags from the generic branch", () => {
    const rows = parseQuotaData("exa", {
      quotas: {
        "Est. spend this month": { used: 1.5, total: 10, unit: "USD", resetAt: "2026-11-01T00:00:00.000Z" },
      },
    });

    expect(rows).toEqual([
      expect.objectContaining({ name: "Est. spend this month", used: 1.5, total: 10, unit: "USD" }),
    ]);
  });

  it("keeps unlimited rows renderable", () => {
    const rows = parseQuotaData("tavily", {
      quotas: {
        "This key": { used: 7, total: 0, unlimited: true, emptyMessage: "Current billing cycle" },
      },
    });

    expect(rows[0]).toMatchObject({ used: 7, unlimited: true, emptyMessage: "Current billing cycle" });
  });

  it("forwards a custom row emoji", () => {
    const rows = parseQuotaData("exa", {
      quotas: {
        Requests: { used: 96, total: 1600, emoji: "📊", resetAt: "2026-11-01T00:00:00.000Z" },
      },
    });

    expect(rows[0]).toMatchObject({ name: "Requests", used: 96, total: 1600, emoji: "📊" });
    // 1600 - 96 left of the projected capacity → the table's progress bar.
    expect(getRemainingPercentage(rows[0])).toBe(94);
  });
});
