"use client";

import { forwardRef, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button, type ButtonProps } from "./button";
import { cn } from "@/lib/cn";
import { Check } from "@/components/icons";

/**
 * Padrão de salvar do DS v2 (handoff README §2), obrigatório em todo
 * Salvar/Resolver/Confirmar:
 *   idle "Salvar" → busy <spinner> "Salvando" → done <check> "Salvo" + toast 2,6s.
 */
export type SaveState = "idle" | "busy" | "done";

export const SAVE_FEEDBACK_MS = 2600;

/**
 * Máquina de estados do padrão. `run(fn)` marca busy, aguarda `fn` e marca done
 * por `duration` ms; em erro volta para idle e repropaga (o chamador mantém o
 * próprio tratamento de erro). Resultado de `fn` é devolvido.
 */
export function useSaveFeedback(duration = SAVE_FEEDBACK_MS) {
  const [state, setState] = useState<SaveState>("idle");
  const timer = useRef<number | null>(null);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);

  const markDone = useCallback(() => {
    clear();
    setState("done");
    timer.current = window.setTimeout(() => setState("idle"), duration);
  }, [duration]);

  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    clear();
    setState("busy");
    try {
      const result = await fn();
      markDone();
      return result;
    } catch (error) {
      setState("idle");
      throw error;
    }
  }, [markDone]);

  const reset = useCallback(() => { clear(); setState("idle"); }, []);

  return { state, busy: state === "busy", done: state === "done", run, markDone, reset };
}

/** Check de confirmação animado (`.on-check` de styles/motion.css). */
export function SaveCheck({ size = 16 }: { size?: number }) {
  return (
    <span className="on-check" style={{ width: size, height: size }} aria-hidden="true">
      <Check size={size * 0.75} strokeWidth={2.5} />
    </span>
  );
}

export type SaveButtonProps = Omit<ButtonProps, "children"> & {
  state: SaveState;
  /** Rótulo em repouso (ex.: "Salvar perfil"). */
  children?: ReactNode;
  busyLabel?: ReactNode;
  doneLabel?: ReactNode;
};

/**
 * Botão com o padrão de salvar. Continua um `<button>` comum (type/onClick/form
 * do chamador); em busy fica desabilitado e anuncia o estado via aria-live.
 */
export const SaveButton = forwardRef<HTMLButtonElement, SaveButtonProps>(function SaveButton(
  { state, children = "Salvar", busyLabel = "Salvando…", doneLabel = "Salvo", tone = "primary", disabled, className, icon, ...props },
  ref
) {
  const busy = state === "busy";
  return (
    <Button
      {...props}
      ref={ref}
      tone={tone}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      data-save-state={state}
      className={cn("save-button", className)}
      icon={busy ? <span className="on-spinner" aria-hidden="true" /> : state === "done" ? <SaveCheck /> : icon}
    >
      <span aria-live="polite">{busy ? busyLabel : state === "done" ? doneLabel : children}</span>
    </Button>
  );
});

/**
 * Toast de sucesso centralizado (`.on-toast`). Renderizado em portal no body
 * com camada fixa própria, então não exige `position: relative` no pai.
 */
export function SaveToast({ show, children = "Alterações salvas" }: { show: boolean; children?: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!show || !mounted) return null;
  return createPortal(
    <div className="save-toast-layer">
      <div className="on-toast" role="status" aria-live="polite">
        <SaveCheck size={22} />
        <span>{children}</span>
      </div>
    </div>,
    document.body
  );
}
