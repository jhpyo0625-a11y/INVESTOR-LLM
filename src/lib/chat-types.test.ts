import { describe, expect, it } from "vitest";
import { chatRequestSchema } from "./chat-types";

describe("chatRequestSchema", () => {
  it("accepts a valid company request", () => {
    expect(chatRequestSchema.safeParse({ mode: "company", target: "005930", option: "A", threadId: "t1" }).success).toBe(true);
  });

  it("accepts a valid date request", () => {
    expect(chatRequestSchema.safeParse({ mode: "date", target: "2026-07-20", option: "A", threadId: "t1" }).success).toBe(true);
  });

  it("rejects a date request with a malformed date", () => {
    expect(chatRequestSchema.safeParse({ mode: "date", target: "not-a-date", option: "A", threadId: "t1" }).success).toBe(false);
  });

  it("rejects a company request missing target", () => {
    expect(chatRequestSchema.safeParse({ mode: "company", option: "A", threadId: "t1" }).success).toBe(false);
  });

  it("rejects a company request missing option", () => {
    expect(chatRequestSchema.safeParse({ mode: "company", target: "005930", threadId: "t1" }).success).toBe(false);
  });

  it("accepts a portfolio request with no target or option", () => {
    expect(chatRequestSchema.safeParse({ mode: "portfolio", threadId: "t1" }).success).toBe(true);
  });

  it("rejects a request missing threadId regardless of mode", () => {
    expect(chatRequestSchema.safeParse({ mode: "portfolio" }).success).toBe(false);
  });
});

describe("chatRequestSchema followup", () => {
  const base = { mode: "company", target: "005930", option: "A", threadId: "t1" } as const;

  it("accepts a valid followup payload", () => {
    const result = chatRequestSchema.safeParse({
      ...base,
      followup: {
        text: "외국인은 왜 팔았어?",
        currentSpecialistKey: "company_analysis",
        turns: [{ question: null, answer: "첫 답변" }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a followup with empty text", () => {
    const result = chatRequestSchema.safeParse({
      ...base,
      followup: { text: "", currentSpecialistKey: "company_analysis", turns: [] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a followup with an invalid currentSpecialistKey", () => {
    const result = chatRequestSchema.safeParse({
      ...base,
      followup: { text: "질문", currentSpecialistKey: "not_a_specialist", turns: [] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a followup turn missing answer", () => {
    const result = chatRequestSchema.safeParse({
      ...base,
      followup: { text: "질문", currentSpecialistKey: "company_analysis", turns: [{ question: null }] },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a request with no followup field, same as before", () => {
    expect(chatRequestSchema.safeParse(base).success).toBe(true);
  });
});
