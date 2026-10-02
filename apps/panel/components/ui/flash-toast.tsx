"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { dismissToast, reportToast } from "@/lib/error-events";

/**
 * Resposta imediata: um aviso breve e animado logo após a ação ("Lead movido
 * para Proposta", "Tarefa concluída"). Cada `show()` reinicia a animação,
 * mesmo com o mesmo texto; o tempo na tela cresce com o tamanho da frase.
 *
 *   const flash = useFlashToast();
 *   flash.show("Tarefa concluída");
 *   return <>{...}{flash.toast}</>;
 */
export function useFlashToast(): { show: (text: string) => void; clear: () => void; toast: ReactNode; text: string | null } {
  const [state, setState] = useState<{ text: string; key: number } | null>(null);
  const token = useRef<object | null>(null);
  const show = useCallback((text: string) => {
    const value = text.trim();
    if (!value) return;
    token.current = reportToast(value, { kind: "success", duration: Math.min(7000, 2400 + value.length * 40), refresh: true });
    setState((current) => ({ text: value, key: (current?.key ?? 0) + 1 }));
  }, []);
  const clear = useCallback(() => {
    if (token.current) dismissToast(token.current);
    token.current = null;
    setState(null);
  }, []);
  useEffect(() => {
    if (!state) return;
    const timer = window.setTimeout(() => setState(null), Math.min(7000, 2400 + state.text.length * 40));
    return () => window.clearTimeout(timer);
  }, [state]);
  return {
    show,
    clear,
    text: state?.text ?? null,
    toast: null
  };
}
