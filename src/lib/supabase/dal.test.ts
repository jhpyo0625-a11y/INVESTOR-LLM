// src/lib/supabase/dal.test.ts
import { describe, expect, it, vi } from "vitest";
import { getUser } from "./dal";
import type { SupabaseClient } from "@supabase/supabase-js";

function fakeClient(result: { user: unknown } | null, error: { message: string } | null = null) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: result?.user ?? null }, error }),
    },
  } as unknown as SupabaseClient;
}

describe("getUser", () => {
  it("returns the user when a session exists", async () => {
    const user = { id: "u1", email: "a@b.com" };
    const result = await getUser(fakeClient({ user }));
    expect(result).toEqual(user);
  });

  it("returns null when there is no session", async () => {
    const result = await getUser(fakeClient(null));
    expect(result).toBeNull();
  });

  it("returns null on an auth error instead of throwing", async () => {
    const result = await getUser(fakeClient(null, { message: "invalid token" }));
    expect(result).toBeNull();
  });
});
