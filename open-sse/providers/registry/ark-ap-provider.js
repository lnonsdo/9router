import { CLAUDE_API_HEADERS } from "../shared.js";

export default {
  id: "ark-ap-provider",
  alias: "ark-ap-provider",
  aliases: [
    "ark-ap",
  ],
  uiAlias: "ark-ap",
  display: {
    name: "Volcengine Agent Plan",
    icon: "cloud",
    color: "#1677FF",
    textIcon: "ARK",
    website: "https://ark.cn-beijing.volces.com",
    notice: {
      apiKeyUrl: "https://console.volcengine.com/ark/region:cn-beijing/subscription/agent-plan",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions",
    // forceStream: true,
    quirks: {
      // Claude wire: intentionally NO claudeSupportedToolTypes. Probed
      // 2026-10-26: doubao ids execute server tools natively, but
      // deepseek-v4.1-flash answers 200 with CLIENT tool_use blocks instead.
      // A provider-level whitelist cannot express that split, so every Claude
      // request is emulated (the adapter still returns standard server blocks).
      // Responses wire: hosted {type:"web_search"} IS native here —
      // web_search_call items confirmed on the same probe — so no deny-list.
    },
  },
  transports: [
    {
      format: "openai",
      baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions",
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
    },
    {
      format: "openai-responses",
      baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3/responses",
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
      forceStream: true,
    },
    {
      format: "claude",
      baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v1/messages",
      headers: { ...CLAUDE_API_HEADERS },
      auth: { combined: true, header: "x-api-key", scheme: "raw" },
    },
  ],
  models: [
    { id: "ark-code-latest", name: "Ark Code (Latest)" },
    { id: "doubao-seed-evolving", name: "Doubao Seed Evolving" },
    { id: "doubao-seed-2.1-pro", name: "Doubao Seed 2.1 Pro" },
    { id: "doubao-seed-2.1-lite", name: "Doubao Seed 2.0 Lite" },
    { id: "doubao-seed-2.0-mini", name: "Doubao Seed 2.0 Mini" },
    { id: "glm-5.3", name: "GLM-5.3" },
    { id: "glm-5.3-flash", name: "GLM-5.3 Flash" },
    { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
    { id: "kimi-k3", name: "Kimi K3" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { id: "deepseek-v4.1-flash-economy", name: "DeepSeek V4.1 Flash Economy" },
    { id: "minimax-m3", name: "MiniMax M3" },
    { id: "doubao-embedding-vision", name: "Doubao Embedding Vision", kind: "embedding" },
    { id: "doubao-seedream-5.0-lite", name: "Doubao Seedream 5.0 Lite", kind: "image", params: ["n", "size", "quality", "response_format"] },
    { id: "seed-tts-2.0", name: "Seed TTS 2.0", kind: "tts" },
  ],
  serviceKinds: ["llm", "embedding", "tts", "image"],
  ttsConfig: {
    baseUrl: "https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional",
    authType: "apikey",
    authHeader: "x-api-key",
    format: "volc-ark-tts",
    defaultModel: "seed-tts-2.0",
  },
  embeddingConfig: {
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3/embeddings",
    authType: "apikey",
    authHeader: "bearer",
  },
  imageConfig: {
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3/images/generations",
    defaultSize: "2048x2048",
  },
};
