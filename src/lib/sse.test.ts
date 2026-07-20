// src/lib/sse.test.ts
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@/agent/engine";
import { agentEventsToSSEStream, parseSSEStream } from "./sse";

async function* fakeEvents(events: AgentEvent[]) {
  for (const e of events) yield e;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out;
}

describe("agentEventsToSSEStream", () => {
  it("encodes token/action/observation/done as SSE", async () => {
    const stream = agentEventsToSSEStream(
      fakeEvents([
        { type: "token", text: "안" },
        { type: "action", tool: "get_stock_data", args: { ticker: "005930" } },
        { type: "observation", tool: "get_stock_data", result: { ok: true, data: { price: 70000 } } },
        { type: "done" },
      ]),
      "thread-1",
      "company_analysis",
    );
    const text = await readAll(stream);
    expect(text).toContain('event: token\ndata: {"text":"안"}');
    expect(text).toContain('event: step\ndata: {"type":"action","tool":"get_stock_data"');
    expect(text).toContain('event: step\ndata: {"type":"observation","tool":"get_stock_data"');
    expect(text).toContain('event: done\ndata: {"threadId":"thread-1","specialistKey":"company_analysis"}');
  });

  it("encodes error events with the retryable flag", async () => {
    const stream = agentEventsToSSEStream(
      fakeEvents([{ type: "error", message: "boom", retryable: true }]),
      "thread-1",
      "macro",
    );
    const text = await readAll(stream);
    expect(text).toContain('event: error\ndata: {"message":"boom","retryable":true}');
  });

  it("turns a failed observation's error into readable text, not a thrown exception", async () => {
    const stream = agentEventsToSSEStream(
      fakeEvents([{ type: "observation", tool: "search_disclosures", result: { ok: false, error: "DART 020: rate limited" } }]),
      "thread-1",
      "disclosures",
    );
    const text = await readAll(stream);
    expect(text).toContain('event: step\ndata: {"type":"observation","tool":"search_disclosures","text":"오류: DART 020: rate limited"}');
  });
});

describe("parseSSEStream", () => {
  function responseFromChunks(chunks: string[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    return new Response(stream);
  }

  it("parses complete SSE blocks into events", async () => {
    const res = responseFromChunks([
      'event: token\ndata: {"text":"a"}\n\nevent: done\ndata: {"threadId":"t1","specialistKey":"macro"}\n\n',
    ]);
    const events = [];
    for await (const e of parseSSEStream(res)) events.push(e);
    expect(events).toEqual([
      { event: "token", data: { text: "a" } },
      { event: "done", data: { threadId: "t1", specialistKey: "macro" } },
    ]);
  });

  it("reassembles a block split across chunk (network packet) boundaries", async () => {
    const res = responseFromChunks(['event: tok', 'en\ndata: {"text":"hi"}\n\n']);
    const events = [];
    for await (const e of parseSSEStream(res)) events.push(e);
    expect(events).toEqual([{ event: "token", data: { text: "hi" } }]);
  });
});
