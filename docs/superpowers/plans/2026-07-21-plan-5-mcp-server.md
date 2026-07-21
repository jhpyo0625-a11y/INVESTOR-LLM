# Plan 5 — MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap 4 existing stateless tools (`search_disclosures`, `get_stock_data`, `get_market_overview`, `web_search`) in a standalone stdio MCP server so any MCP client (Claude Code, Claude Desktop) can call the exact same tool code the web app's ReAct agent uses.

**Architecture:** `mcp/server.ts` uses the official `@modelcontextprotocol/sdk`'s low-level `Server` API with manual `ListTools`/`CallTool` request handlers. The handler logic is factored into two plain, independently testable functions — `listTools(tools)` and `callTool(tools, name, args)` — parameterized by a `Tool[]` rather than closing over module state, so tests exercise them with hand-built fake `Tool` objects (same pattern as `src/tools/index.test.ts`), with zero mocking of the real network-calling tools. The live server wires these against `ALLOWED`, an explicit array of the 4 real tool objects imported directly from `src/tools/index.ts` — `callTool` checks only this array, never the app's global `toolRegistry`, so a tool registered app-side later stays invisible to MCP until someone deliberately adds it to `ALLOWED`. `invokeTool` (already exists — validates args, catches thrown errors) is reused as-is, zero new validation logic.

**Tech Stack:** New dependency: `@modelcontextprotocol/sdk`. Everything else — TypeScript, zod, vitest, tsx — already in the project.

## Global Constraints

- `get_portfolio` is never included — it's session-scoped (built per-request from a logged-in Supabase user via `buildPortfolioSpecialist`), never in the static `toolRegistry`, and has no meaning in a stdio process with no user session. Out of scope for this plan (design spec §5, "Explicitly out").
- No auth or rate-limiting on the MCP server itself — it runs as a local child process spawned by the MCP client (Claude Code), inheriting that trust boundary; no network-exposed surface is added (design spec §5).
- `callTool` must check its `tools` parameter directly, never fall through to `src/tools/index.ts`'s global `toolRegistry` — that's the explicit-allowlist decision locked in the design doc.
- Full design rationale: `docs/superpowers/specs/2026-07-21-plan-5-mcp-server-design.md`.

---

### Task 1: Add `@modelcontextprotocol/sdk` dependency and `mcp` npm script

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: `@modelcontextprotocol/sdk` importable from `mcp/server.ts` (Task 2). `npm run mcp` script, used by the live-verification step in Task 4 and by `.mcp.json` (Task 3).

- [ ] **Step 1: Install the dependency**

Run: `npm install @modelcontextprotocol/sdk`
Expected: exits 0; `package.json`'s `"dependencies"` block gains an `"@modelcontextprotocol/sdk": "^X.Y.Z"` line (exact version is whatever npm resolves — don't hand-edit it); `package-lock.json` updates.

- [ ] **Step 2: Add the `mcp` script**

Edit `package.json`, in the `"scripts"` block, add a line after `"build:listings"` (matching the existing `smoke`/`build:listings` convention — a standalone script needs `--env-file` since it doesn't run inside Next's auto-loaded env context):

```json
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run",
    "smoke": "tsx --env-file=.env.local scripts/smoke.ts",
    "build:listings": "tsx --env-file=.env.local scripts/build-listings.ts",
    "mcp": "tsx --env-file=.env.local mcp/server.ts"
  },
```

- [ ] **Step 3: Verify nothing broke**

Run: `npm test`
Expected: all existing tests still pass (this task touches no source files, only adds a dependency + script).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @modelcontextprotocol/sdk dependency and mcp npm script"
```

---

### Task 2: `mcp/server.ts` — tool adapter + stdio wiring

**Files:**
- Modify: `vitest.config.ts`
- Create: `mcp/server.ts`
- Test: `mcp/server.test.ts`

**Interfaces:**
- Consumes: `invokeTool`, `searchDisclosures`, `getStockData`, `getMarketOverview`, `webSearch` from `src/tools/index.ts` (existing). `Tool` type from `src/tools/types.ts` (existing).
- Produces: `listTools(tools: Tool[]): { tools: { name: string; description: string; inputSchema: object }[] }`, `callTool(tools: Tool[], name: string, args: unknown): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>`, `ALLOWED: Tool[]` (the real 4-tool allowlist), `createServer(): Server`. Consumed by Task 3 (`.mcp.json` just spawns this file, no import) and Task 4 (live verification via `npm run mcp`).

- [ ] **Step 1: Widen vitest's test discovery to include `mcp/`**

Edit `vitest.config.ts`, change the `include` line:

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts", "mcp/**/*.test.ts"] },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
```

- [ ] **Step 2: Write the failing tests**

Create `mcp/server.test.ts`:

