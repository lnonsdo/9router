// Z.ai Start Plan (the ZCode client's `account:zai-start-plan`). Same CLI-polling
// OAuth as glm, but the connection keeps the zcode JWT (plus the OAuth access
// token) instead of minting a coding-plan API key — Start Plan entitlement and
// billing live behind zcode.z.ai, not api.z.ai, so the coding-plan key never sees
// it. Model traffic is Anthropic-messages on zcode.z.ai, authenticated by the
// zcode JWT in both auth headers, with no client signing (the official client
// signs only coding-plan-key requests).
const glmStart = {
  id: "glm-start",
  priority: 141,
  alias: "glm-start",
  display: {
    name: "Zai GLM Start Plan",
    icon: "code",
    color: "#7C3AED",
    textIcon: "GL",
    website: "https://z.ai",
    notice: {
      signupUrl: "https://chat.z.ai",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  // Same server-generated authorize_url polling flow as glm, but pollToken skips
  // the business-JWT → coding-plan API key minting (mintPlanApiKey: false) and
  // surfaces the raw OAuth access token as access_token instead.
  oauth: {
    providerId: "zai",
    cliInitUrl: "https://zcode.z.ai/api/v1/oauth/cli/init",
    cliPollUrl: "https://zcode.z.ai/api/v1/oauth/cli/poll",
    mintPlanApiKey: false,
  },
  transport: {
    baseUrl: "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages",
    format: "claude",
    // captured official-client shape: only anthropic-version, no beta flags
    headers: { "anthropic-version": "2023-06-01" },
    // Start Plan allows 3 concurrent SESSIONS per account. Over that it answers
    // 429 {"code":3008,"msg":"user concurrency limit exceeded"}; 3009 is the
    // model-level sibling (capacity events, e.g. 2026-10-27) and has not been
    // seen since. The budget is per ACCOUNT, not per router: the same account
    // used on a second machine eats into the same 3 slots, which is why 3008
    // can fire here with only 1-2 local requests in flight. Collisions clear in
    // seconds — wait and re-probe inside the executor instead of failing to the
    // client.
    retry: {
      429: { attempts: 3, delayMs: 3000 },
    },
    // executor overrides buildHeaders entirely (zcode JWT in both auth headers)
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "GLM-5.3", name: "GLM 5.3" },
    { id: "GLM-5.3-Flash", name: "GLM 5.3 Flash" },
  ],
  // Start Plan quota is readable through zcode.z.ai billing endpoints
  // (open-sse/services/usage/glm-start.js) — flag it for the usage dashboard.
  features: { usage: true },
  serviceKinds: ["llm"],
};

export default glmStart;
