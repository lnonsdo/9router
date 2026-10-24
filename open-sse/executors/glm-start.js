import { DefaultExecutor } from "./default.js";
import { OFFICIAL_CLI_PREFIX, OFFICIAL_STABLE_SECTIONS } from "./glm-start-identity.js";
import crypto from "node:crypto";
import os from "node:os";

// Start Plan model traffic: POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages.
// Auth is the zcode JWT (stored on the connection at OAuth login as
// providerSpecificData.zcodeJwtToken) — sent as BOTH `Authorization: Bearer` and
// `x-api-key` (verified against a captured official-client request that got a
// 200 SSE response). The OAuth access token is NOT used for model calls and no
// client signing is involved.
//
// The gateway's risk engine (HTTP 405 + {"code":3012,"msg":"request has been
// blocked due to unusual activity."}) is NOT a header/TLS fingerprint check —
// the discriminator is the request BODY: `system` must be a block array whose
// leading blocks are the official ZCode identity text (see
// glm-start-identity.js). Verified by Ebony-Vinyl/dsh-our-free-model: curl with
// the full blocks gets 200, cliPrefix alone gets 3012, headers are irrelevant.
// 3012 carries an account cooldown penalty (30min → 24h → disabled after 5
// hits) so nothing here ever retries it — 405 is absent from DEFAULT_RETRY_CONFIG.
//
// `X-Device-Mid` is required by the billing endpoints (400 code 3001 without)
// and harmless on messages; its VALUE is unvalidated, so we derive a stable
// per-JWT UUID. Connection page header overrides still win over all defaults.
const ZCODE_APP_VERSION = process.env.ZCODE_APP_VERSION || "3.16.3";
const ZCODE_BASE_URL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages";

