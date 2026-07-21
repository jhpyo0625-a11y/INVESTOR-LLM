// src/app/api/watchlist/route.ts
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/supabase/dal";
import { addToWatchlist, removeFromWatchlist } from "@/lib/db/watchlist";

const addSchema = z.object({
  ticker: z.string().regex(/^\d{6}$/),
  name: z.string().min(1),
});

export async function POST(request: Request): Promise<Response> {
  const supabase = await createClient();
  const user = await getUser(supabase);
  if (!user) {
    return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = addSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }

  await addToWatchlist(supabase, user.id, parsed.data.ticker, parsed.data.name);
  return Response.json({ ok: true });
}

export async function DELETE(request: Request): Promise<Response> {
  const supabase = await createClient();
  const user = await getUser(supabase);
  if (!user) {
    return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const ticker = new URL(request.url).searchParams.get("ticker");
  if (!ticker || !/^\d{6}$/.test(ticker)) {
    return Response.json({ error: "invalid ticker" }, { status: 400 });
  }

  await removeFromWatchlist(supabase, user.id, ticker);
  return Response.json({ ok: true });
}
