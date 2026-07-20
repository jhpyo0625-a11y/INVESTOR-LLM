# Plan 2: Chat UI, SSE Streaming, Landing & Thread Pages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the browser-facing half of INVESTOR-LLM on top of Plan 1's ReAct engine/tools/orchestrator: a Korean-language landing page (company/date input + option cards), a `/api/chat` SSE route that drives `runAgent`, and a thread page that renders the live ReAct timeline and streamed markdown answer with no-blank-screen error handling.

**Architecture:** `LandingForm` (client component) resolves a target + option and navigates to `/t/[threadId]?mode=&target=&option=`. The thread page's `ChatThread` (client component) POSTs that request to `/api/chat`, which validates it, calls the existing `orchestrator.route()` + `buildInitialMessage()` + `runAgent()`, and pipes the resulting `AgentEvent` stream through a small SSE encoder as a `ReadableStream` response. The client parses SSE with a hand-rolled fetch+`ReadableStream` reader (no `EventSource`, since it only supports GET) and renders steps/tokens into `ReactTimeline` and `StreamedAnswer`.

**Tech Stack:** Next.js 16.2.10 (App Router, this plan verified the current route-handler/streaming/dynamic-segment docs in `node_modules/next/dist/docs/01-app/` before writing task code — see Global Constraints) · TypeScript · Tailwind CSS v4 (already configured) · zod v4 · vitest · `react-markdown` + `remark-gfm` (new, justified below).

## Global Constraints

- **Next.js 16 API shapes (verified against `node_modules/next/dist/docs/`, not assumed from training data):**
  - `page.tsx`/`route.ts` dynamic `params` and `searchParams` are **Promises** — always `await` them.
  - `error.tsx` is a Client Component (`"use client"`) with props `{ error: Error & { digest?: string }, unstable_retry: () => void }` (the `v16.2.0`-documented convention; `reset` still exists but `unstable_retry` is the current documented example).
  - `not-found.tsx` takes **no props**.
  - Route Handlers stream via the plain Web `ReadableStream`/`Response` API (`new Response(stream, { headers })`) — this is documented directly under "Streaming in Route Handlers", independent of the Vercel AI SDK.
  - `runtime` route-segment config defaults to `'nodejs'` (needed since the OpenAI SDK / NIM client is not edge-safe) — no explicit `export const runtime` needed.
  - `cacheComponents` is **not** enabled in `next.config.ts` (confirmed by reading the file) — dynamic `params`/`searchParams` access in a Server Component does **not** require a `<Suspense>` boundary in this project. Do not add one; it would be unrequested scope.
  - `unstable_instant` (seen referenced in the streaming/navigation docs) only applies **with Cache Components enabled** — not applicable here, do not add it.
- **SSE wire protocol is this plan's contract** (a deliberate, documented extension of spec §2.2, consistent with Plan 1's documented deviation that streamed tokens *are* the thought — there is no separate `"thought"` step):
  - `event: step` → `{ type: "action" | "observation", tool: string, text: string }`
  - `event: token` → `{ text: string }`
  - `event: done` → `{ threadId: string, specialistKey: string }`
  - `event: error` → `{ message: string, retryable: boolean }`
- **Follow-up chat is explicitly OUT of scope for this plan.** Spec §12's own day-plan puts "follow-up intent routing" in D3, not D2. `ChatThread` renders exactly one analysis run per thread; the follow-up input box is not built here. Do not add an intent classifier or a `mode: "followup"` branch — that's Plan 3.
- **No new test framework.** The project has zero React component tests today (vitest only, no jsdom/@testing-library). Keep it that way: every pure-logic module (types, SSE codec, `chat-client.ts`, route handlers) gets a real vitest unit test written first. Every React component task's "test" step is a **manual dev-server verification** with exact click/type/observe instructions — do not install `@testing-library/react` or `jsdom` to test components.
- **One new dependency pair: `react-markdown` + `remark-gfm`.** Spec §5.2 requires rendering headings and **tables** from the LLM's markdown output. Hand-rolling a GFM-table-correct markdown parser is disproportionate ("two stdlib options, same size, take the one correct on edge cases" doesn't apply here — there is no stdlib option). No other dependency gets added.
- **No `@tailwindcss/typography` plugin.** Markdown styling (headings, tables, lists) is a dozen hand-written CSS rules scoped under `.markdown-answer` in `globals.css`, not a new Tailwind plugin.
- **`src/agent/engine.ts` is untouched by this plan.** It was reviewed end-to-end in Plan 1 (mid-stream error handling fix, `5ae7cb1`) and is the file explained in the Q&A. Plan 2 only consumes `runAgent`/`AgentEvent`/`ChatMessage` as-is.
- **Server-only data never reaches a client bundle.** `src/lib/listings.ts` imports `data/listings.json` (3,924 entries) directly — it must only ever be imported by server code (route handlers, `orchestrator.ts`). Client components that need company search go through `GET /api/listings?q=`, never `import { searchListings } from "@/lib/listings"` directly.
- **Korean UI copy throughout**, matching the spec's locked decision and Plan 1's specialist prompts.
- Disclaimer text is already embedded in every specialist's system prompt (Plan 1) — not this plan's concern.

