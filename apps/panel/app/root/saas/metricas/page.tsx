"use client";

import React from "react";
import useSWR from "swr";
import { Shell } from "@/components/shell";
import { api } from "@/lib/api";
import type { PanelSession } from "@/lib/session";

type Metrics = { revenueCents: number; costCents: number; transactions: number; tenants: number; period?: { from: string; to: string } };
const fetcher = <T,>(url: string) => api<T>(url);
const money = (cents: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
export default function MetricsPage() {
  const { data: session } = useSWR<PanelSession>("/me", fetcher, { revalidateOnFocus: false });
  const root = Boolean(session?.user.isRoot);
  const [filters, setFilters] = React.useState({ tenantId: "", planCode: "", from: "", to: "" });
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
  const { data, error } = useSWR<Metrics>(root ? `/root/saas/metrics?${query}` : null, fetcher);
  if (!root) return <Shell><div className="card"><p>Esta área está disponível apenas para usuários ROOT.</p></div></Shell>;
  return <Shell><header className="pagehead"><div><h1>Métricas SaaS</h1><p>Agregados exatos de receita, custo e transações.</p></div></header><section className="card"><form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Filtros de métricas">{([["tenantId", "Tenant"], ["planCode", "Plano"], ["from", "De"], ["to", "Até"]] as const).map(([name, label]) => <label className="field" key={name}><span className="label">{label}</span><input className="input" name={name} type={name === "from" || name === "to" ? "date" : "text"} value={filters[name]} onChange={(e) => setFilters({ ...filters, [name]: e.target.value })} /></label>)}</form></section>{error ? <p className="error">Não foi possível carregar as métricas.</p> : !data ? <div className="card mt-4">Carregando…</div> : <section className="grid gap-4 mt-4 sm:grid-cols-2 lg:grid-cols-4">{([["Receita", money(data.revenueCents)], ["Custo", money(data.costCents)], ["Transações", data.transactions.toLocaleString("pt-BR")], ["Empresas", data.tenants.toLocaleString("pt-BR")]] as const).map(([label, value]) => <article className="card" key={label}><p className="sub">{label}</p><strong className="text-xl">{value}</strong></article>)}</section>}</Shell>;
}
