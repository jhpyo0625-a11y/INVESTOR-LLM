# Plan 3 — Auth, Portfolio & Persistence Design Specification

**Date:** 2026-07-21
**Status:** Approved design, pre-implementation
**Parent spec:** `docs/superpowers/specs/2026-07-20-investor-llm-design.md` (§6, §12 D3)

---

## 1. Overview

Plan 3 covers the DB-backed half of the original spec's D3 milestone: Google login,
Supabase persistence, watchlist, holdings P&L, thread history, and a new
`PortfolioAnalyst` specialist. All 6 chat specialists and the full chat UI (Plans 1–2)
already exist and are unaffected — this plan adds login-gated features on top.

D3's remaining two pieces — follow-up intent routing and the MCP server — are
independent subsystems and are **out of scope** for this plan (see §8). They become
Plan 4 and Plan 5 respectively.

**Decisions locked during brainstorming (this plan):**

| Decision | Choice |
|---|---|
| Supabase project | Does not exist yet — created as part of this plan's setup |
| Auth method | Google OAuth via Supabase Auth (spec-locked choice, not the email/magic-link fallback) |
| Holdings P&L scope | Full feature (not the parent spec's cut-line fallback of watchlist-only) |
| History scope | Full `/history` page + sidebar last-5 (not the parent spec's cut-line fallback of sidebar-only) |
| Reads (sidebar, `/portfolio`, `/history`) | Server Components with direct Supabase queries (RLS-scoped by session) |
| Mutations (watchlist/holdings add/edit/delete) | Route Handlers, matching Plan 1/2's established pattern — no Server Actions introduced |
| `get_portfolio` tool scope | Server-bound to the authenticated session's `user_id`; never an LLM-suppliable argument (IDOR prevention) |

---

## 2. Global Constraints

- Next.js version in this repo renames `middleware.ts` → `proxy.ts` (`export function
  proxy(request)`, same file-convention slot, same execution semantics). Any
  `@supabase/ssr` tutorial referencing `middleware.ts` must be adapted to this name.
  Source: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`.
- No new test framework — vitest only, no jsdom/@testing-library (same constraint as
  Plan 2, same DOM-rendering-gap workaround: extract testable logic into plain functions).
- All external API calls (including Supabase) are server-side only where they touch
  secrets; `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` are the only
  Supabase values allowed in the browser bundle. `SUPABASE_SERVICE_ROLE_KEY` is
  server-only and used only where RLS-safe (this plan does not require bypassing RLS
  anywhere — every query is user-scoped and RLS-enforced).
- Tool inputs are zod-validated, untrusted input (LLM-supplied) — carried over from
  the parent spec's §7. `get_portfolio` specifically must not accept a user-identifying
  argument from the LLM (see §5).
- Guest mode must keep working exactly as today for company/date analysis — nothing
  in this plan may require login for the existing Plan 1/2 flows.
- `.env.local` gitignored; `.env.example` gains the new Supabase keys as placeholders.

---

## 3. Prerequisite Setup (manual, one-time)

Before implementation begins, the following must exist. Exact click-by-click steps are
detailed in the implementation plan's first task; this section lists what must be true
by the end of setup.

1. **Supabase project created** (supabase.com dashboard) — note the project URL,
   anon key, and service role key.
2. **Google Cloud Console OAuth client created** — OAuth consent screen configured,
   an OAuth 2.0 Client ID (type: Web application) created, with Supabase's OAuth
   callback URL (`https://<project-ref>.supabase.co/auth/v1/callback`) registered as
   an authorized redirect URI.
3. **Google provider enabled in Supabase Auth** — the Google client ID/secret from
   step 2 pasted into Supabase's Auth → Providers → Google settings.
4. **Site URL / redirect URLs configured in Supabase Auth** — `http://localhost:3000`
   (and `http://localhost:3000/auth/callback`) added to Supabase's allowed redirect
   list for local development.
5. **Four keys added to `.env.local`:** `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server-only), plus
   the DB schema (§4) applied via Supabase's SQL editor.

---

## 4. Data & DB (Supabase)

Schema, verbatim from the parent spec §6, plus one addition (`handle_new_user`
trigger, needed to ever populate `profiles` — not present in the parent spec's SQL
block):

```sql
profiles   (id uuid pk refs auth.users, display_name text, created_at)
watchlist  (id, user_id, ticker text, name text, created_at,
            unique (user_id, ticker))
holdings   (id, user_id, ticker text, name text,
            quantity numeric check (quantity > 0),
            buy_price numeric check (buy_price > 0), created_at)
analyses   (id, user_id, thread_id text, mode text, target text,
            option text, steps jsonb, answer text, created_at)

-- Auto-create a profile row when a user first signs up via Supabase Auth.
create function public.handle_new_user() returns trigger as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

RLS on every table: `user_id = auth.uid()` (all four tables, matching parent spec §6).
Company listing JSON stays a static bundled file, unaffected by this plan.

---

## 5. Architecture

- `src/lib/supabase/server.ts` — server-side Supabase client factory (`@supabase/ssr`
  `createServerClient`, cookie-based, used in Server Components and Route Handlers).
- `src/lib/supabase/client.ts` — browser Supabase client factory (`createBrowserClient`,
  used in Client Components for `signInWithOAuth`/`signOut`).
- `src/lib/supabase/dal.ts` — `getUser()` helper wrapping `supabase.auth.getUser()`,
  the one real (non-optimistic) auth boundary, used in every Route Handler and Server
  Component that needs a session.
- `src/app/auth/callback/route.ts` — OAuth code-exchange Route Handler
  (`exchangeCodeForSession`), redirects to `/` on success or `/?auth=failed` on failure.
- `proxy.ts` (repo root) — refreshes the session cookie on every request (Supabase's
  standard session-refresh pattern) and does one optimistic check: redirect guests
  hitting `/portfolio` or `/history` to `/?auth=required`. Wraps a pure, exported
  `isProtectedPath(pathname): boolean` predicate for testability. On any
  session-refresh error, fails open to guest — never blocks or crashes the request.
- **`get_portfolio` tool is not static.** Unlike the other 5 tools (registered once at
  module load in `src/tools/index.ts`'s `toolRegistry`), `get_portfolio` is built
  per-request via `makeGetPortfolioTool(userId: string): Tool`, with `userId` bound
  from the authenticated session — never from an LLM-supplied argument. It's wired
  into `runAgent()` via the existing `deps.runTool` override (`engine.ts`'s
  `Partial<Deps>` already supports this; no `engine.ts` changes needed). Because its
  tool list is per-user, `specialists.ts` gains `buildPortfolioSpecialist(userId):
  SpecialistConfig` (a factory) rather than a static `Record` entry. `SPECIALIST_KEYS`
  gains `"portfolio"` for wire/DB typing; the existing `specialists: Record<...>`
  continues covering only the original 6 static keys.
- `/api/chat` gains a third `mode` value: `"portfolio"` (alongside `"company"`/`"date"`),
  with no `target`/`option` — always "analyze the current user's holdings." Requires
  a session; 401 JSON if guest, stream never opens. This requires two existing pieces
  to change, not just add to: `chat-types.ts`'s `chatRequestSchema` currently requires
  `target`/`option` unconditionally — its `.refine()` needs a `mode === "portfolio"`
  branch making both optional (same shape as the existing date-format refinement, one
  more condition). `orchestrator.ts`'s `route()` looks up `` `${mode}:${option}` `` in
  a flat `ROUTES` table, which has no entry for an option-less mode — `route()` needs
  a `mode === "portfolio"` branch that returns `buildPortfolioSpecialist(userId)`
  directly instead of a `ROUTES` lookup (which also means `route()`'s signature grows
  a `userId` parameter, unused by the existing company/date branches).
- `/portfolio` page and sidebar P&L summary fetch live prices via `getStockData`
  called directly as a plain async function (`getStockData.run({ticker})`), **not**
  through the LLM agent — these are data-display reads, not analysis, so there's no
  reason to route them through a chat turn.
- Thread persistence: `route.ts` wraps the raw `runAgent()` generator locally,
  accumulating `steps`/`answer` as events pass through unchanged, and on the `"done"`
  event — if a session exists — fires an unawaited `analyses` insert (never blocks or
  fails the user-visible stream; insert errors are logged server-side only).
  `sse.ts` stays DB-agnostic; this logic lives entirely in `route.ts`.

---

## 6. Components & UI

- **Sidebar** (`src/components/Sidebar.tsx`, Server Component): watchlist chips (★,
  click → new company-analysis thread for that ticker), holdings P&L mini-summary
  (total 평가손익 ₩/%), last-5 analyses (name/date, click → `/t/[threadId]` replay).
  Guest: three "Google로 로그인하면 저장됩니다" placeholders, never blank sections.
- **`/portfolio`** (Server Component page + Client Component table): holdings table
  (종목/수량/평단가/현재가/평가손익), inline add/edit/delete, ticker autocomplete
  reusing `listings-client.ts`. "AI 분석" button starts a `PortfolioAnalyst` thread.
  Guest → redirected by `proxy.ts` before render.
- **`/history`** (Server Component page): full list of past analyses, no pagination
  (YAGNI at demo scale — add if it's ever a real problem).
- **★ button** on company threads (`ChatThread.tsx` header): `POST/DELETE
  /api/watchlist`, optimistic UI, login-prompt (not a raw 401) if guest.
- **Thread replay mode:** `ChatThread.tsx` gains an optional `initialData?: {steps,
  answer}` prop. `ThreadPage` (Server Component) checks whether an `analyses` row
  exists for the current `threadId` and user; if so, passes the saved data and
  `ChatThread` renders statically instead of calling `streamChat`.

---

## 7. Error Handling

- Guest → `/portfolio` or `/history`: `proxy.ts` redirects to `/?auth=required` before
  render; landing page shows a hint, never a raw 401/blank page.
- Guest → ★ or "AI 분석": Route Handler 401 JSON; client shows the same login-prompt
  pattern as the sidebar's guest hint.
- OAuth callback failure (denied consent, expired/reused code): redirect to
  `/?auth=failed`, never a thrown error.
- `proxy.ts` session-refresh failure: fail open to guest — never block or crash a
  request (zero-crashes-during-demo is a hard requirement of the parent spec).
- Holdings/watchlist mutation failure: Route Handler returns `{error}` JSON; client
  uses the existing idle/loading/success/error pattern (parent spec §5.4) — inline
  error + retry, not a page crash.
- `get_portfolio` tool failure or empty holdings: same `ToolResult` shape as the other
  5 tools; empty holdings → empty array, `PortfolioAnalyst`'s prompt states "보유 종목
  없음" rather than inventing data. No `engine.ts` changes needed.
- Thread-persistence insert failure: logged server-side only, never surfaced — a
  failed save must not turn a successful analysis into a visible error.

---

## 8. Testing

No new test framework (vitest only) — same constraint and DOM-gap workaround as Plan 2.

- Route Handlers (`/api/watchlist`, `/api/holdings`, `/api/chat`'s `portfolio` mode):
  unit-tested like Plan 2's `api/chat/route.test.ts` — mock the Supabase server
  client, cover 401-guest, 400-invalid, and happy-path cases.
- `get_portfolio` tool: unit-tested like the existing 5 tools' tests — mock the
  Supabase query response, assert the shape returned to the LLM.
- `makeGetPortfolioTool` user-scoping: a direct test asserting the built tool queries
  `holdings` filtered by the bound `userId`, not one read from `args` — guards the
  IDOR-prevention property in §5 against future regression.
- `proxy.ts`: test the exported `isProtectedPath(pathname)` predicate directly, not
  the full request/response proxy flow (no test utility available for that beyond
  Next's experimental matcher-only helpers).
- Component/DOM-level gaps (Sidebar, portfolio table): extract logic into plain,
  testable functions where practical (e.g. `calculateHoldingPL(holding, currentPrice)`
  as a pure unit-tested function); JSX wiring itself verified only by live Playwright
  browser testing, matching Plan 2's precedent and accepted gap.
- Live verification (once Supabase + Google OAuth are live): Playwright pass covering
  login → watchlist add → holding add → portfolio analysis → history → logout → guest
  sees login-prompt UX, not errors.

---

## 9. Scope Boundaries

**In this plan:** Supabase auth (Google OAuth) + DB schema, watchlist, holdings P&L
(full), thread persistence to `analyses`, full `/history` page, `PortfolioAnalyst`
specialist + `get_portfolio` tool, sidebar.

**Explicitly out, deferred:**
- Follow-up free-text chat input + intent classifier → **Plan 4**. `ChatThread`'s
  follow-up input box stays absent, same as Plan 2.
- MCP server → **Plan 5**. Fully independent of this plan's DB/auth work.

---
