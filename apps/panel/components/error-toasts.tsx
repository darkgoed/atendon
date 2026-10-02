"use client";

import { CheckCircle, WarningCircle, X } from "@/components/icons";
import Link from "next/link";
import { isValidElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ERROR_TOAST_EVENT, type ToastKind, type ToastNotice } from "@/lib/error-events";
import { adaptivePollingDelay, toastableAlerts, type ServerAlertToast } from "@/lib/alerts";
import type { PanelFeatureFlagsResponse } from "@/lib/feature-flags";
import { canPollWorkspaceAlerts, type PanelSession } from "@/lib/session";
import { WhatsAppDisconnectedHelp } from "@/components/whatsapp-disconnected-help";
import { isWhatsAppDisconnectedError } from "@/lib/whatsapp-support";

type Toast = { id: number; message: ReactNode; kind: ToastKind; token?: object; duration: number };

function sameContent(left: ReactNode, right: ReactNode): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((child, index) => sameContent(child, right[index]));
  if (!isValidElement<Record<string, unknown>>(left) || !isValidElement<Record<string, unknown>>(right)) return false;
  if (left.type !== right.type || left.key !== right.key) return false;
  const keys = Object.keys(left.props);
  return keys.length === Object.keys(right.props).length && keys.every((key) => key === "children"
    ? sameContent(left.props.children as ReactNode, right.props.children as ReactNode)
    : Object.is(left.props[key], right.props[key]));
}

function errorMessage(value: unknown): string {
  if (value instanceof Error && value.message) return value.message;
  if (typeof value === "string" && value.trim()) return value;
  return "Ocorreu um erro inesperado";
}

function isBenignResizeObserverError(message: unknown): boolean {
  return typeof message === "string" && message.includes("ResizeObserver loop");
}

