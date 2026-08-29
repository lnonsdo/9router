// Token Plan (个人版) — credit subscription keys on token-plan.cn-beijing.maas.aliyuncs.com.
// CN Beijing region (华北2/北京), distinct from alitp-intl (Singapore). The CN plan
// serves both the OpenAI-compatible surface (/compatible-mode/v1) and the Anthropic
// surface (/apps/anthropic), so both transports are declared for direct-route matching.
export default {
  id: "alitp-cn",
  priority: 12,
  alias: "alitp-cn",
  display: {
    name: "Alibaba Token Plan (CN)",
    icon: "cloud",
    color: "#FF6A00",
    textIcon: "ATP",
    website: "https://help.aliyun.com/zh/model-studio/token-plan-personal-overview",
    notice: {
      apiKeyUrl: "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
    headers: {},
    quirks: { preserveCacheControl: true },
  },
  // Multi-endpoint: pick the transport matching client sourceFormat to skip translation.
  transports: [
    {
      format: "openai",
      baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
      headers: {},
      quirks: { preserveCacheControl: true },
    },
    {
      format: "claude",
      baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages",
      headers: {},
      quirks: { preserveCacheControl: true },
    },
  ],
  models: [
    // 千问 — 推理/视觉理解/文本生成
    { id: "qwen3.8-max", name: "Qwen3.8 Max" },
    { id: "qwen3.8-plus", name: "Qwen3.8 Plus" },
    { id: "qwen3.8-flash", name: "Qwen3.8 Flash" },
    { id: "qwen3.7-max", name: "Qwen3.7 Max" },
    { id: "qwen3.7-plus", name: "Qwen3.7 Plus" },
    { id: "qwen3.6-flash", name: "Qwen3.6 Flash" },
    // DeepSeek — 推理/文本生成
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek-v4-pro-0813", name: "DeepSeek V4 Pro 0813" },
    { id: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash 0731" },
    // 智谱 AI — 推理/文本生成
    { id: "glm-5.2", name: "GLM 5.2" },
    // 图片生成
    { id: "qwen-image-3.0-pro", name: "Qwen Image 3.0 Pro", kind: "image", params: ["n", "size", "quality", "response_format"] },
    { id: "wan2.7-image", name: "WAN Image 2.7", kind: "image", params: ["n", "size", "quality", "response_format"] },
    { id: "wan2.7-image-pro", name: "WAN Image 2.7 Pro", kind: "image", params: ["n", "size", "quality", "response_format"] },

  ],
};
