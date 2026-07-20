// src/app/api/chat/route.ts
import { chatRequestSchema } from "@/lib/chat-types";
import { agentEventsToSSEStream } from "@/lib/sse";
import { route, buildInitialMessage } from "@/agent/orchestrator";
import { runAgent, type ChatMessage } from "@/agent/engine";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 10;

// ponytail: in-memory, per-instance only — resets on redeploy/restart and
// doesn't share state across serverless instances. Fine for this plan's
// local-only demo posture (spec §10); swap for a shared store (e.g. Upstash
// Redis) before a multi-instance/public deploy.
const requestLog = new Map<string, number[]>();

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (requestLog.get(key) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
    requestLog.set(key, recent);
    return true;
  }
  recent.push(now);
  requestLog.set(key, recent);
  return false;
}

export async function POST(request: Request): Promise<Response> {
  const clientKey = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (isRateLimited(clientKey)) {
    return Response.json(
      { error: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요." },
      { status: 429 },
    );
  }

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
