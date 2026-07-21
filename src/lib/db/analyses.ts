// src/lib/db/analyses.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StepPayload } from "@/lib/chat-types";

export type SavedAnalysis = {
  id: string;
  threadId: string;
  mode: string;
  target: string;
  option: string;
  steps: StepPayload[];
  answer: string;
  createdAt: string;
};

type AnalysisRow = {
  id: string;
  thread_id: string;
  mode: string;
  target: string;
  option: string;
  steps: StepPayload[];
  answer: string;
  created_at: string;
};

function toSavedAnalysis(r: AnalysisRow): SavedAnalysis {
  return {
    id: r.id,
    threadId: r.thread_id,
    mode: r.mode,
    target: r.target,
    option: r.option,
    steps: r.steps,
    answer: r.answer,
    createdAt: r.created_at,
  };
}

export async function persistAnalysis(
  supabase: SupabaseClient,
  input: { userId: string; threadId: string; mode: string; target: string; option: string; steps: StepPayload[]; answer: string },
): Promise<void> {
  const { error } = await supabase.from("analyses").insert({
    user_id: input.userId,
    thread_id: input.threadId,
    mode: input.mode,
    target: input.target,
    option: input.option,
    steps: input.steps,
    answer: input.answer,
  });
  if (error) throw new Error(`persistAnalysis: ${error.message}`);
}

export async function getAnalysisByThreadId(
  supabase: SupabaseClient,
  userId: string,
  threadId: string,
): Promise<SavedAnalysis | null> {
  const { data, error } = await supabase
    .from("analyses")
    .select("id, thread_id, mode, target, option, steps, answer, created_at")
    .eq("user_id", userId)
    .eq("thread_id", threadId)
    .maybeSingle();
  if (error) throw new Error(`getAnalysisByThreadId: ${error.message}`);
  return data ? toSavedAnalysis(data as AnalysisRow) : null;
}

export async function listRecentAnalyses(supabase: SupabaseClient, userId: string, limit = 5): Promise<SavedAnalysis[]> {
  const { data, error } = await supabase
    .from("analyses")
    .select("id, thread_id, mode, target, option, steps, answer, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listRecentAnalyses: ${error.message}`);
  return (data ?? []).map(toSavedAnalysis);
}
