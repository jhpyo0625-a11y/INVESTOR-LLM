import { describe, expect, it } from "vitest";
import { searchListings, findByTicker } from "./listings";

describe("listings", () => {
  it("finds 삼성전자 by name", () => {
    const hits = searchListings("삼성전자");
    expect(hits.some((h) => h.ticker === "005930")).toBe(true);
  });
  it("finds by ticker prefix", () => {
    expect(searchListings("005930")[0]?.name).toContain("삼성전자");
  });
  it("caps results", () => {
    expect(searchListings("삼성", 5)).toHaveLength(5);
  });
  it("findByTicker returns corpCode", () => {
    expect(findByTicker("005930")?.corpCode).toMatch(/^\d{8}$/);
  });
  it("empty query returns empty", () => {
    expect(searchListings("  ")).toEqual([]);
  });
});
