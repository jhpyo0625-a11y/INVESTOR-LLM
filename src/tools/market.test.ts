import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./http", () => ({ fetchJson: vi.fn() }));
import { fetchJson } from "./http";
import { getMarketOverview } from "./market";

const mocked = vi.mocked(fetchJson);
beforeEach(() => {
  mocked.mockReset();
});

// two bars: 2026-07-16 close 100, 2026-07-17 close 110
const chart = (t1: number, t2: number) => ({
  chart: {
    result: [
      { timestamp: [t1, t2], indicators: { quote: [{ close: [100, 110] }] } },
    ],
  },
});
const day = (s: string) => Math.floor(new Date(s).getTime() / 1000);

describe("get_market_overview", () => {
  it("picks bar on/before date and computes change", async () => {
    mocked.mockResolvedValue(chart(day("2026-07-16T06:00:00Z"), day("2026-07-17T06:00:00Z")));
    const r = await getMarketOverview.run({ date: "2026-07-17" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const kospi = (r.data as any).kospi;
    expect(kospi.close).toBe(110);
    expect(kospi.changePct).toBeCloseTo(10);
  });

  it("returns null for a symbol whose fetch fails, still ok overall", async () => {
    mocked.mockRejectedValue(new Error("down"));
    const r = await getMarketOverview.run({ date: "2026-07-17" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.data as any).kospi).toBeNull();
  });
});
