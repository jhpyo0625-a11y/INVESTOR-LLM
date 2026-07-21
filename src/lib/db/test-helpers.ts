// src/lib/db/test-helpers.ts
import type { SupabaseClient } from "@supabase/supabase-js";

type FakeResult<T> = { data: T; error: { message: string } | null };

// Test double for Supabase's chainable query builder: every filter method
// (select/eq/order/limit/insert/update/upsert/delete) returns the same
// object, which resolves `result` when awaited — matching how the real
// builder can be awaited after any number of chained calls.
export function fakeSupabaseChain<T>(result: FakeResult<T>) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    single: () => chain,
    maybeSingle: () => chain,
    insert: () => chain,
    update: () => chain,
    upsert: () => chain,
    delete: () => chain,
    then(resolve: (value: FakeResult<T>) => void) {
      resolve(result);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return chain;
}

export function fakeSupabaseClient(chain: unknown): SupabaseClient {
  return { from: () => chain } as unknown as SupabaseClient;
}
