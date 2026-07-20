import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./http", () => ({ fetchJson: vi.fn() }));
import { fetchJson } from "./http";
import { searchDisclosures } from "./disclosures";

const mocked = vi.mocked(fetchJson);
beforeEach(() => {
  mocked.mockReset();
});

describe("search_disclosures", () => {
  it("maps DART response to filings", async () => {
    mocked.mockResolvedValue({
      status: "000",
      message: "정상",
      list: [
        {
          corp_name: "삼성전자",
          stock_code: "005930",
          report_nm: "단일판매ㆍ공급계약체결",
          rcept_no: "20260717000123",
          flr_nm: "삼성전자",
          rcept_dt: "20260717",
        },
      ],
    });
    const r = await searchDisclosures.run({ dateFrom: "20260717", dateTo: "20260718" });
    expect(r).toEqual({
      ok: true,
      data: {
        count: 1,
        filings: [
          {
            corp: "삼성전자",
            ticker: "005930",
            title: "단일판매ㆍ공급계약체결",
            filedAt: "20260717",
            filer: "삼성전자",
            url: "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260717000123",
          },
        ],
      },
    });
  });

  it("treats DART status 013 (no data) as empty success", async () => {
    mocked.mockResolvedValue({ status: "013", message: "조회된 데이타가 없습니다." });
    const r = await searchDisclosures.run({ dateFrom: "20260717", dateTo: "20260717" });
    expect(r).toEqual({ ok: true, data: { count: 0, filings: [] } });
  });

  it("surfaces other DART error statuses", async () => {
    mocked.mockResolvedValue({ status: "020", message: "요청 제한 초과" });
    const r = await searchDisclosures.run({ dateFrom: "20260717", dateTo: "20260717" });
    expect(r.ok).toBe(false);
  });

  it("redacts DART_API_KEY from fetch failure messages", async () => {
    const originalKey = process.env.DART_API_KEY;
    process.env.DART_API_KEY = "secret-dart-key-123";
    mocked.mockRejectedValue(
      new Error(
        "HTTP 401: https://opendart.fss.or.kr/api/list.json?crtfc_key=secret-dart-key-123&bgn_de=20260717",
      ),
    );
    await expect(
      searchDisclosures.run({ dateFrom: "20260717", dateTo: "20260717" }),
    ).rejects.toThrow(/^(?!.*secret-dart-key-123).*\*\*\*.*$/);
    process.env.DART_API_KEY = originalKey;
  });
});
