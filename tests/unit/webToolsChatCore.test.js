import { describe, it, expect, vi, beforeEach } from "vitest";
import "../translator/registerAll.js";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const openaiJson = (message, finishReason = "stop") => new Response(JSON.stringify({
  id: "chatcmpl-test",
  object: "chat.completion",
  model: "gpt-5.5",
  choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", content: "", ...message } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
}), { status: 200, headers: { "content-type": "application/json" } });

const claudeJson = (content, stopReason = "end_turn") => new Response(JSON.stringify({
  id: "msg-upstream",
  type: "message",
  role: "assistant",
  model: "deepseek-chat",
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 8, output_tokens: 4 },
}), { status: 200, headers: { "content-type": "application/json" } });

const claudeBody = {
  model: "openai/gpt-5.5",
  stream: true,
  max_tokens: 1024,
  tools: [
    { type: "web_search_20250305", name: "web_search", max_uses: 3 },
    { type: "function", name: "client_tool", input_schema: { type: "object", properties: {} }, description: "client tool" },
  ],
  messages: [{ role: "user", content: [{ type: "text", text: "search the web for rust vs go" }] }],
};

const adapterConfig = {
  webSearch: { enabled: true, providers: ["tavily"] },
  webFetch: { enabled: true, providers: ["jina-reader"] },
};

async function runChatCore({ body = claudeBody, clientStream = true } = {}) {
  return handleChatCore({
    body: clientStream ? body : { ...body, stream: false },
    modelInfo: { provider: "openai", model: "gpt-5.5" },
    credentials: { apiKey: "test-key", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn(), tagForSession: () => "T" },
    connectionId: "test-conn",
    rtkEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    customPromptEnabled: false,
    pxpipeEnabled: false,
    sourceFormatOverride: "claude",
    webToolsAdapter: adapterConfig,
    executeServerTool: async ({ kind, input }) => {
      if (kind === "web_search") {
        return { ok: true, data: { results: [{ title: "Rust vs Go", url: "https://x.io/a", snippet: "benchmarks", published_at: "2026-01-01" }] } };
      }
      return { ok: false, error: "unexpected kind" };
    },
    clientRawRequest: {
      endpoint: "/v1/messages",
      body: { model: "openai/gpt-5.5" },
      headers: { accept: clientStream ? "text/event-stream" : "application/json" },
    },
  });
}

