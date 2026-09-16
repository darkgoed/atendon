"use client";

import {
  ArrowLineDown,
  CalendarBlank,
  ChartLineUp,
  PhoneCall,
  Target,
  UsersThree
} from "@phosphor-icons/react";
import Link from "next/link";
import { Sparkline } from "@/components/commercial-dashboard-charts";
import { Empty } from "@/components/page-state";
import { BarComparisonChart, Button, Card, DonutChart, Input, KpiCard, KpiGrid, LineAreaChart, TableScroll } from "@/components/ui";
import { trendDelta, type CommercialDashboardSeries } from "@/lib/commercial-dashboard";
import styles from "./metrics-dashboard.module.css";

export type CommercialDashboardData = {
  scope: {
    type: "mine" | "workspace";
    member_id: string | null;
    email: string;
    is_closer: boolean;
    is_attendant: boolean;
    availability_status: "available" | "unavailable" | null;
  };
  period: {
    key: "today" | "week" | "month" | "custom";
    start: string;
    end: string;
    timezone: string;
  };
  metrics: {
    created: number;
    scheduled: number;
    completed: number;
    no_show: number;
    cancelled: number;
    upcoming: number;
    overdue: number;
    result_pending: number;
    rescheduled: number;
    proposals: number;
    negotiations: number;
    sales: number;
    closing_rate: number;
    sold_value: number;
    average_ticket: number;
    overdue_follow_ups: number;
    attendance_rate: number;
    no_show_rate: number;
    average_quality: number | null;
  };
  sdr_metrics: {
    received: number;
    attended: number;
    qualified: number;
    scheduled: number;
    qualification_rate: number;
    scheduling_rate: number;
    average_first_response_minutes: number | null;
    overdue_follow_ups: number;
    recovered_no_shows: number;
  };
  commercial_metrics: {
    scheduled: number;
    completed: number;
    attended: number;
    no_show: number;
    rescheduled: number;
    cancelled: number;
    result_pending: number;
    proposals: number;
    negotiations: number;
    sales: number;
    attendance_rate: number;
    closing_rate: number;
    sold_value: number;
    average_ticket: number;
    overdue_follow_ups: number;
  };
  series: CommercialDashboardSeries;
  today_agenda: Array<{
    id: string;
    start_at: string;
    end_at: string;
    status: string;
    lead_name: string | null;
    lead_phone: string;
    unit_name: string;
    meet_url: string | null;
    assigned_user_email: string | null;
    assigned_availability_status: "available" | "unavailable" | null;
  }>;
  team: Array<{
    member_id: string;
    user_id: string;
    email: string;
    active: number;
    period: number;
    completed: number;
    no_show: number;
    last_assigned_at: string | null;
    availability_status: "available" | "unavailable";
    is_current: boolean;
    is_next: boolean;
  }>;
};

type Period = CommercialDashboardData["period"]["key"];

const periodOptions: Array<{ key: Exclude<Period, "custom">; label: string }> = [
  { key: "today", label: "Hoje" },
  { key: "week", label: "Semana" },
  { key: "month", label: "Mês" }
];

