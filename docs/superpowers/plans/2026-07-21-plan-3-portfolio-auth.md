# Plan 3 — Auth, Portfolio & Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Task 1 is manual and must be executed by the human, not dispatched to a subagent** — it requires clicking through the Supabase dashboard and Google Cloud Console. Pause and hand it to the user; resume subagent dispatch at Task 2.

**Goal:** Add Google login, Supabase persistence, watchlist, holdings P&L, thread history, and a new `PortfolioAnalyst` specialist to INVESTOR-LLM, on top of the existing Plan 1 (agent engine) and Plan 2 (chat UI) — both complete and merged to `main`.

**Architecture:** `@supabase/ssr` for session handling (server client, browser client, `proxy.ts` refresh); Server Components read DB data directly (RLS-scoped), Route Handlers own all mutations (matching Plan 1/2's established pattern). `get_portfolio` is a per-request tool bound to the authenticated session's `user_id` — never LLM-suppliable — wired into the existing `runAgent()` via its `deps.runTool` escape hatch, with zero changes to `engine.ts`.

**Tech Stack:** `@supabase/ssr` `^0.12.3`, `@supabase/supabase-js` `^2.110.7`, on top of the existing Next.js 16 / zod / vitest stack.

## Global Constraints

- Next.js in this repo renames `middleware.ts` → `proxy.ts` (`export function proxy(request)`, placed at `src/proxy.ts` — same directory level as `src/app`). Any Supabase tutorial referencing `middleware.ts` must be adapted to this name/location. Source: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`.
- No new test framework — vitest only, no jsdom/@testing-library. DOM-rendering gaps are accepted (same precedent as Plan 2): extract logic into plain, testable functions; JSX wiring is verified by live Playwright testing only.
- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` are the only Supabase values allowed in the browser bundle. `SUPABASE_SERVICE_ROLE_KEY` is server-only; this plan never needs it (every query is user-scoped, RLS-enforced with the anon key + session cookie).
- Tool inputs are zod-validated, untrusted (LLM-supplied) input. `get_portfolio` must never accept a user-identifying argument from the LLM.
- Guest mode must keep working exactly as today for `company`/`date` analysis — nothing in this plan may require login for the existing Plan 1/2 flows.
- `.env.local` gitignored; `.env.example` gains the new Supabase keys as placeholders.
- Full design rationale: `docs/superpowers/specs/2026-07-21-plan-3-portfolio-auth-design.md`.

---

### Task 1: Manual prerequisite setup (human-executed, not a subagent task)

**Files:** none (external dashboards) + `.env.local` (gitignored, not committed).

Do this yourself before Task 2 begins — a subagent cannot click through these dashboards.

- [ ] **Step 1: Create the Supabase project**

Go to https://supabase.com/dashboard, create a new project. Note down, from Project Settings → API:
- Project URL (`NEXT_PUBLIC_SUPABASE_URL`)
- `anon` `public` key (`NEXT_PUBLIC_SUPABASE_ANON_KEY`)
- `service_role` key (`SUPABASE_SERVICE_ROLE_KEY`) — not used by this plan's code, but save it for `.env.example` completeness/future plans.

- [ ] **Step 2: Apply the DB schema**

In the Supabase dashboard, go to SQL Editor → New query, paste and run:

```sql
create table profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table watchlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  ticker text not null,
  name text not null,
  created_at timestamptz not null default now(),
  unique (user_id, ticker)
);

create table holdings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  ticker text not null,
  name text not null,
  quantity numeric not null check (quantity > 0),
  buy_price numeric not null check (buy_price > 0),
  created_at timestamptz not null default now()
);

create table analyses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  thread_id text not null,
  mode text not null,
  target text not null,
  option text not null,
  steps jsonb not null,
  answer text not null,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;
alter table watchlist enable row level security;
alter table holdings enable row level security;
alter table analyses enable row level security;

create policy "own profile" on profiles for all using (id = auth.uid()) with check (id = auth.uid());
create policy "own watchlist" on watchlist for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own holdings" on holdings for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own analyses" on analyses for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create function public.handle_new_user() returns trigger as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

- [ ] **Step 3: Create the Google OAuth client**

Go to https://console.cloud.google.com → create/select a project → APIs & Services → OAuth consent screen (External, fill in app name/support email) → Credentials → Create Credentials → OAuth client ID → Application type: Web application. Add an Authorized redirect URI:
`https://<your-project-ref>.supabase.co/auth/v1/callback` (find `<your-project-ref>` in the Supabase project URL). Save the generated Client ID and Client Secret.

- [ ] **Step 4: Enable Google in Supabase Auth**

Supabase dashboard → Authentication → Providers → Google → toggle on, paste the Client ID and Client Secret from Step 3 → Save.

- [ ] **Step 5: Configure redirect URLs**

Supabase dashboard → Authentication → URL Configuration → Site URL: `http://localhost:3000`. Add `http://localhost:3000/auth/callback` to Redirect URLs.

- [ ] **Step 6: Add env vars**

In `.env.local` (repo root), add:

```
NEXT_PUBLIC_SUPABASE_URL=https://<your-project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key from Step 1>
SUPABASE_SERVICE_ROLE_KEY=<service role key from Step 1>
```

Tell whoever resumes the plan that this is done — Task 2 onward can proceed (its automated tests mock Supabase and don't need the live project; only the final live-browser verification pass, at the end of the plan, needs it).

---

### Task 2: Supabase client factories + auth DAL

**Files:**
- Modify: `package.json` (add deps)
- Modify: `.env.example`
- Create: `src/lib/supabase/server.ts`
- Create: `src/lib/supabase/client.ts`
- Create: `src/lib/supabase/dal.ts`
- Test: `src/lib/supabase/dal.test.ts`

**Interfaces:**
- Produces: `createClient(): Promise<SupabaseClient>` (server.ts, for Server Components/Route Handlers), `createClient(): SupabaseClient` (client.ts, for Client Components), `getUser(supabase: SupabaseClient): Promise<User | null>` (dal.ts) — every later task's auth check goes through `getUser`.

- [ ] **Step 1: Install dependencies**

Run: `npm install @supabase/ssr@^0.12.3 @supabase/supabase-js@^2.110.7`

Expected: `package.json`'s `dependencies` gains both entries.

- [ ] **Step 2: Add env var placeholders**

Edit `.env.example`, append:

```
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=xxxx
SUPABASE_SERVICE_ROLE_KEY=xxxx
```

- [ ] **Step 3: Write the server client factory**

Create `src/lib/supabase/server.ts`:

```ts
// src/lib/supabase/server.ts
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function createClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component render, where cookies can't be
            // written. Harmless as long as proxy.ts refreshes the session
            // (Task 3) — Supabase's own documented pattern for this split.
          }
        },
      },
    },
  );
}
```

- [ ] **Step 4: Write the browser client factory**

Create `src/lib/supabase/client.ts`:

```ts
// src/lib/supabase/client.ts
import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
```

- [ ] **Step 5: Write the failing test for `getUser`**

Create `src/lib/supabase/dal.test.ts`:

```ts
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
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- dal.test.ts`
Expected: FAIL — `./dal` has no export `getUser`.

- [ ] **Step 7: Implement `getUser`**

Create `src/lib/supabase/dal.ts`:

```ts
// src/lib/supabase/dal.ts
import type { SupabaseClient, User } from "@supabase/supabase-js";

export async function getUser(supabase: SupabaseClient): Promise<User | null> {
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user;
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npm test -- dal.test.ts`
Expected: PASS (3/3).

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json .env.example src/lib/supabase/
git commit -m "feat: add Supabase client factories and auth DAL"
```

---

### Task 3: `proxy.ts` — session refresh + route protection

**Files:**
- Create: `src/proxy.ts`
- Test: `src/proxy.test.ts`

**Interfaces:**
- Consumes: none new.
- Produces: `isProtectedPath(pathname: string): boolean` — exported for direct unit testing since the full request/response proxy flow has no test utility here.

- [ ] **Step 1: Write the failing test**

Create `src/proxy.test.ts`:

```ts
// src/proxy.test.ts
import { describe, expect, it } from "vitest";
import { isProtectedPath } from "./proxy";

describe("isProtectedPath", () => {
  it("protects /portfolio and nested paths", () => {
    expect(isProtectedPath("/portfolio")).toBe(true);
    expect(isProtectedPath("/portfolio/edit")).toBe(true);
  });

  it("protects /history and nested paths", () => {
    expect(isProtectedPath("/history")).toBe(true);
  });

  it("does not protect unrelated paths", () => {
    expect(isProtectedPath("/")).toBe(false);
    expect(isProtectedPath("/t/abc123")).toBe(false);
    expect(isProtectedPath("/portfolio-preview")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- proxy.test.ts`
Expected: FAIL — `./proxy` module not found.

- [ ] **Step 3: Implement `proxy.ts`**

Create `src/proxy.ts`:

```ts
// src/proxy.ts
import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PROTECTED_PATHS = ["/portfolio", "/history"];

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function proxy(request: NextRequest) {
  const response = NextResponse.next();

  try {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              response.cookies.set(name, value, options),
            );
          },
        },
      },
    );

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (isProtectedPath(request.nextUrl.pathname) && !user) {
      return NextResponse.redirect(new URL("/?auth=required", request.url));
    }
  } catch {
    // Session refresh failed (Supabase unreachable, malformed cookie, etc.)
    // — fail open to guest rather than block or crash the request. A demo
    // can never be blocked by an auth-infra hiccup.
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- proxy.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/proxy.ts src/proxy.test.ts
git commit -m "feat: add proxy.ts for session refresh and route protection"
```

---

### Task 4: OAuth callback + login/logout UI

**Files:**
- Create: `src/app/auth/callback/route.ts`
- Create: `src/components/AuthButton.tsx`
- Modify: `src/app/layout.tsx`

**Interfaces:**
- Consumes: `createClient` from `@/lib/supabase/server` (Task 2, callback route), `@/lib/supabase/client` (Task 2, AuthButton).
- Produces: `<AuthButton />` — rendered in the root layout header, used by no other task.

- [ ] **Step 1: Implement the OAuth callback route**

Create `src/app/auth/callback/route.ts`:

```ts
// src/app/auth/callback/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request): Promise<Response> {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}/`);
    }
  }

  return NextResponse.redirect(`${origin}/?auth=failed`);
}
```

This route has no unit test — it's a thin redirect wrapper around a single Supabase SDK call with no branching logic worth mocking; it's covered by the live Playwright pass at the end of this plan.

- [ ] **Step 2: Implement the login/logout button**

Create `src/components/AuthButton.tsx`:

```tsx
// src/components/AuthButton.tsx
"use client";

import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

export function AuthButton() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (loading) return null;

  if (user) {
    return (
      <button
        type="button"
        onClick={async () => {
          await createClient().auth.signOut();
          window.location.href = "/";
        }}
        className="rounded-full border px-4 py-1.5 text-xs font-medium"
      >
        로그아웃
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() =>
        createClient().auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo: `${window.location.origin}/auth/callback` },
        })
      }
      className="rounded-full bg-black px-4 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-black"
    >
      Google로 로그인
    </button>
  );
}
```

- [ ] **Step 3: Wire it into the root layout**

Edit `src/app/layout.tsx` — replace the `<body>` line and its closing tag:

```tsx
import { AuthButton } from "@/components/AuthButton";
```

(add to the top imports, alongside the existing `Geist`/`Geist_Mono` imports)

```tsx
      <body className="min-h-full flex flex-col">
        <header className="flex items-center justify-end border-b px-6 py-3">
          <AuthButton />
        </header>
        {children}
      </body>
