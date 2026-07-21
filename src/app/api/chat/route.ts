// src/app/api/chat/route.ts
import { chatRequestSchema, type StepPayload } from "@/lib/chat-types";
import { agentEventsToSSEStream } from "@/lib/sse";
import { route, buildInitialMessage, type AnalysisRequest } from "@/agent/orchestrator";
import { buildPortfolioRunTool } from "@/agent/specialists";
import { runAgent, type ChatMessage } from "@/agent/engine";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/supabase/dal";
import { persistAnalysis } from "@/lib/db/analyses";

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

  const supabase = await createClient();
  const user = await getUser(supabase);

  if (req.mode === "portfolio" && !user) {
    return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const analysisReq: AnalysisRequest = { mode: req.mode, target: req.target ?? "", option: req.option };
  const specialist = route(analysisReq, { userId: user?.id, supabase });
  if (!specialist) {
    return Response.json({ error: `no specialist for ${req.mode}:${req.option}` }, { status: 400 });
  }

  let initial: string;
  try {
    initial = buildInitialMessage(analysisReq);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "invalid target" }, { status: 400 });
  }

  const messages: ChatMessage[] = [{ role: "user", content: initial }];
  const runTool = req.mode === "portfolio" ? buildPortfolioRunTool(specialist) : undefined;
  const events = runAgent(specialist, messages, runTool ? { runTool } : undefined);

  const steps: StepPayload[] = [];
  let answer = "";
  const stream = agentEventsToSSEStream(events, req.threadId, specialist.key, (e) => {
    if (e.event === "step") steps.push(e.data);
    else if (e.event === "token") answer += e.data.text;
    else if (e.event === "done" && user) {
      // Fire-and-forget: a failed save must not turn a successful analysis
      // into a visible error, and must not delay the client's `done` event.
      persistAnalysis(supabase, {
        userId: user.id,
        threadId: req.threadId,
        mode: req.mode,
        target: req.target ?? "",
        option: req.option ?? "",
        steps,
        answer,
      }).catch((err) => {
        console.error("[analyses] persist failed:", err);
      });
    }
  });

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
