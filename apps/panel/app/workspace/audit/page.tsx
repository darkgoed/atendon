"use client";

import { MagnifyingGlass } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { AuditLogTable } from "@/components/audit-log-table";
import { LoadingCards } from "@/components/page-state";
import { Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { filterAuditLogs, type AuditLogEntry } from "@/lib/audit-ui";

const fetcher = <T,>(url: string) => api<T>(url);

export default function WorkspaceAuditPage() {
  const { data, error } = useSWR<{ auditLogs: AuditLogEntry[] }>("/workspaces/current/audit-logs", fetcher, { revalidateOnFocus: false });
  const [query, setQuery] = useState("");
  const logs = useMemo(() => data?.auditLogs ?? [], [data?.auditLogs]);
  const filtered = useMemo(() => filterAuditLogs(logs, query), [logs, query]);

  return (
    <Shell>
      <header className="pagehead">
        <div>
          <h1>Auditoria do workspace</h1>
          <p>Leitura operacional das ações sensíveis executadas no tenant atual.</p>
        </div>
        <label className="search-field admin-search">
          <MagnifyingGlass aria-hidden="true" />
          <span className="sr-only">Filtrar eventos do workspace</span>
          <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filtrar ação, ator ou recurso" />
        </label>
      </header>

      {error ? <p className="error mb-4" role="alert">{error.message}</p> : null}
      {!data && !error ? <LoadingCards label="Carregando auditoria do workspace" /> : null}
      {data ? (
        <>
          <section className="grid4">
            <Metric label="Eventos" value={logs.length} detail="até 200 registros" />
            <Metric label="ROOT assistido" value={logs.filter((log) => log.actor_scope === "root").length} detail="ações com escopo elevado" />
            <Metric label="Operadores" value={new Set(logs.map((log) => log.actor_email).filter(Boolean)).size} detail="atores únicos" />
            <Metric label="Filtrados" value={filtered.length} detail="pela busca atual" />
          </section>

          <section className="card admin-card">
            <div className="cardtitle">
              <span>Eventos recentes</span>
              <span className="sub">ordem decrescente</span>
            </div>
            <AuditLogTable logs={filtered} />
          </section>
        </>
      ) : null}
    </Shell>
  );
}

function Metric({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <div className="card">
      <span className="label">{label}</span>
      <div className="metric mono">{value}</div>
      <p className="sub">{detail}</p>
    </div>
  );
}
