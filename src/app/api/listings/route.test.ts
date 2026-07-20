import { describe, expect, it } from "vitest";
import { GET } from "./route";

function req(q: string): Request {
  return new Request(`http://localhost/api/listings?q=${encodeURIComponent(q)}`);
}

describe("GET /api/listings", () => {
  it("returns matching listings for a query", async () => {
    const res = await GET(req("삼성전자"));
    const data = await res.json();
    expect(data.some((c: { ticker: string }) => c.ticker === "005930")).toBe(true);
  });

  it("returns an empty array for a blank query", async () => {
    const res = await GET(req(""));
    expect(await res.json()).toEqual([]);
  });
});