```

- [ ] **Step 4: Manual smoke check**

Run: `npm run dev`, visit `http://localhost:3000`, click "Google로 로그인", complete the Google consent screen, confirm you land back on `/` with "로그아웃" now showing. Click it, confirm the button reverts to "Google로 로그인".

- [ ] **Step 5: Commit**

```bash
git add src/app/auth/ src/components/AuthButton.tsx src/app/layout.tsx
git commit -m "feat: add Google OAuth login/logout"
```

---

### Task 5: Watchlist and holdings data layer

**Files:**
- Create: `src/lib/db/test-helpers.ts`
- Create: `src/lib/db/watchlist.ts`
- Test: `src/lib/db/watchlist.test.ts`
- Create: `src/lib/db/holdings.ts`
- Test: `src/lib/db/holdings.test.ts`

**Interfaces:**
- Produces: `listWatchlist(supabase, userId): Promise<WatchlistItem[]>`, `addToWatchlist(supabase, userId, ticker, name): Promise<void>`, `removeFromWatchlist(supabase, userId, ticker): Promise<void>`; `listHoldings(supabase, userId): Promise<Holding[]>`, `addHolding(supabase, userId, input): Promise<void>`, `updateHolding(supabase, userId, id, input): Promise<void>`, `deleteHolding(supabase, userId, id): Promise<void>`. `WatchlistItem = {id, ticker, name, createdAt}`, `Holding = {id, ticker, name, quantity, buyPrice, createdAt}` — both used by Task 9 (tool), Task 12/13 (routes), Task 15 (Sidebar), Task 16 (portfolio page).

- [ ] **Step 1: Write the shared test helper**

Supabase's query builder (`.from().select().eq()...`) is thenable at every step — the same chain object can be `await`ed after any number of chained calls. Create `src/lib/db/test-helpers.ts`:

```ts
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
```

- [ ] **Step 2: Write the failing watchlist test**

Create `src/lib/db/watchlist.test.ts`:

```ts
// src/lib/db/watchlist.test.ts
import { describe, expect, it } from "vitest";
import { fakeSupabaseChain, fakeSupabaseClient } from "./test-helpers";
import { addToWatchlist, listWatchlist, removeFromWatchlist } from "./watchlist";

describe("watchlist data layer", () => {
  it("lists a user's watchlist", async () => {
    const rows = [{ id: "w1", ticker: "005930", name: "삼성전자", created_at: "2026-07-20T00:00:00Z" }];
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: rows, error: null }));
    const result = await listWatchlist(client, "u1");
    expect(result).toEqual([{ id: "w1", ticker: "005930", name: "삼성전자", createdAt: "2026-07-20T00:00:00Z" }]);
  });

  it("throws with the Supabase error message on a list failure", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: null, error: { message: "boom" } }));
    await expect(listWatchlist(client, "u1")).rejects.toThrow("boom");
  });

  it("adds to the watchlist without throwing on success", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: null, error: null }));
    await expect(addToWatchlist(client, "u1", "005930", "삼성전자")).resolves.toBeUndefined();
  });

  it("removes from the watchlist without throwing on success", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: null, error: null }));
    await expect(removeFromWatchlist(client, "u1", "005930")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- watchlist.test.ts`
Expected: FAIL — `./watchlist` module not found.

- [ ] **Step 4: Implement `watchlist.ts`**

Create `src/lib/db/watchlist.ts`:

```ts
// src/lib/db/watchlist.ts
import type { SupabaseClient } from "@supabase/supabase-js";

export type WatchlistItem = { id: string; ticker: string; name: string; createdAt: string };

export async function listWatchlist(supabase: SupabaseClient, userId: string): Promise<WatchlistItem[]> {
  const { data, error } = await supabase
    .from("watchlist")
    .select("id, ticker, name, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listWatchlist: ${error.message}`);
  return (data ?? []).map((r: { id: string; ticker: string; name: string; created_at: string }) => ({
    id: r.id,
    ticker: r.ticker,
    name: r.name,
    createdAt: r.created_at,
  }));
}

export async function addToWatchlist(
  supabase: SupabaseClient,
  userId: string,
  ticker: string,
  name: string,
): Promise<void> {
  const { error } = await supabase
    .from("watchlist")
    .upsert({ user_id: userId, ticker, name }, { onConflict: "user_id,ticker" });
  if (error) throw new Error(`addToWatchlist: ${error.message}`);
}

