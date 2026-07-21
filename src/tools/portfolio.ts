// src/tools/portfolio.ts
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listHoldings } from "@/lib/db/holdings";
import { calculateHoldingPL } from "@/lib/portfolio-calc";
import type { Tool } from "./types";
import { getStockData } from "./stock";

const argsSchema = z.object({});

export function makeGetPortfolioTool(userId: string, supabase: SupabaseClient): Tool {
  return {
    name: "get_portfolio",
    description: "현재 로그인한 사용자의 보유 종목(수량, 평단가)과 각 종목의 현재가·평가손익을 반환한다. 인자 없음.",
    schema: argsSchema,
    async run() {
      // userId is bound here at construction time from the authenticated
      // session — never read from `args`, which is LLM-supplied and untrusted.
      const holdings = await listHoldings(supabase, userId);
      if (holdings.length === 0) {
        return { ok: true, data: { holdings: [] } };
      }

      const priced = await Promise.all(
        holdings.map(async (h) => {
          const priceResult = await getStockData.run({ ticker: h.ticker });
          const currentPrice = priceResult.ok ? (priceResult.data as { price: { close: number } }).price.close : null;
          const pl = calculateHoldingPL({ ticker: h.ticker, name: h.name, quantity: h.quantity, buyPrice: h.buyPrice, currentPrice });
          return {
            ticker: h.ticker,
            name: h.name,
            quantity: h.quantity,
            buyPrice: h.buyPrice,
            currentPrice,
            valueKrw: pl.valueKrw,
            ratePct: pl.ratePct,
          };
        }),
      );

      return { ok: true, data: { holdings: priced } };
    },
  };
}
