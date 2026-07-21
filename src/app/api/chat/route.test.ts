// src/app/api/chat/route.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/agent/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/agent/engine")>();
  return { ...actual, runAgent: vi.fn() };
});
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/dal", () => ({ getUser: vi.fn() }));
vi.mock("@/lib/db/analyses", () => ({ persistAnalysis: vi.fn().mockResolvedValue(undefined) }));
import { runAgent } from "@/agent/engine";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/supabase/dal";
import { persistAnalysis } from "@/lib/db/analyses";
import { POST } from "./route";

const mockedRunAgent = vi.mocked(runAgent);
const mockedCreateClient = vi.mocked(createClient);
const mockedGetUser = vi.mocked(getUser);
const mockedPersistAnalysis = vi.mocked(persistAnalysis);

beforeEach(() => {
  mockedRunAgent.mockReset();
  mockedCreateClient.mockResolvedValue({} as never);
  mockedGetUser.mockResolvedValue(null);
  mockedPersistAnalysis.mockClear();
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
    expect(mockedPersistAnalysis).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "u1", threadId: "t1", mode: "company", answer: "안녕" }),
    );
  });

  it("does not persist the analysis for a guest", async () => {
    mockedGetUser.mockResolvedValue(null);
    mockedRunAgent.mockReturnValue(fakeAgent());
    const res = await POST(req({ mode: "company", target: "005930", option: "A", threadId: "t1" }, { "x-forwarded-for": nextIp() }));
    await res.text();
    expect(mockedPersistAnalysis).not.toHaveBeenCalled();
  });
});