function uuidFromSeed(seed) {
  const hex = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// Stable per-JWT device id — the JWT is long-lived (no exp), so this keeps the
// same X-Device-Mid across the model executor and the usage/billing fetcher.
function deviceMid(jwt) {
  return uuidFromSeed(`zcode-device-mid:${jwt || "glm-start"}`);
}

function zcodeSourceHeaders() {
  // Deliberately MINIMAL — the probe/plugin-verified admission set. The full
  // official header family (x-title, x-zcode-agent, attribution ids, …) paired
  // with a non-Electron TLS fingerprint is the classic "spoofed client"
  // profile bot detectors score down; a bare ZCode UA + referer passes (direct
  // probe and the reference plugin both 200). Per-connection header overrides
  // from the UI still apply on top.
  return {
    "http-referer": "https://zcode.z.ai",
    "user-agent": `ZCode/${ZCODE_APP_VERSION}`,
  };
}

// --- Official request-body shape (admission + fidelity) ----------------------

// NOTE: the official date `<system-reminder>` block in the first user message
// is NOT sent — it is not an admission requirement (reference matrix: removed →
// still 200) and the only direct probe that returned 200 on this account
// (2026-10-24) carried exactly: [cliPrefix, stable, environment] system + plain
// user messages. Bodies are aligned to that verified shape to keep the
// admission surface at the proven minimum.

// Official per-session "# Environment" section (router has no cwd — "/" is a
// neutral placeholder; this block is for model fidelity, not admission).
function environmentBlock(model) {
  const platform = process.platform;
  return [
    "# Environment",
    "You have been invoked in the following environment:",
    " - Primary working directory: /",
    " - Is a git repository: no",
    ` - Platform: ${platform}`,
    ` - Shell: ${platform === "win32" ? "powershell" : "bash"}`,
    ` - OS Version: ${os.release()}`,
    ` - You are powered by the model named zcode/${model || "glm"}.`,
  ].join("\n");
}

function isOfficialPrefix(text) {
  return typeof text === "string" && text.startsWith(OFFICIAL_CLI_PREFIX);
}

function systemAlreadyOfficial(system) {
  if (typeof system === "string") return isOfficialPrefix(system);
  if (Array.isArray(system)) {
    const first = system[0];
    return isOfficialPrefix(typeof first === "string" ? first : first?.text);
  }
  return false;
}

function toTextBlocks(system) {
  if (system === undefined || system === null) return [];
  if (typeof system === "string") return system.trim() ? [{ type: "text", text: system }] : [];
  if (!Array.isArray(system)) return [];
  return system
    .filter((b) => b && typeof b.text === "string" && b.text.trim())
    .map((b) => ({ type: "text", text: b.text }));
}

// Foreign client identity claims ("You are Claude Code, Anthropic's official
// CLI for Claude.") ride along verbatim — the gateway does NOT scan block
// content for vendor names. What it DOES reject (differential probes
// 2026-10-24, new account): any FOURTH system block — even the reference
// plugin's long-proven "You are a helpful assistant." — gets 405 + 3012, while
// the exact same text merged into the tail of the environment block passes.
// ⇒ the official 3-block structure [prefix, stable, env] is preserved and the
// caller's system is appended INSIDE the last block.
export function buildOfficialSystem(system, model) {
  if (systemAlreadyOfficial(system)) {
    if (typeof system === "string") return [{ type: "text", text: system }];
    return system;
  }
  const callerText = toTextBlocks(system).map((b) => b.text).join("\n\n");
  const lastText = callerText
    ? `${environmentBlock(model)}\n\n# Additional instructions\n${callerText}`
    : environmentBlock(model);
  return [
    { type: "text", text: OFFICIAL_CLI_PREFIX },
    { type: "text", text: OFFICIAL_STABLE_SECTIONS.join("\n\n") },
    { type: "text", text: lastText, cache_control: { type: "ephemeral" } },
  ];
}

export class GlmStartExecutor extends DefaultExecutor {
  constructor(provider = "glm-start") {
    super(provider);
  }


  // The zcode JWT is THE model credential: both auth headers carry it and the
  // stock Bearer-oauth descriptor (which would send the OAuth access token) is
  // overridden entirely.
  buildHeaders(credentials, stream = true, url, model, body = null) {
    const headers = { "Content-Type": "application/json", ...this.config.headers };
    const jwt = credentials?.providerSpecificData?.zcodeJwtToken;
    if (jwt) {
      headers["authorization"] = `Bearer ${jwt}`;
      headers["x-api-key"] = jwt;
    }
    headers["x-device-mid"] = deviceMid(jwt);
    for (const [k, v] of Object.entries(zcodeSourceHeaders())) {
      if (headers[k] === undefined) headers[k] = v;
    }
    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  buildUrl() {
    return ZCODE_BASE_URL;
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    if (!transformed || typeof transformed !== "object") return transformed;
    // DefaultExecutor injects OpenAI-isms (stream_options) — the anthropic
    // messages endpoint only ever sees the official body shape, so strip them.
    delete transformed.stream_options;
    // 3012 admission gate: official identity blocks must lead `system`.
    transformed.system = buildOfficialSystem(transformed.system, model);
    return transformed;
  }

  // Make 3012 self-explanatory — and keep the three actors separate: the Z.AI
  // block is per-request (no account cooldown), the local lock is ours, and
  // "never retry" guards against the penalty escalation the reference project
  // observed under heavier abuse.
  parseError(response, bodyText) {
    const base = super.parseError(response, bodyText);
    if (/3012|unusual activity/i.test(bodyText || "")) {
      return {
        ...base,
        message: "Z.AI risk control rejected this request (3012 unusual activity) — it scores "
          + "requests one-by-one, so a corrected request is admitted again immediately. "
          + "9router has locked this connection for 1h to avoid repeat probes; a passing "
          + "Test on the connection clears the lock sooner. If every request keeps failing, "
          + "the gateway's admission rules likely changed again — check the upstream "
          + "reference implementation before retrying.",
      };
    }
    return base;
  }

  async execute(params) {
    return super.execute(params);
  }
}

export default GlmStartExecutor;
