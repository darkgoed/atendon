"use client";

import { ArrowLeft, MagnifyingGlass } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { Empty } from "@/components/page-state";
import { Shell } from "@/components/shell";
import { Input, Select, TableScroll } from "@/components/ui";
import { api } from "@/lib/api";
import {
  buildPostSaleDebtsQuery,
  EMPTY_POST_SALE_DEBT_FILTERS,
  formatPostSaleDebtAmount,
  formatPostSaleDebtDate,
  formatPostSaleDebtPhone,
  type PostSaleDebt,
  type PostSaleDebtFilters,
  type PostSaleDebtsSummary
} from "@/lib/post-sales-debts";

type DebtsResponse = { summary: PostSaleDebtsSummary; debts: PostSaleDebt[] };
type OptionsResponse = { stores: string[]; statuses: string[] };
const fetcher = <T,>(url: string) => api<T>(url);

function statusClass(status: string | null) {
  if (status === "Pago" || status === "Pago parcialmente") return "accent";
  if (status === "Promessa") return "warn";
  return "";
}

export default function PostSaleDebtsPage() {
  const [filters, setFilters] = useState<PostSaleDebtFilters>({ ...EMPTY_POST_SALE_DEBT_FILTERS });
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(filters.q.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [filters.q]);

  const query = useMemo(() => buildPostSaleDebtsQuery({ ...filters, q: debouncedSearch }), [debouncedSearch, filters]);
  const { data, error, isLoading } = useSWR<DebtsResponse>(`/post-sales/debts?${query}`, fetcher, {
    revalidateOnFocus: false
  });
  const { data: options } = useSWR<OptionsResponse>("/post-sales/debts/options", fetcher, { revalidateOnFocus: false });
  const debts = data?.debts ?? [];
  const change = <K extends keyof PostSaleDebtFilters>(key: K, value: PostSaleDebtFilters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));

  return (
    <Shell>
      <header className="pagehead post-sales-pagehead">
        <div>
          <Link className="btn post-sales-back-link" href="/pos-venda"><ArrowLeft size={16} aria-hidden="true" /> Voltar</Link>
          <h1>Cobranças de crediário</h1>
        </div>
        <span className="mono post-sales-result-count" role="status" aria-live="polite">
          {isLoading ? "carregando…" : `${debts.length} resultado(s)`}
        </span>
      </header>

      {data?.summary ? (
        <section className="card post-sales-billing-summary grid gap-3 sm:grid-cols-2 md:grid-cols-4">
          <SummaryTile label="Total de registros" value={String(data.summary.total)} />
          <SummaryTile label="Pagos" value={String(data.summary.paid)} />
          <SummaryTile label="Em aberto" value={formatPostSaleDebtAmount(data.summary.amount_open_total)} />
          <SummaryTile label="Recuperado" value={formatPostSaleDebtAmount(data.summary.amount_recovered_total)} />
        </section>
      ) : null}

      <section className="card post-sales-billing-filters grid gap-3 sm:grid-cols-2 md:grid-cols-3">
        <label className="field">
          <span className="label">Busca</span>
          <span className="search-field"><MagnifyingGlass aria-hidden="true" /><Input value={filters.q} onChange={(event) => change("q", event.target.value)} placeholder="Nome ou telefone" /></span>
        </label>
        <label className="field">
          <span className="label">Loja</span>
          <Select value={filters.store} onChange={(event) => change("store", event.target.value)}>
            <option value="">Todas</option>
            {options?.stores.map((store) => <option key={store} value={store}>{store}</option>)}
          </Select>
        </label>
        <label className="field">
          <span className="label">Status</span>
          <Select value={filters.status} onChange={(event) => change("status", event.target.value)}>
            <option value="">Todos</option>
            {options?.statuses.map((status) => <option key={status} value={status}>{status}</option>)}
          </Select>
        </label>
      </section>

      {error ? <p className="error post-sales-billing-error" role="alert">{error.message}</p> : null}

      <section className="card responsive-table-wrap p-0">
        {isLoading ? (
          <div className="post-sales-billing-skeleton" role="status" aria-label="Carregando cobranças">
            {[1, 2, 3, 4].map((item) => <div key={item} className="skeleton" aria-hidden="true" />)}
          </div>
        ) : debts.length === 0 ? <Empty>Nenhuma cobrança corresponde aos filtros.</Empty> : (
          <TableScroll className="post-sales-billing-table-wrap"><table className="responsive-table post-sales-billing-table">
            <thead>
              <tr>
                {["Loja", "Cliente", "Telefone", "Em aberto", "Recuperado", "Status", "Motivo", "Promessa", "Dias sem contato", "Alerta"].map((label) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {debts.map((debt) => (
                <tr key={debt.id}>
                  <td data-label="Loja">{debt.store}</td>
                  <td data-label="Cliente"><strong>{debt.customer_name}</strong></td>
                  <td data-label="Telefone" className="mono">{formatPostSaleDebtPhone(debt.phone_e164)}</td>
                  <td data-label="Em aberto" className="mono">{formatPostSaleDebtAmount(debt.amount_open)}</td>
                  <td data-label="Recuperado" className="mono">{formatPostSaleDebtAmount(debt.amount_recovered)}</td>
                  <td data-label="Status"><span className={statusClass(debt.status)}>{debt.status ?? "—"}</span></td>
                  <td data-label="Motivo">{debt.reason ?? "—"}</td>
                  <td data-label="Promessa" className="mono">{formatPostSaleDebtDate(debt.promise_date)}</td>
                  <td data-label="Dias sem contato" className="mono">{debt.days_without_contact ?? "—"}</td>
                  <td data-label="Alerta" className="post-sales-debt-alert">{debt.alert ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table></TableScroll>
        )}
      </section>
    </Shell>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="label">{label}</span>
      <strong className="mono post-sales-summary-value">{value}</strong>
    </div>
  );
}
