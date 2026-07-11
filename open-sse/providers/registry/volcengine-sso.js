export default {
  id: "volcengine-sso",
  alias: "volcengine-sso",
  uiAlias: "volcengine-sso",
  display: {
    name: "Volcengine (SSO)",
    icon: "cloud",
    color: "#1677FF",
    textIcon: "ARK",
    website: "https://console.volcengine.com/ark",
    notice: {
      apiKeyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    },
  },
  category: "oauth",
  // No transport - this provider is for quota/usage query only, not LLM inference.
  // LLM inference is handled by volcengine-ark / ark-ap-provider (API Key).
  models: [],
  features: {
    usage: true,
  },
};
