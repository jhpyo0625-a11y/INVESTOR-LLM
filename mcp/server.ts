// mcp/server.ts
import { pathToFileURL } from "node:url";
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
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
