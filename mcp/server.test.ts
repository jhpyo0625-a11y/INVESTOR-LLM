// mcp/server.test.ts
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { listTools, callTool, ALLOWED } from "./server";
import type { Tool } from "../src/tools/types";

const echo: Tool = {
  name: "echo",
  description: "echoes back",
  schema: z.object({ msg: z.string() }),
  run: vi.fn(async (args) => ({ ok: true as const, data: args })),
};
const boom: Tool = {
  name: "boom",
  description: "always fails",
  schema: z.object({}),
  run: vi.fn(async () => ({ ok: false as const, error: "kaput" })),
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
