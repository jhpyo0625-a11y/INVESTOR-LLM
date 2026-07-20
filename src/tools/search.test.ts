import { describe, expect, it, vi, beforeEach } from "vitest";

const fetchSpy = vi.fn();
vi.stubGlobal("fetch", fetchSpy);
import { webSearch } from "./search";

beforeEach(() => fetchSpy.mockReset());

describe("web_search", () => {
  it("maps tavily results", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ title: "t", url: "u", content: "c", score: 0.9 }],
      }),
    });
    const r = await webSearch.run({ query: "삼성전자 실적" });
    expect(r).toEqual({ ok: true, data: { results: [{ title: "t", url: "u", content: "c" }] } });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.max_results).toBeLessThanOrEqual(5);
  });

  it("returns error result on HTTP failure", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 432 });
    const r = await webSearch.run({ query: "x" });
    expect(r.ok).toBe(false);
  });
});
