"use client";

import { WarningCircle, X } from "@/components/icons";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ERROR_TOAST_EVENT } from "@/lib/error-events";
import { adaptivePollingDelay, toastableAlerts, type ServerAlertToast } from "@/lib/alerts";
import type { PanelFeatureFlagsResponse } from "@/lib/feature-flags";
import { canPollWorkspaceAlerts, type PanelSession } from "@/lib/session";
import { WhatsAppDisconnectedHelp } from "@/components/whatsapp-disconnected-help";
import { isWhatsAppDisconnectedError } from "@/lib/whatsapp-support";

type Toast = { id: number; message: string; kind: "error" | "operational" };

function errorMessage(value: unknown): string {
  if (value instanceof Error && value.message) return value.message;
  if (typeof value === "string" && value.trim()) return value;
  return "Ocorreu um erro inesperado";
}

export function ErrorToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const lastToast = useRef({ message: "", kind: "error" as Toast["kind"], at: 0 });
  const dismissTimers = useRef(new Set<number>());
  const seenServerAlerts = useRef(new Set<string>());
  const alertPollingState = useRef<{ pathname: string; enabled: boolean } | null>(null);

  useEffect(() => {
    const timers = dismissTimers.current;
    let stopped = false;
    let pollInFlight = false;
    let pollTimer: number | undefined;
    let consecutiveFailures = 0;
    let deliveryV2 = false;
    const add = (message: string, kind: Toast["kind"] = "error") => {
      if (stopped) return;
      const now = Date.now();
      if (lastToast.current.message === message && lastToast.current.kind === kind && now - lastToast.current.at < 10_000) return;
      lastToast.current = { message, kind, at: now };
      const id = ++nextId.current;
      setToasts((current) => [...current, { id, message, kind }].slice(-4));
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        setToasts((current) => current.filter((toast) => toast.id !== id));
      }, 8_000);
      timers.add(timer);
    };
    const onReportedError = (event: Event) => add(errorMessage((event as CustomEvent<{ message?: unknown }>).detail?.message));
    const onWindowError = (event: ErrorEvent) => add(errorMessage(event.error ?? event.message));
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
        for (const alert of toastableAlerts(alerts)) {
          if (seenServerAlerts.current.has(alert.id)) continue;
          seenServerAlerts.current.add(alert.id);
          add(alert.message, "operational");
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
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return (
    <section className="error-toasts" aria-label="Avisos do sistema" aria-live="assertive">
      {toasts.map((toast) => (
        <div className="error-toast" role="alert" key={toast.id}>
          <WarningCircle className="error-toast-icon" size={20} weight="fill" aria-hidden="true" />
          <div>
            <strong>{toast.kind === "operational" ? "Alerta operacional" : "Não foi possível concluir"}</strong>
            <p>{toast.message}</p>
            {toast.kind === "error" && isWhatsAppDisconnectedError(toast.message) ? <WhatsAppDisconnectedHelp /> : null}
            {toast.kind === "operational" ? (
              <Link className="mt-2 inline-block text-xs font-medium text-[var(--warning-text)] underline underline-offset-4" href="/alertas">
                Revisar na central
              </Link>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="Fechar aviso de erro"
            onClick={() => setToasts((current) => current.filter(({ id }) => id !== toast.id))}
          >
            <X size={16} weight="bold" aria-hidden="true" />
          </button>
        </div>
      ))}
    </section>
  );
}
