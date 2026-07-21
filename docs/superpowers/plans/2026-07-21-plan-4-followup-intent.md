# Plan 4 — Follow-up Intent Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Task 1 is manual and must be executed by the human, not dispatched to a subagent** — it requires running SQL against the live Supabase project and is a breaking migration (drops columns with live data). Pause and hand it to the user; resume subagent dispatch at Task 2.

**Goal:** Add free-text follow-up to any chat thread (company, date, portfolio) — one cheap LLM call classifies the follow-up to a specialist constrained to the thread's mode-family, answers using full conversation history, and persists every turn for logged-in users.

**Architecture:** `analyses` table gains a `turns` jsonb array (one row per thread, not per turn) plus `updated_at` for activity-ordering. `engine.ts`'s `runAgent` already accepts arbitrary multi-turn history — zero engine changes. `/api/chat` gains a `followup` branch: forced tool-call classification, history reconstruction from client-supplied prior turns, same SSE streaming as today. Guests get the full follow-up experience ephemerally (React state only); logged-in users get it persisted via `appendTurn` (read-modify-write, same posture as Plan 3's holdings mutations).

**Tech Stack:** No new dependencies — same Next.js 16 / zod / vitest / `@supabase/ssr` stack as Plans 1–3.

## Global Constraints

- No new test framework — vitest only, no jsdom/@testing-library. DOM-rendering gaps accepted (Plan 1–3 precedent): extract logic into plain, testable functions; JSX wiring verified by manual/live testing only.
- `mode` always describes the thread's identity (`"company"|"date"|"portfolio"`), never the request type. `followup`'s presence on the wire is the discriminator between "start a thread" and "continue a thread" — this field is orthogonal to `mode`/`target`/`option`, which stay required exactly as today.
- Follow-up intent classification is constrained to the thread's original mode-family: company threads only ever switch between `company_analysis`/`broker_view`; date threads only among the 4 date specialists; portfolio threads always stay `portfolio`.
- Classifier failures (API error, timeout, malformed/missing tool call) must fall back silently to the client-supplied `currentSpecialistKey` — never surfaced as a user-visible error.
- Follow-up must work for guests (ephemeral, no persistence), matching how the base analysis already works for guests. Only portfolio-mode threads require login (unchanged from Plan 3).
- Full design rationale: `docs/superpowers/specs/2026-07-21-plan-4-followup-intent-design.md`.

---

### Task 1: Manual DB migration (human-executed, not a subagent task)

**Files:** none (external dashboard).

