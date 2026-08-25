"use client";

import { ArrowClockwise, ArrowLeft, ArrowRight, DownloadSimple, WarningCircle, Wallet } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LoadingCards } from "@/components/page-state";
import { Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { openRouterCreditLevel, type OpenRouterCreditLevel } from "@/lib/openrouter-credit";

type ModelUsage = { ai_model: string; calls: number; tokens: string; cost_usd: string };
type DailyModelUsage = ModelUsage & { day: string };
type UsageData = {
  summary: { calls: number; input_tokens: string; output_tokens: string; cost_usd: string };
  models: ModelUsage[];
  daily_models: DailyModelUsage[];
};
type CreditData =
  | { status: "available"; total_credits: number; total_usage: number; balance: number; checked_at: string }
  | { status: "not_configured" };

const number = new Intl.NumberFormat("pt-BR");
const usd = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 });
const colors = ["#22d3ee", "#ff7a45", "#f4b840", "#8bcf4f", "#5b8def", "#a5afb8", "#db6fc8", "#8e7cf6"];
const dayKey = (date: Date) => date.toISOString().slice(0, 10);

function usageDayDescription(date: Date, rows: DailyModelUsage[], total: number) {
  const dateLabel = date.toLocaleDateString("pt-BR", { timeZone: "UTC", day: "2-digit", month: "long" });
  const breakdown = rows.length
    ? rows.map((item) => `${item.ai_model}: ${usd.format(Number(item.cost_usd))}`).join("; ")
    : "sem consumo";
  return `${dateLabel}. ${breakdown}. Total: ${usd.format(total)}.`;
}