export function ErrorToasts() {
  const [toast, setToast] = useState<Toast | null>(null);
  const nextId = useRef(0);
  const activeToast = useRef<Toast | null>(null);
  const lastSave = useRef<{ message: ReactNode } | null>(null);
  const dismissTimer = useRef<number | null>(null);
  const countdown = useRef({ id: 0, remaining: 0, startedAt: 0 });
  const [interaction, setInteraction] = useState({ hover: false, focus: false });
  const paused = interaction.hover || interaction.focus;
  const seenServerAlerts = useRef(new Set<string>());
  const alertPollingState = useRef<{ pathname: string; enabled: boolean } | null>(null);

  const dismiss = useCallback(() => {
    if (dismissTimer.current !== null) window.clearTimeout(dismissTimer.current);
    dismissTimer.current = null;
    activeToast.current = null;
    setToast(null);
  }, []);

  useEffect(() => {
    if (!toast) return;
    if (countdown.current.id !== toast.id) countdown.current = { id: toast.id, remaining: toast.duration, startedAt: 0 };
    if (paused) return;
    countdown.current.startedAt = Date.now();
    const timer = window.setTimeout(dismiss, countdown.current.remaining);
    dismissTimer.current = timer;
    return () => {
      window.clearTimeout(timer);
      countdown.current.remaining = Math.max(0, countdown.current.remaining - (Date.now() - countdown.current.startedAt));
      dismissTimer.current = null;
    };
  }, [toast, paused, dismiss]);

  useLayoutEffect(() => {
    let stopped = false;
    let pollInFlight = false;
    let pollTimer: number | undefined;
    let consecutiveFailures = 0;
    let deliveryV2 = false;
    const add = (message: ReactNode, kind: ToastKind = "error", options: ToastNotice = { message }) => {
      if (stopped) return;
      if (message == null || typeof message === "boolean" || (typeof message === "string" && !message.trim())) return;
      if (options.dedupeRemount && lastSave.current && sameContent(lastSave.current.message, message)) return;
      if (!options.refresh && activeToast.current?.kind === kind && sameContent(activeToast.current.message, message)) return;
      if (kind === "success" && (options.dedupeRemount || options.refresh)) lastSave.current = { message };
      if (dismissTimer.current !== null) window.clearTimeout(dismissTimer.current);
      const id = ++nextId.current;
      activeToast.current = { id, message, kind, token: options.token, duration: options.duration ?? (kind === "success" ? 2_600 : 8_000) };
      setInteraction({ hover: false, focus: false });
      setToast(activeToast.current);
    };
    const onReportedError = (event: Event) => {
      const detail = (event as CustomEvent<ToastNotice>).detail;
      if (detail?.dismiss) {
        if (detail.token === activeToast.current?.token) dismiss();
      } else if (detail?.kind) add(detail.message, detail.kind, detail);
      else add(errorMessage(detail?.message));
    };
    const onWindowError = (event: ErrorEvent) => {
      /* Aviso benigno do navegador (layout reajustado no mesmo frame, ex.:
         arrastar nós no editor de fluxos) — não é falha da operação. */
      if (isBenignResizeObserverError(event.message)) return;
      add(errorMessage(event.error ?? event.message));
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => add(errorMessage(event.reason));

    const readSession = async (): Promise<PanelSession | null> => {
      const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/backend";
      const response = await fetch(`${base}/me`, { credentials: "include" });
      if (!response.ok) return null;
      return response.json() as Promise<PanelSession>;
    };

    const readDeliveryFlag = async (): Promise<boolean> => {
      const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/backend";
      const response = await fetch(`${base}/feature-flags`, { credentials: "include" });
      if (!response.ok) return false;
      const body = await response.json() as PanelFeatureFlagsResponse;
      return body.flags.alerts_delivery_v2 === true;
    };

    const claimServerAlerts = async (): Promise<
      { alerts: ServerAlertToast[]; featureDisabled: boolean }
    > => {
      const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/backend";
      const response = await fetch(`${base}/alerts/notifications/claim`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 20 })
      });
      const body = await response.json() as {
        alerts?: ServerAlertToast[];
        error?: string;
        code?: string;
        feature?: string;
      };
      if (
        response.status === 409
        && body.code === "FEATURE_FLAG_DISABLED"
        && body.feature === "alerts_delivery_v2"
      ) {
        return { alerts: [], featureDisabled: true };
      }
      if (!response.ok) throw new Error(body.error || `Falha na requisição (${response.status})`);
      return { alerts: body.alerts ?? [], featureDisabled: false };
    };

    window.addEventListener(ERROR_TOAST_EVENT, onReportedError);
    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    function schedulePoll(immediate = false) {
      if (stopped) return;
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
      const delay = immediate
        ? document.visibilityState === "visible" ? 0 : null
        : deliveryV2
          ? adaptivePollingDelay({
              failures: consecutiveFailures,
              visibilityState: document.visibilityState,
              baseMs: 5_000
            })
          : document.visibilityState === "visible" ? 5_000 : null;
      if (delay === null) {
        pollTimer = undefined;
        return;
      }
      pollTimer = window.setTimeout(() => void pollServerAlerts(), delay);
    }
    async function pollServerAlerts() {
      const pathname = window.location.pathname;
      if (document.visibilityState !== "visible" || pollInFlight) return;
      if (pathname.startsWith("/login")) {
        consecutiveFailures = 0;
        schedulePoll();
        return;
      }
      pollInFlight = true;
      try {
        if (alertPollingState.current?.pathname !== pathname) {
          alertPollingState.current = { pathname, enabled: canPollWorkspaceAlerts(await readSession()) };
        }
        if (!alertPollingState.current?.enabled) {
          consecutiveFailures = 0;
          return;
        }
        deliveryV2 = await readDeliveryFlag();
        if (!deliveryV2) {
          consecutiveFailures = 0;
          return;
        }
        const { alerts, featureDisabled } = await claimServerAlerts();
        if (featureDisabled) {
          deliveryV2 = false;
          consecutiveFailures = 0;
          return;
        }
        const unseen = toastableAlerts(alerts).filter((alert) => !seenServerAlerts.current.has(alert.id));
        if (unseen.length) {
          for (const alert of unseen) seenServerAlerts.current.add(alert.id);
          add(unseen.map((alert) => alert.message).join("\n"), "operational");
        }
        consecutiveFailures = 0;
      } catch (caught) {
        add(errorMessage(caught));
        consecutiveFailures += 1;
      } finally {
        pollInFlight = false;
        schedulePoll();
      }
    }
    const onVisibilityChange = () => schedulePoll(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibilityChange);
    schedulePoll(true);
    return () => {
      stopped = true;
      window.removeEventListener(ERROR_TOAST_EVENT, onReportedError);
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
      if (dismissTimer.current !== null) window.clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    };
  }, [dismiss]);

  return (
    <section className="error-toasts" aria-label="Avisos do sistema">
      {toast ? (
        <div className="error-toast" data-kind={toast.kind} role={toast.kind === "success" || toast.kind === "info" ? "status" : "alert"} aria-live={toast.kind === "success" || toast.kind === "info" ? "polite" : "assertive"} key={toast.id}
          onPointerEnter={() => setInteraction((current) => ({ ...current, hover: true }))}
          onPointerLeave={() => setInteraction((current) => ({ ...current, hover: false }))}
          onFocus={() => setInteraction((current) => ({ ...current, focus: true }))}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setInteraction((current) => ({ ...current, focus: false }));
          }}
        >
          {toast.kind === "success" ? <CheckCircle className="error-toast-icon" size={20} aria-hidden="true" /> : <WarningCircle className="error-toast-icon" size={20} weight="fill" aria-hidden="true" />}
          <div>
            <strong>{toast.kind === "operational" ? "Alerta operacional" : toast.kind === "success" ? "Concluído" : toast.kind === "info" ? "Informação" : toast.kind === "warning" ? "Atenção" : "Não foi possível concluir"}</strong>
            <div className="error-toast-message">{toast.message}</div>
            {toast.kind === "error" && typeof toast.message === "string" && isWhatsAppDisconnectedError(toast.message) ? <WhatsAppDisconnectedHelp /> : null}
            {toast.kind === "operational" ? (
              <Link className="mt-2 inline-block text-xs font-medium text-[var(--warning-text)] underline underline-offset-4" href="/alertas">
                Revisar na central
              </Link>
            ) : null}
          </div>
          <button
            type="button"
            aria-label={toast.kind === "error" ? "Fechar aviso de erro" : "Fechar aviso"}
            onClick={dismiss}
          >
            <X size={16} weight="bold" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </section>
  );
}
