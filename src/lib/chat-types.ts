// src/lib/chat-types.ts
import { z } from "zod";

export const chatRequestSchema = z
  .object({
    mode: z.enum(["company", "date"]),
    target: z.string().min(1),
    option: z.enum(["A", "B", "C", "D"]),
    threadId: z.string().min(1),
  })
  .refine((v) => v.mode !== "date" || /^\d{4}-\d{2}-\d{2}$/.test(v.target), {
    message: "target must be YYYY-MM-DD for mode:date",
    path: ["target"],
  });

export type ChatRequest = z.infer<typeof chatRequestSchema>;

export type StepPayload = {
  type: "action" | "observation";
  tool: string;
  text: string;
};

export type ChatEvent =
  | { event: "step"; data: StepPayload }
  | { event: "token"; data: { text: string } }
  | { event: "done"; data: { threadId: string; specialistKey: string } }
  | { event: "error"; data: { message: string; retryable: boolean } };
