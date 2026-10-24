import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getProviderConnections.mockResolvedValue([{
    id: "glm-start-a",
    provider: "glm-start",
    name: "glm-start-a",
    backoffLevel: 2,
  }]);
});

// The executor's parseError wording for the zcode-plan risk gate — this exact
// text is what flows into markAccountUnavailable from the chat fallback path.
const RISK_3012_MESSAGE = "Z.AI risk control rejected this request (3012 unusual activity) — it scores "
  + "requests one-by-one, so a corrected request is admitted again immediately. "
  + "9router has locked this connection for 1h to avoid repeat probes; a passing "
  + "Test on the connection clears the lock sooner. If every request keeps failing, "
  + "the gateway's admission rules likely changed again — check the upstream "
  + "reference implementation before retrying.";

describe("glm-start risk-control lock (3012)", () => {
  it("locks the whole account for 1h on the first risk rejection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T05:00:00.000Z"));

    try {
      const result = await markAccountUnavailable(
        "glm-start-a",
        405,
        RISK_3012_MESSAGE,
        "glm-start",
        "GLM-5.3-Flash",
      );

      expect(result.shouldFallback).toBe(true);
      // account-wide lock (modelLock___all), NOT model-scoped — the risk gate
      // scores per request, so every model of this connection must cool off;
      // 1h (not 24h): a passing Test or successful request unlocks earlier
      expect(dbMocks.updateProviderConnection).toHaveBeenCalledWith(
        "glm-start-a",
        expect.objectContaining({
          modelLock___all: "2026-10-24T06:00:00.000Z",
          testStatus: "unavailable",
          errorCode: 405,
          backoffLevel: 0,
        }),
      );
      expect(dbMocks.updateProviderConnection.mock.calls[0][1])
        .not.toHaveProperty("modelLock_GLM-5.3-Flash");
    } finally {
      vi.useRealTimers();
    }
  });

  it("also locks on the bare upstream WAF body text", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T05:00:00.000Z"));

    try {
      await markAccountUnavailable(
        "glm-start-a",
        405,
        '{"code":3012,"msg":"request has been blocked due to unusual activity."}',
        "glm-start",
        "GLM-5.3",
      );

      expect(dbMocks.updateProviderConnection).toHaveBeenCalledWith(
        "glm-start-a",
        expect.objectContaining({ modelLock___all: "2026-10-24T06:00:00.000Z" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not lock when another provider answers 405", async () => {
    const result = await markAccountUnavailable(
      "glm-start-a",
      405,
      "Method not allowed",
      "glm",
      "GLM-5.3",
    );

    // 405 outside the risk gate is request-scoped: no fallback, no cooldown
    expect(result.shouldFallback).toBe(false);
    expect(dbMocks.updateProviderConnection).not.toHaveBeenCalled();
  });
});
