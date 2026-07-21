// src/lib/db/watchlist.ts
import type { SupabaseClient } from "@supabase/supabase-js";

export type WatchlistItem = { id: string; ticker: string; name: string; createdAt: string };

export async function listWatchlist(supabase: SupabaseClient, userId: string): Promise<WatchlistItem[]> {
  const { data, error } = await supabase
    .from("watchlist")
    .select("id, ticker, name, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listWatchlist: ${error.message}`);
  return (data ?? []).map((r: { id: string; ticker: string; name: string; created_at: string }) => ({
    id: r.id,
    ticker: r.ticker,
    name: r.name,
    createdAt: r.created_at,
  }));
}

export async function addToWatchlist(
  supabase: SupabaseClient,
  userId: string,
  ticker: string,
  name: string,
): Promise<void> {
  const { error } = await supabase
    .from("watchlist")
    .upsert({ user_id: userId, ticker, name }, { onConflict: "user_id,ticker" });
  if (error) throw new Error(`addToWatchlist: ${error.message}`);
}

export async function removeFromWatchlist(supabase: SupabaseClient, userId: string, ticker: string): Promise<void> {
  const { error } = await supabase.from("watchlist").delete().eq("user_id", userId).eq("ticker", ticker);
  if (error) throw new Error(`removeFromWatchlist: ${error.message}`);
}
