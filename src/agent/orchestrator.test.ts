import { describe, expect, it, vi } from "vitest";
import { route, buildInitialMessage } from "./orchestrator";

vi.mock("@/lib/listings", () => ({
  findByTicker: (t: string) =>
    t === "005930" ? { name: "삼성전자", ticker: "005930", corpCode: "00126380" } : undefined,
}));

describe("orchestrator routing", () => {
  it.each([
    ["company", "A", "company_analysis"],
    ["company", "B", "broker_view"],
    ["date", "A", "macro"],
    ["date", "B", "daily_reports"],
    ["date", "C", "disclosures"],
    ["date", "D", "flows"],
  ] as const)("%s option %s -> %s", (mode, option, key) => {
    expect(route({ mode, target: mode === "company" ? "005930" : "2026-07-17", option })?.key).toBe(key);
  });

  it("unknown combo routes nowhere", () => {
    expect(route({ mode: "company", target: "005930", option: "C" })).toBeUndefined();
  });

  it("company message includes name, ticker, corpCode", () => {
    const msg = buildInitialMessage({ mode: "company", target: "005930", option: "A" });
    expect(msg).toContain("삼성전자");
    expect(msg).toContain("005930");
    expect(msg).toMatch(/\d{8}/);
  });

  it("date message includes the date", () => {
    expect(buildInitialMessage({ mode: "date", target: "2026-07-17", option: "A" })).toContain("2026-07-17");
  });

  it("unknown ticker throws", () => {
    expect(() => buildInitialMessage({ mode: "company", target: "000000", option: "A" })).toThrow();
  });

  it("portfolio mode with no userId routes nowhere", () => {
    expect(route({ mode: "portfolio", target: "", option: undefined })).toBeUndefined();
  });

  it("portfolio mode with a userId and supabase client routes to the portfolio specialist", () => {
    const fakeSupabase = {} as never;
    const specialist = route({ mode: "portfolio", target: "", option: undefined }, { userId: "u1", supabase: fakeSupabase });
    expect(specialist?.key).toBe("portfolio");
  });

  it("portfolio message has no ticker/date, just the instruction", () => {
    const msg = buildInitialMessage({ mode: "portfolio", target: "", option: undefined });
    expect(msg).toContain("포트폴리오");
  });
});
