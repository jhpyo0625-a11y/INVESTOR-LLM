// src/lib/chat-types.ts
import { z } from "zod";

// ponytail: mirrors SPECIALIST_KEYS in src/agent/specialists.ts — duplicated
// (not imported) so this lib-level file has no dependency on the agent
// layer. Keep both lists in sync if a specialist is added or removed.
const specialistKeySchema = z.enum([
  "company_analysis",
  "broker_view",
  "macro",
  "daily_reports",
  "disclosures",
  "flows",
  "portfolio",
]);

export type SpecialistKeyName = z.infer<typeof specialistKeySchema>;

const followupSchema = z.object({
  text: z.string().min(1),
  currentSpecialistKey: specialistKeySchema,
  turns: z.array(
    z.object({
      question: z.string().min(1).nullable(),
      answer: z.string(),
    }),
  ),
});

export const chatRequestSchema = z
  .object({
    mode: z.enum(["company", "date", "portfolio"]),
    target: z.string().min(1).optional(),
    option: z.enum(["A", "B", "C", "D"]).optional(),
    threadId: z.string().min(1),
    followup: followupSchema.optional(),
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
