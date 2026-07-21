// src/lib/db/analyses.test.ts
import { describe, expect, it } from "vitest";
import { fakeSupabaseChain, fakeSupabaseClient, fakeSupabaseClientSequence } from "./test-helpers";
import { appendTurn, getAnalysisByThreadId, listRecentAnalyses } from "./analyses";
import type { Turn } from "./analyses";

const turn1: Turn = {
  question: null,
  answer: "요약입니다",
  steps: [{ type: "action", tool: "get_stock_data", text: "{}" }],
  specialistKey: "company_analysis",
  createdAt: "2026-07-20T00:00:00Z",
};

const row = {
  id: "a1",
  thread_id: "t1",
  mode: "company",
  target: "005930",
  option: "A",
  turns: [turn1],
  updated_at: "2026-07-20T00:00:00Z",
};

describe("analyses data layer", () => {
  it("gets a saved analysis by thread id", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: row, error: null }));
    const result = await getAnalysisByThreadId(client, "u1", "t1");
    expect(result?.threadId).toBe("t1");
    expect(result?.turns).toEqual([turn1]);
  });

  it("returns null when no saved analysis exists for the thread", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: null, error: null }));
    const result = await getAnalysisByThreadId(client, "u1", "unknown-thread");
    expect(result).toBeNull();
  });

  it("throws with the Supabase error message on a read failure", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: null, error: { message: "boom" } }));
    await expect(getAnalysisByThreadId(client, "u1", "t1")).rejects.toThrow("boom");
  });

  it("lists recent analyses newest-updated first", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: [row], error: null }));
    const result = await listRecentAnalyses(client, "u1");
    expect(result).toHaveLength(1);
    expect(result[0].updatedAt).toBe("2026-07-20T00:00:00Z");
  });

  it("appendTurn inserts a new row when no analysis exists for the thread", async () => {
    const client = fakeSupabaseClientSequence([
      fakeSupabaseChain({ data: null, error: null }), // getAnalysisByThreadId: no existing row
      fakeSupabaseChain({ data: null, error: null }), // insert
    ]);
    await expect(
      appendTurn(client, { userId: "u1", threadId: "t1", mode: "company", target: "005930", option: "A", turn: turn1 }),
    ).resolves.toBeUndefined();
  });

  it("appendTurn updates the existing row's turns when a row already exists", async () => {
    const turn2: Turn = { ...turn1, question: "외국인은 왜 팔았어?", specialistKey: "flows" };
    const client = fakeSupabaseClientSequence([
      fakeSupabaseChain({ data: row, error: null }), // getAnalysisByThreadId: existing row
      fakeSupabaseChain({ data: null, error: null }), // update
    ]);
    await expect(
      appendTurn(client, { userId: "u1", threadId: "t1", mode: "company", target: "005930", option: "A", turn: turn2 }),
    ).resolves.toBeUndefined();
  });

  it("appendTurn propagates the read error", async () => {
    const client = fakeSupabaseClientSequence([fakeSupabaseChain({ data: null, error: { message: "boom" } })]);
    await expect(
      appendTurn(client, { userId: "u1", threadId: "t1", mode: "company", target: "005930", option: "A", turn: turn1 }),
    ).rejects.toThrow("boom");
  });

  it("appendTurn propagates the insert error", async () => {
    const client = fakeSupabaseClientSequence([
      fakeSupabaseChain({ data: null, error: null }),
      fakeSupabaseChain({ data: null, error: { message: "insert boom" } }),
    ]);
    await expect(
      appendTurn(client, { userId: "u1", threadId: "t1", mode: "company", target: "005930", option: "A", turn: turn1 }),
    ).rejects.toThrow("insert boom");
  });

  it("appendTurn propagates the update error", async () => {
    const client = fakeSupabaseClientSequence([
      fakeSupabaseChain({ data: row, error: null }),
      fakeSupabaseChain({ data: null, error: { message: "update boom" } }),
    ]);
    await expect(
      appendTurn(client, { userId: "u1", threadId: "t1", mode: "company", target: "005930", option: "A", turn: turn1 }),
    ).rejects.toThrow("update boom");
  });
});
