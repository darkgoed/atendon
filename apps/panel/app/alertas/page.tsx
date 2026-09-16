"use client";

import { BellRinging, Check, ClockCounterClockwise, VideoCamera } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Empty } from "@/components/page-state";
import { Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { formatPanelDateTime } from "@/lib/format";
import { alertHistoryPollingDelay } from "@/lib/alerts";
import { panelFeatureEnabled, type PanelFeatureFlagsResponse } from "@/lib/feature-flags";
import { useRealtimeSignals } from "@/lib/realtime";
import { canAccessRootWorkspace, type PanelSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import styles from "../channels-ai.module.css";

type OperationalAlert = {
  id: string;
  message: string;
  kind: "operational" | "meeting";
  metadata: Record<string, unknown>;
  created_at: string;
  notified_at: string | null;
  read_at: string | null;
  can_acknowledge: boolean;
};

type AlertsResponse = {
  alerts: OperationalAlert[];
  unread: number;
  total: number;
  offset: number;
  limit: number;
  receipt_mode: "member" | "root_read_only";
};

const fetcher = <T,>(url: string) => api<T>(url);

const PAGE_SIZE = 50;

type MeetingAlertMetadata = {
  event?: "appointment_assigned" | "appointment_reassigned_in" | "appointment_reassigned_out" | "appointment_unassigned";
  contact_name?: string | null;
  contact_phone?: string;
  starts_at?: string;
  timezone?: string;
  meet_url?: string | null;
};

function meetingMetadata(alert: OperationalAlert): MeetingAlertMetadata | null {
  if (alert.kind !== "meeting" || !alert.metadata || typeof alert.metadata !== "object") return null;
  const value = alert.metadata as MeetingAlertMetadata;
  return value.starts_at || value.contact_phone ? value : null;
}

function meetingTitle(value: MeetingAlertMetadata) {
  const contact = value.contact_name || value.contact_phone || "Contato";
  if (value.event === "appointment_reassigned_in") return `Reunião recebida · ${contact}`;
  if (value.event === "appointment_reassigned_out") return `Reunião redistribuída · ${contact}`;
  if (value.event === "appointment_unassigned") return `Reunião sem responsável · ${contact}`;
  return `Nova reunião · ${contact}`;
}

function meetingDateTime(value: MeetingAlertMetadata): string {
  if (!value.starts_at) return "Horário não informado";
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: value.timezone || "UTC"
    }).format(new Date(value.starts_at));
  } catch {
    return formatPanelDateTime(value.starts_at, { dateStyle: "medium", timeStyle: "short" }, "pt-BR", "UTC");
  }
}