---

### Task 1: `SpecialistKey` union type (orchestrator/specialists type-safety fix)

Carried-over tech debt from Plan 1's final review: `specialists` and `ROUTES` use loose `Record<string, ...>` typing, so a typo in either table (e.g. `"compnay_analysis"`) fails silently at runtime instead of at compile time. This is Plan 2's foundational task — later tasks (route handler) rely on `specialist.key` being trustworthy.

**Files:**
- Modify: `src/agent/specialists.ts`
- Modify: `src/agent/orchestrator.ts`
- Test: `src/agent/orchestrator.test.ts` (existing file — no new test needed, this task's test step is "still passes")

**Interfaces:**
- Produces: `export const SPECIALIST_KEYS` (readonly tuple of the 6 specialist key strings), `export type SpecialistKey = (typeof SPECIALIST_KEYS)[number]`, both from `src/agent/specialists.ts`. Later tasks import `SpecialistKey` from here when they need it (Task 8's components do not need it directly; it exists for type-safety and for Plan 3's follow-up work to reuse).

- [ ] **Step 1: Run the existing orchestrator tests to record the baseline (must be green before you touch anything)**

Run: `npm test -- orchestrator`
Expected: all tests in `src/agent/orchestrator.test.ts` PASS (this is a refactor task — behavior must not change).

- [ ] **Step 2: Add `SPECIALIST_KEYS`/`SpecialistKey` and type the `specialists` map**

In `src/agent/specialists.ts`, add near the top (after the `COMMON` constant, before the `specialists` export) and change the export's type annotation. The full new top-of-file plus changed export line:

```ts
import type { SpecialistConfig } from "./engine";
import { searchDisclosures, getStockData, getMarketOverview, webSearch } from "@/tools/index";

export const SPECIALIST_KEYS = [
  "company_analysis",
  "broker_view",
  "macro",
  "daily_reports",
  "disclosures",
  "flows",
] as const;

export type SpecialistKey = (typeof SPECIALIST_KEYS)[number];

const DISCLAIMER =
  "답변 마지막에 반드시 다음 문장을 포함하라: '본 분석은 투자 참고용이며, 투자 판단의 책임은 투자자 본인에게 있습니다.'";

const COMMON = `너는 한국 주식시장 전문 애널리스트다. 반드시 한국어로 답한다.
도구로 확보한 실제 데이터만 근거로 쓰고, 데이터 출처(공시/시세/검색)를 본문에 자연스럽게 밝힌다.
확보하지 못한 데이터는 추측하지 말고 "확인 불가"라고 명시한다.
마크다운(제목, 표, 불릿)으로 읽기 쉽게 구성한다. ${DISCLAIMER}`;

export const specialists: Record<SpecialistKey, SpecialistConfig> = {
```

Everything else in the file (the six specialist entries and their closing `};`) is unchanged — only the import block at the top and the `export const specialists: ...` line change. Do not touch any specialist's `systemPrompt` or `tools` array.

- [ ] **Step 3: Type `ROUTES` by its values and simplify `route()`**

In `src/agent/orchestrator.ts`, replace the whole file with:

```ts
import { specialists, type SpecialistKey } from "./specialists";
import type { SpecialistConfig } from "./engine";
import { findByTicker } from "@/lib/listings";

export type AnalysisRequest = {
  mode: "company" | "date";
  target: string; // ticker (6자리) or YYYY-MM-DD
  option: "A" | "B" | "C" | "D";
};

const ROUTES: Record<string, SpecialistKey> = {
  "company:A": "company_analysis",
  "company:B": "broker_view",
  "date:A": "macro",
  "date:B": "daily_reports",
  "date:C": "disclosures",
  "date:D": "flows",
};

export function route(req: AnalysisRequest): SpecialistConfig | undefined {
  const key = ROUTES[`${req.mode}:${req.option}`];
  return key ? specialists[key] : undefined;
}

export function buildInitialMessage(req: AnalysisRequest): string {
  const today = new Date().toISOString().slice(0, 10);
  if (req.mode === "company") {
    const c = findByTicker(req.target);
    if (!c) throw new Error(`unknown ticker: ${req.target}`);
    return `분석 대상 기업: ${c.name} (종목코드 ${c.ticker}, DART corpCode ${c.corpCode}). 오늘 날짜: ${today}. 위 임무에 따라 분석하라.`;
  }
  const compact = req.target.replaceAll("-", "");
  return `기준일: ${req.target} (DART 조회용 표기: ${compact}). 오늘 날짜: ${today}. 위 임무에 따라 분석하라.`;
}
```

(This is the same file with `ROUTES` retyped from `Record<string, string>` to `Record<string, SpecialistKey>` and `route()` rewritten to look up through `specialists[key]` instead of `specialists[ROUTES[...] ?? ""]`. `buildInitialMessage` is byte-for-byte unchanged.)

- [ ] **Step 4: Re-run the tests and typecheck**

Run: `npm test -- orchestrator`
Expected: same tests as Step 1, still PASS, unchanged.

Run: `npx tsc --noEmit`
Expected: no errors. (This is the step that actually proves the fix works — a typo in `ROUTES`' values would now be a compile error.)

- [ ] **Step 5: Commit**

```bash
git add src/agent/specialists.ts src/agent/orchestrator.ts
git commit -m "refactor: type specialists/ROUTES with a SpecialistKey union"
```

---

### Task 2: Chat wire-protocol types + SSE encode/decode

The shared contract between the server route (Task 3) and the browser (Task 5): request validation schema, event types, and the two pure functions that turn an `AgentEvent` stream into SSE bytes and turn an SSE `Response` back into typed events.

**Files:**
- Create: `src/lib/chat-types.ts`
- Create: `src/lib/sse.ts`
- Test: `src/lib/sse.test.ts`

**Interfaces:**
- Consumes: `AgentEvent` from `src/agent/engine.ts` (`{type:"token",text} | {type:"action",tool,args} | {type:"observation",tool,result} | {type:"done"} | {type:"error",message,retryable}`).
- Produces: `chatRequestSchema` (zod) and `type ChatRequest = z.infer<typeof chatRequestSchema>` — `{ mode: "company"|"date", target: string, option: "A"|"B"|"C"|"D", threadId: string }`. `type StepPayload = { type: "action"|"observation", tool: string, text: string }`. `type ChatEvent = {event:"step",data:StepPayload} | {event:"token",data:{text:string}} | {event:"done",data:{threadId:string,specialistKey:string}} | {event:"error",data:{message:string,retryable:boolean}}`. `agentEventsToSSEStream(events: AsyncGenerator<AgentEvent>, threadId: string, specialistKey: string): ReadableStream<Uint8Array>` (used by Task 3). `parseSSEStream(res: Response): AsyncGenerator<ChatEvent>` (used by Task 5).

- [ ] **Step 1: Write `chat-types.ts`**

```ts
// src/lib/chat-types.ts
import { z } from "zod";

export const chatRequestSchema = z.object({
  mode: z.enum(["company", "date"]),
  target: z.string().min(1),
  option: z.enum(["A", "B", "C", "D"]),
  threadId: z.string().min(1),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

export type StepPayload = {
  type: "action" | "observation";
  tool: string;
  text: string;
};

export type ChatEvent =
  | { event: "step"; data: StepPayload }
  | { event: "token"; data: { text: string } }
  | { event: "done"; data: { threadId: string; specialistKey: string } }
  | { event: "error"; data: { message: string; retryable: boolean } };
```

- [ ] **Step 2: Write the failing tests for `sse.ts`**

```ts
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- sse`
Expected: FAIL with "Cannot find module './sse'" (file doesn't exist yet).

- [ ] **Step 4: Write `sse.ts`**

```ts
// src/lib/sse.ts
import type { AgentEvent } from "@/agent/engine";
import type { ChatEvent } from "./chat-types";

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
          text: e.result.ok ? JSON.stringify(e.result.data).slice(0, 500) : `오류: ${e.result.error}`,
        },
      };
    case "done":
      return { event: "done", data: { threadId, specialistKey } };
    case "error":
      return { event: "error", data: { message: e.message, retryable: e.retryable } };
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
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await events.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(encodeSSE(toChatEvent(value, threadId, specialistKey))));
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- sse`
Expected: PASS (all 5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/chat-types.ts src/lib/sse.ts src/lib/sse.test.ts
git commit -m "feat: chat wire-protocol types and SSE encode/decode"
```

---

### Task 3: `POST /api/chat` route handler

**Files:**
- Create: `src/app/api/chat/route.ts`
- Test: `src/app/api/chat/route.test.ts`

**Interfaces:**
- Consumes: `chatRequestSchema` and `agentEventsToSSEStream` (Task 2), `route`/`buildInitialMessage` (Task 1's `orchestrator.ts`), `runAgent`/`ChatMessage` from `src/agent/engine.ts` (Plan 1, unchanged).
- Produces: `export async function POST(request: Request): Promise<Response>` — the only export. Consumed by the browser via `fetch("/api/chat", {method:"POST", ...})` in Task 5.

- [ ] **Step 1: Write the failing tests**

```ts
// src/app/api/chat/route.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/agent/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/agent/engine")>();
  return { ...actual, runAgent: vi.fn() };
});
import { runAgent } from "@/agent/engine";
import { POST } from "./route";

const mockedRunAgent = vi.mocked(runAgent);

beforeEach(() => {
  mockedRunAgent.mockReset();
});

async function* fakeAgent() {
  yield { type: "token" as const, text: "안녕" };
  yield { type: "done" as const };
}

function req(body: unknown): Request {
  return new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify(body) });
}

