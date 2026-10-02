"use client";

/**
 * Desempenho do fluxo (C1-d da spec v7) — agregados do flow_execution_log
 * (GET /qualification/flows/:id/analytics, auto-refresh 30s conforme spec)
 * e histórico de execuções (GET /qualification/flows/:id/executions, keyset).
 * Leitura pura: nenhuma mutação; permissão agent.read é exigida pelo backend
 * e a página só abre o drawer para quem já lê o fluxo.
 */

import { useState } from "react";
import useSWR from "swr";
import { ModalDialog } from "@/components/modal-dialog";
import { Empty, LoadingCards } from "@/components/page-state";
import { api } from "@/lib/api";
import { formatPanelDateTime } from "@/lib/format";
import { HelpHint } from "@/components/ui";
import styles from "./flow-insights.module.css";



type Analytics = { executions: number; completed: number; errors: number };
type ExecutionRow = {
  id: string;
  conversation_id: string | null;
  lead_id: string | null;
  node_id: string;
  kind: string;
  status: string;
  detail: string | null;
  created_at: string;
};
type ExecutionsResponse = { executions: ExecutionRow[]; next_cursor: string | null };

const EXECUTIONS_PAGE = 20;

function statusPillClass(status: string): string {
  if (status === "completed") return "mono rounded-full border border-[var(--success-border)] px-2 py-0.5 type-caption font-semibold uppercase tracking-[.1em] text-[var(--success-text)]";
  if (status === "failed") return "mono rounded-full border border-[var(--danger-border, var(--warning-border))] px-2 py-0.5 type-caption font-semibold uppercase tracking-[.1em] text-[var(--warning-text)]";
  return "mono rounded-full border border-[var(--border)] px-2 py-0.5 type-caption font-semibold uppercase tracking-[.1em] text-[var(--text-muted)]";
}

export function FlowInsights({ flowId, onClose }: { flowId: string; onClose: () => void }) {
  /* Páginas do keyset: a primeira vem do SWR; as seguintes acumulam em "older".
     O cursor vivo é o next_cursor da ÚLTIMA página conhecida. */
  const [older, setOlder] = useState<ExecutionsResponse[]>([]);

  const analyticsFetcher = (url: string) => api<Analytics>(url);
  const { data: analytics, error: analyticsError, isLoading: analyticsLoading } = useSWR<Analytics>(
    `/qualification/flows/${flowId}/analytics`,
    analyticsFetcher,
    { refreshInterval: 30_000, revalidateOnFocus: false, dedupingInterval: 5_000 }
  );
  const firstPageKey = `/qualification/flows/${flowId}/executions?limit=${EXECUTIONS_PAGE}`;
  const executionsFetcher = (url: string) => api<ExecutionsResponse>(url);
  const { data: firstExecutions, error: executionsError } = useSWR<ExecutionsResponse>(firstPageKey, executionsFetcher, {
    revalidateOnFocus: false
  });

  const pages: ExecutionsResponse[] = firstExecutions ? [firstExecutions, ...older] : [];
  const rows: ExecutionRow[] = pages.flatMap((page) => page.executions);
  const nextCursor = pages.length ? pages[pages.length - 1].next_cursor : null;

  async function loadOlder() {
    if (!nextCursor) return;
    try {
      const response = await api<ExecutionsResponse>(`/qualification/flows/${flowId}/executions?limit=${EXECUTIONS_PAGE}&cursor=${encodeURIComponent(nextCursor)}`);
      setOlder((current) => [...current, response]);
    } catch {
      // O botão permanece: o usuário pode tentar de novo.
    }
  }

  const executionsLoadFailed = Boolean(executionsError);
  const analyticsFailed = Boolean(analyticsError);

  return (
    <ModalDialog labelledBy="flow-insights-title" onClose={onClose} dialogClassName={`action-dialog ${styles.insightsDialog}`}>
      <h2 id="flow-insights-title" className="text-base font-semibold">Desempenho do fluxo <HelpHint label="Ajuda: Desempenho">Contagens desde a criação do fluxo e as execuções mais recentes. Atualiza sozinho a cada 30 segundos.</HelpHint></h2>

      {analyticsFailed ? (
        <p className="error mt-3" role="alert">{analyticsError instanceof Error ? analyticsError.message : "Não foi possível carregar os agregados."}</p>
      ) : analyticsLoading ? (
        <LoadingCards />
      ) : analytics ? (
        <div className="grid4 mt-3">
          <div className="card"><span className="label">Execuções</span><div className="metric">{analytics.executions}</div><p className="sub">contatos que passaram pelo fluxo</p></div>
          <div className="card"><span className="label">Concluídos</span><div className="metric">{analytics.completed}</div><p className="sub">alcançaram o fim</p></div>
          <div className="card"><span className="label">Erros</span><div className="metric">{analytics.errors}</div><p className="sub">etapas com falha</p></div>
        </div>
      ) : null}

      <h3 className="mt-4 text-sm font-semibold">Últimas execuções</h3>
      {executionsLoadFailed ? (
        <p className="error mt-2" role="alert">{executionsError instanceof Error ? executionsError.message : "Não foi possível carregar as execuções."}</p>
      ) : rows.length === 0 && firstExecutions ? (
        <div className="mt-2"><Empty>Nenhuma execução registrada ainda — o fluxo roda quando um contato dispara o gatilho.</Empty></div>
      ) : rows.length === 0 ? (
        <div className="mt-2 grid gap-2" role="status" aria-label="Carregando execuções">
          {[1, 2, 3].map((row) => <div key={row} className="skeleton h-8" aria-hidden="true" />)}
        </div>
      ) : (
        <ul className="mt-2 grid gap-1" aria-label="Histórico de execuções">
          {rows.map((row) => (
            <li className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--border)] px-2 py-1.5 text-sm" key={row.id}>
              <span className={statusPillClass(row.status)}>{row.status === "completed" ? "ok" : row.status === "failed" ? "erro" : row.status}</span>
              <span className="mono text-xs">{row.kind}</span>
              <span className="mono text-xs text-[var(--text-secondary)]">{row.node_id}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-secondary)]" title={row.detail ?? undefined}>{row.detail ?? ""}</span>
              <time className="mono shrink-0 text-xs">{formatPanelDateTime(row.created_at)}</time>
            </li>
          ))}
        </ul>
      )}
      {nextCursor ? (
        <div className="mt-3 flex justify-center">
          <button type="button" className="btn" onClick={() => void loadOlder()}>Carregar mais execuções</button>
        </div>
      ) : null}
    </ModalDialog>
  );
}
