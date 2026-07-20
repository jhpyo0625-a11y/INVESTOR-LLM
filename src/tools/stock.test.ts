import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./http", () => ({ fetchJson: vi.fn() }));
import { fetchJson } from "./http";
import { getStockData } from "./stock";

const mocked = vi.mocked(fetchJson);
// Block body: mockReset() returns the mock itself, and vitest treats a value
// returned from beforeEach as a post-test cleanup hook. Returning it here would
// re-invoke the mock (with no args) after the test, crashing url-branching impls.
beforeEach(() => {
  mocked.mockReset();
});

// Fixtures trimmed from real https://m.stock.naver.com/api/stock/005930/{basic,trend,integration}
const basic = {
  stockName: "삼성전자",
  closePrice: "244,000",
  fluctuationsRatio: "-4.31",
};
const trend = [
  {
    itemCode: "005930",
    bizdate: "20260716",
    foreignerPureBuyQuant: "-826,076",
    organPureBuyQuant: "-4,567,849",
    individualPureBuyQuant: "+5,211,886",
    closePrice: "255,000",
  },
];
const integration = {
  stockName: "삼성전자",
  totalInfos: [
    { code: "per", key: "PER", value: "19.72배", valueDesc: "2026.03." },
    { code: "pbr", key: "PBR", value: "3.39배", valueDesc: "2026.03." },
  ],
};

describe("get_stock_data", () => {
  it("normalizes price, flows, fundamentals", async () => {
    mocked.mockImplementation(async (url: string) => {
      if (url.includes("/basic")) return basic;
      if (url.includes("/trend")) return trend;
      return integration;
    });
    const r = await getStockData.run({ ticker: "005930" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as any;
    expect(d.name).toBe("삼성전자");
    expect(d.price.close).toBe(244000);
    expect(d.price.changeRate).toBe(-4.31);
    expect(d.flows[0].date).toBe("20260716");
    expect(d.flows[0].foreign).toBe(-826076);
    expect(d.flows[0].institution).toBe(-4567849);
    expect(d.flows[0].individual).toBe(5211886);
    expect(d.fundamentals.PER).toBe("19.72배");
    expect(d.fundamentals.PBR).toBe("3.39배");
  });
});
