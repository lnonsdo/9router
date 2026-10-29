import { DefaultExecutor } from "./default.js";
import { resolveOllamaLocalHost } from "../config/providers.js";

export class OllamaLocalExecutor extends DefaultExecutor {
  constructor() {
    super("ollama-local");
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    return `${resolveOllamaLocalHost(credentials)}/api/chat`;
  }

  // Connection-level `numCtx` (providerSpecificData) overrides the model's
  // Modelfile num_ctx per request — a remote Ollama defaults to 8192 even when
  // the model supports far more, silently truncating long-context sessions.
  transformRequest(model, body, stream, credentials) {
    const raw = credentials?.providerSpecificData?.numCtx ?? credentials?.providerSpecificData?.num_ctx;
    const numCtx = typeof raw === "string" ? Number(raw.trim()) : Number(raw);
    if (Number.isFinite(numCtx) && numCtx > 0) {
      body.options = { ...(body.options || {}), num_ctx: numCtx };
    }
    return body;
  }
}

export default OllamaLocalExecutor;
