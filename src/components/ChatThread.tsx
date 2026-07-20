// src/components/ChatThread.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { streamChat } from "@/lib/chat-client";
import type { ChatEvent, StepPayload } from "@/lib/chat-types";
import { ReactTimeline } from "./ReactTimeline";
import { StreamedAnswer } from "./StreamedAnswer";

type Status = "loading" | "streaming" | "done" | "error";
type Initial = { mode: "company" | "date"; target: string; option: "A" | "B" | "C" | "D" };

export function ChatThread({ threadId, initial }: { threadId: string; initial: Initial }) {
  const [status, setStatus] = useState<Status>("loading");
  const [steps, setSteps] = useState<StepPayload[]>([]);
  const [answer, setAnswer] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [retryable, setRetryable] = useState(true);
  const runId = useRef(0);

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
      if (id !== runId.current) return;
      setStatus("error");
      setErrorMessage(e instanceof Error ? e.message : "스트리밍 중 오류가 발생했습니다.");
      setRetryable(true);
    });

    return () => controller.abort();
  }

  useEffect(() => {
    if (!initial.target) {
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
      <header className="text-sm text-zinc-500">
        {initial.mode === "company" ? `종목코드 ${initial.target}` : initial.target}
      </header>

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
