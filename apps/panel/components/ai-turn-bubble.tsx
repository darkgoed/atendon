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
      <div className="ai-turn-max-width flex flex-col items-end gap-1">
        <div className="flex items-center gap-1.5 px-1 text-xs font-medium ">
          <Robot size={12} weight="duotone" aria-hidden="true" />
          <span>{aiTurnPhaseLabel(progress)}</span>
          {progress.phase !== "preview" && progress.phase !== "sending" ? (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full " aria-hidden="true" />
          ) : null}
        </div>
        <div className="ai-turn-minimum border border-dashed   px-3.5 py-2.5 shadow-sm transition-[opacity,transform] duration-300">
          {showPreview ? (
            <>
              <p className="whitespace-pre-wrap text-sm leading-relaxed ">
                {progress.preview}
              </p>
              {progress.previewTruncated ? (
                <p className="mt-2 border-t  pt-1.5 text-xs ">
                  Prévia abreviada no painel
                </p>
              ) : null}
            </>
          ) : (
            <div className="flex items-center gap-1.5 py-0.5" aria-hidden="true">
              {[0, 1, 2].map((index) => (
                <span
                  key={index}
                  className={`ai-turn-bubble__dot ai-turn-bubble__dot--${index}`}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
