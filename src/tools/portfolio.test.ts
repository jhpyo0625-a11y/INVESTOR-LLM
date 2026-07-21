// src/tools/portfolio.test.ts
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/db/holdings", () => ({ listHoldings: vi.fn() }));
vi.mock("./stock", () => ({ getStockData: { name: "get_stock_data", run: vi.fn() } }));

import { listHoldings } from "@/lib/db/holdings";
import { getStockData } from "./stock";
import { makeGetPortfolioTool } from "./portfolio";

const mockedListHoldings = vi.mocked(listHoldings);
const mockedGetStockDataRun = vi.mocked(getStockData.run);

describe("get_portfolio tool", () => {
  it("is named get_portfolio and takes no meaningful args", () => {
    const tool = makeGetPortfolioTool("u1", {} as SupabaseClient);
    expect(tool.name).toBe("get_portfolio");
  });

  it("returns priced holdings joined with current price and P&L", async () => {
    mockedListHoldings.mockResolvedValue([
      { id: "h1", ticker: "005930", name: "삼성전자", quantity: 10, buyPrice: 70000, createdAt: "2026-07-20T00:00:00Z" },
    ]);
    mockedGetStockDataRun.mockResolvedValue({ ok: true, data: { price: { close: 77000 } } });

    const tool = makeGetPortfolioTool("u1", {} as SupabaseClient);
    const result = await tool.run({});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { holdings: Array<{ ticker: string; currentPrice: number; valueKrw: number }> };
    expect(data.holdings[0].ticker).toBe("005930");
    expect(data.holdings[0].currentPrice).toBe(77000);
    expect(data.holdings[0].valueKrw).toBe(70000);
  });

  it("returns an empty array, not an error, for zero holdings", async () => {
    mockedListHoldings.mockResolvedValue([]);
    const tool = makeGetPortfolioTool("u1", {} as SupabaseClient);
    const result = await tool.run({});
    expect(result).toEqual({ ok: true, data: { holdings: [] } });
  });

  it("sets currentPrice/valueKrw to null when the price lookup fails, without failing the whole tool", async () => {
    mockedListHoldings.mockResolvedValue([
      { id: "h1", ticker: "005930", name: "삼성전자", quantity: 10, buyPrice: 70000, createdAt: "2026-07-20T00:00:00Z" },
    ]);
    mockedGetStockDataRun.mockResolvedValue({ ok: false, error: "upstream down" });

    const tool = makeGetPortfolioTool("u1", {} as SupabaseClient);
    const result = await tool.run({});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { holdings: Array<{ currentPrice: number | null; valueKrw: number | null }> };
    expect(data.holdings[0].currentPrice).toBeNull();
    expect(data.holdings[0].valueKrw).toBeNull();
  });

  it("scopes to the bound userId, not an LLM-supplied argument", async () => {
    mockedListHoldings.mockResolvedValue([]);
    const tool = makeGetPortfolioTool("bound-user", {} as SupabaseClient);
    // Even if the LLM passes a different userId in args, the tool ignores it —
    // listHoldings is always called with the userId bound at construction time.
    await tool.run({ userId: "someone-else" });
    expect(mockedListHoldings).toHaveBeenCalledWith(expect.anything(), "bound-user");
  });
});
