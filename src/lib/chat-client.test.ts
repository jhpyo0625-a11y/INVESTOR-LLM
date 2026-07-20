import { describe, expect, it, vi, beforeEach } from "vitest";
import { streamChat } from "./chat-client";

beforeEach(() => {
  vi.restoreAllMocks();
});

function sseResponse(body: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

describe("streamChat", () => {
  it("POSTs the request body and yields parsed SSE events", async () => {
    const res = sseResponse(
      'event: token\ndata: {"text":"hi"}\n\nevent: done\ndata: {"threadId":"t1","specialistKey":"macro"}\n\n',
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));

    const events: unknown[] = [];
    await streamChat({ mode: "date", target: "2026-07-17", option: "A", threadId: "t1" }, (e) => events.push(e));

    expect(fetch).toHaveBeenCalledWith(
      "/api/chat",
      expect.objectContaining({ method: "POST", body: expect.stringContaining('"threadId":"t1"') }),
    );
    expect(events).toEqual([
      { event: "token", data: { text: "hi" } },
      { event: "done", data: { threadId: "t1", specialistKey: "macro" } },
    ]);
  });

  it("emits a synthetic error event on a non-OK HTTP response instead of throwing", async () => {
    const res = new Response(JSON.stringify({ error: "no specialist" }), { status: 400 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));

    const events: unknown[] = [];
    await streamChat({ mode: "date", target: "2026-07-17", option: "A", threadId: "t1" }, (e) => events.push(e));

    expect(events).toEqual([{ event: "error", data: { message: "no specialist", retryable: false } }]);
  });

  it("emits a synthetic error event with retryable:true when fetch rejects (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    const events: unknown[] = [];
    await streamChat({ mode: "date", target: "2026-07-17", option: "A", threadId: "t1" }, (e) => events.push(e));

    expect(events).toEqual([{ event: "error", data: { message: "network error", retryable: true } }]);
  });
});
