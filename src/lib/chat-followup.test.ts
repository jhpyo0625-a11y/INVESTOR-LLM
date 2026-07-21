// src/lib/chat-followup.test.ts
import { describe, expect, it } from "vitest";
import { buildFollowupTurns } from "./chat-followup";

describe("buildFollowupTurns", () => {
  it("returns an empty array for no prior turns", () => {
    expect(buildFollowupTurns([])).toEqual([]);
  });

  it("maps question/answer pairs in order", () => {
    const result = buildFollowupTurns([
      { question: null, answer: "첫 답변" },
      { question: "후속 질문 1", answer: "두 번째 답변" },
    ]);
    expect(result).toEqual([
      { question: null, answer: "첫 답변" },
      { question: "후속 질문 1", answer: "두 번째 답변" },
    ]);
  });

  it("strips extra fields, keeping only question and answer", () => {
    const result = buildFollowupTurns([
      { question: null, answer: "답변", steps: [{ type: "action", tool: "x", text: "y" }], status: "done" } as never,
    ]);
    expect(result).toEqual([{ question: null, answer: "답변" }]);
  });
});
