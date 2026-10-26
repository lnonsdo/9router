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
      // Claude wire only: Coding Plan's Messages API supports native web search
      // (docs: console.volcengine.com/ark → "使用 Claude Code 的 Web Search 功能").
      // It needs 豆包搜索 Custom 版 activated under
      // 控制台 > 开通管理 > 应用组件库 > 豆包搜索; otherwise the call answers
      // 403 "Access denied for web search … verify the activation status"
      // (observed 2026-10-26). web_fetch is not offered on this endpoint.
      // A Codex client is unaffected by this list: it matches the
      // openai-responses transport below, so translation is skipped and the
      // hosted {type:"web_search"} tool is forwarded as-is
      // (docs: coding-plan-personal-ai-codex.md).
      claudeSupportedToolTypes: ["web_search_20250305", "web_search_20260209"],
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
