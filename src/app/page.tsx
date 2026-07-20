// src/app/page.tsx
import { LandingForm } from "@/components/LandingForm";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-10 px-6 py-20">
      <div className="flex flex-col items-center gap-3 text-center">
        <h1 className="text-3xl font-bold tracking-tight">INVESTOR-LLM</h1>
        <p className="text-sm text-zinc-500">기업 또는 날짜를 입력하고 분석 옵션을 선택하세요.</p>
      </div>
      <LandingForm />
    </main>
  );
}
