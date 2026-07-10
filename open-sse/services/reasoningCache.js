/**
 * Reasoning Replay Cache - caches reasoning_content from thinking-mode models
 * (DeepSeek V4, Kimi K2, etc.) and re-injects it on subsequent tool-call turns
 * to prevent 400 errors when the assistant's reasoning is missing.
 *
 * Memory-only implementation (no DB persistence).
 */

const MAX_MEMORY_ENTRIES = 200;
const MAX_ENTRY_BYTES = 10000;
const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

const memoryCache = new Map();
let replayCount = 0;

function buildCacheKey(toolCallId, provider, model) {
  return `${provider || ""}:${model || ""}:${toolCallId || ""}`;
}

function truncateReasoning(reasoning) {
  if (typeof reasoning !== "string") return reasoning;
  if (reasoning.length * 4 > MAX_ENTRY_BYTES) {
    return reasoning.slice(0, Math.floor(MAX_ENTRY_BYTES / 4));
  }
  return reasoning;
}

function evictIfNeeded() {
  if (memoryCache.size <= MAX_MEMORY_ENTRIES) return;
  // Evict oldest entries (Map maintains insertion order)
  const toDelete = memoryCache.size - MAX_MEMORY_ENTRIES;
  let deleted = 0;
  for (const key of memoryCache.keys()) {
    if (deleted >= toDelete) break;
    memoryCache.delete(key);
    deleted++;
  }
}

function cleanupExpired() {
  const now = Date.now();
  for (const [key, entry] of memoryCache) {
    if (now - entry.timestamp > TTL_MS) {
      memoryCache.delete(key);
    }
  }
}

export function cacheReasoningByKey(key, provider, model, reasoning) {
  if (!reasoning || typeof reasoning !== "string" || reasoning.trim().length === 0) return;
  cleanupExpired();
  evictIfNeeded();
  memoryCache.set(key, {
    reasoning: truncateReasoning(reasoning),
    provider: provider || "",
    model: model || "",
    timestamp: Date.now(),
  });
}

export function cacheReasoning(toolCallId, provider, model, reasoning) {
  const key = buildCacheKey(toolCallId, provider, model);
  cacheReasoningByKey(key, provider, model, reasoning);
}

export function lookupReasoning(toolCallId, provider, model) {
  const key = buildCacheKey(toolCallId, provider, model);
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > TTL_MS) {
    memoryCache.delete(key);
    return null;
  }
  return entry.reasoning;
}

export function cacheReasoningFromAssistantMessage(message, provider, model) {
  if (!message || message.role !== "assistant") return;
  const reasoning = message.reasoning_content || message.reasoning;
  if (!reasoning) return;

  // Cache by tool_call ids if present
  if (message.tool_calls && Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      if (tc.id) cacheReasoning(tc.id, provider, model, reasoning);
    }
  }
  // Also handle Claude format: tool_use blocks in content
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === "tool_use" && block.id) {
        cacheReasoning(block.id, provider, model, reasoning);
      }
    }
  }
}

export function recordReplay() {
  replayCount++;
}

export function getReplayCount() {
  return replayCount;
}

// Provider/model detection for reasoning replay
const REASONING_REPLAY_PROVIDERS = new Set([
  "deepseek", "opencode-go", "siliconflow", "nebius", "deepinfra",
  "sambanova", "fireworks", "together", "xiaomi-mimo",
]);

const REASONING_REPLAY_MODEL_PATTERNS = [
  /deepseek-r1/i, /deepseek-reasoner/i, /deepseek-chat/i,
  /deepseek[-/]v4[-.](flash|pro)(-free)?/i,
  /kimi-k2/i, /qwq/i, /qwen.*think/i, /glm.*think/i, /^mimo[-.]?v\d/i,
];

const DEEPSEEK_V4_MODEL_PATTERN = /deepseek[-/]v4[-.](flash|pro)/i;

export function isDeepSeekReasoningModel({ provider, model, thinkingEnabled }) {
  if (thinkingEnabled !== true) return false;
  return DEEPSEEK_V4_MODEL_PATTERN.test(model);
}

export function requiresReasoningReplay({ provider, model, thinkingEnabled, interleavedField, allowLegacyFallback = true }) {
  const normalizedProvider = (provider || "").trim().toLowerCase();
  const normalizedModel = (model || "").trim();
  const normalizedInterleavedField = typeof interleavedField === "string" ? interleavedField.trim().toLowerCase() : "";
  if (normalizedInterleavedField === "reasoning_content") return true;
  if (normalizedInterleavedField === "reasoning_details") return false;
  if (/deepseek-reasoner/i.test(normalizedModel) || /deepseek-r1/i.test(normalizedModel)) return false;
  if (isDeepSeekReasoningModel({ provider, model, thinkingEnabled })) return true;
  if (!allowLegacyFallback) return false;
  if (REASONING_REPLAY_PROVIDERS.has(normalizedProvider)) return true;
  return REASONING_REPLAY_MODEL_PATTERNS.some(p => p.test(normalizedModel));
}
