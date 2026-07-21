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
