"use client";

import type { ReactNode } from "react";
import useSWR from "swr";
import { api, ApiError } from "@/lib/api";
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
type WidgetValueResponse = { data: { value: number } };

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
  pct: number;
  note: string;
  color: string;
  icon: ReactNode;
};

type Kpi = { label: string; value: string; tint: string; icon: ReactNode };

export function DashboardReferenceOverview({ periodQuery }: { periodQuery: string }) {
  const swrOptions = { refreshInterval: 15_000, revalidateOnFocus: true };
  const { data, error, mutate } = useSWR<CommercialMetricsResponse>(
    `/dashboard/widgets/commercial_metrics?${periodQuery}`,
    fetcher,
    swrOptions
  );
  const started = useSWR<WidgetValueResponse>(
    `/dashboard/widgets/conversations_started?${periodQuery}`,
    fetcher,
    swrOptions
  );
  const conversion = useSWR<WidgetValueResponse>(
    `/dashboard/widgets/conversion_rate?${periodQuery}`,
    fetcher,
    swrOptions
  );

  const retryAll = () => {
    void mutate();
    void started.mutate();
    void conversion.mutate();
  };

  const blockingError = error ?? [started.error, conversion.error].find((err) => err && !isForbidden(err));
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

  const payload = data?.data;
  const startedForbidden = isForbidden(started.error);
  const conversionForbidden = isForbidden(conversion.error);
  if (!payload || (!started.data && !startedForbidden) || (!conversion.data && !conversionForbidden)) {
    return (
      <div className={styles.wrap}>
        <div className={styles.state}>
          <span className={styles.stateText}>Carregando métricas…</span>
        </div>
      </div>
    );
  }

  const r = payload.result;
  const f = payload.funnel;
  const startedValue = started.data?.data?.value;
  const conversionValue = conversion.data?.data?.value;

  const kpis: Kpi[] = [
    { label: "Conversas iniciadas", value: countText(startedValue), tint: "#22D3EE", icon: <UsersIcon size={14} w={2} /> },
    { label: "Agendamentos", value: nf.format(num(r.appointments)), tint: "#67E8F9", icon: <CalendarIcon size={14} w={2} /> },
    { label: "Vendas", value: nf.format(num(r.sales)), tint: "#3DDC97", icon: <CheckCircleIcon size={14} w={2} /> },
    { label: "Taxa de conversão", value: pctOrDash(conversionValue), tint: "#F5B94A", icon: <ChartIcon size={14} w={2} /> },
  ];

  const { widths, empty } = funnelWidths([num(r.new_contacts), num(r.appointments), num(r.calls), num(r.sales)]);
  const stageBg = (gradient: string) => (empty ? "rgba(255,255,255,.05)" : gradient);
  const stages: Stage[] = [
    { n: "01", label: "Novos contatos", color: "#22D3EE", tone: "primary", bg: stageBg("linear-gradient(180deg,rgba(34,211,238,.42),rgba(34,211,238,.26))"), value: num(r.new_contacts), stepPct: null, stepLabel: "" },
    { n: "02", label: "Agendamentos", color: "#67E8F9", tone: "primary", bg: stageBg("linear-gradient(180deg,rgba(45,200,230,.34),rgba(45,200,230,.2))"), value: num(r.appointments), stepPct: Math.round(num(f.lead_to_appointment)), stepLabel: "Lead → Agendamento" },
    { n: "03", label: "Calls realizadas", color: "#4FE0B0", tone: "success", bg: stageBg("linear-gradient(180deg,rgba(61,220,170,.32),rgba(61,220,160,.18))"), value: num(r.calls), stepPct: Math.round(num(f.appointment_to_attendance)), stepLabel: "Agendamento → Comparecimento" },
    { n: "04", label: "Vendas", color: "#3DDC97", tone: "success", bg: stageBg("linear-gradient(180deg,rgba(61,220,151,.42),rgba(61,220,151,.26))"), value: num(r.sales), stepPct: Math.round(num(f.call_to_sale)), stepLabel: "Call → Venda" },
  ];

  const rings: Ring[] = [
    { label: "Lead → Venda", value: pctText(f.lead_to_sale), pct: num(f.lead_to_sale), note: "conversão ponta a ponta do período", color: "#22D3EE", icon: <ChartIcon size={16} w={2} /> },
    { label: "Taxa de no-show", value: pctText(f.no_show_rate), pct: num(f.no_show_rate), note: `sobre ${nf.format(num(r.due_meetings))} reunião(ões) já vencida(s)`, color: "#F5B94A", icon: <NoShowIcon size={16} w={2} /> },
  ];

  return (
    <div className={styles.wrap}>
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
              <span className={styles.heroNumber}>{money(num(r.sold_value))}</span>
            </span>
            <span className={styles.heroMeta}>
              <span>
                Ticket médio <span className={styles.mono}>R$ {money(num(r.average_ticket))}</span>
              </span>
              <span>
                Vendas <span className={styles.mono}>{nf.format(num(r.sales))}</span>
              </span>
            </span>
          </div>
        </div>
        <div className={styles.kpiGrid}>
          {kpis.map((k) => (
            <div key={k.label} className={styles.kpi}>
              <span className={styles.kpiLabel}>
                <span className={styles.kpiIcon} style={{ color: k.tint }}>
                  {k.icon}
                </span>
                {k.label}
              </span>
              <span className={styles.kpiValue}>{k.value}</span>
            </div>
          ))}
        </div>
      </div>

      <div className={styles.bottomRow}>
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
                <div className={styles.ringTrack}>
                  <div
                    className={styles.ringFill}
                    style={{ width: `${Math.min(Math.max(g.pct, 0), 100)}%`, background: g.color }}
                  />
                </div>
                <span className={styles.ringNote}>{g.note}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
