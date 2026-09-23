"use client";

import { MagnifyingGlass } from "@/components/icons";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { AuditLogTable } from "@/components/audit-log-table";
import { LoadingCards } from "@/components/page-state";
import { Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { filterAuditLogs, type AuditLogEntry } from "@/lib/audit-ui";
import type { PanelSession } from "@/lib/session";
import { AdminPage, AdminPageHeader, AdminSection } from "@/components/admin";

const fetcher = <T,>(url: string) => api<T>(url);

export default function RootAuditPage() {
  const { data: session } = useSWR<PanelSession>("/me", fetcher, { revalidateOnFocus: false, dedupingInterval: 10_000 });
  const { data, error } = useSWR<{ auditLogs: AuditLogEntry[] }>(session?.user.isRoot ? "/root/audit-logs" : null, fetcher, { revalidateOnFocus: false });
  const [query, setQuery] = useState("");
  const logs = useMemo(() => data?.auditLogs ?? [], [data?.auditLogs]);
  const filtered = useMemo(() => filterAuditLogs(logs, query, true), [logs, query]);

  return (
    <Shell>
      <AdminPage>
      <AdminPageHeader title="Auditoria ROOT" actions={
        <label className="search-field admin-search">
          <MagnifyingGlass aria-hidden="true" />
          <span className="sr-only">Filtrar eventos globais</span>
          <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filtrar workspace, ator ou ação" />
        </label>
      } />

      {error ? <p className="error mb-4" role="alert">{error.message}</p> : null}
      {!data && !error ? <LoadingCards label="Carregando auditoria global" /> : null}
      {data ? (
        <AdminSection className="card admin-card" title="Eventos globais" description={`${filtered.length} registro(s)`}>
          <AuditLogTable logs={filtered} showWorkspace />
        </AdminSection>
      ) : null}
      </AdminPage>
    </Shell>
  );
}
