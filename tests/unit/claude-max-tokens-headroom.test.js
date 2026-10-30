import { describe, expect, it } from "vitest";
import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";

// Claude Code sends adaptive thinking + output_config.effort:"xhigh" with a
// 32000 max_tokens. On a Claude-format transport that becomes
// thinking:{type:"enabled",budget_tokens:32768}; the old reconciliation raised
// max_tokens only to budget+1024, leaving ~1k for the visible answer. The model
// then replied with a one-line status and stop_reason "end_turn" instead of its
// next tool call. Keep a real answer window.
describe("prepareClaudeRequest thinking headroom", () => {
  it("keeps at least 8192 answer tokens after an adaptive→budget conversion", () => {
    const body = {
      model: "deepseek-v4.1-flash",
      max_tokens: 32000,
      thinking: { type: "enabled", budget_tokens: 32768 },
      messages: [{ role: "user", content: "hi" }],
    };
    prepareClaudeRequest(body, "open-design", null, null, null, null);
    expect(body.thinking.budget_tokens).toBe(32768);
    expect(body.max_tokens).toBe(40960);
    expect(body.max_tokens - body.thinking.budget_tokens).toBe(8192);
  });

  it("shrinks the budget when the model ceiling cannot fit the headroom", () => {
    const body = {
      model: "claude-opus-5",
      max_tokens: 128000,
      thinking: { type: "enabled", budget_tokens: 128000 },
      messages: [{ role: "user", content: "hi" }],
    };
    prepareClaudeRequest(body, "open-design", null, null, null, null);
    expect(body.max_tokens).toBe(128000);
    expect(body.thinking.budget_tokens).toBe(119808);
    expect(body.max_tokens - body.thinking.budget_tokens).toBeGreaterThanOrEqual(8192);
  });

  it("leaves a body with ample answer headroom alone", () => {
    const body = {
      model: "deepseek-v4.1-flash",
      max_tokens: 384000,
      thinking: { type: "enabled", budget_tokens: 128000 },
      messages: [{ role: "user", content: "hi" }],
    };
    prepareClaudeRequest(body, "open-design", null, null, null, null);
    expect(body.max_tokens).toBe(384000);
    expect(body.thinking.budget_tokens).toBe(128000);
  });
});
