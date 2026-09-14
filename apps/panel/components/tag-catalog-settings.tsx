"use client";

import { Archive, Plus, Tag, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { api } from "@/lib/api";
import { useCaseOrganizationEnabled } from "@/lib/organization";
import { usePermission } from "@/lib/use-permission";
import { Button, Field, Input } from "@/components/ui";
import { SETTINGS_COLOR_DEFAULTS } from "@/components/settings-colors";
import styles from "@/components/settings-panels.module.css";

type CatalogTag = { id: string; name: string; color: string; archived_at?: string | null };
const fetcher = <T,>(url: string) => api<T>(url);

export function TagCatalogSettings() {
  const canManage = usePermission("tags.manage");
  const organizationEnabled = useCaseOrganizationEnabled();
  const { data, error, isLoading, mutate } = useSWR<{ tags: CatalogTag[] }>(canManage && organizationEnabled === true ? "/organization/tags?include_archived=true" : null, fetcher, { revalidateOnFocus: false });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(SETTINGS_COLOR_DEFAULTS.tag);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState("");

  if (!canManage || organizationEnabled !== true) return null;

  async function create() {
    if (!name.trim() || pending) return;
    setPending(true); setActionError("");
    try {
      await api("/organization/tags", { method: "POST", body: JSON.stringify({ name: name.trim(), color }) });
      setName("");
      await mutate();
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : "Falha ao criar etiqueta"); }
    finally { setPending(false); }
  }

  return <>
    <Button onClick={() => setOpen(true)}><Tag size={15} aria-hidden="true" />Catálogo</Button>
    {open ? <div className="fixed inset-0 z-30 grid place-items-end bg-[color-mix(in_srgb,var(--app)_68%,transparent)] sm:place-items-center" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setOpen(false); }}>
      <section className="max-h-[88dvh] tag-dialog-width w-full overflow-y-auto rounded-t-2xl border border-[var(--border)] bg-[var(--dialog)] p-4 sm:rounded-xl sm:p-5" role="dialog" aria-modal="true" aria-labelledby="tag-catalog-title">
        <header className="mb-5 flex items-start justify-between gap-4"><div><h2 id="tag-catalog-title" className="text-lg font-semibold">Catálogo de etiquetas</h2><p className="mt-1 text-xs text-[var(--muted)]">O mesmo catálogo é usado em Conversas, Leads e Pipeline.</p></div><button type="button" className="grid size-9 place-items-center rounded border border-[var(--border)] active:scale-[.94]" onClick={() => setOpen(false)} aria-label="Fechar catálogo"><X size={16} /></button></header>
        {isLoading ? <div className="grid gap-2" role="status" aria-label="Carregando catálogo">{[1, 2, 3].map((item) => <span key={item} className="skeleton h-12" />)}</div> : null}
        {error ? <p className="error" role="alert">{error.message}</p> : null}
        <div className="grid gap-2">{data?.tags.map((tag) => <TagEditor key={tag.id} tag={tag} onChanged={mutate} />)}</div>
        {!isLoading && !error && !data?.tags.length ? <p className="py-5 text-center text-sm text-[var(--muted)]">Crie a primeira etiqueta para organizar os leads.</p> : null}
        <section className={styles.dialogSection}><h3 className="text-sm font-semibold">Nova etiqueta</h3><div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_5rem]"><Field label="Nome"><Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} /></Field><Field label="Cor"><Input className="h-10 p-1" type="color" value={color} onChange={(event) => setColor(event.target.value.toUpperCase())} /></Field></div><Button tone="primary" className="mt-3" onClick={() => void create()} disabled={!name.trim() || pending}><Plus size={15} aria-hidden="true" />{pending ? "Criando…" : "Criar etiqueta"}</Button>{actionError ? <p className="error mt-2" role="alert">{actionError}</p> : null}</section>
      </section>
    </div> : null}
  </>;
}

function TagEditor({ tag, onChanged }: { tag: CatalogTag; onChanged: () => unknown | Promise<unknown> }) {
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState(tag.color);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setName(tag.name);
    setColor(tag.color);
  }, [tag.color, tag.name]);
  async function patch(body: Record<string, unknown>) {
    setPending(true); setError("");
    try { await api(`/organization/tags/${tag.id}`, { method: "PATCH", body: JSON.stringify(body) }); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao atualizar etiqueta"); }
    finally { setPending(false); }
  }
  return <div className={`grid gap-2 rounded border border-[var(--border)] p-3 ${tag.archived_at ? "opacity-55" : ""}`}><div className="grid grid-cols-[minmax(0,1fr)_64px_auto] items-end gap-2"><label className="field"><span className="label">Nome</span><input className="input" value={name} onChange={(event) => setName(event.target.value)} disabled={Boolean(tag.archived_at)} /></label><label className="field"><span className="label">Cor</span><input className="input h-10 p-1" type="color" value={color} onChange={(event) => setColor(event.target.value.toUpperCase())} disabled={Boolean(tag.archived_at)} /></label>{tag.archived_at ? <span className="pb-2 type-caption uppercase text-[var(--faint)]">Arquivada</span> : <button type="button" className="btn" onClick={() => void patch({ name: name.trim(), color })} disabled={pending || !name.trim()}>Salvar</button>}</div>{!tag.archived_at ? <button type="button" className="justify-self-start type-label text-[var(--warn)] hover:underline active:scale-[.98]" onClick={() => { if (window.confirm(`Arquivar a etiqueta “${tag.name}”?`)) void patch({ archived: true }); }} disabled={pending}><Archive size={13} className="mr-1 inline" aria-hidden="true" />Arquivar</button> : null}{error ? <p className="error" role="alert">{error}</p> : null}</div>;
}
