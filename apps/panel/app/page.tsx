"use client";

import { ArrowRight } from "@phosphor-icons/react";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { ContactAvatar } from "@/components/contact-avatar";
import { Empty, LoadingCards } from "@/components/page-state";
import { Shell } from "@/components/shell";
import { PageHeader } from "@/components/ui";
import { CommercialDashboard, type CommercialDashboardData } from "@/components/commercial-dashboard";
import { DashboardWidgets } from "@/components/dashboard-widgets";
import { api } from "@/lib/api";
import { useCapabilities } from "@/lib/capabilities";
import { panelFeatureEnabled, type PanelFeatureFlagsResponse } from "@/lib/feature-flags";
import { handoffReasonLabel } from "@/lib/labels";
import styles from "@/components/metrics-dashboard.module.css";
import { useRealtimeSignals } from "@/lib/realtime";
import {
  canAccessRootWorkspace,
  hasWorkspaceWideCaseScope,
  type PanelSession
} from "@/lib/session";

type DashboardData = {
  connection: { status: string };
  counts: {
    handoff: number;
    handoff_unassigned: number;
    handoff_over_sla: number;
    oldest_handoff_minutes: number;
    open: number;
    ai_open: number;
    resolved_today: number;
    messagesToday: number;
  };
  agent: { is_active: boolean; ai_model: string | null } | null;
  handoffs: Array<{
    id: string;
    contact_name: string | null;
    contact_phone: string;
    avatar_url: string | null;
    handoff_reason: string | null;
    waiting_minutes: number;
    assigned_user_email: string | null;
  }>;
  commercial: CommercialDashboardData;
};

const fetcher = <T,>(url: string) => api<T>(url);

