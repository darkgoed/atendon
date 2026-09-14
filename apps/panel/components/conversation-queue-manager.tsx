"use client";

import { ArrowDown, ArrowUp, Check, PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { type CSSProperties, type ReactElement, useEffect, useState } from "react";
import useSWR from "swr";
import { api } from "@/lib/api";
import { usePermission } from "@/lib/use-permission";

type Queue = { id: string; name: string; color: string; position: number; is_initial: boolean; is_resolved: boolean; archived_at: string | null; conversation_count: number };
type QueueResponse = { queues: Queue[] };
const DEFAULT_QUEUE_COLOR = "";
const fetcher = (url: string) => api<QueueResponse>(url);

export function ConversationQueueManager({ onSaved }: { onSaved?: () => void | Promise<void> }): ReactElement {
  const canManage = usePermission("conversations.queues.manage");
  const { data, error, isLoading, mutate } = useSWR<QueueResponse>(canManage ? "/conversation-queues?include_archived=true" : null, fetcher, { revalidateOnFocus: false });
  const [createDraft, setCreateDraft] = useState({ name: "", color: DEFAULT_QUEUE_COLOR });
  const [editDraft, setEditDraft] = useState({ name: "", color: DEFAULT_QUEUE_COLOR });
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    const tokenColor = getComputedStyle(document.documentElement).getPropertyValue("--cat-1").trim();
    if (!tokenColor) return;
    setCreateDraft((current) => current.color ? current : { ...current, color: tokenColor });
    setEditDraft((current) => current.color ? current : { ...current, color: tokenColor });
  }, []);
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
    try { await api("/conversation-queues", { method: "POST", body: JSON.stringify({ name, color: createDraft.color }) }); setCreateDraft({ name: "", color: DEFAULT_QUEUE_COLOR }); await refresh(); }
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
    <button type="button" className="flex w-full items-center justify-between gap-2 text-left" onClick={() => setCollapsed((value) => !value)} aria-expanded={!collapsed} aria-controls="conversation-queues-content"><span id="conversation-queues-title" className="cardtitle">Filas de atendimento</span><span className="text-xs ">{active.length} ativas {collapsed ? "＋" : "－"}</span></button>
    {!collapsed ? <div id="conversation-queues-content">
    <div className="mt-3 grid grid-cols-[minmax(0,1fr)_3rem_auto] gap-2"><label className="field"><span className="label">Nova fila</span><input className="input" value={createDraft.name} maxLength={60} onChange={(event) => setCreateDraft((current) => ({ ...current, name: event.target.value }))} disabled={busy !== null} /></label><label className="field"><span className="label">Cor</span><input className="input h-10 p-1" type="color" value={createDraft.color} onChange={(event) => setCreateDraft((current) => ({ ...current, color: event.target.value }))} disabled={busy !== null} /></label><button type="button" className="btn primary self-end" onClick={() => void create()} disabled={busy !== null}><Plus size={14} /> {busy === "create" ? "Criando…" : "Criar"}</button></div>
    {isLoading ? <p className="mt-3 text-xs " role="status">Carregando filas…</p> : error ? <p className="error mt-3" role="alert">Não foi possível carregar as filas.</p> : null}
    {errorMessage ? <p className="error mt-3" role="alert">{errorMessage}</p> : null}
    <div className="mt-3 grid gap-2">{active.map((queue, index) => editing === queue.id ? <div key={queue.id} className="grid grid-cols-[minmax(0,1fr)_3rem_auto] gap-2 rounded border  p-2"><input className="input" value={editDraft.name} maxLength={60} onChange={(event) => setEditDraft((current) => ({ ...current, name: event.target.value }))} aria-label={`Nome da fila ${queue.name}`} /><input className="input h-10 p-1" type="color" value={editDraft.color} onChange={(event) => setEditDraft((current) => ({ ...current, color: event.target.value }))} aria-label={`Cor da fila ${queue.name}`} /><span className="flex gap-1"><button type="button" className="btn p-2" onClick={() => void save(queue)} disabled={busy === queue.id} aria-label="Salvar fila"><Check size={14} /></button><button type="button" className="btn p-2" onClick={() => setEditing(null)} disabled={busy === queue.id} aria-label="Cancelar edição">×</button></span></div> : <div key={queue.id} className="flex items-center gap-2 rounded border  p-2"><span className="conversation-queue-dot size-3 shrink-0 rounded-full" style={{ "--queue-color": queue.color } as CSSProperties} aria-hidden="true" /><span className="min-w-0 flex-1 truncate text-sm">{queue.name}</span><span className="text-xs ">{queue.conversation_count}</span>{queue.is_initial ? <span className="text-xs ">Inicial</span> : null}{queue.is_resolved ? <span className="text-xs ">Resolvida</span> : null}<button type="button" className="btn p-1.5" onClick={() => { setEditing(queue.id); setEditDraft({ name: queue.name, color: queue.color }); }} aria-label={`Editar fila ${queue.name}`}><PencilSimple size={13} /></button><button type="button" className="btn p-1.5" onClick={() => void move(index, -1)} disabled={busy !== null || index === 0} aria-label="Mover fila para cima"><ArrowUp size={13} /></button><button type="button" className="btn p-1.5" onClick={() => void move(index, 1)} disabled={busy !== null || index === active.length - 1} aria-label="Mover fila para baixo"><ArrowDown size={13} /></button><button type="button" className="btn p-1.5" onClick={() => void archive(queue)} disabled={busy !== null || queue.is_initial || queue.is_resolved} aria-label={`Arquivar fila ${queue.name}`}><Trash size={13} /></button></div>)}</div>
    </div> : null}
  </section>;
}
