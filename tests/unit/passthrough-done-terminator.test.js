import { describe, expect, it } from "vitest";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

// The passthrough path used to omit sourceFormat, so shouldEmitDoneTerminator
// defaulted to true and every Claude stream got a non-standard `data: [DONE]`
// after message_stop. It also meant OpenAI passthrough streams could be given a
// second sentinel when the upstream had already sent one.
async function drain(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

async function runPassthrough({ sourceFormat, sse, onStreamComplete = null }) {
  const stream = createPassthroughStreamWithLogger(
    "test-provider", null, "m", "c1", null, onStreamComplete, null, null, sourceFormat
  );
  const writer = stream.writable.getWriter();
  const readPromise = drain(stream.readable);
  await writer.write(new TextEncoder().encode(sse));
  await writer.close();
  return readPromise;
}

const CLAUDE_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

const OPENAI_CHUNK = 'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n';
const OPENAI_STOP = 'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n';

describe("passthrough stream terminal events", () => {
  it("does not append [DONE] to a Claude stream", async () => {
    const out = await runPassthrough({ sourceFormat: "claude", sse: CLAUDE_SSE });
    expect(out).toContain("event: message_stop");
    expect(out).not.toContain("[DONE]");
  });

  it("aggregates Claude text/thinking for request details", async () => {
    let completed = null;
    await runPassthrough({
      sourceFormat: "claude",
      sse: CLAUDE_SSE,
      onStreamComplete: (content) => { completed = content; },
    });
    expect(completed).toEqual({ content: "Hello", thinking: "" });
  });

  it("does not duplicate [DONE] when the OpenAI upstream already sent one", async () => {
    const out = await runPassthrough({
      sourceFormat: "openai",
      sse: OPENAI_CHUNK + OPENAI_STOP + "data: [DONE]\n\n",
    });
    expect(out.match(/\[DONE\]/g)).toHaveLength(1);
  });

  it("still appends [DONE] for an OpenAI stream that omits it", async () => {
    const out = await runPassthrough({
      sourceFormat: "openai",
      sse: OPENAI_CHUNK + OPENAI_STOP,
    });
    expect(out.match(/\[DONE\]/g)).toHaveLength(1);
  });
});
