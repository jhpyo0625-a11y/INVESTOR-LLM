import { specialists, type SpecialistKey } from "./specialists";
import type { SpecialistConfig } from "./engine";
import { findByTicker } from "@/lib/listings";

export type AnalysisRequest = {
  mode: "company" | "date";
  target: string; // ticker (6자리) or YYYY-MM-DD
  option: "A" | "B" | "C" | "D";
};

const ROUTES: Record<string, SpecialistKey> = {
  "company:A": "company_analysis",
  "company:B": "broker_view",
  "date:A": "macro",
  "date:B": "daily_reports",
  "date:C": "disclosures",
  "date:D": "flows",
};

export function route(req: AnalysisRequest): SpecialistConfig | undefined {
  const key = ROUTES[`${req.mode}:${req.option}`];
  return key ? specialists[key] : undefined;
}

export function buildInitialMessage(req: AnalysisRequest): string {
  const today = new Date().toISOString().slice(0, 10);
  if (req.mode === "company") {
    const c = findByTicker(req.target);
    if (!c) throw new Error(`unknown ticker: ${req.target}`);
    return `분석 대상 기업: ${c.name} (종목코드 ${c.ticker}, DART corpCode ${c.corpCode}). 오늘 날짜: ${today}. 위 임무에 따라 분석하라.`;
  }
  const compact = req.target.replaceAll("-", "");
  return `기준일: ${req.target} (DART 조회용 표기: ${compact}). 오늘 날짜: ${today}. 위 임무에 따라 분석하라.`;
}
