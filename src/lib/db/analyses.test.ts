// src/lib/db/analyses.test.ts
import { describe, expect, it } from "vitest";
import { fakeSupabaseChain, fakeSupabaseClient } from "./test-helpers";
import { getAnalysisByThreadId, listRecentAnalyses, persistAnalysis } from "./analyses";

const row = {
  id: "a1",
  thread_id: "t1",
  mode: "company",
  target: "005930",
  option: "A",
  steps: [{ type: "action", tool: "get_stock_data", text: "{}" }],
  answer: "요약입니다",
  created_at: "2026-07-20T00:00:00Z",
};

describe("analyses data layer", () => {
  it("persists an analysis without throwing on success", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: null, error: null }));
    await expect(
      persistAnalysis(client, {
        userId: "u1",
        threadId: "t1",
        mode: "company",
        target: "005930",
        option: "A",
        steps: [],
        answer: "답변",
      }),
    ).resolves.toBeUndefined();
  });

  it("throws with the Supabase error message on a persist failure", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: null, error: { message: "boom" } }));
    await expect(
      persistAnalysis(client, { userId: "u1", threadId: "t1", mode: "company", target: "005930", option: "A", steps: [], answer: "" }),
    ).rejects.toThrow("boom");
  });

  it("gets a saved analysis by thread id", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: row, error: null }));
    const result = await getAnalysisByThreadId(client, "u1", "t1");
    expect(result?.threadId).toBe("t1");
    expect(result?.answer).toBe("요약입니다");
  });

  it("returns null when no saved analysis exists for the thread", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: null, error: null }));
    const result = await getAnalysisByThreadId(client, "u1", "unknown-thread");
    expect(result).toBeNull();
  });

  it("lists recent analyses newest first", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: [row], error: null }));
    const result = await listRecentAnalyses(client, "u1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a1");
  });
});
