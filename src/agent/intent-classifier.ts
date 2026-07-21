// src/agent/intent-classifier.ts
import { z } from "zod";
import type OpenAI from "openai";
import { MODEL } from "./nim";
import type { SpecialistKey } from "./specialists";

export async function classifyIntent(
  client: OpenAI,
  input: { validKeys: readonly SpecialistKey[]; currentSpecialistKey: SpecialistKey; text: string },
): Promise<SpecialistKey> {
  if (input.validKeys.length <= 1) return input.currentSpecialistKey;

  const schema = z.object({ specialist: z.enum(input.validKeys as [SpecialistKey, ...SpecialistKey[]]) });
  const tool = {
    type: "function" as const,
    function: {
      name: "classify_intent",
      description: "사용자의 후속 질문을 아래 전문가 중 하나로 분류한다.",
      parameters: z.toJSONSchema(schema),
    },
  };

  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0,
      stream: false,
      messages: [
        {
          role: "system",
          content: `사용자의 후속 질문을 다음 전문가 중 하나로 분류하라: ${input.validKeys.join(", ")}. 확신이 없으면 "${input.currentSpecialistKey}"를 선택하라.`,
        },
        { role: "user", content: input.text },
      ],
      tools: [tool],
      tool_choice: { type: "function", function: { name: "classify_intent" } },
    });

    const call = completion.choices[0]?.message.tool_calls?.[0];
    if (!call) return input.currentSpecialistKey;
    const parsed = schema.safeParse(JSON.parse(call.function.arguments));
    return parsed.success ? parsed.data.specialist : input.currentSpecialistKey;
  } catch {
    return input.currentSpecialistKey;
  }
}
