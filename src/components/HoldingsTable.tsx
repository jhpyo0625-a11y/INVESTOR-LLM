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
