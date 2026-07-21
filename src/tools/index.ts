import type { Tool, ToolResult } from "./types";

export const toolRegistry: Record<string, Tool> = {};

export function registerTools(tools: Tool[]) {
  for (const t of tools) toolRegistry[t.name] = t;
}

export async function invokeTool(tool: Tool, args: unknown): Promise<ToolResult> {
  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) return { ok: false, error: `invalid args: ${parsed.error.message}` };
  try {
    return await tool.run(parsed.data);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function runTool(name: string, args: unknown): Promise<ToolResult> {
  const tool = toolRegistry[name];
  if (!tool) return { ok: false, error: `unknown tool: ${name}` };
  return invokeTool(tool, args);
}

import { searchDisclosures } from "./disclosures";
import { getStockData } from "./stock";
import { getMarketOverview } from "./market";
import { webSearch } from "./search";

registerTools([searchDisclosures, getStockData, getMarketOverview, webSearch]);
export { searchDisclosures, getStockData, getMarketOverview, webSearch };
