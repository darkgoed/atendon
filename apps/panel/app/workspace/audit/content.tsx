"use client";

import { MagnifyingGlass } from "@/components/icons";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { AuditLogTable } from "@/components/audit-log-table";
import { LoadingCards } from "@/components/page-state";
import { api } from "@/lib/api";
import { filterAuditLogs, type AuditLogEntry } from "@/lib/audit-ui";
import { AdminMetric, AdminMetricGrid, AdminPage, AdminPageHeader, AdminSection } from "@/components/admin";
import { HelpHint } from "@/components/ui";

const fetcher = <T,>(url: string) => api<T>(url);

export function WorkspaceAuditContent() {
  const { data, error } = useSWR<{ auditLogs: AuditLogEntry[] }>("/workspaces/current/audit-logs", fetcher, { revalidateOnFocus: false });
  const [query, setQuery] = useState("");
  const logs = useMemo(() => data?.auditLogs ?? [], [data?.auditLogs]);
  const filtered = useMemo(() => filterAuditLogs(logs, query), [logs, query]);

  return (
    <AdminPage>
      <AdminPageHeader title={<>Auditoria do workspace <HelpHint label="Ajuda: Auditoria do workspace">Registro de quem fez o quê no workspace, do mais recente para o mais antigo — incluindo ações de usuários ROOT com acesso elevado.</HelpHint></>} actions={
        <label className="search-field admin-search">
          <MagnifyingGlass aria-hidden="true" />
          <span className="sr-only">Filtrar eventos do workspace</span>
          <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filtrar ação, ator ou recurso" />
        </label>
      } />

      {error ? <p className="error mb-4" role="alert">{error.message}</p> : null}
      {!data && !error ? <LoadingCards label="Carregando auditoria do workspace" /> : null}
      {data ? (
        <>
          <AdminMetricGrid>
            <AdminMetric label="Eventos" value={logs.length} detail="até 200 registros" />
            <AdminMetric label="ROOT assistido" value={logs.filter((log) => log.actor_scope === "root").length} detail="ações com escopo elevado" tone="warning" />
            <AdminMetric label="Operadores" value={new Set(logs.map((log) => log.actor_email).filter(Boolean)).size} detail="atores únicos" />
            <AdminMetric label="Filtrados" value={filtered.length} detail="pela busca atual" tone="primary" />
          </AdminMetricGrid>

          <AdminSection className="card admin-card" title="Eventos recentes" description="ordem decrescente">
            <AuditLogTable logs={filtered} />
          </AdminSection>
        </>
      ) : null}
    </AdminPage>
  );
}
