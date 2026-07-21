import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/supabase/dal";
import { listWatchlist } from "@/lib/db/watchlist";
import { listHoldings } from "@/lib/db/holdings";
import { listRecentAnalyses } from "@/lib/db/analyses";
import { calculateHoldingPL } from "@/lib/portfolio-calc";
import { getStockData } from "@/tools/stock";

export async function Sidebar() {
  const supabase = await createClient();
  const user = await getUser(supabase);

  if (!user) {
    return (
      <aside className="hidden w-64 shrink-0 flex-col gap-6 border-r p-4 text-sm text-zinc-500 md:flex">
        <p>Google로 로그인하면 관심종목이 저장됩니다.</p>
        <p>Google로 로그인하면 보유종목 손익이 저장됩니다.</p>
        <p>Google로 로그인하면 분석 기록이 저장됩니다.</p>
      </aside>
    );
  }

  const [watchlist, holdings, recent] = await Promise.all([
    listWatchlist(supabase, user.id),
    listHoldings(supabase, user.id),
    listRecentAnalyses(supabase, user.id, 5),
  ]);

  const pricedHoldings = await Promise.all(
    holdings.map(async (h) => {
      const priceResult = await getStockData.run({ ticker: h.ticker });
      const currentPrice = priceResult.ok ? (priceResult.data as { price: { close: number } }).price.close : null;
      return calculateHoldingPL({ ticker: h.ticker, name: h.name, quantity: h.quantity, buyPrice: h.buyPrice, currentPrice });
    }),
  );
  const totalPL = pricedHoldings.reduce((sum, pl) => sum + (pl.valueKrw ?? 0), 0);

  return (
    <aside className="hidden w-64 shrink-0 flex-col gap-6 border-r p-4 text-sm md:flex">
      <div>
        <h2 className="mb-2 font-medium text-zinc-500">관심종목</h2>
        {watchlist.length === 0 ? (
          <p className="text-xs text-zinc-400">아직 없습니다.</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {watchlist.map((w) => (
              <Link
                key={w.ticker}
                href={`/t/${crypto.randomUUID()}?mode=company&target=${w.ticker}&option=A`}
                className="rounded-full border px-2 py-1 text-xs"
              >
                ★ {w.name}
              </Link>
            ))}
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-2 font-medium text-zinc-500">내 포트폴리오</h2>
        {holdings.length === 0 ? (
          <p className="text-xs text-zinc-400">보유 종목이 없습니다.</p>
        ) : (
          <p className={totalPL >= 0 ? "text-red-600" : "text-blue-600"}>
            평가손익 {totalPL >= 0 ? "+" : ""}
            {totalPL.toLocaleString()}원
          </p>
        )}
        <Link href="/portfolio" className="text-xs text-zinc-500 underline">
          포트폴리오 관리 →
        </Link>
      </div>

      <div>
        <h2 className="mb-2 font-medium text-zinc-500">최근 분석</h2>
        {recent.length === 0 ? (
          <p className="text-xs text-zinc-400">아직 없습니다.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {recent.map((a) => (
              <li key={a.id}>
                <Link href={`/t/${a.threadId}?mode=${a.mode}&target=${a.target}&option=${a.option}`} className="text-xs underline">
                  {a.target} ({a.createdAt.slice(0, 10)})
                </Link>
              </li>
            ))}
          </ul>
        )}
        <Link href="/history" className="text-xs text-zinc-500 underline">
          전체 기록 →
        </Link>
      </div>
    </aside>
  );
}
