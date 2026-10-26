// Open Design (AMR Link) — subscription gateway in front of a "vela" model
// router. Probed 2026-10-23 against https://amr-link.open-design.ai:
//   POST /v1/chat/completions   (Authorization: Bearer)
//   POST /v1/responses          (Authorization: Bearer)
//   POST /v1/messages           (x-api-key or Bearer + anthropic-version)
//   GET  /v1/models             (entitled catalogue, Bearer)
// Every id answers on all three surfaces and streams, tool calls round-trip.
// Anthropic server tools do NOT: probed 2026-10-26 on /v1/messages with
// web_search_20250305 / web_fetch_20250910 (and on /v1/responses with the
// hosted {type:"web_search"}), every Claude id answers HTTP 400
// "unsupported Responses tool type … on Chat route" — the gateway normalizes
// onto its internal Chat route. Do not add claudeSupportedToolTypes here; the
// Web Tools Adapter must emulate for this provider.
// Quota data (credits windows + wallet balance) lives behind the console
// session cookie — see getOpenDesignUsage() in services/usage/misc.js.
export default {
  id: "open-design",
  priority: 118,
  alias: "opendesign",
  aliases: [
    "od",
  ],
  uiAlias: "od",
  display: {
    name: "Open Design",
    icon: "palette",
    color: "#22C55E",
    textIcon: "OD",
    website: "https://open-design.ai",
    notice: {
      text: "AMR Link subscription gateway (Design Plan + plan models). One API key reaches every model on all three surfaces — /v1/chat/completions, /v1/responses and /v1/messages. Non-entitled plan models answer 403 tier_model_not_entitled. Sign in with the device login to fetch balance and plan usage automatically, or paste a console session cookie on the connection form.",
      apiKeyUrl: "https://open-design.ai/cloud/dashboard",
    },
  },
  // Dual auth, like kimi/glm: the device login is the primary path, the
  // sk-amr-… runtime key can also be pasted as a plain API key.
  category: "oauth",
  authType: "oauth",
  // Browser login is possible too: a device-authorization flow (the same one the
  // official `vela login` CLI runs) mints a runtime key plus a console control
  // key, so no manual key or cookie paste is needed.
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  oauth: {
    apiBaseUrl: "https://amr-api.open-design.ai/api/v1",
  },
  // Balance/plan windows are only readable with the console credential — either
  // the control key from the device login or a pasted console session cookie.
  // The sk-amr-… runtime key is inference-only.
  hasProviderSpecificData: true,
  transport: {
    baseUrl: "https://amr-link.open-design.ai/v1/chat/completions",
    validateUrl: "https://amr-link.open-design.ai/v1/models",
  },
  // Multi-endpoint: pick the transport matching the client sourceFormat to skip
  // translation. /v1/messages is a real Anthropic surface: it takes the native
  // `x-api-key` header (Bearer also works) and requires anthropic-version.
  // Chat Completions and Responses only accept `Authorization: Bearer`.
  transports: [
    {
      format: "openai",
      baseUrl: "https://amr-link.open-design.ai/v1/chat/completions",
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
    },
    {
      format: "openai-responses",
      baseUrl: "https://amr-link.open-design.ai/v1/responses",
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
    },
    {
      format: "claude",
      baseUrl: "https://amr-link.open-design.ai/v1/messages",
      auth: { combined: true, header: "x-api-key", scheme: "raw", anthropicVersion: true },
    },
  ],
  models: [
    // Claude — Design Plan
    { id: "claude-haiku-5.5", name: "Claude Haiku 5.5" },
    // Claude — plan models.
    // NOTE: GET /v1/models is ACCOUNT-SCOPED — it lists what the current
    // membership tier is entitled to, not the provider's full catalogue. A
    // model missing there (or shown as "暂不支援" in the console) is gated for
    // that plan; other tiers have it, and an unentitled call answers
    // 403 tier_model_not_entitled. So keep the provider-level list complete
    // and let entitlement fail at request time.
    { id: "claude-fable-5", name: "Claude Fable 5" },
    { id: "claude-fable-5.1", name: "Claude Fable 5.1" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5" },
    { id: "claude-opus-4.8", name: "Claude Opus 4.8" },
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "claude-opus-5.5", name: "Claude Opus 5.5" },
    // GPT — Design Plan
    { id: "gpt-6-luna", name: "GPT-6 Luna" },
    // GPT — plan models
    { id: "gpt-6-astra", name: "GPT-6 Astra" },
    { id: "gpt-6-sol", name: "GPT-6 Sol" },
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
    // Gemini
    { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    { id: "gemini-4-argon", name: "Gemini 4 Argon" },
    // DeepSeek
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision Exp" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    // GLM
    { id: "glm-5.2", name: "GLM 5.2" },
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
    { id: "glm-5.3-flashx", name: "GLM 5.3 Flash-X" },
    // MiMo / Hunyuan / MiniMax / Qwen
    { id: "mimo-v2.6-flash", name: "MiMo V2.6 Flash" },
    { id: "mimo-v2.6-pro", name: "MiMo V2.6 Pro" },
    { id: "hy4-preview", name: "Hunyuan H4 Preview" },
    { id: "minimax-m3.1-flash", name: "MiniMax M3.1 Flash" },
    { id: "qwen3.7-max", name: "Qwen3.7 Max" },
    // Kimi
    { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
    { id: "kimi-k3", name: "Kimi K3" },
    // Grok
    { id: "grok-4.5", name: "Grok 4.5" },
    { id: "grok-4.6", name: "Grok 4.6" },
    { id: "grok-4.7", name: "Grok 4.7" },
    // Muse
    { id: "muse-spark-1.3", name: "Muse Spark 1.3" },
    { id: "muse-wonder", name: "Muse Wonder" },
    // Image generation (/v1/images/generations)
    { id: "seedream-5.0", name: "Seedream 5 Lite", kind: "image", params: ["n", "size"] },
    { id: "seedream-5.0-pro", name: "Seedream 5 Pro", kind: "image", params: ["n", "size"] },
    { id: "nano-banana-2", name: "Nano Banana 2", kind: "image", params: ["n", "size"] },
    { id: "nano-banana-2-lite", name: "Nano Banana 2 Lite", kind: "image", params: ["n", "size"] },
    { id: "gpt-image-2", name: "GPT Image 2", kind: "image", params: ["n", "size", "quality", "response_format"] },
  ],
  serviceKinds: ["llm", "image"],
  // Seedream 5 (non-pro) rejects anything under 3.68 MP ("size must be at least
  // 3686400 pixels"), so the default has to clear that bar; every image id on
  // the gateway accepts 2048x2048.
  imageConfig: {
    baseUrl: "https://amr-link.open-design.ai/v1/images/generations",
    defaultSize: "2048x2048",
  },
  modelsFetcher: { url: "https://amr-link.open-design.ai/v1/models", type: "openai" },
  passthroughModels: true,
  features: {
    usage: true,
    // Usage rows come from the console cookie, not the API key, but the /quota
    // card is keyed on this flag for API-key connections.
    usageApikey: true,
  },
};