export async function removeFromWatchlist(supabase: SupabaseClient, userId: string, ticker: string): Promise<void> {
  const { error } = await supabase.from("watchlist").delete().eq("user_id", userId).eq("ticker", ticker);
  if (error) throw new Error(`removeFromWatchlist: ${error.message}`);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- watchlist.test.ts`
Expected: PASS (4/4).

- [ ] **Step 6: Write the failing holdings test**

Create `src/lib/db/holdings.test.ts`:

```ts
// src/lib/db/holdings.test.ts
import { describe, expect, it } from "vitest";
import { fakeSupabaseChain, fakeSupabaseClient } from "./test-helpers";
import { addHolding, deleteHolding, listHoldings, updateHolding } from "./holdings";

describe("holdings data layer", () => {
  it("lists a user's holdings", async () => {
    const rows = [
      { id: "h1", ticker: "005930", name: "삼성전자", quantity: 10, buy_price: 70000, created_at: "2026-07-20T00:00:00Z" },
    ];
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: rows, error: null }));
    const result = await listHoldings(client, "u1");
    expect(result).toEqual([
      { id: "h1", ticker: "005930", name: "삼성전자", quantity: 10, buyPrice: 70000, createdAt: "2026-07-20T00:00:00Z" },
    ]);
  });

  it("throws with the Supabase error message on a list failure", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: null, error: { message: "boom" } }));
    await expect(listHoldings(client, "u1")).rejects.toThrow("boom");
  });

  it("adds a holding without throwing on success", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: null, error: null }));
    await expect(
      addHolding(client, "u1", { ticker: "005930", name: "삼성전자", quantity: 10, buyPrice: 70000 }),
    ).resolves.toBeUndefined();
  });

  it("updates a holding without throwing on success", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: null, error: null }));
    await expect(updateHolding(client, "u1", "h1", { quantity: 5, buyPrice: 71000 })).resolves.toBeUndefined();
  });

  it("deletes a holding without throwing on success", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: null, error: null }));
    await expect(deleteHolding(client, "u1", "h1")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npm test -- holdings.test.ts`
Expected: FAIL — `./holdings` module not found.

- [ ] **Step 8: Implement `holdings.ts`**

Create `src/lib/db/holdings.ts`:

```ts
// src/lib/db/holdings.ts
import type { SupabaseClient } from "@supabase/supabase-js";

export type Holding = {
  id: string;
  ticker: string;
  name: string;
  quantity: number;
  buyPrice: number;
  createdAt: string;
};

type HoldingRow = {
  id: string;
  ticker: string;
  name: string;
  quantity: number;
  buy_price: number;
  created_at: string;
};

function toHolding(r: HoldingRow): Holding {
  return { id: r.id, ticker: r.ticker, name: r.name, quantity: r.quantity, buyPrice: r.buy_price, createdAt: r.created_at };
}

export async function listHoldings(supabase: SupabaseClient, userId: string): Promise<Holding[]> {
  const { data, error } = await supabase
    .from("holdings")
    .select("id, ticker, name, quantity, buy_price, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listHoldings: ${error.message}`);
  return (data ?? []).map(toHolding);
}

export async function addHolding(
  supabase: SupabaseClient,
  userId: string,
  input: { ticker: string; name: string; quantity: number; buyPrice: number },
): Promise<void> {
  const { error } = await supabase.from("holdings").insert({
    user_id: userId,
    ticker: input.ticker,
    name: input.name,
    quantity: input.quantity,
    buy_price: input.buyPrice,
  });
  if (error) throw new Error(`addHolding: ${error.message}`);
}

export async function updateHolding(
  supabase: SupabaseClient,
  userId: string,
  id: string,
  input: { quantity: number; buyPrice: number },
): Promise<void> {
  const { error } = await supabase
    .from("holdings")
    .update({ quantity: input.quantity, buy_price: input.buyPrice })
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw new Error(`updateHolding: ${error.message}`);
}

export async function deleteHolding(supabase: SupabaseClient, userId: string, id: string): Promise<void> {
  const { error } = await supabase.from("holdings").delete().eq("id", id).eq("user_id", userId);
  if (error) throw new Error(`deleteHolding: ${error.message}`);
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npm test -- holdings.test.ts`
Expected: PASS (5/5).

- [ ] **Step 10: Commit**

```bash
git add src/lib/db/test-helpers.ts src/lib/db/watchlist.ts src/lib/db/watchlist.test.ts src/lib/db/holdings.ts src/lib/db/holdings.test.ts
git commit -m "feat: add watchlist and holdings data layer"
```

---

### Task 6: Analyses data layer (persistence + history)

**Files:**
- Create: `src/lib/db/analyses.ts`
- Test: `src/lib/db/analyses.test.ts`

**Interfaces:**
- Consumes: `fakeSupabaseChain`/`fakeSupabaseClient` (Task 5, test only), `StepPayload` from `@/lib/chat-types` (existing, Plan 2).
- Produces: `persistAnalysis(supabase, input): Promise<void>`, `getAnalysisByThreadId(supabase, userId, threadId): Promise<SavedAnalysis | null>`, `listRecentAnalyses(supabase, userId, limit?): Promise<SavedAnalysis[]>`. `SavedAnalysis = {id, threadId, mode, target, option, steps, answer, createdAt}` — used by Task 12 (persistence), Task 16 (`/portfolio`... actually `/history`), Task 17 (replay).

- [ ] **Step 1: Write the failing test**

Create `src/lib/db/analyses.test.ts`:

```ts
// src/lib/db/analyses.test.ts
import { describe, expect, it } from "vitest";
import { fakeSupabaseChain, fakeSupabaseClient } from "./test-helpers";
import { getAnalysisByThreadId, listRecentAnalyses, persistAnalysis } from "./analyses";

const row = {
  id: "a1",
  thread_id: "t1",
  mode: "company",
  target: "005930",
  option: "A",
  steps: [{ type: "action", tool: "get_stock_data", text: "{}" }],
  answer: "요약입니다",
  created_at: "2026-07-20T00:00:00Z",
};

describe("analyses data layer", () => {
  it("persists an analysis without throwing on success", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: null, error: null }));
    await expect(
      persistAnalysis(client, {
        userId: "u1",
        threadId: "t1",
        mode: "company",
        target: "005930",
        option: "A",
        steps: [],
        answer: "답변",
      }),
    ).resolves.toBeUndefined();
  });

  it("throws with the Supabase error message on a persist failure", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: null, error: { message: "boom" } }));
    await expect(
      persistAnalysis(client, { userId: "u1", threadId: "t1", mode: "company", target: "005930", option: "A", steps: [], answer: "" }),
    ).rejects.toThrow("boom");
  });

  it("gets a saved analysis by thread id", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: row, error: null }));
    const result = await getAnalysisByThreadId(client, "u1", "t1");
    expect(result?.threadId).toBe("t1");
    expect(result?.answer).toBe("요약입니다");
  });

  it("returns null when no saved analysis exists for the thread", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: null, error: null }));
    const result = await getAnalysisByThreadId(client, "u1", "unknown-thread");
    expect(result).toBeNull();
  });

  it("lists recent analyses newest first", async () => {
    const client = fakeSupabaseClient(fakeSupabaseChain({ data: [row], error: null }));
    const result = await listRecentAnalyses(client, "u1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- analyses.test.ts`
Expected: FAIL — `./analyses` module not found.

- [ ] **Step 3: Implement `analyses.ts`**

Create `src/lib/db/analyses.ts`:

```ts
// src/lib/db/analyses.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StepPayload } from "@/lib/chat-types";

export type SavedAnalysis = {
  id: string;
  threadId: string;
  mode: string;
  target: string;
  option: string;
  steps: StepPayload[];
  answer: string;
  createdAt: string;
};

type AnalysisRow = {
  id: string;
  thread_id: string;
  mode: string;
  target: string;
  option: string;
  steps: StepPayload[];
  answer: string;
  created_at: string;
};

function toSavedAnalysis(r: AnalysisRow): SavedAnalysis {
  return {
    id: r.id,
    threadId: r.thread_id,
    mode: r.mode,
    target: r.target,
    option: r.option,
    steps: r.steps,
    answer: r.answer,
    createdAt: r.created_at,
  };
}

export async function persistAnalysis(
  supabase: SupabaseClient,
  input: { userId: string; threadId: string; mode: string; target: string; option: string; steps: StepPayload[]; answer: string },
): Promise<void> {
  const { error } = await supabase.from("analyses").insert({
    user_id: input.userId,
    thread_id: input.threadId,
    mode: input.mode,
    target: input.target,
    option: input.option,
    steps: input.steps,
    answer: input.answer,
  });
  if (error) throw new Error(`persistAnalysis: ${error.message}`);
}

export async function getAnalysisByThreadId(
  supabase: SupabaseClient,
  userId: string,
  threadId: string,
): Promise<SavedAnalysis | null> {
  const { data, error } = await supabase
    .from("analyses")
    .select("id, thread_id, mode, target, option, steps, answer, created_at")
    .eq("user_id", userId)
    .eq("thread_id", threadId)
    .maybeSingle();
  if (error) throw new Error(`getAnalysisByThreadId: ${error.message}`);
  return data ? toSavedAnalysis(data as AnalysisRow) : null;
}

export async function listRecentAnalyses(supabase: SupabaseClient, userId: string, limit = 5): Promise<SavedAnalysis[]> {
  const { data, error } = await supabase
    .from("analyses")
    .select("id, thread_id, mode, target, option, steps, answer, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listRecentAnalyses: ${error.message}`);
  return (data ?? []).map(toSavedAnalysis);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- analyses.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/analyses.ts src/lib/db/analyses.test.ts
git commit -m "feat: add analyses data layer for persistence and history"
```

---

### Task 7: P&L calculation

**Files:**
- Create: `src/lib/portfolio-calc.ts`
- Test: `src/lib/portfolio-calc.test.ts`

**Interfaces:**
- Produces: `calculateHoldingPL(h: PricedHolding): HoldingPL`. `PricedHolding = {ticker, name, quantity, buyPrice, currentPrice: number | null}`, `HoldingPL = {valueKrw: number | null, ratePct: number | null}` — used by Task 9 (tool), Task 15 (Sidebar), Task 16 (`/portfolio` table).

- [ ] **Step 1: Write the failing test**

Create `src/lib/portfolio-calc.test.ts`:

```ts
// src/lib/portfolio-calc.test.ts
import { describe, expect, it } from "vitest";
import { calculateHoldingPL } from "./portfolio-calc";

describe("calculateHoldingPL", () => {
  it("computes positive P&L", () => {
    const result = calculateHoldingPL({ ticker: "005930", name: "삼성전자", quantity: 10, buyPrice: 70000, currentPrice: 77000 });
    expect(result.valueKrw).toBe(70000);
    expect(result.ratePct).toBeCloseTo(10, 5);
  });

  it("computes negative P&L", () => {
    const result = calculateHoldingPL({ ticker: "005930", name: "삼성전자", quantity: 10, buyPrice: 70000, currentPrice: 63000 });
    expect(result.valueKrw).toBe(-70000);
    expect(result.ratePct).toBeCloseTo(-10, 5);
  });

  it("returns nulls when the current price is unavailable", () => {
    const result = calculateHoldingPL({ ticker: "005930", name: "삼성전자", quantity: 10, buyPrice: 70000, currentPrice: null });
    expect(result.valueKrw).toBeNull();
    expect(result.ratePct).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- portfolio-calc.test.ts`
Expected: FAIL — `./portfolio-calc` module not found.

- [ ] **Step 3: Implement it**

Create `src/lib/portfolio-calc.ts`:

```ts
// src/lib/portfolio-calc.ts
export type PricedHolding = {
  ticker: string;
  name: string;
  quantity: number;
  buyPrice: number;
  currentPrice: number | null;
};

export type HoldingPL = { valueKrw: number | null; ratePct: number | null };

export function calculateHoldingPL(h: PricedHolding): HoldingPL {
  if (h.currentPrice === null) return { valueKrw: null, ratePct: null };
  const valueKrw = (h.currentPrice - h.buyPrice) * h.quantity;
  const costBasis = h.buyPrice * h.quantity;
  const ratePct = costBasis === 0 ? 0 : (valueKrw / costBasis) * 100;
  return { valueKrw, ratePct };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- portfolio-calc.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/lib/portfolio-calc.ts src/lib/portfolio-calc.test.ts
git commit -m "feat: add holding P&L calculation"
```

---

### Task 8: Extend `chatRequestSchema` with `mode: "portfolio"`

**Files:**
- Modify: `src/lib/chat-types.ts`
- Create: `src/lib/chat-types.test.ts`

**Interfaces:**
- Produces: `chatRequestSchema` now accepts `mode: "company" | "date" | "portfolio"` with `target`/`option` optional (required only for `company`/`date`, `date` still requires `YYYY-MM-DD`). `ChatRequest` type gains `target?: string`, `option?: "A"|"B"|"C"|"D"`. Consumed by Task 12 (`/api/chat`), Task 17 (`ChatThread.tsx`).

- [ ] **Step 1: Write the failing test**

Create `src/lib/chat-types.test.ts`:

```ts
// src/lib/chat-types.test.ts
import { describe, expect, it } from "vitest";
import { chatRequestSchema } from "./chat-types";

describe("chatRequestSchema", () => {
  it("accepts a valid company request", () => {
    expect(chatRequestSchema.safeParse({ mode: "company", target: "005930", option: "A", threadId: "t1" }).success).toBe(true);
  });

  it("accepts a valid date request", () => {
    expect(chatRequestSchema.safeParse({ mode: "date", target: "2026-07-20", option: "A", threadId: "t1" }).success).toBe(true);
  });

  it("rejects a date request with a malformed date", () => {
    expect(chatRequestSchema.safeParse({ mode: "date", target: "not-a-date", option: "A", threadId: "t1" }).success).toBe(false);
  });

  it("rejects a company request missing target", () => {
    expect(chatRequestSchema.safeParse({ mode: "company", option: "A", threadId: "t1" }).success).toBe(false);
  });

  it("rejects a company request missing option", () => {
    expect(chatRequestSchema.safeParse({ mode: "company", target: "005930", threadId: "t1" }).success).toBe(false);
  });

  it("accepts a portfolio request with no target or option", () => {
    expect(chatRequestSchema.safeParse({ mode: "portfolio", threadId: "t1" }).success).toBe(true);
  });

  it("rejects a request missing threadId regardless of mode", () => {
    expect(chatRequestSchema.safeParse({ mode: "portfolio" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- chat-types.test.ts`
Expected: FAIL — the last 2 cases fail against the current schema (`mode` enum has no `"portfolio"`, `target`/`option` are unconditionally required).

- [ ] **Step 3: Update the schema**

Edit `src/lib/chat-types.ts`, replace the `chatRequestSchema` definition:

```ts
export const chatRequestSchema = z
  .object({
    mode: z.enum(["company", "date", "portfolio"]),
    target: z.string().min(1).optional(),
    option: z.enum(["A", "B", "C", "D"]).optional(),
    threadId: z.string().min(1),
  })
  .refine((v) => v.mode === "portfolio" || v.target !== undefined, {
    message: "target is required for mode:company/date",
    path: ["target"],
  })
  .refine((v) => v.mode === "portfolio" || v.option !== undefined, {
    message: "option is required for mode:company/date",
    path: ["option"],
  })
  .refine((v) => v.mode !== "date" || (v.target !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(v.target)), {
    message: "target must be YYYY-MM-DD for mode:date",
    path: ["target"],
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- chat-types.test.ts`
Expected: PASS (7/7).

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: all existing tests still pass (`route.test.ts`'s malformed-body/malformed-date cases still 400, since the base object shape and date-format refinement are unchanged for `company`/`date`).

- [ ] **Step 6: Commit**

```bash
git add src/lib/chat-types.ts src/lib/chat-types.test.ts
git commit -m "feat: add portfolio mode to chatRequestSchema"
```

---

### Task 9: Extract `invokeTool` from `runTool`

**Files:**
- Modify: `src/tools/index.ts`
- Modify: `src/tools/index.test.ts`

**Interfaces:**
- Produces: `invokeTool(tool: Tool, args: unknown): Promise<ToolResult>` — the validate-and-run body used by both the static-registry `runTool(name, args)` and (Task 11) the portfolio specialist's per-request tool dispatch.

- [ ] **Step 1: Write the failing test**

Edit `src/tools/index.test.ts`, add inside the existing `describe("runTool", ...)` block's setup (after the `boom`/`echo` tool declarations, before the existing `it(...)` calls), import and test `invokeTool` directly:

```ts
import { invokeTool, registerTools, runTool } from "./index";
```

(replace the existing `import { registerTools, runTool } from "./index";` line with the one above)

Add a new test, alongside the existing ones inside `describe("runTool", ...)`:

```ts
  it("invokeTool runs a Tool object directly, same validation as runTool", async () => {
    expect(await invokeTool(echo, { msg: "hi" })).toEqual({ ok: true, data: { msg: "hi" } });
    expect((await invokeTool(echo, { msg: 42 })).ok).toBe(false);
    expect(await invokeTool(boom, {})).toEqual({ ok: false, error: "kaput" });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- index.test.ts`
Expected: FAIL — `./index` has no export `invokeTool`.

- [ ] **Step 3: Extract `invokeTool`**

Edit `src/tools/index.ts`, replace the `runTool` function:

```ts
export async function invokeTool(tool: Tool, args: unknown): Promise<ToolResult> {
  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) return { ok: false, error: `invalid args: ${parsed.error.message}` };
  try {
    return await tool.run(parsed.data);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function runTool(name: string, args: unknown): Promise<ToolResult> {
  const tool = toolRegistry[name];
  if (!tool) return { ok: false, error: `unknown tool: ${name}` };
  return invokeTool(tool, args);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- index.test.ts`
Expected: PASS (5/5, all pre-existing cases plus the new one).

- [ ] **Step 5: Commit**

```bash
git add src/tools/index.ts src/tools/index.test.ts
git commit -m "refactor: extract invokeTool from runTool"
```

---

### Task 10: `get_portfolio` tool

**Files:**
- Create: `src/tools/portfolio.ts`
- Test: `src/tools/portfolio.test.ts`

**Interfaces:**
- Consumes: `listHoldings` (Task 5), `calculateHoldingPL` (Task 7), `getStockData` (existing, `src/tools/stock.ts`).
- Produces: `makeGetPortfolioTool(userId: string, supabase: SupabaseClient): Tool` — used by Task 11's `buildPortfolioSpecialist`. The returned tool's `name` is `"get_portfolio"`.

- [ ] **Step 1: Write the failing test**

Create `src/tools/portfolio.test.ts`:

```ts
// src/tools/portfolio.test.ts
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/db/holdings", () => ({ listHoldings: vi.fn() }));
vi.mock("./stock", () => ({ getStockData: { name: "get_stock_data", run: vi.fn() } }));

import { listHoldings } from "@/lib/db/holdings";
import { getStockData } from "./stock";
import { makeGetPortfolioTool } from "./portfolio";

const mockedListHoldings = vi.mocked(listHoldings);
const mockedGetStockDataRun = vi.mocked(getStockData.run);

describe("get_portfolio tool", () => {
  it("is named get_portfolio and takes no meaningful args", () => {
    const tool = makeGetPortfolioTool("u1", {} as SupabaseClient);
    expect(tool.name).toBe("get_portfolio");
  });

  it("returns priced holdings joined with current price and P&L", async () => {
    mockedListHoldings.mockResolvedValue([
      { id: "h1", ticker: "005930", name: "삼성전자", quantity: 10, buyPrice: 70000, createdAt: "2026-07-20T00:00:00Z" },
    ]);
    mockedGetStockDataRun.mockResolvedValue({ ok: true, data: { price: { close: 77000 } } });

    const tool = makeGetPortfolioTool("u1", {} as SupabaseClient);
    const result = await tool.run({});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { holdings: Array<{ ticker: string; currentPrice: number; valueKrw: number }> };
    expect(data.holdings[0].ticker).toBe("005930");
    expect(data.holdings[0].currentPrice).toBe(77000);
    expect(data.holdings[0].valueKrw).toBe(70000);
  });

  it("returns an empty array, not an error, for zero holdings", async () => {
    mockedListHoldings.mockResolvedValue([]);
    const tool = makeGetPortfolioTool("u1", {} as SupabaseClient);
    const result = await tool.run({});
    expect(result).toEqual({ ok: true, data: { holdings: [] } });
  });

  it("sets currentPrice/valueKrw to null when the price lookup fails, without failing the whole tool", async () => {
    mockedListHoldings.mockResolvedValue([
      { id: "h1", ticker: "005930", name: "삼성전자", quantity: 10, buyPrice: 70000, createdAt: "2026-07-20T00:00:00Z" },
    ]);
    mockedGetStockDataRun.mockResolvedValue({ ok: false, error: "upstream down" });

    const tool = makeGetPortfolioTool("u1", {} as SupabaseClient);
    const result = await tool.run({});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { holdings: Array<{ currentPrice: number | null; valueKrw: number | null }> };
    expect(data.holdings[0].currentPrice).toBeNull();
    expect(data.holdings[0].valueKrw).toBeNull();
  });

  it("scopes to the bound userId, not an LLM-supplied argument", async () => {
    mockedListHoldings.mockResolvedValue([]);
    const tool = makeGetPortfolioTool("bound-user", {} as SupabaseClient);
    // Even if the LLM passes a different userId in args, the tool ignores it —
    // listHoldings is always called with the userId bound at construction time.
    await tool.run({ userId: "someone-else" });
    expect(mockedListHoldings).toHaveBeenCalledWith(expect.anything(), "bound-user");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- portfolio.test.ts`
Expected: FAIL — `./portfolio` module not found.

- [ ] **Step 3: Implement it**

Create `src/tools/portfolio.ts`:

```ts
// src/tools/portfolio.ts
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listHoldings } from "@/lib/db/holdings";
import { calculateHoldingPL } from "@/lib/portfolio-calc";
import type { Tool } from "./types";
import { getStockData } from "./stock";

const argsSchema = z.object({});

export function makeGetPortfolioTool(userId: string, supabase: SupabaseClient): Tool {
  return {
    name: "get_portfolio",
    description: "현재 로그인한 사용자의 보유 종목(수량, 평단가)과 각 종목의 현재가·평가손익을 반환한다. 인자 없음.",
    schema: argsSchema,
    async run() {
      // userId is bound here at construction time from the authenticated
      // session — never read from `args`, which is LLM-supplied and untrusted.
      const holdings = await listHoldings(supabase, userId);
      if (holdings.length === 0) {
        return { ok: true, data: { holdings: [] } };
      }

      const priced = await Promise.all(
        holdings.map(async (h) => {
          const priceResult = await getStockData.run({ ticker: h.ticker });
          const currentPrice = priceResult.ok ? (priceResult.data as { price: { close: number } }).price.close : null;
          const pl = calculateHoldingPL({ ticker: h.ticker, name: h.name, quantity: h.quantity, buyPrice: h.buyPrice, currentPrice });
          return {
            ticker: h.ticker,
            name: h.name,
            quantity: h.quantity,
            buyPrice: h.buyPrice,
            currentPrice,
            valueKrw: pl.valueKrw,
            ratePct: pl.ratePct,
          };
        }),
      );

      return { ok: true, data: { holdings: priced } };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- portfolio.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/tools/portfolio.ts src/tools/portfolio.test.ts
git commit -m "feat: add get_portfolio tool, session-bound to prevent IDOR"
```

---

### Task 11: `PortfolioAnalyst` specialist + orchestrator wiring

**Files:**
- Modify: `src/agent/specialists.ts`
- Modify: `src/agent/orchestrator.ts`
- Modify: `src/agent/orchestrator.test.ts`

**Interfaces:**
- Consumes: `makeGetPortfolioTool` (Task 10), `invokeTool` (Task 9).
- Produces: `SPECIALIST_KEYS` gains `"portfolio"`. `buildPortfolioSpecialist(userId, supabase): SpecialistConfig` and `buildPortfolioRunTool(config: SpecialistConfig): (name, args) => Promise<ToolResult>` (specialists.ts). `route(req, ctx?): SpecialistConfig | undefined` — return type **unchanged** (backward compatible with existing callers/tests), gains an optional second parameter `ctx?: {userId?: string; supabase?: SupabaseClient}`. `buildInitialMessage(req)` gains a `mode: "portfolio"` branch. Used by Task 12 (`/api/chat`).

- [ ] **Step 1: Write the failing orchestrator test**

Edit `src/agent/orchestrator.test.ts`, add at the end of the `describe("orchestrator routing", ...)` block:

```ts
  it("portfolio mode with no userId routes nowhere", () => {
    expect(route({ mode: "portfolio", target: "", option: undefined })).toBeUndefined();
  });

  it("portfolio mode with a userId and supabase client routes to the portfolio specialist", () => {
    const fakeSupabase = {} as never;
    const specialist = route({ mode: "portfolio", target: "", option: undefined }, { userId: "u1", supabase: fakeSupabase });
    expect(specialist?.key).toBe("portfolio");
  });

  it("portfolio message has no ticker/date, just the instruction", () => {
    const msg = buildInitialMessage({ mode: "portfolio", target: "", option: undefined });
    expect(msg).toContain("포트폴리오");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- orchestrator.test.ts`
Expected: FAIL — `AnalysisRequest["mode"]` doesn't include `"portfolio"` yet (type error) and `route`/`buildInitialMessage` have no portfolio branch.

- [ ] **Step 3: Add `buildPortfolioSpecialist` and `buildPortfolioRunTool`**

Edit `src/agent/specialists.ts` — add the import and the new exports (after the existing `specialists` `Record` definition):

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeGetPortfolioTool } from "@/tools/portfolio";
import { invokeTool } from "@/tools/index";
import type { ToolResult } from "@/tools/types";
```

(add these to the top imports, alongside the existing `import type { SpecialistConfig } from "./engine";` line)

Change the `SPECIALIST_KEYS` array:

```ts
export const SPECIALIST_KEYS = [
  "company_analysis",
  "broker_view",
  "macro",
  "daily_reports",
  "disclosures",
  "flows",
  "portfolio",
] as const;
```

Append after the closing `};` of the `specialists` `Record`:

```ts
export function buildPortfolioSpecialist(userId: string, supabase: SupabaseClient): SpecialistConfig {
  const portfolioTool = makeGetPortfolioTool(userId, supabase);
  return {
    key: "portfolio",
    systemPrompt: `${COMMON}
임무: 로그인한 사용자의 보유 포트폴리오 분석.
순서: (1) get_portfolio로 보유 종목, 수량, 평단가, 현재가, 평가손익 확보 (2) 보유 종목이 없으면 "보유 종목 없음"이라고 명시 (3) 필요시 web_search로 개별 종목 최근 뉴스 보강.
리포트 구성: 포트폴리오 요약(총 평가손익) → 종목별 현황(표) → 리스크가 큰 종목 코멘트 → 전반적 포트폴리오 조언.`,
    tools: [portfolioTool, getStockData, webSearch],
  };
}

// PortfolioAnalyst's get_portfolio tool is built per-request (bound to a
// specific userId), so it can't live in the static toolRegistry that the
// other 5 specialists' tools share. This builds a runTool override, scoped
// to a single SpecialistConfig's own tools, for runAgent's deps.runTool hook.
export function buildPortfolioRunTool(config: SpecialistConfig): (name: string, args: unknown) => Promise<ToolResult> {
  const byName = new Map(config.tools.map((t) => [t.name, t] as const));
  return async (name, args) => {
    const tool = byName.get(name);
    return tool ? invokeTool(tool, args) : { ok: false, error: `unknown tool: ${name}` };
  };
}
```

Note: `SPECIALIST_KEYS` now includes `"portfolio"`, but the `specialists: Record<SpecialistKey, SpecialistConfig>` declaration would fail to typecheck (missing the `portfolio` key) unless narrowed. Edit the `specialists` declaration line:

```ts
export const specialists: Record<Exclude<SpecialistKey, "portfolio">, SpecialistConfig> = {
```

(only this line changes — the object body itself, all 6 existing entries, stays exactly as-is)

- [ ] **Step 4: Wire `route()` and `buildInitialMessage()`**

Edit `src/agent/orchestrator.ts` — replace the file:

```ts
import { specialists, buildPortfolioSpecialist, type SpecialistKey } from "./specialists";
import type { SpecialistConfig } from "./engine";
import { findByTicker } from "@/lib/listings";
import type { SupabaseClient } from "@supabase/supabase-js";

export type AnalysisRequest = {
  mode: "company" | "date" | "portfolio";
  target: string; // ticker (6자리), YYYY-MM-DD, or "" for mode:portfolio
  option?: "A" | "B" | "C" | "D";
};

// Excludes "portfolio" — that branch never goes through this table (see
// route() below) — so specialists[key] below stays type-safe against
// specialists' narrower Record<Exclude<SpecialistKey, "portfolio">, ...>.
const ROUTES: Record<string, Exclude<SpecialistKey, "portfolio">> = {
  "company:A": "company_analysis",
  "company:B": "broker_view",
  "date:A": "macro",
  "date:B": "daily_reports",
  "date:C": "disclosures",
  "date:D": "flows",
};

export function route(
  req: AnalysisRequest,
  ctx?: { userId?: string; supabase?: SupabaseClient },
): SpecialistConfig | undefined {
  if (req.mode === "portfolio") {
    return ctx?.userId && ctx?.supabase ? buildPortfolioSpecialist(ctx.userId, ctx.supabase) : undefined;
  }
  const key = ROUTES[`${req.mode}:${req.option}`];
  return key ? specialists[key] : undefined;
}

export function buildInitialMessage(req: AnalysisRequest): string {
  const today = new Date().toISOString().slice(0, 10);
  if (req.mode === "portfolio") {
    return `오늘 날짜: ${today}. 위 임무에 따라 보유 포트폴리오를 분석하라.`;
  }
  if (req.mode === "company") {
    const c = findByTicker(req.target);
    if (!c) throw new Error(`unknown ticker: ${req.target}`);
    return `분석 대상 기업: ${c.name} (종목코드 ${c.ticker}, DART corpCode ${c.corpCode}). 오늘 날짜: ${today}. 위 임무에 따라 분석하라.`;
  }
  const compact = req.target.replaceAll("-", "");
  return `기준일: ${req.target} (DART 조회용 표기: ${compact}). 오늘 날짜: ${today}. 위 임무에 따라 분석하라.`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- orchestrator.test.ts`
Expected: PASS (all pre-existing cases plus the 3 new ones).

- [ ] **Step 6: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests pass, including `specialists`-adjacent and `engine.test.ts` (unaffected — `engine.ts` itself is untouched).

- [ ] **Step 7: Commit**

```bash
git add src/agent/specialists.ts src/agent/orchestrator.ts src/agent/orchestrator.test.ts
git commit -m "feat: add PortfolioAnalyst specialist and portfolio routing"
```

---

### Task 12: Wire portfolio mode + thread persistence into `/api/chat`

**Files:**
- Modify: `src/lib/sse.ts`
- Modify: `src/app/api/chat/route.ts`
- Modify: `src/app/api/chat/route.test.ts`

**Interfaces:**
- Consumes: `getUser` (Task 2), `createClient` from `@/lib/supabase/server` (Task 2), `persistAnalysis` (Task 6), `buildPortfolioRunTool` (Task 11), `route`/`buildInitialMessage` (Task 11, updated signatures).
- Produces: `agentEventsToSSEStream(events, threadId, specialistKey, onEvent?)` — `onEvent` is a new, optional 4th parameter, called with every mapped `ChatEvent` as it's streamed. Existing call sites (none outside `route.ts`) are unaffected by the added optional parameter.

- [ ] **Step 1: Add the `onEvent` hook to `sse.ts`**

Edit `src/lib/sse.ts`, replace the `agentEventsToSSEStream` function signature and body:

```ts
export function agentEventsToSSEStream(
  events: AsyncGenerator<AgentEvent>,
  threadId: string,
  specialistKey: string,
  onEvent?: (e: ChatEvent) => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await events.next();
      if (done) {
        controller.close();
        return;
      }
      const chatEvent = toChatEvent(value, threadId, specialistKey);
      onEvent?.(chatEvent);
      controller.enqueue(encoder.encode(encodeSSE(chatEvent)));
    },
    async cancel() {
      await events.return?.(undefined);
    },
  });
}
```

(only the function signature and the `pull` body change — `toChatEvent`, `encodeSSE`, `parseSSEBlock`, `parseSSEStream` stay exactly as-is)

- [ ] **Step 2: Write the failing route tests**

Edit `src/app/api/chat/route.test.ts` — add these imports at the top, alongside the existing ones:

```ts
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/dal", () => ({ getUser: vi.fn() }));
vi.mock("@/lib/db/analyses", () => ({ persistAnalysis: vi.fn().mockResolvedValue(undefined) }));
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/supabase/dal";
import { persistAnalysis } from "@/lib/db/analyses";

const mockedCreateClient = vi.mocked(createClient);
const mockedGetUser = vi.mocked(getUser);
const mockedPersistAnalysis = vi.mocked(persistAnalysis);
```

Add to the existing `beforeEach`:

```ts
  mockedCreateClient.mockResolvedValue({} as never);
  mockedGetUser.mockResolvedValue(null);
  mockedPersistAnalysis.mockClear();
```

Add these tests inside `describe("POST /api/chat", ...)`:

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- route.test.ts`
Expected: FAIL — `route.ts` doesn't check auth for `mode:portfolio` yet, doesn't call `persistAnalysis`, and `@/lib/supabase/server`/`@/lib/supabase/dal`/`@/lib/db/analyses` mocks reference real modules that don't export what's mocked yet at the call sites (route.ts hasn't imported them).

- [ ] **Step 4: Update `route.ts`**

Replace `src/app/api/chat/route.ts`:

```ts
// src/app/api/chat/route.ts
import { chatRequestSchema, type StepPayload } from "@/lib/chat-types";
import { agentEventsToSSEStream } from "@/lib/sse";
import { route, buildInitialMessage, type AnalysisRequest } from "@/agent/orchestrator";
import { buildPortfolioRunTool } from "@/agent/specialists";
import { runAgent, type ChatMessage } from "@/agent/engine";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/supabase/dal";
import { persistAnalysis } from "@/lib/db/analyses";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 10;

// ponytail: in-memory, per-instance only — resets on redeploy/restart and
// doesn't share state across serverless instances. Fine for this plan's
// local-only demo posture (spec §10); swap for a shared store (e.g. Upstash
// Redis) before a multi-instance/public deploy.
const requestLog = new Map<string, number[]>();

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (requestLog.get(key) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
    requestLog.set(key, recent);
    return true;
  }
  recent.push(now);
  requestLog.set(key, recent);
  return false;
}

export async function POST(request: Request): Promise<Response> {
  const clientKey = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (isRateLimited(clientKey)) {
    return Response.json(
      { error: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요." },
      { status: 429 },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }
  const req = parsed.data;

  const supabase = await createClient();
  const user = await getUser(supabase);

  if (req.mode === "portfolio" && !user) {
    return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const analysisReq: AnalysisRequest = { mode: req.mode, target: req.target ?? "", option: req.option };
  const specialist = route(analysisReq, { userId: user?.id, supabase });
  if (!specialist) {
    return Response.json({ error: `no specialist for ${req.mode}:${req.option}` }, { status: 400 });
  }

  let initial: string;
  try {
    initial = buildInitialMessage(analysisReq);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "invalid target" }, { status: 400 });
  }

  const messages: ChatMessage[] = [{ role: "user", content: initial }];
  const runTool = req.mode === "portfolio" ? buildPortfolioRunTool(specialist) : undefined;
  const events = runAgent(specialist, messages, runTool ? { runTool } : undefined);

  const steps: StepPayload[] = [];
  let answer = "";
  const stream = agentEventsToSSEStream(events, req.threadId, specialist.key, (e) => {
    if (e.event === "step") steps.push(e.data);
    else if (e.event === "token") answer += e.data.text;
    else if (e.event === "done" && user) {
      // Fire-and-forget: a failed save must not turn a successful analysis
      // into a visible error, and must not delay the client's `done` event.
      persistAnalysis(supabase, {
        userId: user.id,
        threadId: req.threadId,
        mode: req.mode,
        target: req.target ?? "",
        option: req.option ?? "",
        steps,
        answer,
      }).catch((err) => {
        console.error("[analyses] persist failed:", err);
      });
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// Vercel Hobby limit (spec §10); the ReAct loop is capped at 6 iterations so it stays well under this.
export const maxDuration = 60;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- route.test.ts`
Expected: PASS — all pre-existing cases plus the 4 new ones.

- [ ] **Step 6: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/sse.ts src/app/api/chat/route.ts src/app/api/chat/route.test.ts
git commit -m "feat: wire portfolio mode and thread persistence into /api/chat"
```

---

### Task 13: `/api/watchlist` route + ★ button

**Files:**
- Create: `src/app/api/watchlist/route.ts`
- Test: `src/app/api/watchlist/route.test.ts`
- Modify: `src/components/ChatThread.tsx`

**Interfaces:**
- Consumes: `getUser`, `createClient` (Task 2), `addToWatchlist`/`removeFromWatchlist` (Task 5), `findByTicker` (existing, `@/lib/listings`).
- Produces: `POST /api/watchlist {ticker, name}` → 200/401/400; `DELETE /api/watchlist?ticker=...` → 200/401/400. ★ button visible on company-mode threads.

- [ ] **Step 1: Write the failing route test**

Create `src/app/api/watchlist/route.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- api/watchlist/route.test.ts`
Expected: FAIL — `./route` module not found.

- [ ] **Step 3: Implement the route**

Create `src/app/api/watchlist/route.ts`:

```ts
// src/app/api/watchlist/route.ts
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/supabase/dal";
import { addToWatchlist, removeFromWatchlist } from "@/lib/db/watchlist";

const addSchema = z.object({
  ticker: z.string().regex(/^\d{6}$/),
  name: z.string().min(1),
});

export async function POST(request: Request): Promise<Response> {
  const supabase = await createClient();
  const user = await getUser(supabase);
  if (!user) {
    return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = addSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }

  await addToWatchlist(supabase, user.id, parsed.data.ticker, parsed.data.name);
  return Response.json({ ok: true });
}

export async function DELETE(request: Request): Promise<Response> {
  const supabase = await createClient();
  const user = await getUser(supabase);
  if (!user) {
    return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const ticker = new URL(request.url).searchParams.get("ticker");
  if (!ticker || !/^\d{6}$/.test(ticker)) {
    return Response.json({ error: "invalid ticker" }, { status: 400 });
  }

  await removeFromWatchlist(supabase, user.id, ticker);
  return Response.json({ ok: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- api/watchlist/route.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Add the ★ button to `ChatThread.tsx`**

Edit `src/components/ChatThread.tsx` — add imports at the top:

```tsx
import { useRouter } from "next/navigation";
import { findByTicker } from "@/lib/listings";
```

Inside the `ChatThread` component, add state and a handler (after the existing `const runId = useRef(0);` line):

```tsx
  const router = useRouter();
  const [starred, setStarred] = useState(false);
  const [starError, setStarError] = useState(false);

  async function toggleStar() {
    if (initial.mode !== "company" || !initial.target) return;
    const nextStarred = !starred;
    setStarred(nextStarred);
    setStarError(false);
    try {
      const res = nextStarred
        ? await fetch("/api/watchlist", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ticker: initial.target, name: findByTicker(initial.target)?.name ?? initial.target }),
          })
        : await fetch(`/api/watchlist?ticker=${initial.target}`, { method: "DELETE" });

      if (res.status === 401) {
        setStarred(false);
        router.push("/?auth=required");
        return;
      }
      if (!res.ok) {
        setStarred(!nextStarred);
        setStarError(true);
      }
    } catch {
      setStarred(!nextStarred);
      setStarError(true);
    }
  }
```

Replace the `<header>` block to add the star button (company-mode only):

```tsx
      <header className="flex items-center justify-between text-sm text-zinc-500">
        <span>{initial.mode === "company" ? `종목코드 ${initial.target}` : initial.target}</span>
        {initial.mode === "company" && (
          <button type="button" onClick={toggleStar} aria-label="watchlist" className="text-lg">
            {starred ? "★" : "☆"}
          </button>
        )}
      </header>
      {starError && <p className="text-xs text-red-600">관심종목 저장에 실패했습니다.</p>}
```

- [ ] **Step 6: Manual smoke check**

Run: `npm run dev`, log in, start a company analysis, click ★ — confirm it fills in; click again — confirm it empties. Log out, start a company analysis, click ★ — confirm it redirects to `/?auth=required`.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/watchlist/ src/components/ChatThread.tsx
git commit -m "feat: add watchlist API and star button on company threads"
```

---

### Task 14: `/api/holdings` route

**Files:**
- Create: `src/app/api/holdings/route.ts`
- Test: `src/app/api/holdings/route.test.ts`

**Interfaces:**
- Consumes: `getUser`, `createClient` (Task 2), `addHolding`/`updateHolding`/`deleteHolding` (Task 5).
- Produces: `POST /api/holdings {ticker, name, quantity, buyPrice}`, `PATCH /api/holdings {id, quantity, buyPrice}`, `DELETE /api/holdings?id=...` — all 401 for guests, 400 on invalid input.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/holdings/route.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- api/holdings/route.test.ts`
Expected: FAIL — `./route` module not found.

- [ ] **Step 3: Implement the route**

Create `src/app/api/holdings/route.ts`:

```ts
// src/app/api/holdings/route.ts
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/supabase/dal";
import { addHolding, deleteHolding, updateHolding } from "@/lib/db/holdings";

const addSchema = z.object({
  ticker: z.string().regex(/^\d{6}$/),
  name: z.string().min(1),
  quantity: z.number().positive(),
  buyPrice: z.number().positive(),
});
const updateSchema = z.object({
  id: z.string().min(1),
  quantity: z.number().positive(),
  buyPrice: z.number().positive(),
});

export async function POST(request: Request): Promise<Response> {
  const supabase = await createClient();
  const user = await getUser(supabase);
  if (!user) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = addSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "invalid request" }, { status: 400 });

  await addHolding(supabase, user.id, parsed.data);
  return Response.json({ ok: true });
}

export async function PATCH(request: Request): Promise<Response> {
  const supabase = await createClient();
  const user = await getUser(supabase);
  if (!user) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "invalid request" }, { status: 400 });

  await updateHolding(supabase, user.id, parsed.data.id, { quantity: parsed.data.quantity, buyPrice: parsed.data.buyPrice });
  return Response.json({ ok: true });
}

export async function DELETE(request: Request): Promise<Response> {
  const supabase = await createClient();
  const user = await getUser(supabase);
  if (!user) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "invalid id" }, { status: 400 });

  await deleteHolding(supabase, user.id, id);
  return Response.json({ ok: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- api/holdings/route.test.ts`
Expected: PASS (7/7).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/holdings/
git commit -m "feat: add holdings CRUD API"
```

---

### Task 15: Sidebar

**Files:**
- Create: `src/components/Sidebar.tsx`
- Modify: `src/app/layout.tsx`

**Interfaces:**
- Consumes: `getUser`, `createClient` (Task 2), `listWatchlist` (Task 5), `listHoldings` (Task 5), `listRecentAnalyses` (Task 6), `calculateHoldingPL` (Task 7), `getStockData` (existing).

- [ ] **Step 1: Implement the Sidebar**

Create `src/components/Sidebar.tsx`:

```tsx
// src/components/Sidebar.tsx
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/supabase/dal";
import { listWatchlist } from "@/lib/db/watchlist";
import { listHoldings } from "@/lib/db/holdings";
import { listRecentAnalyses } from "@/lib/db/analyses";
import { calculateHoldingPL } from "@/lib/portfolio-calc";
import { getStockData } from "@/tools/stock";

export async function Sidebar() {
  const supabase = await createClient();
  const user = await getUser(supabase);

  if (!user) {
    return (
      <aside className="hidden w-64 shrink-0 flex-col gap-6 border-r p-4 text-sm text-zinc-500 md:flex">
        <p>Google로 로그인하면 관심종목이 저장됩니다.</p>
        <p>Google로 로그인하면 보유종목 손익이 저장됩니다.</p>
        <p>Google로 로그인하면 분석 기록이 저장됩니다.</p>
      </aside>
    );
  }

  const [watchlist, holdings, recent] = await Promise.all([
    listWatchlist(supabase, user.id),
    listHoldings(supabase, user.id),
    listRecentAnalyses(supabase, user.id, 5),
  ]);

  const pricedHoldings = await Promise.all(
    holdings.map(async (h) => {
      const priceResult = await getStockData.run({ ticker: h.ticker });
      const currentPrice = priceResult.ok ? (priceResult.data as { price: { close: number } }).price.close : null;
      return calculateHoldingPL({ ticker: h.ticker, name: h.name, quantity: h.quantity, buyPrice: h.buyPrice, currentPrice });
    }),
  );
  const totalPL = pricedHoldings.reduce((sum, pl) => sum + (pl.valueKrw ?? 0), 0);

  return (
    <aside className="hidden w-64 shrink-0 flex-col gap-6 border-r p-4 text-sm md:flex">
      <div>
        <h2 className="mb-2 font-medium text-zinc-500">관심종목</h2>
        {watchlist.length === 0 ? (
          <p className="text-xs text-zinc-400">아직 없습니다.</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {watchlist.map((w) => (
              <Link
                key={w.ticker}
                href={`/t/${crypto.randomUUID()}?mode=company&target=${w.ticker}&option=A`}
                className="rounded-full border px-2 py-1 text-xs"
              >
                ★ {w.name}
              </Link>
            ))}
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-2 font-medium text-zinc-500">내 포트폴리오</h2>
        {holdings.length === 0 ? (
          <p className="text-xs text-zinc-400">보유 종목이 없습니다.</p>
        ) : (
          <p className={totalPL >= 0 ? "text-red-600" : "text-blue-600"}>
            평가손익 {totalPL >= 0 ? "+" : ""}
            {totalPL.toLocaleString()}원
          </p>
        )}
        <Link href="/portfolio" className="text-xs text-zinc-500 underline">
          포트폴리오 관리 →
        </Link>
      </div>

      <div>
        <h2 className="mb-2 font-medium text-zinc-500">최근 분석</h2>
        {recent.length === 0 ? (
          <p className="text-xs text-zinc-400">아직 없습니다.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {recent.map((a) => (
              <li key={a.id}>
                <Link href={`/t/${a.threadId}?mode=${a.mode}&target=${a.target}&option=${a.option}`} className="text-xs underline">
                  {a.target} ({a.createdAt.slice(0, 10)})
                </Link>
              </li>
            ))}
          </ul>
        )}
        <Link href="/history" className="text-xs text-zinc-500 underline">
          전체 기록 →
        </Link>
      </div>
    </aside>
  );
}
```

Note: red/blue for gain/loss follows Korean market convention (red = up/gain, blue = down/loss) — opposite of US convention, deliberate.

No dedicated test — this Server Component is a thin composition of already-tested data-layer functions (Tasks 5–7) with no independent branching logic beyond total P&L summation, which is a one-line `reduce`. Covered by live Playwright verification at the end of the plan (same accepted DOM-gap precedent as Plan 2).

- [ ] **Step 2: Wire it into the layout**

Edit `src/app/layout.tsx` — add the import:

```tsx
import { Sidebar } from "@/components/Sidebar";
```

Replace the body:

```tsx
      <body className="min-h-full flex flex-col">
        <header className="flex items-center justify-end border-b px-6 py-3">
          <AuthButton />
        </header>
        <div className="flex flex-1">
          <Sidebar />
          <div className="flex flex-1 flex-col">{children}</div>
        </div>
      </body>
```

- [ ] **Step 3: Manual smoke check**

Run: `npm run dev`. As a guest, confirm the sidebar shows the three login hints. Log in, add a watchlist item and a holding (once Tasks 16 exists — revisit this check after Task 16), confirm they appear.

- [ ] **Step 4: Commit**

```bash
git add src/components/Sidebar.tsx src/app/layout.tsx
git commit -m "feat: add sidebar with watchlist, portfolio summary, and recent analyses"
```

---

### Task 16: `/portfolio` page

**Files:**
- Create: `src/app/portfolio/page.tsx`
- Create: `src/components/HoldingsTable.tsx`

**Interfaces:**
- Consumes: `getUser`, `createClient` (Task 2), `listHoldings` (Task 5), `calculateHoldingPL` (Task 7), `getStockData` (existing), `searchCompaniesRemote` (existing, `@/lib/listings-client`).

- [ ] **Step 1: Implement the holdings table (client component)**

Create `src/components/HoldingsTable.tsx`:

```tsx
// src/components/HoldingsTable.tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Listing } from "@/lib/listings";
import { searchCompaniesRemote } from "@/lib/listings-client";

export type HoldingRow = {
  id: string;
  ticker: string;
  name: string;
  quantity: number;
  buyPrice: number;
  currentPrice: number | null;
  valueKrw: number | null;
  ratePct: number | null;
};

const SEARCH_DEBOUNCE_MS = 200;

export function HoldingsTable({ initialHoldings }: { initialHoldings: HoldingRow[] }) {
  const router = useRouter();
  const [holdings, setHoldings] = useState(initialHoldings);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Listing[]>([]);
  const [selected, setSelected] = useState<Listing | null>(null);
  const [quantity, setQuantity] = useState("");
  const [buyPrice, setBuyPrice] = useState("");
  const [formError, setFormError] = useState("");

  useEffect(() => {
    if (!query.trim() || selected) {
      setSuggestions([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchCompaniesRemote(query, controller.signal)
        .then((data) => setSuggestions(data))
        .catch(() => {});
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, selected]);

  async function addRow() {
    setFormError("");
    const qty = Number(quantity);
    const price = Number(buyPrice);
    if (!selected || !(qty > 0) || !(price > 0)) {
      setFormError("종목, 수량, 평단가를 올바르게 입력하세요.");
      return;
    }
    const res = await fetch("/api/holdings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker: selected.ticker, name: selected.name, quantity: qty, buyPrice: price }),
    });
    if (!res.ok) {
      setFormError("추가에 실패했습니다.");
      return;
    }
    setHoldings((prev) => [
      ...prev,
      { id: crypto.randomUUID(), ticker: selected.ticker, name: selected.name, quantity: qty, buyPrice: price, currentPrice: null, valueKrw: null, ratePct: null },
    ]);
    setSelected(null);
    setQuery("");
    setQuantity("");
    setBuyPrice("");
    router.refresh();
  }

  async function deleteRow(id: string) {
    const res = await fetch(`/api/holdings?id=${id}`, { method: "DELETE" });
    if (res.ok) setHoldings((prev) => prev.filter((h) => h.id !== id));
  }

  return (
    <div className="flex flex-col gap-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-zinc-500">
            <th className="py-2">종목</th>
            <th>수량</th>
            <th>평단가</th>
            <th>현재가</th>
            <th>평가손익</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {holdings.map((h) => (
            <tr key={h.id} className="border-b">
              <td className="py-2">{h.name}</td>
              <td>{h.quantity.toLocaleString()}</td>
              <td>{h.buyPrice.toLocaleString()}</td>
              <td>{h.currentPrice?.toLocaleString() ?? "-"}</td>
              <td className={h.valueKrw !== null && h.valueKrw >= 0 ? "text-red-600" : "text-blue-600"}>
                {h.valueKrw !== null ? `${h.valueKrw >= 0 ? "+" : ""}${h.valueKrw.toLocaleString()}원 (${h.ratePct?.toFixed(1)}%)` : "-"}
              </td>
              <td>
                <button type="button" onClick={() => deleteRow(h.id)} className="text-xs text-zinc-400 hover:text-red-600">
                  삭제
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex flex-wrap items-end gap-2 rounded-lg border p-4">
        <div className="relative">
          <input
            value={selected ? `${selected.name} (${selected.ticker})` : query}
            onChange={(e) => {
              setSelected(null);
              setQuery(e.target.value);
            }}
            placeholder="종목 검색"
            className="rounded-lg border px-3 py-2 text-sm"
          />
          {suggestions.length > 0 && (
            <ul className="absolute z-10 mt-1 w-56 rounded-lg border bg-white shadow-lg dark:bg-black">
              {suggestions.map((c) => (
                <li key={c.ticker}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(c);
                      setQuery("");
                      setSuggestions([]);
                    }}
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900"
                  >
                    {c.name} ({c.ticker})
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <input
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          placeholder="수량"
          type="number"
          className="w-24 rounded-lg border px-3 py-2 text-sm"
        />
        <input
          value={buyPrice}
          onChange={(e) => setBuyPrice(e.target.value)}
          placeholder="평단가"
          type="number"
          className="w-28 rounded-lg border px-3 py-2 text-sm"
        />
        <button type="button" onClick={addRow} className="rounded-lg bg-black px-4 py-2 text-sm text-white dark:bg-white dark:text-black">
          추가
        </button>
      </div>
      {formError && <p className="text-xs text-red-600">{formError}</p>}
    </div>
  );
}
```

No dedicated test for this client component (DOM-interaction wiring — same accepted gap as `LandingForm.tsx` in Plan 2; its non-trivial logic, `calculateHoldingPL`, is already unit-tested in Task 7).

- [ ] **Step 2: Implement the page (Server Component)**

Create `src/app/portfolio/page.tsx`:

```tsx
// src/app/portfolio/page.tsx
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/supabase/dal";
import { listHoldings } from "@/lib/db/holdings";
import { calculateHoldingPL } from "@/lib/portfolio-calc";
import { getStockData } from "@/tools/stock";
import { HoldingsTable, type HoldingRow } from "@/components/HoldingsTable";

export default async function PortfolioPage() {
  const supabase = await createClient();
  const user = await getUser(supabase);

  // Defense in depth: proxy.ts already redirects guests before this ever
  // renders, but a Server Component must not assume request-time state.
  if (!user) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-sm text-zinc-500">로그인이 필요합니다.</p>
      </main>
    );
  }

  const holdings = await listHoldings(supabase, user.id);
  const rows: HoldingRow[] = await Promise.all(
    holdings.map(async (h) => {
      const priceResult = await getStockData.run({ ticker: h.ticker });
      const currentPrice = priceResult.ok ? (priceResult.data as { price: { close: number } }).price.close : null;
      const pl = calculateHoldingPL({ ticker: h.ticker, name: h.name, quantity: h.quantity, buyPrice: h.buyPrice, currentPrice });
      return { id: h.id, ticker: h.ticker, name: h.name, quantity: h.quantity, buyPrice: h.buyPrice, currentPrice, valueKrw: pl.valueKrw, ratePct: pl.ratePct };
    }),
  );

  const threadId = crypto.randomUUID();

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">내 포트폴리오</h1>
        <Link href={`/t/${threadId}?mode=portfolio`} className="rounded-full bg-black px-4 py-2 text-sm text-white dark:bg-white dark:text-black">
          AI 분석
        </Link>
      </div>
      <HoldingsTable initialHoldings={rows} />
    </main>
  );
}
```

- [ ] **Step 3: Manual smoke check**

Run: `npm run dev`, log in, visit `/portfolio`, add a holding, confirm it shows current price and P&L, confirm "AI 분석" starts a `PortfolioAnalyst` thread. As a guest, visit `/portfolio` directly — confirm `proxy.ts` (Task 3) redirects to `/?auth=required` before this page ever renders.

- [ ] **Step 4: Commit**

```bash
git add src/app/portfolio/ src/components/HoldingsTable.tsx
git commit -m "feat: add /portfolio page with holdings CRUD and AI analysis"
```

---

### Task 17: Portfolio-mode support + thread replay in `ChatThread`

**Files:**
- Modify: `src/components/ChatThread.tsx`
- Modify: `src/app/t/[threadId]/page.tsx`

**Interfaces:**
- Consumes: `getAnalysisByThreadId` (Task 6), `getUser`/`createClient` (Task 2).
- Produces: `ChatThread`'s `Initial.mode` gains `"portfolio"`, `target`/`option` become optional; `ChatThread` gains an optional `initialData?: {steps: StepPayload[]; answer: string}` prop that skips streaming entirely.

- [ ] **Step 1: Update `ChatThread.tsx`'s types and guard**

Edit `src/components/ChatThread.tsx` — replace the `Initial` type:

```tsx
type Initial = { mode: "company" | "date" | "portfolio"; target?: string; option?: "A" | "B" | "C" | "D" };
```

Update the component signature to accept `initialData`:

```tsx
export function ChatThread({
  threadId,
  initial,
  initialData,
}: {
  threadId: string;
  initial: Initial;
  initialData?: { steps: StepPayload[]; answer: string };
}) {
  const [status, setStatus] = useState<Status>(initialData ? "done" : "loading");
  const [steps, setSteps] = useState<StepPayload[]>(initialData?.steps ?? []);
  const [answer, setAnswer] = useState(initialData?.answer ?? "");
```

(only the initial values of `status`/`steps`/`answer` change — the rest of the state declarations stay as-is)

Replace the `useEffect` that kicks off `run()`:

```tsx
  useEffect(() => {
    if (initialData) return; // replay mode: nothing to stream, already rendered
    if (initial.mode !== "portfolio" && !initial.target) {
      setStatus("error");
      setErrorMessage("잘못된 요청입니다. 처음부터 다시 시도해주세요.");
      setRetryable(false);
      return;
    }
    // initial is derived once from the URL's search params; threadId alone identifies a distinct run.
    return run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);
```

Update `streamChat`'s call site inside `run()` — `{ ...initial, threadId }` already spreads `target`/`option` as-is; when they're `undefined` (portfolio mode), `JSON.stringify` in `chat-client.ts` drops those keys automatically, matching the now-optional `chatRequestSchema` fields from Task 8. No change needed to `run()`'s body itself.

Update the header (already showing `initial.target` for company/date) to handle portfolio mode:

```tsx
      <header className="flex items-center justify-between text-sm text-zinc-500">
        <span>
          {initial.mode === "company" && `종목코드 ${initial.target}`}
          {initial.mode === "date" && initial.target}
          {initial.mode === "portfolio" && "내 포트폴리오 분석"}
        </span>
        {initial.mode === "company" && (
          <button type="button" onClick={toggleStar} aria-label="watchlist" className="text-lg">
            {starred ? "★" : "☆"}
          </button>
        )}
      </header>
      {starError && <p className="text-xs text-red-600">관심종목 저장에 실패했습니다.</p>}
```

- [ ] **Step 2: Update `ThreadPage`**

Replace `src/app/t/[threadId]/page.tsx`:

```tsx
// src/app/t/[threadId]/page.tsx
import { ChatThread } from "@/components/ChatThread";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/supabase/dal";
import { getAnalysisByThreadId } from "@/lib/db/analyses";

export default async function ThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{ threadId: string }>;
  searchParams: Promise<{ mode?: string; target?: string; option?: string }>;
}) {
  const { threadId } = await params;
  const sp = await searchParams;
  const mode = sp.mode === "date" ? "date" : sp.mode === "portfolio" ? "portfolio" : "company";
  const option = (["A", "B", "C", "D"].includes(sp.option ?? "") ? sp.option : "A") as "A" | "B" | "C" | "D";
  const target = sp.target ?? "";

  const supabase = await createClient();
  const user = await getUser(supabase);
  const saved = user ? await getAnalysisByThreadId(supabase, user.id, threadId) : null;

  return (
    <main className="flex flex-1 flex-col">
      <ChatThread
        threadId={threadId}
        initial={{ mode, target: mode === "portfolio" ? undefined : target, option: mode === "portfolio" ? undefined : option }}
        initialData={saved ? { steps: saved.steps, answer: saved.answer } : undefined}
      />
    </main>
  );
}
```

No dedicated test — this Server Component composes already-tested pieces (`getAnalysisByThreadId` from Task 6, `ChatThread`'s own rendering) with one conditional (`saved ? ... : undefined`), covered by manual/live verification below.

- [ ] **Step 3: Manual smoke check**

Run: `npm run dev`. As a guest, run a company analysis — confirm it streams exactly as before Plan 3 (unaffected). Log in, run a company analysis to completion, then navigate to `/history` (once Task 18 exists) or copy the thread URL and revisit it — confirm it renders the saved answer instantly with no streaming/loading state. From `/portfolio`, click "AI 분석" — confirm a `PortfolioAnalyst` thread starts and streams normally.

- [ ] **Step 4: Commit**

```bash
git add src/components/ChatThread.tsx "src/app/t/[threadId]/page.tsx"
git commit -m "feat: support portfolio mode and thread replay in ChatThread"
```

---

### Task 18: `/history` page

**Files:**
- Create: `src/app/history/page.tsx`

**Interfaces:**
- Consumes: `getUser`, `createClient` (Task 2), `listRecentAnalyses` (Task 6).

- [ ] **Step 1: Implement the page**

Create `src/app/history/page.tsx`:

```tsx
// src/app/history/page.tsx
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/supabase/dal";
import { listRecentAnalyses } from "@/lib/db/analyses";

const MODE_LABELS: Record<string, string> = { company: "기업", date: "날짜", portfolio: "포트폴리오" };

export default async function HistoryPage() {
  const supabase = await createClient();
  const user = await getUser(supabase);

  // Defense in depth: proxy.ts already redirects guests before this ever renders.
  if (!user) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-sm text-zinc-500">로그인이 필요합니다.</p>
      </main>
    );
  }

  // Full history, no pagination — YAGNI at this app's demo scale (spec §6).
  const analyses = await listRecentAnalyses(supabase, user.id, 1000);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-6">
      <h1 className="text-xl font-bold">분석 기록</h1>
      {analyses.length === 0 ? (
        <p className="text-sm text-zinc-500">아직 분석 기록이 없습니다.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {analyses.map((a) => (
            <li key={a.id} className="py-3">
              <Link href={`/t/${a.threadId}?mode=${a.mode}&target=${a.target}&option=${a.option}`} className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">
                  [{MODE_LABELS[a.mode] ?? a.mode}] {a.target || "포트폴리오"}
                </span>
                <span className="text-xs text-zinc-500">{a.createdAt.slice(0, 10)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
```

No dedicated test — thin composition of `listRecentAnalyses` (already unit-tested in Task 6) with no independent logic. Covered by live verification below.

- [ ] **Step 2: Manual smoke check**

Run: `npm run dev`, log in, run a couple of analyses, visit `/history`, confirm they're all listed and clicking one replays it (via Task 17's replay mode). As a guest, visit `/history` directly — confirm `proxy.ts` redirects to `/?auth=required`.

- [ ] **Step 3: Commit**

```bash
git add src/app/history/
git commit -m "feat: add /history page"
```

---

### Task 19: Full-suite regression pass + live verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full automated suite**

Run: `npm test`
Expected: all tests pass (Plan 1, Plan 2, and every Plan 3 task's tests).

- [ ] **Step 2: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: no type errors, build succeeds.

- [ ] **Step 3: Live Playwright verification**

With the real Supabase project + Google OAuth from Task 1 configured and `npm run dev` running, walk through: guest sees login hints in the sidebar → login via Google → add a company to the watchlist from a thread page → add a holding on `/portfolio` → run "AI 분석" and confirm a `PortfolioAnalyst` report streams → visit `/history` and confirm the run is listed → click it and confirm it replays instantly (no re-streaming) → logout → confirm `/portfolio` and `/history` redirect guests to `/?auth=required` → confirm a guest can still run a normal company/date analysis exactly as before this plan.

- [ ] **Step 4: Report**

No commit for this task — it's verification only. If any step fails, fix it in a follow-up commit against the specific task it belongs to (not a catch-all "fix everything" commit).

---
