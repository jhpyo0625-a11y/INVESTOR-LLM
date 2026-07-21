// src/app/portfolio/page.tsx
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/supabase/dal";
import { listHoldings } from "@/lib/db/holdings";
import { calculateHoldingPL } from "@/lib/portfolio-calc";
import { getStockData } from "@/tools/stock";
import { HoldingsTable, type HoldingRow } from "@/components/HoldingsTable";

export default async function PortfolioPage() {
  const supabase = await createClient();
  const user = await getUser(supabase);

  // Defense in depth: proxy.ts already redirects guests before this ever
  // renders, but a Server Component must not assume request-time state.
  if (!user) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-sm text-zinc-500">로그인이 필요합니다.</p>
      </main>
    );
  }

  const holdings = await listHoldings(supabase, user.id);
  const rows: HoldingRow[] = await Promise.all(
    holdings.map(async (h) => {
      const priceResult = await getStockData.run({ ticker: h.ticker }).catch(() => ({ ok: false as const, error: "price lookup failed" }));
      const currentPrice = priceResult.ok ? (priceResult.data as { price: { close: number } }).price.close : null;
      const pl = calculateHoldingPL({ ticker: h.ticker, name: h.name, quantity: h.quantity, buyPrice: h.buyPrice, currentPrice });
      return { id: h.id, ticker: h.ticker, name: h.name, quantity: h.quantity, buyPrice: h.buyPrice, currentPrice, valueKrw: pl.valueKrw, ratePct: pl.ratePct };
    }),
  );

  const threadId = crypto.randomUUID();

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">내 포트폴리오</h1>
        <Link href={`/t/${threadId}?mode=portfolio`} className="rounded-full bg-black px-4 py-2 text-sm text-white dark:bg-white dark:text-black">
          AI 분석
        </Link>
      </div>
      <HoldingsTable initialHoldings={rows} />
    </main>
  );
}
