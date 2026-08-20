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
    // 千问 — 文本/视觉推理
    { id: "qwen3.8-max", name: "Qwen3.8 Max" },
    { id: "qwen3.7-max", name: "Qwen3.7 Max" },
    { id: "qwen3.7-plus", name: "Qwen3.7 Plus" },
    { id: "qwen3.6-flash", name: "Qwen3.6 Flash" },
    // DeepSeek — 文本推理
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek-v4-pro-0813", name: "DeepSeek V4 Pro 0813" },
    { id: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash 0731" },
    // 智谱 AI — 文本推理
    { id: "glm-5.2", name: "GLM 5.2" },
    // 千问 — 图片生成
    { id: "qwen-image-3.0-pro", name: "Qwen Image 3.0 Pro", type: "image" },
    // 万相 — 图片生成
    { id: "wan2.7-image", name: "Wan2.7 Image", type: "image" },
    { id: "wan2.7-image-pro", name: "Wan2.7 Image Pro", type: "image" },
    // 千问 — 语音
    { id: "qwen-audio-3.0-tts-plus", name: "Qwen Audio TTS Plus", type: "tts" },
    { id: "qwen-audio-3.0-realtime-plus", name: "Qwen Audio Realtime Plus" },
    { id: "qwen-audio-3.0-asr-flash", name: "Qwen Audio ASR Flash", type: "stt" },
    // HappyHorse — 视频生成
    { id: "happyhorse-1.1-i2v", name: "HappyHorse 1.1 I2V", type: "video" },
    { id: "happyhorse-1.1-t2v", name: "HappyHorse 1.1 T2V", type: "video" },
    { id: "happyhorse-1.1-r2v", name: "HappyHorse 1.1 R2V", type: "video" },
  ],
};
