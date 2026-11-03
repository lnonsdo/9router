import { describe, expect, it } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// /v1/messages is a real Anthropic surface. Sending it the Chat-wire DeepSeek
// dialect (thinking:{type:"enabled"} with no budget_tokens + reasoning_effort)
// made deepseek-v4.1-flash intermittently end an agent turn with a one-sentence
// status and stop_reason "end_turn" instead of its tool call. The transport
// declares thinkingFormat:"claude-budget" so this endpoint gets the Anthropic
// shape; the Chat and Responses transports stay on the effort lane.
describe("open-design thinking wire format", () => {
  it("uses budget_tokens (not reasoning_effort) on the Claude transport", () => {
    const body = { thinking: { type: "enabled" }, reasoning_effort: "max" };
    applyThinking("claude", "deepseek-v4.1-flash(max)", body, "open-design");
    // The gateway's output_budget for this model is 128000, so thinkingRange caps
    // max effort at 32768 — leaving room for the answer and the tool call.
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 32768 });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("advertises the gateway's output budget, not the canonical 384000", () => {
    for (const id of ["deepseek-v4.1-flash", "deepseek-v4-1-flash"]) {
      const caps = getCapabilitiesForModel("open-design", id);
      expect(caps.maxOutput).toBe(128000);
      expect(caps.thinkingRange).toEqual({ max: 32768 });
      // A provider-scoped entry replaces the canonical one, so these must survive.
      expect(caps.vision).toBe(true);
      expect(caps.reasoning).toBe(true);
    }
  });

  it("keeps the Chat transport on the effort lane", () => {
    const body = { thinking: { type: "enabled" }, reasoning_effort: "max" };
    applyThinking("openai", "deepseek-v4.1-flash(max)", body, "open-design");
    expect(body.reasoning_effort).toBe("max");
    expect(body.thinking).toEqual({ type: "enabled" });
  });

  it("does not change another provider's Claude transport", () => {
    const body = { thinking: { type: "enabled" }, reasoning_effort: "max" };
    applyThinking("claude", "deepseek-v4.1-flash(max)", body, "codebuddy-cn");
    expect(body.reasoning_effort).toBe("max");
    expect(body.thinking).toBeUndefined();
  });
});
