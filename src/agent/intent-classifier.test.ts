// src/agent/intent-classifier.test.ts
import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { classifyIntent } from "./intent-classifier";

function fakeClient(response: unknown) {
  const create = vi.fn().mockResolvedValue(response);
  const client = { chat: { completions: { create } } } as unknown as OpenAI;
  return { client, create };
}

function toolCallResponse(specialist: string) {
  return {
    choices: [
      {
        message: {
          tool_calls: [{ type: "function" as const, function: { name: "classify_intent", arguments: JSON.stringify({ specialist }) } }],
        },
      },
    ],
  };
}

describe("classifyIntent", () => {
  it("returns the only valid key without calling the model", async () => {
    const { client, create } = fakeClient(toolCallResponse("portfolio"));
    const result = await classifyIntent(client, { validKeys: ["portfolio"], currentSpecialistKey: "portfolio", text: "아무 질문" });
    expect(result).toBe("portfolio");
    expect(create).not.toHaveBeenCalled();
  });

  it("returns the model's chosen specialist when valid", async () => {
    const { client } = fakeClient(toolCallResponse("broker_view"));
    const result = await classifyIntent(client, {
      validKeys: ["company_analysis", "broker_view"],
      currentSpecialistKey: "company_analysis",
      text: "목표주가는 얼마야?",
    });
    expect(result).toBe("broker_view");
  });

  it("forces tool_choice to classify_intent with the family's enum", async () => {
    const { client, create } = fakeClient(toolCallResponse("flows"));
    await classifyIntent(client, {
      validKeys: ["macro", "daily_reports", "disclosures", "flows"],
      currentSpecialistKey: "macro",
      text: "외국인 수급 어땠어?",
    });
    const call = create.mock.calls[0][0];
    expect(call.tool_choice).toEqual({ type: "function", function: { name: "classify_intent" } });
    expect(call.tools[0].function.name).toBe("classify_intent");
  });

  it("falls back to currentSpecialistKey when the API call throws", async () => {
    const { client } = fakeClient(null);
    vi.mocked(client.chat.completions.create).mockRejectedValue(new Error("boom"));
    const result = await classifyIntent(client, {
      validKeys: ["company_analysis", "broker_view"],
      currentSpecialistKey: "company_analysis",
      text: "아무 질문",
    });
    expect(result).toBe("company_analysis");
  });

  it("falls back to currentSpecialistKey when no tool call is returned", async () => {
    const { client } = fakeClient({ choices: [{ message: {} }] });
    const result = await classifyIntent(client, {
      validKeys: ["company_analysis", "broker_view"],
      currentSpecialistKey: "company_analysis",
      text: "아무 질문",
    });
    expect(result).toBe("company_analysis");
  });

  it("falls back to currentSpecialistKey when the model returns an invalid specialist", async () => {
    const { client } = fakeClient(toolCallResponse("not_a_real_specialist"));
    const result = await classifyIntent(client, {
      validKeys: ["company_analysis", "broker_view"],
      currentSpecialistKey: "company_analysis",
      text: "아무 질문",
    });
    expect(result).toBe("company_analysis");
  });
});
