"use client";

import { MagnifyingGlass } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { AuditLogTable } from "@/components/audit-log-table";
import { LoadingCards } from "@/components/page-state";
import { Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { filterAuditLogs, type AuditLogEntry } from "@/lib/audit-ui";
import type { PanelSession } from "@/lib/session";

const fetcher = <T,>(url: string) => api<T>(url);

export default function RootAuditPage() {
  const { data: session } = useSWR<PanelSession>("/me", fetcher, { revalidateOnFocus: false, dedupingInterval: 10_000 });
  const { data, error } = useSWR<{ auditLogs: AuditLogEntry[] }>(session?.user.isRoot ? "/root/audit-logs" : null, fetcher, { revalidateOnFocus: false });
  const [query, setQuery] = useState("");
  const logs = useMemo(() => data?.auditLogs ?? [], [data?.auditLogs]);
  const filtered = useMemo(() => filterAuditLogs(logs, query, true), [logs, query]);

  return (
    <Shell>
      <header className="pagehead" style={{ "--eyebrow": '"PAINEL · ROOT"' } as React.CSSProperties}>
        <div>
          <h1>Auditoria ROOT</h1>
          <p>Eventos globais com contexto de workspace, úteis para trilha administrativa e acesso assistido.</p>
        </div>
        <label className="search-field admin-search">
          <MagnifyingGlass aria-hidden="true" />
          <span className="sr-only">Filtrar eventos globais</span>
          <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filtrar workspace, ator ou ação" />
        </label>
      </header>

      {error ? <p className="error mb-4" role="alert">{error.message}</p> : null}
      {!data && !error ? <LoadingCards label="Carregando auditoria global" /> : null}
      {data ? (
        <section className="card admin-card">
          <div className="cardtitle">
            <span>Eventos globais</span>
            <span className="sub">{filtered.length} registro(s)</span>
          </div>
          <AuditLogTable logs={filtered} showWorkspace />
        </section>
      ) : null}
    </Shell>
  );
}
