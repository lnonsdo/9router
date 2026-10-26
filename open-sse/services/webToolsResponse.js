/**
 * Web Tools Adapter — client response assembly.
 *
 * Kept out of open-sse/handlers/chatCore.js on purpose: chatCore is an upstream
 * file, and this fork wants its footprint there as small as possible so syncing
 * from upstream stays a clean merge. Everything app-side (usage DB, request
 * detail, logging) is passed in as callbacks so this module stays free of `@/`
 * imports and usable from the standalone engine.
 */
import { claudeMessageToResponsesResponse, claudeMessageToSseBody, responsesToSseBody, runServerToolEmulation } from "./serverToolEmulator.js";
import { FORMATS } from "../translator/formats.js";

/**
 * Drive the emulation loop against the provider.
 *
 * Owns the repeated upstream calls so chatCore (an upstream file) only needs a
 * single call site. `stream:false` is deliberate — the loop buffers complete
 * rounds and re-synthesizes the client stream at the end.
 */
export function runEmulatedExchange({
  firstResponse, plan, translatedBody, executeServerTool,
  executor, upstream, clientModel, targetFormat, responseFormat,
}) {
  const { model, credentials, providerSessionId, clientTool, signal, log, proxyOptions, providerOverrides } = upstream;
  return runServerToolEmulation({
    firstResponse,
    plan,
    translatedBody,
    executeServerTool,
    runUpstream: async (body) => {
      const r = await executor.execute({
        model,
        body,
        stream: false,
        credentials,
        providerSessionId,
        clientTool,
        signal,
        log,
        proxyOptions,
        providerOverrides,
      });
      return r.response;
    },
    model,
    clientModel,
    targetFormat,
    responseFormat,
    log,
  });
}

/**
 * Build the final HTTP response for a completed emulation run.
 *
 * @param {object} args
 * @param {object} args.emuResult            runServerToolEmulation result (ok:true).
 * @param {boolean} args.wantsSse            Client asked for a stream.
 * @param {object} args.ctx                  sharedCtx from chatCore plus the app-side helpers.
 * @returns {{success: true, response: Response}}
 */
export function buildEmulatedResponse({ emuResult, wantsSse, ctx }) {
  const {
    provider, model, connectionId, sessionId, apiKey, clientRawRequest, requestStartTime,
    pxpipe, body, translatedBody, sourceFormat, reqTag, log,
    appendLog, trackDone, onRequestSuccess,
    formatDoneLine, saveUsageStats, saveRequestDetail, buildRequestDetail, extractRequestConfig,
  } = ctx;

  const claudeResponse = emuResult.claudeResponse;
  // Usage tracking wants what the router actually paid across every round; the
  // client-facing response carries Anthropic semantics (final context size).
  const usage = {
    prompt_tokens: emuResult.billed?.input_tokens || claudeResponse.usage?.input_tokens || 0,
    completion_tokens: emuResult.billed?.output_tokens || claudeResponse.usage?.output_tokens || 0,
  };

  trackDone();
  appendLog?.({ tokens: usage, status: "200 OK" });
  saveUsageStats?.({
    provider, model, tokens: usage, connectionId, sessionId, apiKey,
    endpoint: clientRawRequest?.endpoint, silent: true,
  });
  if (log?.line) {
    log.line(reqTag, "📊", `${formatDoneLine?.({ usage, latency: { total: Date.now() - requestStartTime } })} | EMU:${emuResult.rounds}r`);
  }
  if (onRequestSuccess) {
    Promise.resolve()
      .then(onRequestSuccess)
      .catch(err => {
        console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
      });
  }
  saveRequestDetail?.(buildRequestDetail?.({
    provider, model, connectionId, sessionId,
    latency: { ttft: Date.now() - requestStartTime, total: Date.now() - requestStartTime },
    tokens: usage,
    request: extractRequestConfig?.(body, false),
    providerRequest: translatedBody || null,
    response: {
      content: (claudeResponse.content || []).filter(b => b.type === "text").map(b => b.text).join("\n") || null,
      thinking: (claudeResponse.content || []).filter(b => b.type === "thinking").map(b => b.thinking).join("\n") || null,
      finish_reason: claudeResponse.stop_reason || "end_turn",
    },
    pxpipe,
    status: "success",
  }, { endpoint: clientRawRequest?.endpoint || null }))?.catch?.(err => {
    console.error("[RequestDetail] Failed to save:", err.message);
  });

  let payload;
  if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
    const response = claudeMessageToResponsesResponse(claudeResponse, {
      model: clientRawRequest?.body?.model || model,
    });
    payload = wantsSse ? responsesToSseBody(response) : JSON.stringify(response);
  } else {
    payload = wantsSse ? claudeMessageToSseBody(claudeResponse) : JSON.stringify(claudeResponse);
  }

  return {
    success: true,
    response: new Response(payload, {
      headers: wantsSse
        ? { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" }
        : { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    }),
  };
}
