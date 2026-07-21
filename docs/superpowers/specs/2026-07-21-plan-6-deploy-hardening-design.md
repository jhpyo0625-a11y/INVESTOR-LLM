# Plan 6 — Deployment & Error Hardening Design Specification

**Date:** 2026-07-21
**Status:** Approved design, pre-implementation
**Parent spec:** `docs/superpowers/specs/2026-07-20-investor-llm-design.md` (§7, §10, §12 D4)

---

## 1. Overview

Plans 1–5 covered D1–D3 of the parent spec's day plan (§12): core agent/tools, chat UI,
auth/watchlist/holdings/history, follow-up intent routing, and the MCP server. D4 —
Vercel deployment, an error-state hardening pass, demo rehearsal, and a Q&A cheat
sheet — is the last unbuilt item. Demo rehearsal and the cheat sheet are human
activities, not code; this plan covers the two engineering pieces: deployment and
error hardening.

**Decisions locked during brainstorming (this plan):**

| Decision | Choice |
|---|---|
| Hardening scope | Narrow: `global-error.tsx` (catches root-layout crashes) + `<html lang>` fix. Not a broader audit of every server component's error handling. |
| Deployment scope | Mostly a human-executed checklist (Vercel project creation, dashboard env vars) — code-side prep (`.env.example`, `.gitignore`, `maxDuration`) is already done from prior plans; verified live at the end. |

---

## 2. Error Hardening

### 2.1 The gap

`src/app/error.tsx` (existing) is a React error boundary that wraps everything
*below* the root layout — pages, nested layouts, loading/not-found states. Per
Next's own file-convention docs (vendored at
`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md`,
since this project's Next version has non-standard breaking changes per `AGENTS.md`):
`error.js` does **not** wrap the `layout.js` above it in the same segment.

`src/app/layout.tsx` (root layout) renders `<Sidebar />`, an async server component
that calls `listRecentAnalyses(supabase, userId)` — which `throw`s on a Supabase
read failure (`src/lib/db/analyses.ts`). If that throw happens, `error.tsx` cannot
catch it (it's above `error.tsx` in the tree), so the *entire app* falls through
to Next's default, unbranded crash screen. This gap has been sitting in the
project's progress ledger since Plan 3 (Tasks 15/16 worked around the same bug
class in sibling code, but the root-layout case itself was never fixed).

### 2.2 The fix

Create `src/app/global-error.tsx` — the file convention specifically for root-layout
crashes. Per the same vendored docs, it must be a Client Component that defines its
own `<html>`/`<body>` (it fully replaces the root layout when active) and takes
`{ error, unstable_retry }` props — the same non-standard prop name (not the
stable-Next `reset`) that `error.tsx` already uses in this codebase, confirmed
against the vendored docs rather than assumed from prior Next-version knowledge.

Content mirrors `error.tsx`'s existing Korean copy and styling (same "문제가
발생했습니다" heading, retry + home-link buttons) for visual consistency between the
two error states — a user shouldn't be able to tell which boundary caught the
crash from the UI alone.

### 2.3 `<html lang>` fix

`src/app/layout.tsx`'s root `<html lang="en" ...>` is wrong for a Korean-language
app (`metadata.description` is already Korean; every page's content is Korean).
Flagged in Plan 2's final whole-branch review, never fixed. One-line change to
`lang="ko"`. `global-error.tsx`'s own `<html>` gets the same `lang="ko"` for
consistency (it's a separate root element per the file convention, so it needs its
own attribute).

### 2.4 Testing

No automated test — `error.tsx` and `not-found.tsx` (the two existing file-convention
error components) have no test files either; this is an accepted, pre-existing gap
for Next's App Router file-convention components in this project (same DOM-rendering
gap accepted for `ChatThread.tsx` etc. across Plans 1–5: no jsdom/@testing-library).
Verified live instead: temporarily force a `throw` inside `Sidebar` (e.g. an
unconditional `throw new Error("test")` at the top of the function), load the app,
confirm `global-error.tsx`'s Korean UI renders instead of Next's default crash
screen, then revert the temporary throw before committing.

---

## 3. Deployment

### 3.1 What's already done

