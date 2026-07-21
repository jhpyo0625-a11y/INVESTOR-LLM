# Plan 4 — Follow-up Intent Routing Design Specification

**Date:** 2026-07-21
**Status:** Approved design, pre-implementation
**Parent spec:** `docs/superpowers/specs/2026-07-20-investor-llm-design.md` (§6, §12 D3)
**Sibling spec:** `docs/superpowers/specs/2026-07-21-plan-3-portfolio-auth-design.md` (§1 — names this as Plan 4)

---

## 1. Overview

Plan 3 shipped auth, portfolio, and persistence but explicitly deferred the two
remaining pieces of the parent spec's D3 milestone: follow-up intent routing (this
plan) and the MCP server (Plan 5).

Plan 4 adds free-text follow-up to any chat thread — company, date, or portfolio.
Once the initial structured analysis finishes, a text input appears. The user's
free-text question is classified (one cheap LLM call) to a specialist constrained
to the thread's original mode-family, then answered in the same thread with full
conversation history. Works for guests (session-only, no persistence, matching how
the base analysis already works for guests) and logged-in users (persisted,
replayable from `/history`).

**Decisions locked during brainstorming (this plan):**

| Decision | Choice |
|---|---|
| Persistence scope | Full multi-turn — every follow-up turn is saved for logged-in users; `/history` replay shows the whole conversation |
| Schema shape | Extend the existing `analyses` row (one per thread) with a `turns` jsonb array, rather than a normalized per-turn table |
| Classifier routing scope | Constrained to the thread's original mode-family (company threads only switch between `company_analysis`/`broker_view`, date threads among the 4 date specialists, portfolio always stays portfolio) |
| Guest access | Follow-up works for guests too, ephemeral only (no persistence) — matches the base analysis's existing guest support |
| Classifier mechanism | Forced tool-call classification (single tool, enum-constrained to the mode-family's valid keys) — not plain-text parsing, not keyword heuristics |

---

## 2. Data Model

### 2.1 `analyses` table migration

```sql
alter table analyses drop column steps;
alter table analyses drop column answer;
alter table analyses add column turns jsonb not null default '[]';
alter table analyses add column updated_at timestamptz not null default now();
```

Each element of `turns`:

```ts
type Turn = {
  question: string | null;   // null only for turn 1 (structured input, no free-text question)
  answer: string;
  steps: StepPayload[];
  specialistKey: string;
  createdAt: string;
};
```

**Caveat — breaking migration:** existing rows' `steps`/`answer` are dropped, not
backfilled into `turns`. Acceptable at this app's pre-launch/demo scale (this is
the author's own data, not a production user base). Flag if a backfill is wanted
instead.

`updated_at` is bumped on every turn append (initial insert sets it equal to
`created_at`; `appendTurn` sets it to `now()`). `/history` and the sidebar's
"recent" list order by `updated_at desc` instead of `created_at desc`, so a thread
with recent follow-up activity bubbles to the top even if its first turn is old.

### 2.2 `src/lib/db/analyses.ts` changes

- `SavedAnalysis.turns: Turn[]` replaces `.steps: StepPayload[]` / `.answer: string`.
- `getAnalysisByThreadId` / `listRecentAnalyses`: same signatures, updated row-mapping for the new columns.
- New `appendTurn(supabase, input: { userId, threadId, mode, target, option, turn: Turn }): Promise<void>`:
  read-modify-write — if no row exists for `(userId, threadId)`, insert one with
  `turns: [turn]`; otherwise fetch the existing `turns`, push the new turn, and
  update along with `updated_at`. Same read-modify-write posture already accepted
  for `updateHolding`/`deleteHolding` at this app's single-tab-per-thread scale.
  Replaces `persistAnalysis` (turn-1-only) — turn 1 is just `appendTurn` with
  `question: null`.

---

## 3. Wire Contract

`chatRequestSchema` gains one new optional field, `followup`, on the *existing*
`mode`/`target`/`option`/`threadId` shape. `mode` always describes the thread's
identity (`"company"|"date"|"portfolio"`), never the request type — `followup`'s
presence is the discriminator between "start a thread" and "continue a thread".

```ts
followup?: {
  text: string;                          // the new follow-up question, min 1 char
  currentSpecialistKey: SpecialistKey;    // last specialist that answered; classifier's fallback
  turns: { question: string | null; answer: string }[]; // prior turns; turns[0].question is null
}
```

All existing `.refine()` rules (target/option required unless portfolio, date
format for mode:date) are untouched — they validate the thread's identity;
`followup` is orthogonal and adds no new refinement beyond `text.min(1)` and
`turns` being an array of the shape above.

---

## 4. Server Flow (`/api/chat`)

**If `followup` is absent:** unchanged — today's turn-1 behavavior, now persisted
via `appendTurn(..., { question: null, ... })` instead of `persistAnalysis`.

**If `followup` is present:**

1. Auth check unchanged: only a portfolio-mode thread's follow-up requires login
   (same as today's portfolio-mode gate). Company/date follow-ups work for guests.
2. Derive the mode-family's valid specialist keys:
   - `mode:"company"` → `["company_analysis", "broker_view"]`
   - `mode:"date"` → `["macro", "daily_reports", "disclosures", "flows"]`
   - `mode:"portfolio"` → `["portfolio"]`
3. Validate `followup.currentSpecialistKey` is a member of that family; if not
   (stale/tampered client state), fall back to the family's first key. This is a
   correctness guard, not a security boundary — specialist selection isn't
   privileged data.
4. **Classify** (skipped entirely when the family has one member — portfolio
   always stays portfolio, zero classifier calls needed there): one non-streamed
   NIM chat completion, `tool_choice` forced to a single
   `classify_intent(specialist: enum<validKeys>)` tool. The model must return one
   of the valid keys — no free-text parsing, no hallucinated specialist names.
   On any classifier error, timeout, or malformed/missing tool call, fall back
   silently to `followup.currentSpecialistKey` — a flaky classifier call never
   blocks or errors the user-visible request.
5. Build the `SpecialistConfig` for the chosen key: `specialists[key]` for the 6
   static specialists, or `buildPortfolioSpecialist(userId, supabase)` for portfolio.
6. Reconstruct `history: ChatMessage[]` from `followup.turns`: for each turn,
   push `{role:'user', content: turn.question ?? buildInitialMessage({mode,target,option})}`
   then `{role:'assistant', content: turn.answer}` — then append the new
   `{role:'user', content: followup.text}`. Turn 1's grounding message is
   regenerated (a function of `mode`/`target`, already known to both client and
   server) rather than transmitted over the wire. Caveat: `buildInitialMessage`
   embeds "오늘 날짜" (today's date), so a follow-up on a later calendar day than
   turn 1 regenerates that line with the *current* date, not turn 1's original
   date — a harmless cosmetic drift (the model's grounding is still correct
   about the target company/date being analyzed), not worth solving for.
7. `runAgent(specialist, history, ...)` — **unchanged**. `engine.ts`'s `runAgent`
   already accepts arbitrary `ChatMessage[]` history (built for multi-turn since
   Plan 1, never previously exercised by the route). Zero engine changes needed.
8. On the stream's `done` event, persist via `appendTurn` (fire-and-forget, same
   failure posture as today's `persistAnalysis` — a save failure logs via
   `console.error` and never turns a successful stream into a visible error) —
   only if `user` is present. Guests get the full streamed follow-up experience
   with zero persistence, matching their existing base-analysis behavior.

---

## 5. Client (`ChatThread.tsx`)

State becomes a `turns: TurnState[]` array (each with its own `steps`, `answer`,
`status`) instead of single top-level `steps`/`answer`/`status`. Turn 1 renders
exactly as today — no visible "question" line, since it was structured input via
option cards, not free text.

Turns 2+ render: a small "You asked: …" line, then that turn's `ReactTimeline`
(collapsed once its answer starts) and `StreamedAnswer`. A follow-up text input is
pinned below the last turn — enabled once the latest turn's status is `done`,
disabled while a new turn is streaming.

On submit: append a new turn locally with `status:'streaming'`, POST with
`followup: { text, currentSpecialistKey: <from the most recent 'done' event's
data.specialistKey>, turns: <prior turns mapped to {question, answer}> }`.
`specialistKey` is tracked in component state, updated from each `done` event —
that field already exists on the event today, no SSE/engine change needed.

Per-turn error handling: a failed follow-up shows a retry button scoped to that
turn only (resubmits the same text), leaving prior turns untouched — not a
full-thread reset.

Non-trivial payload-building logic (mapping local `turns` state to the wire
`followup.turns` shape) is extracted into a plain function in
`src/lib/chat-followup.ts` for unit testing, following this repo's established
precedent of extracting logic out of untestable JSX (no jsdom/testing-library
per the Plan 1–3 constraint).

---

## 6. Error Handling

- Classifier failure (API error, timeout, malformed/missing tool call) → silent
  fallback to `currentSpecialistKey`, never surfaced to the user as an error.
- Follow-up run failure (engine error) → per-turn error card + retry; thread's
  prior turns stay intact and rendered.
- `appendTurn` failure → `console.error`, fire-and-forget — matches
  `persistAnalysis`'s existing posture.
- The existing 10 req/min per-IP rate limit (`src/app/api/chat/route.ts`) applies
  unchanged to follow-up POSTs. An active back-and-forth conversation will consume
  that budget faster than one-shot analyses — pre-existing, already-documented
  limitation (see that route's `ponytail:` comment), not new scope for this plan.

---

## 7. Testing

No new test framework — vitest only, matching Plan 1–3's constraint (DOM-rendering
gaps accepted; logic extracted into plain functions instead).

- `src/lib/chat-types.test.ts`: new cases for `followup` field validation (valid
  shape accepted; missing `text`, empty `turns` question/answer shape rejected;
  existing company/date/portfolio cases unaffected).
- New `src/agent/intent-classifier.test.ts`: mock the NIM client, assert the
  forced `tool_choice` call is shaped with the correct enum for each mode-family;
  assert the model's valid response is returned; assert fallback to
  `currentSpecialistKey` on an API error, a timeout, and a malformed/missing tool
  call.
- `src/agent/orchestrator.test.ts`: new family-derivation helper — given a
  specialist key, returns its mode-family and valid sibling keys; covers all 7
  keys including `portfolio` (family of one).
- `src/lib/db/analyses.test.ts`: rewritten for the `turns` array shape;
  `appendTurn`'s insert-if-missing path, update-append path, and Supabase error
  propagation on both paths.
- `src/app/api/chat/route.test.ts`: new end-to-end followup case (mocked
  classifier + engine) — verifies the persisted turn's shape via a mocked
  `appendTurn`, and verifies a guest's followup request skips persistence
  entirely (no DB call attempted).
- New `src/lib/chat-followup.test.ts`: unit tests for the turns-state → wire
  `followup.turns` payload mapping (empty history, one prior turn, several).

---

## 8. Scope Boundaries

**In:** free-text follow-up on any thread type (company, date, portfolio);
mode-family-constrained intent classification via forced tool-call; full
multi-turn persistence for logged-in users; guest support (ephemeral,
session-only); `/history` and sidebar ordering by last-activity (`updated_at`).

**Explicitly out, deferred:**
- MCP server → **Plan 5** (per parent spec §12, unchanged).
- Editing or deleting individual follow-up turns.
- Backfilling existing pre-migration `steps`/`answer` data into the new `turns`
  shape (breaking migration, see §2.1 caveat).
- Any change to the existing per-IP rate limiter (see §6) — a shared/distributed
  rate-limit store remains future work, same as noted in Plan 3.
- Manual specialist override in the follow-up UI (spec explicitly frames this as
  automatic classification from free text, no manual card re-selection).
