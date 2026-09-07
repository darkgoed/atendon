"use client";

import React from "react";
import useSWR from "swr";
import { Shell } from "@/components/shell";
import { api } from "@/lib/api";
import type { PanelSession } from "@/lib/session";

type BillingMetric = {
  tenantId: string;
  planId: string | null;
  overageInteractions: number;
  overageRevenueCents: number;
  providerCostBrlCents: number;
};

type MetricsResponse = { metrics: BillingMetric[] };

const fetcher = <T,>(url: string) => api<T>(url);
const money = (cents: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);

export default function MetricsPage() {
  const { data: session } = useSWR<PanelSession>("/me", fetcher, { revalidateOnFocus: false });
  const root = Boolean(session?.user.isRoot);
  const [filters, setFilters] = React.useState({ tenantId: "", planId: "", start: "", end: "" });
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString();
  const path = `/root/billing/metrics${query ? `?${query}` : ""}`;
  const { data, error } = useSWR<MetricsResponse>(root ? path : null, fetcher);
  const totals = (data?.metrics ?? []).reduce((result, metric) => ({
    revenueCents: result.revenueCents + metric.overageRevenueCents,
    costCents: result.costCents + metric.providerCostBrlCents,
    transactions: result.transactions + metric.overageInteractions,
  }), { revenueCents: 0, costCents: 0, transactions: 0 });
  const tenants = new Set((data?.metrics ?? []).map((metric) => metric.tenantId)).size;

  if (!root) return <Shell><div className="card"><p>Esta área está disponível apenas para usuários ROOT.</p></div></Shell>;

  return <Shell>
    <header className="pagehead"><div><h1>Métricas SaaS</h1><p>Agregados exatos de receita, custo e transações.</p></div></header>
    <section className="card">
      <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Filtros de métricas">
        {([["tenantId", "Tenant ID"], ["planId", "Plano ID"], ["start", "De"], ["end", "Até"]] as const).map(([name, label]) => <label className="field" key={name}>
          <span className="label">{label}</span>
          <input className="input" name={name} type={name === "start" || name === "end" ? "date" : "text"} value={filters[name]} onChange={(event) => setFilters({ ...filters, [name]: event.target.value })} />
        </label>)}
      </form>
    </section>
    {error ? <p className="error">Não foi possível carregar as métricas.</p> : !data ? <div className="card mt-4">Carregando…</div> : <section className="grid gap-4 mt-4 sm:grid-cols-2 lg:grid-cols-4">
      {([["Receita", money(totals.revenueCents)], ["Custo", money(totals.costCents)], ["Transações", totals.transactions.toLocaleString("pt-BR")], ["Empresas", tenants.toLocaleString("pt-BR")]] as const).map(([label, value]) => <article className="card" key={label}><p className="sub">{label}</p><strong className="text-xl">{value}</strong></article>)}
    </section>}
  </Shell>;
}