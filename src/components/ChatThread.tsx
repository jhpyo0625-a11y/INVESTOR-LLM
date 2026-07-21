// src/components/ChatThread.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { streamChat } from "@/lib/chat-client";
import type { ChatEvent, ChatRequest, SpecialistKeyName, StepPayload } from "@/lib/chat-types";
import { findByTicker } from "@/lib/listings";
import { buildFollowupTurns } from "@/lib/chat-followup";
import { ReactTimeline } from "./ReactTimeline";
import { StreamedAnswer } from "./StreamedAnswer";

type TurnStatus = "loading" | "streaming" | "done" | "error";
type Initial = { mode: "company" | "date" | "portfolio"; target?: string; option?: "A" | "B" | "C" | "D" };

type TurnState = {
  question: string | null;
  steps: StepPayload[];
  answer: string;
  status: TurnStatus;
  errorMessage: string;
  retryable: boolean;
};

function newTurn(question: string | null): TurnState {
  return { question, steps: [], answer: "", status: "loading", errorMessage: "", retryable: true };
}

export function ChatThread({
  threadId,
  initial,
  initialTurns,
  initialStarred = false,
}: {
  threadId: string;
  initial: Initial;
  initialTurns?: { question: string | null; answer: string; steps: StepPayload[]; specialistKey: string }[];
  initialStarred?: boolean;
}) {
  const [turns, setTurns] = useState<TurnState[]>(() =>
    initialTurns && initialTurns.length > 0
      ? initialTurns.map((t) => ({
          question: t.question,
          steps: t.steps,
          answer: t.answer,
          status: "done" as const,
          errorMessage: "",
          retryable: true,
        }))
      : [newTurn(null)],
  );
  const [specialistKey, setSpecialistKey] = useState<string>(
    initialTurns && initialTurns.length > 0 ? initialTurns[initialTurns.length - 1].specialistKey : "",
  );
  const [followupText, setFollowupText] = useState("");
  const runIdRef = useRef(0);
  const router = useRouter();
  const [starred, setStarred] = useState(initialStarred);
  const [starError, setStarError] = useState(false);

  function updateTurn(index: number, patch: Partial<TurnState> | ((t: TurnState) => TurnState)) {
    setTurns((prev) => {
      const next = [...prev];
      next[index] = typeof patch === "function" ? patch(next[index]) : { ...next[index], ...patch };
      return next;
    });
  }

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

  function runTurn(index: number, question: string | null, priorTurns: TurnState[]): () => void {
    const id = ++runIdRef.current;
    updateTurn(index, { status: "streaming", steps: [], answer: "", errorMessage: "" });
    const controller = new AbortController();

    const payload: ChatRequest = question
      ? {
          mode: initial.mode,
          target: initial.target,
          option: initial.option,
          threadId,
          followup: {
            text: question,
            currentSpecialistKey: specialistKey as SpecialistKeyName,
            turns: buildFollowupTurns(priorTurns),
          },
        }
      : { mode: initial.mode, target: initial.target, option: initial.option, threadId };

    streamChat(
      payload,
      (event: ChatEvent) => {
        if (id !== runIdRef.current) return;
        if (event.event === "step") updateTurn(index, (t) => ({ ...t, steps: [...t.steps, event.data] }));
        else if (event.event === "token") updateTurn(index, (t) => ({ ...t, answer: t.answer + event.data.text }));
        else if (event.event === "done") {
          setSpecialistKey(event.data.specialistKey);
          updateTurn(index, { status: "done" });
        } else if (event.event === "error") {
          updateTurn(index, { status: "error", errorMessage: event.data.message, retryable: event.data.retryable });
        }
      },
      controller.signal,
    ).catch((e) => {
      // Defensive backstop: streamChat catches its own failures and always
      // resolves via onEvent, so this should be unreachable today — kept in
      // case that contract ever regresses.
      if (id !== runIdRef.current) return;
      updateTurn(index, {
        status: "error",
        errorMessage: e instanceof Error ? e.message : "스트리밍 중 오류가 발생했습니다.",
        retryable: true,
      });
    });

    return () => controller.abort();
  }

  function submitFollowup() {
    const text = followupText.trim();
    if (!text) return;
    const priorTurns = turns;
    setFollowupText("");
    setTurns((prev) => [...prev, newTurn(text)]);
    runTurn(priorTurns.length, text, priorTurns);
  }

  useEffect(() => {
    if (initialTurns && initialTurns.length > 0) return; // replay mode: nothing to stream, already rendered
    if (initial.mode !== "portfolio" && !initial.target) {
      updateTurn(0, { status: "error", errorMessage: "잘못된 요청입니다. 처음부터 다시 시도해주세요.", retryable: false });
      return;
    }
    // initial is derived once from the URL's search params; threadId alone identifies a distinct run.
    return runTurn(0, null, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  const lastTurn = turns[turns.length - 1];

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6">
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

      {turns.map((t, i) => (
        <div key={i} className="flex flex-col gap-4">
          {t.question && (
            <p className="self-end rounded-2xl bg-zinc-100 px-4 py-2 text-sm dark:bg-zinc-800">{t.question}</p>
          )}
          {t.status === "loading" && <p className="animate-pulse text-sm text-zinc-500">분석 준비 중…</p>}
          <ReactTimeline steps={t.steps} collapsed={t.status === "done" || t.answer.length > 0} />
          {t.answer && <StreamedAnswer text={t.answer} />}
          {t.status === "error" && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
              <p>{t.errorMessage}</p>
              {t.retryable && (
                <button
                  onClick={() => runTurn(i, t.question, turns.slice(0, i))}
                  className="mt-2 rounded-full bg-red-600 px-4 py-1 text-xs font-medium text-white"
                >
                  재시도
                </button>
              )}
            </div>
          )}
        </div>
      ))}

      {lastTurn.status === "done" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitFollowup();
          }}
          className="flex gap-2"
        >
          <input
            value={followupText}
            onChange={(e) => setFollowupText(e.target.value)}
            placeholder="후속 질문을 입력하세요"
            className="flex-1 rounded-full border px-4 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={!followupText.trim()}
            className="rounded-full bg-black px-4 py-2 text-sm text-white disabled:opacity-40 dark:bg-white dark:text-black"
          >
            전송
          </button>
        </form>
      )}
    </div>
  );
}
