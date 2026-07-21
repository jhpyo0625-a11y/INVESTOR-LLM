// src/lib/db/holdings.ts
import type { SupabaseClient } from "@supabase/supabase-js";

export type Holding = {
  id: string;
  ticker: string;
  name: string;
  quantity: number;
  buyPrice: number;
  createdAt: string;
};

type HoldingRow = {
  id: string;
  ticker: string;
  name: string;
  quantity: number;
  buy_price: number;
  created_at: string;
};

function toHolding(r: HoldingRow): Holding {
  return { id: r.id, ticker: r.ticker, name: r.name, quantity: r.quantity, buyPrice: r.buy_price, createdAt: r.created_at };
}

export async function listHoldings(supabase: SupabaseClient, userId: string): Promise<Holding[]> {
  const { data, error } = await supabase
    .from("holdings")
    .select("id, ticker, name, quantity, buy_price, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listHoldings: ${error.message}`);
  return (data ?? []).map(toHolding);
}

export async function addHolding(
  supabase: SupabaseClient,
  userId: string,
  input: { ticker: string; name: string; quantity: number; buyPrice: number },
): Promise<void> {
  const { error } = await supabase.from("holdings").insert({
    user_id: userId,
    ticker: input.ticker,
    name: input.name,
    quantity: input.quantity,
    buy_price: input.buyPrice,
  });
  if (error) throw new Error(`addHolding: ${error.message}`);
}

export async function updateHolding(
  supabase: SupabaseClient,
  userId: string,
  id: string,
  input: { quantity: number; buyPrice: number },
): Promise<void> {
  const { error } = await supabase
    .from("holdings")
    .update({ quantity: input.quantity, buy_price: input.buyPrice })
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw new Error(`updateHolding: ${error.message}`);
}

export async function deleteHolding(supabase: SupabaseClient, userId: string, id: string): Promise<void> {
  const { error } = await supabase.from("holdings").delete().eq("id", id).eq("user_id", userId);
  if (error) throw new Error(`deleteHolding: ${error.message}`);
}
