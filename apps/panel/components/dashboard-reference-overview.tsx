"use client";

import type { ReactNode } from "react";
import useSWR from "swr";
import { api, ApiError } from "@/lib/api";
import { useCapabilities } from "@/lib/capabilities";
import styles from "./dashboard-reference-overview.module.css";

type MetricsResult = {
  new_contacts: number;
  appointments: number;
  calls: number;
  sales: number;
  sold_value: number;
  average_ticket: number;
  due_meetings: number;
  no_show: number;
};

type MetricsFunnel = {
  lead_to_appointment: number;
  appointment_to_attendance: number;
  call_to_sale: number;
  lead_to_sale: number;
  no_show_rate: number;
};

type CommercialMetricsPayload = { result: MetricsResult; funnel: MetricsFunnel };
type CommercialMetricsResponse = { data: CommercialMetricsPayload };
type DashboardBundleResponse = { widgets: Record<string, { key: string; data: unknown }> };
type WidgetValueResponse = { data: { value: number } };

/* Payloads das seções que substituem o board de widgets — mesmos endpoints do
   catálogo antigo, agora com apresentação da referência. */
type OperationsPayload = {
  operations: {
    inbound_messages: number;
    open_conversations: number;
    handoffs: number;
    average_first_response_minutes: number | null;
    overdue_follow_ups: number;
    unassigned_leads: number;
  };
};
type OperationsResponse = { data: OperationsPayload };
type OpenConversationsPayload = { open: number; ai_open: number; resolved_today: number };
type OpenConversationsResponse = { data: OpenConversationsPayload };
type WhatsappPayload = { total: number; connected: number };
type WhatsappResponse = { data: WhatsappPayload };
type AgendaItem = { id: string; start_at: string; lead_name?: string; lead_phone?: string };
type AgendaPayload = { items: AgendaItem[]; period?: { timezone?: string } };
type AgendaResponse = { data: AgendaPayload };
type HandoffItem = { id: string; contact_name?: string; contact_phone?: string; waiting_minutes: number };
type HandoffsPayload = { total: number; items: HandoffItem[] };
type HandoffsResponse = { data: HandoffsPayload };
type AlertItem = { id: string; message: string; created_at: string };
type AlertsPayload = { items: AlertItem[] };
type AlertsResponse = { data: AlertsPayload };
type PipelineStage = { id?: string; status?: string; name?: string; count: number; capacity_target?: number; color?: string };
type PipelinePayload = { stages: PipelineStage[] };
type PipelineResponse = { data: PipelinePayload };
type TeamMember = {
  member_id: string;
  name?: string;
  email?: string;
  availability_status?: string;
  completed: number;
  no_show: number;
  sales: number;
  closing_rate: number;
  sold_value: number;
};
type TeamLoadPayload = { members: TeamMember[] };
type TeamLoadResponse = { data: TeamLoadPayload };

const fetcher = <T,>(url: string) => api<T>(url);

const nf = new Intl.NumberFormat("pt-BR");
const money = (value: number) =>
  new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
const num = (value: unknown) => Number(value ?? 0);
const pctText = (value: unknown) => `${Math.round(num(value))}%`;
const countText = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? nf.format(value) : "—");
const pctOrDash = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? pctText(value) : "—");
const isForbidden = (err: unknown) => err instanceof ApiError && err.status === 403;

const MIN_W = 22;
const TAIL = 0.72;
const GHOST = [100, 78, 58, 40];
const trap = (top: number, bottom: number) =>
  `polygon(${(100 - top) / 2}% 0%, ${(100 + top) / 2}% 0%, ${(100 + bottom) / 2}% 100%, ${(100 - bottom) / 2}% 100%)`;

function funnelWidths(values: number[]) {
  const max = Math.max(...values);
  if (!max) return { widths: GHOST, empty: true };
  return { widths: values.map((v) => MIN_W + (100 - MIN_W) * (v / max)), empty: false };
}

type IconProps = { size?: number; w?: number };