function formatPercent(value: number) {
  return `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(value)}%`;
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

function statusLabel(status: string, overdue: boolean) {
  if (status === "concluido") return "Compareceu";
  if (status === "no_show") return "Não compareceu";
  if (overdue) return "Resultado pendente";
  if (status === "reagendado") return "Reagendada";
  return "Confirmada";
}

function statusTone(status: string, overdue: boolean) {
  if (status === "concluido") return styles.statusDone;
  if (status === "no_show" || overdue) return styles.statusWarning;
  return styles.statusAccent;
}

function initials(email: string) {
  return email.split("@")[0].split(/[._-]+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
}

function exportDashboard(data: CommercialDashboardData) {
  const lines = [
    ["data", "marcadas", "compareceram", "nao_compareceram", "canceladas"],
    ...data.series.map((item) => [item.day, item.scheduled, item.completed, item.no_show, item.cancelled])
  ];
  const csv = lines.map((line) => line.map((value) => `"${String(value).replaceAll("\"", "\"\"")}"`).join(",")).join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = `atendon-reunioes-${data.period.start}-${data.period.end}.csv`;
  anchor.click();
  URL.revokeObjectURL(href);
}

export function CommercialDashboard({
  data,
  selectedPeriod,
  customStart,
  customEnd,
  onPeriodChange,
  onCustomStartChange,
  onCustomEndChange
}: {
  data: CommercialDashboardData;
  selectedPeriod: Period;
  customStart: string;
  customEnd: string;
  onPeriodChange: (period: Period) => void;
  onCustomStartChange: (value: string) => void;
  onCustomEndChange: (value: string) => void;
}) {
  const now = Date.now();
  const delta = trendDelta(data.series);

  return (
    <section className={styles.dashboard} aria-labelledby="commercial-dashboard-title">
      <header className={styles.dashboardHeader}>
        <div>
          <span className="label">{data.scope.type === "mine" ? "MINHA OPERAÇÃO" : "OPERAÇÃO DO WORKSPACE"}</span>
          <h2 id="commercial-dashboard-title" className="mt-1 text-2xl font-semibold tracking-tight">Dashboard de reuniões</h2>
          <p className="sub mt-1">
            {data.scope.type === "mine"
              ? `Resultados e agenda atribuídos a ${data.scope.email}.`
              : "Resultados consolidados, agenda e equilíbrio da distribuição."}
          </p>
        </div>
        <div className={styles.actions}>
          <div className={styles.periodControl} aria-label="Período do dashboard">
            {periodOptions.map((option) => (
              <Button
                key={option.key}
                type="button"
                className={selectedPeriod === option.key ? styles.periodSelected : styles.periodOption}
                aria-pressed={selectedPeriod === option.key}
                onClick={() => onPeriodChange(option.key)}
              >
                {option.label}
              </Button>
            ))}
            <Button
              type="button"
              className={selectedPeriod === "custom" ? styles.periodSelected : styles.periodOption}
              aria-pressed={selectedPeriod === "custom"}
              onClick={() => onPeriodChange("custom")}
            >
              Período
            </Button>
          </div>
          <button type="button" className="btn" onClick={() => exportDashboard(data)}>
            <ArrowLineDown size={16} aria-hidden="true" />
            Exportar
          </button>
        </div>
      </header>

      {selectedPeriod === "custom" ? (
        <div className={styles.customDates}>
          <label className="grid gap-2 text-xs font-medium text-[var(--text-secondary)]">
            Data inicial
            <Input type="date" value={customStart} onChange={(event) => onCustomStartChange(event.target.value)} />
          </label>
          <label className="grid gap-2 text-xs font-medium text-[var(--text-secondary)]">
            Data final
            <Input type="date" min={customStart} value={customEnd} onChange={(event) => onCustomEndChange(event.target.value)} />
          </label>
        </div>
      ) : null}

      <div className={styles.agendaChartGrid}>
        <Card>
          <div className="cardtitle"><span>Calls no período</span><CalendarBlank size={17} aria-hidden="true" /></div>
          <KpiGrid className="kpi-grid--highlight">
            <KpiCard
              label="Criadas"
              value={data.metrics.created}
              hint="novos agendamentos no período"
              tone="primary"
              icon={<PhoneCall size={16} weight="duotone" aria-hidden="true" />}
              delta={delta !== null ? { value: delta, label: "Segunda metade do período comparada à primeira" } : null}
              spark={<Sparkline values={data.series.map((item) => item.scheduled)} tone="var(--primary)" className="h-8 w-full" />}
            />
          </KpiGrid>
          <KpiGrid className="mt-3">
            <KpiCard label="Marcadas" value={data.metrics.scheduled} tone="primary" />
            <KpiCard label="Compareceram" value={data.metrics.completed} tone="success" />
            <KpiCard label="Resultado pendente" value={data.metrics.result_pending} tone="warning" />
            <KpiCard label="Não comp." value={data.metrics.no_show} tone="danger" />
            <KpiCard label="Canceladas" value={data.metrics.cancelled} />
          </KpiGrid>
        </Card>

        <Card>
          <div className="cardtitle"><span>Operação SDR</span><UsersThree size={19} aria-hidden="true" /></div>
          <dl className={styles.sdrGrid}>
            {[
              ["Recebidos", data.sdr_metrics.received],
              ["Atendidos", data.sdr_metrics.attended],
              ["Qualificados", data.sdr_metrics.qualified],
              ["Agendados", data.sdr_metrics.scheduled],
              ["Taxa qualificação", formatPercent(data.sdr_metrics.qualification_rate)],
              ["Taxa agendamento", formatPercent(data.sdr_metrics.scheduling_rate)],
              ["1º atendimento", data.sdr_metrics.average_first_response_minutes == null ? "—" : `${data.sdr_metrics.average_first_response_minutes} min`],
              ["Follow-ups atrasados", data.sdr_metrics.overdue_follow_ups],
              ["No-shows recuperados", data.sdr_metrics.recovered_no_shows]
            ].map(([label, value]) => <div key={String(label)} className="rounded border border-[var(--border)] p-2"><dt className="type-caption text-[var(--text-muted)]">{label}</dt><dd className="mono mt-1 text-lg font-semibold">{value}</dd></div>)}
          </dl>
        </Card>

        <Card>
          <div className="cardtitle"><span>Comercial / Closer</span><Target size={19} aria-hidden="true" /></div>
          <dl className={styles.closerGrid}>
            {[
              ["Agendadas", data.commercial_metrics.scheduled],
              ["Realizadas", data.commercial_metrics.completed],
              ["Comparecimentos", data.commercial_metrics.attended],
              ["No-shows", data.commercial_metrics.no_show],
              ["Canceladas", data.commercial_metrics.cancelled],
              ["Resultado pendente", data.commercial_metrics.result_pending],
              ["Propostas", data.commercial_metrics.proposals],
              ["Negociações", data.commercial_metrics.negotiations],
              ["Vendas", data.commercial_metrics.sales],
              ["Taxa comparecimento", formatPercent(data.commercial_metrics.attendance_rate)],
              ["Taxa fechamento", formatPercent(data.commercial_metrics.closing_rate)],
              ["Valor vendido", formatMoney(data.commercial_metrics.sold_value)],
              ["Ticket médio", formatMoney(data.commercial_metrics.average_ticket)],
              ["Reagendadas", data.commercial_metrics.rescheduled],
              ["Follow-ups atrasados", data.commercial_metrics.overdue_follow_ups]
            ].map(([label, value]) => <div key={String(label)} className="rounded border border-[var(--border)] p-2"><dt className="type-caption text-[var(--text-muted)]">{label}</dt><dd className="mono mt-1 text-lg font-semibold">{value}</dd></div>)}
          </dl>
        </Card>

        <Card>
          <div className="cardtitle"><span>Taxas</span><ChartLineUp size={19} aria-hidden="true" /></div>
          <DonutChart
            height={168}
            ariaLabel="Comparecimento vs. não comparecimento no período"
            centerValue={formatPercent(data.metrics.attendance_rate)}
            centerLabel="comparecimento"
            data={[
              { label: "Compareceram", value: data.metrics.attendance_rate, tone: "success" },
              { label: "Não compareceram", value: data.metrics.no_show_rate, tone: "warning" }
            ]}
          />
        </Card>

        <Card>
          <div className="cardtitle">
            <span className="inline-flex items-center gap-2"><CalendarBlank size={19} aria-hidden="true" /> Agenda de hoje</span>
            <Link href="/agenda" className="accent text-xs">Abrir agenda</Link>
          </div>
          {data.today_agenda.length ? (
            <div className="divide-y divide-[var(--border)]">
              {data.today_agenda.map((appointment) => {
                const overdue = ["confirmado", "reagendado"].includes(appointment.status) && new Date(appointment.end_at).getTime() < now;
                const status = statusLabel(appointment.status, overdue);
                return (
                  <div key={appointment.id} className="grid gap-3 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
                    <time className="mono rounded-sm bg-[var(--surface-active)] px-2 py-1 text-xs font-semibold text-[var(--primary)]">
                      {new Intl.DateTimeFormat("pt-BR", { timeZone: data.period.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(appointment.start_at))}
                    </time>
                    <div className="min-w-0">
                      <strong className="block truncate text-sm">{appointment.lead_name ?? appointment.lead_phone}</strong>
                      <span className="sub block truncate text-xs">{appointment.lead_phone} · {appointment.unit_name}</span>
                      <span className="sub block truncate type-caption">
                        {appointment.assigned_user_email
                          ? `${appointment.assigned_user_email} · ${appointment.assigned_availability_status === "available" ? "disponível" : appointment.assigned_availability_status === "unavailable" ? "indisponível" : "fora do pool"}`
                          : "Sem responsável"}
                      </span>
                    </div>
                    <span className={`w-fit rounded-full border px-2 py-1 type-caption font-medium ${statusTone(appointment.status, overdue)}`}>{status}</span>
                  </div>
                );
              })}
            </div>
          ) : <Empty>Nenhuma reunião na agenda de hoje.</Empty>}
        </Card>

        <Card>
          <div className="chart-panel__head">
            <span className="chart-panel__title inline-flex items-center gap-2"><ChartLineUp size={17} aria-hidden="true" /> Evolução de calls</span>
          </div>
          <LineAreaChart
            ariaLabel="Evolução de reuniões marcadas, realizadas e não comparecidas"
            height={220}
            data={data.series.map((item) => ({ x: item.day, scheduled: item.scheduled, completed: item.completed, no_show: item.no_show }))}
            series={[
              { key: "scheduled", label: "Marcadas", tone: "primary" },
              { key: "completed", label: "Compareceram", tone: "success" },
              { key: "no_show", label: "Não comp.", tone: "warning" }
            ]}
            xLabelFormatter={(value) => new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(new Date(`${value}T12:00:00.000Z`))}
          />
        </Card>

        {data.scope.type === "workspace" ? (
          <Card>
            <div className="cardtitle">
              <span className="inline-flex items-center gap-2"><UsersThree size={19} aria-hidden="true" /> Distribuição do time</span>
              {data.team[0] ? <span className="sub text-xs">Próxima da fila: <strong className="text-[var(--text)]">{data.team[0].email}</strong></span> : null}
            </div>
            {data.team.length ? (
              <TableScroll tabIndex={0} aria-label="Distribuição detalhada do time">
              <table className={styles.widgetTable}>
                  <thead className="border-b border-[var(--border)] type-caption uppercase tracking-[.08em] text-[var(--text-muted)]">
                    <tr><th className="pb-2 font-medium">Atendente</th><th className="pb-2 text-right font-medium">Ativas</th><th className="pb-2 text-right font-medium">Período</th><th className="pb-2 text-right font-medium">Compareceu</th><th className="pb-2 text-right font-medium">Não comp.</th></tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {data.team.map((member) => (
                      <tr key={member.member_id}>
                        <td className="py-3">
                          <div className="flex items-center gap-2">
                            <span className="grid size-8 shrink-0 place-items-center rounded-full border border-[var(--border)] bg-[var(--surface-active)] type-caption font-semibold">{initials(member.email)}</span>
                            <span className="min-w-0">
                              <strong className="block max-w-64 truncate font-medium">{member.email}</strong>
                              <span className="type-caption text-[var(--text-muted)]">
                                {member.is_next ? "Próxima da fila · " : member.is_current ? "Você · " : ""}
                                {member.availability_status === "available" ? "Disponível" : "Indisponível"} (informativo)
                              </span>
                            </span>
                          </div>
                        </td>
                        <td className="mono py-3 text-right font-semibold">{member.active}</td>
                        <td className="mono py-3 text-right">{member.period}</td>
                        <td className="mono py-3 text-right text-[var(--success-text)]">{member.completed}</td>
                        <td className="mono py-3 text-right text-[var(--warning-text)]">{member.no_show}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </TableScroll>
            ) : (
              <Empty>Selecione membros na Equipe de atendimento para ativar o rodízio.</Empty>
            )}
          </Card>
        ) : null}

        <Card>
          <div className="cardtitle"><span className="inline-flex items-center gap-2"><Target size={19} aria-hidden="true" /> Composição das calls</span></div>
          <BarComparisonChart
            ariaLabel="Composição das calls marcadas no período por desfecho"
            data={[
              { label: "Marcadas", value: data.metrics.scheduled, tone: "primary" },
              { label: "Compareceram", value: data.metrics.completed, tone: "success" },
              { label: "Não compareceram", value: data.metrics.no_show, tone: "warning" },
              { label: "Próximas", value: data.metrics.upcoming, tone: "info" }
            ]}
          />
          <div className="mt-4 border-t border-[var(--border)] pt-3">
            <span className="kpi-card__label">Qualidade média dos leads</span>
            <div className="mt-1.5 flex items-end gap-2">
              <strong className="mono text-2xl font-semibold">{data.metrics.average_quality ?? "—"}</strong>
              <span className="sub pb-1 text-xs">{data.metrics.average_quality === null ? "sem avaliação no período" : "de 5 estrelas"}</span>
            </div>
          </div>
        </Card>
      </div>
    </section>
  );
}
