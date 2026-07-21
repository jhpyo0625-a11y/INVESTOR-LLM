// src/lib/db/holdings.test.ts
import { describe, expect, it } from "vitest";
import { fakeSupabaseChain, fakeSupabaseClient } from "./test-helpers";
import { addHolding, deleteHolding, listHoldings, updateHolding } from "./holdings";

describe("holdings data layer", () => {
  it("lists a user's holdings", async () => {
    const rows = [
      { id: "h1", ticker: "005930", name: "삼성전자", quantity: 10, buy_price: 70000, created_at: "2026-07-20T00:00:00Z" },
    ];
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: rows, error: null }));
    const result = await listHoldings(client, "u1");
    expect(result).toEqual([
      { id: "h1", ticker: "005930", name: "삼성전자", quantity: 10, buyPrice: 70000, createdAt: "2026-07-20T00:00:00Z" },
    ]);
  });

  it("throws with the Supabase error message on a list failure", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: null, error: { message: "boom" } }));
    await expect(listHoldings(client, "u1")).rejects.toThrow("boom");
  });

  it("adds a holding without throwing on success", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: null, error: null }));
    await expect(
      addHolding(client, "u1", { ticker: "005930", name: "삼성전자", quantity: 10, buyPrice: 70000 }),
    ).resolves.toBeUndefined();
  });

  it("updates a holding without throwing on success", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: null, error: null }));
    await expect(updateHolding(client, "u1", "h1", { quantity: 5, buyPrice: 71000 })).resolves.toBeUndefined();
  });

  it("deletes a holding without throwing on success", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: null, error: null }));
    await expect(deleteHolding(client, "u1", "h1")).resolves.toBeUndefined();
  });
});
