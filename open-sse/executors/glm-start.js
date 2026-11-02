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
// The wire UA version is PINNED, not env-driven: the desktop shell injects
// ZCODE_APP_VERSION=<installed ZCode version>, and the gateway refuses UA
// versions it cannot pair with the identity-block era — ZCode/3.17.1 = 405 +
// 3012, ZCode/3.16.3 = 200 on the byte-identical request (P12/P13 probes,
// 2026-10-31). That version flip is what broke the channel on 10-30. Bump
// ZCODE_UA_VERSION only after a live probe confirms the gate accepts it.
const ZCODE_UA_VERSION = process.env.ZCODE_UA_VERSION || "3.16.3";
const ZCODE_BASE_URL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages";

// Edge-layer block, NOT the zcode-plan identity gate: Aliyun WAF in front of
// zcode.z.ai answers with an HTML 405 page (`<title>405</title>`,
// errors.aliyun.com assets, traceid in #renderData) instead of JSON.
// 2026-11-03 probes from the blocked egress IP: GET / POST / PUT on
// /api/v1/zcode-plan/anthropic/v1/messages ALL get the page — with a valid
// JWT, with no Authorization at all, and with an empty User-Agent — while
// /api/v1/zcode-plan/billing/balance (401) and /api/v1/oauth/cli/init (400)
// on the same host still reach the origin. So the rule is egress-IP × this
// one path, decided BEFORE any account is consulted: two different accounts
// blocked identically here while the same account works from another network.
// It is not account standing (zero 3012 that day) and it is not a whole-IP
// ban. Retrying in place only bridges the boundary where the rule starts or
// lapses; a sustained block needs a different egress IP.
export const WAF_RETRY_DELAYS_MS = [1500, 4000];

export function isWafBlockBody(bodyText) {
  const text = typeof bodyText === "string" ? bodyText : "";
  if (!text || /\b3012\b|unusual activity/i.test(text)) return false;
  return /aliyun\.com|renderData|<!doctype/i.test(text);
}

function isWafBlockResponse(response) {
  if (!response || response.status !== 405) return false;
  return /text\/html/i.test(response.headers?.get?.("content-type") || "");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Per-account session slots ----------------------------------------------
// Start Plan allows 3 concurrent SESSIONS per account; the 4th answers 429
// {"code":3008,"msg":"user concurrency limit exceeded"}. The budget is the
// ACCOUNT's, not this router's: the same account on another machine eats the
// same 3 slots, which is why 3008 can fire with only one local request in
// flight. Colliding and retrying is how the channel got flagged at the edge
// (2026-11-03: a 3-minute burst of collisions ended in an egress-IP block on
// this path), so requests QUEUE for a slot instead of racing for it.
export const GLM_START_SLOTS = {
  max: Number(process.env.GLM_START_MAX_SESSIONS || 3),
  // Give up waiting and hand the request to account fallback. Long enough to
  // outlive a slow GLM-5.3 thinking turn, short enough not to hang a chat.
  queueTimeoutMs: Number(process.env.GLM_START_QUEUE_TIMEOUT_MS || 60_000),
  // Safety net when a caller never reads or cancels the body.
  watchdogMs: 15 * 60 * 1000,
};

const sessionSlots = new Map(); // connectionId -> { active, waiters: [] }

function slotEntry(key) {
  let entry = sessionSlots.get(key);
  if (!entry) {
    entry = { active: 0, waiters: [] };
    sessionSlots.set(key, entry);
  }
  return entry;
}

// Idempotent; hands the freed slot straight to the next waiter so queued
// requests are admitted in order without re-checking.
function makeSlotRelease(key) {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const entry = sessionSlots.get(key);
    if (!entry) return;
    const next = entry.waiters.shift();
    if (next) {
      next.settle(makeSlotRelease(key));
      return;
    }
    entry.active = Math.max(0, entry.active - 1);
    if (!entry.active) sessionSlots.delete(key);
  };
}

// Resolves with a release fn, or null when the wait timed out / was aborted.
function acquireSlot(key, signal) {
  const entry = slotEntry(key);
  if (entry.active < GLM_START_SLOTS.max) {
    entry.active++;
    return Promise.resolve(makeSlotRelease(key));
  }
  return new Promise((resolve) => {
    const waiter = {
      settle: (value) => {
        clearTimeout(waiter.timer);
        if (waiter.onAbort) signal?.removeEventListener?.("abort", waiter.onAbort);
        resolve(value);
      },
      timer: null,
      onAbort: null,
    };
    const drop = () => {
      const i = entry.waiters.indexOf(waiter);
      if (i >= 0) entry.waiters.splice(i, 1);
    };
    waiter.timer = setTimeout(() => {
      drop();
      waiter.settle(null);
    }, GLM_START_SLOTS.queueTimeoutMs);
    waiter.timer.unref?.();
    if (signal) {
      waiter.onAbort = () => {
        drop();
        waiter.settle(null);
      };
      signal.addEventListener?.("abort", waiter.onAbort, { once: true });
    }
    entry.waiters.push(waiter);
  });
}

