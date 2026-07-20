# INVESTOR-LLM — Design Specification

**Date:** 2026-07-20
**Status:** Approved design, pre-implementation
**Timeline:** 4 days to live demo (cut lines defined in §12)

---

## 1. Overview

INVESTOR-LLM is an AI-powered investment information web app for the Korean market
(with US macro coverage). A user enters either a **Company** or a **Date**, picks an
analysis option from a card UI, and a multi-agent ReAct system gathers real data
(DART disclosures, prices, foreign/institutional flows, web search) and streams a
Korean-language analyst-style report into a chat thread. The user can then ask
free-text follow-up questions in the same thread.

**Decisions locked during brainstorming:**

| Decision | Choice |
|---|---|
| Market scope | Korea primary + US macro (daily briefing only) |
| Data strategy | Real APIs (DART, Naver Finance) + web search (Tavily); no scraping of paywalled reports, no mock data |
| UI paradigm | Hybrid: structured entry (company search / date picker + option cards) feeding a chat thread |
| Agent visibility | Live, collapsible ReAct step timeline (Thought → Action → Observation) in the UI |
| Language | Korean UI and Korean LLM output |
| Date range | Last 30 days only (enforced by date picker, stated in UI) |
| Portfolio | Watchlist + holdings P&L (per-user, in DB) |
| Demo | Localhost production build; deployed Vercel URL shown as proof of deployment |
| MCP | Our own stdio MCP server exposing our tools |
| Bonus features in scope | Web search tool, MCP server, deployment, DB storage, social login, multi-agent orchestration |
| Bonus feature out of scope | Hybrid serving (stretch only, §12) |

**Hard requirements (from evaluation):**

- ReAct loop (Thought → Action → Observation), visibly working
- ≥1 custom tool, dynamically selected by the LLM
- NVIDIA API (Qwen) as baseline model
- Real-time LLM response streaming
- Robust loading/error states — no blank screen on any API failure
- API keys in environment variables only
- Zero crashes during live demo (penalty)
- Author must be able to explain request-response routing in Q&A

---

## 2. Architecture (chosen: Option A)

Single Next.js application. Hand-rolled ReAct engine. One codebase, one deploy.

```
┌─────────────────────────── Browser ────────────────────────────┐
│  Landing (company search / date picker / option cards)         │
│  Chat thread (ReAct timeline + streamed report + follow-ups)   │
│  Sidebar (watchlist, holdings P&L, history)                    │
└───────────────┬────────────────────────────────────────────────┘
                │ POST /api/chat  (SSE stream back)
┌───────────────▼──────────── Next.js server ────────────────────┐
│  Orchestrator (route: structured → deterministic,              │
│                free-text → LLM intent classifier)              │
│        │ dispatches to exactly one specialist                  │
│  ┌─────▼──────────────────────────────────────────┐            │
│  │ Specialist agents (system prompt + tool subset)│            │
│  │ CompanyAnalyst · MacroAnalyst · ReportAnalyst  │            │
│  │ DisclosureAnalyst · FlowAnalyst ·              │            │
│  │ PortfolioAnalyst                               │            │
│  └─────┬──────────────────────────────────────────┘            │
│  ┌─────▼─────────────┐   ┌──────────────────────┐              │
│  │ ReAct engine      │──▶│ NVIDIA NIM (Qwen)    │              │
│  │ (shared, 1 file)  │   │ OpenAI-compatible    │              │
│  └─────┬─────────────┘   └──────────────────────┘              │
│  ┌─────▼──────────────────────────────────────────┐            │
│  │ Tools: search_disclosures · get_stock_data ·   │            │
│  │ get_market_overview · get_portfolio ·          │            │
│  │ web_search                                     │            │
│  └───┬──────────┬──────────┬──────────┬───────────┘            │
└──────┼──────────┼──────────┼──────────┼────────────────────────┘
   DART API   Naver Fin   Tavily    Supabase
   (공시)      (시세/수급)   (search)  (DB + Google OAuth)
```

