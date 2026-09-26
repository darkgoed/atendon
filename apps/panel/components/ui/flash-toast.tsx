"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { SaveToast } from "./save-feedback";

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
  const show = useCallback((text: string) => {
    const value = text.trim();
    if (!value) return;
    setState((current) => ({ text: value, key: (current?.key ?? 0) + 1 }));
  }, []);
  const clear = useCallback(() => setState(null), []);
  useEffect(() => {
    if (!state) return;
    const timer = window.setTimeout(() => setState(null), Math.min(7000, 2400 + state.text.length * 40));
    return () => window.clearTimeout(timer);
  }, [state]);
  return {
    show,
    clear,
    text: state?.text ?? null,
    toast: <SaveToast key={state?.key ?? 0} show={Boolean(state)}>{state?.text}</SaveToast>
  };
}
