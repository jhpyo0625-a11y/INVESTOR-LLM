import type { ChatRequest, ChatEvent } from "./chat-types";
import { parseSSEStream } from "./sse";

export async function streamChat(
  req: ChatRequest,
  onEvent: (e: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    onEvent({ event: "error", data: { message: body.error ?? `HTTP ${res.status}`, retryable: false } });
    return;
  }

  for await (const event of parseSSEStream(res)) {
    onEvent(event);
  }
}
