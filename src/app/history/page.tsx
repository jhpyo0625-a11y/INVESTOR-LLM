// src/app/history/page.tsx
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/supabase/dal";
import { listRecentAnalyses } from "@/lib/db/analyses";

const MODE_LABELS: Record<string, string> = { company: "기업", date: "날짜", portfolio: "포트폴리오" };

export default async function HistoryPage() {
  const supabase = await createClient();
  const user = await getUser(supabase);

  // Defense in depth: proxy.ts already redirects guests before this ever renders.
  if (!user) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-sm text-zinc-500">로그인이 필요합니다.</p>
      </main>
    );
  }

  // Full history, no pagination — YAGNI at this app's demo scale (spec §6).
  const analyses = await listRecentAnalyses(supabase, user.id, 1000);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-6">
      <h1 className="text-xl font-bold">분석 기록</h1>
      {analyses.length === 0 ? (
        <p className="text-sm text-zinc-500">아직 분석 기록이 없습니다.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {analyses.map((a) => (
            <li key={a.id} className="py-3">
              <Link href={`/t/${a.threadId}?mode=${a.mode}&target=${a.target}&option=${a.option}`} className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">
                  [{MODE_LABELS[a.mode] ?? a.mode}] {a.target || "포트폴리오"}
                </span>
                <span className="text-xs text-zinc-500">{a.updatedAt.slice(0, 10)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
