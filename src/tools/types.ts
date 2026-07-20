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
