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

  it("records the first 3012 in the persistent ledger without disabling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T05:00:00.000Z"));

    try {
      await markAccountUnavailable("glm-start-a", 405, RISK_3012_MESSAGE, "glm-start", "GLM-5.3-Flash");

      const update = dbMocks.updateProviderConnection.mock.calls[0][1];
      expect(update.riskControlHits).toEqual(["2026-10-24T05:00:00.000Z"]);
      expect(update.isActive).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-disables the connection on the 3rd hit inside 24h", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T05:00:00.000Z"));
    dbMocks.getProviderConnections.mockResolvedValue([{
      id: "glm-start-a",
      provider: "glm-start",
      name: "glm-start-a",
      backoffLevel: 0,
      // two hits already inside the window
      riskControlHits: ["2026-10-24T03:10:00.000Z", "2026-10-24T04:20:00.000Z"],
    }]);

    try {
      await markAccountUnavailable("glm-start-a", 405, RISK_3012_MESSAGE, "glm-start", "GLM-5.3-Flash");

      const update = dbMocks.updateProviderConnection.mock.calls[0][1];
      expect(update.riskControlHits).toHaveLength(3);
      expect(update.isActive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prunes ledger hits older than the 24h window", async () => {    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T05:00:00.000Z"));
    dbMocks.getProviderConnections.mockResolvedValue([{
      id: "glm-start-a",
      provider: "glm-start",
      name: "glm-start-a",
      backoffLevel: 0,
      // two hits, but both outside the rolling window — only today's counts
      riskControlHits: ["2026-10-22T05:00:00.000Z", "2026-10-23T04:59:00.000Z"],
    }]);

    try {
      await markAccountUnavailable("glm-start-a", 405, RISK_3012_MESSAGE, "glm-start", "GLM-5.3-Flash");

      const update = dbMocks.updateProviderConnection.mock.calls[0][1];
      expect(update.riskControlHits).toEqual(["2026-10-24T05:00:00.000Z"]);
      expect(update.isActive).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

// Aliyun WAF (edge in front of zcode.z.ai) answers request bursts with an HTML
// 405 page. Verified 2026-11-03: the same body is admitted seconds later, so it
// is a transient throttle — it must never reach the 3012 fuse.
const ALIYUN_WAF_405 = '<!doctype html><html lang="zh-cn"><meta name="data-spm" content="a3c0e">'
  + '<title>405</title><textarea id="renderData" style="display:none">{"traceid":"0a3d3ed5"}</textarea>'
  + '<img src="https://errors.aliyun.com/images/TB15QGaHpXXXXXOaXXXXia39XXX-660-117.png"></html>';

describe("glm-start edge WAF throttle (HTML 405)", () => {
  it("does not count it as a risk hit and never disables the connection", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([{
      id: "glm-start-a",
      provider: "glm-start",
      name: "glm-start-a",
      backoffLevel: 0,
      riskControlHits: ["2026-11-02T18:02:10.549Z", "2026-11-02T18:02:14.685Z"],
    }]);

    const result = await markAccountUnavailable("glm-start-a", 405, ALIYUN_WAF_405, "glm-start", "GLM-5.3-Flash");

    const update = dbMocks.updateProviderConnection.mock.calls[0][1];
    // short model-scoped cool-off, ledger untouched, still enabled
    expect(result.shouldFallback).toBe(true);
    expect(update).toHaveProperty("modelLock_GLM-5.3-Flash");
    expect(update).not.toHaveProperty("modelLock___all");
    expect(update.riskControlHits).toBeUndefined();
    expect(update.isActive).toBeUndefined();
    // a shed is not a health signal — the card must not flicker red
    expect(update.testStatus).toBeUndefined();
    expect(update.errorCode).toBeUndefined();
  });

  it("keeps the 1h account-wide lock for the real 3012 JSON gate", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([{
      id: "glm-start-a",
      provider: "glm-start",
      name: "glm-start-a",
      backoffLevel: 0,
    }]);

    await markAccountUnavailable(
      "glm-start-a",
      405,
      '{"code":3012,"msg":"request has been blocked due to unusual activity."}',
      "glm-start",
      "GLM-5.3-Flash",
    );

    const update = dbMocks.updateProviderConnection.mock.calls[0][1];
    expect(update).toHaveProperty("modelLock___all");
    expect(update.riskControlHits).toHaveLength(1);
    expect(update.testStatus).toBe("unavailable");
  });
});
