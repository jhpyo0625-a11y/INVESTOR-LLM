// src/lib/supabase/dal.ts
import type { SupabaseClient, User } from "@supabase/supabase-js";

export async function getUser(supabase: SupabaseClient): Promise<User | null> {
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user;
}
