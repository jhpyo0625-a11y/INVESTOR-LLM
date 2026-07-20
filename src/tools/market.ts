import { z } from "zod";
import { fetchJson } from "./http";
import type { Tool } from "./types";

const argsSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("기준일 YYYY-MM-DD (최근 30일 이내)"),
});

const SYMBOLS = {
  kospi: "^KS11",
  kosdaq: "^KQ11",
  sp500: "^GSPC",
  nasdaq: "^IXIC",
  usdkrw: "KRW=X",
  wti: "CL=F",
  us10y: "^TNX",
} as const;

const chartSchema = z.object({
  chart: z.object({
    result: z.array(
      z.object({
        timestamp: z.array(z.number()),
        indicators: z.object({
          quote: z.array(z.object({ close: z.array(z.number().nullable()) })),
        }),
      }),
    ),
  }),
});

type Quote = { close: number; changePct: number; asOf: string };

async function quoteOnOrBefore(symbol: string, date: string): Promise<Quote | null> {
  try {
    const raw = await fetchJson(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2mo&interval=1d`,
    );
    const r = chartSchema.parse(raw).chart.result[0];
    const closes = r.indicators.quote[0].close;
    // bars whose UTC date <= requested date, with non-null close
    const bars = r.timestamp
      .map((t, i) => ({ day: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] }))
      .filter((b): b is { day: string; close: number } => b.close != null && b.day <= date);
    if (bars.length === 0) return null;
    const cur = bars[bars.length - 1];
    const prev = bars[bars.length - 2];
    return {
      close: cur.close,
      changePct: prev ? ((cur.close - prev.close) / prev.close) * 100 : 0,
      asOf: cur.day,
    };
  } catch {
    return null; // partial data is fine; agent narrates the gap
  }
}

export const getMarketOverview: Tool = {
  name: "get_market_overview",
  description:
    "기준일의 시장 개요: KOSPI/KOSDAQ, S&P500/나스닥, 원달러 환율, WTI 유가, 미국 10년물 금리의 종가와 등락률.",
  schema: argsSchema,
  async run(args) {
    const { date } = args as z.infer<typeof argsSchema>;
    const entries = await Promise.all(
      Object.entries(SYMBOLS).map(async ([k, sym]) => [k, await quoteOnOrBefore(sym, date)] as const),
    );
    return { ok: true, data: Object.fromEntries(entries) };
  },
};
