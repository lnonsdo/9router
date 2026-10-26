import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the DB layer at a throwaway directory before it is imported.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-spend-"));
process.env.DATA_DIR = dataDir;

const { saveRequestUsage } = await import("@/lib/usageDb.js");
const { getProviderSpend } = await import("@/lib/db/repos/webToolUsageRepo.js");

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const webToolEntry = (overrides) => ({
  provider: "exa",
  model: "web-search",
  tokens: { prompt_tokens: 0, completion_tokens: 0 },
  apiKey: "client-key",
  endpoint: "/v1/search",
  ...overrides,
});

describe("provider spend aggregation", () => {
  it("sums the explicit per-request cost for one connection and window", async () => {
    const base = Date.now();
    await saveRequestUsage(webToolEntry({ cost: 0.012, connectionId: "conn-a", timestamp: new Date(base).toISOString() }));
    await saveRequestUsage(webToolEntry({ cost: 0.001, connectionId: "conn-a", model: "web-fetch", endpoint: "/v1/web/fetch", timestamp: new Date(base + 1000).toISOString() }));
    // Other connection and out-of-window rows must not be counted.
    await saveRequestUsage(webToolEntry({ cost: 5, connectionId: "conn-b", timestamp: new Date(base + 2000).toISOString() }));
    await saveRequestUsage(webToolEntry({ cost: 9, connectionId: "conn-a", timestamp: "2020-01-01T00:00:00.000Z" }));

    const spend = await getProviderSpend({
      provider: "exa",
      connectionId: "conn-a",
      startDate: new Date(base - 60_000),
    });

    expect(spend.cost).toBeCloseTo(0.013, 6);
    expect(spend.requests).toBe(2);
  });

  it("keeps the explicit cost instead of recalculating from token pricing", async () => {
    const before = await getProviderSpend({ provider: "exa", connectionId: "conn-c" });
    expect(before.cost).toBe(0);

    await saveRequestUsage(webToolEntry({ cost: 0.007, connectionId: "conn-c" }));

    const after = await getProviderSpend({ provider: "exa", connectionId: "conn-c" });
    expect(after.cost).toBeCloseTo(0.007, 6);
    expect(after.requests).toBe(1);
  });
});
