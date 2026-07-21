// src/lib/chat-types.ts
import { z } from "zod";

export const chatRequestSchema = z
  .object({
    mode: z.enum(["company", "date", "portfolio"]),
    target: z.string().min(1).optional(),
    option: z.enum(["A", "B", "C", "D"]).optional(),
    threadId: z.string().min(1),
  })
  .refine((v) => v.mode === "portfolio" || v.target !== undefined, {
    message: "target is required for mode:company/date",
    path: ["target"],
  })
  .refine((v) => v.mode === "portfolio" || v.option !== undefined, {
    message: "option is required for mode:company/date",
    path: ["option"],
  })
  .refine((v) => v.mode !== "date" || (v.target !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(v.target)), {
    message: "target must be YYYY-MM-DD for mode:date",
    path: ["target"],
  });

export type ChatRequest = z.infer<typeof chatRequestSchema>;

// Two-stage truncation for step text: the wire cap bounds SSE payload size
// against huge tool results (e.g. a 32-filing DART response); the display
// cap is a smaller, independent limit for compact timeline rendering.
export const MAX_STEP_TEXT_WIRE_CHARS = 500;
export const MAX_STEP_TEXT_DISPLAY_CHARS = 300;

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
