# INVESTOR-LLM Plan 1/3 — Core Agent & Tools (Day 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Working ReAct agent in the terminal — real tools (DART, Naver, Yahoo, Tavily), hand-rolled streaming loop against NVIDIA NIM (Qwen), deterministic orchestrator — proven by a smoke script.

**Architecture:** Plain TypeScript modules inside a fresh Next.js scaffold (`src/tools/*`, `src/agent/*`). No UI in this plan. The engine is an async generator emitting events (`token`/`action`/`observation`/`done`/`error`) — Plan 2 pipes these same events over SSE. Spec: `docs/superpowers/specs/2026-07-20-investor-llm-design.md`.

**Tech Stack:** Next.js 15 (App Router, TS, Tailwind, src-dir) · zod v4 · `openai` pkg pointed at `https://integrate.api.nvidia.com/v1` · `fflate` (zip) · vitest · tsx

## Global Constraints

- All keys from env vars only: `NVIDIA_API_KEY`, `DART_API_KEY`, `TAVILY_API_KEY`. Never hardcode, never commit `.env.local`.
- Tools never throw to callers: the registry's `runTool` returns `{ ok: false, error }` on any failure.
- Every external HTTP call has a 10s timeout (`AbortSignal.timeout`).
- ReAct loop: max 6 iterations; final iteration forces a text answer (tools disabled).
- LLM output language: Korean. Every specialist prompt ends with the fixed disclaimer "본 분석은 투자 참고용이며, 투자 판단의 책임은 투자자 본인에게 있습니다."
- Windows dev machine: npm scripts must be cross-platform (no bash-isms); run TS scripts via `tsx --env-file=.env.local`.
- Commits in the NEW repo created in Task 1 (rooted at `C:\Users\jhpyo\Desktop\INVESTOR-LLM`), not the pre-existing home-directory repo.
- Naver/Yahoo endpoint response shapes in Tasks 5–6 are best-known guesses: each has a mandatory verify step (curl real endpoint, adjust zod schema to reality) before its test step.

**Spec deviations (agreed rationale, carry into Plan 2/3):**
1. Engine emits no separate `thought` event — streamed text preceding an `action` IS the thought; the client reclassifies on receiving `action`. Keeps token-by-token streaming for final answers.
2. `listings.json` entries are `{ name, ticker, corpCode }` — no `market` field (DART CORPCODE.xml doesn't carry it, nothing needs it).
3. `get_market_overview` uses Yahoo chart API for ALL symbols (KR + US + FX + WTI + 10Y): one source, one schema. Sector table dropped from the tool; FlowAnalyst covers sectors via `web_search`.

---

### Task 0: API keys (user action, before or during Task 1)

- [ ] DART: https://opendart.fss.or.kr → 인증키 신청 → key by email (instant). Put in `.env.local` as `DART_API_KEY`.
- [ ] Tavily: https://app.tavily.com → sign up → copy `tvly-...` key → `TAVILY_API_KEY`.
- [ ] NVIDIA key (already issued) → `NVIDIA_API_KEY`.

---

### Task 1: Scaffold project + repo

**Files:**
- Create: Next.js scaffold at repo root, `vitest.config.ts`, `.env.example`, `.env.local`
- Modify: `package.json` (scripts), `.gitignore`

**Interfaces:**
- Produces: `npm test` (vitest), `npm run dev`, path alias `@/*` → `src/*`, working git repo rooted here.

- [ ] **Step 1: Init dedicated repo** (parent home-dir repo stays untouched; nested repo takes over)

```powershell
Set-Location C:\Users\jhpyo\Desktop\INVESTOR-LLM
git init -b main
```

- [ ] **Step 2: Scaffold Next.js** (create-next-app refuses unknown dirs — temporarily move `docs`)

```powershell
Rename-Item docs ..\_investor_docs_tmp
npx create-next-app@latest . --typescript --tailwind --app --src-dir --use-npm --no-eslint --import-alias "@/*" --yes
Move-Item ..\_investor_docs_tmp .\docs
```

- [ ] **Step 3: Install deps**

```powershell
npm install zod openai fflate
npm install -D vitest tsx
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
```

- [ ] **Step 5: Add npm scripts** — merge into `package.json` `"scripts"`:

```json
{
  "test": "vitest run",
  "smoke": "tsx --env-file=.env.local scripts/smoke.ts",
  "build:listings": "tsx --env-file=.env.local scripts/build-listings.ts"
}
```

- [ ] **Step 6: Create `.env.example`** (committed) **and `.env.local`** (real keys, NOT committed — verify `.gitignore` from create-next-app contains `.env*`; it does by default, but `.env.example` must be force-added or the pattern adjusted to `.env*.local`):

```bash
# .env.example
NVIDIA_API_KEY=nvapi-xxxx
DART_API_KEY=xxxx
TAVILY_API_KEY=tvly-xxxx
NIM_MODEL=qwen/qwen3-235b-a22b
```

In `.gitignore`, replace the `.env*` line with `.env*.local` so `.env.example` is trackable.

- [ ] **Step 7: Verify**

Run: `npm run dev` → localhost:3000 renders Next starter. Ctrl-C.
Run: `npm test` → "no test files found" exit 0 (or trivial pass).

- [ ] **Step 8: Commit**

```powershell
git add -A
git commit -m "chore: scaffold Next.js app with vitest, tsx, env template"
```

---

### Task 2: Listings build script + search helper

**Files:**
- Create: `scripts/build-listings.ts`, `src/lib/listings.ts`, `src/lib/listings.test.ts`
- Generated (committed): `data/listings.json`

**Interfaces:**
- Produces: `searchListings(q: string, limit?: number): Listing[]`, `findByTicker(ticker: string): Listing | undefined` where `Listing = { name: string; ticker: string; corpCode: string }`. `data/listings.json` = `Listing[]`.

- [ ] **Step 1: Write `scripts/build-listings.ts`**

```ts
import { unzipSync, strFromU8 } from "fflate";
import { writeFileSync, mkdirSync } from "node:fs";

async function main() {
  const key = process.env.DART_API_KEY;
  if (!key) throw new Error("DART_API_KEY missing");
  const res = await fetch(
    `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${key}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!res.ok) throw new Error(`DART corpCode HTTP ${res.status}`);
  const zip = new Uint8Array(await res.arrayBuffer());
  const xml = strFromU8(unzipSync(zip)["CORPCODE.xml"]);

  const listings = [...xml.matchAll(/<list>([\s\S]*?)<\/list>/g)]
    .map((m) => {
      const g = (tag: string) =>
        m[1].match(new RegExp(`<${tag}>(.*?)</${tag}>`))?.[1]?.trim() ?? "";
      return { name: g("corp_name"), ticker: g("stock_code"), corpCode: g("corp_code") };
    })
    .filter((c) => /^\d{6}$/.test(c.ticker));

  mkdirSync("data", { recursive: true });
  writeFileSync("data/listings.json", JSON.stringify(listings), "utf8");
  console.log(`wrote data/listings.json: ${listings.length} listed companies`);
}
main();
```

- [ ] **Step 2: Run it**

Run: `npm run build:listings`
Expected: `wrote data/listings.json: <N> listed companies` with N roughly 2500–3800. Spot-check: open the file, search `005930` → 삼성전자 present with 8-digit corpCode.

- [ ] **Step 3: Write failing test `src/lib/listings.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { searchListings, findByTicker } from "./listings";

