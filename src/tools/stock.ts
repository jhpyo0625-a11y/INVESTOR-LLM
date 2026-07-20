import { z } from "zod";
import { fetchJson } from "./http";
import type { Tool } from "./types";

const argsSchema = z.object({
  ticker: z.string().regex(/^\d{6}$/).describe("한국 상장기업 종목코드 6자리, 예: 005930"),
});

const num = (s: string | number) =>
  typeof s === "number" ? s : Number(String(s).replace(/,/g, ""));

const basicSchema = z.looseObject({
  stockName: z.string(),
  closePrice: z.string(),
  fluctuationsRatio: z.string(),
});
const trendSchema = z.array(
  z.looseObject({
    bizdate: z.string(),
    foreignerPureBuyQuant: z.union([z.string(), z.number()]),
    organPureBuyQuant: z.union([z.string(), z.number()]),
    individualPureBuyQuant: z.union([z.string(), z.number()]),
  }),
);
const integrationSchema = z.looseObject({
  totalInfos: z.array(z.looseObject({ key: z.string(), value: z.string() })),
});

const BASE = "https://m.stock.naver.com/api/stock";

export const getStockData: Tool = {
  name: "get_stock_data",
  description:
    "한국 주식의 현재가, 등락률, PER/PBR 등 기본 지표, 최근 10거래일 외국인/기관/개인 순매수(수급)를 반환한다.",
  schema: argsSchema,
  async run(args) {
    const { ticker } = args as z.infer<typeof argsSchema>;
    const [basic, trend, integration] = await Promise.all([
      fetchJson(`${BASE}/${ticker}/basic`).then((r) => basicSchema.parse(r)),
      fetchJson(`${BASE}/${ticker}/trend?pageSize=10`).then((r) => trendSchema.parse(r)),
      fetchJson(`${BASE}/${ticker}/integration`).then((r) => integrationSchema.parse(r)),
    ]);
    return {
      ok: true,
      data: {
        name: basic.stockName,
        price: { close: num(basic.closePrice), changeRate: num(basic.fluctuationsRatio) },
        fundamentals: Object.fromEntries(integration.totalInfos.map((i) => [i.key, i.value])),
        flows: trend.map((t) => ({
          date: t.bizdate,
          foreign: num(t.foreignerPureBuyQuant),
          institution: num(t.organPureBuyQuant),
          individual: num(t.individualPureBuyQuant),
        })),
      },
    };
  },
};
