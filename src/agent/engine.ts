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
    try {
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
    } catch (e) {
      // mid-stream failure: partial state already emitted, a bare retry isn't safe/meaningful here
      yield { type: "error", message: e instanceof Error ? e.message : String(e), retryable: false };
      return;
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
