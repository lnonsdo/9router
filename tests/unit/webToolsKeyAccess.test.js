import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: vi.fn() }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: vi.fn(async () => []) }));

import { filterWebToolsAdapterForKey } from "../../src/sse/services/keyAccess.js";

// _sets is the per-request memo getAllowSets() builds; pre-seeding it keeps
// these cases off the DB and pins exactly the gate under test.
const restrictedCtx = (providers) => ({
  keyName: "test-key",
  allow: [],
  _sets: { combos: new Set(), models: new Set(), providers: new Set(providers) },
});

const config = () => ({
  webSearch: { enabled: true, roundRobin: true, providers: ["tavily", "exa"] },
  webFetch: { enabled: true, providers: ["firecrawl"] },
});

describe("filterWebToolsAdapterForKey", () => {
  it("drops providers and disables a pool the restricted key cannot reach", async () => {
    const out = await filterWebToolsAdapterForKey(restrictedCtx(["tavily"]), config());
    expect(out.webSearch).toMatchObject({ enabled: true, roundRobin: true, providers: ["tavily"] });
    expect(out.webFetch).toEqual({ enabled: false, providers: [] });
  });

  it("leaves an unrestricted request untouched", async () => {
    const cfg = config();
    expect(await filterWebToolsAdapterForKey(null, cfg)).toBe(cfg);
  });

  it("keeps the original entries when every provider is allowed", async () => {
    const cfg = config();
    const out = await filterWebToolsAdapterForKey(restrictedCtx(["tavily", "exa", "firecrawl"]), cfg);
    expect(out.webSearch).toBe(cfg.webSearch);
    expect(out.webFetch).toBe(cfg.webFetch);
  });
});
