// src/app/api/watchlist/route.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/dal", () => ({ getUser: vi.fn() }));
vi.mock("@/lib/db/watchlist", () => ({ addToWatchlist: vi.fn(), removeFromWatchlist: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/supabase/dal";
import { addToWatchlist, removeFromWatchlist } from "@/lib/db/watchlist";
import { DELETE, POST } from "./route";

const mockedCreateClient = vi.mocked(createClient);
const mockedGetUser = vi.mocked(getUser);
const mockedAdd = vi.mocked(addToWatchlist);
const mockedRemove = vi.mocked(removeFromWatchlist);

beforeEach(() => {
  mockedCreateClient.mockResolvedValue({} as never);
  mockedGetUser.mockReset();
  mockedAdd.mockReset().mockResolvedValue(undefined);
  mockedRemove.mockReset().mockResolvedValue(undefined);
});

function postReq(body: unknown) {
  return new Request("http://localhost/api/watchlist", { method: "POST", body: JSON.stringify(body) });
}
function deleteReq(ticker: string) {
  return new Request(`http://localhost/api/watchlist?ticker=${ticker}`, { method: "DELETE" });
}

describe("POST /api/watchlist", () => {
  it("401s for a guest", async () => {
    mockedGetUser.mockResolvedValue(null);
    const res = await POST(postReq({ ticker: "005930", name: "삼성전자" }));
    expect(res.status).toBe(401);
    expect(mockedAdd).not.toHaveBeenCalled();
  });

  it("400s on an invalid ticker", async () => {
    mockedGetUser.mockResolvedValue({ id: "u1" } as never);
    const res = await POST(postReq({ ticker: "bad", name: "x" }));
    expect(res.status).toBe(400);
    expect(mockedAdd).not.toHaveBeenCalled();
  });

  it("adds to the watchlist for a logged-in user", async () => {
    mockedGetUser.mockResolvedValue({ id: "u1" } as never);
    const res = await POST(postReq({ ticker: "005930", name: "삼성전자" }));
    expect(res.status).toBe(200);
    expect(mockedAdd).toHaveBeenCalledWith(expect.anything(), "u1", "005930", "삼성전자");
  });
});

describe("DELETE /api/watchlist", () => {
  it("401s for a guest", async () => {
    mockedGetUser.mockResolvedValue(null);
    const res = await DELETE(deleteReq("005930"));
    expect(res.status).toBe(401);
    expect(mockedRemove).not.toHaveBeenCalled();
  });

  it("400s with no ticker query param", async () => {
    mockedGetUser.mockResolvedValue({ id: "u1" } as never);
    const res = await DELETE(new Request("http://localhost/api/watchlist", { method: "DELETE" }));
    expect(res.status).toBe(400);
  });

  it("removes from the watchlist for a logged-in user", async () => {
    mockedGetUser.mockResolvedValue({ id: "u1" } as never);
    const res = await DELETE(deleteReq("005930"));
    expect(res.status).toBe(200);
    expect(mockedRemove).toHaveBeenCalledWith(expect.anything(), "u1", "005930");
  });
});
