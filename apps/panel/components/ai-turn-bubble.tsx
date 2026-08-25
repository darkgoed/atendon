"use client";

import { Robot } from "@phosphor-icons/react";
import React from "react";
import {
  aiTurnPhaseLabel,
  type AiTurnProgress
} from "../lib/ai-turn-progress";

export function AiTurnBubble({ progress }: { progress: AiTurnProgress }) {
  const showPreview = Boolean(progress.preview)
    && (progress.phase === "preview" || progress.phase === "sending");
  return (
    <div className="flex justify-end" aria-live="polite" aria-atomic="true" role="status">
      <div className="flex max-w-[min(42rem,92%)] flex-col items-end gap-1">
        <div className="flex items-center gap-1.5 px-1 text-[10px] font-medium text-[var(--accent-soft)]">
          <Robot size={12} weight="duotone" aria-hidden="true" />
          <span>{aiTurnPhaseLabel(progress)}</span>
          {progress.phase !== "preview" && progress.phase !== "sending" ? (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)]" aria-hidden="true" />
          ) : null}
        </div>
        <div className="min-w-[12rem] rounded-tl-[12px] rounded-tr-[12px] rounded-bl-[12px] rounded-br-[3px] border border-dashed border-[var(--border-ai)] bg-[var(--accent-bg)] px-3.5 py-2.5 shadow-sm transition-[opacity,transform] duration-300">
          {showPreview ? (
            <>
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--body)]">
                {progress.preview}
              </p>
              {progress.previewTruncated ? (
                <p className="mt-2 border-t border-[var(--border-ai)] pt-1.5 text-[10px] text-[var(--faint-text)]">
                  Prévia abreviada no painel
                </p>
              ) : null}
            </>
          ) : (
            <div className="flex items-center gap-1.5 py-0.5" aria-hidden="true">
              {[0, 1, 2].map((index) => (
                <span
                  key={index}
                  className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)] opacity-70"
                  style={{ animationDelay: `${index * 140}ms` }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
