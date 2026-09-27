"use client";

import { useEffect } from "react";

/* Guarda de saída para telas com rascunho não salvo. Cobre as quatro saídas
   do App Router: fechar/recarregar a aba (beforeunload), clique em <a> do
   app, Voltar/Avançar do navegador (popstate) e navegações programáticas
   (router.push da paleta e das notificações), que chamam confirmLeave(). */

const SENTINEL_KEY = "__atendonLeaveGuard";
let activeMessage: string | null = null;

/** true = pode navegar (sem rascunho, ou o usuário aceitou descartar). */
export function confirmLeave(): boolean {
  return !activeMessage || window.confirm(activeMessage);
}

/** Ativa a guarda enquanto `message` não for null. */
export function useLeaveGuard(message: string | null) {
  useEffect(() => {
    if (!message) return;
    activeMessage = message;
    const guardedHref = window.location.href;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const onClickCapture = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor || anchor.hasAttribute("download") || anchor.target === "_blank") return;
      const href = anchor.getAttribute("href") ?? "";
      if (href.startsWith("#")) return;
      if (new URL(href, window.location.href).origin !== window.location.origin) return;
      if (!window.confirm(message)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    /* Voltar: uma entrada sentinela (mesma URL, marcada no state) absorve o
       Voltar. Chegar à entrada original com rascunho pergunta; cancelar
       re-arma a sentinela, confirmar desativa a guarda e volta de fato. Sem
       rascunho, a sentinela restante só custa um Voltar sem efeito. */
    const armSentinel = () => window.history.pushState({ ...window.history.state, [SENTINEL_KEY]: true }, "", guardedHref);
    if (!window.history.state?.[SENTINEL_KEY]) armSentinel();
    const onPopState = (event: PopStateEvent) => {
      if (event.state?.[SENTINEL_KEY] || window.location.href !== guardedHref) return;
      if (window.confirm(message)) {
        window.removeEventListener("popstate", onPopState);
        activeMessage = null;
        window.history.back();
      } else {
        armSentinel();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("popstate", onPopState);
    document.addEventListener("click", onClickCapture, true);
    return () => {
      if (activeMessage === message) activeMessage = null;
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("popstate", onPopState);
      document.removeEventListener("click", onClickCapture, true);
    };
  }, [message]);
}
