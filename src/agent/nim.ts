import OpenAI from "openai";

export const MODEL = process.env.NIM_MODEL ?? "qwen/qwen3-235b-a22b";

export function nimClient(): OpenAI {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY missing");
  return new OpenAI({ apiKey, baseURL: "https://integrate.api.nvidia.com/v1" });
}

type ChatParams = Omit<OpenAI.ChatCompletionCreateParamsStreaming, "model" | "stream">;

export async function createChatStream(client: OpenAI, params: ChatParams) {
  const make = () =>
    // qwen3: disable thinking-mode <think> blocks; verified in Task 11 smoke
    // @ts-expect-error NIM extension (chat_template_kwargs is not in the OpenAI SDK types)
    client.chat.completions.create({
      model: MODEL,
      stream: true,
      temperature: 0.3,
      ...params,
      chat_template_kwargs: { thinking: false },
    });
  try {
    return await make();
  } catch {
    return await make(); // one retry on transient failure
  }
}
