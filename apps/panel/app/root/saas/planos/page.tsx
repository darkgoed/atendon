"use client";

import { useState, type FormEvent } from "react";
import useSWR from "swr";
import { Empty } from "@/components/page-state";
import { ModalDialog } from "@/components/modal-dialog";
import { Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { canAccessRootWorkspace, type PanelSession } from "@/lib/session";

type Plan = { id: string; code?: string; name: string; priceCents?: number; price_cents?: number; status?: string; features?: Record<string, boolean>; limits?: Record<string, number | null> };
type Catalog = { features?: Array<{ key: string; name?: string; displayName?: string }>; limits?: Array<{ key: string; name?: string; displayName?: string }> };
const fetcher = <T,>(url: string) => api<T>(url);
const price = (plan: Plan) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format((plan.priceCents ?? plan.price_cents ?? 0) / 100);

export default function RootPlansPage() {
  const { data: session } = useSWR<PanelSession>("/me", fetcher, { revalidateOnFocus: false });
  const root = Boolean(session && canAccessRootWorkspace(session));
  const { data, error, mutate } = useSWR<{ plans: Plan[] }>(root ? "/root/saas/plans" : null, fetcher, { revalidateOnFocus: false });
  const { data: catalog } = useSWR<Catalog>(root ? "/root/saas/catalog" : null, fetcher, { revalidateOnFocus: false });
  const [selected, setSelected] = useState<Plan | null>(null);
  const [archive, setArchive] = useState<Plan | null>(null);
  const [message, setMessage] = useState("");
  const plans = data?.plans ?? [];

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return;
    const form = new FormData(event.currentTarget);
    try {
      const payload = { name: String(form.get("name") ?? "").trim(), priceCents: Number(form.get("priceCents") ?? 0) };
      await api(selected.id ? `/root/saas/plans/${selected.id}` : "/root/saas/plans", { method: selected.id ? "PATCH" : "POST", body: JSON.stringify(payload) });
      setSelected(null); await mutate();
    } catch (saveError) { setMessage(saveError instanceof Error ? saveError.message : "Não foi possível salvar o plano."); }
  }
  async function archivePlan() {
    if (!archive) return;
    try { await api(`/root/saas/plans/${archive.id}/archive`, { method: "POST" }); setArchive(null); await mutate(); }
    catch (archiveError) { setMessage(archiveError instanceof Error ? archiveError.message : "Não foi possível arquivar o plano."); }
  }
  async function patchMatrix(key: string, kind: "feature" | "limit", value: boolean | number | null) {
    if (!selected) return;
    const features = { ...selected.features }; const limits = { ...selected.limits };
    if (kind === "feature") features[key] = Boolean(value); else limits[key] = value as number | null;
    try { await api(`/root/saas/plans/${selected.id}`, { method: "PATCH", body: JSON.stringify({ features, limits }) }); setSelected({ ...selected, features, limits }); await mutate(); }
    catch (patchError) { setMessage(patchError instanceof Error ? patchError.message : "Não foi possível atualizar a matriz."); }
  }

  return <Shell><header className="pagehead" style={{ "--eyebrow": '"PAINEL · ROOT"' } as React.CSSProperties}><div><h1>Planos SaaS</h1><p>Catálogo comercial, preços e limites de uso.</p></div><button className="btn primary" type="button" onClick={() => setSelected({ id: "", name: "", priceCents: 0, features: {}, limits: {} })}>Criar plano</button></header>
    {message ? <p className="error mb-4" role="alert">{message}</p> : null}
    {!root ? <div className="card"><p>Esta área está disponível apenas para usuários ROOT.</p></div> : error ? <p className="error" role="alert">Não foi possível carregar os planos.</p> : !data ? <div className="card">Carregando…</div> : plans.length === 0 ? <Empty>Nenhum plano cadastrado.</Empty> : <section className="card admin-card"><div className="admin-table-wrap responsive-table-wrap"><table className="admin-table responsive-table"><thead><tr><th>Plano</th><th>Preço</th><th>Status</th><th>Features</th><th>Ações</th></tr></thead><tbody>{plans.map((plan) => <tr key={plan.id}><td data-label="Plano"><strong>{plan.name}</strong><span className="sub mono">{plan.code}</span></td><td data-label="Preço">{price(plan)}</td><td data-label="Status"><span className="admin-badge">{plan.status ?? "ativo"}</span></td><td data-label="Features">{Object.values(plan.features ?? {}).filter(Boolean).length}</td><td data-label="Ações"><div className="admin-actions"><button className="btn" type="button" onClick={() => setSelected(plan)}>Editar</button><button className="btn warn" type="button" onClick={() => setArchive(plan)}>Arquivar</button></div></td></tr>)}</tbody></table></div></section>}
    {selected ? <ModalDialog labelledBy="plan-dialog-title" onClose={() => setSelected(null)}><form className="card admin-card" onSubmit={save}><div className="cardtitle"><span id="plan-dialog-title">{selected.id ? "Editar plano" : "Criar plano"}</span></div><div className="admin-form"><label className="field"><span className="label">Nome</span><input className="input" name="name" defaultValue={selected.name} required /></label><label className="field"><span className="label">Preço (centavos)</span><input className="input" name="priceCents" type="number" min="0" defaultValue={selected.priceCents ?? selected.price_cents ?? 0} required /></label>{selected.id ? <div className="border-y border-[var(--border)] py-3"><span className="label">Matriz de features e limites</span>{(catalog?.features ?? []).map((item) => <label className="field mt-2" key={item.key}><span>{item.displayName ?? item.name ?? item.key}</span><input type="checkbox" checked={selected.features?.[item.key] === true} onChange={(event) => void patchMatrix(item.key, "feature", event.target.checked)} /></label>)}{(catalog?.limits ?? []).map((item) => <label className="field mt-2" key={item.key}><span>{item.displayName ?? item.name ?? item.key}</span><input className="input" type="number" value={selected.limits?.[item.key] ?? ""} onChange={(event) => void patchMatrix(item.key, "limit", event.target.value === "" ? null : Number(event.target.value))} /></label>)}</div> : null}<div className="admin-actions"><button className="btn primary" type="submit">Salvar</button><button className="btn" type="button" onClick={() => setSelected(null)}>Cancelar</button></div></div></form></ModalDialog> : null}
    {archive ? <ModalDialog labelledBy="archive-title" onClose={() => setArchive(null)}><div className="card"><h2 id="archive-title">Arquivar plano?</h2><p className="sub mt-2">O plano {archive.name} deixará de ser oferecido.</p><div className="admin-actions mt-4"><button className="btn warn" type="button" onClick={() => void archivePlan()}>Confirmar</button><button className="btn" type="button" onClick={() => setArchive(null)}>Cancelar</button></div></div></ModalDialog> : null}
  </Shell>;
}
