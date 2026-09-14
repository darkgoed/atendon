"use client";

import {
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ClipboardText,
  FloppyDisk,
  PencilSimple,
  Plus,
  SpinnerGap,
  X
} from "@phosphor-icons/react";
import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import useSWR from "swr";
import { ModalDialog } from "@/components/modal-dialog";
import { Shell } from "@/components/shell";
import { Input } from "@/components/ui";
import { api } from "@/lib/api";
import { isPostSaleVersionConflict, type PostSaleTemplateItem } from "@/lib/post-sales";

type TemplateResponse = { items: PostSaleTemplateItem[] };
const fetcher = <T,>(url: string) => api<T>(url);

export default function PostSalesChecklistSettingsPage() {
  const { data, error: loadError, isLoading, mutate } = useSWR<TemplateResponse>(
    "/post-sales/checklist-template/items",
    fetcher,
    { refreshInterval: 15_000, revalidateOnFocus: true }
  );
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  function cancelEditing(itemId: string) {
    setEditingId(null);
    requestAnimationFrame(() => editButtonRefs.current[itemId]?.focus());
  }
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pendingArchive, setPendingArchive] = useState<PostSaleTemplateItem | null>(null);
  const active = data?.items.filter((item) => !item.archived_at) ?? [];
  const archived = data?.items.filter((item) => Boolean(item.archived_at)) ?? [];

  async function createItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const description = String(new FormData(form).get("description") ?? "").trim();
    if (!description) return;
    setCreating(true);
    setError("");
    setMessage("");
    try {
      await api("/post-sales/checklist-template/items", {
        method: "POST",
        body: JSON.stringify({ description })
      });
      form.reset();
      await mutate();
      setMessage("Item adicionado como pendente para todos os clientes ativos.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao adicionar item");
    } finally {
      setCreating(false);
    }
  }

  async function renameItem(event: FormEvent<HTMLFormElement>, item: PostSaleTemplateItem) {
    event.preventDefault();
    const description = String(new FormData(event.currentTarget).get("description") ?? "").trim();
    if (!description) return;
    setPendingId(item.id);
    setError("");
    try {
      await api(`/post-sales/checklist-template/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ version: item.version, description })
      });
      await mutate();
      setEditingId(null);
      setMessage("Descrição atualizada.");
    } catch (caught) {
      if (isPostSaleVersionConflict(caught)) await mutate();
      setError(isPostSaleVersionConflict(caught)
        ? "Este item mudou em outra sessão. A lista foi recarregada."
        : caught instanceof Error ? caught.message : "Falha ao editar item");
    } finally {
      setPendingId(null);
    }
  }

  async function moveItem(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= active.length || pendingId) return;
    const reordered = [...active];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    setPendingId(active[index].id);
    setError("");
    try {
      const response = await api<TemplateResponse>("/post-sales/checklist-template/order", {
        method: "PUT",
        body: JSON.stringify({ items: reordered.map((item) => ({ id: item.id, version: item.version })) })
      });
      await mutate(response, false);
      setMessage("Ordem do checklist salva.");
    } catch (caught) {
      if (isPostSaleVersionConflict(caught)) await mutate();
      setError(isPostSaleVersionConflict(caught)
        ? "A ordem mudou em outra sessão. Recarregamos a lista."
        : caught instanceof Error ? caught.message : "Falha ao ordenar itens");
    } finally {
      setPendingId(null);
    }
  }

  async function setArchived(item: PostSaleTemplateItem, archive: boolean) {
    if (pendingId) return;
    setPendingId(item.id);
    setError("");
    setMessage("");
    try {
      await api(`/post-sales/checklist-template/items/${item.id}/${archive ? "archive" : "restore"}`, {
        method: "POST",
        body: JSON.stringify({ version: item.version })
      });
      await mutate();
      setMessage(archive
        ? "Item arquivado. As respostas anteriores foram preservadas."
        : "Item restaurado e copiado para clientes ativos que ainda não o possuíam.");
    } catch (caught) {
      if (isPostSaleVersionConflict(caught)) await mutate();
      setError(caught instanceof Error ? caught.message : "Falha ao atualizar item");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <Shell>
      <header className="pagehead post-sales-head">
        <div>
          <h1>Configurar checklist</h1>
          <p>Defina a sequência real da empresa. Novos itens chegam pendentes aos clientes ativos.</p>
        </div>
        <Link className="btn" href="/pos-venda"><ArrowLeft size={16} aria-hidden="true" /> Voltar à carteira</Link>
      </header>

      {message ? <p className="post-sales-feedback accent" role="status">{message}</p> : null}
      {error ? <p className="post-sales-feedback error" role="alert">{error}</p> : null}
      {loadError ? <div className="post-sales-failure" role="alert"><strong>Não foi possível carregar o checklist</strong><p>{loadError.message}</p><button className="btn warn" type="button" onClick={() => void mutate()}>Tentar novamente</button></div> : null}

      <div className="post-sales-template-layout">
        <section className="post-sales-template-main">
          <form className="post-sales-template-create" onSubmit={createItem} aria-busy={creating}>
            <label className="field">
              <span className="label">Novo item</span>
              <span className="post-sales-template-create__input">
                <Input name="description" placeholder="Ex.: oferecer treinamento da equipe" maxLength={500} required disabled={creating} />
                <button className="btn primary" type="submit" disabled={creating}><Plus size={16} aria-hidden="true" /> {creating ? "Adicionando…" : "Adicionar"}</button>
              </span>
            </label>
            <p>O item será incluído como pendente, sem alterar respostas já registradas.</p>
          </form>

          <section className="post-sales-template-section" aria-labelledby="active-template-title">
            <div className="post-sales-section-title">
              <div><span className="label">Modelo ativo</span><h2 id="active-template-title">Sequência do atendimento</h2></div>
              <span className="mono">{active.length} item(ns)</span>
            </div>
            {isLoading && !data ? <div className="post-sales-template-skeleton" role="status" aria-label="Carregando itens">{[1, 2, 3].map((item) => <div className="skeleton" key={item} aria-hidden="true" />)}</div>
              : active.length === 0 ? (
                <div className="post-sales-checklist-empty" role="status"><ClipboardText size={30} aria-hidden="true" /><strong>Comece pelo primeiro compromisso</strong><p>O checklist nasce vazio para refletir o processo real desta empresa.</p></div>
              ) : (
                <ol className="post-sales-template-list">
                  {active.map((item, index) => (
                    <li key={item.id} className="post-sales-template-item" aria-busy={pendingId === item.id}>
                      <span className="post-sales-template-item__position mono">{String(index + 1).padStart(2, "0")}</span>
                      {editingId === item.id ? (
                        <form className="post-sales-template-item__edit" onSubmit={(event) => void renameItem(event, item)}>
                          <label className="field"><span className="sr-only">Descrição do item</span><Input name="description" defaultValue={item.description} required data-autofocus disabled={pendingId === item.id} /></label>
                          <button className="btn primary" type="submit" aria-label="Salvar descrição" disabled={pendingId === item.id}><FloppyDisk size={15} aria-hidden="true" /> Salvar</button>
                          <button className="btn" type="button" aria-label="Cancelar edição" onClick={() => cancelEditing(item.id)}><X size={15} aria-hidden="true" /></button>
                        </form>
                      ) : (
                        <div className="post-sales-template-item__copy"><strong>{item.description}</strong><span>{item.answered_count} resposta(s) em {item.client_count} cliente(s)</span></div>
                      )}
                      <div className="post-sales-template-item__actions">
                        {pendingId === item.id ? <SpinnerGap className="post-sales-spin" size={16} aria-label="Salvando" /> : null}
                        <button type="button" onClick={() => void moveItem(index, -1)} disabled={index === 0 || Boolean(pendingId)} aria-label={`Mover ${item.description} para cima`} title="Mover para cima"><ArrowUp size={16} aria-hidden="true" /></button>
                        <button type="button" onClick={() => void moveItem(index, 1)} disabled={index === active.length - 1 || Boolean(pendingId)} aria-label={`Mover ${item.description} para baixo`} title="Mover para baixo"><ArrowDown size={16} aria-hidden="true" /></button>
                        <button type="button" ref={(node) => { editButtonRefs.current[item.id] = node; }} onClick={() => setEditingId(item.id)} disabled={Boolean(pendingId)} aria-label={`Editar ${item.description}`} title="Editar"><PencilSimple size={16} aria-hidden="true" /></button>
                        <button type="button" data-tone="danger" onClick={() => setPendingArchive(item)} disabled={Boolean(pendingId)} aria-label={`Arquivar ${item.description}`} title="Arquivar"><Archive size={16} aria-hidden="true" /></button>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
          </section>
        </section>

        <aside className="post-sales-template-aside">
          <div className="post-sales-template-note">
            <Check size={18} aria-hidden="true" />
            <div><strong>Histórico permanece íntegro</strong><p>Arquivar remove o item do progresso atual, mas conserva resultado, nota, responsável e data.</p></div>
          </div>
          <section aria-labelledby="archived-template-title">
            <div className="post-sales-section-title"><div><span className="label">Histórico</span><h2 id="archived-template-title">Itens arquivados</h2></div><span className="mono">{archived.length}</span></div>
            {archived.length === 0 ? <p className="post-sales-template-aside__empty">Nenhum item arquivado.</p> : (
              <div className="post-sales-template-archive-list">
                {archived.map((item) => (
                  <article key={item.id} aria-busy={pendingId === item.id}>
                    <div><strong>{item.description}</strong><span>{item.answered_count} resposta(s) preservada(s)</span></div>
                    <button className="btn" type="button" onClick={() => void setArchived(item, false)} disabled={Boolean(pendingId)}>{pendingId === item.id ? "Restaurando…" : "Restaurar"}</button>
                  </article>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>

      {pendingArchive ? (
        <ModalDialog labelledBy="confirm-archive-title" onClose={() => setPendingArchive(null)}>
          <h2 id="confirm-archive-title" className="text-base">Arquivar item</h2>
          <p className="post-sales-archive-confirmation">Arquivar &ldquo;{pendingArchive.description}&rdquo;? O histórico de respostas é mantido.</p>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => setPendingArchive(null)}>Cancelar</button>
            <button type="button" className="btn warn" data-autofocus onClick={() => { void setArchived(pendingArchive, true); setPendingArchive(null); }}>Arquivar</button>
          </div>
        </ModalDialog>
      ) : null}
    </Shell>
  );
}
