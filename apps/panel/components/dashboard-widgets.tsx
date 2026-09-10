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
  TrendDown,
  TrendUp,
  UserMinus,
  UsersThree,
  X,
  type Icon
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { RateRing, Sparkline, TrendChart } from "@/components/commercial-dashboard-charts";
import { Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { useCapabilities } from "@/lib/capabilities";
import { trendDelta, type CommercialDashboardSeries } from "@/lib/commercial-dashboard";
import { useRealtimeSignals } from "@/lib/realtime";

type WidgetKey =
  | "commercial_metrics"
  | "conversion_funnel"
  | "operations_summary"
  | "whatsapp_connection"
  | "handoffs"
  | "open_conversations"
  | "messages_today"
  | "today_agenda"
  | "team_load"
  | "pipeline"
  | "recent_alerts";
type WidgetSize = "small" | "medium" | "wide" | "full";
type LayoutItem = { key: WidgetKey; order: number; visible: boolean; size: WidgetSize };
type WidgetDefinition = {
  key: WidgetKey;
  label: string;
  description: string;
  sizes: WidgetSize[];
  default_size: WidgetSize;
};
type CatalogResponse = { widgets: WidgetDefinition[]; default_layout: LayoutItem[] };
type LayoutResponse = { layout: { items: LayoutItem[]; source: "default" | "saved" } };
type WidgetResponse = { key: WidgetKey; data: Record<string, unknown> };

const fetcher = <T,>(url: string) => api<T>(url);
const sizeClasses: Record<WidgetSize, string> = {
  small: "col-span-12 sm:col-span-6 xl:col-span-3",
  medium: "col-span-12 md:col-span-6 xl:col-span-4",
  wide: "col-span-12 xl:col-span-8",
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
    <div className="space-y-3" role="status" aria-label="Carregando widget">
      <div className="h-8 w-24 animate-pulse rounded-lg bg-[var(--panel-raised)]" />
      <div className="h-3 w-3/4 animate-pulse rounded bg-[var(--panel-raised)]" />
      <div className="h-3 w-1/2 animate-pulse rounded bg-[var(--panel-raised)]" />
    </div>
  );
}

function EmptyWidget({ message }: { message: string }) {
  return <p className="py-6 text-sm text-[var(--muted)]">{message}</p>;
}

type SparkKey = "scheduled" | "completed" | "no_show";
const legend: Array<[string, string]> = [["Agendadas", "var(--accent)"], ["Realizadas", "var(--ok)"], ["No-show", "var(--warn)"]];

function KpiTile({ label, value, hint, tone, icon: TileIcon, spark, series }: {
  label: string; value: string; hint: string; tone: string; icon: Icon; spark?: SparkKey; series: CommercialDashboardSeries;
}) {
  const delta = spark ? trendDelta(series, spark) : null;
  return (
    <div className="flex flex-col justify-between gap-3 bg-[var(--panel)] p-4 transition-colors duration-200 hover:bg-[var(--panel-raised)]">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[10px] uppercase tracking-[.12em] text-[var(--faint-text)]">{label}</p>
        <TileIcon size={16} weight="duotone" aria-hidden="true" style={{ color: tone }} />
      </div>
      <div>
        <div className="flex flex-wrap items-end gap-x-2 gap-y-1">
          <span className="mono text-[22px] font-semibold leading-none tracking-[-.03em] tabular-nums" style={{ color: tone }}>{value}</span>
          {delta !== null ? (
            <span className={`mono inline-flex items-center gap-0.5 text-[11px] font-semibold ${delta >= 0 ? "text-[var(--ok)]" : "text-[var(--warn)]"}`} title="Segunda metade do período comparada à primeira">
              {delta >= 0 ? <TrendUp size={12} weight="bold" aria-hidden="true" /> : <TrendDown size={12} weight="bold" aria-hidden="true" />}
              {percent(Math.abs(delta))}
            </span>
          ) : null}
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-[var(--muted)]">{hint}</p>
      </div>
      {spark ? <Sparkline values={series.map((item) => item[spark])} tone={tone} className="-mb-1 h-8 w-full" /> : null}
    </div>
  );
}

