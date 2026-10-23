import { OPEN_DESIGN_CONFIG } from "../constants/oauth.js";

/**
 * Open Design (AMR) device-authorization login.
 *
 * Mirrors what the `vela login` CLI does (verified end-to-end against the
 * upstream contract):
 *   1. POST {apiBaseUrl}/cli/device-authorizations
 *        {"cliVersion":"0.1.7","host":"…","profile":"prod"}
 *      → {deviceId, deviceSecret, activationUrl, userCode, expiresInSeconds,
 *         expiresAt, pollIntervalSeconds}
 *   2. User opens activationUrl in a browser and approves the request.
 *   3. POST {apiBaseUrl}/cli/device-authorizations/{deviceId}/token
 *        {"deviceSecret":"…"}   (no other auth)
 *      → pending, or {status:"approved", controlKey, runtimeKey, apiUrl,
 *         linkUrl, user:{id,email,name}}
 *
 * controlKey is the console credential (wallet balance / plan usage), runtimeKey
 * is the sk-amr-… inference key. Both are stored on the connection; the device
 * secret rides along as `codeVerifier` because the poll route forwards it
 * verbatim (same trick Qoder uses for its own verifier).
 */
const openDesign = {
  config: OPEN_DESIGN_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config) => {
    const response = await fetch(`${config.apiBaseUrl}/cli/device-authorizations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        // The gateway validates this shape; keep the CLI's own version string.
        cliVersion: "0.1.7",
        host: "9router",
        profile: "prod",
      }),
    });

    if (!response.ok) {
      const error = await response.text().catch(() => "");
      throw new Error(`Open Design device code request failed (${response.status}): ${error}`);
    }

    const data = await response.json();
    if (!data?.deviceId || !data?.deviceSecret) {
      throw new Error("Open Design device code response missing deviceId/deviceSecret");
    }

    const expiresIn = Number(data.expiresInSeconds)
      || (data.expiresAt ? Math.max(1, Math.round((Date.parse(data.expiresAt) - Date.now()) / 1000)) : 300);

    return {
      device_code: data.deviceId,
      user_code: data.userCode || data.code || "",
      verification_uri: data.activationUrl,
      verification_uri_complete: data.activationUrl,
      expires_in: expiresIn,
      interval: Number(data.pollIntervalSeconds) || 2,
      // Forwarded to pollToken() by the poll route.
      codeVerifier: data.deviceSecret,
    };
  },
  pollToken: async (config, deviceCode, deviceSecret) => {
    if (!deviceCode || !deviceSecret) {
      return { ok: false, data: { error: "invalid_request", error_description: "Missing device id/secret" } };
    }

    const response = await fetch(
      `${config.apiBaseUrl}/cli/device-authorizations/${encodeURIComponent(deviceCode)}/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ deviceSecret }),
      },
    );

    let data;
    try {
      data = await response.json();
    } catch {
      const text = await response.text().catch(() => "");
      data = { error: "invalid_response", error_description: text };
    }

    if (response.ok && data?.status === "approved") {
      return {
        ok: true,
        data: {
          access_token: data.runtimeKey,
          _controlKey: data.controlKey,
          _apiUrl: data.apiUrl,
          _linkUrl: data.linkUrl,
          _user: data.user,
        },
      };
    }

    if (response.ok) {
      // "pending" is the normal waiting state; anything else terminal is surfaced.
      const status = typeof data?.status === "string" ? data.status : "pending";
      return {
        ok: false,
        data: status === "pending"
          ? { error: "authorization_pending" }
          : { error: status, error_description: `Device authorization ${status}` },
      };
    }

    return { ok: false, data };
  },
  mapTokens: (tokens) => {
    const user = tokens._user || {};
    const email = typeof user.email === "string" && user.email.trim() ? user.email.trim() : null;
    return {
      // Inference key (sk-amr-…) — what every transport sends upstream.
      accessToken: tokens.access_token,
      apiKey: tokens.access_token,
      // No refresh grant: the device login issues long-lived keys.
      refreshToken: null,
      email,
      displayName: user.name || user.displayName || null,
      providerSpecificData: {
        authMethod: "device",
        // Console credential — used by getOpenDesignUsage(), never sent upstream.
        ...(tokens._controlKey ? { amrControlKey: tokens._controlKey } : {}),
        ...(user.id ? { userId: user.id } : {}),
      },
    };
  },
};

export default openDesign;
