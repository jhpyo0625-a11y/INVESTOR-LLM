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
    const client = { chat: { completions: { create: vi.fn(async (_params: any) => streams.shift()) } } };
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
    const client = { chat: { completions: { create: vi.fn(async (_params: any) => streams.shift()) } } };
    const runTool = vi.fn();

    const events = await collect(runAgent(config as any, [{ role: "user", content: "x" }], { client: client as any, runTool }));
    const obs = events.find((e) => e.type === "observation") as any;
    expect(obs.result.ok).toBe(false);
    expect(runTool).not.toHaveBeenCalled();
  });

  it("disables tools on final iteration (forces text answer)", async () => {
    const toolTurn = () => makeStream([call("c1", "get_stock_data", '{"ticker":"005930"}')]);
    const streams = [toolTurn(), toolTurn(), toolTurn(), toolTurn(), toolTurn(), makeStream([text("최종 요약.")])];
    const client = { chat: { completions: { create: vi.fn(async (_params: any) => streams.shift()) } } };
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