function WidgetContent({ widgetKey, data }: { widgetKey: WidgetKey; data: Record<string, unknown> }) {
  const { isEnabled } = useCapabilities();
  const leadsEnabled = isEnabled("leads_v1");
  const appointmentsEnabled = isEnabled("appointments_v1");
  if (widgetKey === "whatsapp_connection") {
    const total = Number(data.total ?? 0);
    const connectedCount = Number(data.connected ?? 0);
    const connected = total > 0 && connectedCount === total;
    const statusLabel = total > 1 ? `${connectedCount} de ${total} conectados` : total === 1 ? (connected ? "Conectado" : "Desconectado") : "Desconectado";
    const aggregateStatus = total > 1 ? (connected ? "todas conectadas" : connectedCount > 0 ? "parcial" : "nenhuma conectada") : (connected ? "connected" : "disconnected");
    return <div><p className={connected ? "metric accent" : "metric warning"}>{statusLabel}</p><p className="sub mono">status: {aggregateStatus}</p></div>;
  }
  if (widgetKey === "open_conversations") {
    return <div><p className="metric">{metric(data.open)}</p><p className="sub">{metric(data.ai_open)} com IA · {metric(data.resolved_today)} resolvidas hoje</p></div>;
  }
  if (widgetKey === "messages_today") {
    return <div><p className="metric">{metric(data.today)}</p><p className="sub">mensagens recebidas e enviadas</p></div>;
  }
  if (widgetKey === "commercial_metrics") {
    const result = (data.result ?? {}) as Record<string, unknown>;
    const series = (Array.isArray(data.series) ? data.series : []) as CommercialDashboardSeries;
    const kpis: Array<{ label: string; value: string; hint: string; tone: string; icon: Icon; spark?: SparkKey }> = [
      { label: "Novos contatos", value: metric(result.new_contacts), hint: "contatos únicos no período", tone: "var(--accent)", icon: UsersThree },
      ...(appointmentsEnabled ? [
        { label: "Agendamentos", value: metric(result.appointments), hint: "reuniões marcadas", tone: "var(--accent)", icon: CalendarCheck, spark: "scheduled" as SparkKey },
        { label: "Calls realizadas", value: metric(result.calls), hint: "o lead compareceu", tone: "var(--ok)", icon: PhoneCall, spark: "completed" as SparkKey },
        { label: "No-show", value: metric(result.no_show), hint: "o lead não compareceu", tone: "var(--warn)", icon: UserMinus, spark: "no_show" as SparkKey }
      ] : []),
      { label: "Vendas", value: metric(result.sales), hint: "fechamentos registrados", tone: "var(--ok)", icon: Handshake },
      { label: "Valor vendido", value: money(result.sold_value), hint: `ticket médio ${money(result.average_ticket)}`, tone: "var(--ok)", icon: CurrencyCircleDollar }
    ];
    return (
      <div className="space-y-5">
        <div className="grid gap-px overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
          {kpis.map((kpi) => <KpiTile key={kpi.label} {...kpi} series={series} />)}
        </div>
        {series.length > 1 ? (
          <section className="rounded-xl border border-[var(--border)] p-4" aria-label="Evolução no período">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">Evolução no período</h3>
              <div className="flex flex-wrap gap-4 text-[11px] text-[var(--muted)]">
                {legend.map(([label, color]) => (
                  <span key={label} className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />{label}</span>
                ))}
              </div>
            </div>
            <TrendChart data={series} />
          </section>
        ) : null}
      </div>
    );
  }
  if (widgetKey === "conversion_funnel") {
    const funnel = (data.funnel ?? {}) as Record<string, unknown>;
    const result = (data.result ?? {}) as Record<string, unknown>;
    const due = Number(result.due_meetings ?? 0);
    const stages: Array<{ label: string; value: number; color: string; step: string | null; rate: unknown }> = [
      { label: "Novos contatos", value: Number(result.new_contacts ?? 0), color: "var(--accent)", step: null, rate: null },
      { label: "Agendamentos", value: Number(result.appointments ?? 0), color: "var(--accent)", step: "Lead → Agendamento", rate: funnel.lead_to_appointment },
      { label: "Calls realizadas", value: Number(result.calls ?? 0), color: "var(--ok)", step: "Agendamento → Comparecimento", rate: funnel.appointment_to_attendance },
      { label: "Vendas", value: Number(result.sales ?? 0), color: "var(--ok)", step: "Call → Venda", rate: funnel.call_to_sale }
    ];
    const top = Math.max(...stages.map((stage) => stage.value), 1);
    return (
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_15rem]">
        <div>
          {stages.map((stage) => (
            <div key={stage.label}>
              {stage.step ? (
                <div className="flex flex-wrap items-center justify-center gap-x-2 py-2 text-[11px] text-[var(--faint-text)]">
                  <CaretDown size={12} aria-hidden="true" />
                  <span>{stage.step}</span>
                  <strong className="mono text-[var(--heading)]">{percent(stage.rate)}</strong>
                </div>
              ) : null}
              <div
                className="mx-auto flex min-w-0 items-center justify-between gap-3 rounded-xl border px-4 py-3 transition-[width] duration-500"
                style={{
                  width: `${Math.round(46 + (stage.value / top) * 54)}%`,
                  borderColor: `color-mix(in srgb, ${stage.color} 30%, transparent)`,
                  background: `linear-gradient(90deg, color-mix(in srgb, ${stage.color} 18%, transparent), color-mix(in srgb, ${stage.color} 6%, transparent))`
                }}
              >
                <span className="truncate text-sm">{stage.label}</span>
                <strong className="mono flex-none text-base tabular-nums" style={{ color: stage.color }}>{metric(stage.value)}</strong>
              </div>
            </div>
          ))}
        </div>
        <dl className="grid grid-cols-1 gap-3 self-start sm:grid-cols-2 xl:grid-cols-1">
          <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] p-3">
            <RateRing value={Number(funnel.lead_to_sale ?? 0)} tone="var(--accent)" />
            <div className="min-w-0">
              <dt className="text-[10px] uppercase tracking-[.1em] text-[var(--faint-text)]">Lead → Venda</dt>
              <dd className="mt-1 text-[11px] leading-snug text-[var(--muted)]">conversão ponta a ponta do período</dd>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] p-3">
            <RateRing value={Number(funnel.no_show_rate ?? 0)} tone="var(--warn)" />
            <div className="min-w-0">
              <dt className="text-[10px] uppercase tracking-[.1em] text-[var(--faint-text)]">Taxa de no-show</dt>
              <dd className="mt-1 text-[11px] leading-snug text-[var(--muted)]">sobre {metric(due)} reunião(ões) já vencida(s)</dd>
            </div>
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
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {entries.map(([label, value]) => (
          <div key={label} className="rounded-xl bg-[var(--panel-raised)] px-3 py-2.5">
            <dt className="text-[11px] leading-snug text-[var(--faint-text)]">{label}</dt>
            <dd className="mono mt-1.5 text-lg font-semibold tabular-nums text-[var(--body)]">{value}</dd>
          </div>
        ))}
      </dl>
    );
  }
  if (widgetKey === "handoffs") {
    const items = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : [];
    if (!items.length) return <EmptyWidget message="Nenhum handoff aguardando agora." />;
    return <div className="space-y-3"><p className="font-mono text-2xl font-semibold text-[var(--warn)]">{metric(data.total)}</p>{items.slice(0, 4).map((item) => <div key={String(item.id)} className="flex items-center justify-between gap-3 border-t border-[var(--border)] pt-3 text-sm"><span className="truncate">{String(item.contact_name ?? item.contact_phone ?? "Contato")}</span><span className="mono text-[var(--muted)]">{metric(item.waiting_minutes)} min</span></div>)}</div>;
  }
  if (widgetKey === "today_agenda") {
    const items = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : [];
    const period = (data.period ?? {}) as Record<string, unknown>;
    const timezone = typeof period.timezone === "string" ? period.timezone : undefined;
    if (!items.length) return <EmptyWidget message="Nenhum compromisso para hoje." />;
    return <div className="divide-y divide-[var(--border)]">{items.slice(0, 6).map((item) => <div key={String(item.id)} className="grid grid-cols-[5rem_1fr] gap-3 py-3 text-sm"><time className="mono text-[var(--accent)]">{new Date(String(item.start_at)).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", ...(timezone ? { timeZone: timezone } : {}) })}</time><span className="truncate">{String(item.lead_name ?? item.lead_phone ?? "Contato")}</span></div>)}</div>;
  }
  if (widgetKey === "team_load") {
    const members = Array.isArray(data.members) ? data.members as Array<Record<string, unknown>> : [];
    if (!members.length) return <EmptyWidget message="Nenhum closer no pool de distribuição." />;
    const ranked = [...members].sort((a, b) => Number(b.sold_value ?? 0) - Number(a.sold_value ?? 0));
    const topSold = Math.max(...ranked.map((member) => Number(member.sold_value ?? 0)), 1);
    return (
      <div className="overflow-x-auto" tabIndex={0} aria-label="Performance por closer">
        <table className="w-full min-w-[620px] text-left text-sm">
          <thead className="border-b border-[var(--border)] text-[10px] uppercase tracking-[.08em] text-[var(--faint)]">
            <tr>
              <th className="pb-2 font-medium">Closer</th>
              <th className="pb-2 text-right font-medium">Calls</th>
              <th className="pb-2 text-right font-medium">No-shows</th>
              <th className="pb-2 text-right font-medium">Vendas</th>
              <th className="pb-2 text-right font-medium">Call → Venda</th>
              <th className="pb-2 text-right font-medium">Valor vendido</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {ranked.map((member) => (
              <tr key={String(member.member_id)}>
                <td className="py-3">
                  <strong className="block max-w-56 truncate font-medium">{closerName(member)}</strong>
                  <span className="text-[10px] text-[var(--faint)]">{member.availability_status === "available" ? "Disponível" : "Indisponível"}</span>
                </td>
                <td className="mono py-3 text-right tabular-nums text-[var(--ok)]">{metric(member.completed)}</td>
                <td className="mono py-3 text-right tabular-nums text-[var(--warn)]">{metric(member.no_show)}</td>
                <td className="mono py-3 text-right tabular-nums">{metric(member.sales)}</td>
                <td className="mono py-3 text-right tabular-nums">{percent(member.closing_rate)}</td>
                <td className="py-3 text-right">
                  <span className="mono block font-semibold tabular-nums">{money(member.sold_value)}</span>
                  <span className="mt-1.5 ml-auto block h-1 w-24 overflow-hidden rounded-full bg-[var(--panel-raised)]">
                    <span className="block h-full rounded-full bg-[var(--ok)] transition-[width] duration-500" style={{ width: `${(Number(member.sold_value ?? 0) / topSold) * 100}%` }} />
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
    return <div className="space-y-3">{stages.map((stage) => { const count = Number(stage.count ?? 0); const capacity = typeof stage.capacity_target === "number" ? stage.capacity_target : null; return <div key={String(stage.id ?? stage.status)}><div className="mb-1 flex justify-between gap-4 text-sm"><span>{String(stage.name ?? stage.status)}</span><span className="mono">{count}{capacity ? ` / ${capacity}` : ""}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-[var(--panel-raised)]"><div className="h-full origin-left transition-transform duration-300" style={{ backgroundColor: String(stage.color ?? "var(--accent)"), transform: `scaleX(${capacity ? Math.min(count / capacity, 1) : total ? count / total : 0})` }} /></div></div>; })}</div>;
  }
  const alerts = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : [];
  if (!alerts.length) return <EmptyWidget message="Nenhum alerta recente." />;
  return <div className="divide-y divide-[var(--border)]">{alerts.map((alert) => <div key={String(alert.id)} className="py-3 text-sm"><p>{String(alert.message)}</p><time className="mono text-xs text-[var(--muted)]">{new Date(String(alert.created_at)).toLocaleString("pt-BR")}</time></div>)}</div>;
}

function WidgetCard({ item, definition, periodQuery }: { item: LayoutItem; definition: WidgetDefinition; periodQuery: string }) {
  const { data, error, mutate, isLoading } = useSWR<WidgetResponse>(
    `/dashboard/widgets/${item.key}?${periodQuery}`,
    fetcher,
    { refreshInterval: 15_000, revalidateOnFocus: true }
  );
  return (
    <article className={`${sizeClasses[item.size]} card min-h-44 transition-colors duration-300 hover:border-[var(--strong)]`} aria-busy={isLoading}>
      <div className="cardtitle mb-5 items-start"><div><span className="text-[13.5px] font-semibold tracking-[-.01em]">{definition.label}</span><p className="mt-1 text-xs font-normal normal-case tracking-normal text-[var(--muted)]">{definition.description}</p></div></div>
      {error ? <div role="alert" className="rounded-xl border border-[var(--danger)]/30 p-4"><p className="text-sm text-[var(--danger)]">Este widget não pôde carregar.</p><button className="btn secondary mt-3 active:scale-[0.98]" onClick={() => void mutate()}>Tentar novamente</button></div> : !data ? <WidgetSkeleton /> : <WidgetContent widgetKey={item.key} data={data.data} />}
    </article>
  );
}

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
  // Um único filtro alimenta todos os widgets: eles recalculam juntos.
  const periodQuery = period === "custom"
    ? `period=custom&start=${encodeURIComponent(customStart)}&end=${encodeURIComponent(customEnd)}`
    : `period=${period}`;

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

  return (
    <Shell>
      <div className="mx-auto w-full max-w-[1400px]">
        <header className="pagehead" style={{ "--eyebrow": '"PAINEL · PERSONALIZÁVEL"' } as React.CSSProperties}>
          <div><h1>Visão geral</h1><p>Quantos leads entraram, quantos agendaram, quantos compareceram e quanto vendemos.</p></div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="dashboard-period">Período</label>
            <select id="dashboard-period" className="input w-auto" value={period} onChange={(event) => setPeriod(event.target.value)}><option value="today">Hoje</option><option value="week">Semana</option><option value="month">Mês</option><option value="custom">Período personalizado</option></select>
            {period === "custom" ? <>
              <label className="sr-only" htmlFor="dashboard-start">Data inicial</label>
              <input id="dashboard-start" className="input w-auto" type="date" value={customStart} max={customEnd} onChange={(event) => { setCustomStart(event.target.value); if (customEnd < event.target.value) setCustomEnd(event.target.value); }} />
              <label className="sr-only" htmlFor="dashboard-end">Data final</label>
              <input id="dashboard-end" className="input w-auto" type="date" value={customEnd} min={customStart} onChange={(event) => setCustomEnd(event.target.value)} />
            </> : null}
            <button className="btn secondary active:scale-[0.98]" onClick={() => setEditing((value) => !value)}>{editing ? <X size={18} /> : <SlidersHorizontal size={18} />}{editing ? "Fechar" : "Personalizar"}</button>
          </div>
        </header>

        {editing && catalog ? <section className="mb-6 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 md:p-6" aria-label="Configurar dashboard">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Biblioteca de widgets</h2><p className="text-sm text-[var(--muted)]">A ordem e o tamanho se adaptam automaticamente em telas menores — um widget &ldquo;Amplo&rdquo; também vira coluna única no celular.</p></div><div className="flex gap-2"><button className="btn secondary active:scale-[0.98]" disabled={saving} onClick={() => void reset()}><ArrowCounterClockwise size={18} />Restaurar padrão</button><button className="btn active:scale-[0.98]" disabled={saving} onClick={() => void save()}><Check size={18} />{saving ? "Salvando" : "Salvar"}</button></div></div>
          <div className="divide-y divide-[var(--border)]">{[...availableDraft].sort((a, b) => a.order - b.order).map((item, index) => { const definition = definitions.get(item.key); if (!definition) return null; return <div key={item.key} className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center"><label className="flex min-w-0 items-start gap-3"><input type="checkbox" checked={item.visible} onChange={(event) => patchItem(item.key, { visible: event.target.checked })} className="mt-1" /><span><strong className="block text-sm">{definition.label}</strong><span className="block text-xs text-[var(--muted)]">{definition.description}</span></span></label><label className="flex items-center gap-2 text-sm"><span>Tamanho</span><select className="input w-auto" value={item.size} onChange={(event) => patchItem(item.key, { size: event.target.value as WidgetSize })}>{definition.sizes.map((size) => <option key={size} value={size}>{sizeLabels[size]}</option>)}</select></label><div className="flex gap-1"><button className="btn secondary min-h-11 min-w-11 px-2" disabled={index === 0} aria-label={`Mover ${definition.label} para cima`} title="Mover para cima" onClick={() => move(item.key, -1)}><CaretUp size={17} /></button><button className="btn secondary min-h-11 min-w-11 px-2" disabled={index === availableDraft.length - 1} aria-label={`Mover ${definition.label} para baixo`} title="Mover para baixo" onClick={() => move(item.key, 1)}><CaretDown size={17} /></button></div></div>; })}</div>
        </section> : null}

        {catalogError || layoutError ? <div className="card" role="alert"><p className="error">Não foi possível carregar a configuração do dashboard.</p></div> : !catalog || !layout ? <div className="grid grid-cols-1 gap-4 md:grid-cols-2"><div className="card min-h-[220px]"><WidgetSkeleton /></div><div className="card min-h-[220px]"><WidgetSkeleton /></div><div className="card min-h-[220px]"><WidgetSkeleton /></div><div className="card min-h-[220px]"><WidgetSkeleton /></div></div> : !visible.length ? <div className="card"><EmptyWidget message="Nenhum widget está visível. Abra Personalizar para escolher o que acompanhar." /></div> : <section className="grid grid-cols-12 gap-4" aria-label="Widgets do dashboard">{visible.map((item) => { const definition = definitions.get(item.key); return definition ? <WidgetCard key={item.key} item={item} definition={definition} periodQuery={periodQuery} /> : null; })}</section>}
      </div>
    </Shell>
  );
}
