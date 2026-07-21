// src/lib/sse.ts
import type { AgentEvent } from "@/agent/engine";
import { MAX_STEP_TEXT_WIRE_CHARS, type ChatEvent } from "./chat-types";

function toChatEvent(e: AgentEvent, threadId: string, specialistKey: string): ChatEvent {
  switch (e.type) {
    case "token":
      return { event: "token", data: { text: e.text } };
    case "action":
      return { event: "step", data: { type: "action", tool: e.tool, text: JSON.stringify(e.args) } };
    case "observation":
      return {
        event: "step",
        data: {
          type: "observation",
          tool: e.tool,
          text: e.result.ok
            ? JSON.stringify(e.result.data).slice(0, MAX_STEP_TEXT_WIRE_CHARS)
            : `오류: ${e.result.error}`,
        },
      };
    case "done":
      return { event: "done", data: { threadId, specialistKey } };
    case "error":
      return { event: "error", data: { message: e.message, retryable: e.retryable } };
    default: {
      const exhaustive: never = e;
      throw new Error(`unhandled AgentEvent type: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function encodeSSE(e: ChatEvent): string {
  return `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
}

// Mirrors the Next.js docs' iteratorToStream pattern (node_modules/next/dist/docs/01-app/02-guides/streaming.md).
export function agentEventsToSSEStream(
  events: AsyncGenerator<AgentEvent>,
  threadId: string,
  specialistKey: string,
  onEvent?: (e: ChatEvent) => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await events.next();
      if (done) {
        controller.close();
        return;
      }
      const chatEvent = toChatEvent(value, threadId, specialistKey);
      onEvent?.(chatEvent);
      controller.enqueue(encoder.encode(encodeSSE(chatEvent)));
    },
    async cancel() {
      await events.return?.(undefined);
    },
  });
}

function parseSSEBlock(block: string): ChatEvent | null {
  const lines = block.split("\n");
  const eventLine = lines.find((l) => l.startsWith("event: "));
  const dataLine = lines.find((l) => l.startsWith("data: "));
  if (!eventLine || !dataLine) return null;
  return {
    event: eventLine.slice("event: ".length),
    data: JSON.parse(dataLine.slice("data: ".length)),
  } as ChatEvent;
}

// Deliberately minimal: we control both ends of this stream, so this is not
// a general SSE client (no retry/id/comment-line support, no EventSource —
// EventSource is GET-only and /api/chat is POST).
export async function* parseSSEStream(res: Response): AsyncGenerator<ChatEvent> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("response has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const event = parseSSEBlock(part);
      if (event) yield event;
    }
  }
}
