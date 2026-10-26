// Ark exposes two independent web-search wires:
//   • Claude / Messages  → /api/{coding,plan}/v1/messages  (Anthropic server tool)
//   • Codex  / Responses → /api/{coding,plan}/v3/responses (hosted {type:"web_search"})
// chatCore picks the transport whose format matches the client's sourceFormat, so a
// Codex request is forwarded untranslated and never consults claudeSupportedToolTypes.
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

  it.each(ARK_PROVIDERS)("%s whitelists Anthropic server tools on the published transport", (id) => {
    // providers/index.js sets PROVIDERS[id] from the top-level `transport`; that
    // is the object prepareClaudeRequest reads. A quirk placed on a transports[]
    // entry would be invisible here.
    expect(PROVIDERS[id].quirks.claudeSupportedToolTypes).toEqual([
      "web_search_20250305",
      "web_search_20260209",
    ]);
  });

  it("Codex /responses matches the Responses transport, so translation is skipped", () => {
    for (const id of ARK_PROVIDERS) {
      expect(resolveTransport(id, "openai-responses")?.format).toBe("openai-responses");
    }
  });
});