```ts
// mcp/server.test.ts
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { listTools, callTool, ALLOWED } from "./server";
import type { Tool } from "../src/tools/types";

const echo: Tool = {
  name: "echo",
  description: "echoes back",
  schema: z.object({ msg: z.string() }),
  run: vi.fn(async (args) => ({ ok: true, data: args })),
};
const boom: Tool = {
  name: "boom",
  description: "always fails",
  schema: z.object({}),
  run: vi.fn(async () => ({ ok: false, error: "kaput" })),
};
const fakeTools = [echo, boom];

describe("listTools", () => {
  it("lists every given tool with its name, description, and JSON-schema-converted input schema", () => {
    const { tools } = listTools(fakeTools);
    expect(tools).toEqual([
      { name: "echo", description: "echoes back", inputSchema: z.toJSONSchema(echo.schema) },
      { name: "boom", description: "always fails", inputSchema: z.toJSONSchema(boom.schema) },
    ]);
  });

  it("returns an empty list for an empty tool array", () => {
    expect(listTools([])).toEqual({ tools: [] });
  });
});

describe("callTool", () => {
  it("calls the matching tool and wraps an ok result as text content", async () => {
    const result = await callTool(fakeTools, "echo", { msg: "hi" });
    expect(echo.run).toHaveBeenCalledWith({ msg: "hi" });
    expect(result).toEqual({ content: [{ type: "text", text: JSON.stringify({ msg: "hi" }) }] });
  });

  it("wraps an ok:false result as isError:true", async () => {
    const result = await callTool(fakeTools, "boom", {});
    expect(result).toEqual({ content: [{ type: "text", text: "kaput" }], isError: true });
  });

  it("rejects invalid args via invokeTool's own schema validation, without calling run", async () => {
    vi.mocked(echo.run).mockClear();
    const result = await callTool(fakeTools, "echo", { msg: 42 });
    expect(echo.run).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it("returns isError:true for a tool name outside the given list, without calling any tool", async () => {
    vi.mocked(echo.run).mockClear();
    vi.mocked(boom.run).mockClear();
    const result = await callTool(fakeTools, "get_portfolio", {});
    expect(result).toEqual({ content: [{ type: "text", text: "unknown tool: get_portfolio" }], isError: true });
    expect(echo.run).not.toHaveBeenCalled();
    expect(boom.run).not.toHaveBeenCalled();
  });
});

describe("ALLOWED", () => {
  it("exposes exactly the 4 stateless tools the live server wires up, in a stable order", () => {
    expect(ALLOWED.map((t) => t.name)).toEqual([
      "search_disclosures",
      "get_stock_data",
      "get_market_overview",
      "web_search",
    ]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- server.test.ts`
Expected: FAIL — `./server` module not found.

- [ ] **Step 4: Implement `mcp/server.ts`**

Create `mcp/server.ts`:

```ts
// mcp/server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { invokeTool, searchDisclosures, getStockData, getMarketOverview, webSearch } from "../src/tools/index";
import type { Tool } from "../src/tools/types";

export const ALLOWED: Tool[] = [searchDisclosures, getStockData, getMarketOverview, webSearch];

export function listTools(tools: Tool[]) {
  return {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.schema),
    })),
  };
}

export async function callTool(tools: Tool[], name: string, args: unknown) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return { content: [{ type: "text" as const, text: `unknown tool: ${name}` }], isError: true };
  }
  const result = await invokeTool(tool, args);
  return result.ok
    ? { content: [{ type: "text" as const, text: JSON.stringify(result.data) }] }
    : { content: [{ type: "text" as const, text: result.error }], isError: true };
}

export function createServer(): Server {
  const server = new Server({ name: "investor-llm", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => listTools(ALLOWED));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(ALLOWED, request.params.name, request.params.arguments),
  );
  return server;
}

async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

// Guard so importing this module in vitest (which doesn't set process.argv[1]
// to this file) never opens a real stdio connection — only `tsx mcp/server.ts`
// as the actual entrypoint does.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- server.test.ts`
Expected: PASS (7/7).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests pass (Plans 1–4's tests plus this task's 7 new ones).

- [ ] **Step 8: Commit**

```bash
git add vitest.config.ts mcp/server.ts mcp/server.test.ts
git commit -m "feat: add MCP server wrapping the 4 stateless registry tools"
```

---

### Task 3: `.mcp.json` — project-scoped Claude Code registration

**Files:**
- Create: `.mcp.json`

**Interfaces:** none (static config, no code consumes it — Claude Code reads it directly).

- [ ] **Step 1: Create the registration file**

Create `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "investor-llm": {
      "command": "npx",
      "args": ["tsx", "--env-file=.env.local", "mcp/server.ts"]
    }
  }
}
```

- [ ] **Step 2: Verify the server still starts standalone**

Run: `npm run mcp`
Expected: the process starts and hangs waiting on stdio (no stack trace, no immediate exit — this is a server, not a script; it does not print anything to stdout on a healthy start since stdout is the MCP wire protocol). Stop it with Ctrl+C.

- [ ] **Step 3: Commit**

```bash
git add .mcp.json
git commit -m "feat: register the MCP server for project-scoped Claude Code use"
```

---

### Task 4: Full-suite regression pass + live verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full automated suite**

Run: `npm test`
Expected: all tests pass (Plans 1–5).

- [ ] **Step 2: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: no type errors; `npm run build` succeeds (the MCP server is a separate standalone process, not part of the Next.js app — this just confirms adding `@modelcontextprotocol/sdk` and the new `mcp/` files didn't break the app build).

- [ ] **Step 3: Live verification — register and call through Claude Code**

With `.env.local` populated (`DART_API_KEY`, `TAVILY_API_KEY`, and whatever else `src/tools/*` reads) and the repo's `.mcp.json` picked up by Claude Code (restart Claude Code in this project if it was already running, so it re-reads `.mcp.json`):

- Confirm the server shows as connected (Claude Code's `/mcp` command or equivalent UI).
- Ask something that requires `search_disclosures`, e.g. "삼성전자 최근 공시 찾아줘" — confirm Claude Code calls the `search_disclosures` tool and returns real DART filings (not a hallucinated answer — check the filing titles/dates look real).
- Ask something that requires `get_stock_data`, e.g. "005930 현재가 알려줘" — confirm a real price comes back.
- Ask something that requires `web_search`, e.g. a recent-news question — confirm it calls `web_search` rather than answering from training data.

- [ ] **Step 4: Report**

No commit for this task — it's verification only. If any step fails, fix it in a follow-up commit against the specific task it belongs to (not a catch-all "fix everything" commit).

---