**⚠️ Destructive migration:** this drops `analyses.steps` and `analyses.answer`, replacing them with a `turns` jsonb array. Any existing saved analyses lose their old steps/answer data (not backfilled — accepted at this app's pre-launch/demo scale per the design spec §2.1). Confirm you're fine losing existing `analyses` rows' content before running this.

- [ ] **Step 1: Run the migration**

In the Supabase dashboard → SQL Editor → New query, paste and run:

```sql
alter table analyses drop column steps;
alter table analyses drop column answer;
alter table analyses add column turns jsonb not null default '[]';
alter table analyses add column updated_at timestamptz not null default now();
```

- [ ] **Step 2: Verify the schema**

In the SQL Editor, run `select column_name, data_type from information_schema.columns where table_name = 'analyses';` and confirm the result includes `turns` (jsonb) and `updated_at` (timestamp with time zone), and no longer includes `steps`/`answer`.

Tell whoever resumes the plan that this is done — Task 2 onward can proceed (its automated tests mock Supabase and don't need the live project; only the final live-browser verification pass, at the end of the plan, needs it).

---

### Task 2: Extend `chatRequestSchema` with `followup`

**Files:**
- Modify: `src/lib/chat-types.ts`
- Modify: `src/lib/chat-types.test.ts`

**Interfaces:**
- Produces: `chatRequestSchema` now accepts an optional `followup: { text: string; currentSpecialistKey: SpecialistKeyName; turns: { question: string | null; answer: string }[] }` field. `SpecialistKeyName` (new export) is a zod-derived union of the 7 specialist keys. Consumed by Task 7 (`/api/chat`), Task 8 (`ChatThread.tsx`).

- [ ] **Step 1: Write the failing tests**

Edit `src/lib/chat-types.test.ts`, append after the existing `describe("chatRequestSchema", ...)` block:

```ts
describe("chatRequestSchema followup", () => {
  const base = { mode: "company", target: "005930", option: "A", threadId: "t1" } as const;

  it("accepts a valid followup payload", () => {
    const result = chatRequestSchema.safeParse({
      ...base,
      followup: {
        text: "외국인은 왜 팔았어?",
        currentSpecialistKey: "company_analysis",
        turns: [{ question: null, answer: "첫 답변" }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a followup with empty text", () => {
    const result = chatRequestSchema.safeParse({
      ...base,
      followup: { text: "", currentSpecialistKey: "company_analysis", turns: [] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a followup with an invalid currentSpecialistKey", () => {
    const result = chatRequestSchema.safeParse({
      ...base,
      followup: { text: "질문", currentSpecialistKey: "not_a_specialist", turns: [] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a followup turn missing answer", () => {
    const result = chatRequestSchema.safeParse({
      ...base,
      followup: { text: "질문", currentSpecialistKey: "company_analysis", turns: [{ question: null }] },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a request with no followup field, same as before", () => {
    expect(chatRequestSchema.safeParse(base).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- chat-types.test.ts`
Expected: FAIL — `followup` is not a recognized field yet (the 4 new "followup" tests fail; existing tests still pass).

- [ ] **Step 3: Update the schema**

Edit `src/lib/chat-types.ts`, replace the top of the file (everything before `export type ChatRequest`):

```ts
// src/lib/chat-types.ts
import { z } from "zod";

// ponytail: mirrors SPECIALIST_KEYS in src/agent/specialists.ts — duplicated
// (not imported) so this lib-level file has no dependency on the agent
// layer. Keep both lists in sync if a specialist is added or removed.
const specialistKeySchema = z.enum([
  "company_analysis",
  "broker_view",
  "macro",
  "daily_reports",
  "disclosures",
  "flows",
  "portfolio",
]);

export type SpecialistKeyName = z.infer<typeof specialistKeySchema>;

const followupSchema = z.object({
  text: z.string().min(1),
  currentSpecialistKey: specialistKeySchema,
  turns: z.array(
    z.object({
      question: z.string().min(1).nullable(),
      answer: z.string(),
    }),
  ),
});

export const chatRequestSchema = z
  .object({
    mode: z.enum(["company", "date", "portfolio"]),
    target: z.string().min(1).optional(),
    option: z.enum(["A", "B", "C", "D"]).optional(),
    threadId: z.string().min(1),
    followup: followupSchema.optional(),
  })
  .refine((v) => v.mode === "portfolio" || v.target !== undefined, {
    message: "target is required for mode:company/date",
    path: ["target"],
  })
  .refine((v) => v.mode === "portfolio" || v.option !== undefined, {
    message: "option is required for mode:company/date",
    path: ["option"],
  })
  .refine((v) => v.mode !== "date" || (v.target !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(v.target)), {
    message: "target must be YYYY-MM-DD for mode:date",
    path: ["target"],
  });
```

The rest of the file (`export type ChatRequest`, `MAX_STEP_TEXT_WIRE_CHARS`, `MAX_STEP_TEXT_DISPLAY_CHARS`, `StepPayload`, `ChatEvent`) stays unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- chat-types.test.ts`
Expected: PASS (12/12 — 7 existing + 5 new).

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/chat-types.ts src/lib/chat-types.test.ts
git commit -m "feat: add followup field to chatRequestSchema"
```

---

### Task 3: Mode-family helpers in `orchestrator.ts`

**Files:**
- Modify: `src/agent/orchestrator.ts`
- Modify: `src/agent/orchestrator.test.ts`

**Interfaces:**
- Produces: `specialistFamily(mode: AnalysisRequest["mode"]): readonly SpecialistKey[]` and `resolveSpecialist(key: SpecialistKey, ctx?: { userId?: string; supabase?: SupabaseClient }): SpecialistConfig | undefined`. Both consumed by Task 7 (`/api/chat`). `route()` and `buildInitialMessage()` are unchanged.

- [ ] **Step 1: Write the failing tests**

Edit `src/agent/orchestrator.test.ts`, append at the end of the file (before the final closing, i.e. add new `describe` blocks after the existing one):

```ts
describe("specialistFamily", () => {
  it("returns the two company specialists for mode:company", () => {
    expect(specialistFamily("company")).toEqual(["company_analysis", "broker_view"]);
  });

  it("returns the four date specialists for mode:date", () => {
    expect(specialistFamily("date")).toEqual(["macro", "daily_reports", "disclosures", "flows"]);
  });

  it("returns just portfolio for mode:portfolio", () => {
    expect(specialistFamily("portfolio")).toEqual(["portfolio"]);
  });
});

describe("resolveSpecialist", () => {
  it("resolves a static specialist by key", () => {
    expect(resolveSpecialist("broker_view")?.key).toBe("broker_view");
  });

  it("resolves the portfolio specialist when userId and supabase are given", () => {
    const fakeSupabase = {} as never;
    expect(resolveSpecialist("portfolio", { userId: "u1", supabase: fakeSupabase })?.key).toBe("portfolio");
  });

  it("returns undefined for portfolio without a userId/supabase", () => {
    expect(resolveSpecialist("portfolio")).toBeUndefined();
  });
});
```

Also update the import line at the top of the file:

```ts
import { route, buildInitialMessage, specialistFamily, resolveSpecialist } from "./orchestrator";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- orchestrator.test.ts`
Expected: FAIL — `./orchestrator` has no export `specialistFamily`/`resolveSpecialist`.

- [ ] **Step 3: Implement the helpers**

Edit `src/agent/orchestrator.ts`, add at the end of the file (after `buildInitialMessage`):

```ts
export function specialistFamily(mode: AnalysisRequest["mode"]): readonly SpecialistKey[] {
  if (mode === "company") return ["company_analysis", "broker_view"];
  if (mode === "date") return ["macro", "daily_reports", "disclosures", "flows"];
  return ["portfolio"];
}

export function resolveSpecialist(
  key: SpecialistKey,
  ctx?: { userId?: string; supabase?: SupabaseClient },
): SpecialistConfig | undefined {
  if (key === "portfolio") {
    return ctx?.userId && ctx?.supabase ? buildPortfolioSpecialist(ctx.userId, ctx.supabase) : undefined;
  }
  return specialists[key];
}
```

No new imports needed — `specialists`, `buildPortfolioSpecialist`, `SpecialistKey`, and `SupabaseClient` are already imported at the top of `orchestrator.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- orchestrator.test.ts`
Expected: PASS (17/17 — 11 existing + 6 new).

- [ ] **Step 5: Commit**

```bash
git add src/agent/orchestrator.ts src/agent/orchestrator.test.ts
git commit -m "feat: add specialistFamily and resolveSpecialist helpers"
```

---

### Task 4: Intent classifier

**Files:**
- Create: `src/agent/intent-classifier.ts`
- Test: `src/agent/intent-classifier.test.ts`

**Interfaces:**
- Consumes: `MODEL` from `./nim` (existing), `SpecialistKey` from `./specialists` (existing).
- Produces: `classifyIntent(client: OpenAI, input: { validKeys: readonly SpecialistKey[]; currentSpecialistKey: SpecialistKey; text: string }): Promise<SpecialistKey>` — used by Task 7 (`/api/chat`).

- [ ] **Step 1: Write the failing tests**

Create `src/agent/intent-classifier.test.ts`:

```ts
// src/agent/intent-classifier.test.ts
import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { classifyIntent } from "./intent-classifier";

function fakeClient(response: unknown) {
  const create = vi.fn().mockResolvedValue(response);
  const client = { chat: { completions: { create } } } as unknown as OpenAI;
  return { client, create };
}

function toolCallResponse(specialist: string) {
  return {
    choices: [
      {
        message: {
          tool_calls: [{ function: { name: "classify_intent", arguments: JSON.stringify({ specialist }) } }],
        },
      },
    ],
  };
}

describe("classifyIntent", () => {
  it("returns the only valid key without calling the model", async () => {
    const { client, create } = fakeClient(toolCallResponse("portfolio"));
    const result = await classifyIntent(client, { validKeys: ["portfolio"], currentSpecialistKey: "portfolio", text: "아무 질문" });
    expect(result).toBe("portfolio");
    expect(create).not.toHaveBeenCalled();
  });

  it("returns the model's chosen specialist when valid", async () => {
    const { client } = fakeClient(toolCallResponse("broker_view"));
    const result = await classifyIntent(client, {
      validKeys: ["company_analysis", "broker_view"],
      currentSpecialistKey: "company_analysis",
      text: "목표주가는 얼마야?",
    });
    expect(result).toBe("broker_view");
  });

  it("forces tool_choice to classify_intent with the family's enum", async () => {
    const { client, create } = fakeClient(toolCallResponse("flows"));
    await classifyIntent(client, {
      validKeys: ["macro", "daily_reports", "disclosures", "flows"],
      currentSpecialistKey: "macro",
      text: "외국인 수급 어땠어?",
    });
    const call = create.mock.calls[0][0];
    expect(call.tool_choice).toEqual({ type: "function", function: { name: "classify_intent" } });
    expect(call.tools[0].function.name).toBe("classify_intent");
  });

  it("falls back to currentSpecialistKey when the API call throws", async () => {
    const { client } = fakeClient(null);
    vi.mocked(client.chat.completions.create).mockRejectedValue(new Error("boom"));
    const result = await classifyIntent(client, {
      validKeys: ["company_analysis", "broker_view"],
      currentSpecialistKey: "company_analysis",
      text: "아무 질문",
    });
    expect(result).toBe("company_analysis");
  });

  it("falls back to currentSpecialistKey when no tool call is returned", async () => {
    const { client } = fakeClient({ choices: [{ message: {} }] });
    const result = await classifyIntent(client, {
      validKeys: ["company_analysis", "broker_view"],
      currentSpecialistKey: "company_analysis",
      text: "아무 질문",
    });
    expect(result).toBe("company_analysis");
  });

  it("falls back to currentSpecialistKey when the model returns an invalid specialist", async () => {
    const { client } = fakeClient(toolCallResponse("not_a_real_specialist"));
    const result = await classifyIntent(client, {
      validKeys: ["company_analysis", "broker_view"],
      currentSpecialistKey: "company_analysis",
      text: "아무 질문",
    });
    expect(result).toBe("company_analysis");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- intent-classifier.test.ts`
Expected: FAIL — `./intent-classifier` module not found.

- [ ] **Step 3: Implement it**

Create `src/agent/intent-classifier.ts`:

```ts
// src/agent/intent-classifier.ts
import { z } from "zod";
import type OpenAI from "openai";
import { MODEL } from "./nim";
import type { SpecialistKey } from "./specialists";

export async function classifyIntent(
  client: OpenAI,
  input: { validKeys: readonly SpecialistKey[]; currentSpecialistKey: SpecialistKey; text: string },
): Promise<SpecialistKey> {
  if (input.validKeys.length <= 1) return input.currentSpecialistKey;

  const schema = z.object({ specialist: z.enum(input.validKeys as [SpecialistKey, ...SpecialistKey[]]) });
  const tool = {
    type: "function" as const,
    function: {
      name: "classify_intent",
      description: "사용자의 후속 질문을 아래 전문가 중 하나로 분류한다.",
      parameters: z.toJSONSchema(schema),
    },
  };

  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0,
      stream: false,
      messages: [
        {
          role: "system",
          content: `사용자의 후속 질문을 다음 전문가 중 하나로 분류하라: ${input.validKeys.join(", ")}. 확신이 없으면 "${input.currentSpecialistKey}"를 선택하라.`,
        },
        { role: "user", content: input.text },
      ],
      tools: [tool],
      tool_choice: { type: "function", function: { name: "classify_intent" } },
    });

    const call = completion.choices[0]?.message.tool_calls?.[0];
    if (!call) return input.currentSpecialistKey;
    const parsed = schema.safeParse(JSON.parse(call.function.arguments));
    return parsed.success ? parsed.data.specialist : input.currentSpecialistKey;
  } catch {
    return input.currentSpecialistKey;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- intent-classifier.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add src/agent/intent-classifier.ts src/agent/intent-classifier.test.ts
git commit -m "feat: add intent classifier for follow-up routing"
```

---

### Task 5: `analyses.ts` — multi-turn storage

**Files:**
- Modify: `src/lib/db/test-helpers.ts`
- Modify: `src/lib/db/analyses.ts`
- Modify: `src/lib/db/analyses.test.ts`

**Interfaces:**
- Produces: `Turn = { question: string | null; answer: string; steps: StepPayload[]; specialistKey: string; createdAt: string }`, `SavedAnalysis = { id, threadId, mode, target, option, turns: Turn[], updatedAt }`, `appendTurn(supabase, input: { userId, threadId, mode, target, option, turn: Turn }): Promise<void>`. `getAnalysisByThreadId`/`listRecentAnalyses` keep their existing signatures, updated return shape. `fakeSupabaseClientSequence` (new test helper) — used only by this task's tests. Consumed by Task 7 (`/api/chat`), Task 9 (`ThreadPage`), Task 10 (`Sidebar`/`/history`).

- [ ] **Step 1: Add the sequencing test helper**

Edit `src/lib/db/test-helpers.ts`, add at the end of the file:

```ts
// For functions that make multiple sequential `.from()` calls (e.g.
// appendTurn's read-then-write), each call consumes the next chain in
// order; the last chain repeats if more calls happen than chains given.
export function fakeSupabaseClientSequence(chains: unknown[]): SupabaseClient {
  let i = 0;
  return {
    from: () => {
      const chain = chains[Math.min(i, chains.length - 1)];
      i += 1;
      return chain;
    },
  } as unknown as SupabaseClient;
}
```

- [ ] **Step 2: Write the failing tests**

Replace the entire contents of `src/lib/db/analyses.test.ts`:

```ts
// src/lib/db/analyses.test.ts
import { describe, expect, it } from "vitest";
import { fakeSupabaseChain, fakeSupabaseClient, fakeSupabaseClientSequence } from "./test-helpers";
import { appendTurn, getAnalysisByThreadId, listRecentAnalyses } from "./analyses";
import type { Turn } from "./analyses";

const turn1: Turn = {
  question: null,
  answer: "요약입니다",
  steps: [{ type: "action", tool: "get_stock_data", text: "{}" }],
  specialistKey: "company_analysis",
  createdAt: "2026-07-20T00:00:00Z",
};

const row = {
  id: "a1",
  thread_id: "t1",
  mode: "company",
  target: "005930",
  option: "A",
  turns: [turn1],
  updated_at: "2026-07-20T00:00:00Z",
};

describe("analyses data layer", () => {
  it("gets a saved analysis by thread id", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: row, error: null }));
    const result = await getAnalysisByThreadId(client, "u1", "t1");
    expect(result?.threadId).toBe("t1");
    expect(result?.turns).toEqual([turn1]);
  });

  it("returns null when no saved analysis exists for the thread", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: null, error: null }));
    const result = await getAnalysisByThreadId(client, "u1", "unknown-thread");
    expect(result).toBeNull();
  });

  it("throws with the Supabase error message on a read failure", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: null, error: { message: "boom" } }));
    await expect(getAnalysisByThreadId(client, "u1", "t1")).rejects.toThrow("boom");
  });

  it("lists recent analyses newest-updated first", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: [row], error: null }));
    const result = await listRecentAnalyses(client, "u1");
    expect(result).toHaveLength(1);
    expect(result[0].updatedAt).toBe("2026-07-20T00:00:00Z");
  });

  it("appendTurn inserts a new row when no analysis exists for the thread", async () => {
    const client = fakeSupabaseClientSequence([
      fakeSupabaseChain({ data: null, error: null }), // getAnalysisByThreadId: no existing row
      fakeSupabaseChain({ data: null, error: null }), // insert
    ]);
    await expect(
      appendTurn(client, { userId: "u1", threadId: "t1", mode: "company", target: "005930", option: "A", turn: turn1 }),
    ).resolves.toBeUndefined();
  });

  it("appendTurn updates the existing row's turns when a row already exists", async () => {
    const turn2: Turn = { ...turn1, question: "외국인은 왜 팔았어?", specialistKey: "flows" };
    const client = fakeSupabaseClientSequence([
      fakeSupabaseChain({ data: row, error: null }), // getAnalysisByThreadId: existing row
      fakeSupabaseChain({ data: null, error: null }), // update
    ]);
    await expect(
      appendTurn(client, { userId: "u1", threadId: "t1", mode: "company", target: "005930", option: "A", turn: turn2 }),
    ).resolves.toBeUndefined();
  });

  it("appendTurn propagates the read error", async () => {
    const client = fakeSupabaseClientSequence([fakeSupabaseChain({ data: null, error: { message: "boom" } })]);
    await expect(
      appendTurn(client, { userId: "u1", threadId: "t1", mode: "company", target: "005930", option: "A", turn: turn1 }),
    ).rejects.toThrow("boom");
  });

  it("appendTurn propagates the insert error", async () => {
    const client = fakeSupabaseClientSequence([
      fakeSupabaseChain({ data: null, error: null }),
      fakeSupabaseChain({ data: null, error: { message: "insert boom" } }),
    ]);
    await expect(
      appendTurn(client, { userId: "u1", threadId: "t1", mode: "company", target: "005930", option: "A", turn: turn1 }),
    ).rejects.toThrow("insert boom");
  });

  it("appendTurn propagates the update error", async () => {
    const client = fakeSupabaseClientSequence([
      fakeSupabaseChain({ data: row, error: null }),
      fakeSupabaseChain({ data: null, error: { message: "update boom" } }),
    ]);
    await expect(
      appendTurn(client, { userId: "u1", threadId: "t1", mode: "company", target: "005930", option: "A", turn: turn1 }),
    ).rejects.toThrow("update boom");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- analyses.test.ts`
Expected: FAIL — `./analyses` has no export `appendTurn`/`Turn`; `persistAnalysis` (old export) is gone from the test file, `getAnalysisByThreadId`/`listRecentAnalyses` still return the old `steps`/`answer` shape.

- [ ] **Step 4: Replace `analyses.ts`**

Replace the entire contents of `src/lib/db/analyses.ts`:

```ts
// src/lib/db/analyses.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StepPayload } from "@/lib/chat-types";

export type Turn = {
  question: string | null;
  answer: string;
  steps: StepPayload[];
  specialistKey: string;
  createdAt: string;
};

export type SavedAnalysis = {
  id: string;
  threadId: string;
  mode: string;
  target: string;
  option: string;
  turns: Turn[];
  updatedAt: string;
};

type AnalysisRow = {
  id: string;
  thread_id: string;
  mode: string;
  target: string;
  option: string;
  turns: Turn[];
  updated_at: string;
};

function toSavedAnalysis(r: AnalysisRow): SavedAnalysis {
  return {
    id: r.id,
    threadId: r.thread_id,
    mode: r.mode,
    target: r.target,
    option: r.option,
    turns: r.turns,
    updatedAt: r.updated_at,
  };
}

export async function getAnalysisByThreadId(
  supabase: SupabaseClient,
  userId: string,
  threadId: string,
): Promise<SavedAnalysis | null> {
  const { data, error } = await supabase
    .from("analyses")
    .select("id, thread_id, mode, target, option, turns, updated_at")
    .eq("user_id", userId)
    .eq("thread_id", threadId)
    .maybeSingle();
  if (error) throw new Error(`getAnalysisByThreadId: ${error.message}`);
  return data ? toSavedAnalysis(data as AnalysisRow) : null;
}

export async function listRecentAnalyses(supabase: SupabaseClient, userId: string, limit = 5): Promise<SavedAnalysis[]> {
  const { data, error } = await supabase
    .from("analyses")
    .select("id, thread_id, mode, target, option, turns, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listRecentAnalyses: ${error.message}`);
  return (data ?? []).map(toSavedAnalysis);
}

