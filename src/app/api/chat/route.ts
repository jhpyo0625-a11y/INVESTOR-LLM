// src/app/api/chat/route.ts
import { chatRequestSchema } from "@/lib/chat-types";
import { agentEventsToSSEStream } from "@/lib/sse";
import { route, buildInitialMessage } from "@/agent/orchestrator";
import { runAgent, type ChatMessage } from "@/agent/engine";

export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null);
  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }
  const req = parsed.data;

  const specialist = route(req);
  if (!specialist) {
    return Response.json({ error: `no specialist for ${req.mode}:${req.option}` }, { status: 400 });
  }

  let initial: string;
  try {
    initial = buildInitialMessage(req);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "invalid target" }, { status: 400 });
  }

  const messages: ChatMessage[] = [{ role: "user", content: initial }];
  const events = runAgent(specialist, messages);
  const stream = agentEventsToSSEStream(events, req.threadId, specialist.key);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// Vercel Hobby limit (spec §10); the ReAct loop is capped at 6 iterations so it stays well under this.
export const maxDuration = 60;
