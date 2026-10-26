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
          url: "https://amr-link.open-design.ai/v1/messages",
          headers: {},
          transformedBody: null,
        };
      }
      return {
        response: claudeJson([{ type: "text", text: "claude-target answer" }]),
        url: "https://amr-link.open-design.ai/v1/messages",
        headers: {},
        transformedBody: null,
      };
    });

    const result = await handleChatCore({
      body: claudeBody,
      modelInfo: { provider: "open-design", model: "claude-sonnet-5" },
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
        body: { model: "od/claude-sonnet-5" },
        headers: { accept: "text/event-stream" },
      },
    });
    expect(result.success).toBe(true);

    // A Claude wire alone is not native support: open-design has no
    // claudeSupportedToolTypes whitelist, so prepareClaudeRequest would strip
    // the server tool. Emulation must engage even though the model id resolves
    // search:true, and the injected tool uses the Claude shape (input_schema).
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

  it("surfaces the upstream error when an already-emulated request fails", async () => {
    executeMock.mockImplementation(async () => ({
      response: new Response(JSON.stringify({ error: { message: "upstream boom" } }), {
        status: 500, headers: { "content-type": "application/json" },
      }),
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    }));

    const result = await runChatCore({ clientStream: false });
    expect(result.success).toBe(false);
    expect(result.status).toBe(500);
    expect(result.error).toContain("upstream boom");
    // The fallback only applies to the native path; an emulated first attempt
    // must not be retried again.
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("emulates hosted web_search for a Codex/Responses client (open-design)", async () => {
    const executedBodies = [];
    const responsesJson = (output, usage = { input_tokens: 10, output_tokens: 4 }) => new Response(JSON.stringify({
      id: "resp_test", object: "response", status: "completed", model: "gpt-6-astra", output, usage,
    }), { status: 200, headers: { "content-type": "application/json" } });

    executeMock.mockImplementation(async ({ body: upstreamBody }) => {
      executedBodies.push(JSON.parse(JSON.stringify(upstreamBody)));
      if (executedBodies.length === 1) {
        return {
          response: responsesJson([{
            type: "function_call", id: "fc_1", call_id: "call_1", name: "web_search",
            arguments: '{"query":"rust vs go"}', status: "completed",
          }], { input_tokens: 10, output_tokens: 4 }),
          url: "https://amr-link.open-design.ai/v1/responses",
          headers: {},
          transformedBody: null,
        };
      }
      return {
        response: responsesJson([{
          type: "message", role: "assistant",
          content: [{ type: "output_text", text: "Go compiles faster." }],
        }], { input_tokens: 20, output_tokens: 6 }),
        url: "https://amr-link.open-design.ai/v1/responses",
        headers: {},
        transformedBody: null,
      };
    });

    const result = await handleChatCore({
      body: {
        model: "od/gpt-6-astra",
        stream: true,
        tools: [{ type: "web_search" }],
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "rust vs go" }] }],
      },
      modelInfo: { provider: "open-design", model: "gpt-6-astra" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn(), tagForSession: () => "T" },
      connectionId: "test-conn",
      rtkEnabled: false,
      headroomEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      customPromptEnabled: false,
      pxpipeEnabled: false,
      sourceFormatOverride: "openai-responses",
      webToolsAdapter: adapterConfig,
      executeServerTool: async () => ({ ok: true, data: { results: [{ title: "Rust vs Go", url: "https://x.io/a", snippet: "bench" }] } }),
      clientRawRequest: {
        endpoint: "/v1/responses",
        body: { model: "od/gpt-6-astra" },
        headers: { accept: "text/event-stream" },
      },
    });

    expect(result.success).toBe(true);
    // Hosted tool replaced by a flat Responses function tool; upstream non-streaming.
    expect(executedBodies[0].stream).toBe(false);
    expect(executedBodies[0].tools).toEqual([
      expect.objectContaining({
        type: "function",
        name: "web_search",
        parameters: expect.objectContaining({ required: ["query"] }),
      }),
    ]);

    // Second round echoes the function_call item and appends function_call_output.
    const secondInput = executedBodies[1].input;
    expect(secondInput.at(-2)).toMatchObject({ type: "function_call", call_id: "call_1", name: "web_search" });
    expect(secondInput.at(-1)).toMatchObject({ type: "function_call_output", call_id: "call_1" });
    expect(secondInput.at(-1).output).toContain("https://x.io/a");

    // Client sees a Responses event stream with the restored web_search_call.
    const sse = await result.response.text();
    expect(result.response.headers.get("content-type")).toContain("text/event-stream");
    expect(sse).toContain("event: response.created");
    expect(sse).toContain('"type":"web_search_call"');
    expect(sse).toContain("Go compiles faster.");
    expect(sse).toContain("event: response.completed");
  });

  it("falls back to emulation when a declared-native provider denies web search to the account", async () => {
    const executedBodies = [];
    executeMock.mockImplementation(async ({ body: upstreamBody }) => {
      executedBodies.push(JSON.parse(JSON.stringify(upstreamBody)));
      if (executedBodies.length === 1) {
        return {
          response: new Response(JSON.stringify({
            error: { message: "Access denied for web search, please verify the activation status of Doubao Search" },
          }), { status: 403, headers: { "content-type": "application/json" } }),
          url: "https://api.deepseek.com/anthropic/v1/messages",
          headers: {},
          transformedBody: null,
        };
      }
      if (executedBodies.length === 2) {
        return {
          response: claudeJson([{ type: "tool_use", id: "toolu_1", name: "web_search", input: { query: "rust vs go" } }], "tool_use"),
          url: "https://api.deepseek.com/anthropic/v1/messages",
          headers: {},
          transformedBody: null,
        };
      }
      return {
        response: claudeJson([{ type: "text", text: "Answer after emulated search." }]),
        url: "https://ark.cn-beijing.volces.com/api/coding/v1/messages",
        headers: {},
        transformedBody: null,
      };
    });

    const result = await handleChatCore({
      body: {
        ...claudeBody,
        stream: false,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      },
      modelInfo: { provider: "deepseek", model: "deepseek-v4-pro" },
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
        body: { model: "ds/deepseek-v4-pro" },
        headers: { accept: "application/json" },
      },
    });

    expect(result.success).toBe(true);
    // native 403 → emulated round → final answer
    expect(executeMock).toHaveBeenCalledTimes(3);
    expect(executedBodies[1].stream).toBe(false);
    const injected = executedBodies[1].tools.find(t => t.name === "web_search");
    expect(injected.input_schema.required).toEqual(["query"]);
    expect(executedBodies[2].messages.at(-2).content.at(-1)).toMatchObject({ type: "tool_use", name: "web_search" });
    expect(executedBodies[2].messages.at(-1).content[0]).toMatchObject({ type: "tool_result" });

    const message = await result.response.json();
    expect(message.content.map(b => b.type)).toEqual(["server_tool_use", "web_search_tool_result", "text"]);
    expect(message.content.at(-1).text).toBe("Answer after emulated search.");
  });

  it("falls back to emulation when a native Responses provider denies web search", async () => {
    const executedBodies = [];
    const responsesJson = (output, usage = { input_tokens: 10, output_tokens: 4 }) => new Response(JSON.stringify({
      id: "resp_test", object: "response", status: "completed", output, usage,
    }), { status: 200, headers: { "content-type": "application/json" } });

    executeMock.mockImplementation(async ({ body: upstreamBody }) => {
      executedBodies.push(JSON.parse(JSON.stringify(upstreamBody)));
      if (executedBodies.length === 1) {
        return {
          response: new Response(JSON.stringify({
            error: { message: "Access denied for web search, verify the activation status" },
          }), { status: 403, headers: { "content-type": "application/json" } }),
          url: "https://ark.cn-beijing.volces.com/api/plan/v3/responses",
          headers: {},
          transformedBody: null,
        };
      }
      if (executedBodies.length === 2) {
        return {
          response: responsesJson([{
            type: "function_call", id: "fc_1", call_id: "call_1", name: "web_search",
            arguments: '{"query":"rust vs go"}', status: "completed",
          }]),
          url: "https://ark.cn-beijing.volces.com/api/plan/v3/responses",
          headers: {},
          transformedBody: null,
        };
      }
      return {
        response: responsesJson([{
          type: "message", role: "assistant",
          content: [{ type: "output_text", text: "Go compiles faster." }],
        }]),
        url: "https://ark.cn-beijing.volces.com/api/coding/v3/responses",
        headers: {},
        transformedBody: null,
      };
    });

    const result = await handleChatCore({
      body: {
        model: "ark-ap/deepseek-v4.1-flash",
        stream: false,
        tools: [{ type: "web_search" }],
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "rust vs go" }] }],
      },
      modelInfo: { provider: "ark-ap-provider", model: "deepseek-v4.1-flash" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn(), tagForSession: () => "T" },
      connectionId: "test-conn",
      rtkEnabled: false,
      headroomEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      customPromptEnabled: false,
      pxpipeEnabled: false,
      sourceFormatOverride: "openai-responses",
      webToolsAdapter: adapterConfig,
      executeServerTool: async () => ({ ok: true, data: { results: [{ title: "Rust vs Go", url: "https://x.io/a", snippet: "bench" }] } }),
      clientRawRequest: {
        endpoint: "/v1/responses",
        body: { model: "ark-ap/deepseek-v4.1-flash" },
        headers: { accept: "application/json" },
      },
    });

    expect(result.success).toBe(true);
    expect(executeMock).toHaveBeenCalledTimes(3);
    // First attempt is native: the hosted tool rides through untouched.
    expect(executedBodies[0].tools).toEqual([expect.objectContaining({ type: "web_search" })]);
    // Retry replaces it with a flat Responses function tool.
    expect(executedBodies[1].tools).toEqual([expect.objectContaining({ type: "function", name: "web_search" })]);
    // Second emulated round carries the function_call_output.
    expect(executedBodies[2].input.at(-1)).toMatchObject({ type: "function_call_output", call_id: "call_1" });

    const response = await result.response.json();
    expect(response.object).toBe("response");
    expect(response.output.map(i => i.type)).toEqual(["web_search_call", "message"]);
    expect(response.output[1].content[0].text).toBe("Go compiles faster.");
  });
});