The same tool implementations are also exported to a small **stdio MCP server**
(`mcp/`) — shared code, two consumers (§8).

### 2.1 Request-response routing (the Q&A answer)

1. Browser sends `POST /api/chat` with `{ mode, target, option, messages, threadId }`.
   - `mode`: `"company" | "date" | "followup"`; `target`: ticker or date; `option`: A/B/C/D.
2. **Orchestrator** resolves which specialist runs:
   - Structured input (user clicked an option card) → deterministic table lookup. No LLM involved, cannot misroute.
   - Free-text follow-up → one cheap LLM call classifies intent to a specialist (default: the thread's current specialist).
3. The specialist = a config object `{ systemPrompt, tools[] }`. Orchestrator passes it to the **ReAct engine**.
4. ReAct engine loops (max 6 iterations):
   - Call Qwen via NVIDIA NIM (OpenAI-compatible chat completions, native tool/function calling).
   - Model returns either a tool call (**Action**) or final text.
   - Engine executes the tool, appends the result (**Observation**) to the message list, loops.
   - Every step is emitted as an SSE event the moment it happens.
5. Final answer streams token-by-token as SSE. Route handler returns the SSE response; client renders incrementally.
6. On completion, the thread (steps + answer) is persisted to Supabase `analyses` (logged-in users only).

### 2.2 Streaming protocol

`POST /api/chat` responds `text/event-stream`. Event types:

| Event | Payload | UI effect |
|---|---|---|
| `step` | `{ type: "thought" \| "action" \| "observation", text, tool?, args? }` | Appends to ReAct timeline |
| `token` | `{ text }` | Appends to streamed answer |
| `done` | `{ threadId }` | Enables follow-up input, saves thread |
| `error` | `{ code, message, retryable }` | Renders error card with retry |

Client uses `fetch` + `ReadableStream` parsing (or the Vercel AI SDK's stream
helpers if they map cleanly to these events — implementation detail, protocol above
is the contract).

### 2.3 Model

- Primary: Qwen3 (largest instruct variant available on `integrate.api.nvidia.com`
  with function calling — pin exact model ID on Day 1 after a smoke test).
- Intent classifier + small tasks: same model, low `max_tokens` (one model, fewer variables).
- If native function calling proves unreliable on NIM: fallback is prompt-based ReAct
  (model emits `{"thought": ..., "action": ..., "args": ...}` JSON, engine parses).
  The engine abstracts this so the rest of the app doesn't care.

---

## 3. Multi-agent orchestration

Six specialists. Each is **only** a system prompt plus a tool allowlist — the loop
code is shared. This is deliberately thin: honest to demo, one sentence to explain.

| Specialist | Trigger | Tools | Output |
|---|---|---|---|
| `CompanyAnalyst` | Company → A (기업 분석) | get_stock_data, search_disclosures, web_search | Fundamentals-style report: price action, valuation context, recent disclosures, risks |
| `ReportAnalyst` | Company → B (증권사/애널리스트 시각) · Date → B (일일 리포트 요약) | web_search, get_stock_data | Synthesizes analyst-report headlines/consensus from search; decodes jargon and target prices in plain Korean |
| `MacroAnalyst` | Date → A (거시경제 핵심 이슈) | get_market_overview, web_search | US market, big tech, rates, FX, oil for that date |
| `DisclosureAnalyst` | Date → C (주요 공시 리뷰) | search_disclosures, web_search, get_stock_data | Filters that date's DART filings to material ones (대규모 계약, 유상증자, 블록딜, 내부자 매수, 시설투자), explains hidden meaning |
| `FlowAnalyst` | Date → D (수급/섹터 동향) | get_stock_data, get_market_overview, web_search | Foreign/institutional net flows, leading vs lagging sectors |
| `PortfolioAnalyst` | Sidebar "내 포트폴리오 분석" button / follow-up intent | get_portfolio, get_stock_data, web_search | P&L summary + per-holding risk/news check |

Every specialist prompt ends with a fixed disclaimer instruction: output must include
"본 분석은 투자 참고용이며, 투자 판단의 책임은 투자자 본인에게 있습니다."

---

## 4. Tools

All tools: TypeScript functions with zod-validated inputs/outputs, a JSON-schema
definition for the LLM, a 10s timeout, and typed errors (never throw raw — return
`{ ok: false, error }` so the agent can react and the UI never blanks).

### 4.1 `search_disclosures` (custom — DART OpenAPI)

- Input: `{ corpCode?, dateFrom, dateTo, types? }`
- Source: `https://opendart.fss.or.kr/api/list.json` (key: `DART_API_KEY`).
- Corp-code resolution: DART's CORPCODE zip is downloaded once at build time and
  reduced to a bundled JSON of **listed** companies `{ name, ticker, corpCode, market }`
  (~2,600 entries). This same file powers company autocomplete (§6).
- Output: list of filings `{ title, filedAt, corp, reportUrl, type }`.

### 4.2 `get_stock_data` (custom — Naver Finance mobile JSON API)

- Input: `{ ticker, include: ("price" | "flows" | "fundamentals")[] }`
- Source: `m.stock.naver.com/api/...` unofficial JSON endpoints (current price, OHLC
  history, investor trend = 외국인/기관/개인 net buy). Unofficial but stable and
  server-side only; wrapped in zod so schema drift fails loudly, not weirdly.
- Output: normalized price/flow/fundamental snapshot.

### 4.3 `get_market_overview` (custom — Naver market + Yahoo endpoints)

- Input: `{ date }` (within 30-day window)
- Output: KOSPI/KOSDAQ, S&P500/NASDAQ, USD/KRW, WTI, US 10Y, sector performance table.
- Historical values within the window come from the same endpoints' daily-history APIs.

### 4.4 `get_portfolio` (custom — Supabase)

- Input: `{}` (user resolved from session server-side; the LLM never sees user IDs)
- Output: holdings joined with live prices from `get_stock_data` → cost basis,
  current value, P&L per holding and total.

### 4.5 `web_search` (Tavily)

- Input: `{ query, maxResults? }` — key: `TAVILY_API_KEY`, free tier.
- Used by all specialists for news, analyst-report headlines, context for old-ish dates.

---

## 5. Pages & UX (Korean UI)

### 5.1 Landing `/`

- Hero with segmented input: **[기업]** | **[날짜]** toggle.
  - 기업: search-as-you-type against bundled listing JSON (name, ticker; keyboard navigable).
  - 날짜: native date picker, min = today − 30d, max = today; helper text "최근 30일 이내만 지원됩니다".
- Selecting a target reveals **option cards**:
  - Company: A. 기업 분석 리포트 · B. 증권사/애널리스트 시각
  - Date: A. 거시경제 핵심 이슈 · B. 일일 리포트 요약 · C. 주요 공시 리뷰 · D. 수급/섹터 동향
- Clicking a card navigates to `/t/[threadId]` and starts the stream.
- Sidebar (collapsible on mobile): watchlist chips (★ one-click re-analysis),
  holdings P&L mini-summary, recent analysis history. Guest sees a tasteful
  "Google로 로그인하면 저장됩니다" hint — never a blocking wall.

### 5.2 Thread `/t/[threadId]`

- Header: target chip (기업명 or 날짜) + chosen option.
- **ReAct timeline**: live-appending list — 🤔 Thought / 🔧 Action (tool + args) /
  👁 Observation (result summary, truncated, expandable). Collapses automatically
  when the final answer starts streaming; re-expandable.
- **Answer**: streamed markdown (headings, tables) rendered incrementally.
- **Follow-up input** at bottom, enabled after `done`. Follow-ups run through the
  orchestrator's intent classifier and append to the same thread.
- ★ button on company threads → add to watchlist (prompts login if guest).

### 5.3 Portfolio `/portfolio`

- Table of holdings: 종목, 수량, 평단가, 현재가, 평가손익(₩, %). Add/edit/delete rows
  (ticker autocomplete reuses the listing JSON; numeric validation on qty/price).
- "AI 분석" button → PortfolioAnalyst thread.
- Login required (redirect with explanatory message; guest never sees a broken page).

### 5.4 State handling (no-blank-screen contract)

Every remote interaction has four explicit states: `idle / loading / success / error`.

- Loading: skeletons (cards, table rows), animated "분석 준비 중…" placeholder in threads.
- Tool failure mid-run: agent receives the error observation and either retries once
  or states in the answer what data was unavailable — the run still completes.
- Stream/LLM failure: partial content is kept, an error card with 재시도 button
  replaces only the streaming region. `error` SSE events carry `retryable`.
- Global: Next.js `error.tsx` + `not-found.tsx` boundaries on every route; root
  boundary shows branded error page with a home link. Nothing ever renders blank.
- All fetches: explicit timeouts; NVIDIA call wrapped with 1 automatic retry on
  transient failure.

---

## 6. Data & DB (Supabase)

Google social login via Supabase Auth (`@supabase/ssr` for Next.js session handling).
**Guest mode**: analysis fully works logged out; only save/watchlist/portfolio require
login. Demo can never be blocked by an OAuth hiccup.

Tables (all with RLS: `user_id = auth.uid()`):

```sql
profiles   (id uuid pk refs auth.users, display_name text, created_at)
watchlist  (id, user_id, ticker text, name text, created_at,
            unique (user_id, ticker))
holdings   (id, user_id, ticker text, name text,
            quantity numeric check (quantity > 0),
            buy_price numeric check (buy_price > 0), created_at)
analyses   (id, user_id, thread_id text, mode text, target text,
            option text, steps jsonb, answer text, created_at)
```

Company listing data (autocomplete + corp-code map) is a static bundled JSON, not a
DB table — no query latency, works offline.

---

## 7. Security

- All keys in env vars: `NVIDIA_API_KEY`, `DART_API_KEY`, `TAVILY_API_KEY`,
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY` (server only).
- `.env.local` gitignored; `.env.example` committed with placeholder values.
- All external API calls are server-side only (route handlers) — no key ever reaches
  the browser.
- Supabase RLS on every table; service-role key used only where RLS-safe.
- Tool inputs zod-validated (the LLM's arguments are untrusted input).

---

## 8. MCP server (bonus)

`mcp/server.ts` — stdio MCP server (official `@modelcontextprotocol/sdk`) exposing
`search_disclosures` and `get_stock_data` by importing the **same tool modules** the
web app uses. Run: `npx tsx mcp/server.ts`.

Demo move: register it in Claude Code, ask Claude "삼성전자 최근 공시 찾아줘", show it
calling our server. Q&A story: "same tool code, two consumers — our ReAct agent and
any MCP client."

---

## 9. Project structure

```
src/
  app/
    page.tsx                # landing
    t/[threadId]/page.tsx   # thread
    portfolio/page.tsx
    api/chat/route.ts       # orchestrator entry, SSE out
    api/portfolio/route.ts  # CRUD
    auth/callback/route.ts  # Supabase OAuth callback
    error.tsx, not-found.tsx
  agent/
    engine.ts               # ReAct loop (the file you explain in Q&A)
    orchestrator.ts         # routing table + intent classifier
    specialists.ts          # 6 { systemPrompt, tools } configs
    nim.ts                  # NVIDIA NIM client wrapper (retry, timeout)
  tools/
    disclosures.ts, stock.ts, market.ts, portfolio.ts, search.ts
    index.ts                # registry: name → { schema, run }
  components/               # ReactTimeline, StreamedAnswer, OptionCards, ...
  lib/
    supabase/               # client/server helpers
    listings.ts             # bundled company JSON access
mcp/
  server.ts
data/
  listings.json             # generated from DART CORPCODE (build script)
scripts/
  build-listings.ts
```

Stack: Next.js 15 (App Router) · TypeScript · Tailwind CSS · zod ·
`@supabase/ssr` · `@modelcontextprotocol/sdk` · Vercel AI SDK only if its stream
helpers fit §2.2 (otherwise plain SSE — no dependency added for what ~50 lines do).

---

## 10. Deployment (bonus)

- Vercel, env vars set in dashboard. `maxDuration = 60` on `/api/chat` (Hobby limit) —
  ReAct capped at 6 iterations keeps runs well under it.
- Demo runs `next build && next start` locally (fast, controllable); deployed URL
  opened once during demo as deployment proof.

---

## 11. Testing & verification

- Per-tool smoke script (`scripts/smoke.ts`): calls each real API once, prints
  normalized output — run every morning of the build and before the demo.
- Engine unit test: mock NIM responses → assert loop emits thought/action/observation
  sequence and terminates (max iterations, malformed tool args, tool error paths).
- Manual demo rehearsal ×3 on Day 4 with the exact demo script (§13); any crash found
  is a Day-4 blocker bug.

---

## 12. Day plan & cut lines

| Day | Deliverable (demoable at end of day) |
|---|---|
| **D1** | Repo scaffold; listings build script; all 5 tools working via smoke script; ReAct engine looping against NVIDIA NIM in terminal with streaming |
| **D2** | Chat UI: landing inputs, option cards, SSE streaming, ReAct timeline, markdown answers; CompanyAnalyst + MacroAnalyst end-to-end |
| **D3** | Remaining specialists; Supabase auth + watchlist + holdings P&L + history; MCP server; follow-up intent routing |
| **D4** | Vercel deploy; error-state hardening pass; demo rehearsal ×3; Q&A cheat sheet |

**Cut lines (in order, if behind schedule):**
1. Holdings P&L → watchlist only
2. Follow-up intent classifier → follow-ups always reuse current specialist
3. ReportAnalyst (Date B) → folded into MacroAnalyst
4. History page → last-5 list in sidebar only

**Stretch (only if D4 has slack):** hybrid serving — tiny local Ollama model
generates thread titles; NVIDIA remains the analysis brain. One paragraph in Q&A,
one afternoon of work, skippable.

**Never cut:** ReAct visibility, streaming, error states, custom tools, guest mode.

---

## 13. Demo script (5 min)

1. Landing → type "삼성전자" → option A → watch ReAct timeline call
   `get_stock_data` + `search_disclosures` live → streamed report.
2. Follow-up: "외국인은 최근 왜 팔았어?" → FlowAnalyst-style answer in same thread.
3. Date → yesterday → option C (공시 리뷰) → DisclosureAnalyst filters real filings.
4. Google login → ★ 삼성전자 → portfolio: add holding → P&L → "AI 분석".
5. MCP: Claude Code calls our `search_disclosures` server.
6. Open Vercel URL — deployed proof. Close with architecture one-liner:
   "orchestrator routes deterministically, specialists run a shared ReAct loop with
   scoped tools, everything streams as SSE events."

---

## 14. Risks

| Risk | Mitigation |
|---|---|
| Naver unofficial API schema change | zod validation fails loudly; agent degrades to web_search for that data; morning smoke script catches it before demo |
| NIM function calling flaky with Qwen | Day-1 smoke test decides; JSON-prompt ReAct fallback already designed (§2.3) |
| Tavily free-tier rate limit during rehearsal ×3 + demo | Cap search calls per run (≤3); second free key as spare |
| OAuth breaks in demo | Guest mode covers every analysis feature |
| Scope (all bonuses in 4 days) | Cut lines §12; each day ends demoable |
