import { describe, expect, it, vi, beforeEach } from "vitest";
import { searchCompaniesRemote } from "./listings-client";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("searchCompaniesRemote", () => {
  it("fetches and returns matching listings", async () => {
    const listings = [{ name: "삼성전자", ticker: "005930", corpCode: "00126380" }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(listings), { status: 200 })));

    const result = await searchCompaniesRemote("삼성전자");

    expect(result).toEqual(listings);
    expect(fetch).toHaveBeenCalledWith(
      `/api/listings?q=${encodeURIComponent("삼성전자")}`,
      { signal: undefined },
    );
  });

  it("throws on a non-OK response instead of returning empty data silently", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    await expect(searchCompaniesRemote("x")).rejects.toThrow("HTTP 500");
  });
});
