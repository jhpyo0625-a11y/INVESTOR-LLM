// src/components/ReactTimeline.tsx
"use client";

import { useEffect, useState } from "react";
import { MAX_STEP_TEXT_DISPLAY_CHARS, type StepPayload } from "@/lib/chat-types";

const ICON: Record<StepPayload["type"], string> = { action: "🔧", observation: "👁" };

export function ReactTimeline({ steps, collapsed }: { steps: StepPayload[]; collapsed: boolean }) {
  const [open, setOpen] = useState(true);
  const [autoCollapsed, setAutoCollapsed] = useState(false);

  useEffect(() => {
    if (collapsed && !autoCollapsed) {
      setOpen(false);
      setAutoCollapsed(true);
    }
  }, [collapsed, autoCollapsed]);

  if (steps.length === 0) return null;

  return (
    <div className="rounded-lg border text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2 font-medium"
      >
        <span>진행 과정 ({steps.length})</span>
        <span>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <ul className="flex flex-col gap-2 border-t px-4 py-3">
          {steps.map((s, i) => (
            <li key={i} className="flex gap-2">
              <span>{ICON[s.type]}</span>
              <span className="flex flex-col">
                <span className="font-medium">{s.tool}</span>
                <span className="break-all text-zinc-500">{s.text.slice(0, MAX_STEP_TEXT_DISPLAY_CHARS)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
