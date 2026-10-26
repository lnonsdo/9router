import { CLAUDE_API_HEADERS } from "../shared.js";

export default {
  id: "volcengine-ark",
  priority: 270,
  alias: "volcengine-ark",
  aliases: [
    "ark",
  ],
  uiAlias: "ark",
  display: {
    name: "Volcengine Ark",
    icon: "cloud",
    color: "#1677FF",
    textIcon: "ARK",
    website: "https://ark.cn-beijing.volces.com",
    notice: {
      apiKeyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions",
    headers: {},
    quirks: {
      // Claude wire: intentionally NO claudeSupportedToolTypes. Probed
      // 2026-10-26 with this account: /api/coding/v1/messages answers either
      // 403 ("Access denied for web search", 豆包搜索 not activated) or 200 with
      // a CLIENT tool_use block for web_search — never server_tool_use. Native
      // cannot be trusted, so the adapter emulates every Claude request.
      // Responses wire: the endpoint silently ignores a hosted
      // {type:"web_search"} tool (no web_search_call item, no error), so force
      // emulation there as well.
      responsesUnsupportedToolTypes: ["web_search", "web_search_preview", "web_fetch"],
    },
  },
  transports: [
    {
      format: "openai",
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions",
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
    },
    {
      format: "openai-responses",
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3/responses",
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
      forceStream: true,
    },
    {
      format: "claude",
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v1/messages",
      headers: { ...CLAUDE_API_HEADERS },
      auth: { combined: true, header: "x-api-key", scheme: "raw" },
    },
  ],
  models: [
    { id: "ark-code-latest", name: "Ark Code (Latest)" },
    { id: "doubao-seed-2.1-pro", name: "Doubao Seed 2.1 Pro" },
    { id: "doubao-seed-2.1-lite", name: "Doubao Seed 2.0 Lite" },
    { id: "doubao-seed-2.0-mini", name: "Doubao Seed 2.0 Mini" },
    { id: "doubao-seed-evolving", name: "Doubao Seed Evolving" },
    { id: "glm-5.3", name: "GLM-5.3" },
    { id: "glm-5.3-flash", name: "GLM-5.3 Flash" },
    { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
    { id: "kimi-k3", name: "Kimi K3" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { id: "deepseek-v4.1-flash-economy", name: "DeepSeek V4.1 Flash Economy" },
    { id: "minimax-m3", name: "MiniMax M3" },
  ],
};
