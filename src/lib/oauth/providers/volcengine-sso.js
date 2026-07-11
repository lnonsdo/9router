import { VOLCENGINE_SSO_CONFIG } from "../constants/oauth.js";

// Volcengine SSO - uses arkcli subprocess for SSO login
// Flow: Phase 1 (start) -> arkcli outputs SSO URL -> user logs in browser
//       Phase 2 (complete) -> user pastes auth code -> arkcli completes login
//       Post: read STS credentials from ~/.arkcli/identities/
const volcengineSso = {
  config: VOLCENGINE_SSO_CONFIG,
  flowType: "volcengine_sso",

  // Phase 1: Start arkcli --no-browser, extract SSO URL
  // Returns a fake "device code" object with the SSO URL as verification_uri
  requestDeviceCode: async () => {
    const { startSsoLogin, checkArkcliInstalled } = await import("@/lib/volcengine/ssoLogin.js");
    const installed = await checkArkcliInstalled();
    if (!installed) {
      throw new Error("arkcli not installed. Run: npm install -g @volcengine/ark-cli");
    }
    const { ssoUrl, arkcliHome } = await startSsoLogin();
    // Return in device_code-like shape so OAuthModal can handle it
    return {
      device_code: "volcengine_sso_pending",
      user_code: null,
      verification_uri: ssoUrl,
      verification_uri_complete: ssoUrl,
      expires_in: 900,
      interval: 5,
      // Custom field: indicates this is a manual code-paste flow, not polling
      _volcengineSso: true,
      // The isolated arkcli HOME from Phase 1 - needed by Phase 2
      _arkcliHome: arkcliHome,
    };
  },

  // Phase 2: This is NOT called via standard polling.
  // Instead, the dynamic route calls completeSsoLogin directly.
  // But we implement pollToken to return "pending" so the OAuthModal
  // polling loop keeps waiting until the manual-code path completes.
  pollToken: async () => {
    return {
      ok: false,
      data: { error: "authorization_pending" },
    };
  },

  mapTokens: (tokens) => tokens,
};

export default volcengineSso;