function BaseIcon({ size = 14, w = 2, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={w}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}
const DollarIcon = (p: IconProps) => (
  <BaseIcon {...p}>
    <path d="M12 2v20" />
    <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
  </BaseIcon>
);
const UsersIcon = (p: IconProps) => (
  <BaseIcon {...p}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </BaseIcon>
);
const CalendarIcon = (p: IconProps) => (
  <BaseIcon {...p}>
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <path d="M16 2v4" />
    <path d="M8 2v4" />
    <path d="M3 10h18" />
  </BaseIcon>
);
const CheckCircleIcon = (p: IconProps) => (
  <BaseIcon {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="m9 12 2 2 4-4" />
  </BaseIcon>
);
const ChartIcon = (p: IconProps) => (
  <BaseIcon {...p}>
    <path d="M3 3v18h18" />
    <path d="m7 14 4-4 3 3 5-6" />
  </BaseIcon>
);
const NoShowIcon = (p: IconProps) => (
  <BaseIcon {...p}>
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <path d="M3 10h18" />
    <path d="m10 14 4 4" />
    <path d="m14 14-4 4" />
  </BaseIcon>
);
const MessageIcon = (p: IconProps) => (
  <BaseIcon {...p}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </BaseIcon>
);
const ChatIcon = (p: IconProps) => (
  <BaseIcon {...p}>
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
  </BaseIcon>
);
const ClockIcon = (p: IconProps) => (
  <BaseIcon {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" />
  </BaseIcon>
);
const FlagIcon = (p: IconProps) => (
  <BaseIcon {...p}>
    <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
    <path d="M4 22v-7" />
  </BaseIcon>
);
const SignalIcon = (p: IconProps) => (
  <BaseIcon {...p}>
    <path d="M2 20h.01" />
    <path d="M7 20v-4" />
    <path d="M12 20v-8" />
    <path d="M17 20V8" />
    <path d="M22 4v16" />
  </BaseIcon>
);

type Stage = {
  n: string;
  label: string;
  color: string;
  tone: "primary" | "success";
  bg: string;
  value: number;
  stepPct: number | null;
  stepLabel: string;
};

type Ring = {
  label: string;
  value: string;
  pct: number | null;
  note: string;
  color: string;
  icon: ReactNode;
};

type Kpi = { label: string; value: string; hint?: string; tint: string; icon: ReactNode };

type WidgetHooks = { data?: { data: unknown }; error?: unknown; hidden: boolean };
/* Uma seção entra na tela quando todos os seus endpoints concluíram a primeira
   carga (dado, erro ou desabilitado). Quem falhou só omita as próprias métricas
   — nunca trava a seção inteira nem quebra a página. */
function settled(...hooks: WidgetHooks[]) {
  return hooks.every((hook) => Boolean(hook.data) || Boolean(hook.error) || hook.hidden);
}

export function DashboardReferenceOverview({ periodQuery }: { periodQuery: string }) {
  const { isEnabled } = useCapabilities();
  const appointmentsEnabled = isEnabled("appointments_v1");
  const leadsEnabled = isEnabled("leads_v1");
  const pipelineEnabled = isEnabled("pipeline_v1");
  // Uma única requisição consolidada (backend deriva todos os widgets de
  // agregados compartilhados) alimenta a visão inteira — em vez de ~23 requests
  // simultâneas com a mesma autenticação, gates e períodos.
  const bundle = useSWR<DashboardBundleResponse>(`/dashboard?include=widgets&${periodQuery}`, fetcher, {
    refreshInterval: 15_000,
    revalidateOnFocus: true
  });
  const widgetOf = <T,>(key: string) => ({
    // Cada entrada do bundle é { key, data } — o mesmo corpo do endpoint
    // individual. Os tipos históricos (T) modelam esse corpo sem a chave `key`,
    // então o cast é direto na entrada inteira.
    data: bundle.data?.widgets?.[key] as T | undefined,
    error: undefined as unknown
  });
  const commercial = {
    ...widgetOf<CommercialMetricsResponse>("commercial_metrics"),
    error: bundle.error,
    mutate: () => bundle.mutate()
  };
  const started = widgetOf<WidgetValueResponse>("conversations_started");
  const conversion = widgetOf<WidgetValueResponse>("conversion_rate");

  // Seções que substituem o board: mesmos payloads do catálogo, apresentação
  // da referência. Widget ausente do bundle (capability/permission ausente no
  // catálogo do servidor) esconde a própria seção — nunca quebra a página.
  const operations = widgetOf<OperationsResponse>("operations_summary");
  const openConversations = widgetOf<OpenConversationsResponse>("open_conversations");
  const whatsapp = widgetOf<WhatsappResponse>("whatsapp_connection");
  const agenda = widgetOf<AgendaResponse>("today_agenda");
  const handoffs = widgetOf<HandoffsResponse>("handoffs");
  const alerts = widgetOf<AlertsResponse>("recent_alerts");
  const attendanceRate = widgetOf<WidgetValueResponse>("attendance_rate");
  const reschedules = widgetOf<WidgetValueResponse>("reschedules");
  const pipeline = widgetOf<PipelineResponse>("pipeline");
  const newLeads = widgetOf<WidgetValueResponse>("new_leads");
  const pendingFollowUps = widgetOf<WidgetValueResponse>("pending_follow_ups");
  const leadsPaid = widgetOf<WidgetValueResponse>("leads_paid_traffic");
  const leadsReferral = widgetOf<WidgetValueResponse>("leads_referral");
  const leadsOrganic = widgetOf<WidgetValueResponse>("leads_organic");
  const leadsOther = widgetOf<WidgetValueResponse>("leads_other_sources");
  const lostSales = widgetOf<WidgetValueResponse>("lost_sales");
  const salesPaid = widgetOf<WidgetValueResponse>("sales_paid_traffic");
  const salesReferral = widgetOf<WidgetValueResponse>("sales_referral");
  const salesOrganic = widgetOf<WidgetValueResponse>("sales_organic");
  const team = widgetOf<TeamLoadResponse>("team_load");

  const retryAll = () => {
    void bundle.mutate();
  };

  const blockingError = appointmentsEnabled
    ? commercial.error ?? [started.error, conversion.error].find((err) => err && !isForbidden(err))
    : null;
  const commercialForbidden = !appointmentsEnabled || isForbidden(commercial.error);
  if (blockingError) {
    return (
      <div className={styles.wrap}>
        <div className={styles.state}>
          <span className={styles.stateTitle}>Não foi possível carregar as métricas comerciais</span>
          <span className={styles.stateText}>Verifique a conexão e tente novamente.</span>
          <button type="button" className={styles.retry} onClick={() => retryAll()}>
            Tentar novamente
          </button>
        </div>
      </div>
    );
  }

  const payload = commercial.data?.data;
  const startedForbidden = isForbidden(started.error);
  const conversionForbidden = isForbidden(conversion.error);
  if (appointmentsEnabled && (!payload || (!started.data && !startedForbidden) || (!conversion.data && !conversionForbidden))) {
    return (
      <div className={styles.wrap}>
        <div className={styles.state}>
          <span className={styles.stateText}>Carregando métricas…</span>
        </div>
      </div>
    );
  }

  const r = payload?.result;
  const f = payload?.funnel;
  const startedValue = started.data?.data?.value;
  const conversionValue = conversion.data?.data?.value;

  const kpis: Kpi[] = [
    { label: "Conversas iniciadas", value: countText(startedValue), tint: "#22D3EE", icon: <UsersIcon size={14} w={2} /> },
    { label: "Agendamentos", value: r ? nf.format(num(r.appointments)) : "—", tint: "#67E8F9", icon: <CalendarIcon size={14} w={2} /> },
    { label: "Vendas", value: r ? nf.format(num(r.sales)) : "—", tint: "#3DDC97", icon: <CheckCircleIcon size={14} w={2} /> },
    { label: "Taxa de conversão", value: pctOrDash(conversionValue), tint: "#F5B94A", icon: <ChartIcon size={14} w={2} /> },
  ];

  const funnelBlock = (() => {
    if (!r || !f) {
      return (
        <div className={`${styles.funnelCard} ${styles.funnelCardEmpty}`}>
          <div className={styles.funnelHead}>
            <div className={styles.funnelTitleBlock}>
              <span className={styles.funnelTitle}>Funil de conversão</span>
              <span className={styles.funnelSubtitle}>Da primeira conversa ao fechamento</span>
            </div>
          </div>
          <p className={styles.funnelEmptyText}>
            O funil e as métricas comerciais ficam disponíveis com o módulo de agendamentos ativo para este workspace.
          </p>
        </div>
      );
    }
    const { widths, empty } = funnelWidths([num(r.new_contacts), num(r.appointments), num(r.calls), num(r.sales)]);
    const stageBg = (gradient: string) => (empty ? "rgba(255,255,255,.05)" : gradient);
    const stages: Stage[] = [
      { n: "01", label: "Novos contatos", color: "#22D3EE", tone: "primary", bg: stageBg("linear-gradient(180deg,rgba(34,211,238,.42),rgba(34,211,238,.26))"), value: num(r.new_contacts), stepPct: null, stepLabel: "" },
      { n: "02", label: "Agendamentos", color: "#67E8F9", tone: "primary", bg: stageBg("linear-gradient(180deg,rgba(45,200,230,.34),rgba(45,200,230,.2))"), value: num(r.appointments), stepPct: Math.round(num(f.lead_to_appointment)), stepLabel: "Lead → Agendamento" },
      { n: "03", label: "Calls realizadas", color: "#4FE0B0", tone: "success", bg: stageBg("linear-gradient(180deg,rgba(61,220,170,.32),rgba(61,220,160,.18))"), value: num(r.calls), stepPct: Math.round(num(f.appointment_to_attendance)), stepLabel: "Agendamento → Comparecimento" },
      { n: "04", label: "Vendas", color: "#3DDC97", tone: "success", bg: stageBg("linear-gradient(180deg,rgba(61,220,151,.42),rgba(61,220,151,.26))"), value: num(r.sales), stepPct: Math.round(num(f.call_to_sale)), stepLabel: "Call → Venda" },
    ];
    return (
      <div className={styles.funnelCard}>
        <div className={styles.funnelHead}>
          <div className={styles.funnelTitleBlock}>
            <span className={styles.funnelTitle}>Funil de conversão</span>
            <span className={styles.funnelSubtitle}>Da primeira conversa ao fechamento</span>
          </div>
          <span className={styles.funnelBadge}>
            Lead → Venda <span className={styles.funnelBadgePct}>{pctText(f.lead_to_sale)}</span>
          </span>
        </div>
        <div className={styles.funnelRows}>
          {stages.map((s, i) => {
            const top = widths[i];
            const bottom = i < stages.length - 1 ? widths[i + 1] : widths[i] * TAIL;
            return (
              <div key={s.label} className={styles.funnelRow}>
                <div className={styles.funnelLabel}>
                  <span className={styles.funnelN}>{s.n}</span>
                  <span className={styles.funnelName}>{s.label}</span>
                </div>
                <div className={styles.funnelBar}>
                  <div className={styles.funnelFill} style={{ clipPath: trap(top, bottom), background: s.bg }} />
                  <span className={styles.funnelValue}>{nf.format(s.value)}</span>
                </div>
                <div className={styles.funnelStep}>
                  {s.stepPct !== null ? (
                    <div className={styles.stepInner}>
                      <span className={styles.stepTick} />
                      <span className={styles.stepText}>
                        <span className={`${styles.stepPct} ${s.tone === "primary" ? styles.stepPctPrimary : styles.stepPctSuccess}`}>
                          {s.stepPct}%
                        </span>
                        <span className={styles.stepLabel} title={s.stepLabel}>
                          {s.stepLabel}
                        </span>
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  })();

  const rings: Ring[] = r && f
    ? [
        { label: "Lead → Venda", value: pctText(f.lead_to_sale), pct: num(f.lead_to_sale), note: "conversão ponta a ponta do período", color: "#22D3EE", icon: <ChartIcon size={16} w={2} /> },
        { label: "Taxa de no-show", value: pctText(f.no_show_rate), pct: num(f.no_show_rate), note: `sobre ${nf.format(num(r.due_meetings))} reunião(ões) já vencida(s)`, color: "#F5B94A", icon: <NoShowIcon size={16} w={2} /> },
      ]
    : [{ label: "Taxa de comparecimento", value: pctOrDash(attendanceRate.data?.data?.value), pct: num(attendanceRate.data?.data?.value), note: "agendamentos que viraram call", color: "#4FE0B0", icon: <CheckCircleIcon size={16} w={2} /> }];

  const kpiTile = (k: Kpi) => (
    <div key={k.label} className={styles.kpi}>
      <span className={styles.kpiLabel}>
        <span className={styles.kpiIcon} style={{ color: k.tint }}>
          {k.icon}
        </span>
        {k.label}
      </span>
      <span className={styles.kpiValue}>{k.value}</span>
      {k.hint ? <span className={styles.kpiHint}>{k.hint}</span> : null}
    </div>
  );

  const operationsData = operations.data?.data.operations;
  const openData = openConversations.data?.data;
  const whatsappData = whatsapp.data?.data;
  const attendanceValue = attendanceRate.data?.data?.value;

  const atendimentoKpis: Kpi[] = [];
  if (operationsData) {
    atendimentoKpis.push(
      { label: "Mensagens recebidas", value: nf.format(num(operationsData.inbound_messages)), tint: "#22D3EE", icon: <MessageIcon size={14} w={2} /> },
      { label: "Tempo médio 1ª resposta", value: operationsData.average_first_response_minutes == null ? "—" : `${nf.format(num(operationsData.average_first_response_minutes))} min`, tint: "#F5B94A", icon: <ClockIcon size={14} w={2} /> },
      { label: "Follow-ups atrasados", value: nf.format(num(operationsData.overdue_follow_ups)), tint: "#F5B94A", icon: <FlagIcon size={14} w={2} /> }
    );
    if (leadsEnabled) {
      atendimentoKpis.push({ label: "Leads sem responsável", value: nf.format(num(operationsData.unassigned_leads)), tint: "#F5B94A", icon: <UsersIcon size={14} w={2} /> });
    }
  }
  if (openData) {
    atendimentoKpis.push({
      label: "Conversas abertas (agora)",
      value: nf.format(num(openData.open)),
      hint: `${nf.format(num(openData.ai_open))} com IA · ${nf.format(num(openData.resolved_today))} resolvidas hoje`,
      tint: "#22D3EE",
      icon: <ChatIcon size={14} w={2} />
    });
  }
  if (whatsappData) {
    atendimentoKpis.push({
      label: "WhatsApp",
      value: whatsappData.total > 0 ? `${nf.format(num(whatsappData.connected))}/${nf.format(num(whatsappData.total))}` : "0",
      hint: whatsappData.total > 0 && whatsappData.connected === whatsappData.total ? "todas as conexões ativas" : "conexões ativas agora",
      tint: whatsappData.total > 0 && whatsappData.connected === whatsappData.total ? "#3DDC97" : "#F5B94A",
      icon: <SignalIcon size={14} w={2} />
    });
  }

  const agendaItems = agenda.data?.data.items ?? [];
  const handoffsData = handoffs.data?.data;
  const alertItems = alerts.data?.data.items ?? [];
  const reschedulesValue = reschedules.data?.data?.value;

  const pipelineStages = pipeline.data?.data.stages ?? [];
  const teamMembers = [...(team.data?.data.members ?? [])].sort((a, b) => num(b.sold_value) - num(a.sold_value));
  const topSold = Math.max(...teamMembers.map((member) => num(member.sold_value)), 1);
  const memberName = (member: TeamMember) => {
    const name = typeof member.name === "string" ? member.name.trim() : "";
    return name || String(member.email ?? "").split("@")[0];
  };

  const leadsKpis: Kpi[] = [
    { label: "Novos leads", value: countText(newLeads.data?.data?.value), tint: "#22D3EE", icon: <UsersIcon size={14} w={2} /> },
    { label: "Follow-ups pendentes", value: countText(pendingFollowUps.data?.data?.value), tint: "#F5B94A", icon: <FlagIcon size={14} w={2} /> },
    { label: "Tráfego pago", value: countText(leadsPaid.data?.data?.value), tint: "#22D3EE", icon: <ChartIcon size={14} w={2} /> },
    { label: "Indicação", value: countText(leadsReferral.data?.data?.value), tint: "#67E8F9", icon: <UsersIcon size={14} w={2} /> },
    { label: "Orgânico", value: countText(leadsOrganic.data?.data?.value), tint: "#4FE0B0", icon: <ChartIcon size={14} w={2} /> },
    { label: "Outros canais", value: countText(leadsOther.data?.data?.value), tint: "#F5B94A", icon: <ChartIcon size={14} w={2} /> },
  ];

  const salesBySourceKpis: Kpi[] = [
    { label: "Vendas perdidas", value: countText(lostSales.data?.data?.value), tint: "#F5B94A", icon: <NoShowIcon size={14} w={2} /> },
    { label: "Tráfego pago", value: countText(salesPaid.data?.data?.value), tint: "#22D3EE", icon: <ChartIcon size={14} w={2} /> },
    { label: "Indicação", value: countText(salesReferral.data?.data?.value), tint: "#67E8F9", icon: <UsersIcon size={14} w={2} /> },
    { label: "Orgânico", value: countText(salesOrganic.data?.data?.value), tint: "#4FE0B0", icon: <ChartIcon size={14} w={2} /> },
  ];

  return (
    <div className={styles.wrap}>
      {!commercialForbidden ? (
        <>
          <div className={styles.topGrid}>
            <div className={styles.hero}>
              <span className={styles.heroGlow} aria-hidden="true" />
              <span className={styles.heroLabel}>
                <span className={styles.heroIcon}>
                  <DollarIcon size={14} />
                </span>
                Valor vendido
              </span>
              <div className={styles.heroBody}>
                <span className={styles.heroValue}>
                  <span className={styles.heroCurrency}>R$</span>
                  <span className={styles.heroNumber}>{money(num(r?.sold_value))}</span>
                </span>
                <span className={styles.heroMeta}>
                  <span>
                    Ticket médio <span className={styles.mono}>R$ {money(num(r?.average_ticket))}</span>
                  </span>
                  <span>
                    Vendas <span className={styles.mono}>{r ? nf.format(num(r.sales)) : "—"}</span>
                  </span>
                </span>
              </div>
            </div>
            <div className={styles.kpiGrid}>{kpis.map(kpiTile)}</div>
          </div>

          <div className={styles.bottomRow}>
            {funnelBlock}
            <div className={styles.ringsCard}>
              {rings.map((g, i) => (
                <div key={g.label} className={i === 0 ? styles.ring : `${styles.ring} ${styles.ringBordered}`}>
                  <div className={styles.ringHead}>
                    <span className={styles.ringLabel}>{g.label}</span>
                    <span className={styles.ringIcon} style={{ color: g.color }}>
                      {g.icon}
                    </span>
                  </div>
                  <div className={styles.ringBody}>
                    <span className={styles.ringValue}>{g.value}</span>
                    {g.pct !== null ? (
                      <div className={styles.ringTrack}>
                        <div
                          className={styles.ringFill}
                          style={{ width: `${Math.min(Math.max(g.pct, 0), 100)}%`, background: g.color }}
                        />
                      </div>
                    ) : null}
                    <span className={styles.ringNote}>{g.note}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div className={styles.state}>
          <span className={styles.stateTitle}>Métricas comerciais indisponíveis</span>
          <span className={styles.stateText}>
            O funil de conversão fica disponível com o módulo de agendamentos ativo para este workspace.
          </span>
        </div>
      )}

      {settled({ data: operations.data, error: operations.error, hidden: false }, { data: openConversations.data, error: openConversations.error, hidden: false }, { data: whatsapp.data, error: whatsapp.error, hidden: false }) && atendimentoKpis.length ? (
        <section className={styles.sectionCard} aria-label="Atendimento">
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>Atendimento</span>
            <span className={styles.sectionHint}>sinais da operação no período</span>
          </div>
          <div className={styles.sectionKpis}>{atendimentoKpis.map(kpiTile)}</div>
        </section>
      ) : null}

      {settled({ data: agenda.data, error: agenda.error, hidden: !appointmentsEnabled }, { data: handoffs.data, error: handoffs.error, hidden: false }, { data: alerts.data, error: alerts.error, hidden: false }, { data: attendanceRate.data, error: attendanceRate.error, hidden: !appointmentsEnabled }, { data: reschedules.data, error: reschedules.error, hidden: !appointmentsEnabled }) ? (
        <div className={styles.listsRow}>
          {appointmentsEnabled ? (
            <section className={styles.sectionCard} aria-label="Reuniões">
              <div className={styles.sectionHead}>
                <span className={styles.sectionTitle}>Reuniões</span>
              </div>
              <div className={styles.ring}>
                <div className={styles.ringHead}>
                  <span className={styles.ringLabel}>Taxa de comparecimento</span>
                  <span className={styles.ringIcon} style={{ color: "#4FE0B0" }}>
                    <CheckCircleIcon size={16} w={2} />
                  </span>
                </div>
                <div className={styles.ringBody}>
                  <span className={styles.ringValue}>{pctOrDash(attendanceValue)}</span>
                  <div className={styles.ringTrack}>
                    <div className={styles.ringFill} style={{ width: `${Math.min(Math.max(num(attendanceValue), 0), 100)}%`, background: "#4FE0B0" }} />
                  </div>
                  <span className={styles.ringNote}>agendamentos que viraram call</span>
                </div>
              </div>
              <div className={`${styles.ring} ${styles.ringBordered}`}>
                <div className={styles.ringHead}>
                  <span className={styles.ringLabel}>Reagendamentos</span>
                  <span className={styles.ringIcon} style={{ color: "#F5B94A" }}>
                    <CalendarIcon size={16} w={2} />
                  </span>
                </div>
                <div className={styles.ringBody}>
                  <span className={styles.ringValue}>{countText(reschedulesValue)}</span>
                  <span className={styles.ringNote}>reuniões remarcadas no período</span>
                </div>
              </div>
            </section>
          ) : null}
          {appointmentsEnabled ? (
            <section className={styles.sectionCard} aria-label="Agenda de hoje">
              <div className={styles.sectionHead}>
                <span className={styles.sectionTitle}>Agenda de hoje</span>
              </div>
              {agendaItems.length ? (
                <div className={styles.listRows}>
                  {agendaItems.slice(0, 6).map((item) => {
                    const timezone = agenda.data?.data.period?.timezone;
                    return (
                      <div key={String(item.id)} className={styles.listRow}>
                        <time className={styles.listTime}>
                          {new Date(String(item.start_at)).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", ...(timezone ? { timeZone: timezone } : {}) })}
                        </time>
                        <span className={styles.listMain}>{String(item.lead_name ?? item.lead_phone ?? "Contato")}</span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className={styles.listEmpty}>Nenhum compromisso para hoje.</p>
              )}
            </section>
          ) : null}
          <section className={styles.sectionCard} aria-label="Handoffs aguardando">
            <div className={styles.sectionHead}>
              <span className={styles.sectionTitle}>Handoffs aguardando</span>
              {handoffsData ? <span className={styles.sectionHint}>{nf.format(num(handoffsData.total))} na fila</span> : null}
            </div>
            {handoffsData && handoffsData.items.length ? (
              <div className={styles.listRows}>
                {handoffsData.items.slice(0, 4).map((item) => (
                  <div key={String(item.id)} className={styles.listRow}>
                    <span className={styles.listMain}>{String(item.contact_name ?? item.contact_phone ?? "Contato")}</span>
                    <span className={styles.listTime}>{nf.format(num(item.waiting_minutes))} min</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className={styles.listEmpty}>Nenhum handoff aguardando agora.</p>
            )}
          </section>
          <section className={styles.sectionCard} aria-label="Alertas recentes">
            <div className={styles.sectionHead}>
              <span className={styles.sectionTitle}>Alertas recentes</span>
            </div>
            {alertItems.length ? (
              <div className={styles.listRows}>
                {alertItems.slice(0, 4).map((alert) => (
                  <div key={String(alert.id)} className={styles.listRowStacked}>
                    <p className={styles.listMain}>{String(alert.message)}</p>
                    <time className={styles.listTime}>{new Date(String(alert.created_at)).toLocaleString("pt-BR")}</time>
                  </div>
                ))}
              </div>
            ) : (
              <p className={styles.listEmpty}>Nenhum alerta recente.</p>
            )}
          </section>
        </div>
      ) : null}

      {leadsEnabled && pipelineEnabled && pipelineStages.length ? (
        <section className={styles.sectionCard} aria-label="Pipeline">
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>Pipeline</span>
            <span className={styles.sectionHint}>{nf.format(pipelineStages.reduce((sum, stage) => sum + num(stage.count), 0))} leads no funil</span>
          </div>
          <div className={styles.barRows}>
            {pipelineStages.map((stage) => {
              const count = num(stage.count);
              const capacity = typeof stage.capacity_target === "number" ? stage.capacity_target : null;
              const total = pipelineStages.reduce((sum, item) => sum + num(item.count), 0);
              return (
                <div key={String(stage.id ?? stage.status)} className={styles.barRow}>
                  <div className={styles.barHead}>
                    <span className={styles.barName}>{String(stage.name ?? stage.status)}</span>
                    <span className={styles.barValue}>{nf.format(count)}{capacity ? ` / ${nf.format(capacity)}` : ""}</span>
                  </div>
                  <div className={styles.barTrack}>
                    <div className={styles.barFill} style={{ backgroundColor: String(stage.color ?? "var(--primary)"), transform: `scaleX(${capacity ? Math.min(count / capacity, 1) : total ? count / total : 0})` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {leadsEnabled && settled({ data: newLeads.data, error: newLeads.error, hidden: false }, { data: pendingFollowUps.data, error: pendingFollowUps.error, hidden: false }, { data: leadsPaid.data, error: leadsPaid.error, hidden: false }, { data: leadsReferral.data, error: leadsReferral.error, hidden: false }, { data: leadsOrganic.data, error: leadsOrganic.error, hidden: false }, { data: leadsOther.data, error: leadsOther.error, hidden: false }) ? (
        <section className={styles.sectionCard} aria-label="Origem dos leads">
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>Origem dos leads</span>
            <span className={styles.sectionHint}>como os contatos chegaram no período</span>
          </div>
          <div className={styles.sectionKpis}>{leadsKpis.map(kpiTile)}</div>
        </section>
      ) : null}

      {leadsEnabled && appointmentsEnabled && settled({ data: lostSales.data, error: lostSales.error, hidden: false }, { data: salesPaid.data, error: salesPaid.error, hidden: false }, { data: salesReferral.data, error: salesReferral.error, hidden: false }, { data: salesOrganic.data, error: salesOrganic.error, hidden: false }) ? (
        <section className={styles.sectionCard} aria-label="Vendas por origem">
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>Vendas por origem</span>
          </div>
          <div className={styles.sectionKpis}>{salesBySourceKpis.map(kpiTile)}</div>
        </section>
      ) : null}

      {appointmentsEnabled && teamMembers.length ? (
        <section className={styles.sectionCard} aria-label="Equipe">
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>Equipe</span>
            <span className={styles.sectionHint}>performance dos closers no período</span>
          </div>
          <div className={styles.tableWrap} tabIndex={0}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Closer</th>
                  <th className={styles.numeric}>Calls</th>
                  <th className={styles.numeric}>No-shows</th>
                  <th className={styles.numeric}>Vendas</th>
                  <th className={styles.numeric}>Call → Venda</th>
                  <th className={styles.numeric}>Valor vendido</th>
                </tr>
              </thead>
              <tbody>
                {teamMembers.map((member) => (
                  <tr key={String(member.member_id)}>
                    <td>
                      <strong className={styles.memberName}>{memberName(member)}</strong>
                      <span className={styles.memberStatus}>{member.availability_status === "available" ? "Disponível" : "Indisponível"}</span>
                    </td>
                    <td className={styles.numeric} style={{ color: "var(--success-text)" }}>{nf.format(num(member.completed))}</td>
                    <td className={styles.numeric} style={{ color: "var(--warning-text)" }}>{nf.format(num(member.no_show))}</td>
                    <td className={styles.numeric}>{nf.format(num(member.sales))}</td>
                    <td className={styles.numeric}>{pctText(member.closing_rate)}</td>
                    <td className={styles.numeric}>
                      <span className={styles.memberValue}>R$ {money(num(member.sold_value))}</span>
                      <span className={styles.barTrack} style={{ width: "6rem", marginInlineStart: "auto", marginBlockStart: "6px" }}>
                        <span className={styles.barFill} style={{ display: "block", background: "var(--success)", transform: `scaleX(${num(member.sold_value) / topSold})` }} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
