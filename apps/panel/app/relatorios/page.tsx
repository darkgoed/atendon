"use client";

/**
 * Relatórios (B1 da spec v7) — UI para os endpoints existentes em
 * /reports/*. Toda agregação e escopo (case scope por sessão) ficam no
 * backend; aqui são só abas, período e tabelas/gráfico. Exportação usa o
 * CSV já servido por /reports/export/csv (mesmo padrão do export de
 * contatos). Permissão única: dashboard.read (capability existente).
 */

import { useMemo, useState } from "react";
import useSWR from "swr";
import { DownloadSimple } from "@/components/icons";
import { Empty } from "@/components/page-state";
import { Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { apiContentUrl } from "@/lib/meet";
import { leadStatusLabel } from "@/lib/labels";
import type { PanelSession } from "@/lib/session";
import { usePermission } from "@/lib/use-permission";
import { ChartEmptyState, LineAreaChart } from "@/components/ui";
import { IconButton, HelpHint } from "@/components/ui";

const fetcher = <T,>(url: string) => api<T>(url);

type VolumePoint = { date: string; total: number; open: number; closed: number; pending: number };
type AgentRow = { user_id: string; name: string; email: string; answered: number; closed: number; messages_sent: number };
type StatusRow = { status: string; total: number; avg_close_minutes: number | null };
type QualityReport = {
  from: string;
  to: string;
  idle_agents: Array<{ user_id: string; name: string; email: string; last_message_at: string | null }>;
  queue: {
    count: number;
    avg_wait_seconds: number | null;
    items: Array<{ conversation_id: string; contact: { phone: string; name: string | null }; waiting_since_seconds: number | null; last_inbound_at: string | null }>;
  };
  avg_first_response: Array<{ user_id: string; name: string; seconds: number }>;
  bottlenecks: Array<{ pipeline_id: string; stage_id: string; stage_name: string; contacts: number; avg_minutes: number | null }>;
};

type ReportTab = "volume" | "agents" | "status" | "quality";

const TABS: Array<{ id: ReportTab; label: string }> = [
  { id: "volume", label: "Volume de conversas" },
  { id: "agents", label: "Produtividade" },
  { id: "status", label: "Fluxo de status" },
  { id: "quality", label: "Qualidade" }
];

const CSV_TYPES: Record<ReportTab, "volume" | "agents" | "status" | "quality"> = {
  volume: "volume",
  agents: "agents",
  status: "status",
  quality: "quality"
};

function dayKeyInTimezone(timezone: string, daysAgo = 0): string {
  const date = new Date(Date.now() - daysAgo * 86_400_000);
  try {
    // en-CA devolve AAAA-MM-DD — o formato que o backend valida.
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  }
}

function formatWait(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}min`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}min`;
}

function formatMinutes(minutes: number | null): string {
  if (minutes === null || minutes === undefined) return "—";
  if (minutes < 60) return `${minutes}min`;
  return `${Math.floor(minutes / 60)}h ${String(Math.round(minutes % 60)).padStart(2, "0")}min`;
}

