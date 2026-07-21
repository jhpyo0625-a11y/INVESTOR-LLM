// src/app/api/holdings/route.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/dal", () => ({ getUser: vi.fn() }));
vi.mock("@/lib/db/holdings", () => ({ addHolding: vi.fn(), updateHolding: vi.fn(), deleteHolding: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/supabase/dal";
import { addHolding, deleteHolding, updateHolding } from "@/lib/db/holdings";
import { DELETE, PATCH, POST } from "./route";

const mockedCreateClient = vi.mocked(createClient);
const mockedGetUser = vi.mocked(getUser);
const mockedAdd = vi.mocked(addHolding);
const mockedUpdate = vi.mocked(updateHolding);
const mockedDelete = vi.mocked(deleteHolding);

beforeEach(() => {
  mockedCreateClient.mockResolvedValue({} as never);
  mockedGetUser.mockReset();
  mockedAdd.mockReset().mockResolvedValue(undefined);
  mockedUpdate.mockReset().mockResolvedValue(undefined);
  mockedDelete.mockReset().mockResolvedValue(undefined);
});

function jsonReq(method: string, body: unknown) {
  return new Request("http://localhost/api/holdings", { method, body: JSON.stringify(body) });
}

describe("POST /api/holdings", () => {
  it("401s for a guest", async () => {
    mockedGetUser.mockResolvedValue(null);
    const res = await POST(jsonReq("POST", { ticker: "005930", name: "삼성전자", quantity: 10, buyPrice: 70000 }));
    expect(res.status).toBe(401);
  });

  it("400s on a non-positive quantity", async () => {
    mockedGetUser.mockResolvedValue({ id: "u1" } as never);
    const res = await POST(jsonReq("POST", { ticker: "005930", name: "삼성전자", quantity: 0, buyPrice: 70000 }));
    expect(res.status).toBe(400);
    expect(mockedAdd).not.toHaveBeenCalled();
  });

  it("adds a holding for a logged-in user", async () => {
    mockedGetUser.mockResolvedValue({ id: "u1" } as never);
    const res = await POST(jsonReq("POST", { ticker: "005930", name: "삼성전자", quantity: 10, buyPrice: 70000 }));
    expect(res.status).toBe(200);
    expect(mockedAdd).toHaveBeenCalledWith(expect.anything(), "u1", { ticker: "005930", name: "삼성전자", quantity: 10, buyPrice: 70000 });
  });
});

describe("PATCH /api/holdings", () => {
  it("400s on a non-positive buyPrice", async () => {
    mockedGetUser.mockResolvedValue({ id: "u1" } as never);
    const res = await PATCH(jsonReq("PATCH", { id: "h1", quantity: 5, buyPrice: -1 }));
    expect(res.status).toBe(400);
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("updates a holding for a logged-in user", async () => {
    mockedGetUser.mockResolvedValue({ id: "u1" } as never);
    const res = await PATCH(jsonReq("PATCH", { id: "h1", quantity: 5, buyPrice: 71000 }));
    expect(res.status).toBe(200);
    expect(mockedUpdate).toHaveBeenCalledWith(expect.anything(), "u1", "h1", { quantity: 5, buyPrice: 71000 });
  });
});

describe("DELETE /api/holdings", () => {
  it("401s for a guest", async () => {
    mockedGetUser.mockResolvedValue(null);
    const res = await DELETE(new Request("http://localhost/api/holdings?id=h1", { method: "DELETE" }));
    expect(res.status).toBe(401);
  });

  it("deletes a holding for a logged-in user", async () => {
    mockedGetUser.mockResolvedValue({ id: "u1" } as never);
    const res = await DELETE(new Request("http://localhost/api/holdings?id=h1", { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(mockedDelete).toHaveBeenCalledWith(expect.anything(), "u1", "h1");
  });
});
