import { describe, it, expect } from "vitest";

import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { OllamaLocalExecutor } from "../../open-sse/executors/ollama-local.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";

// qwen3.8-27b-unc on ollama-local: caps come from the *qwen3.8* pattern
// (reasoning: true, thinkingFormat: "qwen") — the provider's transport-level
// thinkingFormat: "ollama" must win so the Ollama boolean `think` dial is used.
const MODEL = "qwen3.8-27b-unc";

describe("ollama thinking mapping (thinkingUnified)", () => {
  it("declares thinkingFormat ollama on the transport for both ollama providers", () => {
    expect(PROVIDERS["ollama-local"]?.thinkingFormat).toBe("ollama");
    expect(PROVIDERS["ollama"]?.thinkingFormat).toBe("ollama");
  });

  it("maps intent none → think:false on the ollama body", () => {
    const body = { model: MODEL, messages: [] };
    applyThinking("ollama", MODEL, body, "ollama-local", { mode: "none" });
    expect(body.think).toBe(false);
    // qwen dialect fields must not leak onto an ollama body
    expect(body.enable_thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("maps level intent → think:true", () => {
    const body = { model: MODEL, messages: [] };
    applyThinking("ollama", MODEL, body, "ollama-local", { mode: "level", level: "high" });
    expect(body.think).toBe(true);
  });

  it("maps budget intent → think:true", () => {
    const body = { model: MODEL, messages: [] };
    applyThinking("ollama", MODEL, body, "ollama-local", { mode: "budget", budget: 8192 });
    expect(body.think).toBe(true);
  });

  it("keeps the model default (no think field) for auto / absent intent", () => {
    const auto = { model: MODEL, messages: [] };
    applyThinking("ollama", MODEL, auto, "ollama-local", { mode: "auto" });
    expect(auto.think).toBeUndefined();

    const absent = { model: MODEL, messages: [] };
    applyThinking("ollama", MODEL, absent, "ollama-local", undefined);
    expect(absent.think).toBeUndefined();
  });

  it("full pipeline: openai body with reasoning_effort:none → ollama body with think:false", () => {
    const body = {
      model: "ollama-local/qwen3.8-27b-unc",
      messages: [{ role: "user", content: "1+1=?" }],
      reasoning_effort: "none",
    };
    const out = translateRequest("openai", "ollama", MODEL, body, false, null, "ollama-local");
    expect(out.think).toBe(false);
  });
});

describe("OllamaLocalExecutor num_ctx", () => {
  const exec = new OllamaLocalExecutor();

  it("merges providerSpecificData.numCtx into options.num_ctx", () => {
    const body = { model: MODEL, messages: [], options: { temperature: 0.5 } };
    exec.transformRequest(MODEL, body, true, { providerSpecificData: { numCtx: 32768 } });
    expect(body.options.num_ctx).toBe(32768);
    expect(body.options.temperature).toBe(0.5);
  });

  it("accepts num_ctx alias and string values", () => {
    const body = { model: MODEL, messages: [] };
    exec.transformRequest(MODEL, body, true, { providerSpecificData: { num_ctx: "16384" } });
    expect(body.options.num_ctx).toBe(16384);
  });

  it("leaves options untouched when absent or invalid", () => {
    const absent = { model: MODEL, messages: [] };
    exec.transformRequest(MODEL, absent, true, null);
    expect(absent.options).toBeUndefined();

    const invalid = { model: MODEL, messages: [] };
    exec.transformRequest(MODEL, invalid, true, { providerSpecificData: { numCtx: "abc" } });
    expect(invalid.options).toBeUndefined();
  });
});
