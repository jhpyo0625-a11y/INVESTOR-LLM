import { z } from "zod";
import { fetchJson } from "./http";
import type { Tool } from "./types";

const argsSchema = z.object({
  corpCode: z
    .string()
    .regex(/^\d{8}$/)
    .optional()
    .describe("DART 고유번호(8자리). 특정 기업의 공시만 조회할 때 지정"),
  dateFrom: z.string().regex(/^\d{8}$/).describe("조회 시작일 YYYYMMDD"),
  dateTo: z.string().regex(/^\d{8}$/).describe("조회 종료일 YYYYMMDD"),
});

const dartResponse = z.object({
  status: z.string(),
  message: z.string(),
  list: z
    .array(
      z.object({
        corp_name: z.string(),
        stock_code: z.string(),
        report_nm: z.string(),
        rcept_no: z.string(),
        flr_nm: z.string(),
        rcept_dt: z.string(),
      }),
    )
    .optional(),
});

export const searchDisclosures: Tool = {
  name: "search_disclosures",
  description:
    "DART 전자공시 검색. 기간(YYYYMMDD)과 선택적으로 기업(corpCode)을 지정해 공시 목록을 반환한다. 계약, 유상증자, 블록딜, 시설투자 등 주요 공시 확인용.",
  schema: argsSchema,
  async run(args) {
    const { corpCode, dateFrom, dateTo } = args as z.infer<typeof argsSchema>;
    const params = new URLSearchParams({
      crtfc_key: process.env.DART_API_KEY ?? "",
      bgn_de: dateFrom,
      end_de: dateTo,
      page_count: "100",
    });
    if (corpCode) params.set("corp_code", corpCode);

    const key = process.env.DART_API_KEY ?? "";
    let raw: unknown;
    try {
      raw = await fetchJson(`https://opendart.fss.or.kr/api/list.json?${params}`);
    } catch (e) {
      // fetchJson embeds the full request URL (including crtfc_key) in its
      // error message; redact before it reaches the LLM context or the UI.
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(key ? message.replaceAll(key, "***") : message);
    }
    const parsed = dartResponse.parse(raw);

    if (parsed.status === "013")
      return { ok: true, data: { count: 0, filings: [] } };
    if (parsed.status !== "000")
      return { ok: false, error: `DART ${parsed.status}: ${parsed.message}` };

    const filings = (parsed.list ?? []).slice(0, 50).map((f) => ({
      corp: f.corp_name,
      ticker: f.stock_code,
      title: f.report_nm,
      filedAt: f.rcept_dt,
      filer: f.flr_nm,
      url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${f.rcept_no}`,
    }));
    return { ok: true, data: { count: filings.length, filings } };
  },
};
