import { z } from "zod";
import type { Tool } from "./types";

const argsSchema = z.object({
  query: z.string().min(2).describe("검색어. 한국어 또는 영어"),
  maxResults: z.number().int().min(1).max(5).optional().describe("결과 수 (기본 5)"),
});

const responseSchema = z.object({
  results: z.array(
    z.looseObject({ title: z.string(), url: z.string(), content: z.string() }),
  ),
});

export const webSearch: Tool = {
  name: "web_search",
  description:
    "웹 검색. 뉴스, 증권사 리포트 헤드라인, 시장 이슈 등 실시간 정보가 필요할 때 사용한다.",
  schema: argsSchema,
  async run(args) {
    const { query, maxResults } = args as z.infer<typeof argsSchema>;
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
      },
      body: JSON.stringify({ query, max_results: Math.min(maxResults ?? 5, 5) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, error: `tavily HTTP ${res.status}` };
    const parsed = responseSchema.parse(await res.json());
    return {
      ok: true,
      data: { results: parsed.results.map(({ title, url, content }) => ({ title, url, content })) },
    };
  },
};