From prior plans, with no changes needed:
- `.env.example` lists exactly the 7 env vars `.env.local` actually uses
  (`NVIDIA_API_KEY`, `DART_API_KEY`, `TAVILY_API_KEY`, `NIM_MODEL`,
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`), with placeholder values.
- `.gitignore` already excludes `.vercel` (the directory the Vercel CLI/dashboard
  link creates).
- `src/app/api/chat/route.ts:143` already sets `export const maxDuration = 60`
  (spec §10's Hobby-tier requirement).
- No `next.config.ts` changes needed, no `engines.node` pin needed — the
  `--env-file` flag (Node 20+) is only used by local dev scripts (`smoke`,
  `build:listings`, `mcp`), never by the deployed Next.js runtime itself, which
  gets its env vars injected directly by Vercel.

### 3.2 What's left (human-executed)

1. Create a Vercel project, connect it to the `INVESTOR-LLM` GitHub repo
   (`jhpyo0625-a11y/INVESTOR-LLM`).
2. Enter the 7 env vars from `.env.example` into the Vercel dashboard (Project
   Settings → Environment Variables), using the real values from `.env.local` —
   not the placeholders.
3. Trigger a deploy (either automatic on the dashboard connection, or a manual
   redeploy).
4. Live-verify the deployed URL: guest company analysis end-to-end against the
   production build (same shape as spec §13's demo script step 6 — "Open Vercel
   URL — deployed proof").

This mirrors the human-executed-Task-1 pattern already used in Plan 3 (Supabase
project setup) and Plan 4 (SQL migration) — an external-dashboard action a
subagent has no credentials to perform, handed to the user, with the plan's
automated portion (already-passing tests, clean build) as the prerequisite gate
before it, and live verification as the final step after it.

---

## 4. Scope Boundaries

**In:** `global-error.tsx`, `<html lang>` fix, live-verified Vercel deployment.

**Explicitly out, deferred:**
- Broader error-handling audit (AuthButton's missing `.catch()`, other server
  components) — narrowed out during brainstorming; not this plan's scope.
- Demo rehearsal ×3 and the Q&A cheat sheet (spec §12 D4, §13) — human
  presentation-prep activities, not engineering tasks a plan executes.
- A shared/distributed rate-limit store for `/api/chat` (still the same
  per-instance in-memory limiter, `ponytail:`-flagged since Plan 4) — pre-existing,
  explicitly out of scope for every prior plan, unchanged here.
- CI/CD pipeline (GitHub Actions, preview deployments, etc.) — spec's deployment
  bonus is "Vercel, env vars set in dashboard," nothing about a CI pipeline.

## 5. Known Limitation (discovered during live deployment verification)

Not part of the original design — found while live-verifying the deployed app
(Task 2, Step 4) and left here since it directly affects the parent spec's
flagship demo flow (§13, step 1: 삼성전자 → option A).

**`company_analysis` (mode:company, option A) intermittently/reliably exceeds
Vercel Hobby's hard 60s `maxDuration` ceiling in production.** The initial
deploy failed outright (function ran in `iad1`/US East while every tool —
DART, Naver, Tavily — is Korea-hosted). Two fixes narrowed the gap
substantially but didn't close it:

1. `vercel.json`'s `regions: ["icn1"]` (Seoul) — moved the function itself
   next to its tool APIs. Took the flow from a total failure (0 tokens
   streamed) to ~100-118 tokens streamed before still hitting the wall.
2. Capping `company_analysis`'s optional `web_search` step to exactly one
   call (`src/agent/specialists.ts`) — removed one ReAct iteration's worth of
   reasoning-heavy NIM latency from the worst case. Got to ~142-155 tokens
   streamed, still not finishing in time.

**Important nuance for whoever revisits this:** the `icn1` region move is a
net win (it fixed the outright failure) but it does NOT help — and may
slightly hurt — the specific bottleneck now remaining. `src/agent/nim.ts`
calls `https://integrate.api.nvidia.com/v1`, NVIDIA's managed NIM endpoint,
which is not Korea-hosted. Every ReAct iteration is a full NIM completion
call (and streams reasoning/thinking-token content along with tool-call
decisions, per this project's existing deliberate design — see Plan 2's
progress ledger). Pinning the function to `icn1` optimizes the DART/Naver/
Tavily hops but adds a trans-Pacific round trip to every NIM call instead.
The region fix helped because tool-call latency was the dominant cost before
it; now that it's fixed, NIM inference/reasoning time across
`company_analysis`'s remaining 3-4 iterations is the likely dominant cost.

`macro` (mode:date, option A — 2 mandatory tools, 3 iterations) completes
reliably (55.8s observed). `company_analysis` needs 2 mandatory tools
(`get_stock_data`, `search_disclosures`) plus a capped-optional `web_search`
plus final-answer generation (3-4 iterations).

**Explicitly not pursued further this plan (user's informed decision):**
dropping `web_search` from `company_analysis` entirely (would match
`macro`'s proven 2-tool pattern, at the cost of losing supplementary
news context beyond official filings/price data).

**Real remaining levers, if revisited:**
- Upgrade to Vercel Pro (`maxDuration` up to 300s) — removes the ceiling
  entirely, doesn't require touching the ReAct loop or prompts.
- Check whether NVIDIA offers a Korea/Asia-region NIM endpoint or gateway —
  would address the actual remaining bottleneck this nuance describes,
  unlike the `icn1` function-region fix.
- Drop `web_search` from `company_analysis` (see above).
