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
