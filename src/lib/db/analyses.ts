// src/lib/db/analyses.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StepPayload } from "@/lib/chat-types";

export type Turn = {
  question: string | null;
  answer: string;
  steps: StepPayload[];
  specialistKey: string;
  createdAt: string;
};

export type SavedAnalysis = {
  id: string;
  threadId: string;
  mode: string;
  target: string;
  option: string;
  turns: Turn[];
  updatedAt: string;
};

type AnalysisRow = {
  id: string;
  thread_id: string;
  mode: string;
  target: string;
  option: string;
  turns: Turn[];
  updated_at: string;
};

function toSavedAnalysis(r: AnalysisRow): SavedAnalysis {
  return {
    id: r.id,
    threadId: r.thread_id,
    mode: r.mode,
    target: r.target,
    option: r.option,
    turns: r.turns,
    updatedAt: r.updated_at,
  };
}

export async function getAnalysisByThreadId(
  supabase: SupabaseClient,
  userId: string,
  threadId: string,
): Promise<SavedAnalysis | null> {
  const { data, error } = await supabase
    .from("analyses")
    .select("id, thread_id, mode, target, option, turns, updated_at")
    .eq("user_id", userId)
    .eq("thread_id", threadId)
    .maybeSingle();
  if (error) throw new Error(`getAnalysisByThreadId: ${error.message}`);
  return data ? toSavedAnalysis(data as AnalysisRow) : null;
}

export async function listRecentAnalyses(supabase: SupabaseClient, userId: string, limit = 5): Promise<SavedAnalysis[]> {
  const { data, error } = await supabase
    .from("analyses")
    .select("id, thread_id, mode, target, option, turns, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listRecentAnalyses: ${error.message}`);
  return (data ?? []).map(toSavedAnalysis);
}

const APPEND_TURN_MAX_ATTEMPTS = 5;

// ponytail: the insert-conflict retry (23505 branch below) only kicks in if
// (user_id, thread_id) has a unique constraint in the DB. Without one, two
// concurrent first-turns race the read and both insert — a genuine
// duplicate row, not something app code can prevent. Add the constraint if
// this hasn't been done already.
export async function appendTurn(
  supabase: SupabaseClient,
  input: { userId: string; threadId: string; mode: string; target: string; option: string; turn: Turn },
): Promise<void> {
  for (let attempt = 0; attempt < APPEND_TURN_MAX_ATTEMPTS; attempt++) {
    const existing = await getAnalysisByThreadId(supabase, input.userId, input.threadId);

    if (!existing) {
      const { error } = await supabase.from("analyses").insert({
        user_id: input.userId,
        thread_id: input.threadId,
        mode: input.mode,
        target: input.target,
        option: input.option,
        turns: [input.turn],
      });
      if (!error) return;
      // Another request inserted the row between our read and this insert
      // (23505 = unique_violation on (user_id, thread_id)) — retry as an
      // append against the row that now exists instead of failing.
      if (error.code === "23505") continue;
      throw new Error(`appendTurn: ${error.message}`);
    }

    // Optimistic concurrency: only apply if `updated_at` still matches what
    // we just read. If another request appended a turn in between, this
    // matches 0 rows instead of silently overwriting their turn — retry
    // with a fresh read/append instead of losing it.
    const { data, error } = await supabase
      .from("analyses")
      .update({ turns: [...existing.turns, input.turn], updated_at: new Date().toISOString() })
      .eq("user_id", input.userId)
      .eq("thread_id", input.threadId)
      .eq("updated_at", existing.updatedAt)
      .select("id");
    if (error) throw new Error(`appendTurn: ${error.message}`);
    if (data && data.length > 0) return;
  }
  throw new Error("appendTurn: lost the update race too many times, giving up");
}