export default function AlertsPage() {
  const { data: session } = useSWR<PanelSession>("/me", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 10_000
  });
  const canReadAlerts = session ? canAccessRootWorkspace(session) : false;
  const [offset, setOffset] = useState(0);
  const pollingFailures = useRef(0);
  const { data: featureFlags } = useSWR<PanelFeatureFlagsResponse>("/feature-flags", fetcher, {
    refreshInterval: 5_000,
    revalidateOnFocus: true,
    dedupingInterval: 2_000
  });
  const deliveryV2 = panelFeatureEnabled(featureFlags, "alerts_delivery_v2");
  const alertsPath = canReadAlerts ? `/alerts?limit=${PAGE_SIZE}&offset=${offset}` : null;
  const { data, error, mutate } = useSWR<AlertsResponse>(
    alertsPath,
    fetcher,
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
      dedupingInterval: 4_000
    }
  );
  const [dismissing, setDismissing] = useState<string | null>(null);

  useRealtimeSignals({
    onCatchUp: () => {
      if (alertsPath && document.visibilityState === "visible") void mutate();
    },
    onSignal: (signal) => {
      if (
        alertsPath
        && document.visibilityState === "visible"
        && signal.type === "alerts.changed"
      ) void mutate();
    }
  });

  useEffect(() => {
    if (!alertsPath) return;
    pollingFailures.current = 0;
    let stopped = false;
    let inFlight = false;
    let timer: number | undefined;

    function schedule(immediate = false) {
      if (stopped) return;
      if (timer !== undefined) window.clearTimeout(timer);
      const delay = immediate
        ? document.visibilityState === "visible" ? 0 : null
        : alertHistoryPollingDelay({
            deliveryV2,
            failures: pollingFailures.current,
            visibilityState: document.visibilityState,
            baseMs: 15_000
          });
      if (delay === null) {
        timer = undefined;
        return;
      }
      timer = window.setTimeout(() => void poll(), delay);
    }

    async function poll() {
      if (stopped || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        await mutate();
        pollingFailures.current = 0;
      } catch {
        pollingFailures.current += 1;
      } finally {
        inFlight = false;
        schedule();
      }
    }

    const onVisibilityChange = () => schedule(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibilityChange);
    schedule();
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [alertsPath, deliveryV2, mutate]);

  const dismiss = async (id: string) => {
    setDismissing(id);
    try {
      await api(`/alerts/${id}/read`, { method: "PATCH" });
      await mutate();
    } finally {
      setDismissing(null);
    }
  };

  const alerts = data?.alerts ?? [];

  return (
    <Shell><div className={`${styles.channelsAiPage} channels-ai-page`}>
      <header className="pagehead">
        <div>
          <h1>Alertas operacionais</h1>
          <p>Novas reuniões direcionadas e falhas do sistema continuam disponíveis depois que o aviso rápido desaparece.</p>
        </div>
        <div className="flex items-center gap-3 border-l border-[var(--border)] pl-5">
          <BellRinging size={20} className="text-[var(--warning-text)]" aria-hidden="true" />
          <div>
            <strong className="mono block text-xl leading-none text-[var(--text)]">{data?.unread ?? 0}</strong>
            <span className="text-xs text-[var(--text-secondary)]">não lidos</span>
          </div>
        </div>
      </header>

      {error ? <p className="error mb-4" role="alert">{error.message}</p> : null}
      {!data && !error ? (
        <section className="channels-ai-alert-list">
          {[0, 1, 2].map((item) => (
            <div className="channels-ai-alert-item" key={item}>
              <div className="skeleton channels-ai-alert-icon" />
              <div className="grid gap-2"><div className="skeleton channels-ai-skeleton--row" /><div className="skeleton channels-ai-skeleton--tiny" /></div>
            </div>
          ))}
        </section>
      ) : alerts.length === 0 ? (
        <Empty>Nenhum alerta foi registrado para você neste workspace.</Empty>
      ) : (
        <>
          <section aria-label="Histórico de alertas" className="border-y border-[var(--border)]">
            {alerts.map((alert) => {
              const unread = alert.can_acknowledge && !alert.read_at;
              const meeting = meetingMetadata(alert);
              return (
                <article
                  className={`channels-ai-alert-item md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-center ${unread ? "text-[var(--text)]" : "text-[var(--text-secondary)]"}`}
                  key={alert.id}
                >
                  <span className={`channels-ai-alert-icon ${unread ? "border-[var(--warning-border)] bg-[var(--warning-subtle)] text-[var(--warning-text)]" : "text-[var(--text-muted)]"}`}>
                    {meeting ? <VideoCamera size={18} weight={unread ? "fill" : "regular"} aria-hidden="true" /> : unread ? <BellRinging size={18} weight="fill" aria-hidden="true" /> : <Check size={18} weight="bold" aria-hidden="true" />}
                  </span>
                  <div className="channels-ai-min-zero">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-sm">{meeting ? meetingTitle(meeting) : alert.message}</strong>
                      {unread ? <span className="rounded border border-[var(--warning-border)] px-2 py-0.5 type-caption font-semibold uppercase tracking-[.1em] text-[var(--warning-text)]">Novo</span> : null}
                    </div>
                    {meeting ? (
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-[var(--text-secondary)]">
                        <span>{meeting.contact_phone}</span>
                        <span>{meetingDateTime(meeting)}</span>
                        {meeting.meet_url?.startsWith("https://meet.google.com/") ? (
                          <a className="inline-flex items-center gap-1.5 font-medium text-[var(--primary-text)] underline underline-offset-4 active:scale-[0.98]" href={meeting.meet_url} target="_blank" rel="noreferrer">
                            <VideoCamera size={14} aria-hidden="true" /> Abrir Google Meet
                          </a>
                        ) : <span>Sem link de reunião</span>}
                      </div>
                    ) : null}
                    <time className="mono mt-2 flex items-center gap-1.5 type-caption text-[var(--text-muted)]" dateTime={alert.created_at}>
                      <ClockCounterClockwise size={13} aria-hidden="true" />
                      {formatPanelDateTime(alert.created_at, { dateStyle: "medium", timeStyle: "short" })}
                    </time>
                  </div>
                  {unread ? (
                    <Button
                      tone="default"
                      className="channels-ai-touch justify-self-start md:justify-self-end"
                      disabled={dismissing === alert.id}
                      onClick={() => void dismiss(alert.id)}
                      type="button"
                    >
                      <Check size={16} weight="bold" aria-hidden="true" />
                      {dismissing === alert.id ? "Dispensando…" : "Dispensar"}
                    </Button>
                  ) : (
                    <span className="mono type-caption uppercase tracking-[.1em] text-[var(--text-muted)] md:text-right">
                      {alert.can_acknowledge ? "Revisado" : "Somente leitura"}
                    </span>
                  )}
                </article>
              );
            })}
          </section>
          {data && data.total > PAGE_SIZE ? (
            <nav aria-label="Paginação dos alertas" className="mt-5 flex items-center justify-between gap-4">
              <button className="btn channels-ai-touch" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} type="button">
                Mais recentes
              </button>
              <span className="mono type-caption text-[var(--text-muted)]">
                {offset + 1}–{Math.min(offset + alerts.length, data.total)} de {data.total}
              </span>
              <button className="btn channels-ai-touch" disabled={offset + PAGE_SIZE >= data.total} onClick={() => setOffset(offset + PAGE_SIZE)} type="button">
                Anteriores
              </button>
            </nav>
          ) : null}
        </>
      )}
    </div></Shell>
  );
}
