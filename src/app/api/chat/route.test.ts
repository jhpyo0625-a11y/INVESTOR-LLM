// src/app/api/chat/route.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/agent/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/agent/engine")>();
  return { ...actual, runAgent: vi.fn() };
});
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/dal", () => ({ getUser: vi.fn() }));
vi.mock("@/lib/db/analyses", () => ({ appendTurn: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/agent/nim", () => ({ nimClient: vi.fn(() => ({})), MODEL: "test-model" }));
vi.mock("@/agent/intent-classifier", () => ({ classifyIntent: vi.fn() }));
import { runAgent } from "@/agent/engine";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/supabase/dal";
import { appendTurn } from "@/lib/db/analyses";
import { classifyIntent } from "@/agent/intent-classifier";
import { POST } from "./route";

const mockedRunAgent = vi.mocked(runAgent);
const mockedCreateClient = vi.mocked(createClient);
const mockedGetUser = vi.mocked(getUser);
const mockedAppendTurn = vi.mocked(appendTurn);
const mockedClassifyIntent = vi.mocked(classifyIntent);

beforeEach(() => {
  mockedRunAgent.mockReset();
  mockedCreateClient.mockResolvedValue({} as never);
  mockedGetUser.mockResolvedValue(null);
  mockedAppendTurn.mockClear();
  mockedClassifyIntent.mockReset();
  mockedClassifyIntent.mockResolvedValue("company_analysis");
});

async function* fakeAgent() {
  yield { type: "token" as const, text: "안녕" };
  yield { type: "done" as const };
}

function req(body: unknown, headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    body: JSON.stringify(body),
    headers,
  });
}

// Each test uses its own X-Forwarded-For so the shared in-memory rate
// limiter (keyed by client IP) doesn't let tests interfere with each other.
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.0.0.${ipCounter}`;
}

describe("POST /api/chat", () => {
  it("streams SSE for a valid structured request", async () => {
    mockedRunAgent.mockReturnValue(fakeAgent());
    const res = await POST(req({ mode: "company", target: "005930", option: "A", threadId: "t1" }, { "x-forwarded-for": nextIp() }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain('event: token\ndata: {"text":"안녕"}');
    expect(text).toContain('event: done\ndata: {"threadId":"t1","specialistKey":"company_analysis"}');
  });

  it("400s on a malformed body without calling the agent", async () => {
    const res = await POST(req({ mode: "company" }, { "x-forwarded-for": nextIp() }));
    expect(res.status).toBe(400);
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });

  it("400s on a non-JSON request body without calling the agent", async () => {
    const res = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        body: "not json",
        headers: { "x-forwarded-for": nextIp() },
      }),
    );
    expect(res.status).toBe(400);
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });

  it("400s on an unknown mode:option combination", async () => {
    const res = await POST(req({ mode: "company", target: "005930", option: "C", threadId: "t1" }, { "x-forwarded-for": nextIp() }));
    expect(res.status).toBe(400);
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });

  it("400s on an unknown ticker", async () => {
    const res = await POST(req({ mode: "company", target: "000000", option: "A", threadId: "t1" }, { "x-forwarded-for": nextIp() }));
    expect(res.status).toBe(400);
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });

  it("400s on a malformed date target without calling the agent", async () => {
    const res = await POST(
      req({ mode: "date", target: "not-a-date", option: "A", threadId: "t1" }, { "x-forwarded-for": nextIp() }),
    );
    expect(res.status).toBe(400);
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });

  it("429s after exceeding the per-IP rate limit, without calling the agent", async () => {
    mockedRunAgent.mockImplementation(() => fakeAgent());
    const ip = nextIp();
    const body = { mode: "company", target: "005930", option: "A", threadId: "t1" };
    for (let i = 0; i < 10; i++) {
      const res = await POST(req(body, { "x-forwarded-for": ip }));
      expect(res.status).toBe(200);
      await res.text(); // drain the stream so the request is fully "complete"
    }
    mockedRunAgent.mockClear();
    const res = await POST(req(body, { "x-forwarded-for": ip }));
    expect(res.status).toBe(429);
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });

  it("401s on mode:portfolio for a guest, without calling the agent", async () => {
    const res = await POST(req({ mode: "portfolio", threadId: "t1" }, { "x-forwarded-for": nextIp() }));
    expect(res.status).toBe(401);
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });

  it("streams SSE for mode:portfolio when logged in", async () => {
    mockedGetUser.mockResolvedValue({ id: "u1" } as never);
    mockedRunAgent.mockReturnValue(fakeAgent());
    const res = await POST(req({ mode: "portfolio", threadId: "t1" }, { "x-forwarded-for": nextIp() }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: done\ndata: {"threadId":"t1","specialistKey":"portfolio"}');
  });

  it("persists the analysis on done when the user is logged in", async () => {
    mockedGetUser.mockResolvedValue({ id: "u1" } as never);
    mockedRunAgent.mockReturnValue(fakeAgent());
    const res = await POST(req({ mode: "company", target: "005930", option: "A", threadId: "t1" }, { "x-forwarded-for": nextIp() }));
    await res.text();
    expect(mockedAppendTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: "u1",
        threadId: "t1",
        mode: "company",
        turn: expect.objectContaining({ question: null, answer: "안녕", specialistKey: "company_analysis" }),
      }),
    );
  });

  it("does not persist the analysis for a guest", async () => {
    mockedGetUser.mockResolvedValue(null);
    mockedRunAgent.mockReturnValue(fakeAgent());
    const res = await POST(req({ mode: "company", target: "005930", option: "A", threadId: "t1" }, { "x-forwarded-for": nextIp() }));
    await res.text();
    expect(mockedAppendTurn).not.toHaveBeenCalled();
  });

  it("classifies and streams a followup on a company thread, reconstructing history", async () => {
    mockedClassifyIntent.mockResolvedValue("broker_view");
    mockedRunAgent.mockReturnValue(fakeAgent());
    const res = await POST(
      req(
        {
          mode: "company",
          target: "005930",
          option: "A",
          threadId: "t1",
          followup: {
            text: "목표주가는 얼마야?",
            currentSpecialistKey: "company_analysis",
            turns: [{ question: null, answer: "첫 답변" }],
          },
        },
        { "x-forwarded-for": nextIp() },
      ),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"specialistKey":"broker_view"');
    const history = mockedRunAgent.mock.calls[0][1];
    expect(history).toEqual([
      { role: "user", content: expect.stringContaining("005930") },
      { role: "assistant", content: "첫 답변" },
      { role: "user", content: "목표주가는 얼마야?" },
    ]);
  });

  it("persists the followup turn with the question and chosen specialist", async () => {
    mockedGetUser.mockResolvedValue({ id: "u1" } as never);
    mockedClassifyIntent.mockResolvedValue("broker_view");
    mockedRunAgent.mockReturnValue(fakeAgent());
    const res = await POST(
      req(
        {
          mode: "company",
          target: "005930",
          option: "A",
          threadId: "t1",
          followup: {
            text: "목표주가는 얼마야?",
            currentSpecialistKey: "company_analysis",
            turns: [{ question: null, answer: "첫 답변" }],
          },
        },
        { "x-forwarded-for": nextIp() },
      ),
    );
    await res.text();
    expect(mockedAppendTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        turn: expect.objectContaining({ question: "목표주가는 얼마야?", specialistKey: "broker_view", answer: "안녕" }),
      }),
    );
  });

  it("does not persist a followup for a guest", async () => {
    mockedGetUser.mockResolvedValue(null);
    mockedClassifyIntent.mockResolvedValue("broker_view");
    mockedRunAgent.mockReturnValue(fakeAgent());
    const res = await POST(
      req(
        {
          mode: "company",
          target: "005930",
          option: "A",
          threadId: "t1",
          followup: { text: "질문", currentSpecialistKey: "company_analysis", turns: [] },
        },
        { "x-forwarded-for": nextIp() },
      ),
    );
    await res.text();
    expect(res.status).toBe(200);
    expect(mockedAppendTurn).not.toHaveBeenCalled();
  });

  it("401s on a portfolio followup for a guest", async () => {
    const res = await POST(
      req(
        { mode: "portfolio", threadId: "t1", followup: { text: "질문", currentSpecialistKey: "portfolio", turns: [] } },
        { "x-forwarded-for": nextIp() },
      ),
    );
    expect(res.status).toBe(401);
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });
});
