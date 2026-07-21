# Plan 5 — MCP Server Design Specification

**Date:** 2026-07-21
**Status:** Approved design, pre-implementation
**Parent spec:** `docs/superpowers/specs/2026-07-20-investor-llm-design.md` (§8, §12 D3)
**Sibling spec:** `docs/superpowers/specs/2026-07-21-plan-4-followup-intent-design.md` (§1 — names this as Plan 5)

---

## 1. Overview

Plan 3 shipped auth/portfolio/persistence, Plan 4 shipped follow-up intent routing.
Both deferred the parent spec's remaining D3/bonus piece: an MCP server exposing
the app's tools to any MCP client (Claude Code, Claude Desktop, etc.), reusing the
exact same tool code the web app's ReAct agent calls — "same tool code, two
consumers" is the demo line (parent spec §8).

`mcp/server.ts` is a standalone stdio MCP server (official
`@modelcontextprotocol/sdk`) that wraps 4 of the 5 registry tools. `get_portfolio`
is excluded — it's session-scoped (built per-request from a logged-in Supabase
user via `buildPortfolioSpecialist`, never statically registered in
`src/tools/index.ts`'s `toolRegistry`), so it has no meaning in a stdio context
with no user session.

**Decisions locked during brainstorming (this plan):**

| Decision | Choice |
|---|---|
| Tool scope | All 4 stateless registry tools — `search_disclosures`, `get_stock_data`, `get_market_overview`, `web_search` — not just the 2 the parent spec named. `get_portfolio` excluded (session-scoped, not in the static registry). |
| Wiring | Explicit allowlist array in `mcp/server.ts`, not a generic loop over `toolRegistry`. A future tool added to the registry is invisible to MCP until someone deliberately adds it here. |
| SDK API surface | Low-level `Server` + manual `ListTools`/`CallTool` request handlers, not the high-level `McpServer.tool()` shape-API. Reuses the same `z.toJSONSchema(schema)` conversion `src/tools/types.ts`'s `toOpenAITool` already does, so it works uniformly regardless of a tool's exact zod shape. |
| Validation/execution | Reuses `invokeTool(tool, args)` from `src/tools/index.ts` as-is (already does `schema.safeParse` + try/catch around `run`) — zero new validation logic. |
| Transport | stdio (`StdioServerTransport`) — standard for local MCP registration in Claude Code/Desktop, matches the parent spec's demo line. |

---

## 2. Components

### 2.1 `mcp/server.ts`

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { invokeTool, searchDisclosures, getStockData, getMarketOverview, webSearch } from "../src/tools/index";
import type { Tool } from "../src/tools/types";

const ALLOWED: Tool[] = [searchDisclosures, getStockData, getMarketOverview, webSearch];

const server = new Server({ name: "investor-llm", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ALLOWED.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.schema),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = ALLOWED.find((t) => t.name === request.params.name);
  if (!tool) {
    return { content: [{ type: "text", text: `unknown tool: ${request.params.name}` }], isError: true };
  }
  const result = await invokeTool(tool, request.params.arguments);
  return result.ok
    ? { content: [{ type: "text", text: JSON.stringify(result.data) }] }
    : { content: [{ type: "text", text: result.error }], isError: true };
});

await server.connect(new StdioServerTransport());
```

(Relative imports, not the `@/` alias — matches the existing precedent for
standalone scripts outside `src/`: `scripts/smoke.ts` already imports
`../src/tools/index` the same way.)

### 2.2 Data flow

```
MCP client (Claude Code)
  → ListTools request
  → server responds with 4 tools + their JSON schemas (derived from the same
    zod schemas the OpenAI tool-calling path uses)
  → client calls CallTool("search_disclosures", {...})
  → CallTool handler looks up the tool in ALLOWED (not the global toolRegistry)
  → invokeTool() — same function the web app's engine.ts ReAct loop calls —
    validates args, runs the tool, catches thrown errors
  → ToolResult{ok:true,data} / {ok:false,error} mapped to MCP's
    {content:[{type:"text",...}], isError?}
```

### 2.3 Error handling

No new error-handling logic — `invokeTool` already normalizes bad args and
thrown errors into `ToolResult`. The MCP handler's only two failure paths beyond
that are: (1) a tool name outside `ALLOWED` (own `isError:true` response, tool
never invoked), and (2) transport-level errors, which the SDK handles.

---

## 3. Testing

- `mcp/server.test.ts` (vitest, mocked `Tool.run` per tool — same pattern as
  `src/tools/*.test.ts`, no real API calls):
  - `ListTools` returns exactly the 4 allowed tools; each entry's `name`,
    `description`, `inputSchema` match calling `z.toJSONSchema` on that tool's own
    schema directly (regression-proof against the conversion drifting).
  - `CallTool` on a known name + valid args → underlying `run` called once,
    `ok:true` result mapped to `content:[{type:"text",text:JSON.stringify(data)}]`.
  - `CallTool` on a known name + invalid args → `invokeTool`'s own `safeParse`
    rejection surfaces as `isError:true` (no `run` call).
  - `CallTool` on a name outside `ALLOWED` (e.g. `"get_portfolio"` or a made-up
    name) → `isError:true`, and the test asserts the underlying `run` mock was
    **never called** — this is what actually proves the allowlist decision, not
    just that the registry happens not to contain that name.
- Live verification (manual, end of plan, same convention as prior plans' final
  task): register the server in Claude Code via the committed `.mcp.json`, ask a
  Korean question that requires a real DART/Naver/Tavily lookup, confirm the tool
  call round-trips with real data. `scripts/smoke.ts` already exercises these 4
  tools' real APIs at the function level — this step proves the MCP protocol
  adapter on top, not the tools again.

---

## 4. Demo / Run

- New dependency: `@modelcontextprotocol/sdk`.
- New npm script (matches `smoke`/`build:listings` convention — a standalone
  script needs `--env-file` since it doesn't run inside Next's auto-loaded env
  context): `"mcp": "tsx --env-file=.env.local mcp/server.ts"`.
- New committed file `.mcp.json` at repo root, project-scoped Claude Code
  registration pointing at `npx tsx --env-file=.env.local mcp/server.ts` — no
  manual `claude mcp add` step needed by anyone who clones the repo.
- Demo move (unchanged from parent spec §8): register in Claude Code, ask "삼성전자
  최근 공시 찾아줘", show it calling the server. Q&A story: "same tool code, two
  consumers — our ReAct agent and any MCP client."

---

## 5. Scope Boundaries

**In:** stdio MCP server wrapping `search_disclosures`, `get_stock_data`,
`get_market_overview`, `web_search`; explicit allowlist wiring; unit tests for the
protocol adapter; committed `.mcp.json`; live Claude-Code-registration
verification.

**Explicitly out, deferred:**
- `get_portfolio` — session-scoped, no stdio-context meaning without an
  authenticated user. Would need an HTTP/SSE MCP transport carrying auth, which
  is a different (and currently unplanned) shape of server.
- Any transport other than stdio.
- Publishing/distributing the MCP server outside this repo (npm package, Docker
  image, etc.) — out of scope for the parent spec's bonus-feature framing.
- Rate limiting or auth on the MCP server itself — it runs as a local child
  process spawned by the MCP client (Claude Code), inheriting whatever trust
  boundary that implies; no network-exposed surface is added.
