// src/components/LandingForm.tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Listing } from "@/lib/listings";

const TODAY = new Date();
const MIN_DATE = new Date(TODAY);
MIN_DATE.setDate(MIN_DATE.getDate() - 30);
const toISODate = (d: Date) => d.toISOString().slice(0, 10);

const COMPANY_OPTIONS = [
  { option: "A" as const, label: "기업 분석 리포트" },
  { option: "B" as const, label: "증권사/애널리스트 시각" },
];
const DATE_OPTIONS = [
  { option: "A" as const, label: "거시경제 핵심 이슈" },
  { option: "B" as const, label: "일일 리포트 요약" },
  { option: "C" as const, label: "주요 공시 리뷰" },
  { option: "D" as const, label: "수급/섹터 동향" },
];

export function LandingForm() {
  const router = useRouter();
  const [mode, setMode] = useState<"company" | "date">("company");
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Listing[]>([]);
  const [selected, setSelected] = useState<Listing | null>(null);
  const [date, setDate] = useState("");

  useEffect(() => {
    if (mode !== "company" || !query.trim() || selected) {
      setSuggestions([]);
      return;
    }
    const controller = new AbortController();
    fetch(`/api/listings?q=${encodeURIComponent(query)}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data: Listing[]) => setSuggestions(data))
      .catch(() => {});
    return () => controller.abort();
  }, [mode, query, selected]);

  const target = mode === "company" ? selected?.ticker : date;
  const options = mode === "company" ? COMPANY_OPTIONS : DATE_OPTIONS;

  function selectOption(option: "A" | "B" | "C" | "D") {
    if (!target) return;
    const threadId = crypto.randomUUID();
    const params = new URLSearchParams({ mode, target, option });
    router.push(`/t/${threadId}?${params}`);
  }

  return (
    <div className="flex w-full max-w-xl flex-col gap-6">
      <div className="flex gap-2 rounded-full border p-1">
        <button
          type="button"
          onClick={() => {
            setMode("company");
            setSelected(null);
            setDate("");
          }}
          className={`flex-1 rounded-full py-2 text-sm font-medium ${mode === "company" ? "bg-black text-white dark:bg-white dark:text-black" : ""}`}
        >
          기업
        </button>
        <button
          type="button"
          onClick={() => {
            setMode("date");
            setSelected(null);
            setQuery("");
          }}
          className={`flex-1 rounded-full py-2 text-sm font-medium ${mode === "date" ? "bg-black text-white dark:bg-white dark:text-black" : ""}`}
        >
          날짜
        </button>
      </div>

      {mode === "company" ? (
        <div className="relative">
          <input
            value={selected ? `${selected.name} (${selected.ticker})` : query}
            onChange={(e) => {
              setSelected(null);
              setQuery(e.target.value);
            }}
            placeholder="기업명 또는 종목코드 검색"
            className="w-full rounded-lg border px-4 py-3 text-sm"
          />
          {suggestions.length > 0 && (
            <ul className="absolute z-10 mt-1 w-full rounded-lg border bg-white shadow-lg dark:bg-black">
              {suggestions.map((c) => (
                <li key={c.ticker}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(c);
                      setQuery("");
                      setSuggestions([]);
                    }}
                    className="block w-full px-4 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900"
                  >
                    {c.name} ({c.ticker})
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <input
            type="date"
            value={date}
            min={toISODate(MIN_DATE)}
            max={toISODate(TODAY)}
            onChange={(e) => setDate(e.target.value)}
            className="w-full rounded-lg border px-4 py-3 text-sm"
          />
          <p className="text-xs text-zinc-500">최근 30일 이내만 지원됩니다.</p>
        </div>
      )}

      {target && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {options.map((o) => (
            <button
              key={o.option}
              type="button"
              onClick={() => selectOption(o.option)}
              className="rounded-lg border p-4 text-left text-sm font-medium hover:border-black dark:hover:border-white"
            >
              {o.option}. {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
