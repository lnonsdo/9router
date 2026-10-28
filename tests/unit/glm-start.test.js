import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// proxyAwareFetch captures globalThis.fetch at import time — mock the module
// (same pattern as glm-oauth.test.js) so both the executor's agent/configs
// route lookup and the upstream POST are observable.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
  default: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import glmStartProvider from "../../src/lib/oauth/providers/glm.js";
import glmStartOauthProvider from "../../src/lib/oauth/providers/glm-start.js";
import { getProvider } from "../../src/lib/oauth/providers";
import { PROVIDERS as TRANSPORTS, PROVIDER_OAUTH } from "../../open-sse/providers/index.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { GlmStartExecutor } from "../../open-sse/executors/glm-start.js";
import { OFFICIAL_CLI_PREFIX, OFFICIAL_STABLE_SECTIONS, OFFICIAL_IDENTITY_CHARS } from "../../open-sse/executors/glm-start-identity.js";
import { getGlmStartUsage } from "../../open-sse/services/usage/glm-start.js";

const UPSTREAM_URL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages";
const ROUTED_URL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages";
const ZCODE_JWT = "zcode-jwt";
const OAUTH_AT = "zai-oauth-token";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("glm-start registry entry (Start Plan)", () => {
  it("points the transport at the zcode.z.ai Start Plan endpoint", () => {
    expect(TRANSPORTS["glm-start"].baseUrl).toBe(UPSTREAM_URL);
    expect(TRANSPORTS["glm-start"].format).toBe("claude");
    expect(TRANSPORTS["glm-start"].headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("skips coding-plan key minting via the oauth config flag", () => {
    expect(PROVIDER_OAUTH["glm-start"].mintPlanApiKey).toBe(false);
    expect(PROVIDER_OAUTH["glm-start"].providerId).toBe("zai");
    expect(PROVIDER_OAUTH["glm-start"].cliPollUrl).toBe("https://zcode.z.ai/api/v1/oauth/cli/poll");
  });

  it("is wired into the generic OAuth provider registry sharing the glm flow", () => {
    expect(getProvider("glm-start")).toBe(glmStartOauthProvider);
    expect(glmStartOauthProvider.flowType).toBe("device_code");
    expect(glmStartOauthProvider.mapTokens).toBe(glmStartProvider.mapTokens);
  });
});

describe("glm-start OAuth flow (mintPlanApiKey: false)", () => {
  let calls;

  beforeEach(() => {
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init = {}) => {
        calls.push({ url: String(url), method: init.method || "GET" });
        const u = new URL(url);
        if (u.pathname.startsWith("/api/v1/oauth/cli/poll/")) {
          return jsonResponse({
            code: 0,
            data: {
              status: "ready",
              token: ZCODE_JWT,
              providerId: "zai",
              user: { user_id: "u-1", name: "Feavy", email: "feavy@example.com" },
              zai: { access_token: OAUTH_AT },
            },
          });
        }
        return jsonResponse({ code: 500, msg: `unexpected ${url}` }, 500);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the raw OAuth access token and never touches api.z.ai", async () => {
    const result = await glmStartOauthProvider.pollToken(
      glmStartOauthProvider.config,
      "flow-123",
      null,
      { _zcodePollToken: "t" },
    );

    expect(result.ok).toBe(true);
    expect(result.data.access_token).toBe(OAUTH_AT);
    expect(result.data._zcodeJwtToken).toBe(ZCODE_JWT);
    expect(calls.some((c) => c.url.includes("api.z.ai"))).toBe(false);
  });

  it("mapTokens lands the OAuth token in accessToken with the zcode JWT in providerSpecificData", () => {
    const tokens = glmStartOauthProvider.mapTokens({
      access_token: OAUTH_AT,
      _zcodeJwtToken: ZCODE_JWT,
      _zaiBusinessToken: "",
      _zcodeUser: { user_id: "u-1", name: "Feavy", email: "feavy@example.com" },
    });

    expect(tokens.accessToken).toBe(OAUTH_AT);
    expect(tokens.email).toBe("feavy@example.com");
    expect(tokens.providerSpecificData.zcodeJwtToken).toBe(ZCODE_JWT);
    expect(tokens.providerSpecificData.zaiBusinessToken).toBeUndefined();
  });
});

describe("GlmStartExecutor", () => {
  beforeEach(() => {
    vi.mocked(proxyAwareFetch).mockReset();
    vi.mocked(proxyAwareFetch).mockImplementation(async () => jsonResponse({ id: "msg_1", content: [] }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const executor = new GlmStartExecutor("glm-start");
  const credentials = {
    authType: "oauth",
    accessToken: "oauth-access-token-unused",
    providerSpecificData: { zcodeJwtToken: ZCODE_JWT },
  };
  const run = (overrides = {}) => executor.execute({
    model: "GLM-5.3-Flash",
    body: { model: "GLM-5.3-Flash", stream: false, messages: [{ role: "user", content: [] }] },
    stream: false,
    credentials,
    log: { debug: () => {}, info: () => {} },
    ...overrides,
  });

  it("is registered and sends the zcode JWT in both auth headers", async () => {
    expect(getExecutor("glm-start")).toBeInstanceOf(GlmStartExecutor);
    const result = await run();

    expect(result.url).toBe(UPSTREAM_URL);
    expect(result.headers.authorization).toBe(`Bearer ${ZCODE_JWT}`);
    expect(result.headers["x-api-key"]).toBe(ZCODE_JWT);
    expect(result.headers["anthropic-version"]).toBe("2023-06-01");
    // official client does not send beta flags or X-Zcode-Authorization
    expect(result.headers["Anthropic-Beta"]).toBeUndefined();
    expect(result.headers["X-Zcode-Authorization"]).toBeUndefined();
  });

  it("presents the minimal plugin-verified fingerprint headers", async () => {
    const result = await run();

    expect(result.headers["user-agent"]).toMatch(/^ZCode\//);
    expect(result.headers["http-referer"]).toBe("https://zcode.z.ai");
    expect(result.headers["x-device-mid"]).toMatch(/^[0-9a-f-]{36}$/);
    // the full official header family + non-Electron TLS reads as a spoofed
    // client — everything beyond the minimal set stays OFF the wire
    expect(result.headers["x-title"]).toBeUndefined();
    expect(result.headers["x-zcode-agent"]).toBeUndefined();
    expect(result.headers["x-zcode-trace-id"]).toBeUndefined();
    expect(result.headers["x-session-id"]).toBeUndefined();
  });

  it("lets per-provider header overrides win over the zcode defaults", async () => {
    const result = await run({
      providerOverrides: { headers: { "user-agent": "my-custom-agent/1.0" } },
    });

    expect(result.headers["user-agent"]).toBe("my-custom-agent/1.0");
    expect(result.headers["x-api-key"]).toBe(ZCODE_JWT);
  });

  it("sends a stable X-Device-Mid derived from the zcode JWT", async () => {
    const first = await run();
    const second = await run({
      credentials: { ...credentials, connectionId: "other-connection" },
    });

    expect(first.headers["x-device-mid"]).toMatch(/^[0-9a-f-]{36}$/);
    // Same JWT ⇒ same device id, even across connections (billing dedups on it).
    expect(second.headers["x-device-mid"]).toBe(first.headers["x-device-mid"]);
    const otherJwt = await run({
      credentials: { ...credentials, providerSpecificData: { zcodeJwtToken: "another-jwt" } },
    });
    expect(otherJwt.headers["x-device-mid"]).not.toBe(first.headers["x-device-mid"]);
  });
});

describe("GlmStartExecutor request-body admission (3012 gate)", () => {
  beforeEach(() => {
    vi.mocked(proxyAwareFetch).mockReset();
    vi.mocked(proxyAwareFetch).mockImplementation(async () => jsonResponse({ id: "msg_1", content: [] }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const executor = new GlmStartExecutor("glm-start");
  const credentials = {
    authType: "oauth",
    accessToken: "oauth-access-token-unused",
    providerSpecificData: { zcodeJwtToken: ZCODE_JWT },
  };
  const run = (body, overrides = {}) => executor.execute({
    model: "GLM-5.3-Flash",
    body,
    stream: false,
    credentials,
    log: { debug: () => {}, info: () => {} },
    ...overrides,
  });

  it("merges the caller system into the official 3-block structure", async () => {
    const result = await run({
      model: "GLM-5.3-Flash",
      stream: false,
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      messages: [{ role: "user", content: "hi" }],
    });

    const system = result.transformedBody.system;
    // EXACTLY three blocks — a 4th block (even "You are a helpful assistant.")
    // trips the 3012 risk gate (differential probes, 2026-10-24)
    expect(system).toHaveLength(3);
    expect(system[0].text).toBe(OFFICIAL_CLI_PREFIX);
    expect(system[1].text).toBe(OFFICIAL_STABLE_SECTIONS.join("\n\n"));
    // caller text rides INSIDE the environment block, after the "# Additional
    // instructions" header — probe-verified 200 with the full Claude identity
    expect(system[2].text).toContain("# Environment");
    expect(system[2].text).toContain("# Additional instructions");
    expect(system[2].text).toContain("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(system[2].cache_control).toEqual({ type: "ephemeral" });
    // admission requires prefix + full stable sections (2898 chars, 实测矩阵)
    expect(OFFICIAL_IDENTITY_CHARS).toBe(2898);
  });

  it("ships the bare official shape when the caller has no system", async () => {
    const result = await run({
      model: "GLM-5.3-Flash",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    });

    const system = result.transformedBody.system;
    expect(system).toHaveLength(3);
    expect(system[2].text).toContain("# Environment");
    expect(system[2].text).not.toContain("# Additional instructions");
  });

  it("leaves user messages untouched (no date reminder — matches the verified-200 shape)", async () => {
    const result = await run({
      model: "GLM-5.3-Flash",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    });

    const first = result.transformedBody.messages[0];
    expect(first.role).toBe("user");
    expect(first.content).toBe("hi");
  });

  it("passes through a request that already carries the official identity", async () => {
    const official = [
      { type: "text", text: OFFICIAL_CLI_PREFIX },
      { type: "text", text: OFFICIAL_STABLE_SECTIONS.join("\n\n") },
      { type: "text", text: "caller rules" },
    ];
    const body = {
      model: "GLM-5.3-Flash",
      stream: false,
      system: official,
      messages: [{ role: "user", content: [{ type: "text", text: "<system-reminder>x</system-reminder>" }] }],
    };
    const result = await run(body);

    expect(result.transformedBody.system).toBe(official);
    // date block is idempotent — no second reminder injected
    expect(result.transformedBody.messages[0].content).toHaveLength(1);
  });

  it("strips the OpenAI stream_options the base executor injects", async () => {
    const result = await run(
      { model: "GLM-5.3-Flash", messages: [{ role: "user", content: "hi" }] },
      { stream: true },
    );

    expect(result.transformedBody.stream).toBe(true);
    expect(result.transformedBody.stream_options).toBeUndefined();
  });

  it("merges a foreign identity claim verbatim (no masking needed — block structure is the gate)", async () => {
    const result = await run({
      model: "GLM-5.3-Flash",
      stream: false,
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      messages: [{ role: "user", content: "hi" }],
    });

    // probe-verified: the FULL Claude identity sentence passes when it lives
    // inside the environment block instead of a 4th block
    expect(result.transformedBody.system[2].text).toContain("Anthropic's official CLI");
    // the official blocks stay untouched
    expect(result.transformedBody.system[0].text).toBe(OFFICIAL_CLI_PREFIX);
  });

  it("retries 3009 concurrency rejections inside the executor instead of failing", async () => {
    // real registry config waits 3s between probes — shrink for the test
    const original = executor.config.retry;
    executor.config.retry = { 429: { attempts: 3, delayMs: 10 } };
    try {
      vi.mocked(proxyAwareFetch)
        .mockImplementationOnce(async () => jsonResponse(
          { code: 3009, msg: "model concurrency limit exceeded" }, 429,
        ))
        .mockImplementationOnce(async () => jsonResponse(
          { code: 3009, msg: "model concurrency limit exceeded" }, 429,
        ))
        .mockImplementation(async () => jsonResponse({ id: "msg_ok", content: [] }));

      const result = await run({ model: "GLM-5.3-Flash", messages: [{ role: "user", content: "hi" }] });

      expect(result.response.status).toBe(200);
      expect(vi.mocked(proxyAwareFetch)).toHaveBeenCalledTimes(3);
    } finally {
      executor.config.retry = original;
    }
  });

  it("explains 3012 risk-control blocks without conflating the three actors", () => {
    const parsed = executor.parseError(
      { status: 405 },
      '{"code":3012,"msg":"request has been blocked due to unusual activity."}',
    );
    expect(parsed.status).toBe(405);
    expect(parsed.message).toContain("3012");
    // per-request scoring (no account cooldown)…
    expect(parsed.message).toContain("one-by-one");
    // …the local lock is ours and self-service unlockable…
    expect(parsed.message).toContain("locked this connection");
    expect(parsed.message).toContain("Test");
    // …and repeated failure means rule drift, not account trouble
    expect(parsed.message).toContain("admission rules likely changed");
  });
});

describe("glm-start usage (zcode.z.ai billing)", () => {
  beforeEach(() => {
    vi.mocked(proxyAwareFetch).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads balance buckets and the daily-grant preview", async () => {
    const seen = [];
    vi.mocked(proxyAwareFetch).mockImplementation(async (url, init = {}) => {
      seen.push({ url: String(url), method: init.method, headers: init.headers });
      const u = new URL(String(url));
      if (u.pathname.endsWith("/billing/balance")) {
        return jsonResponse({
          code: 0,
          data: {
            balances: [
              { plan_id: "zcode-v3-start-plan", show_name: "GLM-5.3-Flash", unit_type: "token",
                total_units: 100_000_000, used_units: 25_000_000, remaining_units: 75_000_000, expires_at: 1_900_000_000 },
              // second tier, SAME model name — must not overwrite the first card
              { plan_id: "zcode-v3-start-plan-1024", show_name: "GLM-5.3-Flash", unit_type: "token",
                total_units: 300_000_000, used_units: 0, remaining_units: 300_000_000, expires_at: 1_900_100_000 },
            ],
            plans: [{ plan_id: "zcode-v3-start-plan-1024", name: "ZCode 1024 Dev Day", status: "active" }],
          },
        });
      }
      if (u.pathname.endsWith("/event/report")) return jsonResponse({ code: 0 });
      if (u.pathname.endsWith("/billing/preview")) {
        return jsonResponse({
          code: 0,
          data: { plans: [{ plan_id: "zcode-v3-start-plan-trust-1003", name: "Start Plan", priority: 10, entitlements: [{ grant_units: 100_000_000, unit_type: "token" }] }] },
        });
      }
      return jsonResponse({ code: 404 }, 404);
    });

    const usage = await getGlmStartUsage({ providerSpecificData: { zcodeJwtToken: ZCODE_JWT } }, null);

    // one card per (model, tier) — the daily bucket and the Dev Day bucket coexist
    expect(usage.quotas["GLM-5.3-Flash"]).toBeDefined();
    expect(usage.quotas["GLM-5.3-Flash · 1024 Dev Day"]).toBeDefined();
    expect(usage.quotas["GLM-5.3-Flash"].used).toBe(25);
    expect(usage.quotas["GLM-5.3-Flash · 1024 Dev Day"].used).toBe(0);
    expect(usage.claimable[0].planId).toBe("zcode-v3-start-plan-trust-1003");
    expect(usage.claimable[0].grantUnits).toBe(100_000_000);
    // billing auth + the hard-required device header, consistent with the executor
    const balance = seen.find((c) => c.url.includes("/billing/balance"));
    expect(balance.headers.Authorization).toBe(`Bearer ${ZCODE_JWT}`);
    expect(balance.headers["X-Device-Mid"]).toMatch(/^[0-9a-f-]{36}$/);
    // activation events are reported before preview (gates the daily grant)
    const reportIdx = seen.findIndex((c) => c.url.includes("/event/report"));
    const previewIdx = seen.findIndex((c) => c.url.includes("/billing/preview"));
    expect(reportIdx).toBeGreaterThanOrEqual(0);
    expect(previewIdx).toBeGreaterThan(reportIdx);
  });

  it("degrades to a message without the zcode JWT", async () => {
    const usage = await getGlmStartUsage({ providerSpecificData: {} }, null);
    expect(usage.message).toBeTruthy();
    expect(vi.mocked(proxyAwareFetch)).not.toHaveBeenCalled();
  });
});
