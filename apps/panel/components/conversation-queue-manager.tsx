"use client";

import { ArrowDown, ArrowUp, Check, DotsThreeVertical, PencilSimple, Plus, Trash, X } from "@/components/icons";
import { type ReactElement, useState } from "react";
import useSWR from "swr";
import { api } from "@/lib/api";
import { SETTINGS_COLOR_DEFAULTS } from "@/components/settings-colors";
import { PopoverMenu } from "@/components/popover-menu";
import { IconButton, SaveButton, SaveToast, useSaveFeedback } from "@/components/ui";
import { usePermission } from "@/lib/use-permission";

type Queue = { id: string; name: string; color: string; position: number; is_initial: boolean; is_resolved: boolean; archived_at: string | null; conversation_count: number };
type QueueResponse = { queues: Queue[] };
const DEFAULT_QUEUE_COLOR = SETTINGS_COLOR_DEFAULTS.conversationQueue;
const fetcher = (url: string) => api<QueueResponse>(url);

export function ConversationQueueManager({ onSaved }: { onSaved?: () => void | Promise<void> }): ReactElement {
  const canManage = usePermission("conversations.queues.manage");
  const { data, error, isLoading, mutate } = useSWR<QueueResponse>(canManage ? "/conversation-queues?include_archived=true" : null, fetcher, { revalidateOnFocus: false });
  const [createDraft, setCreateDraft] = useState<{ name: string; color: string }>({ name: "", color: DEFAULT_QUEUE_COLOR });
  const [editDraft, setEditDraft] = useState<{ name: string; color: string }>({ name: "", color: DEFAULT_QUEUE_COLOR });
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [collapsed, setCollapsed] = useState(true);
  const createSave = useSaveFeedback();

  if (!canManage) return <></>;
  const queues = data?.queues ?? [];
  const active = queues.filter((queue) => !queue.archived_at);

  async function refresh() {
    await mutate();
    await onSaved?.();
  }
  async function create() {
    const name = createDraft.name.trim();
    if (!name) { setErrorMessage("Informe um nome para a fila."); return; }
    setBusy("create"); setErrorMessage("");
    try { await api("/conversation-queues", { method: "POST", body: JSON.stringify({ name, color: createDraft.color }) }); setCreateDraft({ name: "", color: DEFAULT_QUEUE_COLOR }); createSave.markDone(); await refresh(); }
    catch (caught) { setErrorMessage(caught instanceof Error ? caught.message : "Falha ao criar a fila"); }
    finally { setBusy(null); }
  }
  async function save(queue: Queue) {
    const name = editDraft.name.trim();
    if (!name) { setErrorMessage("Informe um nome para a fila."); return; }
    setBusy(queue.id); setErrorMessage("");
    try { await api(`/conversation-queues/${queue.id}`, { method: "PATCH", body: JSON.stringify({ name, color: editDraft.color }) }); setEditing(null); await refresh(); }
    catch (caught) { setErrorMessage(caught instanceof Error ? caught.message : "Falha ao editar a fila"); }
    finally { setBusy(null); }
  }
  async function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= active.length) return;
    const ids = [...active.map((queue) => queue.id)];
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setBusy("reorder"); setErrorMessage("");
    try { await api("/conversation-queues/reorder", { method: "POST", body: JSON.stringify({ ids }) }); await refresh(); }
    catch (caught) { setErrorMessage(caught instanceof Error ? caught.message : "Falha ao ordenar as filas"); }
    finally { setBusy(null); }
  }
  async function archive(queue: Queue) {
    if (queue.is_initial || queue.is_resolved) return;
    setBusy(queue.id); setErrorMessage("");
    try { await api(`/conversation-queues/${queue.id}`, { method: "DELETE" }); await refresh(); }
    catch (caught) { setErrorMessage(caught instanceof Error ? caught.message : "Falha ao arquivar a fila"); }
    finally { setBusy(null); }
  }

  return <section className="card" aria-labelledby="conversation-queues-title">
    <button type="button" className="flex w-full items-center justify-between gap-2 text-left" onClick={() => setCollapsed((value) => !value)} aria-expanded={!collapsed} aria-controls="conversation-queues-content"><span id="conversation-queues-title" className="cardtitle">Filas de atendimento</span><span className="text-xs text-[var(--text-muted)]">{active.length} ativas {collapsed ? "＋" : "－"}</span></button>
    {!collapsed ? <div id="conversation-queues-content">
    <div className="mt-3 grid grid-cols-[minmax(0,1fr)_3rem_auto] gap-2"><label className="field"><span className="label">Nova fila</span><input className="input" value={createDraft.name} maxLength={60} onChange={(event) => setCreateDraft((current) => ({ ...current, name: event.target.value }))} disabled={busy !== null} /></label><label className="field"><span className="label">Cor</span><input className="input" type="color" value={createDraft.color} onChange={(event) => setCreateDraft((current) => ({ ...current, color: event.target.value }))} disabled={busy !== null} /></label><SaveButton type="button" state={busy === "create" ? "busy" : createSave.state} busyLabel="Criando…" className="self-end" icon={<Plus size={14} aria-hidden="true" />} disabled={busy !== null} onClick={() => void create()}>Criar</SaveButton></div>
    {isLoading ? <p className="mt-3 text-xs text-[var(--text-muted)]" role="status">Carregando filas…</p> : error ? <p className="error mt-3" role="alert">Não foi possível carregar as filas.</p> : null}
    {errorMessage ? <p className="error mt-3" role="alert">{errorMessage}</p> : null}
    <SaveToast show={createSave.done}>Fila criada</SaveToast>
    <div className="mt-3 grid gap-2">{active.map((queue, index) => editing === queue.id ? <div key={queue.id} className="grid grid-cols-[minmax(0,1fr)_3rem_auto] gap-2 rounded border border-[var(--border)] p-2"><input className="input" value={editDraft.name} maxLength={60} onChange={(event) => setEditDraft((current) => ({ ...current, name: event.target.value }))} aria-label={`Nome da fila ${queue.name}`} /><input className="input" type="color" value={editDraft.color} onChange={(event) => setEditDraft((current) => ({ ...current, color: event.target.value }))} aria-label={`Cor da fila ${queue.name}`} /><span className="flex gap-1"><IconButton type="button" label="Salvar fila" disabled={busy === queue.id} onClick={() => void save(queue)}><Check size={14} aria-hidden="true" /></IconButton><IconButton type="button" label="Cancelar edição" disabled={busy === queue.id} onClick={() => setEditing(null)}><X size={14} aria-hidden="true" /></IconButton></span></div> : <div key={queue.id} className="flex items-center gap-2 rounded border border-[var(--border)] p-2"><span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: queue.color }} aria-hidden="true" /><span className="min-w-0 flex-1 truncate text-sm">{queue.name}</span><span className="text-xs text-[var(--text-muted)]">{queue.conversation_count}</span>{queue.is_initial ? <span className="text-xs text-[var(--text-muted)]">Inicial</span> : null}{queue.is_resolved ? <span className="text-xs text-[var(--text-muted)]">Resolvida</span> : null}<IconButton type="button" label={`Editar fila ${queue.name}`} onClick={() => { setEditing(queue.id); setEditDraft({ name: queue.name, color: queue.color }); }}><PencilSimple size={13} aria-hidden="true" /></IconButton><PopoverMenu
  buttonClassName="btn shrink-0"
  icon={<DotsThreeVertical size={13} weight="bold" aria-hidden="true" />}
  ariaLabel={`Mais ações da fila ${queue.name}`}
  title="Mais ações"
  align="end"
  panelClassName="conversation-action-menu__panel"
>{(close) => <>
  <button type="button" className="conversation-action-menu__item" onClick={() => { void move(index, -1); close(); }} disabled={busy !== null || index === 0} aria-label="Mover fila para cima"><ArrowUp size={15} aria-hidden="true" /> Mover para cima</button>
  <button type="button" className="conversation-action-menu__item" onClick={() => { void move(index, 1); close(); }} disabled={busy !== null || index === active.length - 1} aria-label="Mover fila para baixo"><ArrowDown size={15} aria-hidden="true" /> Mover para baixo</button>
  <button type="button" className="conversation-action-menu__item conversation-action-menu__item--warn" onClick={() => { if (window.confirm(`Arquivar a fila "${queue.name}"? Ela sai da lista de filas ativas.`)) { void archive(queue); close(); } }} disabled={busy !== null || queue.is_initial || queue.is_resolved}><Trash size={15} aria-hidden="true" /> Arquivar fila</button>
</>}</PopoverMenu></div>)}</div>
    </div> : null}
  </section>;
}
