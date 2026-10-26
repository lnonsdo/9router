import { describe, expect, it } from "vitest";
import { pivotToClientWire } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";

// translateNonStreamingResponse() only ever lands on OpenAI Chat Completions.
// These cases pin the second hop: the client must receive its own wire.
const chat = (message = {}, finishReason = "stop") => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "gemini-x",
  choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", ...message } }],
  usage: { prompt_tokens: 3, completion_tokens: 2 },
});

describe("pivotToClientWire", () => {
  it("gives a Claude client an Anthropic message instead of chat.completion", () => {
    const out = pivotToClientWire(chat({ content: "hi" }), "claude");
    expect(out).toMatchObject({ type: "message", role: "assistant" });
    expect(out.content).toEqual([{ type: "text", text: "hi" }]);
    expect(out.choices).toBeUndefined();
    expect(out.usage).toEqual({ input_tokens: 3, output_tokens: 2 });
  });

  it("keeps tool calls visible to a Claude client", () => {
    const out = pivotToClientWire(
      chat({ content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: '{"cmd":"ls"}' } }] }, "tool_calls"),
      "claude",
    );
    expect(out.content).toContainEqual({ type: "tool_use", id: "call_1", name: "shell", input: { cmd: "ls" } });
    expect(out.stop_reason).toBe("tool_use");
  });

  it("gives a Responses client output items instead of choices", () => {
    const out = pivotToClientWire(chat({ content: "hi" }), "openai-responses");
    expect(out.object).toBe("response");
    expect(out.choices).toBeUndefined();
    expect(out.output.map(i => i.type)).toEqual(["message"]);
  });

  it("leaves OpenAI bodies and same-format bodies untouched", () => {
    const body = chat({ content: "hi" });
    expect(pivotToClientWire(body, "openai")).toBe(body);
    const claude = { type: "message", role: "assistant", content: [] };
    expect(pivotToClientWire(claude, "claude")).toBe(claude);
  });
});