export default function Usage() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [period, setPeriod] = useState<"week" | "month">("week");
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(new Set());
  const [activeDay, setActiveDay] = useState<string | null>(null);
  const [data, setData] = useState<UsageData>();
  const [error, setError] = useState("");
  const [credits, setCredits] = useState<CreditData>();
  const [creditsError, setCreditsError] = useState("");
  const [creditsLoading, setCreditsLoading] = useState(true);

  const loadCredits = useCallback(async () => {
    setCreditsLoading(true);
    setCreditsError("");
    try {
      setCredits(await api<CreditData>("/usage/credits"));
    } catch (loadError) {
      setCreditsError(loadError instanceof Error ? loadError.message : "Falha ao consultar o saldo");
    } finally {
      setCreditsLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    setData(undefined);
    setError("");
    api<UsageData>(`/usage?month=${month}`)
      .then((response) => { if (active) setData(response); })
      .catch((loadError: Error) => { if (active) setError(loadError.message); });
    return () => { active = false; };
  }, [month]);

  useEffect(() => {
    void loadCredits();
  }, [loadCredits]);

  useEffect(() => setActiveDay(null), [month, period, hiddenModels]);

  const week = useMemo(() => {
    const now = new Date();
    const currentMonth = now.toISOString().slice(0, 7);
    const end = month === currentMonth ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) : new Date(`${month}-01T00:00:00Z`);
    if (month !== currentMonth) end.setUTCMonth(end.getUTCMonth() + 1, 0);
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(end);
      date.setUTCDate(end.getUTCDate() - 6 + index);
      return date;
    });
  }, [month]);

  const modelColors = useMemo(() => new Map((data?.models ?? []).map((model, index) => [model.ai_model, colors[index % colors.length]])), [data]);
  const periodDays = useMemo(() => period === "week" ? week : Array.from({ length: new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate() }, (_, index) => new Date(`${month}-${String(index + 1).padStart(2, "0")}T00:00:00Z`)), [month, period, week]);
  const periodRows = useMemo(() => periodDays.map((date) => {
    const day = dayKey(date);
    const rows = (data?.daily_models ?? []).filter((row) => row.day === day && !hiddenModels.has(row.ai_model));
    return { date, day, rows, total: rows.reduce((sum, row) => sum + Number(row.cost_usd), 0) };
  }), [data, hiddenModels, periodDays]);
  const max = Math.max(0.000001, ...periodRows.map((row) => row.total));

  function moveMonth(direction: number) {
    const date = new Date(`${month}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + direction);
    setMonth(date.toISOString().slice(0, 7));
  }

  function toggleModel(model: string) {
    setHiddenModels((current) => {
      const next = new Set(current);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      return next;
    });
  }

  async function exportCsv() {
    if (!data) return;
    try {
      const csv = await api<string>(`/usage/export?month=${month}`);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      link.download = `uso-ia-${month}.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Falha ao exportar CSV");
    }
  }

  return (
    <Shell>
      <header className="pagehead" style={{ "--eyebrow": '"PAINEL · MONITORAMENTO"' } as React.CSSProperties}>
        <div><h1>Uso</h1><p>Transparência do consumo de IA. Sua assinatura é fixa — isto não é cobrança.</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn p-2.5" onClick={() => moveMonth(-1)} aria-label="Mês anterior"><ArrowLeft aria-hidden="true" /></button>
          <input type="month" className="input w-auto" value={month} onChange={(event) => { if (event.target.value) setMonth(event.target.value); }} aria-label="Mês de referência" />
          <button type="button" className="btn p-2.5" onClick={() => moveMonth(1)} aria-label="Próximo mês"><ArrowRight aria-hidden="true" /></button>
          <button type="button" className="btn" onClick={() => void exportCsv()} disabled={!data}><DownloadSimple aria-hidden="true" />CSV</button>
        </div>
      </header>

      <CreditBalance
        data={credits}
        error={creditsError}
        loading={creditsLoading}
        onRefresh={() => void loadCredits()}
      />

      {error ? <p className="error" role="alert">{error}</p> : !data ? <LoadingCards /> : <>
        <section className="grid4">
          <Metric label="Chamadas de IA" value={number.format(data.summary.calls)} />
          <Metric label="Tokens de entrada" value={compact(data.summary.input_tokens)} />
          <Metric label="Tokens de saída" value={compact(data.summary.output_tokens)} />
          <Metric label="Custo estimado" value={usd.format(Number(data.summary.cost_usd))} accent />
        </section>

        <section className="line-section mt-6" aria-labelledby="usage-chart-title">
          <div className="cardtitle flex-wrap gap-3">
            <div>
              <h2 id="usage-chart-title">Uso por modelo</h2>
              <p className="sub">Custo diário empilhado por IA</p>
            </div>
            <div className="flex items-center gap-3">
              <div className="usage-period" aria-label="Período do gráfico">
                {(["week", "month"] as const).map((option) => <button type="button" key={option} className={period === option ? "active" : ""} onClick={() => setPeriod(option)} aria-pressed={period === option}>{option === "week" ? "Semana" : "Mês"}</button>)}
              </div>
              <span className="mono text-[10px] text-[var(--faint)]">{periodDays[0].toLocaleDateString("pt-BR", { timeZone: "UTC", day: "2-digit", month: "short" })} — {periodDays.at(-1)!.toLocaleDateString("pt-BR", { timeZone: "UTC", day: "2-digit", month: "short" })}</span>
            </div>
          </div>
          <p id="usage-chart-description" className="sub mb-3">Use Tab para percorrer os dias ou toque em uma barra para consultar os valores. A tabela abaixo apresenta os totais por modelo.</p>

          <div className="usage-chart-scroll" role="region" aria-label="Gráfico de uso por dia" tabIndex={0}>
            <div className={`usage-chart usage-chart--${period}`} role="group" aria-describedby="usage-chart-description" style={{ gridTemplateColumns: `repeat(${periodRows.length},minmax(${period === "month" ? "24px" : "56px"},1fr))` }}>
              <div className="usage-gridlines" aria-hidden="true"><i /><i /><i /><i /></div>
              {periodRows.map((row) => {
                const tooltipId = `usage-day-${row.day}`;
                const description = usageDayDescription(row.date, row.rows, row.total);
                return (
                  <button
                    type="button"
                    className={`usage-day${activeDay === row.day ? " is-active" : ""}`}
                    key={row.day}
                    aria-label={description}
                    aria-expanded={activeDay === row.day}
                    onFocus={() => setActiveDay(row.day)}
                    onClick={() => setActiveDay(row.day)}
                    onBlur={() => setActiveDay((current) => current === row.day ? null : current)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") event.currentTarget.blur();
                    }}
                  >
                    <span className="usage-bar" style={{ height: `${Math.max(row.total ? 3 : 0, row.total / max * 100)}%` }} aria-hidden="true">
                      {row.rows.map((item) => <i key={item.ai_model} style={{ height: `${row.total ? Number(item.cost_usd) / row.total * 100 : 0}%`, background: modelColors.get(item.ai_model) }} />)}
                    </span>
                    <span id={tooltipId} className="usage-tooltip" role="tooltip">
                      <strong>{row.date.toLocaleDateString("pt-BR", { timeZone: "UTC", day: "2-digit", month: "long" })}</strong>
                      {row.rows.length ? row.rows.map((item) => <span key={item.ai_model}><i style={{ background: modelColors.get(item.ai_model) }} />{item.ai_model}<b>{usd.format(Number(item.cost_usd))}</b></span>) : <small>Sem consumo</small>}
                      <span className="usage-total">Total <b>{usd.format(row.total)}</b></span>
                    </span>
                    <time dateTime={row.day}>{row.date.toLocaleDateString("pt-BR", { timeZone: "UTC", weekday: period === "week" ? "short" : undefined, day: "2-digit" })}</time>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="usage-legend" aria-label="Modelos exibidos">
            {data.models.map((model) => <button type="button" className={hiddenModels.has(model.ai_model) ? "muted" : ""} key={model.ai_model} onClick={() => toggleModel(model.ai_model)} aria-pressed={!hiddenModels.has(model.ai_model)}><i style={{ background: modelColors.get(model.ai_model) }} aria-hidden="true" />{model.ai_model}</button>)}
          </div>
          <div className="usage-table-scroll" role="region" aria-label="Totais de uso por modelo" tabIndex={0}>
            <table className="usage-data-table">
              <thead><tr><th>Modelo</th><th>Chamadas</th><th>Tokens</th><th>Custo</th></tr></thead>
              <tbody>{data.models.map((model) => <tr key={model.ai_model}><th scope="row">{model.ai_model}</th><td>{number.format(model.calls)}</td><td>{compact(model.tokens)}</td><td className="accent">{usd.format(Number(model.cost_usd))}</td></tr>)}</tbody>
            </table>
          </div>
        </section>
      </>}
    </Shell>
  );
}

function CreditBalance({
  data,
  error,
  loading,
  onRefresh
}: {
  data?: CreditData;
  error: string;
  loading: boolean;
  onRefresh: () => void;
}) {
  const available = data?.status === "available" ? data : undefined;
  const level: OpenRouterCreditLevel | "unavailable" = available
    ? openRouterCreditLevel(available.balance)
    : "unavailable";
  const isAlert = level === "warning" || level === "critical" || Boolean(error);
  const message = level === "critical"
    ? "Saldo crítico: abaixo de US$ 1,00. Adicione créditos para evitar a interrupção da IA."
    : level === "warning"
      ? "Saldo baixo: abaixo de US$ 3,00. Programe uma recarga em breve."
      : level === "healthy"
        ? "Saldo suficiente para manter as chamadas de IA."
        : error
          ? error
          : data?.status === "not_configured"
            ? "Configure OPENROUTER_MANAGEMENT_API_KEY no backend para exibir o saldo total."
            : "Consultando o saldo atual da conta.";

  return (
    <section
      className={`credit-balance credit-balance--${level}`}
      aria-labelledby="openrouter-credit-title"
      aria-busy={loading}
      role={isAlert ? "alert" : "status"}
    >
      <div className="credit-balance__icon" aria-hidden="true">
        {level === "warning" || level === "critical" || error
          ? <WarningCircle size={22} />
          : <Wallet size={22} />}
      </div>
      <div className="credit-balance__copy">
        <span className="label" id="openrouter-credit-title">Saldo OpenRouter</span>
        <strong className="mono">
          {loading && !available
            ? "Consultando…"
            : available
              ? usd.format(available.balance)
              : "Indisponível"}
        </strong>
        <p>{message}</p>
      </div>
      {available ? (
        <dl className="credit-balance__details">
          <div><dt>Créditos adquiridos</dt><dd className="mono">{usd.format(available.total_credits)}</dd></div>
          <div><dt>Uso acumulado</dt><dd className="mono">{usd.format(available.total_usage)}</dd></div>
        </dl>
      ) : null}
      <button type="button" className="btn credit-balance__refresh" onClick={onRefresh} disabled={loading}>
        <ArrowClockwise aria-hidden="true" />
        {loading ? "Atualizando" : "Atualizar saldo"}
      </button>
    </section>
  );
}

function Metric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div className="card"><span className="label">{label}</span><div className={`metric mono ${accent ? "accent" : ""}`}>{value}</div></div>;
}

function compact(value: string | number) {
  return new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value));
}
