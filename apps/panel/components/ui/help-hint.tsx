"use client";

import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Tooltip } from "./overlays";

/** Orientação no rótulo/controle existente, sem criar um botão de ajuda. */
export function HelpHint({ content, description, label, title, children, asChild = false, side = "top", align = "center", className }: {
  content?: ReactNode;
  description?: ReactNode;
  /** Compatibilidade temporária: callers antigos exibem o assunto como texto. */
  label?: string;
  title?: ReactNode;
  children: ReactNode;
  asChild?: boolean;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  className?: string;
}) {
  const descriptionId = `help-${useId()}`;
  const explanation = content ?? children;
  const trigger = content === undefined ? title ?? label?.replace(/^Ajuda:\s*/, "") : children;
  const element = isValidElement(trigger) ? trigger as ReactElement<Record<string, unknown>> : null;
  const describedBy = [element?.props["aria-describedby"], descriptionId].filter(Boolean).join(" ");
  return (
    <>
      <Tooltip content={explanation} side={side} align={align} compact>
        {asChild && element ? cloneElement(element, {
          "aria-describedby": describedBy,
          title: undefined,
          ...(["span", "label"].includes(String(element.type)) ? { tabIndex: element.props.tabIndex ?? 0 } : {}),
        }) : (
          <span tabIndex={0} className={cn("compact-help-trigger", className)} aria-describedby={descriptionId}>{trigger}</span>
        )}
      </Tooltip>
      <span id={descriptionId} className="compact-help-description" hidden>{description ?? explanation}</span>
    </>
  );
}
