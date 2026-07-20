// src/app/api/chat/route.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/agent/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/agent/engine")>();
  return { ...actual, runAgent: vi.fn() };
});
import { runAgent } from "@/agent/engine";
import { POST } from "./route";

const mockedRunAgent = vi.mocked(runAgent);

beforeEach(() => {
  mockedRunAgent.mockReset();
});

async function* fakeAgent() {
  yield { type: "token" as const, text: "안녕" };
  yield { type: "done" as const };
}

function req(body: unknown): Request {
  return new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify(body) });
}

describe("POST /api/chat", () => {
  it("streams SSE for a valid structured request", async () => {
    mockedRunAgent.mockReturnValue(fakeAgent());
    const res = await POST(req({ mode: "company", target: "005930", option: "A", threadId: "t1" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain('event: token\ndata: {"text":"안녕"}');
    expect(text).toContain('event: done\ndata: {"threadId":"t1","specialistKey":"company_analysis"}');
  });

  it("400s on a malformed body without calling the agent", async () => {
    const res = await POST(req({ mode: "company" }));
    expect(res.status).toBe(400);
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });

  it("400s on an unknown mode:option combination", async () => {
    const res = await POST(req({ mode: "company", target: "005930", option: "C", threadId: "t1" }));
    expect(res.status).toBe(400);
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });

  it("400s on an unknown ticker", async () => {
    const res = await POST(req({ mode: "company", target: "000000", option: "A", threadId: "t1" }));
    expect(res.status).toBe(400);
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });
});