export default function ReportsPage() {
  const canReadReports = usePermission("dashboard.read");
  const { data: session } = useSWR<PanelSession>("/me", fetcher, { revalidateOnFocus: false, dedupingInterval: 10_000 });
  const [tab, setTab] = useState<ReportTab>("volume");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // Período padrão: últimos 30 dias no fuso do workspace (o backend usa o
  // mesmo default; os inputs só tornam o período visível/editável).
  const timezone = session?.activeWorkspace?.timezone ?? "UTC";
  const defaultFrom = dayKeyInTimezone(timezone, 29);
  const defaultTo = dayKeyInTimezone(timezone, 0);
  const effectiveFrom = from || defaultFrom;
  const effectiveTo = to || defaultTo;

  const query = `from=${effectiveFrom}&to=${effectiveTo}`;
  const { data: volume, error: volumeError, isLoading: volumeLoading } = useSWR<{ points: VolumePoint[] }>(
    canReadReports && tab === "volume" ? `/reports/conversation-volume?${query}` : null, fetcher, { revalidateOnFocus: false });
  const { data: agents, error: agentsError, isLoading: agentsLoading } = useSWR<{ items: AgentRow[] }>(
    canReadReports && tab === "agents" ? `/reports/agent-productivity?${query}` : null, fetcher, { revalidateOnFocus: false });
  const { data: statusFlow, error: statusError, isLoading: statusLoading } = useSWR<{ items: StatusRow[] }>(
    canReadReports && tab === "status" ? `/reports/status-flow?${query}` : null, fetcher, { revalidateOnFocus: false });
  const { data: quality, error: qualityError, isLoading: qualityLoading } = useSWR<QualityReport>(
    canReadReports && tab === "quality" ? `/reports/quality?${query}` : null, fetcher, { revalidateOnFocus: false });

  const activeError = tab === "volume" ? volumeError : tab === "agents" ? agentsError : tab === "status" ? statusError : qualityError;
  const activeLoading = tab === "volume" ? volumeLoading : tab === "agents" ? agentsLoading : tab === "status" ? statusLoading : qualityLoading;

  const volumeSeries = useMemo(() => {
    const points = volume?.points ?? [];
    return {
      data: points.map((point) => ({ x: point.date, total: point.total, open: point.open, closed: point.closed, pending: point.pending })),
      hasData: points.some((point) => point.total > 0)
    };
  }, [volume?.points]);

  if (!canReadReports) {
    return (
      <Shell fitViewport>
        <div className="leads-page">
          <header className="leads-page__header"><div><h1>Relatórios</h1></div></header>
          <Empty>Você não tem permissão para ver relatórios deste workspace.</Empty>
        </div>
      </Shell>
    );
  }

  return (
    <Shell fitViewport>
      <div className="leads-page">
        <header className="leads-page__header">
          <div>
            <h1><HelpHint content="Indicadores do atendimento no seu escopo de acesso." description={<>Operação do atendimento no período escolhido, com o escopo da sua sessão: gestores veem o workspace inteiro; operadores veem o próprio escopo.</>}>Relatórios</HelpHint></h1>
          </div>
          <div className="leads-page__actions flex min-h-8 flex-wrap items-center gap-2">
            <label className="field m-0">
              <span className="sr-only">Data inicial</span>
              <input className="input" type="date" value={from} max={effectiveTo} onChange={(event) => setFrom(event.target.value)} aria-label="Data inicial" />
            </label>
            <label className="field m-0">
              <span className="sr-only">Data final</span>
              <input className="input" type="date" value={to} min={effectiveFrom} onChange={(event) => setTo(event.target.value)} aria-label="Data final" />
            </label>
            <IconButton
              asChild
              label={`Exportar CSV (${TABS.find((item) => item.id === tab)?.label})`}
              size="sm"
            >
              <a href={apiContentUrl(`/reports/export/csv?type=${CSV_TYPES[tab]}&${query}`)}><DownloadSimple size={14} aria-hidden="true" /></a>
            </IconButton>
          </div>
        </header>

        <div className="conversation-filter-tabs mb-4" role="tablist" aria-label="Abas de relatórios">
          {TABS.map((item) => (
            <button
              type="button"
              key={item.id}
              role="tab"
              aria-selected={tab === item.id}
              className={`flex min-w-0 items-center justify-center gap-1 truncate ${tab === item.id ? "is-active" : ""}`}
              onClick={() => setTab(item.id)}
            >
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </div>

        {activeError ? (
          <p className="error mb-4" role="alert">{activeError instanceof Error ? activeError.message : "Falha ao carregar o relatório."}</p>
        ) : null}

        {activeLoading ? (
          <section className="card p-4 grid gap-2" role="status" aria-label="Carregando relatório">
            {[1, 2, 3, 4].map((row) => <div key={row} className="skeleton h-10" aria-hidden="true" />)}
          </section>
        ) : (
          <>
            {tab === "volume" && volume ? (
              <section className="card p-4 grid gap-4">
                {volumeSeries.hasData ? (
                  <LineAreaChart
                    data={volumeSeries.data}
                    series={[
                      { key: "total", label: "Total", tone: "primary", area: true },
                      { key: "open", label: "Abertas", tone: "info" },
                      { key: "closed", label: "Fechadas", tone: "success" },
                      { key: "pending", label: "Aguardando resposta", tone: "warning" }
                    ]}
                    ariaLabel="Conversas criadas por dia no período"
                  />
                ) : (
                  <ChartEmptyState />
                )}
                {volume.points.length === 0 ? (
                  <Empty>Nenhuma conversa criada neste período.</Empty>
                ) : (
                  <div className="responsive-table-wrap overflow-y-auto" style={{ maxHeight: 420 }}>
                    <table className="responsive-table leads-table">
                      <thead><tr><th>Dia</th><th>Total</th><th>Abertas</th><th>Fechadas</th><th>Aguardando resposta</th></tr></thead>
                      <tbody>
                        {volume.points.map((point) => (
                          <tr key={point.date} className="border-b border-[var(--border)] last:border-0">
                            <td className="mono">{point.date}</td>
                            <td>{point.total}</td>
                            <td>{point.open}</td>
                            <td>{point.closed}</td>
                            <td>{point.pending}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            ) : null}

            {tab === "agents" && agents ? (
              <section className="card p-4">
                {agents.items.length === 0 ? (
                  <Empty>Nenhum atendente ativo neste período.</Empty>
                ) : (
                  <div className="responsive-table-wrap overflow-y-auto" style={{ maxHeight: 560 }}>
                    <table className="responsive-table leads-table">
                      <thead><tr><th>Atendente</th><th>Conversas atendidas</th><th>Encerradas</th><th>Mensagens enviadas</th></tr></thead>
                      <tbody>
                        {agents.items.map((row) => (
                          <tr key={row.user_id} className="border-b border-[var(--border)] last:border-0">
                            <td data-label="Atendente"><strong>{row.name}</strong><span className="sub block">{row.email}</span></td>
                            <td>{row.answered}</td>
                            <td>{row.closed}</td>
                            <td>{row.messages_sent}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            ) : null}

            {tab === "status" && statusFlow ? (
              <section className="card p-4">
                {statusFlow.items.every((row) => row.total === 0) ? (
                  <Empty>Nenhuma conversa neste período.</Empty>
                ) : (
                  <div className="responsive-table-wrap overflow-y-auto" style={{ maxHeight: 560 }}>
                    <table className="responsive-table leads-table">
                      <thead><tr><th>Situação do contato</th><th>Conversas</th><th>Média até fechamento</th></tr></thead>
                      <tbody>
                        {statusFlow.items.filter((row) => row.total > 0).map((row) => (
                          <tr key={row.status} className="border-b border-[var(--border)] last:border-0">
                            <td>{leadStatusLabel(row.status)}</td>
                            <td>{row.total}</td>
                            <td>{formatMinutes(row.avg_close_minutes)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            ) : null}

            {tab === "quality" && quality ? (
              <div className="grid gap-4">
                <section className="card p-4">
                  <h2 className="text-base font-semibold">Fila agora</h2>
                  <p className="sub mt-1">{quality.queue.count} conversa(s) aguardando resposta · espera média {formatWait(quality.queue.avg_wait_seconds)}</p>
                  {quality.queue.items.length === 0 ? (
                    <div className="mt-3"><Empty>Ninguém aguardando neste momento.</Empty></div>
                  ) : (
                    <ul className="mt-3 grid gap-2">
                      {quality.queue.items.slice(0, 5).map((item) => (
                        <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--border)] px-3 py-2" key={item.conversation_id}>
                          <span><strong>{item.contact.name ?? "Sem nome"}</strong> <span className="mono text-xs text-[var(--text-secondary)]">{item.contact.phone}</span></span>
                          <span className="mono text-xs">esperando {formatWait(item.waiting_since_seconds)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <section className="card p-4">
                  <h2 className="text-base font-semibold">Primeira resposta</h2>
                  {quality.avg_first_response.length === 0 ? (
                    <Empty>Sem mensagens de contato neste período.</Empty>
                  ) : (
                    <table className="responsive-table leads-table mt-2">
                      <thead><tr><th>Atendente</th><th>1ª resposta média</th></tr></thead>
                      <tbody>
                        {quality.avg_first_response.map((row) => (
                          <tr key={row.user_id} className="border-b border-[var(--border)] last:border-0">
                            <td>{row.name}</td>
                            <td>{formatWait(row.seconds)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </section>
                <section className="card p-4">
                  <h2 className="text-base font-semibold"><HelpHint content="Atendentes sem enviar mensagens há mais de 3 dias." description={<>Ativos sem enviar mensagem há mais de 3 dias (considerando todo o workspace).</>}>Atentes ociosos</HelpHint></h2>
                  {quality.idle_agents.length === 0 ? (
                    <Empty>Nenhum atendente ocioso.</Empty>
                  ) : (
                    <ul className="mt-2 grid gap-1">
                      {quality.idle_agents.map((row) => (
                        <li key={row.user_id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                          <span>{row.name} <span className="sub">{row.email}</span></span>
                          <span className="mono text-xs">{row.last_message_at ? `última mensagem ${new Date(row.last_message_at).toLocaleDateString("pt-BR")}` : "nunca enviou mensagem"}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <section className="card p-4">
                  <h2 className="text-base font-semibold">Gargalos do pipeline</h2>
                  {quality.bottlenecks.length === 0 ? (
                    <Empty>Sem gargalos: nenhuma etapa com conversas paradas.</Empty>
                  ) : (
                    <table className="responsive-table leads-table mt-2">
                      <thead><tr><th>Etapa</th><th>Conversas</th><th>Tempo médio na etapa</th></tr></thead>
                      <tbody>
                        {quality.bottlenecks.map((row) => (
                          <tr key={row.stage_id} className="border-b border-[var(--border)] last:border-0">
                            <td>{row.stage_name}</td>
                            <td>{row.contacts}</td>
                            <td>{formatMinutes(row.avg_minutes)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </section>
              </div>
            ) : null}
          </>
        )}

        <p className="sub mt-4">Período: {effectiveFrom} a {effectiveTo} (fuso {timezone}).</p>
      </div>
    </Shell>
  );
}