describe("listings", () => {
  it("finds 삼성전자 by name", () => {
    const hits = searchListings("삼성전자");
    expect(hits.some((h) => h.ticker === "005930")).toBe(true);
  });
  it("finds by ticker prefix", () => {
    expect(searchListings("005930")[0]?.name).toContain("삼성전자");
  });
  it("caps results", () => {
    expect(searchListings("삼성", 5)).toHaveLength(5);
  });
  it("findByTicker returns corpCode", () => {
    expect(findByTicker("005930")?.corpCode).toMatch(/^\d{8}$/);
  });
  it("empty query returns empty", () => {
    expect(searchListings("  ")).toEqual([]);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./listings`.

- [ ] **Step 5: Write `src/lib/listings.ts`**

```ts
import raw from "../../data/listings.json";

export type Listing = { name: string; ticker: string; corpCode: string };

const listings = raw as Listing[];

export function searchListings(q: string, limit = 8): Listing[] {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  return listings
    .filter((c) => c.name.toLowerCase().includes(query) || c.ticker.startsWith(query))
    .slice(0, limit);
}

export function findByTicker(ticker: string): Listing | undefined {
  return listings.find((c) => c.ticker === ticker);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test` → PASS (5 tests).

- [ ] **Step 7: Commit**

```powershell
git add scripts/build-listings.ts src/lib/listings.ts src/lib/listings.test.ts data/listings.json
git commit -m "feat: DART corp-code listings build script and search helper"
```

---

### Task 3: Tool infrastructure (types, http helper, registry)

**Files:**
- Create: `src/tools/types.ts`, `src/tools/http.ts`, `src/tools/index.ts`, `src/tools/index.test.ts`

**Interfaces:**
- Produces:
  - `type ToolResult = { ok: true; data: unknown } | { ok: false; error: string }`
  - `interface Tool { name: string; description: string; schema: z.ZodType; run(args: unknown): Promise<ToolResult> }`
  - `toOpenAITool(t: Tool)` → OpenAI function-tool JSON
  - `fetchJson(url, init?, timeoutMs=10000): Promise<unknown>` (throws on non-2xx/timeout)
  - `runTool(name: string, args: unknown): Promise<ToolResult>` (never throws)
  - `toolRegistry: Record<string, Tool>`
- Consumed by: every tool (Tasks 4–7), engine (Task 9).

- [ ] **Step 1: Write `src/tools/types.ts`**

```ts
import { z } from "zod";

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

export interface Tool {
  name: string;
  description: string;
  schema: z.ZodType;
  run(args: unknown): Promise<ToolResult>;
}

export function toOpenAITool(t: Tool) {
  return {
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: z.toJSONSchema(t.schema),
    },
  };
}
```

- [ ] **Step 2: Write `src/tools/http.ts`**

```ts
export async function fetchJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: {
      // Naver/Yahoo endpoints reject default undici UA
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      ...init.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
```

- [ ] **Step 3: Write failing test `src/tools/index.test.ts`** (registry is the app's error boundary for tools — test it hard)

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registerTools, runTool } from "./index";
import type { Tool } from "./types";

const echo: Tool = {
  name: "echo",
  description: "echoes",
  schema: z.object({ msg: z.string() }),
  run: async (args) => ({ ok: true, data: args }),
};
const boom: Tool = {
  name: "boom",
  description: "throws",
  schema: z.object({}),
  run: async () => {
    throw new Error("kaput");
  },
};

describe("runTool", () => {
  registerTools([echo, boom]);
  it("runs a tool with valid args", async () => {
    expect(await runTool("echo", { msg: "hi" })).toEqual({ ok: true, data: { msg: "hi" } });
  });
  it("rejects invalid args without throwing", async () => {
    const r = await runTool("echo", { msg: 42 });
    expect(r.ok).toBe(false);
  });
  it("converts thrown errors to ToolResult", async () => {
    expect(await runTool("boom", {})).toEqual({ ok: false, error: "kaput" });
  });
  it("handles unknown tool", async () => {
    const r = await runTool("nope", {});
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test` → FAIL — `./index` has no `registerTools`.

- [ ] **Step 5: Write `src/tools/index.ts`**

```ts
import type { Tool, ToolResult } from "./types";

export const toolRegistry: Record<string, Tool> = {};

export function registerTools(tools: Tool[]) {
  for (const t of tools) toolRegistry[t.name] = t;
}

export async function runTool(name: string, args: unknown): Promise<ToolResult> {
  const tool = toolRegistry[name];
  if (!tool) return { ok: false, error: `unknown tool: ${name}` };
  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) return { ok: false, error: `invalid args: ${parsed.error.message}` };
  try {
    return await tool.run(parsed.data);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
```

(Real tools self-register in Task 7's final step; `registerTools` keeps tests isolated.)

- [ ] **Step 6: Run tests** → `npm test` PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/tools
git commit -m "feat: tool interface, http helper, and error-safe registry"
```

---

### Task 4: `search_disclosures` tool (DART)

**Files:**
- Create: `src/tools/disclosures.ts`, `src/tools/disclosures.test.ts`

**Interfaces:**
- Produces: `searchDisclosures: Tool` (name `"search_disclosures"`). Args `{ corpCode?, dateFrom: "YYYYMMDD", dateTo: "YYYYMMDD" }`. Success data: `{ count: number; filings: { corp: string; ticker: string; title: string; filedAt: string; filer: string; url: string }[] }`.

- [ ] **Step 1: Write failing test `src/tools/disclosures.test.ts`** (mock `fetchJson`; live call happens in smoke script, not unit tests)

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./http", () => ({ fetchJson: vi.fn() }));
import { fetchJson } from "./http";
import { searchDisclosures } from "./disclosures";

const mocked = vi.mocked(fetchJson);
beforeEach(() => mocked.mockReset());

describe("search_disclosures", () => {
  it("maps DART response to filings", async () => {
    mocked.mockResolvedValue({
      status: "000",
      message: "정상",
      list: [
        {
          corp_name: "삼성전자",
          stock_code: "005930",
          report_nm: "단일판매ㆍ공급계약체결",
          rcept_no: "20260717000123",
          flr_nm: "삼성전자",
          rcept_dt: "20260717",
        },
      ],
    });
    const r = await searchDisclosures.run({ dateFrom: "20260717", dateTo: "20260718" });
    expect(r).toEqual({
      ok: true,
      data: {
        count: 1,
        filings: [
          {
            corp: "삼성전자",
            ticker: "005930",
            title: "단일판매ㆍ공급계약체결",
            filedAt: "20260717",
            filer: "삼성전자",
            url: "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260717000123",
          },
        ],
      },
    });
  });

  it("treats DART status 013 (no data) as empty success", async () => {
    mocked.mockResolvedValue({ status: "013", message: "조회된 데이타가 없습니다." });
    const r = await searchDisclosures.run({ dateFrom: "20260717", dateTo: "20260717" });
    expect(r).toEqual({ ok: true, data: { count: 0, filings: [] } });
  });

  it("surfaces other DART error statuses", async () => {
    mocked.mockResolvedValue({ status: "020", message: "요청 제한 초과" });
    const r = await searchDisclosures.run({ dateFrom: "20260717", dateTo: "20260717" });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test** → FAIL, `./disclosures` missing.

- [ ] **Step 3: Write `src/tools/disclosures.ts`**

```ts
import { z } from "zod";
import { fetchJson } from "./http";
import type { Tool } from "./types";

const argsSchema = z.object({
  corpCode: z
    .string()
    .regex(/^\d{8}$/)
    .optional()
    .describe("DART 고유번호(8자리). 특정 기업의 공시만 조회할 때 지정"),
  dateFrom: z.string().regex(/^\d{8}$/).describe("조회 시작일 YYYYMMDD"),
  dateTo: z.string().regex(/^\d{8}$/).describe("조회 종료일 YYYYMMDD"),
});

const dartResponse = z.object({
  status: z.string(),
  message: z.string(),
  list: z
    .array(
      z.object({
        corp_name: z.string(),
        stock_code: z.string(),
        report_nm: z.string(),
        rcept_no: z.string(),
        flr_nm: z.string(),
        rcept_dt: z.string(),
      }),
    )
    .optional(),
});

export const searchDisclosures: Tool = {
  name: "search_disclosures",
  description:
    "DART 전자공시 검색. 기간(YYYYMMDD)과 선택적으로 기업(corpCode)을 지정해 공시 목록을 반환한다. 계약, 유상증자, 블록딜, 시설투자 등 주요 공시 확인용.",
  schema: argsSchema,
  async run(args) {
    const { corpCode, dateFrom, dateTo } = args as z.infer<typeof argsSchema>;
    const params = new URLSearchParams({
      crtfc_key: process.env.DART_API_KEY ?? "",
      bgn_de: dateFrom,
      end_de: dateTo,
      page_count: "100",
    });
    if (corpCode) params.set("corp_code", corpCode);

    const raw = await fetchJson(`https://opendart.fss.or.kr/api/list.json?${params}`);
    const parsed = dartResponse.parse(raw);

    if (parsed.status === "013")
      return { ok: true, data: { count: 0, filings: [] } };
    if (parsed.status !== "000")
      return { ok: false, error: `DART ${parsed.status}: ${parsed.message}` };

    const filings = (parsed.list ?? []).slice(0, 50).map((f) => ({
      corp: f.corp_name,
      ticker: f.stock_code,
      title: f.report_nm,
      filedAt: f.rcept_dt,
      filer: f.flr_nm,
      url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${f.rcept_no}`,
    }));
    return { ok: true, data: { count: filings.length, filings } };
  },
};
```

- [ ] **Step 4: Run tests** → `npm test` PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/tools/disclosures.ts src/tools/disclosures.test.ts
git commit -m "feat: search_disclosures tool over DART OpenAPI"
```

---

### Task 5: `get_stock_data` tool (Naver Finance)

**Files:**
- Create: `src/tools/stock.ts`, `src/tools/stock.test.ts`

**Interfaces:**
- Produces: `getStockData: Tool` (name `"get_stock_data"`). Args `{ ticker: string }`. Success data: `{ name, price: { close: number; changeRate: number }, fundamentals: Record<string, string>, flows: { date: string; foreign: number; institution: number; individual: number }[] }` (flows = 최근 10 거래일 순매수량).

- [ ] **Step 1: VERIFY ENDPOINTS FIRST** — schemas below are best-guess; correct them against reality before writing code:

```powershell
curl.exe -s -A "Mozilla/5.0" "https://m.stock.naver.com/api/stock/005930/basic" | Out-File -Encoding utf8 tmp-basic.json
curl.exe -s -A "Mozilla/5.0" "https://m.stock.naver.com/api/stock/005930/trend?pageSize=10" | Out-File -Encoding utf8 tmp-trend.json
curl.exe -s -A "Mozilla/5.0" "https://m.stock.naver.com/api/stock/005930/integration" | Out-File -Encoding utf8 tmp-integration.json
```

Open the three tmp files. Expected fields (adjust code in Step 3 to what you actually see, then delete tmp files):
- basic: `stockName`, `closePrice` ("71,300" comma-string), `fluctuationsRatio`
- trend: array items with `bizdate`, `foreignerPureBuyQuant`, `organPureBuyQuant`, `individualPureBuyQuant`
- integration: `totalInfos` array of `{ code, key, value }` (PER, PBR, 시가총액 등)

If an endpoint 404s, find the working one by opening `https://m.stock.naver.com/domestic/stock/005930/total` in a browser with DevTools network tab; the page calls its own JSON APIs.

- [ ] **Step 2: Write failing test `src/tools/stock.test.ts`** (fixtures = trimmed copies of real responses from Step 1; shape shown here assumes the expected fields — sync with reality)

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./http", () => ({ fetchJson: vi.fn() }));
import { fetchJson } from "./http";
import { getStockData } from "./stock";

const mocked = vi.mocked(fetchJson);
beforeEach(() => mocked.mockReset());

const basic = { stockName: "삼성전자", closePrice: "71,300", fluctuationsRatio: "-1.25" };
const trend = [
  {
    bizdate: "20260717",
    foreignerPureBuyQuant: "-1,234,567",
    organPureBuyQuant: "890,123",
    individualPureBuyQuant: "344,444",
  },
];
const integration = { totalInfos: [{ code: "per", key: "PER", value: "12.3배" }] };

describe("get_stock_data", () => {
  it("normalizes price, flows, fundamentals", async () => {
    mocked.mockImplementation(async (url: string) => {
      if (url.includes("/basic")) return basic;
      if (url.includes("/trend")) return trend;
      return integration;
    });
    const r = await getStockData.run({ ticker: "005930" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as any;
    expect(d.name).toBe("삼성전자");
    expect(d.price.close).toBe(71300);
    expect(d.flows[0].foreign).toBe(-1234567);
    expect(d.fundamentals.PER).toBe("12.3배");
  });
});
```

- [ ] **Step 3: Write `src/tools/stock.ts`** (adjust zod fields to Step 1 findings)

```ts
import { z } from "zod";
import { fetchJson } from "./http";
import type { Tool } from "./types";

const argsSchema = z.object({
  ticker: z.string().regex(/^\d{6}$/).describe("한국 상장기업 종목코드 6자리, 예: 005930"),
});

const num = (s: string | number) =>
  typeof s === "number" ? s : Number(String(s).replace(/,/g, ""));

const basicSchema = z.looseObject({
  stockName: z.string(),
  closePrice: z.string(),
  fluctuationsRatio: z.string(),
});
const trendSchema = z.array(
  z.looseObject({
    bizdate: z.string(),
    foreignerPureBuyQuant: z.union([z.string(), z.number()]),
    organPureBuyQuant: z.union([z.string(), z.number()]),
    individualPureBuyQuant: z.union([z.string(), z.number()]),
  }),
);
const integrationSchema = z.looseObject({
  totalInfos: z.array(z.looseObject({ key: z.string(), value: z.string() })),
});

const BASE = "https://m.stock.naver.com/api/stock";

export const getStockData: Tool = {
  name: "get_stock_data",
  description:
    "한국 주식의 현재가, 등락률, PER/PBR 등 기본 지표, 최근 10거래일 외국인/기관/개인 순매수(수급)를 반환한다.",
  schema: argsSchema,
  async run(args) {
    const { ticker } = args as z.infer<typeof argsSchema>;
    const [basic, trend, integration] = await Promise.all([
      fetchJson(`${BASE}/${ticker}/basic`).then((r) => basicSchema.parse(r)),
      fetchJson(`${BASE}/${ticker}/trend?pageSize=10`).then((r) => trendSchema.parse(r)),
      fetchJson(`${BASE}/${ticker}/integration`).then((r) => integrationSchema.parse(r)),
    ]);
    return {
      ok: true,
      data: {
        name: basic.stockName,
        price: { close: num(basic.closePrice), changeRate: num(basic.fluctuationsRatio) },
        fundamentals: Object.fromEntries(integration.totalInfos.map((i) => [i.key, i.value])),
        flows: trend.map((t) => ({
          date: t.bizdate,
          foreign: num(t.foreignerPureBuyQuant),
          institution: num(t.organPureBuyQuant),
          individual: num(t.individualPureBuyQuant),
        })),
      },
    };
  },
};
```

- [ ] **Step 4: Run tests** → `npm test` PASS.

- [ ] **Step 5: Live check** (one-off, proves schema matches reality):

```powershell
npx tsx --env-file=.env.local -e "import('./src/tools/stock.ts').then(async m => console.log(JSON.stringify(await m.getStockData.run({ticker:'005930'}), null, 2)))"
```

Expected: `ok: true` with real 삼성전자 numbers. If zod throws → fix schema, rerun.

- [ ] **Step 6: Commit**

```powershell
git add src/tools/stock.ts src/tools/stock.test.ts
git commit -m "feat: get_stock_data tool over Naver Finance mobile API"
```

---

### Task 6: `get_market_overview` tool (Yahoo chart API)

**Files:**
- Create: `src/tools/market.ts`, `src/tools/market.test.ts`

**Interfaces:**
- Produces: `getMarketOverview: Tool` (name `"get_market_overview"`). Args `{ date: "YYYY-MM-DD" }`. Success data: `Record<"kospi"|"kosdaq"|"sp500"|"nasdaq"|"usdkrw"|"wti"|"us10y", { close: number; changePct: number; asOf: string } | null>` (null = no bar found near date; partial data is success, agent narrates gaps).

- [ ] **Step 1: Verify endpoint**

```powershell
curl.exe -s -A "Mozilla/5.0" "https://query1.finance.yahoo.com/v8/finance/chart/%5EKS11?range=2mo&interval=1d" | Out-File -Encoding utf8 tmp-yahoo.json
```

Expected shape: `chart.result[0].timestamp: number[]` + `chart.result[0].indicators.quote[0].close: (number|null)[]`. Adjust Step 3 schema if different. Delete tmp file after.

- [ ] **Step 2: Write failing test `src/tools/market.test.ts`**

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./http", () => ({ fetchJson: vi.fn() }));
import { fetchJson } from "./http";
import { getMarketOverview } from "./market";

const mocked = vi.mocked(fetchJson);
beforeEach(() => mocked.mockReset());

// two bars: 2026-07-16 close 100, 2026-07-17 close 110
const chart = (t1: number, t2: number) => ({
  chart: {
    result: [
      { timestamp: [t1, t2], indicators: { quote: [{ close: [100, 110] }] } },
    ],
  },
});
const day = (s: string) => Math.floor(new Date(s).getTime() / 1000);

describe("get_market_overview", () => {
  it("picks bar on/before date and computes change", async () => {
    mocked.mockResolvedValue(chart(day("2026-07-16T06:00:00Z"), day("2026-07-17T06:00:00Z")));
    const r = await getMarketOverview.run({ date: "2026-07-17" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const kospi = (r.data as any).kospi;
    expect(kospi.close).toBe(110);
    expect(kospi.changePct).toBeCloseTo(10);
  });

  it("returns null for a symbol whose fetch fails, still ok overall", async () => {
    mocked.mockRejectedValue(new Error("down"));
    const r = await getMarketOverview.run({ date: "2026-07-17" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.data as any).kospi).toBeNull();
  });
});
```

- [ ] **Step 3: Write `src/tools/market.ts`**

```ts
import { z } from "zod";
import { fetchJson } from "./http";
import type { Tool } from "./types";

const argsSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("기준일 YYYY-MM-DD (최근 30일 이내)"),
});

const SYMBOLS = {
  kospi: "^KS11",
  kosdaq: "^KQ11",
  sp500: "^GSPC",
  nasdaq: "^IXIC",
  usdkrw: "KRW=X",
  wti: "CL=F",
  us10y: "^TNX",
} as const;

const chartSchema = z.object({
  chart: z.object({
    result: z.array(
      z.object({
        timestamp: z.array(z.number()),
        indicators: z.object({
          quote: z.array(z.object({ close: z.array(z.number().nullable()) })),
        }),
      }),
    ),
  }),
});

type Quote = { close: number; changePct: number; asOf: string };

async function quoteOnOrBefore(symbol: string, date: string): Promise<Quote | null> {
  try {
    const raw = await fetchJson(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2mo&interval=1d`,
    );
    const r = chartSchema.parse(raw).chart.result[0];
    const closes = r.indicators.quote[0].close;
    // bars whose UTC date <= requested date, with non-null close
    const bars = r.timestamp
      .map((t, i) => ({ day: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] }))
      .filter((b): b is { day: string; close: number } => b.close != null && b.day <= date);
    if (bars.length === 0) return null;
    const cur = bars[bars.length - 1];
    const prev = bars[bars.length - 2];
    return {
      close: cur.close,
      changePct: prev ? ((cur.close - prev.close) / prev.close) * 100 : 0,
      asOf: cur.day,
    };
  } catch {
    return null; // partial data is fine; agent narrates the gap
  }
}

export const getMarketOverview: Tool = {
  name: "get_market_overview",
  description:
    "기준일의 시장 개요: KOSPI/KOSDAQ, S&P500/나스닥, 원달러 환율, WTI 유가, 미국 10년물 금리의 종가와 등락률.",
  schema: argsSchema,
  async run(args) {
    const { date } = args as z.infer<typeof argsSchema>;
    const entries = await Promise.all(
      Object.entries(SYMBOLS).map(async ([k, sym]) => [k, await quoteOnOrBefore(sym, date)] as const),
    );
    return { ok: true, data: Object.fromEntries(entries) };
  },
};
```

- [ ] **Step 4: Run tests** → `npm test` PASS.

- [ ] **Step 5: Live check**

```powershell
npx tsx --env-file=.env.local -e "import('./src/tools/market.ts').then(async m => console.log(JSON.stringify(await m.getMarketOverview.run({date:new Date().toISOString().slice(0,10)}), null, 2)))"
```

Expected: `ok: true`, plausible numbers for at least 5 of 7 symbols.

- [ ] **Step 6: Commit**

```powershell
git add src/tools/market.ts src/tools/market.test.ts
git commit -m "feat: get_market_overview tool over Yahoo chart API"
```

---

### Task 7: `web_search` tool (Tavily) + register all tools

**Files:**
- Create: `src/tools/search.ts`, `src/tools/search.test.ts`
- Modify: `src/tools/index.ts` (register real tools)

**Interfaces:**
- Produces: `webSearch: Tool` (name `"web_search"`). Args `{ query: string; maxResults?: number }` (maxResults capped at 5). Success data: `{ results: { title: string; url: string; content: string }[] }`. Also: importing `@/tools/index` now has all 4 real tools registered.

- [ ] **Step 1: Write failing test `src/tools/search.test.ts`**

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const fetchSpy = vi.fn();
vi.stubGlobal("fetch", fetchSpy);
import { webSearch } from "./search";

beforeEach(() => fetchSpy.mockReset());

describe("web_search", () => {
  it("maps tavily results", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ title: "t", url: "u", content: "c", score: 0.9 }],
      }),
    });
    const r = await webSearch.run({ query: "삼성전자 실적" });
    expect(r).toEqual({ ok: true, data: { results: [{ title: "t", url: "u", content: "c" }] } });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.max_results).toBeLessThanOrEqual(5);
  });

  it("returns error result on HTTP failure", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 432 });
    const r = await webSearch.run({ query: "x" });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test** → FAIL, `./search` missing.

- [ ] **Step 3: Write `src/tools/search.ts`**

```ts
import { z } from "zod";
import type { Tool } from "./types";

const argsSchema = z.object({
  query: z.string().min(2).describe("검색어. 한국어 또는 영어"),
  maxResults: z.number().int().min(1).max(5).optional().describe("결과 수 (기본 5)"),
});

const responseSchema = z.object({
  results: z.array(
    z.looseObject({ title: z.string(), url: z.string(), content: z.string() }),
  ),
});

export const webSearch: Tool = {
  name: "web_search",
  description:
    "웹 검색. 뉴스, 증권사 리포트 헤드라인, 시장 이슈 등 실시간 정보가 필요할 때 사용한다.",
  schema: argsSchema,
  async run(args) {
    const { query, maxResults } = args as z.infer<typeof argsSchema>;
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
      },
      body: JSON.stringify({ query, max_results: Math.min(maxResults ?? 5, 5) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, error: `tavily HTTP ${res.status}` };
    const parsed = responseSchema.parse(await res.json());
    return {
      ok: true,
      data: { results: parsed.results.map(({ title, url, content }) => ({ title, url, content })) },
    };
  },
};
```

- [ ] **Step 4: Register all real tools** — append to `src/tools/index.ts`:

```ts
import { searchDisclosures } from "./disclosures";
import { getStockData } from "./stock";
import { getMarketOverview } from "./market";
import { webSearch } from "./search";

registerTools([searchDisclosures, getStockData, getMarketOverview, webSearch]);
export { searchDisclosures, getStockData, getMarketOverview, webSearch };
```

(Move the `registerTools` function definition above this block. The Task 3 test still passes — re-registering `echo`/`boom` on top is additive.)

- [ ] **Step 5: Run tests** → `npm test` PASS (all files).

- [ ] **Step 6: Commit**

```powershell
git add src/tools
git commit -m "feat: web_search tool via Tavily; register all tools"
```

---

### Task 8: NVIDIA NIM client wrapper

**Files:**
- Create: `src/agent/nim.ts`

**Interfaces:**
- Produces: `MODEL: string` (env `NIM_MODEL`, default `"qwen/qwen3-235b-a22b"`), `nimClient(): OpenAI`, `createChatStream(client, params): Promise<Stream>` — one retry on creation failure. Consumed by engine (Task 9).

- [ ] **Step 1: Write `src/agent/nim.ts`** (thin; behavior is covered by engine tests with a mocked client — no separate unit test)

```ts
import OpenAI from "openai";

export const MODEL = process.env.NIM_MODEL ?? "qwen/qwen3-235b-a22b";

export function nimClient(): OpenAI {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY missing");
  return new OpenAI({ apiKey, baseURL: "https://integrate.api.nvidia.com/v1" });
}

type ChatParams = Omit<OpenAI.ChatCompletionCreateParamsStreaming, "model" | "stream">;

export async function createChatStream(client: OpenAI, params: ChatParams) {
  const make = () =>
    client.chat.completions.create({
      model: MODEL,
      stream: true,
      temperature: 0.3,
      ...params,
      // qwen3: disable thinking-mode <think> blocks; verified in Task 11 smoke
      // @ts-expect-error NIM extension
      chat_template_kwargs: { thinking: false },
    });
  try {
    return await make();
  } catch {
    return await make(); // one retry on transient failure
  }
}
```

- [ ] **Step 2: Compile check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```powershell
git add src/agent/nim.ts
git commit -m "feat: NVIDIA NIM client wrapper with retry"
```

---

### Task 9: ReAct engine

**Files:**
- Create: `src/agent/engine.ts`, `src/agent/engine.test.ts`

**Interfaces:**
- Consumes: `createChatStream`, `MODEL` (Task 8); `toOpenAITool`, `ToolResult` (Task 3); `runTool` (Task 3).
- Produces:

```ts
type AgentEvent =
  | { type: "token"; text: string }
  | { type: "action"; tool: string; args: unknown }
  | { type: "observation"; tool: string; result: ToolResult }
  | { type: "done" }
  | { type: "error"; message: string; retryable: boolean };

type SpecialistConfig = { key: string; systemPrompt: string; tools: Tool[] };

runAgent(config: SpecialistConfig, history: ChatMessage[], deps?): AsyncGenerator<AgentEvent>
```

  `deps = { client, runTool }` for test injection. Streamed `token`s that precede an `action` are that step's "thought" — clients reclassify on receiving `action` (spec deviation #1).

- [ ] **Step 1: Write failing test `src/agent/engine.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runAgent, type AgentEvent } from "./engine";

// fabricate an OpenAI-style async-iterable stream from delta chunks
function makeStream(deltas: any[]) {
  return (async function* () {
    for (const delta of deltas) yield { choices: [{ delta }] };
  })();
}
const text = (t: string) => ({ content: t });
const call = (id: string, name: string, args: string) => ({
  tool_calls: [{ index: 0, id, function: { name, arguments: args } }],
});

const config = {
  key: "test",
  systemPrompt: "sys",
  tools: [
    { name: "get_stock_data", description: "d", schema: z.object({ ticker: z.string() }), run: async () => ({ ok: true as const, data: {} }) },
  ],
};

async function collect(gen: AsyncGenerator<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe("runAgent", () => {
  it("runs tool-call turn then answer turn", async () => {
    const streams = [
      makeStream([text("시세 확인. "), call("c1", "get_stock_data", '{"ticker":"005930"}')]),
      makeStream([text("삼성전자는 "), text("보합입니다.")]),
    ];
    const client = { chat: { completions: { create: vi.fn(async () => streams.shift()) } } };
    const runTool = vi.fn(async () => ({ ok: true as const, data: { close: 71300 } }));

    const events = await collect(runAgent(config as any, [{ role: "user", content: "삼성전자?" }], { client: client as any, runTool }));

    expect(events.map((e) => e.type)).toEqual([
      "token", "action", "observation", "token", "token", "done",
    ]);
    expect(runTool).toHaveBeenCalledWith("get_stock_data", { ticker: "005930" });
    // tool result was appended as a tool message for turn 2
    const secondCallMessages = client.chat.completions.create.mock.calls[1][0].messages;
    expect(secondCallMessages.at(-1).role).toBe("tool");
  });

  it("feeds malformed tool-call JSON back as failed observation", async () => {
    const streams = [
      makeStream([call("c1", "get_stock_data", "{broken")]),
      makeStream([text("데이터 조회 실패로 일반 답변.")]),
    ];
    const client = { chat: { completions: { create: vi.fn(async () => streams.shift()) } } };
    const runTool = vi.fn();

    const events = await collect(runAgent(config as any, [{ role: "user", content: "x" }], { client: client as any, runTool }));
    const obs = events.find((e) => e.type === "observation") as any;
    expect(obs.result.ok).toBe(false);
    expect(runTool).not.toHaveBeenCalled();
  });

  it("disables tools on final iteration (forces text answer)", async () => {
    const toolTurn = () => makeStream([call("c1", "get_stock_data", '{"ticker":"005930"}')]);
    const streams = [toolTurn(), toolTurn(), toolTurn(), toolTurn(), toolTurn(), makeStream([text("최종 요약.")])];
    const client = { chat: { completions: { create: vi.fn(async () => streams.shift()) } } };
    const runTool = vi.fn(async () => ({ ok: true as const, data: {} }));

    const events = await collect(runAgent(config as any, [{ role: "user", content: "x" }], { client: client as any, runTool }));
    expect(events.at(-1)!.type).toBe("done");
    const lastParams = client.chat.completions.create.mock.calls.at(-1)![0];
    expect(lastParams.tools).toBeUndefined();
  });

  it("emits retryable error when the LLM call fails twice", async () => {
    const client = { chat: { completions: { create: vi.fn(async () => { throw new Error("502"); }) } } };
    const events = await collect(runAgent(config as any, [{ role: "user", content: "x" }], { client: client as any, runTool: vi.fn() }));
    expect(events).toEqual([{ type: "error", message: "502", retryable: true }]);
  });
});
```

- [ ] **Step 2: Run test** → FAIL, `./engine` missing.

- [ ] **Step 3: Write `src/agent/engine.ts`**

```ts
import type OpenAI from "openai";
import { createChatStream, nimClient } from "./nim";
import { toOpenAITool, type Tool, type ToolResult } from "@/tools/types";
import { runTool as defaultRunTool } from "@/tools/index";

export type AgentEvent =
  | { type: "token"; text: string }
  | { type: "action"; tool: string; args: unknown }
  | { type: "observation"; tool: string; result: ToolResult }
  | { type: "done" }
  | { type: "error"; message: string; retryable: boolean };

export type SpecialistConfig = { key: string; systemPrompt: string; tools: Tool[] };
export type ChatMessage = OpenAI.ChatCompletionMessageParam;

type Deps = {
  client: OpenAI;
  runTool: (name: string, args: unknown) => Promise<ToolResult>;
};

const MAX_ITERATIONS = 6;
const MAX_OBSERVATION_CHARS = 4000;

export async function* runAgent(
  config: SpecialistConfig,
  history: ChatMessage[],
  deps?: Partial<Deps>,
): AsyncGenerator<AgentEvent> {
  const client = deps?.client ?? nimClient();
  const runTool = deps?.runTool ?? defaultRunTool;

  const messages: ChatMessage[] = [
    { role: "system", content: config.systemPrompt },
    ...history,
  ];
  const tools = config.tools.map(toOpenAITool);

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const finalTurn = i === MAX_ITERATIONS - 1;

    let stream;
    try {
      stream = await createChatStream(client, {
        messages,
        ...(finalTurn ? {} : { tools }),
      });
    } catch (e) {
      yield { type: "error", message: e instanceof Error ? e.message : String(e), retryable: true };
      return;
    }

    let content = "";
    const calls: { id: string; name: string; args: string }[] = [];
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        yield { type: "token", text: delta.content };
      }
      for (const tc of delta.tool_calls ?? []) {
        calls[tc.index] ??= { id: tc.id ?? "", name: "", args: "" };
        if (tc.id) calls[tc.index].id = tc.id;
        if (tc.function?.name) calls[tc.index].name += tc.function.name;
        if (tc.function?.arguments) calls[tc.index].args += tc.function.arguments;
      }
    }

    if (calls.length === 0) {
      yield { type: "done" };
      return;
    }

    messages.push({
      role: "assistant",
      content: content || null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.args },
      })),
    });

    for (const c of calls) {
      let result: ToolResult;
      try {
        const args = JSON.parse(c.args || "{}");
        yield { type: "action", tool: c.name, args };
        result = await runTool(c.name, args);
      } catch {
        yield { type: "action", tool: c.name, args: c.args };
        result = { ok: false, error: `malformed tool arguments: ${c.args}` };
      }
      yield { type: "observation", tool: c.name, result };
      messages.push({
        role: "tool",
        tool_call_id: c.id,
        content: JSON.stringify(result).slice(0, MAX_OBSERVATION_CHARS),
      });
    }
  }

  yield { type: "done" }; // unreachable in practice (final turn has no tools), kept as guard
}
```

- [ ] **Step 4: Run tests** → `npm test` PASS (all 4 engine tests).

Note: the error test relies on `createChatStream`'s internal retry (call count 2) — if the mock counts once, check that `createChatStream` is being used, not a raw `client.chat.completions.create`.

- [ ] **Step 5: Commit**

```powershell
git add src/agent/engine.ts src/agent/engine.test.ts
git commit -m "feat: hand-rolled streaming ReAct engine over NIM"
```

---

### Task 10: Specialists + orchestrator

**Files:**
- Create: `src/agent/specialists.ts`, `src/agent/orchestrator.ts`, `src/agent/orchestrator.test.ts`

**Interfaces:**
- Consumes: tools (Tasks 4–7), `SpecialistConfig` (Task 9), `findByTicker` (Task 2).
- Produces:
  - `specialists: Record<SpecialistKey, SpecialistConfig>` with keys `company_analysis | broker_view | macro | daily_reports | disclosures | flows`
  - `type AnalysisRequest = { mode: "company" | "date"; target: string; option: "A" | "B" | "C" | "D" }`
  - `route(req: AnalysisRequest): SpecialistConfig | undefined`
  - `buildInitialMessage(req: AnalysisRequest): string` (throws if company ticker unknown)
- PortfolioAnalyst intentionally absent — Plan 3 (needs Supabase).

- [ ] **Step 1: Write failing test `src/agent/orchestrator.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { route, buildInitialMessage } from "./orchestrator";

describe("orchestrator routing", () => {
  it.each([
    ["company", "A", "company_analysis"],
    ["company", "B", "broker_view"],
    ["date", "A", "macro"],
    ["date", "B", "daily_reports"],
    ["date", "C", "disclosures"],
    ["date", "D", "flows"],
  ] as const)("%s option %s -> %s", (mode, option, key) => {
    expect(route({ mode, target: mode === "company" ? "005930" : "2026-07-17", option })?.key).toBe(key);
  });

  it("unknown combo routes nowhere", () => {
    expect(route({ mode: "company", target: "005930", option: "C" })).toBeUndefined();
  });

  it("company message includes name, ticker, corpCode", () => {
    const msg = buildInitialMessage({ mode: "company", target: "005930", option: "A" });
    expect(msg).toContain("삼성전자");
    expect(msg).toContain("005930");
    expect(msg).toMatch(/\d{8}/);
  });

  it("date message includes the date", () => {
    expect(buildInitialMessage({ mode: "date", target: "2026-07-17", option: "A" })).toContain("2026-07-17");
  });

  it("unknown ticker throws", () => {
    expect(() => buildInitialMessage({ mode: "company", target: "000000", option: "A" })).toThrow();
  });
});
```

- [ ] **Step 2: Run test** → FAIL, `./orchestrator` missing.

- [ ] **Step 3: Write `src/agent/specialists.ts`** (full prompts, Korean)

```ts
import type { SpecialistConfig } from "./engine";
import { searchDisclosures, getStockData, getMarketOverview, webSearch } from "@/tools/index";

const DISCLAIMER =
  "답변 마지막에 반드시 다음 문장을 포함하라: '본 분석은 투자 참고용이며, 투자 판단의 책임은 투자자 본인에게 있습니다.'";

const COMMON = `너는 한국 주식시장 전문 애널리스트다. 반드시 한국어로 답한다.
도구로 확보한 실제 데이터만 근거로 쓰고, 데이터 출처(공시/시세/검색)를 본문에 자연스럽게 밝힌다.
확보하지 못한 데이터는 추측하지 말고 "확인 불가"라고 명시한다.
마크다운(제목, 표, 불릿)으로 읽기 쉽게 구성한다. ${DISCLAIMER}`;

export const specialists: Record<string, SpecialistConfig> = {
  company_analysis: {
    key: "company_analysis",
    systemPrompt: `${COMMON}
임무: 특정 기업의 종합 분석 리포트 작성.
순서: (1) get_stock_data로 시세·수급·기본지표 확보 (2) search_disclosures로 최근 30일 공시 확인 (3) 필요시 web_search로 최근 뉴스 보강.
리포트 구성: 요약 → 주가/수급 동향 → 밸류에이션(PER/PBR 등) → 최근 공시·뉴스 핵심 → 투자 포인트와 리스크.`,
    tools: [getStockData, searchDisclosures, webSearch],
  },
  broker_view: {
    key: "broker_view",
    systemPrompt: `${COMMON}
임무: 특정 기업에 대한 증권사·애널리스트 시각 정리.
순서: (1) web_search로 "종목명 증권사 리포트 목표주가" 등 검색해 최근 리포트 헤드라인·목표주가·투자의견 수집 (2) get_stock_data로 현재가와 비교.
리포트 구성: 컨센서스 요약 → 주요 증권사별 시각(있는 것만) → 목표주가 vs 현재가 괴리 → 전문용어를 쉬운 말로 풀이.`,
    tools: [webSearch, getStockData],
  },
  macro: {
    key: "macro",
    systemPrompt: `${COMMON}
임무: 기준일의 거시경제 핵심 이슈 브리핑.
순서: (1) get_market_overview로 미국·한국 증시, 환율, 유가, 금리 확보 (2) web_search로 해당일 주요 이슈(연준, 빅테크, 지정학) 검색.
리포트 구성: 한줄 요약 → 미국 증시와 빅테크 → 금리·환율·유가 → 한국 시장 시사점.`,
    tools: [getMarketOverview, webSearch],
  },
  daily_reports: {
    key: "daily_reports",
    systemPrompt: `${COMMON}
임무: 기준일에 나온 증권사 리포트들을 쉬운 말로 요약.
순서: (1) web_search로 "해당날짜 증권사 리포트", "오늘의 리포트 요약" 등 검색 (2) 매크로/전략 리포트와 섹터/기업 리포트를 구분해 정리.
리포트 구성: 오늘의 리포트 한눈에 → 매크로/전략(시장 바닥론, ETF 영향 등) → 섹터/기업(반도체, 2차전지, 바이오 등) → 용어·목표주가 쉬운 해설.`,
    tools: [webSearch, getStockData],
  },
  disclosures: {
    key: "disclosures",
    systemPrompt: `${COMMON}
임무: 기준일 주요 공시 리뷰.
순서: (1) search_disclosures로 해당일 공시 전체 조회 (2) 대규모 계약, 유상증자, 블록딜, 내부자 매수, 시설투자 등 주가 영향이 큰 공시만 선별 (3) 필요시 해당 기업 get_stock_data·web_search로 맥락 보강.
리포트 구성: 오늘의 핵심 공시 목록(표) → 공시별 숨은 의미와 주가 관점 해석 → 종합 코멘트. 중요 공시가 없으면 없다고 명시.`,
    tools: [searchDisclosures, getStockData, webSearch],
  },
  flows: {
    key: "flows",
    systemPrompt: `${COMMON}
임무: 기준일의 수급과 섹터 동향 정리.
순서: (1) get_market_overview로 지수 흐름 확보 (2) web_search로 "해당날짜 외국인 기관 순매수 상위", "주도 섹터" 검색 (3) 특정 종목 언급 시 get_stock_data로 수급 확인.
리포트 구성: 시장 수급 요약(외국인/기관) → 주도 섹터 vs 소외 섹터 → 수급 상위 종목 → 내일 관전 포인트.`,
    tools: [getStockData, getMarketOverview, webSearch],
  },
};
```

- [ ] **Step 4: Write `src/agent/orchestrator.ts`**

```ts
import { specialists } from "./specialists";
import type { SpecialistConfig } from "./engine";
import { findByTicker } from "@/lib/listings";

export type AnalysisRequest = {
  mode: "company" | "date";
  target: string; // ticker (6자리) or YYYY-MM-DD
  option: "A" | "B" | "C" | "D";
};

const ROUTES: Record<string, string> = {
  "company:A": "company_analysis",
  "company:B": "broker_view",
  "date:A": "macro",
  "date:B": "daily_reports",
  "date:C": "disclosures",
  "date:D": "flows",
};

export function route(req: AnalysisRequest): SpecialistConfig | undefined {
  return specialists[ROUTES[`${req.mode}:${req.option}`] ?? ""];
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

- [ ] **Step 5: Run tests** → `npm test` PASS (all suites).

- [ ] **Step 6: Commit**

```powershell
git add src/agent/specialists.ts src/agent/orchestrator.ts src/agent/orchestrator.test.ts
git commit -m "feat: six specialist configs and deterministic orchestrator"
```

---

### Task 11: Smoke script — Day 1 exit criterion

**Files:**
- Create: `scripts/smoke.ts`

**Interfaces:**
- Consumes: everything. `npm run smoke tools` = live tool checks; `npm run smoke agent [ticker]` = full ReAct run streaming to stdout. This script is also the pre-demo morning check (spec §11).

- [ ] **Step 1: Write `scripts/smoke.ts`**

```ts
import { runTool } from "../src/tools/index";
import { runAgent } from "../src/agent/engine";
import { route, buildInitialMessage } from "../src/agent/orchestrator";

const today = new Date().toISOString().slice(0, 10);
const dartDay = today.replaceAll("-", "");

async function tools() {
  const checks: [string, unknown][] = [
    ["get_stock_data", { ticker: "005930" }],
    ["search_disclosures", { dateFrom: dartDay, dateTo: dartDay }],
    ["get_market_overview", { date: today }],
    ["web_search", { query: "삼성전자 주가 전망", maxResults: 3 }],
  ];
  let failed = 0;
  for (const [name, args] of checks) {
    const r = await runTool(name, args);
    const summary = r.ok ? JSON.stringify(r.data).slice(0, 200) : `ERROR: ${r.error}`;
    if (!r.ok) failed++;
    console.log(`\n[${r.ok ? "OK " : "FAIL"}] ${name}\n  ${summary}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} tools OK`);
  process.exit(failed ? 1 : 0);
}

async function agent(ticker = "005930") {
  const req = { mode: "company" as const, target: ticker, option: "A" as const };
  const specialist = route(req)!;
  console.log(`specialist: ${specialist.key}\n`);
  for await (const e of runAgent(specialist, [{ role: "user", content: buildInitialMessage(req) }])) {
    if (e.type === "token") process.stdout.write(e.text);
    else if (e.type === "action") console.log(`\n\n>> ACTION ${e.tool} ${JSON.stringify(e.args)}`);
    else if (e.type === "observation")
      console.log(`>> OBSERVATION ${e.tool} ${e.result.ok ? "ok" : `FAIL: ${e.result.error}`}\n`);
    else if (e.type === "error") console.error(`\n!! ERROR (retryable=${e.retryable}): ${e.message}`);
    else if (e.type === "done") console.log("\n\n== done ==");
  }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "tools") tools();
else if (cmd === "agent") agent(arg);
else console.log("usage: npm run smoke tools | npm run smoke agent [ticker]");
```

- [ ] **Step 2: Run tool smoke**

Run: `npm run smoke tools`
Expected: `4/4 tools OK`, exit 0. Any FAIL → fix that tool's schema against the real response before proceeding.

- [ ] **Step 3: Run agent smoke — THE Day 1 gate**

Run: `npm run smoke agent`
Expected: streamed Korean text, ≥1 `>> ACTION get_stock_data` with `>> OBSERVATION ... ok`, a coherent 삼성전자 report ending with the disclaimer, then `== done ==`.

Checks while it runs:
- `<think>` tags appearing in output → the `chat_template_kwargs` flag isn't working; try `extra_body: { chat_template_kwargs: { thinking: false } }` form, or switch `NIM_MODEL` to another Qwen instruct variant with function calling. Record the working model ID in `.env.example`.
- Model never calls tools → strengthen the "순서:" section of the specialist prompt; verify `tools` param reaches NIM (log `toOpenAITool` output once).

- [ ] **Step 4: Run full test suite once more**

Run: `npm test` → all PASS. `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```powershell
git add scripts/smoke.ts
git commit -m "feat: smoke script for live tools and end-to-end agent run"
```

---

## Done = Day 1 complete

`npm run smoke agent` streams a real, tool-grounded 삼성전자 report in the terminal. Plan 2 (chat UI + SSE + landing/thread pages) starts from this working core.