function waitingLabel(minutes = 0) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 ? ` ${minutes % 60}min` : ""}`;
}

export default function Overview() {
  const { isEnabled } = useCapabilities();
  const appointmentsEnabled = isEnabled("appointments_v1");
  const today = new Date().toISOString().slice(0, 10);
  const [period, setPeriod] = useState<CommercialDashboardData["period"]["key"]>("today");
  const [customStart, setCustomStart] = useState(today);
  const [customEnd, setCustomEnd] = useState(today);
  const { data: session } = useSWR<PanelSession>("/me", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 10_000
  });
  const { data: featureFlags, error: featureFlagsError } = useSWR<PanelFeatureFlagsResponse>("/feature-flags", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 10_000
  });
  const widgetsEnabled = panelFeatureEnabled(featureFlags, "dashboard_widgets_v1");
  const canReadAgent = session ? canAccessRootWorkspace(session) : false;
  const hasWorkspaceScope = Boolean(session && hasWorkspaceWideCaseScope(session));
  const dashboardUrl = period === "custom"
    ? `/dashboard?period=custom&start=${encodeURIComponent(customStart)}&end=${encodeURIComponent(customEnd)}`
    : `/dashboard?period=${period}`;
  const legacyDashboardUrl = !featureFlags && !featureFlagsError ? null : widgetsEnabled ? null : dashboardUrl;
  const { data, error, mutate } = useSWR<DashboardData>(legacyDashboardUrl, fetcher, {
    refreshInterval: 10_000,
    revalidateOnFocus: true,
    dedupingInterval: 4_000,
    keepPreviousData: true
  });

  useRealtimeSignals({
    onCatchUp: () => {
      if (document.visibilityState === "visible") void mutate();
    },
    onSignal: (signal) => {
      if (
        document.visibilityState === "visible"
        && (
          signal.type === "conversation.messages.changed"
          || signal.type === "case.assignment.changed"
          || signal.type === "appointment.changed"
        )
      ) {
        void mutate();
      }
    }
  });

  if (!featureFlags && !featureFlagsError) return <Shell><LoadingCards /></Shell>;
  if (widgetsEnabled) return <DashboardWidgets />;

  return (
    <Shell>
      <PageHeader title={hasWorkspaceScope ? "Visão geral" : "Minha operação"} description={hasWorkspaceScope ? "O pulso do atendimento hoje." : "Seus atendimentos, leads e reuniões em um só lugar."} />
      {error ? <p className="error" role="alert">{error.message}</p> : !data ? <LoadingCards /> : <>
        {appointmentsEnabled ? <CommercialDashboard
          data={data.commercial}
          selectedPeriod={period}
          customStart={customStart}
          customEnd={customEnd}
          onPeriodChange={setPeriod}
          onCustomStartChange={(value) => {
            setCustomStart(value);
            if (customEnd < value) setCustomEnd(value);
          }}
          onCustomEndChange={setCustomEnd}
        /> : null}
        <div className={styles.realtimeBand}>
          <span className="label">ATENDIMENTO EM TEMPO REAL</span>
        </div>
        <section className="grid4">
          <div className="card">
            <span className="label">Conexão WhatsApp</span>
            <div className={`mt-2.5 flex items-center gap-2 text-lg font-semibold leading-tight ${data.connection.status === "connected" ? "accent" : "warning"}`}>
              <i className={`dot ${data.connection.status !== "connected" ? "warn" : ""}`} aria-hidden="true" />
              {data.connection.status === "connected" ? "Conectado" : "Desconectado"}
            </div>
            <p className="sub mono">status: {data.connection.status}</p>
          </div>
          <div className="card warn">
            <span className="label">Aguardando humano</span>
            <div className="metric warning">{data.counts.handoff}</div>
            <p className="sub">
              {hasWorkspaceScope
                ? `${data.counts.handoff_unassigned} sem responsável · ${data.counts.handoff_over_sla} acima de 15 min`
                : `${data.counts.handoff_over_sla} dos seus atendimentos acima de 15 min`}
            </p>
          </div>
          <div className="card">
            <span className="label">Conversas abertas</span>
            <div className="metric">{data.counts.open}</div>
            <p className="sub">{data.counts.ai_open} com IA · {data.counts.resolved_today} resolvidas hoje</p>
          </div>
          <div className="card">
            <span className="label">Mensagens hoje</span>
            <div className="metric">{data.counts.messagesToday}</div>
            <p className="sub">contato, IA e humano</p>
          </div>
        </section>

        <section className="grid-main">
          <div className="card">
            <div className="cardtitle">
              <span>{hasWorkspaceScope ? "Aguardando atendimento humano" : "Meus atendimentos aguardando ação"}</span>
              <Link href={`/conversas?filtro=${hasWorkspaceScope ? "human" : "mine"}`} className="accent inline-flex items-center gap-1 text-xs">Ver conversas <ArrowRight size={13} aria-hidden="true" /></Link>
            </div>
            {data.handoffs.length === 0 ? <Empty>Nenhuma conversa aguardando humano.</Empty> : (
              <div className="grid gap-2">
                {data.handoffs.map((item) => (
                  <div key={item.id} className={styles.handoffItem}>
                    <ContactAvatar
                      name={item.contact_name ?? item.contact_phone}
                      src={item.avatar_url}
                      className={`${styles.handoffAvatar} text-xs text-[var(--warn)]`}
                    />
                    <div className={styles.handoffMeta}>
                      <strong className="block truncate text-sm">{item.contact_name ?? item.contact_phone}</strong>
                      <span className="text-xs text-[var(--warn-muted)]">
                        {handoffReasonLabel(item.handoff_reason)} · {waitingLabel(Number(item.waiting_minutes))}
                        {item.assigned_user_email ? ` · ${item.assigned_user_email}` : " · sem responsável"}
                      </span>
                    </div>
                    <Link className="btn warn" href={`/conversas?id=${item.id}`}>Abrir</Link>
                  </div>
                ))}
              </div>
            )}
            <p className={`sub ${styles.handoffNote}`}>
              Mais antiga: {waitingLabel(Number(data.counts.oldest_handoff_minutes))}.
              {hasWorkspaceScope
                ? " O atendente responsável também é avisado no WhatsApp da empresa."
                : " Esta fila mostra somente conversas atribuídas a você."}
            </p>
          </div>
          <div className="card flex flex-col">
            <div className="cardtitle">Agente</div>
            {data.agent ? <>
              <dl className="grid gap-4">
                <div><dt className="label">Status</dt><dd className={`mt-1 ${data.agent.is_active ? "accent" : "warning"}`}>{data.agent.is_active ? "Ativo" : "Pausado"}</dd></div>
                <div><dt className="label">Modelo</dt><dd className="mono mt-1 text-xs">{data.agent.ai_model ?? "Não configurado"}</dd></div>
              </dl>
              {canReadAgent ? <Link href="/agente" className="btn mt-auto text-center">Abrir agente</Link> : null}
            </> : <p className="sub">Seu perfil não possui acesso às configurações do agente.</p>}
          </div>
        </section>
      </>}
    </Shell>
  );
}
