// src/lib/db/watchlist.test.ts
import { describe, expect, it } from "vitest";
import { fakeSupabaseChain, fakeSupabaseClient } from "./test-helpers";
import { addToWatchlist, isInWatchlist, listWatchlist, removeFromWatchlist } from "./watchlist";

describe("watchlist data layer", () => {
  it("lists a user's watchlist", async () => {
    const rows = [{ id: "w1", ticker: "005930", name: "삼성전자", created_at: "2026-07-20T00:00:00Z" }];
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: rows, error: null }));
    const result = await listWatchlist(client, "u1");
    expect(result).toEqual([{ id: "w1", ticker: "005930", name: "삼성전자", createdAt: "2026-07-20T00:00:00Z" }]);
  });

  it("throws with the Supabase error message on a list failure", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: null, error: { message: "boom" } }));
    await expect(listWatchlist(client, "u1")).rejects.toThrow("boom");
  });

  it("adds to the watchlist without throwing on success", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: null, error: null }));
    await expect(addToWatchlist(client, "u1", "005930", "삼성전자")).resolves.toBeUndefined();
  });

  it("removes from the watchlist without throwing on success", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: null, error: null }));
    await expect(removeFromWatchlist(client, "u1", "005930")).resolves.toBeUndefined();
  });

  it("reports true when the ticker is in the watchlist", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: { id: "w1" }, error: null }));
    await expect(isInWatchlist(client, "u1", "005930")).resolves.toBe(true);
  });

  it("reports false when the ticker is not in the watchlist", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: null, error: null }));
    await expect(isInWatchlist(client, "u1", "005930")).resolves.toBe(false);
  });
});