export async function appendTurn(
  supabase: SupabaseClient,
  input: { userId: string; threadId: string; mode: string; target: string; option: string; turn: Turn },
): Promise<void> {
  const existing = await getAnalysisByThreadId(supabase, input.userId, input.threadId);

  if (!existing) {
    const { error } = await supabase.from("analyses").insert({
      user_id: input.userId,
      thread_id: input.threadId,
      mode: input.mode,
      target: input.target,
      option: input.option,
      turns: [input.turn],
    });
    if (error) throw new Error(`appendTurn: ${error.message}`);
    return;
  }

  const { error } = await supabase
    .from("analyses")
    .update({ turns: [...existing.turns, input.turn], updated_at: new Date().toISOString() })
    .eq("user_id", input.userId)
    .eq("thread_id", input.threadId);
  if (error) throw new Error(`appendTurn: ${error.message}`);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- analyses.test.ts`
Expected: PASS (8/8).

- [ ] **Step 6: Run the full suite to check for regressions**

Run: `npm test`
Expected: other test files that import from `analyses.ts` (none yet — Task 7 is next) still pass; overall suite may show pre-existing failures in `src/app/api/chat/route.test.ts` and `src/components`-adjacent files only if they already referenced the old `persistAnalysis`/`steps`/`answer` shape — that's expected and fixed in Task 7.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db/test-helpers.ts src/lib/db/analyses.ts src/lib/db/analyses.test.ts
git commit -m "feat: rework analyses data layer for multi-turn storage"
```

---

### Task 6: Follow-up wire-payload mapping

**Files:**
- Create: `src/lib/chat-followup.ts`
- Test: `src/lib/chat-followup.test.ts`

**Interfaces:**
- Produces: `buildFollowupTurns(turns: { question: string | null; answer: string }[]): { question: string | null; answer: string }[]` — used by Task 8 (`ChatThread.tsx`) to map its richer internal turn state down to the wire shape.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/chat-followup.test.ts`:

```ts
// src/lib/chat-followup.test.ts
import { describe, expect, it } from "vitest";
import { buildFollowupTurns } from "./chat-followup";

describe("buildFollowupTurns", () => {
  it("returns an empty array for no prior turns", () => {
    expect(buildFollowupTurns([])).toEqual([]);
  });

  it("maps question/answer pairs in order", () => {
    const result = buildFollowupTurns([
      { question: null, answer: "첫 답변" },
      { question: "후속 질문 1", answer: "두 번째 답변" },
    ]);
    expect(result).toEqual([
      { question: null, answer: "첫 답변" },
      { question: "후속 질문 1", answer: "두 번째 답변" },
    ]);
  });

  it("strips extra fields, keeping only question and answer", () => {
    const result = buildFollowupTurns([
      { question: null, answer: "답변", steps: [{ type: "action", tool: "x", text: "y" }], status: "done" } as never,
    ]);
    expect(result).toEqual([{ question: null, answer: "답변" }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- chat-followup.test.ts`
Expected: FAIL — `./chat-followup` module not found.

- [ ] **Step 3: Implement it**

Create `src/lib/chat-followup.ts`:

```ts
// src/lib/chat-followup.ts
export type TurnLike = { question: string | null; answer: string };

export function buildFollowupTurns(turns: TurnLike[]): { question: string | null; answer: string }[] {
  return turns.map((t) => ({ question: t.question, answer: t.answer }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- chat-followup.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/lib/chat-followup.ts src/lib/chat-followup.test.ts
git commit -m "feat: add follow-up turns wire-payload mapping"
```

---

### Task 7: Wire follow-up into `/api/chat`

**Files:**
- Modify: `src/app/api/chat/route.ts`
- Modify: `src/app/api/chat/route.test.ts`

**Interfaces:**
- Consumes: `specialistFamily`, `resolveSpecialist` (Task 3), `classifyIntent` (Task 4), `appendTurn` (Task 5).
- Produces: no new exports — `POST` handler now branches on `req.followup`.

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `src/app/api/chat/route.test.ts`:

```ts
// src/app/api/chat/route.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/agent/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/agent/engine")>();
  return { ...actual, runAgent: vi.fn() };
});
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/dal", () => ({ getUser: vi.fn() }));
vi.mock("@/lib/db/analyses", () => ({ appendTurn: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/agent/nim", () => ({ nimClient: vi.fn(() => ({})), MODEL: "test-model" }));
vi.mock("@/agent/intent-classifier", () => ({ classifyIntent: vi.fn() }));
import { runAgent } from "@/agent/engine";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/supabase/dal";
import { appendTurn } from "@/lib/db/analyses";
import { classifyIntent } from "@/agent/intent-classifier";
import { POST } from "./route";

const mockedRunAgent = vi.mocked(runAgent);
const mockedCreateClient = vi.mocked(createClient);
const mockedGetUser = vi.mocked(getUser);
const mockedAppendTurn = vi.mocked(appendTurn);
const mockedClassifyIntent = vi.mocked(classifyIntent);

beforeEach(() => {
  mockedRunAgent.mockReset();
  mockedCreateClient.mockResolvedValue({} as never);
  mockedGetUser.mockResolvedValue(null);
  mockedAppendTurn.mockClear();
  mockedClassifyIntent.mockReset();
  mockedClassifyIntent.mockResolvedValue("company_analysis");
});

async function* fakeAgent() {
  yield { type: "token" as const, text: "안녕" };
  yield { type: "done" as const };
}

function req(body: unknown, headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    body: JSON.stringify(body),
    headers,
  });
}

// Each test uses its own X-Forwarded-For so the shared in-memory rate
// limiter (keyed by client IP) doesn't let tests interfere with each other.
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.0.0.${ipCounter}`;
}

describe("POST /api/chat", () => {
  it("streams SSE for a valid structured request", async () => {
    mockedRunAgent.mockReturnValue(fakeAgent());
    const res = await POST(req({ mode: "company", target: "005930", option: "A", threadId: "t1" }, { "x-forwarded-for": nextIp() }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain('event: token\ndata: {"text":"안녕"}');
    expect(text).toContain('event: done\ndata: {"threadId":"t1","specialistKey":"company_analysis"}');
  });

  it("400s on a malformed body without calling the agent", async () => {
    const res = await POST(req({ mode: "company" }, { "x-forwarded-for": nextIp() }));
    expect(res.status).toBe(400);
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });

  it("400s on a non-JSON request body without calling the agent", async () => {
    const res = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        body: "not json",
        headers: { "x-forwarded-for": nextIp() },
      }),
    );
    expect(res.status).toBe(400);
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });

  it("400s on an unknown mode:option combination", async () => {
    const res = await POST(req({ mode: "company", target: "005930", option: "C", threadId: "t1" }, { "x-forwarded-for": nextIp() }));
    expect(res.status).toBe(400);
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });

  it("400s on an unknown ticker", async () => {
    const res = await POST(req({ mode: "company", target: "000000", option: "A", threadId: "t1" }, { "x-forwarded-for": nextIp() }));
    expect(res.status).toBe(400);
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });

  it("400s on a malformed date target without calling the agent", async () => {
    const res = await POST(
      req({ mode: "date", target: "not-a-date", option: "A", threadId: "t1" }, { "x-forwarded-for": nextIp() }),
    );
    expect(res.status).toBe(400);
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });

  it("429s after exceeding the per-IP rate limit, without calling the agent", async () => {
    mockedRunAgent.mockImplementation(() => fakeAgent());
    const ip = nextIp();
    const body = { mode: "company", target: "005930", option: "A", threadId: "t1" };
    for (let i = 0; i < 10; i++) {
      const res = await POST(req(body, { "x-forwarded-for": ip }));
      expect(res.status).toBe(200);
      await res.text(); // drain the stream so the request is fully "complete"
    }
    mockedRunAgent.mockClear();
    const res = await POST(req(body, { "x-forwarded-for": ip }));
    expect(res.status).toBe(429);
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });

  it("401s on mode:portfolio for a guest, without calling the agent", async () => {
    const res = await POST(req({ mode: "portfolio", threadId: "t1" }, { "x-forwarded-for": nextIp() }));
    expect(res.status).toBe(401);
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });

  it("streams SSE for mode:portfolio when logged in", async () => {
    mockedGetUser.mockResolvedValue({ id: "u1" } as never);
    mockedRunAgent.mockReturnValue(fakeAgent());
    const res = await POST(req({ mode: "portfolio", threadId: "t1" }, { "x-forwarded-for": nextIp() }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: done\ndata: {"threadId":"t1","specialistKey":"portfolio"}');
  });

  it("persists the analysis on done when the user is logged in", async () => {
    mockedGetUser.mockResolvedValue({ id: "u1" } as never);
    mockedRunAgent.mockReturnValue(fakeAgent());
    const res = await POST(req({ mode: "company", target: "005930", option: "A", threadId: "t1" }, { "x-forwarded-for": nextIp() }));
    await res.text();
    expect(mockedAppendTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: "u1",
        threadId: "t1",
        mode: "company",
        turn: expect.objectContaining({ question: null, answer: "안녕", specialistKey: "company_analysis" }),
      }),
    );
  });

  it("does not persist the analysis for a guest", async () => {
    mockedGetUser.mockResolvedValue(null);
    mockedRunAgent.mockReturnValue(fakeAgent());
    const res = await POST(req({ mode: "company", target: "005930", option: "A", threadId: "t1" }, { "x-forwarded-for": nextIp() }));
    await res.text();
    expect(mockedAppendTurn).not.toHaveBeenCalled();
  });

  it("classifies and streams a followup on a company thread, reconstructing history", async () => {
    mockedClassifyIntent.mockResolvedValue("broker_view");
    mockedRunAgent.mockReturnValue(fakeAgent());
    const res = await POST(
      req(
        {
          mode: "company",
          target: "005930",
          option: "A",
          threadId: "t1",
          followup: {
            text: "목표주가는 얼마야?",
            currentSpecialistKey: "company_analysis",
            turns: [{ question: null, answer: "첫 답변" }],
          },
        },
        { "x-forwarded-for": nextIp() },
      ),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"specialistKey":"broker_view"');
    const history = mockedRunAgent.mock.calls[0][1];
    expect(history).toEqual([
      { role: "user", content: expect.stringContaining("005930") },
      { role: "assistant", content: "첫 답변" },
      { role: "user", content: "목표주가는 얼마야?" },
    ]);
  });

  it("persists the followup turn with the question and chosen specialist", async () => {
    mockedGetUser.mockResolvedValue({ id: "u1" } as never);
    mockedClassifyIntent.mockResolvedValue("broker_view");
    mockedRunAgent.mockReturnValue(fakeAgent());
    const res = await POST(
      req(
        {
          mode: "company",
          target: "005930",
          option: "A",
          threadId: "t1",
          followup: {
            text: "목표주가는 얼마야?",
            currentSpecialistKey: "company_analysis",
            turns: [{ question: null, answer: "첫 답변" }],
          },
        },
        { "x-forwarded-for": nextIp() },
      ),
    );
    await res.text();
    expect(mockedAppendTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        turn: expect.objectContaining({ question: "목표주가는 얼마야?", specialistKey: "broker_view", answer: "안녕" }),
      }),
    );
  });

  it("does not persist a followup for a guest", async () => {
    mockedGetUser.mockResolvedValue(null);
    mockedClassifyIntent.mockResolvedValue("broker_view");
    mockedRunAgent.mockReturnValue(fakeAgent());
    const res = await POST(
      req(
        {
          mode: "company",
          target: "005930",
          option: "A",
          threadId: "t1",
          followup: { text: "질문", currentSpecialistKey: "company_analysis", turns: [] },
        },
        { "x-forwarded-for": nextIp() },
      ),
    );
    await res.text();
    expect(res.status).toBe(200);
    expect(mockedAppendTurn).not.toHaveBeenCalled();
  });

  it("401s on a portfolio followup for a guest", async () => {
    const res = await POST(
      req(
        { mode: "portfolio", threadId: "t1", followup: { text: "질문", currentSpecialistKey: "portfolio", turns: [] } },
        { "x-forwarded-for": nextIp() },
      ),
    );
    expect(res.status).toBe(401);
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- route.test.ts`
Expected: FAIL — `persistAnalysis` import removed from the mock, but `route.ts` still calls it; followup tests fail since `route.ts` doesn't understand `followup` yet.

- [ ] **Step 3: Replace `route.ts`**

Replace the entire contents of `src/app/api/chat/route.ts`:

```ts
// src/app/api/chat/route.ts
import { chatRequestSchema, type StepPayload } from "@/lib/chat-types";
import { agentEventsToSSEStream } from "@/lib/sse";
import {
  route,
  buildInitialMessage,
  resolveSpecialist,
  specialistFamily,
  type AnalysisRequest,
} from "@/agent/orchestrator";
import { buildPortfolioRunTool } from "@/agent/specialists";
import { runAgent, type ChatMessage, type SpecialistConfig } from "@/agent/engine";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/supabase/dal";
import { appendTurn } from "@/lib/db/analyses";
import { classifyIntent } from "@/agent/intent-classifier";
import { nimClient } from "@/agent/nim";

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

  let initial: string;
  try {
    initial = buildInitialMessage(analysisReq);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "invalid target" }, { status: 400 });
  }

  let specialist: SpecialistConfig | undefined;
  let history: ChatMessage[];

  if (req.followup) {
    const family = specialistFamily(req.mode);
    const fallbackKey = family.includes(req.followup.currentSpecialistKey)
      ? req.followup.currentSpecialistKey
      : family[0];
    const chosenKey = await classifyIntent(nimClient(), {
      validKeys: family,
      currentSpecialistKey: fallbackKey,
      text: req.followup.text,
    });
    specialist = resolveSpecialist(chosenKey, { userId: user?.id, supabase });
    history = [];
    for (const t of req.followup.turns) {
      history.push({ role: "user", content: t.question ?? initial });
      history.push({ role: "assistant", content: t.answer });
    }
    history.push({ role: "user", content: req.followup.text });
  } else {
    specialist = route(analysisReq, { userId: user?.id, supabase });
    history = [{ role: "user", content: initial }];
  }

  if (!specialist) {
    return Response.json({ error: `no specialist for ${req.mode}:${req.option}` }, { status: 400 });
  }
  const specialistKey = specialist.key;

  const runTool = req.mode === "portfolio" ? buildPortfolioRunTool(specialist) : undefined;
  const events = runAgent(specialist, history, runTool ? { runTool } : undefined);

  const steps: StepPayload[] = [];
  let answer = "";
  const stream = agentEventsToSSEStream(events, req.threadId, specialistKey, (e) => {
    if (e.event === "step") steps.push(e.data);
    else if (e.event === "token") answer += e.data.text;
    else if (e.event === "done" && user) {
      // Fire-and-forget: a failed save must not turn a successful analysis
      // into a visible error, and must not delay the client's `done` event.
      appendTurn(supabase, {
        userId: user.id,
        threadId: req.threadId,
        mode: req.mode,
        target: req.target ?? "",
        option: req.option ?? "",
        turn: {
          question: req.followup ? req.followup.text : null,
          answer,
          steps,
          specialistKey,
          createdAt: new Date().toISOString(),
        },
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- route.test.ts`
Expected: PASS (16/16 — 11 existing + 5 new).

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests pass except any in `src/components`/`src/app` that still reference the old `ChatThread` props (`initialData`) — fixed in Task 8/9.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/chat/route.ts src/app/api/chat/route.test.ts
git commit -m "feat: wire follow-up intent classification into /api/chat"
```

---

### Task 8: Multi-turn `ChatThread.tsx`

**Files:**
- Modify: `src/components/ChatThread.tsx`

**Interfaces:**
- Consumes: `buildFollowupTurns` (Task 6), `SpecialistKeyName` (Task 2).
- Produces: `<ChatThread>` now accepts `initialTurns?: { question: string | null; answer: string; steps: StepPayload[]; specialistKey: string }[]` instead of `initialData`. Consumed by Task 9 (`ThreadPage`).

No automated test — DOM-rendering gap accepted per Plan 1–3 precedent (no jsdom/@testing-library). Verified by Task 8's manual smoke check below and Task 11's live verification.

- [ ] **Step 1: Replace `ChatThread.tsx`**

Replace the entire contents of `src/components/ChatThread.tsx`:

```tsx
// src/components/ChatThread.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { streamChat } from "@/lib/chat-client";
import type { ChatEvent, ChatRequest, SpecialistKeyName, StepPayload } from "@/lib/chat-types";
import { findByTicker } from "@/lib/listings";
import { buildFollowupTurns } from "@/lib/chat-followup";
import { ReactTimeline } from "./ReactTimeline";
import { StreamedAnswer } from "./StreamedAnswer";

type TurnStatus = "loading" | "streaming" | "done" | "error";
type Initial = { mode: "company" | "date" | "portfolio"; target?: string; option?: "A" | "B" | "C" | "D" };

type TurnState = {
  question: string | null;
  steps: StepPayload[];
  answer: string;
  status: TurnStatus;
  errorMessage: string;
  retryable: boolean;
};

function newTurn(question: string | null): TurnState {
  return { question, steps: [], answer: "", status: "loading", errorMessage: "", retryable: true };
}

export function ChatThread({
  threadId,
  initial,
  initialTurns,
  initialStarred = false,
}: {
  threadId: string;
  initial: Initial;
  initialTurns?: { question: string | null; answer: string; steps: StepPayload[]; specialistKey: string }[];
  initialStarred?: boolean;
}) {
  const [turns, setTurns] = useState<TurnState[]>(() =>
    initialTurns && initialTurns.length > 0
      ? initialTurns.map((t) => ({
          question: t.question,
          steps: t.steps,
          answer: t.answer,
          status: "done" as const,
          errorMessage: "",
          retryable: true,
        }))
      : [newTurn(null)],
  );
  const [specialistKey, setSpecialistKey] = useState<string>(
    initialTurns && initialTurns.length > 0 ? initialTurns[initialTurns.length - 1].specialistKey : "",
  );
  const [followupText, setFollowupText] = useState("");
  const runIdRef = useRef(0);
  const router = useRouter();
  const [starred, setStarred] = useState(initialStarred);
  const [starError, setStarError] = useState(false);

  function updateTurn(index: number, patch: Partial<TurnState> | ((t: TurnState) => TurnState)) {
    setTurns((prev) => {
      const next = [...prev];
      next[index] = typeof patch === "function" ? patch(next[index]) : { ...next[index], ...patch };
      return next;
    });
  }

  async function toggleStar() {
    if (initial.mode !== "company" || !initial.target) return;
    const nextStarred = !starred;
    setStarred(nextStarred);
    setStarError(false);
    try {
      const res = nextStarred
        ? await fetch("/api/watchlist", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ticker: initial.target, name: findByTicker(initial.target)?.name ?? initial.target }),
          })
        : await fetch(`/api/watchlist?ticker=${initial.target}`, { method: "DELETE" });

      if (res.status === 401) {
        setStarred(false);
        router.push("/?auth=required");
        return;
      }
      if (!res.ok) {
        setStarred(!nextStarred);
        setStarError(true);
      }
    } catch {
      setStarred(!nextStarred);
      setStarError(true);
    }
  }

  function runTurn(index: number, question: string | null, priorTurns: TurnState[]): () => void {
    const id = ++runIdRef.current;
    updateTurn(index, { status: "streaming", steps: [], answer: "", errorMessage: "" });
    const controller = new AbortController();

    const payload: ChatRequest = question
      ? {
          mode: initial.mode,
          target: initial.target,
          option: initial.option,
          threadId,
          followup: {
            text: question,
            currentSpecialistKey: specialistKey as SpecialistKeyName,
            turns: buildFollowupTurns(priorTurns),
          },
        }
      : { mode: initial.mode, target: initial.target, option: initial.option, threadId };

    streamChat(
      payload,
      (event: ChatEvent) => {
        if (id !== runIdRef.current) return;
        if (event.event === "step") updateTurn(index, (t) => ({ ...t, steps: [...t.steps, event.data] }));
        else if (event.event === "token") updateTurn(index, (t) => ({ ...t, answer: t.answer + event.data.text }));
        else if (event.event === "done") {
          setSpecialistKey(event.data.specialistKey);
          updateTurn(index, { status: "done" });
        } else if (event.event === "error") {
          updateTurn(index, { status: "error", errorMessage: event.data.message, retryable: event.data.retryable });
        }
      },
      controller.signal,
    ).catch((e) => {
      // Defensive backstop: streamChat catches its own failures and always
      // resolves via onEvent, so this should be unreachable today — kept in
      // case that contract ever regresses.
      if (id !== runIdRef.current) return;
      updateTurn(index, {
        status: "error",
        errorMessage: e instanceof Error ? e.message : "스트리밍 중 오류가 발생했습니다.",
        retryable: true,
      });
    });

    return () => controller.abort();
  }

  function submitFollowup() {
    const text = followupText.trim();
    if (!text) return;
    const priorTurns = turns;
    setFollowupText("");
    setTurns((prev) => [...prev, newTurn(text)]);
    runTurn(priorTurns.length, text, priorTurns);
  }

  useEffect(() => {
    if (initialTurns && initialTurns.length > 0) return; // replay mode: nothing to stream, already rendered
    if (initial.mode !== "portfolio" && !initial.target) {
      updateTurn(0, { status: "error", errorMessage: "잘못된 요청입니다. 처음부터 다시 시도해주세요.", retryable: false });
      return;
    }
    // initial is derived once from the URL's search params; threadId alone identifies a distinct run.
    return runTurn(0, null, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  const lastTurn = turns[turns.length - 1];

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6">
      <header className="flex items-center justify-between text-sm text-zinc-500">
        <span>
          {initial.mode === "company" && `종목코드 ${initial.target}`}
          {initial.mode === "date" && initial.target}
          {initial.mode === "portfolio" && "내 포트폴리오 분석"}
        </span>
        {initial.mode === "company" && (
          <button type="button" onClick={toggleStar} aria-label="watchlist" className="text-lg">
            {starred ? "★" : "☆"}
          </button>
        )}
      </header>
      {starError && <p className="text-xs text-red-600">관심종목 저장에 실패했습니다.</p>}

      {turns.map((t, i) => (
        <div key={i} className="flex flex-col gap-4">
          {t.question && (
            <p className="self-end rounded-2xl bg-zinc-100 px-4 py-2 text-sm dark:bg-zinc-800">{t.question}</p>
          )}
          {t.status === "loading" && <p className="animate-pulse text-sm text-zinc-500">분석 준비 중…</p>}
          <ReactTimeline steps={t.steps} collapsed={t.status === "done" || t.answer.length > 0} />
          {t.answer && <StreamedAnswer text={t.answer} />}
          {t.status === "error" && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
              <p>{t.errorMessage}</p>
              {t.retryable && (
                <button
                  onClick={() => runTurn(i, t.question, turns.slice(0, i))}
                  className="mt-2 rounded-full bg-red-600 px-4 py-1 text-xs font-medium text-white"
                >
                  재시도
                </button>
              )}
            </div>
          )}
        </div>
      ))}

      {lastTurn.status === "done" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitFollowup();
          }}
          className="flex gap-2"
        >
          <input
            value={followupText}
            onChange={(e) => setFollowupText(e.target.value)}
            placeholder="후속 질문을 입력하세요"
            className="flex-1 rounded-full border px-4 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={!followupText.trim()}
            className="rounded-full bg-black px-4 py-2 text-sm text-white disabled:opacity-40 dark:bg-white dark:text-black"
          >
            전송
          </button>
        </form>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: errors only in `src/app/t/[threadId]/page.tsx` (still passes the old `initialData` prop — fixed in Task 9). No errors inside `ChatThread.tsx` itself.

- [ ] **Step 3: Commit**

```bash
git add src/components/ChatThread.tsx
git commit -m "feat: support multi-turn follow-up in ChatThread"
```

---

### Task 9: Wire `initialTurns` into `ThreadPage`

**Files:**
- Modify: `src/app/t/[threadId]/page.tsx`

**Interfaces:**
- Consumes: `SavedAnalysis.turns` (Task 5).

- [ ] **Step 1: Update the page**

Edit `src/app/t/[threadId]/page.tsx`, replace the `<ChatThread ... />` block:

```tsx
      <ChatThread
        threadId={threadId}
        initial={{ mode, target: mode === "portfolio" ? undefined : target, option: mode === "portfolio" ? undefined : option }}
        initialTurns={saved?.turns}
        initialStarred={initialStarred}
      />
```

(This replaces the old `initialData={saved ? { steps: saved.steps, answer: saved.answer } : undefined}` line — everything else in the file, including the `isInWatchlist` call from Plan 3's follow-up fix, is unchanged.)

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/t/[threadId]/page.tsx"
git commit -m "feat: pass multi-turn history into ChatThread"
```

---

### Task 10: Sidebar and `/history` — order and display by `updatedAt`

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/app/history/page.tsx`

**Interfaces:**
- Consumes: `SavedAnalysis.updatedAt` (Task 5, replaces `.createdAt`).

- [ ] **Step 1: Update `Sidebar.tsx`**

Edit `src/components/Sidebar.tsx`, find the "최근 분석" list rendering and replace:

```tsx
                <Link href={`/t/${a.threadId}?mode=${a.mode}&target=${a.target}&option=${a.option}`} className="text-xs underline">
                  {a.target} ({a.createdAt.slice(0, 10)})
                </Link>
```

with:

```tsx
                <Link href={`/t/${a.threadId}?mode=${a.mode}&target=${a.target}&option=${a.option}`} className="text-xs underline">
                  {a.target} ({a.updatedAt.slice(0, 10)})
                </Link>
```

- [ ] **Step 2: Update `history/page.tsx`**

Edit `src/app/history/page.tsx`, replace:

```tsx
                <span className="text-xs text-zinc-500">{a.createdAt.slice(0, 10)}</span>
```

with:

```tsx
                <span className="text-xs text-zinc-500">{a.updatedAt.slice(0, 10)}</span>
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/Sidebar.tsx src/app/history/page.tsx
git commit -m "feat: order sidebar/history by last-activity timestamp"
```

---

### Task 11: Full-suite regression pass + live verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full automated suite**

Run: `npm test`
Expected: all tests pass (Plans 1–4).

- [ ] **Step 2: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: no type errors, build succeeds.

- [ ] **Step 3: Live verification**

With the Task 1 migration applied and `npm run dev` running, walk through:
- Guest: run a company analysis → ask a follow-up ("목표주가는 얼마야?") → confirm a second Q&A block streams in, possibly under a different specialist (broker_view) than the first (company_analysis) → reload the page → confirm the follow-up is gone (guest, ephemeral) and only the original analysis remains.
- Logged in: run a date analysis → ask 2-3 follow-ups across different angles (e.g. one that should route to `flows`, one to `disclosures`) → confirm each streams and the specialist can change turn-to-turn → reload the page → confirm the *entire* multi-turn conversation replays instantly (no re-streaming) → check `/history` and the sidebar's "최근 분석" — confirm this thread is at the top (recent follow-up bumped its `updated_at`) and its displayed date reflects the latest activity, not the original creation time.
- Confirm a portfolio thread's follow-up still requires login (guest gets redirected same as the base portfolio flow) and never offers a different specialist (always `portfolio`).

- [ ] **Step 4: Report**

No commit for this task — it's verification only. If any step fails, fix it in a follow-up commit against the specific task it belongs to (not a catch-all "fix everything" commit).

---
