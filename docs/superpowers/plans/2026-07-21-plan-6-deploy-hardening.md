# Plan 6 — Deployment & Error Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Task 2 is manual and must be executed by the human, not dispatched to a subagent** — it requires a Vercel account and dashboard access. Pause and hand it to the user after Task 1.

**Goal:** Fix the one real gap in the app's error handling (a root-layout crash falls through to Next's default error screen), fix the wrong `<html lang>`, and get the app live on Vercel.

**Architecture:** `src/app/error.tsx` (existing) doesn't cover crashes in `layout.tsx` itself — Next's file-convention docs are explicit that `error.js` doesn't wrap the `layout.js` above it in the same segment. `layout.tsx` renders `<Sidebar />`, an async server component that can throw on a Supabase read failure. The fix is `global-error.tsx`, the file convention specifically for root-layout crashes — it fully replaces the root layout when active, so it defines its own `<html>`/`<body>` and imports `./globals.css` itself. Deployment has almost no code work left (env vars, gitignore, `maxDuration` already done in prior plans) — it's a human-executed Vercel dashboard checklist, verified live at the end.

**Tech Stack:** No new dependencies. Same Next.js 16 / Tailwind stack as Plans 1–5.

## Global Constraints

- `global-error.tsx` uses the `{ error, unstable_retry }` prop shape (not the stable-Next `reset`) — confirmed against this project's vendored Next docs at `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md`, matching what `src/app/error.tsx` already uses.
- No automated test for `global-error.tsx` — same accepted gap as the existing `error.tsx`/`not-found.tsx` (neither has a test file; this project has never adopted jsdom/@testing-library, per Plans 1–5's Global Constraints). Verified live instead.
- Scope is narrow by design: `global-error.tsx` + the `lang` fix only. `AuthButton.tsx`'s missing `.catch()` and any other server-component error handling are explicitly out of scope for this plan (see design spec §4).
- Full design rationale: `docs/superpowers/specs/2026-07-21-plan-6-deploy-hardening-design.md`.

---

### Task 1: `global-error.tsx` + `<html lang>` fix

**Files:**
- Modify: `src/app/layout.tsx`
- Create: `src/app/global-error.tsx`

**Interfaces:** none (file-convention components, no exports consumed elsewhere).

- [ ] **Step 1: Fix the root layout's `lang` attribute**

Edit `src/app/layout.tsx`, change:

```tsx
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
```

to:

```tsx
    <html
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
```

- [ ] **Step 2: Create `global-error.tsx`**

Create `src/app/global-error.tsx`:

```tsx
// src/app/global-error.tsx
"use client";

import "./globals.css";

export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <html lang="ko" className="h-full">
      <body className="flex min-h-full flex-col">
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          <h2 className="text-xl font-semibold">문제가 발생했습니다</h2>
          <p className="text-sm text-zinc-500">{error.message || "알 수 없는 오류가 발생했습니다."}</p>
          <div className="flex gap-3">
            <button
              onClick={() => unstable_retry()}
              className="rounded-full bg-black px-5 py-2 text-sm font-medium text-white dark:bg-white dark:text-black"
            >
              다시 시도
            </button>
            <a href="/" className="rounded-full border px-5 py-2 text-sm font-medium">
              홈으로
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
```

(This mirrors `src/app/error.tsx`'s existing copy and button styling exactly, so a
user can't tell which boundary caught the crash from the UI alone. It doesn't load
`geistSans`/`geistMono` — this is the rarely-hit full-app crash fallback, a plain
system font is a deliberate simplification, not an oversight.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the full suite to check for regressions**

Run: `npm test`
Expected: all existing tests still pass (this task touches no code any existing test covers).

- [ ] **Step 5: Live-verify the crash boundary actually works**

Temporarily edit `src/components/Sidebar.tsx`, add a throw as the very first line
inside the function body:

```tsx
export async function Sidebar() {
  throw new Error("test global-error boundary");
  const supabase = await createClient();
```

Run `npm run dev`, open `http://localhost:3000/` in a browser. Confirm:
- The page shows `global-error.tsx`'s Korean "문제가 발생했습니다" UI — not Next's
  default unstyled crash screen.
- The "다시 시도" button is present and clickable (clicking it re-attempts the
  render; it'll throw again since the temporary throw is still in place — that's
  expected, you're testing that the button renders and calls `unstable_retry`, not
  that the underlying error resolves).
- View source / inspect element: `<html lang="ko">` is present (this also
  incidentally re-confirms Step 1's fix rendered, on the crash path).

Then **revert the temporary throw** — remove the `throw new Error(...)` line from
`Sidebar.tsx` so it's back to its original first line (`const supabase = await
createClient();`). Confirm `git diff src/components/Sidebar.tsx` is empty before
continuing.

- [ ] **Step 6: Confirm the normal (non-crashing) path still renders correctly**

With the throw reverted, reload `http://localhost:3000/` — confirm the app loads
normally (landing page, sidebar, no error UI).

- [ ] **Step 7: Commit**

```bash
git add src/app/layout.tsx src/app/global-error.tsx
git commit -m "fix: add global-error.tsx for root-layout crashes, fix html lang"
```

---

### Task 2: Vercel deployment (human-executed, not a subagent task)

**Files:** none (external dashboard + live verification).

- [ ] **Step 1: Create the Vercel project**

In the Vercel dashboard, create a new project and connect it to the
`jhpyo0625-a11y/INVESTOR-LLM` GitHub repository. Let Vercel auto-detect the Next.js
framework (no `vercel.json` needed — confirmed in the design spec §3.1, nothing in
`next.config.ts` requires it).

- [ ] **Step 2: Set environment variables**

In Project Settings → Environment Variables, add all 7 keys from `.env.example`,
using the **real** values from your local `.env.local` (not the placeholders):

```
NVIDIA_API_KEY
DART_API_KEY
TAVILY_API_KEY
NIM_MODEL
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
```

- [ ] **Step 3: Deploy**

Trigger a deploy (automatic on first connection, or a manual redeploy from the
dashboard if needed). Wait for it to finish and note the deployed URL.

- [ ] **Step 4: Live-verify the deployed app**

Open the deployed URL. As a guest (no login needed): run a company analysis (e.g.
search "삼성전자", pick option A) and confirm it streams a real answer end-to-end
against the production build — same shape as the parent spec's demo script step 6
("Open Vercel URL — deployed proof").

- [ ] **Step 5: Report**

No commit for this task — it's an external dashboard action plus live verification,
nothing in this repo changes. If the deploy fails or the live check fails, note
what broke; fixing it belongs to whichever task actually owns the broken piece
(e.g. a code bug goes back to Task 1 or an earlier plan, not a catch-all fix here).

---
