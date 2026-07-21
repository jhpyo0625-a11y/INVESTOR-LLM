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

// For functions that make multiple sequential `.from()` calls (e.g.
// appendTurn's read-then-write), each call consumes the next chain in
// order; the last chain repeats if more calls happen than chains given.
export function fakeSupabaseClientSequence(chains: unknown[]): SupabaseClient {
  let i = 0;
  return {
    from: () => {
      const chain = chains[Math.min(i, chains.length - 1)];
      i += 1;
      return chain;
    },
  } as unknown as SupabaseClient;
}