describe("handleChatCore server tool emulation (Web Tools Adapter)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("downgrades server tools, runs the emulation loop and returns an SSE stream with restored server_tool_use blocks", async () => {
    const executedBodies = [];
    executeMock.mockImplementation(async ({ body: upstreamBody }) => {
      executedBodies.push(JSON.parse(JSON.stringify(upstreamBody)));
      if (executedBodies.length === 1) {
        return {
          response: openaiJson({
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"rust vs go"}' } }],
          }, "tool_calls"),
          url: "https://api.openai.com/v1/chat/completions",
          headers: {},
          transformedBody: null,
        };
      }
      return {
        response: openaiJson({ content: "Go compiles faster." }),
        url: "https://api.openai.com/v1/chat/completions",
        headers: {},
        transformedBody: null,
      };
    });

    const result = await runChatCore();
    expect(result.success).toBe(true);

    // First upstream call: server tool downgraded to a plain function tool,
    // forced non-streaming, client tools preserved.
    expect(executedBodies[0].stream).toBe(false);
    const toolNames = executedBodies[0].tools.map(t => t.function.name);
    expect(toolNames).toContain("web_search");
    expect(toolNames).toContain("client_tool");
    expect(executedBodies[0].tools.every(t => t.type === "function")).toBe(true);

    // Second upstream call: emulated round appended (assistant tool_calls + tool result).
    expect(executedBodies[1].messages.at(-2).tool_calls[0]).toMatchObject({ id: "call_1", function: { name: "web_search" } });
    expect(executedBodies[1].messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_1" });
    expect(executedBodies[1].messages.at(-1).content).toContain("https://x.io/a");

    // Client-facing response is a standard Anthropic SSE stream.
    const sse = await result.response.text();
    expect(result.response.headers.get("content-type")).toContain("text/event-stream");
    const events = sse.split("\n\n").filter(Boolean).map(e => ({
      event: e.split("\n")[0].replace("event: ", ""),
      data: JSON.parse(e.split("\n")[1].replace("data: ", "")),
    }));
    expect(events[0].event).toBe("message_start");
    const blockStarts = events.filter(e => e.data.type === "content_block_start").map(e => e.data.content_block);
    expect(blockStarts[0]).toMatchObject({ type: "server_tool_use", name: "web_search", input: {} });
    expect(events[2].data.delta.partial_json).toBe('{"query":"rust vs go"}');
    expect(blockStarts[1].type).toBe("web_search_tool_result");
    expect(blockStarts[1].content[0]).toMatchObject({ type: "web_search_result", url: "https://x.io/a", snippet: "benchmarks" });
    expect(blockStarts[2].type).toBe("text");
    expect(events.at(-2).data.delta.stop_reason).toBe("end_turn");
    expect(events.at(-1).event).toBe("message_stop");
  });

  it("returns a plain JSON Anthropic message for non-streaming clients", async () => {
    executeMock.mockImplementation(async () => ({
      response: openaiJson({ content: "Answer without tools." }),
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    }));

    const result = await runChatCore({ clientStream: false });
    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toContain("application/json");
    const message = await result.response.json();
    expect(message).toMatchObject({ type: "message", role: "assistant", model: "openai/gpt-5.5", stop_reason: "end_turn" });
    expect(message.content[0]).toEqual({ type: "text", text: "Answer without tools." });
    expect(message.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("downgrades replayed server_tool_use history before the first upstream call", async () => {
    const body = {
      ...claudeBody,
      stream: false,
      messages: [
        { role: "user", content: [{ type: "text", text: "q" }] },
        { role: "assistant", content: [{ type: "server_tool_use", id: "srvtoolu_prev", name: "web_search", input: { query: "q0" } }] },
        { role: "user", content: [{ type: "web_search_tool_result", tool_use_id: "srvtoolu_prev", content: [{ type: "web_search_result", title: "old", url: "https://old.io" }] }] },
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ],
    };
    executeMock.mockImplementation(async () => ({
      response: openaiJson({ content: "final" }),
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    }));

    const result = await runChatCore({ body, clientStream: false });
    expect(result.success).toBe(true);

    const sent = executeMock.mock.calls[0][0].body;
    // server_tool_use → tool_use; web_search_tool_result → tool message.
    // The srvtoolu_ id is rewritten to the toolu_ namespace (paired on both halves).
    const assistantMsg = sent.messages.find(m => m.role === "assistant");
    expect(assistantMsg.tool_calls[0]).toMatchObject({ id: "toolu_prev", function: { name: "web_search" } });
    const toolMsg = sent.messages.find(m => m.role === "tool");
    expect(toolMsg.tool_call_id).toBe("toolu_prev");
    expect(toolMsg.content).toContain("https://old.io");
    // The client text turn survives the downgrade.
    expect(sent.messages.at(-1).content).toBe("continue");
  });

  it("emulates server tools for a third-party Claude-compatible target (claude→claude)", async () => {
    const executedBodies = [];
    executeMock.mockImplementation(async ({ body: upstreamBody }) => {
      executedBodies.push(JSON.parse(JSON.stringify(upstreamBody)));
      if (executedBodies.length === 1) {
        return {
          response: claudeJson([{ type: "tool_use", id: "toolu_u1", name: "web_search", input: { query: "rust vs go" } }], "tool_use"),
          url: "https://api.deepseek.com/anthropic/v1/messages",
          headers: {},
          transformedBody: null,
        };
      }
      return {
        response: claudeJson([{ type: "text", text: "claude-target answer" }]),
        url: "https://api.deepseek.com/anthropic/v1/messages",
        headers: {},
        transformedBody: null,
      };
    });

    const result = await handleChatCore({
      body: claudeBody,
      modelInfo: { provider: "deepseek", model: "deepseek-chat" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn(), tagForSession: () => "T" },
      connectionId: "test-conn",
      rtkEnabled: false,
      headroomEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      customPromptEnabled: false,
      pxpipeEnabled: false,
      sourceFormatOverride: "claude",
      webToolsAdapter: adapterConfig,
      executeServerTool: async () => ({ ok: true, data: { results: [{ title: "Rust vs Go", url: "https://x.io/a", snippet: "bench" }] } }),
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: { model: "deepseek/deepseek-chat" },
        headers: { accept: "text/event-stream" },
      },
    });
    expect(result.success).toBe(true);

    // Third-party claude endpoints do not run server tools: emulation kicks in
    // and injects the tool in the Claude shape (input_schema), non-streaming.
    expect(executedBodies[0].stream).toBe(false);
    const injected = executedBodies[0].tools.find(t => t.name === "web_search");
    expect(injected.input_schema.required).toEqual(["query"]);
    expect(injected.function).toBeUndefined();

    // Appended round is native Claude blocks (assistant tool_use + user tool_result).
    expect(executedBodies[1].messages.at(-2).content[0]).toMatchObject({ type: "tool_use", id: "toolu_u1", name: "web_search" });
    expect(executedBodies[1].messages.at(-1).role).toBe("user");
    expect(executedBodies[1].messages.at(-1).content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_u1" });

    // The client still sees standard Anthropic SSE with restored server blocks.
    const sse = await result.response.text();
    expect(result.response.headers.get("content-type")).toContain("text/event-stream");
    const events = sse.split("\n\n").filter(Boolean).map(e => ({
      event: e.split("\n")[0].replace("event: ", ""),
      data: JSON.parse(e.split("\n")[1].replace("data: ", "")),
    }));
    const starts = events.filter(e => e.data.type === "content_block_start").map(e => e.data.content_block);
    expect(starts.map(b => b.type)).toEqual(["server_tool_use", "web_search_tool_result", "text"]);
    // The final answer text arrives as a text_delta on the last block.
    const lastDelta = events.filter(e => e.data.type === "content_block_delta" && e.data.delta.type === "text_delta").at(-1);
    expect(lastDelta.data.delta.text).toBe("claude-target answer");
  });

  it("does not emulate when the adapter is disabled — upstream keeps the stripped behavior", async () => {
    executeMock.mockImplementation(async () => ({
      response: openaiJson({ content: "plain" }),
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    }));

    const result = await handleChatCore({
      body: claudeBody,
      modelInfo: { provider: "openai", model: "gpt-5.5" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn(), tagForSession: () => "T" },
      connectionId: "test-conn",
      rtkEnabled: false,
      headroomEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      customPromptEnabled: false,
      pxpipeEnabled: false,
      sourceFormatOverride: "claude",
      webToolsAdapter: null,
      executeServerTool: null,
      clientRawRequest: { endpoint: "/v1/messages", body: { model: "openai/gpt-5.5" }, headers: { accept: "application/json" } },
    });
    expect(result.success).toBe(true);
    // Without the adapter the legacy behavior is untouched: the translator
    // converts the server tool into a bare function tool with an empty schema
    // (the Web Tools Adapter is what replaces it with a real implementation).
    const sent = executeMock.mock.calls[0][0].body;
    const legacyFn = sent.tools?.find(t => t.function?.name === "web_search");
    expect(legacyFn).toBeTruthy();
    expect(legacyFn.function.parameters?.properties?.query).toBeUndefined();
  });
});
