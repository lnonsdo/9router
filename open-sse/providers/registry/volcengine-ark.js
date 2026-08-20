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
    { id: "doubao-seed-2.1-turbo", name: "Doubao Seed 2.1 Turbo" },
    { id: "doubao-seed-2.1-pro", name: "Doubao Seed 2.1 Pro" },
    { id: "doubao-seed-2.0-lite", name: "Doubao Seed 2.0 Lite" },
    { id: "doubao-seed-2.0-mini", name: "Doubao Seed 2.0 Mini" },
    { id: "glm-5.2", name: "GLM-5.2" },
    { id: "glm-5.3", name: "GLM-5.3" },
    { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
    { id: "kimi-k3", name: "Kimi K3" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "minimax-m3", name: "MiniMax M3" },
  ],
};
