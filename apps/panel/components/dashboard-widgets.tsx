"use client";

import {
  ArrowCounterClockwise,
  CalendarCheck,
  CaretDown,
  CaretUp,
  Check,
  CurrencyCircleDollar,
  Handshake,
  PhoneCall,
  SlidersHorizontal,
  UserMinus,
  UsersThree,
  X,
  type Icon
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import useSWR, { useSWRConfig } from "swr";
import { Sparkline } from "@/components/commercial-dashboard-charts";
import { DashboardMetricWidget, DashboardTeamWidget, type DashboardMetricData, type DashboardTeamData } from "@/components/dashboard-metric-widget";
import { Shell } from "@/components/shell";
import {
  Button,
  Funnel,
  Input,
  KpiCard,
  KpiGrid,
  LineAreaChart,
  Segmented,
  type FunnelStage
} from "@/components/ui";
import { api } from "@/lib/api";
import { useCapabilities } from "@/lib/capabilities";
import { trendDelta, type CommercialDashboardSeries } from "@/lib/commercial-dashboard";
import { useRealtimeSignals } from "@/lib/realtime";
import styles from "./metrics-dashboard.module.css";

type WidgetKey = string;
type WidgetSize = "small" | "medium" | "wide" | "full";
type LayoutItem = { key: WidgetKey; order: number; visible: boolean; size: WidgetSize };
type WidgetGroup = string;
type WidgetDefinition = {
  key: WidgetKey;
  label: string;
  description: string;
  group?: WidgetGroup;
  sizes: WidgetSize[];
  default_size: WidgetSize;
  selectable?: boolean;
};
type CatalogResponse = { widgets: WidgetDefinition[]; default_layout: LayoutItem[] };
type LayoutResponse = { layout: { items: LayoutItem[]; source: "default" | "saved" } };
type WidgetResponse = { key: WidgetKey; data: Record<string, unknown> };

const fetcher = <T,>(url: string) => api<T>(url);
const sizeClasses: Record<WidgetSize, string> = {
  small: "col-span-12 sm:col-span-6 xl:col-span-3",
  medium: "col-span-12 sm:col-span-6 xl:col-span-4",
  wide: "col-span-12 sm:col-span-12 xl:col-span-8",
  full: "col-span-12"
};
const sizeLabels: Record<WidgetSize, string> = {
  small: "Compacto",
  medium: "Médio",
  wide: "Amplo",
  full: "Linha inteira"
};
function metric(value: unknown) {
  return typeof value === "number" ? value.toLocaleString("pt-BR") : "0";
}
function money(value: unknown) {
  return Number(value ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function percent(value: unknown) {
  if (value === null || value === undefined) return "—";
  return `${Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}
function closerName(member: Record<string, unknown>) {
  const name = typeof member.name === "string" ? member.name.trim() : "";
  return name || String(member.email ?? "").split("@")[0];
}

function WidgetSkeleton() {
  return (
    <div className={styles.widgetLoading} role="status" aria-label="Carregando widget">
      <span className={styles.widgetLoadingValue} />
      <span className={styles.widgetLoadingLine} />
      <span className={styles.widgetLoadingLineShort} />
    </div>
  );
}

function EmptyWidget({ message }: { message: string }) {
  return <p className={styles.widgetEmpty}>{message}</p>;
}

type SparkKey = "scheduled" | "completed" | "no_show";
const legend: Array<[string, string]> = [["Agendadas", "primary"], ["Realizadas", "success"], ["No-show", "warning"]];

const GROUP_LABELS: Record<string, string> = {
  atendimento: "Atendimento",
  origem: "Origem",
  agendamento: "Agendamento",
  vendas: "Vendas",
  origem_das_vendas: "Origem das vendas",
  equipe: "Equipe"
};
/* Cada grupo tem um token categórico. Essa é a ÚNICA cor de chrome do board:
   entra como fio de 1px no topo do card, não como fundo nem como badge. */
const GROUP_ACCENTS: Record<string, string> = {
  atendimento: "var(--cat-1)",
  origem: "var(--cat-5)",
  agendamento: "var(--cat-3)",
  vendas: "var(--cat-2)",
  origem_das_vendas: "var(--cat-4)",
  equipe: "var(--cat-3)"
};
const PERCENTAGE_WIDGET_KEYS = new Set(["attendance_rate", "conversion_rate", "conversion_by_seller"]);
/* Widgets cujo conteúdo (gráfico, funil, tabela) define a própria altura. */
const WIDE_WIDGET_KEYS = new Set(["commercial_metrics", "conversion_funnel", "team_load", "operations_summary", "pipeline", "today_agenda"]);

function groupTitle(group: string | undefined) {
  return GROUP_LABELS[group ?? ""] ?? group ?? "Outros";
}

function groupAccent(group: string | undefined) {
  return GROUP_ACCENTS[group ?? ""] ?? "var(--primary)";
}

function metricData(data: Record<string, unknown>): DashboardMetricData | null {
  return typeof data.value === "number" ? { value: data.value, ...(data.currency === "BRL" ? { currency: "BRL" as const } : {}) } : null;
}

function teamData(data: Record<string, unknown>): DashboardTeamData | null {
  if (!Array.isArray(data.items)) return null;
  const items = data.items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object").map((item) => ({ member_id: String(item.member_id ?? ""), name: String(item.name ?? "Membro"), value: Number(item.value ?? 0) }));
  return { items, ...(data.currency === "BRL" ? { currency: "BRL" as const } : {}) };
}

function WidgetContent({ widgetKey, data }: { widgetKey: WidgetKey; data: Record<string, unknown> }) {
  const { isEnabled } = useCapabilities();
  const newMetric = metricData(data);
  const newTeam = ["sales_by_seller", "sales_value_by_seller", "conversion_by_seller"].includes(widgetKey) ? teamData(data) : null;
  if (newTeam) return <DashboardTeamWidget data={newTeam} percentage={PERCENTAGE_WIDGET_KEYS.has(widgetKey)} />;
  if (newMetric) return <DashboardMetricWidget data={newMetric} percentage={PERCENTAGE_WIDGET_KEYS.has(widgetKey)} />;

  const leadsEnabled = isEnabled("leads_v1");
  const appointmentsEnabled = isEnabled("appointments_v1");
  if (widgetKey === "whatsapp_connection") {
    const total = Number(data.total ?? 0);
    const connectedCount = Number(data.connected ?? 0);
    const connected = total > 0 && connectedCount === total;
    const statusLabel = total > 1 ? `${connectedCount} de ${total} conectados` : total === 1 ? (connected ? "Conectado" : "Desconectado") : "Desconectado";
    const aggregateStatus = total > 1 ? (connected ? "todas conectadas" : connectedCount > 0 ? "parcial" : "nenhuma conectada") : (connected ? "connected" : "disconnected");
    return (
      <div>
        <p className={styles.statusLine}>
          <span className={styles.statusPip} data-state={connected ? "on" : "off"} aria-hidden="true" />
          <span className={styles.statusText} style={{ color: connected ? "var(--success-text)" : "var(--warning-text)" }}>{statusLabel}</span>
        </p>
        <p className={`${styles.metricCaption} mono`}>status: {aggregateStatus}</p>
      </div>
    );
  }
  if (widgetKey === "open_conversations") {
    return <div><p className={styles.metricValue}>{metric(data.open)}</p><p className={styles.metricCaption}><strong>{metric(data.ai_open)}</strong> com IA · <strong>{metric(data.resolved_today)}</strong> resolvidas hoje</p></div>;
  }
  if (widgetKey === "messages_today") {
    return <div><p className={styles.metricValue}>{metric(data.today)}</p><p className={styles.metricCaption}>recebidas e enviadas</p></div>;
  }
  if (widgetKey === "commercial_metrics") {
    const result = (data.result ?? {}) as Record<string, unknown>;
    const series = (Array.isArray(data.series) ? data.series : []) as CommercialDashboardSeries;
    const kpis: Array<{ label: string; value: string; hint: string; tone: "primary" | "success" | "warning"; icon: Icon; spark?: SparkKey }> = [
      { label: "Novos contatos", value: metric(result.new_contacts), hint: "contatos únicos no período", tone: "primary", icon: UsersThree },
      ...(appointmentsEnabled ? [
        { label: "Agendamentos", value: metric(result.appointments), hint: "reuniões marcadas", tone: "primary" as const, icon: CalendarCheck, spark: "scheduled" as SparkKey },
        { label: "Calls realizadas", value: metric(result.calls), hint: "o lead compareceu", tone: "success" as const, icon: PhoneCall, spark: "completed" as SparkKey },
        { label: "No-show", value: metric(result.no_show), hint: "o lead não compareceu", tone: "warning" as const, icon: UserMinus, spark: "no_show" as SparkKey }
      ] : []),
      { label: "Vendas", value: metric(result.sales), hint: "fechamentos registrados", tone: "success", icon: Handshake },
      { label: "Valor vendido", value: money(result.sold_value), hint: `ticket médio ${money(result.average_ticket)}`, tone: "success", icon: CurrencyCircleDollar }
    ];
    return (
      <div className={styles.widgetContent}>
        <KpiGrid>
          {kpis.map((kpi) => {
            const delta = kpi.spark ? trendDelta(series, kpi.spark) : null;
            return (
              <KpiCard
                key={kpi.label}
                label={kpi.label}
                value={kpi.value}
                hint={kpi.hint}
                tone={kpi.tone}
                icon={<kpi.icon size={16} weight="duotone" aria-hidden="true" />}
                delta={delta !== null ? { value: delta, label: "Segunda metade do período comparada à primeira" } : null}
                spark={kpi.spark ? <Sparkline values={series.map((item) => item[kpi.spark as SparkKey])} tone={`var(--${kpi.tone})`} className="h-14 w-full" /> : null}
              />
            );
          })}
        </KpiGrid>
        {series.length > 1 ? (
          <section className={styles.widgetChart} aria-label="Evolução no período">
            <div className={styles.chartLegend}>
              {legend.map(([label, tone]) => (
                <span key={label} className={styles.legendItem}><span className={styles.legendDot} style={{ backgroundColor: `var(--${tone})` }} aria-hidden="true" />{label}</span>
              ))}
            </div>
            <LineAreaChart
              ariaLabel="Evolução de reuniões marcadas, realizadas e não comparecidas"
              height={230}
              data={series.map((item) => ({ x: item.day, scheduled: item.scheduled, completed: item.completed, no_show: item.no_show }))}
              series={[
                { key: "scheduled", label: "Agendadas", tone: "primary" },
                { key: "completed", label: "Realizadas", tone: "success" },
                { key: "no_show", label: "No-show", tone: "warning" }
              ]}
              xLabelFormatter={(value) => new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(new Date(`${value}T12:00:00.000Z`))}
            />
          </section>
        ) : null}
      </div>
    );
  }
  if (widgetKey === "conversion_funnel") {
    const funnel = (data.funnel ?? {}) as Record<string, unknown>;
    const result = (data.result ?? {}) as Record<string, unknown>;
    const due = Number(result.due_meetings ?? 0);
    const stages: FunnelStage[] = [
      { label: "Novos contatos", value: Number(result.new_contacts ?? 0), tone: "primary" },
      { label: "Agendamentos", value: Number(result.appointments ?? 0), tone: "primary", conversionLabel: `Lead → Agendamento · ${percent(funnel.lead_to_appointment)}` },
      { label: "Calls realizadas", value: Number(result.calls ?? 0), tone: "success", conversionLabel: `Agendamento → Comparecimento · ${percent(funnel.appointment_to_attendance)}` },
      { label: "Vendas", value: Number(result.sales ?? 0), tone: "success", conversionLabel: `Call → Venda · ${percent(funnel.call_to_sale)}` }
    ];
    return (
      <div className={styles.funnelLayout}>
        <Funnel stages={stages} height={220} ariaLabel="Funil de conversão: contatos, agendamentos, calls e vendas" />
        <dl className={styles.funnelSide}>
          <div className={styles.funnelStat}>
            <dt className={styles.funnelStatLabel}>Lead → Venda</dt>
            <dd className={styles.funnelStatValue}>{percent(funnel.lead_to_sale ?? 0)}</dd>
            <p className={styles.funnelStatHint}>conversão ponta a ponta do período</p>
          </div>
          <div className={styles.funnelStat}>
            <dt className={styles.funnelStatLabel}>Taxa de no-show</dt>
            <dd className={styles.funnelStatValue} data-tone="warning">{percent(funnel.no_show_rate ?? 0)}</dd>
            <p className={styles.funnelStatHint}>sobre {metric(due)} reunião(ões) já vencida(s)</p>
          </div>
        </dl>
      </div>
    );
  }
  if (widgetKey === "operations_summary") {
    const operations = (data.operations ?? {}) as Record<string, unknown>;
    const firstResponse = operations.average_first_response_minutes;
    const entries: Array<[string, string]> = [
      ["Mensagens recebidas", metric(operations.inbound_messages)],
      ["Conversas abertas (agora)", metric(operations.open_conversations)],
      ["Handoffs", metric(operations.handoffs)],
      ["Tempo médio 1ª resposta", firstResponse == null ? "—" : `${metric(firstResponse)} min`],
      ["Follow-ups atrasados", metric(operations.overdue_follow_ups)],
      ...(leadsEnabled ? [["Leads sem responsável", metric(operations.unassigned_leads)] as [string, string]] : [])
    ];
    return (
      <dl className={styles.statGrid}>
        {entries.map(([label, value]) => (
          <div key={label} className={styles.statTile}>
            <dt className={styles.statLabel}>{label}</dt>
            <dd className={styles.statValue}>{value}</dd>
          </div>
        ))}
      </dl>
    );
  }
  if (widgetKey === "handoffs") {
    const items = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : [];
    if (!items.length) return <EmptyWidget message="Nenhum handoff aguardando agora." />;
    return (
      <div>
        <p className={styles.metricValue} data-tone="warning">{metric(data.total)}</p>
        <div className={styles.rows}>
          {items.slice(0, 4).map((item) => (
            <div key={String(item.id)} className={styles.row}>
              <span className={styles.rowLabel}>{String(item.contact_name ?? item.contact_phone ?? "Contato")}</span>
              <span className={styles.rowValue}>{metric(item.waiting_minutes)} min</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (widgetKey === "today_agenda") {
    const items = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : [];
    const period = (data.period ?? {}) as Record<string, unknown>;
    const timezone = typeof period.timezone === "string" ? period.timezone : undefined;
    if (!items.length) return <EmptyWidget message="Nenhum compromisso para hoje." />;
    return (
      <div className={styles.rows}>
        {items.slice(0, 6).map((item) => (
          <div key={String(item.id)} className={styles.agendaRow}>
            <time className={styles.agendaTime}>{new Date(String(item.start_at)).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", ...(timezone ? { timeZone: timezone } : {}) })}</time>
            <span className={styles.rowLabel}>{String(item.lead_name ?? item.lead_phone ?? "Contato")}</span>
          </div>
        ))}
      </div>
    );
  }
  if (widgetKey === "team_load") {
    const members = Array.isArray(data.members) ? data.members as Array<Record<string, unknown>> : [];
    if (!members.length) return <EmptyWidget message="Nenhum closer no pool de distribuição." />;
    const ranked = [...members].sort((a, b) => Number(b.sold_value ?? 0) - Number(a.sold_value ?? 0));
    const topSold = Math.max(...ranked.map((member) => Number(member.sold_value ?? 0)), 1);
    return (
      <div className={styles.tableWrap} tabIndex={0} aria-label="Performance por closer">
        <table className={styles.widgetTable}>
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
            {ranked.map((member) => (
              <tr key={String(member.member_id)}>
                <td>
                  <strong className="block max-w-56 truncate font-medium">{closerName(member)}</strong>
                  <span className={styles.statLabel}>{member.availability_status === "available" ? "Disponível" : "Indisponível"}</span>
                </td>
                <td className={styles.numeric} style={{ color: "var(--success-text)" }}>{metric(member.completed)}</td>
                <td className={styles.numeric} style={{ color: "var(--warning-text)" }}>{metric(member.no_show)}</td>
                <td className={styles.numeric}>{metric(member.sales)}</td>
                <td className={styles.numeric}>{percent(member.closing_rate)}</td>
                <td className={styles.numeric}>
                  <span className="block font-semibold">{money(member.sold_value)}</span>
                  <span className={styles.barTrack} style={{ width: "6rem", marginInlineStart: "auto", marginBlockStart: "var(--space-1)" }}>
                    <span className={styles.barFill} style={{ display: "block", background: "var(--success)", transform: `scaleX(${Number(member.sold_value ?? 0) / topSold})` }} />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (widgetKey === "pipeline") {
    const stages = Array.isArray(data.stages) ? data.stages as Array<Record<string, unknown>> : [];
    if (!stages.length) return <EmptyWidget message="Nenhum lead no Pipeline." />;
    const total = stages.reduce((sum, stage) => sum + Number(stage.count ?? 0), 0);
    return (
      <div>
        {stages.map((stage) => {
          const count = Number(stage.count ?? 0);
          const capacity = typeof stage.capacity_target === "number" ? stage.capacity_target : null;
          return (
            <div key={String(stage.id ?? stage.status)} className={styles.barRow}>
              <div className={styles.barHead}>
                <span className={styles.barName}>{String(stage.name ?? stage.status)}</span>
                <span className={styles.barValue}>{count}{capacity ? ` / ${capacity}` : ""}</span>
              </div>
              <div className={styles.barTrack}>
                <div className={styles.barFill} style={{ backgroundColor: String(stage.color ?? "var(--primary)"), transform: `scaleX(${capacity ? Math.min(count / capacity, 1) : total ? count / total : 0})` }} />
              </div>
            </div>
          );
        })}
      </div>
    );
  }
  const alerts = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : [];
  if (!alerts.length) return <EmptyWidget message="Nenhum alerta recente." />;
  return (
    <div className={styles.rows}>
      {alerts.map((alert) => (
        <div key={String(alert.id)} className={styles.row} style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
          <p className={styles.rowLabel} style={{ whiteSpace: "normal" }}>{String(alert.message)}</p>
          <time className={`${styles.rowValue} block`}>{new Date(String(alert.created_at)).toLocaleString("pt-BR")}</time>
        </div>
      ))}
    </div>
  );
}

function WidgetCard({ item, definition, periodQuery, index }: { item: LayoutItem; definition: WidgetDefinition; periodQuery: string; index: number }) {
  const { data, error, mutate, isLoading } = useSWR<WidgetResponse>(
    `/dashboard/widgets/${item.key}?${periodQuery}`,
    fetcher,
    { refreshInterval: 15_000, revalidateOnFocus: true }
  );
  const accent = groupAccent(definition.group);
  return (
    <section
      className={`${sizeClasses[item.size]} ${styles.widgetCard}`}
      aria-busy={isLoading}
      data-wide={WIDE_WIDGET_KEYS.has(item.key) ? "true" : "false"}
      // A descrição saiu da superfície: continua acessível como tooltip nativo.
      title={definition.description}
      style={{ "--dash-accent": accent, "--dash-index": index } as CSSProperties}
    >
      <div className={styles.widgetHeader}>
        <h2 className={styles.widgetTitle}>{definition.label}</h2>
        <span className={styles.widgetDot} aria-hidden="true" />
      </div>
      <div className={styles.widgetBody}>
        {error ? (
          <div role="alert" className={styles.widgetError}>
            <p className="error">Este widget não pôde carregar.</p>
            <Button tone="quiet" size="sm" onClick={() => void mutate()}>Tentar novamente</Button>
          </div>
        ) : !data ? <WidgetSkeleton /> : <WidgetContent widgetKey={item.key} data={data.data} />}
      </div>
    </section>
  );
}

const PERIOD_OPTIONS: Array<[string, string]> = [["today", "Hoje"], ["week", "Semana"], ["month", "Mês"], ["custom", "Período"]];

export function DashboardWidgets() {
  const { isEnabled } = useCapabilities();
  const leadsEnabled = isEnabled("leads_v1");
  const pipelineEnabled = isEnabled("pipeline_v1");
  const appointmentsEnabled = isEnabled("appointments_v1");
  const today = new Date().toISOString().slice(0, 10);
  const [editing, setEditing] = useState(false);
  const [period, setPeriod] = useState("today");
  const [customStart, setCustomStart] = useState(today);
  const [customEnd, setCustomEnd] = useState(today);
  const [draft, setDraft] = useState<LayoutItem[]>([]);
  const [saving, setSaving] = useState(false);
  const { mutate: mutateCache } = useSWRConfig();
  const { data: catalog, error: catalogError } = useSWR<CatalogResponse>("/dashboard/widgets/catalog", fetcher);
  const { data: layout, error: layoutError, mutate: mutateLayout } = useSWR<LayoutResponse>("/dashboard/widgets/layout", fetcher);

  useEffect(() => { if (layout) setDraft(layout.layout.items); }, [layout]);
  const definitions = useMemo(() => new Map(catalog?.widgets.map((widget) => [widget.key, widget]) ?? []), [catalog]);
  const widgetAvailable = (key: WidgetKey) => {
    if (key === "pipeline") return leadsEnabled && pipelineEnabled;
    if (["today_agenda", "team_load", "conversion_funnel"].includes(key)) return appointmentsEnabled;
    return true;
  };
  const availableDraft = draft.filter((item) => widgetAvailable(item.key));
  const visible = availableDraft.filter((item) => item.visible).sort((a, b) => a.order - b.order);
  // O board é um fluxo contínuo de cards: os grupos continuam ordenando o
  // layout, mas não viram faixas de título. Uma linha de texto entre cada
  // bloco quebrava a grade em pedaços e empurrava o dado para baixo da dobra —
  // o grupo já se lê na cor do fio de acento e no rótulo de cada card.
  const boardItems = visible.map((item) => ({ item, definition: definitions.get(item.key) }));
  const groupedDraft = useMemo(() => {
    const groups = new Map<string, LayoutItem[]>();
    [...availableDraft].sort((a, b) => a.order - b.order).forEach((item) => {
      const definition = definitions.get(item.key);
      if (definition?.selectable === false) return;
      const group = definition?.group ?? "outros";
      groups.set(group, [...(groups.get(group) ?? []), item]);
    });
    return [...groups.entries()];
  }, [availableDraft, definitions]);
  // Um único filtro alimenta todos os widgets: eles recalculam juntos.
  const periodQuery = period === "custom"
    ? `period=custom&start=${encodeURIComponent(customStart)}&end=${encodeURIComponent(customEnd)}`
    : `period=${period}`;
  const periodSummary = period === "custom"
    ? `${new Date(`${customStart}T12:00:00.000Z`).toLocaleDateString("pt-BR", { timeZone: "UTC" })} — ${new Date(`${customEnd}T12:00:00.000Z`).toLocaleDateString("pt-BR", { timeZone: "UTC" })}`
    : PERIOD_OPTIONS.find(([key]) => key === period)?.[1] ?? "Hoje";

  useRealtimeSignals({
    onCatchUp: () => { if (document.visibilityState === "visible") void mutateCache((key) => typeof key === "string" && key.startsWith("/dashboard/widgets/")); },
    onSignal: (signal) => {
      if (document.visibilityState === "visible" && (signal.type === "appointment.changed" || signal.type === "case.assignment.changed")) {
        void mutateCache((key) => typeof key === "string" && key.startsWith("/dashboard/widgets/"));
      }
    }
  });

  function patchItem(key: WidgetKey, patch: Partial<LayoutItem>) {
    setDraft((current) => current.map((item) => item.key === key ? { ...item, ...patch } : item));
  }
  function move(key: WidgetKey, direction: -1 | 1) {
    setDraft((current) => {
      const ordered = [...current].sort((a, b) => a.order - b.order);
      const index = ordered.findIndex((item) => item.key === key);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= ordered.length) return current;
      [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
      return ordered.map((item, order) => ({ ...item, order }));
    });
  }
  async function save() {
    setSaving(true);
    try {
      const response = await api<LayoutResponse>("/dashboard/widgets/layout", { method: "PUT", body: JSON.stringify({ items: draft }) });
      await mutateLayout(response, { revalidate: false });
      setEditing(false);
    } finally { setSaving(false); }
  }
  async function reset() {
    setSaving(true);
    try {
      const response = await api<LayoutResponse>("/dashboard/widgets/layout", { method: "DELETE" });
      await mutateLayout(response, { revalidate: false });
    } finally { setSaving(false); }
  }
  async function applyPreset(key: "essencial" | "comercial" | "gestao_completa") {
    setSaving(true);
    try {
      const response = await api<{ items: LayoutItem[] }>(`/dashboard/widgets/presets/${key}`, { method: "POST" });
      const nextLayout: LayoutResponse = { layout: { items: response.items, source: "saved" } };
      await mutateLayout(nextLayout, { revalidate: true });
      setDraft(response.items);
    } finally { setSaving(false); }
  }

  return (
    <Shell>
      <div className={styles.pageFrame}>
        {/* Toolbar única: título, período e ações na mesma linha, grudada no
            topo ao rolar. Antes eram um PageHeader alto com descrição + uma
            fileira de controles — duas linhas de chrome antes do primeiro dado. */}
        <header className={styles.toolbar}>
          <div className={styles.toolbarTitle}>
            <h1>Visão geral</h1>
            <span className={styles.toolbarPeriod}>{periodSummary}</span>
          </div>
          <div className={styles.toolbarActions}>
            <Segmented aria-label="Período">
              {PERIOD_OPTIONS.map(([key, label]) => (
                <button key={key} type="button" aria-pressed={period === key} onClick={() => setPeriod(key)}>{label}</button>
              ))}
            </Segmented>
            {period === "custom" ? (
              <div className={styles.toolbarDates}>
                <label className="sr-only" htmlFor="dashboard-start">Data inicial</label>
                <Input id="dashboard-start" type="date" value={customStart} max={customEnd} onChange={(event) => { setCustomStart(event.target.value); if (customEnd < event.target.value) setCustomEnd(event.target.value); }} />
                <label className="sr-only" htmlFor="dashboard-end">Data final</label>
                <Input id="dashboard-end" type="date" value={customEnd} min={customStart} onChange={(event) => setCustomEnd(event.target.value)} />
              </div>
            ) : null}
            <Button tone="quiet" icon={editing ? <X size={17} /> : <SlidersHorizontal size={17} />} onClick={() => setEditing((value) => !value)}>{editing ? "Fechar" : "Personalizar"}</Button>
          </div>
        </header>

        {editing && catalog ? <section className={styles.widgetLibrary} aria-label="Configurar dashboard">
          <div className={styles.libraryHead}>
            <div>
              <h2 className="type-section-title">Biblioteca de widgets</h2>
              <p className="sub">A ordem e o tamanho se adaptam automaticamente em telas menores — um widget &ldquo;Amplo&rdquo; também vira coluna única no celular.</p>
            </div>
            <div className="cluster">
              <Button tone="quiet" icon={<ArrowCounterClockwise size={17} />} disabled={saving} onClick={() => void reset()}>Restaurar padrão</Button>
              <Button tone="primary" icon={<Check size={17} />} disabled={saving} onClick={() => void save()}>{saving ? "Salvando" : "Salvar"}</Button>
            </div>
          </div>
          <div className={styles.libraryPresets} aria-label="Presets do dashboard">
            {([["essencial", "Essencial"], ["comercial", "Comercial"], ["gestao_completa", "Gestão completa"]] as const).map(([key, label]) => <button key={key} className="btn secondary active:scale-[0.98]" disabled={saving} onClick={() => void applyPreset(key)}>{label}</button>)}
            <button className="btn secondary active:scale-[0.98]" disabled={saving} onClick={() => setEditing(true)}>Personalizado</button>
          </div>
          <div className={styles.libraryGroups}>{groupedDraft.map(([group, items]) => <section key={group} aria-labelledby={`dashboard-group-${group}`}><h3 id={`dashboard-group-${group}`} className={styles.libraryGroupTitle}>{groupTitle(group)}</h3>{items.map((item) => { const definition = definitions.get(item.key); if (!definition) return null; return <div key={item.key} className={`${styles.libraryItem} md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center`}><label className={styles.libraryItemLabel}><input type="checkbox" checked={item.visible} onChange={(event) => patchItem(item.key, { visible: event.target.checked })} className="mt-1" /><span><strong className={styles.libraryItemName}>{definition.label}</strong><span className={styles.libraryItemHint}>{definition.description}</span></span></label><label className={styles.libraryItemSize}><span>Tamanho</span><select className="input w-auto" value={item.size} onChange={(event) => patchItem(item.key, { size: event.target.value as WidgetSize })}>{definition.sizes.map((size) => <option key={size} value={size}>{sizeLabels[size]}</option>)}</select></label><div className={styles.libraryItemMove}><Button tone="quiet" className="min-h-11 min-w-11 px-2" disabled={item.order === 0} aria-label={`Mover ${definition.label} para cima`} title="Mover para cima" onClick={() => move(item.key, -1)}><CaretUp size={17} /></Button><Button tone="quiet" className="min-h-11 min-w-11 px-2" disabled={item.order === availableDraft.length - 1} aria-label={`Mover ${definition.label} para baixo`} title="Mover para baixo" onClick={() => move(item.key, 1)}><CaretDown size={17} /></Button></div></div>; })}</section>)}</div>
        </section> : null}

        {catalogError || layoutError ? <div className="card" role="alert"><p className="error">Não foi possível carregar a configuração do dashboard.</p></div> : !catalog || !layout ? <div className={`${styles.widgets} grid grid-cols-12 gap-4`}>{[0, 1, 2, 3].map((index) => <div key={index} className={`${sizeClasses.small} ${styles.widgetCard}`} style={{ "--dash-index": index } as CSSProperties}><WidgetSkeleton /></div>)}</div> : !visible.length ? <div className="card"><EmptyWidget message="Nenhum widget está visível. Abra Personalizar para escolher o que acompanhar." /></div> : <section className={`${styles.widgets} grid grid-cols-12 gap-4`} aria-label="Widgets do dashboard">{boardItems.map(({ item, definition }, index) => definition ? <WidgetCard key={item.key} item={item} definition={definition} periodQuery={periodQuery} index={index} /> : null)}</section>}
      </div>
    </Shell>
  );
}
