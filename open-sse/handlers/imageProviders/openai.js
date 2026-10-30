// OpenAI-compatible adapter (used by openai, minimax, openrouter, recraft)
import { PROVIDER_MEDIA } from "../../providers/index.js";

const imageCfg = (id) => PROVIDER_MEDIA[id]?.imageConfig || {};
const imageUrl = (id) => imageCfg(id).baseUrl;

export default function createOpenAIAdapter(providerId) {
  const cfg = imageCfg(providerId);
  return {
    buildUrl: () => imageUrl(providerId),
    buildHeaders: (creds) => {
      const headers = { "Content-Type": "application/json", ...(cfg.headers || {}) };
      const key = creds?.apiKey || creds?.accessToken;
      if (key) headers["Authorization"] = `Bearer ${key}`;
      return headers;
    },
    buildBody: (model, body) => {
      const {
        prompt,
        n = 1,
        size,
        quality,
        style,
        response_format,
        output_format,
      } = body;
      const full = {
        model,
        prompt,
        n,
        size: size || cfg.defaultSize || "1024x1024",
        output_format,
      };
      if (quality) full.quality = quality;
      if (style) full.style = style;
      if (response_format) full.response_format = response_format;
      for (const field of ["output_format", "watermark", "prompt_extend"]) {
        if (cfg.bodyFields?.includes(field) && body[field] !== undefined) {
          full[field] = body[field];
        }
      }
      // I2I / edit: forward the input image(s) only when the provider's imageConfig
      // opts in — upstreams differ, e.g. Ark AgentPlan Seedream takes `image` as a
      // string for one reference and an array for many (URL or base64 data URI).
      if (cfg.imageEdit) {
        const refs = [
          ...(Array.isArray(body.images) ? body.images : []),
          ...(Array.isArray(body.image) ? body.image : body.image ? [body.image] : []),
        ].filter(Boolean);
        if (refs.length === 1) full.image = refs[0];
        else if (refs.length > 1) full.image = refs;
      }
      // bodyFields whitelist (e.g. xAI accepts only model/prompt/n/response_format)
      if (Array.isArray(cfg.bodyFields)) {
        const req = {};
        for (const f of cfg.bodyFields) if (full[f] !== undefined) req[f] = full[f];
        return req;
      }
      return full;
    },
    normalize: (responseBody) => responseBody,
  };
}
