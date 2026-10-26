// Ark exposes two independent web-search wires:
//   • Claude / Messages  → /api/{coding,plan}/v1/messages  (Anthropic server tool)
//   • Codex  / Responses → /api/{coding,plan}/v3/responses (hosted {type:"web_search"})
// chatCore picks the transport whose format matches the client's sourceFormat.
//
// Post-probe policy (2026-10-26): neither Ark Claude transport declares native
// server tools — the coding plan returns 403 or a client tool_use, and the agent
// plan does the same for deepseek ids. On Responses, the agent plan executes the
// hosted tool natively while the coding plan silently ignores it, so the latter
// declares responsesUnsupportedToolTypes.
import { describe, it, expect } from "vitest";
import { PROVIDERS } from "../../open-sse/providers/index.js";
import { resolveTransport } from "../../open-sse/services/provider.js";

const ARK_PROVIDERS = ["volcengine-ark", "ark-ap-provider"];

describe("Ark web search: one provider, two wires", () => {
  it.each(ARK_PROVIDERS)("%s exposes distinct Messages and Responses endpoints", (id) => {
    const claude = resolveTransport(id, "claude");
    const responses = resolveTransport(id, "openai-responses");
    expect(claude?.baseUrl).toMatch(/\/v1\/messages$/);
    expect(responses?.baseUrl).toMatch(/\/responses$/);
    expect(responses.baseUrl).not.toBe(claude.baseUrl);
  });

  it("declares native support per wire: no Claude whitelist, Responses differs", () => {
    // providers/index.js publishes the top-level transport as PROVIDERS[id].
    for (const id of ARK_PROVIDERS) {
      expect(PROVIDERS[id].quirks?.claudeSupportedToolTypes, id).toBeUndefined();
    }
    // Agent Plan executes hosted web_search on /responses → native.
    expect(PROVIDERS["ark-ap-provider"].quirks?.responsesUnsupportedToolTypes).toBeUndefined();
    // Coding Plan silently ignores it → force emulation.
    expect(PROVIDERS["volcengine-ark"].quirks.responsesUnsupportedToolTypes).toEqual([
      "web_search",
      "web_search_preview",
      "web_fetch",
    ]);
  });

  it("Codex /responses matches the Responses transport, so translation is skipped", () => {
    for (const id of ARK_PROVIDERS) {
      expect(resolveTransport(id, "openai-responses")?.format).toBe("openai-responses");
    }
  });
});
