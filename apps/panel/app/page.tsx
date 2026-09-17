"use client";

import { ArrowRight } from "@phosphor-icons/react";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { ContactAvatar } from "@/components/contact-avatar";
import { Empty, LoadingCards } from "@/components/page-state";
import { Shell } from "@/components/shell";
import { Button, Dot, PageHeader, Panel, PanelBody, PanelFooter, PanelHeader } from "@/components/ui";
import { CommercialDashboard, type CommercialDashboardData } from "@/components/commercial-dashboard";
import { DashboardWidgets } from "@/components/dashboard-widgets";
import { api } from "@/lib/api";
import { useCapabilities } from "@/lib/capabilities";
import { panelFeatureEnabled, type PanelFeatureFlagsResponse } from "@/lib/feature-flags";
import { handoffReasonLabel } from "@/lib/labels";
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

  const connected = data?.connection.status === "connected";

  return (
    <Shell>
      <PageHeader title={hasWorkspaceScope ? "Visão geral" : "Minha operação"} />
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

        {/* Indicadores de tempo real: UMA superfície com divisores, não quatro
            cards. Quatro caixas emolduradas lado a lado para quatro números é
            exatamente a densidade errada — os números competem com a moldura.
            Sem título de seção: cada coluna já se identifica no próprio
            overline, e um "Atendimento em tempo real" acima seria um rótulo
            sobre rótulos. */}
        <div className="overview-realtime">
          <Panel>
            <dl className="overview-metrics">
              <div className="overview-metrics__item">
                <dt className="type-overline">Conexão WhatsApp</dt>
                <dd className="overview-metrics__status">
                  <Dot tone={connected ? "success" : "warning"} />
                  <span className={connected ? "success-text" : "warning"}>{connected ? "Conectado" : "Desconectado"}</span>
                </dd>
                <dd className="type-meta mono">status: {data.connection.status}</dd>
              </div>
              <div className="overview-metrics__item">
                <dt className="type-overline">Aguardando humano</dt>
                <dd className="metric warning">{data.counts.handoff}</dd>
                <dd className="type-meta">
                  {hasWorkspaceScope
                    ? `${data.counts.handoff_unassigned} sem responsável · ${data.counts.handoff_over_sla} acima de 15 min`
                    : `${data.counts.handoff_over_sla} dos seus atendimentos acima de 15 min`}
                </dd>
              </div>
              <div className="overview-metrics__item">
                <dt className="type-overline">Conversas abertas</dt>
                <dd className="metric">{data.counts.open}</dd>
                <dd className="type-meta">{data.counts.ai_open} com IA · {data.counts.resolved_today} resolvidas hoje</dd>
              </div>
              <div className="overview-metrics__item">
                <dt className="type-overline">Mensagens hoje</dt>
                <dd className="metric">{data.counts.messagesToday}</dd>
                <dd className="type-meta">contato, IA e humano</dd>
              </div>
            </dl>
          </Panel>
        </div>

        <section className="grid-main">
          {/* Fila de handoff: uma LISTA de linhas divididas. Antes cada item era
              um bloco com borda e fundo âmbar dentro de um card — caixa dentro
              de caixa, e o alerta gritava mais que o conteúdo. */}
          <Panel>
            <PanelHeader>
              <h2 className="type-section-title">{hasWorkspaceScope ? "Aguardando atendimento humano" : "Meus atendimentos aguardando ação"}</h2>
              <Link href={`/conversas?filtro=${hasWorkspaceScope ? "human" : "mine"}`} className="overview-link">
                Ver conversas <ArrowRight size={13} aria-hidden="true" />
              </Link>
            </PanelHeader>
            {data.handoffs.length === 0 ? <Empty>Nenhuma conversa aguardando humano.</Empty> : (
              <ul className="overview-queue">
                {data.handoffs.map((item) => (
                  <li key={item.id} className="overview-queue__item">
                    <ContactAvatar
                      name={item.contact_name ?? item.contact_phone}
                      src={item.avatar_url}
                      className="overview-queue__avatar"
                    />
                    <div className="overview-queue__meta">
                      <strong className="truncate">{item.contact_name ?? item.contact_phone}</strong>
                      <span className="type-meta">
                        {handoffReasonLabel(item.handoff_reason)} · {waitingLabel(Number(item.waiting_minutes))}
                        {item.assigned_user_email ? ` · ${item.assigned_user_email}` : " · sem responsável"}
                      </span>
                    </div>
                    <Button asChild size="sm"><Link href={`/conversas?id=${item.id}`}>Abrir</Link></Button>
                  </li>
                ))}
              </ul>
            )}
            <PanelFooter className="overview-queue__note">
              <p className="type-meta">
                Mais antiga: {waitingLabel(Number(data.counts.oldest_handoff_minutes))}.
                {hasWorkspaceScope
                  ? " O atendente responsável também é avisado no WhatsApp da empresa."
                  : " Esta fila mostra somente conversas atribuídas a você."}
              </p>
            </PanelFooter>
          </Panel>

          <Panel>
            <PanelHeader><h2 className="type-section-title">Agente</h2></PanelHeader>
            <PanelBody>
              {data.agent ? <div className="stack stack--tight">
                <dl className="overview-agent">
                  <div>
                    <dt className="type-overline">Status</dt>
                    <dd className={data.agent.is_active ? "success-text" : "warning"}>{data.agent.is_active ? "Ativo" : "Pausado"}</dd>
                  </div>
                  <div>
                    <dt className="type-overline">Modelo</dt>
                    <dd className="mono type-meta">{data.agent.ai_model ?? "Não configurado"}</dd>
                  </div>
                </dl>
                {canReadAgent ? <Button asChild size="sm"><Link href="/agente">Abrir agente</Link></Button> : null}
              </div> : <p className="sub">Seu perfil não possui acesso às configurações do agente.</p>}
            </PanelBody>
          </Panel>
        </section>
      </>}
    </Shell>
  );
}
