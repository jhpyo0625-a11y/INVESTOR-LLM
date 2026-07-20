// src/app/not-found.tsx
import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <h2 className="text-xl font-semibold">페이지를 찾을 수 없습니다</h2>
      <Link
        href="/"
        className="rounded-full bg-black px-5 py-2 text-sm font-medium text-white dark:bg-white dark:text-black"
      >
        홈으로
      </Link>
    </div>
  );
}
