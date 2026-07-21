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