describe("POST /api/chat", () => {
  it("streams SSE for a valid structured request", async () => {
    mockedRunAgent.mockReturnValue(fakeAgent());
    const res = await POST(req({ mode: "company", target: "005930", option: "A", threadId: "t1" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain('event: token\ndata: {"text":"안녕"}');
    expect(text).toContain('event: done\ndata: {"threadId":"t1","specialistKey":"company_analysis"}');
  });

  it("400s on a malformed body without calling the agent", async () => {
    const res = await POST(req({ mode: "company" }));
    expect(res.status).toBe(400);
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });

  it("400s on an unknown mode:option combination", async () => {
    const res = await POST(req({ mode: "company", target: "005930", option: "C", threadId: "t1" }));
    expect(res.status).toBe(400);
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });

  it("400s on an unknown ticker", async () => {
    const res = await POST(req({ mode: "company", target: "000000", option: "A", threadId: "t1" }));
    expect(res.status).toBe(400);
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- api/chat`
Expected: FAIL with "Cannot find module './route'" (file doesn't exist yet).

- [ ] **Step 3: Write `route.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- api/chat`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/chat/route.ts src/app/api/chat/route.test.ts
git commit -m "feat: POST /api/chat SSE route"
```

---

### Task 4: `GET /api/listings` route handler (company autocomplete)

Exists so client components can search companies without bundling `data/listings.json` (3,924 entries) into client JS — see Global Constraints.

**Files:**
- Create: `src/app/api/listings/route.ts`
- Test: `src/app/api/listings/route.test.ts`

**Interfaces:**
- Consumes: `searchListings` from `src/lib/listings.ts` (Plan 1, unchanged) — `searchListings(q: string, limit?: number): Listing[]` where `Listing = { name: string; ticker: string; corpCode: string }`.
- Produces: `export async function GET(request: Request): Promise<Response>`, returning `Listing[]` as JSON. Consumed by `LandingForm` (Task 7) via `fetch("/api/listings?q=...")`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/app/api/listings/route.test.ts
import { describe, expect, it } from "vitest";
import { GET } from "./route";

function req(q: string): Request {
  return new Request(`http://localhost/api/listings?q=${encodeURIComponent(q)}`);
}

describe("GET /api/listings", () => {
  it("returns matching listings for a query", async () => {
    const res = await GET(req("삼성전자"));
    const data = await res.json();
    expect(data.some((c: { ticker: string }) => c.ticker === "005930")).toBe(true);
  });

  it("returns an empty array for a blank query", async () => {
    const res = await GET(req(""));
    expect(await res.json()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- api/listings`
Expected: FAIL with "Cannot find module './route'".

- [ ] **Step 3: Write `route.ts`**

```ts
// src/app/api/listings/route.ts
import { searchListings } from "@/lib/listings";

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q") ?? "";
  return Response.json(searchListings(q));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- api/listings`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/listings/route.ts src/app/api/listings/route.test.ts
git commit -m "feat: GET /api/listings company autocomplete route"
```

---

### Task 5: `streamChat` client helper

The only piece of client-side networking logic, kept as plain TS (no React) so it's fully unit-testable.

**Files:**
- Create: `src/lib/chat-client.ts`
- Test: `src/lib/chat-client.test.ts`

**Interfaces:**
- Consumes: `ChatRequest`, `ChatEvent` (Task 2's `chat-types.ts`), `parseSSEStream` (Task 2's `sse.ts`).
- Produces: `export async function streamChat(req: ChatRequest, onEvent: (e: ChatEvent) => void, signal?: AbortSignal): Promise<void>`. Consumed by `ChatThread` (Task 8).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/chat-client.test.ts
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
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- chat-client`
Expected: FAIL with "Cannot find module './chat-client'".

- [ ] **Step 3: Write `chat-client.ts`**

```ts
// src/lib/chat-client.ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- chat-client`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/chat-client.ts src/lib/chat-client.test.ts
git commit -m "feat: streamChat client helper for SSE fetch"
```

---

### Task 6: Root error and not-found boundaries

Implements spec §5.4's "nothing ever renders blank" contract at the app-wide level, using the Next 16 `error.tsx` prop shape confirmed in Global Constraints.

**Files:**
- Create: `src/app/error.tsx`
- Create: `src/app/not-found.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing consumed by later tasks — this is a leaf, app-wide convention.

- [ ] **Step 1: Write `error.tsx`**

```tsx
// src/app/error.tsx
"use client";

export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <h2 className="text-xl font-semibold">문제가 발생했습니다</h2>
      <p className="text-sm text-zinc-500">{error.message || "알 수 없는 오류가 발생했습니다."}</p>
      <div className="flex gap-3">
        <button
          onClick={() => unstable_retry()}
          className="rounded-full bg-black px-5 py-2 text-sm font-medium text-white dark:bg-white dark:text-black"
        >
          다시 시도
        </button>
        <a href="/" className="rounded-full border px-5 py-2 text-sm font-medium">
          홈으로
        </a>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write `not-found.tsx`**

```tsx
// src/app/not-found.tsx
import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <h2 className="text-xl font-semibold">페이지를 찾을 수 없습니다</h2>
      <Link
        href="/"
        className="rounded-full bg-black px-5 py-2 text-sm font-medium text-white dark:bg-white dark:text-black"
      >
        홈으로
      </Link>
    </div>
  );
}
```

- [ ] **Step 3: Manually verify both boundaries in the browser**

Run: `npm run dev`, then:
1. Visit `http://localhost:3000/does-not-exist` → expect the "페이지를 찾을 수 없습니다" card with a working "홈으로" link back to `/`.
2. Temporarily add `throw new Error("test error boundary")` as the first line inside `src/app/page.tsx`'s default export function, reload `http://localhost:3000/` → expect the "문제가 발생했습니다" card showing "test error boundary" with a working "다시 시도" button (click it — the error clears and the page attempts to re-render). **Remove the temporary `throw` line before continuing** (Task 7 rewrites this file anyway, but don't leave it broken in the meantime).

- [ ] **Step 4: Commit**

```bash
git add src/app/error.tsx src/app/not-found.tsx
git commit -m "feat: root error and not-found boundaries"
```

---

### Task 7: Landing page — mode toggle, company/date input, option cards

**Files:**
- Modify: `src/app/page.tsx` (replace the create-next-app placeholder entirely)
- Modify: `src/app/layout.tsx:15-18` (metadata)
- Modify: `package.json:2` (`"name"`)
- Create: `src/components/LandingForm.tsx`

**Interfaces:**
- Consumes: `GET /api/listings?q=` (Task 4), `Listing` type from `@/lib/listings` (type-only import — safe, erased at compile time, does **not** pull `data/listings.json` into the client bundle).
- Produces: navigates the browser to `/t/[threadId]?mode=&target=&option=`, the URL contract Task 8's thread page reads.

- [ ] **Step 1: Fix `package.json`'s leftover scaffold name**

In `package.json`, change:
```json
  "name": "temp-next-app",
```
to:
```json
  "name": "investor-llm",
```

- [ ] **Step 2: Fix the page metadata**

In `src/app/layout.tsx`, replace:
```ts
export const metadata: Metadata = {
  title: "Create Next App",
  description: "Generated by create next app",
};
```
with:
```ts
export const metadata: Metadata = {
  title: "INVESTOR-LLM",
  description: "AI 기반 국내 투자 정보 서비스",
};
```

- [ ] **Step 3: Write `LandingForm.tsx`**

```tsx
// src/components/LandingForm.tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Listing } from "@/lib/listings";

const TODAY = new Date();
const MIN_DATE = new Date(TODAY);
MIN_DATE.setDate(MIN_DATE.getDate() - 30);
const toISODate = (d: Date) => d.toISOString().slice(0, 10);

const COMPANY_OPTIONS = [
  { option: "A" as const, label: "기업 분석 리포트" },
  { option: "B" as const, label: "증권사/애널리스트 시각" },
];
const DATE_OPTIONS = [
  { option: "A" as const, label: "거시경제 핵심 이슈" },
  { option: "B" as const, label: "일일 리포트 요약" },
  { option: "C" as const, label: "주요 공시 리뷰" },
  { option: "D" as const, label: "수급/섹터 동향" },
];

export function LandingForm() {
  const router = useRouter();
  const [mode, setMode] = useState<"company" | "date">("company");
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Listing[]>([]);
  const [selected, setSelected] = useState<Listing | null>(null);
  const [date, setDate] = useState("");

  useEffect(() => {
    if (mode !== "company" || !query.trim() || selected) {
      setSuggestions([]);
      return;
    }
    const controller = new AbortController();
    fetch(`/api/listings?q=${encodeURIComponent(query)}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data: Listing[]) => setSuggestions(data))
      .catch(() => {});
    return () => controller.abort();
  }, [mode, query, selected]);

  const target = mode === "company" ? selected?.ticker : date;
  const options = mode === "company" ? COMPANY_OPTIONS : DATE_OPTIONS;

  function selectOption(option: "A" | "B" | "C" | "D") {
    if (!target) return;
    const threadId = crypto.randomUUID();
    const params = new URLSearchParams({ mode, target, option });
    router.push(`/t/${threadId}?${params}`);
  }

  return (
    <div className="flex w-full max-w-xl flex-col gap-6">
      <div className="flex gap-2 rounded-full border p-1">
        <button
          type="button"
          onClick={() => {
            setMode("company");
            setSelected(null);
            setDate("");
          }}
          className={`flex-1 rounded-full py-2 text-sm font-medium ${mode === "company" ? "bg-black text-white dark:bg-white dark:text-black" : ""}`}
        >
          기업
        </button>
        <button
          type="button"
          onClick={() => {
            setMode("date");
            setSelected(null);
            setQuery("");
          }}
          className={`flex-1 rounded-full py-2 text-sm font-medium ${mode === "date" ? "bg-black text-white dark:bg-white dark:text-black" : ""}`}
        >
          날짜
        </button>
      </div>

      {mode === "company" ? (
        <div className="relative">
          <input
            value={selected ? `${selected.name} (${selected.ticker})` : query}
            onChange={(e) => {
              setSelected(null);
              setQuery(e.target.value);
            }}
            placeholder="기업명 또는 종목코드 검색"
            className="w-full rounded-lg border px-4 py-3 text-sm"
          />
          {suggestions.length > 0 && (
            <ul className="absolute z-10 mt-1 w-full rounded-lg border bg-white shadow-lg dark:bg-black">
              {suggestions.map((c) => (
                <li key={c.ticker}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(c);
                      setQuery("");
                      setSuggestions([]);
                    }}
                    className="block w-full px-4 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900"
                  >
                    {c.name} ({c.ticker})
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <input
            type="date"
            value={date}
            min={toISODate(MIN_DATE)}
            max={toISODate(TODAY)}
            onChange={(e) => setDate(e.target.value)}
            className="w-full rounded-lg border px-4 py-3 text-sm"
          />
          <p className="text-xs text-zinc-500">최근 30일 이내만 지원됩니다.</p>
        </div>
      )}

      {target && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {options.map((o) => (
            <button
              key={o.option}
              type="button"
              onClick={() => selectOption(o.option)}
              className="rounded-lg border p-4 text-left text-sm font-medium hover:border-black dark:hover:border-white"
            >
              {o.option}. {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Rewrite `page.tsx`**

```tsx
// src/app/page.tsx
import { LandingForm } from "@/components/LandingForm";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-10 px-6 py-20">
      <div className="flex flex-col items-center gap-3 text-center">
        <h1 className="text-3xl font-bold tracking-tight">INVESTOR-LLM</h1>
        <p className="text-sm text-zinc-500">기업 또는 날짜를 입력하고 분석 옵션을 선택하세요.</p>
      </div>
      <LandingForm />
    </main>
  );
}
```

- [ ] **Step 5: Manually verify in the browser**

Run: `npm run dev`, visit `http://localhost:3000/`:
1. Default mode is "기업" — type "삼성" → a dropdown with 삼성전자 (and others matching "삼성") appears within ~1s.
2. Click 삼성전자 → the input shows "삼성전자 (005930)", the dropdown closes, and two option cards appear ("A. 기업 분석 리포트", "B. 증권사/애널리스트 시각").
3. Click "날짜" toggle → the input switches to a native date picker; typing/selecting a company is cleared.
4. Pick a date within the last 30 days → four option cards appear (A–D).
5. Try to pick a date older than 30 days or in the future via the date input — the native picker should refuse it (`min`/`max` enforced by the browser).
6. Click any option card → browser navigates to `/t/<uuid>?mode=...&target=...&option=...` (this will currently show nothing useful yet — Task 8 builds the thread page — confirm only that the URL and query params are correct).

- [ ] **Step 6: Commit**

```bash
git add package.json src/app/layout.tsx src/app/page.tsx src/components/LandingForm.tsx
git commit -m "feat: landing page with company/date input and option cards"
```

---

### Task 8: Thread page — ReAct timeline + streamed markdown answer

**Files:**
- Create: `src/app/t/[threadId]/page.tsx`
- Create: `src/components/ChatThread.tsx`
- Create: `src/components/ReactTimeline.tsx`
- Create: `src/components/StreamedAnswer.tsx`
- Modify: `src/app/globals.css` (append markdown styling)
- Modify: `package.json` (add `react-markdown`, `remark-gfm`)

**Interfaces:**
- Consumes: `streamChat` (Task 5), `ChatEvent`/`StepPayload` (Task 2), the `/t/[threadId]?mode=&target=&option=` URL contract produced by Task 7.

- [ ] **Step 1: Install the two new dependencies**

Run: `npm install react-markdown remark-gfm`
Expected: `package.json` gains two entries under `"dependencies"`.

- [ ] **Step 2: Append markdown styling to `globals.css`**

Add to the end of `src/app/globals.css`:

```css

.markdown-answer h1,
.markdown-answer h2,
.markdown-answer h3 {
  font-weight: 600;
  margin-top: 1.25em;
  margin-bottom: 0.5em;
}
.markdown-answer p {
  margin-bottom: 0.75em;
  line-height: 1.7;
}
.markdown-answer ul,
.markdown-answer ol {
  margin: 0.5em 0 0.75em 1.25em;
}
.markdown-answer table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.75em 0;
  font-size: 0.875rem;
}
.markdown-answer th,
.markdown-answer td {
  border: 1px solid var(--foreground);
  padding: 0.4em 0.6em;
  opacity: 0.9;
}
```

- [ ] **Step 3: Write `StreamedAnswer.tsx`**

```tsx
// src/components/StreamedAnswer.tsx
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function StreamedAnswer({ text }: { text: string }) {
  return (
    <article className="markdown-answer text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </article>
  );
}
```

- [ ] **Step 4: Write `ReactTimeline.tsx`**

```tsx
// src/components/ReactTimeline.tsx
"use client";

import { useEffect, useState } from "react";
import type { StepPayload } from "@/lib/chat-types";

const ICON: Record<StepPayload["type"], string> = { action: "🔧", observation: "👁" };

export function ReactTimeline({ steps, collapsed }: { steps: StepPayload[]; collapsed: boolean }) {
  const [open, setOpen] = useState(true);
  const [autoCollapsed, setAutoCollapsed] = useState(false);

  useEffect(() => {
    if (collapsed && !autoCollapsed) {
      setOpen(false);
      setAutoCollapsed(true);
    }
  }, [collapsed, autoCollapsed]);

  if (steps.length === 0) return null;

  return (
    <div className="rounded-lg border text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2 font-medium"
      >
        <span>진행 과정 ({steps.length})</span>
        <span>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <ul className="flex flex-col gap-2 border-t px-4 py-3">
          {steps.map((s, i) => (
            <li key={i} className="flex gap-2">
              <span>{ICON[s.type]}</span>
              <span className="flex flex-col">
                <span className="font-medium">{s.tool}</span>
                <span className="break-all text-zinc-500">{s.text.slice(0, 300)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Write `ChatThread.tsx`**

```tsx
// src/components/ChatThread.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { streamChat } from "@/lib/chat-client";
import type { ChatEvent, StepPayload } from "@/lib/chat-types";
import { ReactTimeline } from "./ReactTimeline";
import { StreamedAnswer } from "./StreamedAnswer";

type Status = "loading" | "streaming" | "done" | "error";
type Initial = { mode: "company" | "date"; target: string; option: "A" | "B" | "C" | "D" };

export function ChatThread({ threadId, initial }: { threadId: string; initial: Initial }) {
  const [status, setStatus] = useState<Status>("loading");
  const [steps, setSteps] = useState<StepPayload[]>([]);
  const [answer, setAnswer] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [retryable, setRetryable] = useState(true);
  const runId = useRef(0);

  function run() {
    const id = ++runId.current;
    setStatus("streaming");
    setSteps([]);
    setAnswer("");
    setErrorMessage("");
    const controller = new AbortController();

    streamChat(
      { ...initial, threadId },
      (event: ChatEvent) => {
        if (id !== runId.current) return;
        if (event.event === "step") setSteps((prev) => [...prev, event.data]);
        else if (event.event === "token") setAnswer((prev) => prev + event.data.text);
        else if (event.event === "done") setStatus("done");
        else if (event.event === "error") {
          setStatus("error");
          setErrorMessage(event.data.message);
          setRetryable(event.data.retryable);
        }
      },
      controller.signal,
    ).catch((e) => {
      if (id !== runId.current) return;
      setStatus("error");
      setErrorMessage(e instanceof Error ? e.message : "스트리밍 중 오류가 발생했습니다.");
      setRetryable(true);
    });

    return () => controller.abort();
  }

  useEffect(() => {
    if (!initial.target) {
      setStatus("error");
      setErrorMessage("잘못된 요청입니다. 처음부터 다시 시도해주세요.");
      setRetryable(false);
      return;
    }
    // initial is derived once from the URL's search params; threadId alone identifies a distinct run.
    return run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-6">
      <header className="text-sm text-zinc-500">
        {initial.mode === "company" ? `종목코드 ${initial.target}` : initial.target}
      </header>

      {status === "loading" && <p className="animate-pulse text-sm text-zinc-500">분석 준비 중…</p>}

      <ReactTimeline steps={steps} collapsed={status === "done" || answer.length > 0} />

      {answer && <StreamedAnswer text={answer} />}

      {status === "error" && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          <p>{errorMessage}</p>
          {retryable && (
            <button onClick={run} className="mt-2 rounded-full bg-red-600 px-4 py-1 text-xs font-medium text-white">
              재시도
            </button>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Write the thread page**

```tsx
// src/app/t/[threadId]/page.tsx
import { ChatThread } from "@/components/ChatThread";

export default async function ThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{ threadId: string }>;
  searchParams: Promise<{ mode?: string; target?: string; option?: string }>;
}) {
  const { threadId } = await params;
  const sp = await searchParams;
  const mode = sp.mode === "date" ? "date" : "company";
  const option = (["A", "B", "C", "D"].includes(sp.option ?? "") ? sp.option : "A") as
    | "A"
    | "B"
    | "C"
    | "D";
  const target = sp.target ?? "";

  return (
    <main className="flex flex-1 flex-col">
      <ChatThread threadId={threadId} initial={{ mode, target, option }} />
    </main>
  );
}
```

- [ ] **Step 7: Manually verify the full flow in the browser**

Run: `npm run dev` (make sure `.env.local` has real `NVIDIA_API_KEY`/`DART_API_KEY`/`TAVILY_API_KEY` — this hits real APIs, same as `scripts/smoke.ts`).

1. From `/`, search "삼성전자" → select it → click "A. 기업 분석 리포트".
2. On `/t/<uuid>?mode=company&target=005930&option=A`: expect "분석 준비 중…" briefly, then a "진행 과정 (N)" panel that grows live with 🔧/👁 rows as `get_stock_data`/`search_disclosures`/`web_search` are called (open the browser Network tab and confirm the `/api/chat` request's response streams in multiple chunks over several seconds, not all at once).
3. Once the model starts answering, confirm the "진행 과정" panel auto-collapses and a markdown report streams in below it, token by token, with headings and at least one table rendered with visible borders.
4. Click "진행 과정" to re-expand it — confirm it still shows the full step list.
5. From `/`, switch to "날짜", pick yesterday's date, click "C. 주요 공시 리뷰" → confirm a DisclosureAnalyst-style run streams similarly.
6. Force an error path: temporarily rename `NVIDIA_API_KEY` to `NVIDIA_API_KEY_X` in `.env.local`, restart `npm run dev`, repeat step 1 → expect the red error card (not a blank screen) with a working "재시도" button. **Restore `NVIDIA_API_KEY` afterward.**

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/app/globals.css src/components/StreamedAnswer.tsx src/components/ReactTimeline.tsx src/components/ChatThread.tsx src/app/t/[threadId]/page.tsx
git commit -m "feat: thread page with live ReAct timeline and streamed markdown answer"
```

---

### Task 9: End-to-end regression gate

Closes the plan out: full suite, typecheck, and production build all green, plus one more manual pass on the exact spec §13 demo path this plan covers.

**Files:** none created or modified — verification only.

- [ ] **Step 1: Full automated suite**

Run: `npm test`
Expected: every test file passes, including all new ones from Tasks 1–5 (orchestrator, sse, api/chat route, api/listings route, chat-client) alongside every Plan 1 test.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: build succeeds. Since `cacheComponents` is off, this is a standard dynamic-rendering build — confirm the build output lists `/`, `/t/[threadId]`, `/api/chat`, and `/api/listings` and does not print any "blocking route" or Suspense-boundary error (those only fire with Cache Components, but confirm anyway since this is the first build since Plan 1).

- [ ] **Step 4: Manual demo-path rehearsal**

Run: `npm run build && npm run start`, then repeat Task 8 Step 7's items 1–5 against the production build (not `next dev`) — this is closer to what spec §10 describes for the actual demo ("Demo runs `next build && next start` locally"). Confirm streaming still arrives progressively (check the Network tab's timing, not just that the final content appears) — production mode compresses responses more aggressively and is the more realistic test of whether chunked delivery survives.

- [ ] **Step 5: Update the progress ledger**

Append to `.superpowers/sdd/progress.md`:
```
Plan 2 (chat UI + SSE + landing/thread pages): Tasks 1-9 complete.
```

No commit needed for this step if `.superpowers/` is git-ignored (check with `git check-ignore .superpowers/sdd/progress.md`); if it's tracked, commit it with `git commit -m "docs: log Plan 2 completion in progress ledger"`.
