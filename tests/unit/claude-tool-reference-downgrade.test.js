// Tool-search clients (Claude Code / ZCode) return `tool_reference` blocks in
// tool_result content. Only Anthropic parses them; strict Claude-format
// gateways reject the unknown block with a message-level 422 — AMR Link
// (open-design) answers "messages[N]: missing field `content`" for a body in
// which every message HAS content, on both the flat {tool_name} and the nested
// {tool_reference:{…}} shapes. Verified live 2026-10-24: replacing the blocks
// with a text note turns the 422 into a 200 on the same request.
//
// Non-Anthropic providers must therefore see tool_reference downgraded to text
// (the referenced tools already ride in the `tools` array); Anthropic itself
// keeps the blocks untouched.
import { describe, expect, it } from "vitest";

import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";

const toolUse = { type: "tool_use", id: "toolu_01abc", name: "ToolSearch", input: { query: "ctx7" } };

function bodyWithToolResult(content, provider) {
  return prepareClaudeRequest(
    {
      model: "deepseek-v4.1-flash",
      max_tokens: 64,
      messages: [
        { role: "user", content: [{ type: "text", text: "load the tool" }] },
        { role: "assistant", content: [toolUse] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content }] },
      ],
    },
    provider
  );
}

describe("tool_reference downgrade for non-Anthropic Claude transports", () => {
  it("downgrades a flat tool_reference block for open-design", () => {
    const prepared = bodyWithToolResult(
      [{ type: "tool_reference", tool_name: "mcp__context7__resolve-library-id" }],
      "open-design"
    );
    const result = prepared.messages[2].content[0];
    expect(result.type).toBe("tool_result");
    expect(result.content).toEqual([
      { type: "text", text: "[tool loaded: mcp__context7__resolve-library-id]" },
    ]);
  });

  it("downgrades the nested official-shape tool_reference too", () => {
    const prepared = bodyWithToolResult(
      [{ type: "tool_reference", tool_reference: { type: "tool_name", tool_name: "mcp__context7__query-docs" } }],
      "open-design"
    );
    expect(prepared.messages[2].content[0].content).toEqual([
      { type: "text", text: "[tool loaded: mcp__context7__query-docs]" },
    ]);
  });

  it("keeps sibling parts of the tool_result intact", () => {
    const prepared = bodyWithToolResult(
      [
        { type: "tool_reference", tool_name: "tool_a" },
        { type: "text", text: "Tool loaded." },
      ],
      "open-design"
    );
    const parts = prepared.messages[2].content[0].content;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: "[tool loaded: tool_a]" });
    expect(parts[1]).toEqual({ type: "text", text: "Tool loaded." });
  });

  it("downgrades a bare top-level tool_reference block", () => {
    const prepared = prepareClaudeRequest(
      {
        model: "m",
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "tool_reference", tool_name: "tool_b" }] }],
      },
      "open-design"
    );
    expect(prepared.messages[0].content).toEqual([
      { type: "text", text: "[tool loaded: tool_b]" },
    ]);
  });

  it("keeps tool_reference blocks for Anthropic itself", () => {
    const prepared = bodyWithToolResult(
      [{ type: "tool_reference", tool_name: "mcp__context7__resolve-library-id" }],
      "claude"
    );
    expect(prepared.messages[2].content[0].content).toEqual([
      { type: "tool_reference", tool_name: "mcp__context7__resolve-library-id" },
    ]);
  });

  it("keeps tool_reference blocks for anthropic-compatible providers", () => {
    const prepared = bodyWithToolResult(
      [{ type: "tool_reference", tool_name: "tool_a" }],
      "anthropic-compatible-custom"
    );
    expect(prepared.messages[2].content[0].content).toEqual([
      { type: "tool_reference", tool_name: "tool_a" },
    ]);
  });
});