// Hold the slot for as long as the upstream session lives — i.e. until the SSE
// body ends, errors or is cancelled — not merely until headers arrive.
function holdSlotUntilBodyEnds(response, release) {
  const body = response?.body;
  if (!body) {
    release();
    return response;
  }
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    release();
  };
  const watchdog = setTimeout(finish, GLM_START_SLOTS.watchdogMs);
  watchdog.unref?.();
  const reader = body.getReader();
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// Every slot is busy past the queue timeout: hand the request to account
// fallback with the upstream's own shape, so it hits the existing 429 path
// (5s cool-off + next account) instead of queueing behind a wall.
function sessionQueueBusyResult(params) {
  const payload = JSON.stringify({
    code: 3008,
    msg: "user concurrency limit exceeded (9router: all session slots busy, queue timeout)",
  });
  return {
    response: new Response(payload, {
      status: 429,
      headers: { "content-type": "application/json" },
    }),
    url: ZCODE_BASE_URL,
    headers: {},
    transformedBody: params?.body,
  };
}

// Test hook: module state is per-process, so suites must start clean.
export function resetGlmStartSlots() {
  sessionSlots.clear();
}

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
    "user-agent": `ZCode/${ZCODE_UA_VERSION}`,
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

  // Make 3012 self-explanatory — the verified trigger (2026-10-31) is the UA
  // version string: the gate refuses versions it cannot pair with the identity
  // era (ZCode/3.17.1 = 405, ZCode/3.16.3 = 200, byte-identical request). The
  // wire UA is pinned, so a fresh 3012 means the gate moved again.
  parseError(response, bodyText) {
    const base = super.parseError(response, bodyText);
    if (isWafBlockBody(bodyText)) {
      // Never quoted back verbatim: the HTML page is ~2.5KB of boilerplate and
      // says nothing the client can act on.
      return {
        ...base,
        message: "Z.AI's edge (Aliyun WAF) is refusing this API path from the current egress IP — "
          + "an HTML 405 page, not the 3012 identity gate. Verified 2026-11-03: an unauthenticated "
          + "request and a different account get the same page, while other paths on zcode.z.ai "
          + "still reach the origin, so the exit IP is what is blocked, not the account. "
          + "9router retried in place 3x (account standing untouched); this error means the block is "
          + "sustained — switch the egress IP (proxy/VPN node) or wait for it to lapse.",
      };
    }
    if (/3012|unusual activity/i.test(bodyText || "")) {
      return {
        ...base,
        message: "Z.AI risk control rejected this request (3012 unusual activity). Verified trigger "
          + "(2026-10-31): user-agent versions the gate refuses — ZCode/3.17.1 = 405, ZCode/3.16.3 = 200 "
          + "on the byte-identical request — so 9router pins the wire UA to the accepted version. "
          + "A fresh 3012 on the pinned version means the gate moved again: wait 1-2h, re-test once, "
          + "then check the upstream reference implementation. "
          + "9router has locked this connection for 1h; a passing Test clears the lock sooner.",
      };
    }
    return base;
  }

  // Every upstream call runs inside an account session slot. Only an HTML 405
  // WAF page is retried (in place, still inside the slot) — the JSON 3012 gate
  // is NEVER retried, every hit of it costs account standing.
  async execute(params) {
    const key = params?.credentials?.connectionId || "__glm-start__";
    const release = await acquireSlot(key, params?.signal);
    if (!release) {
      params?.log?.debug?.("QUEUE", `glm-start ${key}: all ${GLM_START_SLOTS.max} session slots busy for ${GLM_START_SLOTS.queueTimeoutMs}ms — yielding to fallback`);
      return sessionQueueBusyResult(params);
    }
    try {
      for (let attempt = 0; ; attempt++) {
        const result = await super.execute(params);
        if (!isWafBlockResponse(result?.response) || attempt >= WAF_RETRY_DELAYS_MS.length) {
          // A streaming response owns the slot until its body ends; a JSON
          // response (stream:false) has already finished upstream by the time
          // headers arrive, and error bodies are tiny — release immediately.
          if (result?.response?.ok && params?.stream) {
            return { ...result, response: holdSlotUntilBodyEnds(result.response, release) };
          }
          release();
          return result;
        }
        const delay = WAF_RETRY_DELAYS_MS[attempt] + Math.floor(Math.random() * 800);
        params?.log?.debug?.("RETRY", `WAF 405 block page — retry ${attempt + 1}/${WAF_RETRY_DELAYS_MS.length} after ${delay}ms`);
        try { await result.response.body?.cancel?.(); } catch { /* body already gone */ }
        await sleep(delay);
      }
    } catch (error) {
      release();
      throw error;
    }
  }
}

export default GlmStartExecutor;
