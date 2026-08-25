"use client";

import { BellRinging, Check, ClockCounterClockwise, VideoCamera } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Empty } from "@/components/page-state";
import { Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { alertHistoryPollingDelay } from "@/lib/alerts";
import { panelFeatureEnabled, type PanelFeatureFlagsResponse } from "@/lib/feature-flags";
import { useRealtimeSignals } from "@/lib/realtime";
import { canAccessRootWorkspace, type PanelSession } from "@/lib/session";

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
const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeStyle: "short" });
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
    return dateTime.format(new Date(value.starts_at));
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
    <Shell>
      <header className="pagehead">
        <div>
          <h1>Alertas operacionais</h1>
          <p>Novas reuniões direcionadas e falhas do sistema continuam disponíveis depois que o aviso rápido desaparece.</p>
        </div>
        <div className="flex items-center gap-3 border-l border-[var(--border)] pl-5">
          <BellRinging size={20} className="text-[var(--warn)]" aria-hidden="true" />
          <div>
            <strong className="mono block text-xl leading-none text-[var(--text)]">{data?.unread ?? 0}</strong>
            <span className="text-xs text-[var(--muted)]">não lidos</span>
          </div>
        </div>
      </header>

      {error ? <p className="error mb-4" role="alert">{error.message}</p> : null}
      {!data && !error ? (
        <section className="overflow-hidden border-y border-[var(--border)]">
          {[0, 1, 2].map((item) => (
            <div className="grid grid-cols-[auto_1fr] gap-4 border-b border-[var(--border)] py-5 last:border-0" key={item}>
              <div className="skeleton size-9 rounded-full" />
              <div className="grid gap-2"><div className="skeleton h-4 w-3/5" /><div className="skeleton h-3 w-32" /></div>
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
                  className={`grid gap-4 border-b border-[var(--border)] py-5 last:border-0 md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-center ${unread ? "text-[var(--text)]" : "text-[var(--muted)]"}`}
                  key={alert.id}
                >
                  <span className={`grid size-10 place-items-center rounded-full border ${unread ? "border-[var(--warn-border)] bg-[var(--warn-bg)] text-[var(--warn)]" : "border-[var(--border)] text-[var(--faint)]"}`}>
                    {meeting ? <VideoCamera size={18} weight={unread ? "fill" : "regular"} aria-hidden="true" /> : unread ? <BellRinging size={18} weight="fill" aria-hidden="true" /> : <Check size={18} weight="bold" aria-hidden="true" />}
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-sm">{meeting ? meetingTitle(meeting) : alert.message}</strong>
                      {unread ? <span className="rounded border border-[var(--warn-border)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[.1em] text-[var(--warn)]">Novo</span> : null}
                    </div>
                    {meeting ? (
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-[var(--muted)]">
                        <span>{meeting.contact_phone}</span>
                        <span>{meetingDateTime(meeting)}</span>
                        {meeting.meet_url?.startsWith("https://meet.google.com/") ? (
                          <a className="inline-flex items-center gap-1.5 font-medium text-[var(--accent-soft)] underline underline-offset-4 active:scale-[0.98]" href={meeting.meet_url} target="_blank" rel="noreferrer">
                            <VideoCamera size={14} aria-hidden="true" /> Abrir Google Meet
                          </a>
                        ) : <span>Sem link de reunião</span>}
                      </div>
                    ) : null}
                    <time className="mono mt-2 flex items-center gap-1.5 text-[11px] text-[var(--faint)]" dateTime={alert.created_at}>
                      <ClockCounterClockwise size={13} aria-hidden="true" />
                      {dateTime.format(new Date(alert.created_at))}
                    </time>
                  </div>
                  {unread ? (
                    <button
                      className="btn min-h-11 justify-self-start active:scale-[.98] md:justify-self-end"
                      disabled={dismissing === alert.id}
                      onClick={() => void dismiss(alert.id)}
                      type="button"
                    >
                      <Check size={16} weight="bold" aria-hidden="true" />
                      {dismissing === alert.id ? "Dispensando…" : "Dispensar"}
                    </button>
                  ) : (
                    <span className="mono text-[10px] uppercase tracking-[.1em] text-[var(--faint)] md:text-right">
                      {alert.can_acknowledge ? "Revisado" : "Somente leitura"}
                    </span>
                  )}
                </article>
              );
            })}
          </section>
          {data && data.total > PAGE_SIZE ? (
            <nav aria-label="Paginação dos alertas" className="mt-5 flex items-center justify-between gap-4">
              <button className="btn min-h-11 active:scale-[.98]" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} type="button">
                Mais recentes
              </button>
              <span className="mono text-[11px] text-[var(--faint)]">
                {offset + 1}–{Math.min(offset + alerts.length, data.total)} de {data.total}
              </span>
              <button className="btn min-h-11 active:scale-[.98]" disabled={offset + PAGE_SIZE >= data.total} onClick={() => setOffset(offset + PAGE_SIZE)} type="button">
                Anteriores
              </button>
            </nav>
          ) : null}
        </>
      )}
    </Shell>
  );
}
