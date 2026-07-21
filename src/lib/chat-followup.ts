// src/lib/chat-followup.ts
export type TurnLike = { question: string | null; answer: string };

export function buildFollowupTurns(turns: TurnLike[]): { question: string | null; answer: string }[] {
  return turns.map((t) => ({ question: t.question, answer: t.answer }));
}
