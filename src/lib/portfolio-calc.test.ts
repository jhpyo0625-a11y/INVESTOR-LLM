import { describe, expect, it } from "vitest";
import { calculateHoldingPL } from "./portfolio-calc";

describe("calculateHoldingPL", () => {
  it("computes positive P&L", () => {
    const result = calculateHoldingPL({ ticker: "005930", name: "삼성전자", quantity: 10, buyPrice: 70000, currentPrice: 77000 });
    expect(result.valueKrw).toBe(70000);
    expect(result.ratePct).toBeCloseTo(10, 5);
  });

  it("computes negative P&L", () => {
    const result = calculateHoldingPL({ ticker: "005930", name: "삼성전자", quantity: 10, buyPrice: 70000, currentPrice: 63000 });
    expect(result.valueKrw).toBe(-70000);
    expect(result.ratePct).toBeCloseTo(-10, 5);
  });

  it("returns nulls when the current price is unavailable", () => {
    const result = calculateHoldingPL({ ticker: "005930", name: "삼성전자", quantity: 10, buyPrice: 70000, currentPrice: null });
    expect(result.valueKrw).toBeNull();
    expect(result.ratePct).toBeNull();
  });
});
