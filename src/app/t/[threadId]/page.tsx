// src/app/t/[threadId]/page.tsx
import { ChatThread } from "@/components/ChatThread";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/supabase/dal";
import { getAnalysisByThreadId } from "@/lib/db/analyses";
import { isInWatchlist } from "@/lib/db/watchlist";

export default async function ThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{ threadId: string }>;
  searchParams: Promise<{ mode?: string; target?: string; option?: string }>;
}) {
  const { threadId } = await params;
  const sp = await searchParams;
  const mode = sp.mode === "date" ? "date" : sp.mode === "portfolio" ? "portfolio" : "company";
  const option = (["A", "B", "C", "D"].includes(sp.option ?? "") ? sp.option : "A") as "A" | "B" | "C" | "D";
  const target = sp.target ?? "";

  const supabase = await createClient();
  const user = await getUser(supabase);
  const saved = user ? await getAnalysisByThreadId(supabase, user.id, threadId) : null;
  const initialStarred =
    user && mode === "company" && target ? await isInWatchlist(supabase, user.id, target) : false;

  return (
    <main className="flex flex-1 flex-col">
      <ChatThread
        threadId={threadId}
        initial={{ mode, target: mode === "portfolio" ? undefined : target, option: mode === "portfolio" ? undefined : option }}
        initialTurns={saved?.turns}
        initialStarred={initialStarred}
      />
    </main>
  );
}
