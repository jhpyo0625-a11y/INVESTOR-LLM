// src/components/ChatThread.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { streamChat } from "@/lib/chat-client";
import type { ChatEvent, StepPayload } from "@/lib/chat-types";
import { findByTicker } from "@/lib/listings";
import { ReactTimeline } from "./ReactTimeline";
import { StreamedAnswer } from "./StreamedAnswer";

type Status = "loading" | "streaming" | "done" | "error";
type Initial = { mode: "company" | "date" | "portfolio"; target?: string; option?: "A" | "B" | "C" | "D" };

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
  const [errorMessage, setErrorMessage] = useState("");
  const [retryable, setRetryable] = useState(true);
  const runId = useRef(0);
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

  function run() {
    const id = ++runId.current;
    setStatus("streaming");
    setSteps([]);
    setAnswer("");
    setErrorMessage("");
    const controller = new AbortController();

    streamChat(
      { ...initial, threadId },
      (event: ChatEvent) => {
        if (id !== runId.current) return;
        if (event.event === "step") setSteps((prev) => [...prev, event.data]);
        else if (event.event === "token") setAnswer((prev) => prev + event.data.text);
        else if (event.event === "done") setStatus("done");
        else if (event.event === "error") {
          setStatus("error");
          setErrorMessage(event.data.message);
          setRetryable(event.data.retryable);
        }
      },
      controller.signal,
    ).catch((e) => {
      // Defensive backstop: streamChat catches its own failures and always
      // resolves via onEvent, so this should be unreachable today — kept in
      // case that contract ever regresses.
      if (id !== runId.current) return;
      setStatus("error");
      setErrorMessage(e instanceof Error ? e.message : "스트리밍 중 오류가 발생했습니다.");
      setRetryable(true);
    });

    return () => controller.abort();
  }

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

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-6">
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

      {status === "loading" && <p className="animate-pulse text-sm text-zinc-500">분석 준비 중…</p>}

      <ReactTimeline steps={steps} collapsed={status === "done" || answer.length > 0} />

      {answer && <StreamedAnswer text={answer} />}

      {status === "error" && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          <p>{errorMessage}</p>
          {retryable && (
            <button onClick={run} className="mt-2 rounded-full bg-red-600 px-4 py-1 text-xs font-medium text-white">
              재시도
            </button>
          )}
        </div>
      )}
    </div>
  );
}
