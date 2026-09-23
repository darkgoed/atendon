"use client";

/**
 * Tarefas (R6 v6): lista com filtros mine/team (equipe exige tasks.assign),
 * status e prioridade; CRUD em dialog do design system; concluir, excluir,
 * responsável, contato relacionado, prazo e prioridade. Paginação keyset:
 * o poll (20s) refetcha SÓ a página 1 — "Carregar mais" anexa páginas antigas
 * por cursor, dedup por id mantendo a cópia fresca da página 1.
 */

import { Check, PencilSimple, Plus, Trash, X } from "@/components/icons";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { Shell } from "@/components/shell";
import { Badge, Button, Dialog, EmptyState, Field, IconButton, Input, SaveButton, SaveToast, Segmented, Select, Textarea, useSaveFeedback } from "@/components/ui";
import { api } from "@/lib/api";
import { canAccessWithSession, type PanelSession } from "@/lib/session";
import { groupTasksByDay, type AgendaGroup } from "./tasks-agenda";
import styles from "./tarefas.module.css";

type TaskStatus = "aberta" | "em_andamento" | "concluida";
type TaskPriority = "baixa" | "media" | "alta";

type Task = {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_at: string | null;
  assignee: { id: string; name: string | null } | null;
  author: { id: string; name: string | null };
  lead: { id: string; name: string | null; phone: string | null } | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type TasksResponse = { items: Task[]; page: { limit: number; has_more: boolean; next_cursor: string | null } };
type MembersResponse = { members: { user_id: string; name: string | null; email: string; status: string }[] };
type LeadSearchResponse = { leads: { id: string; nome?: string; telefone: string }[] };

type RelatedLead = { id: string; name: string | null; phone: string | null };

const PAGE_SIZE = 30;
const fetcher = <T,>(url: string) => api<T>(url);

const STATUS_LABELS: Record<TaskStatus, string> = { aberta: "Aberta", em_andamento: "Em andamento", concluida: "Concluída" };
const PRIORITY_LABELS: Record<TaskPriority, string> = { baixa: "Baixa", media: "Média", alta: "Alta" };
const STATUS_TONES: Record<TaskStatus, "neutral" | "info" | "success"> = { aberta: "neutral", em_andamento: "info", concluida: "success" };
const PRIORITY_TONES: Record<TaskPriority, "neutral" | "warning" | "danger"> = { baixa: "neutral", media: "warning", alta: "danger" };

const STATUS_FILTER_OPTIONS: TaskStatus[] = ["aberta", "em_andamento", "concluida"];
const PRIORITY_FILTER_OPTIONS: TaskPriority[] = ["baixa", "media", "alta"];

/** Visão "Agenda pessoal" (spec tarefas-agenda-pessoal): Lista | Agenda. */
const TASKS_VIEW_KEY = "atendon-tasks-view";
type TasksView = "lista" | "agenda";

function readTasksView(): TasksView {
  try {
    return localStorage.getItem(TASKS_VIEW_KEY) === "agenda" ? "agenda" : "lista";
  } catch {
    return "lista";
  }
}

function storeTasksView(view: TasksView) {
  try {
    localStorage.setItem(TASKS_VIEW_KEY, view);
  } catch {
    // Sem storage, sem persistência.
  }
}

const dateTimeFormatter = (timezone?: string) => new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: timezone || undefined
});

function formatDue(value: string, timezone?: string): string {
  try {
    return dateTimeFormatter(timezone).format(new Date(value));
  } catch {
    return value;
  }
}

/** ISO do backend → valor de <input type="datetime-local"> no fuso local. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function isOverdue(task: Task): boolean {
  if (task.status === "concluida" || !task.due_at) return false;
  const due = new Date(task.due_at).getTime();
  return Number.isFinite(due) && due < Date.now();
}

function displayName(name: string | null, fallback: string): string {
  return name?.trim() || fallback;
}

function TaskDialog({
  open,
  task,
  canAssign,
  currentUserId,
  onClose,
  onSaved
}: {
  open: boolean;
  task: Task | null;
  canAssign: boolean;
  currentUserId: string;
  onClose: () => void;
  onSaved: (task: Task, created: boolean) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("media");
  const [dueLocal, setDueLocal] = useState("");
  const [relatedLead, setRelatedLead] = useState<RelatedLead | null>(null);
  const [leadQuery, setLeadQuery] = useState("");
  const [debouncedLeadQuery, setDebouncedLeadQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const { data: membersData } = useSWR<MembersResponse>(open && canAssign ? "/workspaces/current/members" : null, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 30_000,
    shouldRetryOnError: false
  });
  const members = useMemo(
    () => (membersData?.members ?? []).filter((member) => member.status === "active"),
    [membersData]
  );

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedLeadQuery(leadQuery.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [leadQuery]);

  const leadSearchKey = open && !task && debouncedLeadQuery.length >= 2
    ? `/scheduling/leads?busca=${encodeURIComponent(debouncedLeadQuery)}&limit=8`
    : null;
  const { data: leadSearchData, isLoading: leadSearchLoading } = useSWR<LeadSearchResponse>(leadSearchKey, fetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false
  });
  const leadOptions = leadSearchData?.leads ?? [];

  // Recarrega o formulário sempre que o dialog abre (criar ou editar).
  useEffect(() => {
    if (!open) return;
    setTitle(task?.title ?? "");
    setDescription(task?.description ?? "");
    setAssigneeId(task?.assignee?.id ?? (!canAssign && task ? currentUserId : ""));
    setPriority(task?.priority ?? "media");
    setDueLocal(toLocalInput(task?.due_at ?? null));
    setRelatedLead(task?.lead ?? null);
    setLeadQuery("");
    setDebouncedLeadQuery("");
    setError("");
  }, [open, task, canAssign, currentUserId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError("");
    try {
      const dueIso = dueLocal ? new Date(dueLocal).toISOString() : null;
      if (Number.isNaN(new Date(dueLocal).getTime()) && dueLocal) throw new Error("Prazo inválido");
      let saved: Task;
      if (task) {
        const response = await api<{ task: Task }>(`/tasks/${task.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            title: trimmed,
            description: description.trim() ? description.trim() : null,
            ...(canAssign ? { assignee_id: assigneeId || null } : {}),
            priority,
            due_at: dueIso
          })
        });
        saved = response.task;
      } else {
        const response = await api<{ task: Task }>("/tasks", {
          method: "POST",
          body: JSON.stringify({
            title: trimmed,
            description: description.trim() ? description.trim() : null,
            assignee_id: canAssign ? (assigneeId || null) : currentUserId,
            priority,
            due_at: dueIso,
            lead_id: relatedLead?.id ?? null
          })
        });
        saved = response.task;
      }
      onSaved(saved, !task);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao salvar a tarefa");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={task ? "Editar tarefa" : "Nova tarefa"}
      description={task ? "Atualize título, responsável, prazo e prioridade." : "Crie uma tarefa para você ou atribua a um membro da equipe."}
    >
      <form id="task-dialog-form" className="grid gap-3" onSubmit={submit}>
        <Field label="Título">
          <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={500} required placeholder="Ex.: Enviar proposta revisada" />
        </Field>
        <Field label="Descrição">
          <Textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={10000} placeholder="Detalhes, contexto e próximo passo" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Prioridade">
            <Select value={priority} onChange={(event) => setPriority(event.target.value as TaskPriority)}>
              {(["baixa", "media", "alta"] as const).map((value) => <option key={value} value={value}>{PRIORITY_LABELS[value]}</option>)}
            </Select>
          </Field>
          <Field label="Prazo">
            <Input type="datetime-local" value={dueLocal} onChange={(event) => setDueLocal(event.target.value)} />
          </Field>
        </div>
        {canAssign ? (
          <Field label="Responsável">
            <Select value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}>
              <option value="">Sem responsável</option>
              {members.map((member) => (
                <option key={member.user_id} value={member.user_id}>{displayName(member.name, member.email)} · {member.email}</option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="Responsável" hint="Somente gestores podem atribuir tarefas a outras pessoas.">
            <Input value="Você" readOnly disabled />
          </Field>
        )}
        {!task ? (
          <Field label="Contato relacionado" hint="Busque pelo nome ou telefone para vincular a tarefa a um contato.">
            {relatedLead ? (
              <span className={styles.leadChip}>
                <strong>{relatedLead.name?.trim() || relatedLead.phone || "Contato"}</strong>
                {relatedLead.phone ? <span className="mono">{relatedLead.phone}</span> : null}
                <button type="button" className="btn quiet icon-button icon-button--sm" onClick={() => setRelatedLead(null)} aria-label="Remover contato relacionado">
                  <X size={14} aria-hidden="true" />
                </button>
              </span>
            ) : (
              <div className={styles.leadSearch}>
                <Input
                  value={leadQuery}
                  onChange={(event) => setLeadQuery(event.target.value)}
                  placeholder="Buscar contato por nome ou telefone"
                  aria-label="Buscar contato relacionado"
                  role="combobox"
                  aria-expanded={leadOptions.length > 0}
                  aria-controls="task-lead-options"
                />
                {leadQuery.trim().length >= 2 ? (
                  <ul id="task-lead-options" className={styles.leadOptions} role="listbox" aria-label="Contatos encontrados">
                    {leadOptions.length ? leadOptions.map((lead, index) => (
                      <li key={lead.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={false}
                          data-active={index === 0}
                          className={styles.leadOption}
                          onClick={() => {
                            setRelatedLead({ id: lead.id, name: lead.nome ?? null, phone: lead.telefone });
                            setLeadQuery("");
                          }}
                        >
                          <span>{lead.nome?.trim() || "Contato sem nome"}</span>
                          <span className="mono">{lead.telefone}</span>
                        </button>
                      </li>
                    )) : (
                      <li className={styles.leadOptionEmpty} aria-live="polite">{leadSearchLoading ? "Buscando…" : "Nenhum contato encontrado."}</li>
                    )}
                  </ul>
                ) : null}
              </div>
            )}
          </Field>
        ) : task.lead ? (
          <Field label="Contato relacionado" hint="O contato relacionado não pode ser alterado após a criação.">
            <Input value={`${task.lead.name?.trim() || "Contato sem nome"}${task.lead.phone ? ` · ${task.lead.phone}` : ""}`} readOnly disabled />
          </Field>
        ) : null}
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={saving}>Cancelar</Button>
          <SaveButton type="submit" state={saving ? "busy" : "idle"} disabled={!title.trim()}>
            {task ? "Salvar tarefa" : "Criar tarefa"}
          </SaveButton>
        </div>
      </form>
    </Dialog>
  );
}

/** Card de tarefa compartilhado pela visão Lista e pela Agenda (mesmo markup). */
function TaskCard({
  task,
  timezone,
  onToggle,
  onEdit,
  onRemove
}: {
  task: Task;
  timezone?: string;
  onToggle: (task: Task) => void;
  onEdit: (task: Task) => void;
  onRemove: (task: Task) => void;
}) {
  return (
    <article className={`${styles.task}${task.status === "concluida" ? ` ${styles.taskDone}` : ""}`} data-task-id={task.id}>
      <div className={styles.taskBody}>
        <h3 className={styles.taskTitle}>{task.title}</h3>
        {task.description ? <p className={styles.taskDescription}>{task.description}</p> : null}
        <div className={styles.taskMeta}>
          <Badge tone={STATUS_TONES[task.status]} variant="pill">{STATUS_LABELS[task.status]}</Badge>
          <Badge tone={PRIORITY_TONES[task.priority]} variant="outline">Prioridade {PRIORITY_LABELS[task.priority]}</Badge>
          {task.lead ? (
            <span className={styles.taskMetaItem}>
              {task.lead.name?.trim() || "Contato sem nome"}{task.lead.phone ? ` · ${task.lead.phone}` : ""}
            </span>
          ) : null}
        </div>
      </div>
      <div className={styles.taskSide}>
        <span className={styles.taskMetaItem}>Resp.: {task.assignee ? displayName(task.assignee.name, "sem nome") : "Sem responsável"}</span>
        {task.due_at ? (
          <span className={`${styles.due}${isOverdue(task) ? ` ${styles.dueOverdue}` : ""}`}>
            Prazo: {formatDue(task.due_at, timezone)}
          </span>
        ) : null}
        <div className={styles.taskActions}>
          <IconButton
            size="sm"
            label={task.status === "concluida" ? `Reabrir tarefa: ${task.title}` : `Concluir tarefa: ${task.title}`}
            tone={task.status === "concluida" ? "quiet" : "primary"}
            onClick={() => onToggle(task)}
          >
            <Check size={14} aria-hidden="true" />
          </IconButton>
          <IconButton size="sm" label={`Editar tarefa: ${task.title}`} onClick={() => onEdit(task)}><PencilSimple size={14} aria-hidden="true" /></IconButton>
          <IconButton size="sm" tone="danger" label={`Excluir tarefa: ${task.title}`} onClick={() => onRemove(task)}><Trash size={14} aria-hidden="true" /></IconButton>
        </div>
      </div>
    </article>
  );
}

export default function TasksPage() {
  const save = useSaveFeedback();
  const { data: session } = useSWR<PanelSession>("/me", fetcher, { revalidateOnFocus: false, dedupingInterval: 10_000 });
  const currentUserId = session?.user.id ?? "";
  const canAssign = Boolean(session && canAccessWithSession(session, ["tasks.assign"]));
  const timezone = session?.activeWorkspace?.timezone;

  const [scope, setScope] = useState<"mine" | "team">("mine");
  const [statusFilter, setStatusFilter] = useState<"" | TaskStatus>("");
  const [priorityFilter, setPriorityFilter] = useState<"" | TaskPriority>("");
  const [view, setView] = useState<TasksView>("lista");
  // Preferência lida APÓS a hidratação (mesmo padrão da sidebar no shell):
  // o SSR renderiza "lista" e o client adota o valor persistido sem mismatch.
  useEffect(() => { setView(readTasksView()); }, []);

  function changeView(next: TasksView) {
    setView(next);
    storeTasksView(next);
  }

  const listKey = useMemo(() => {
    const params = new URLSearchParams({ scope, limit: String(PAGE_SIZE) });
    if (statusFilter) params.set("status", statusFilter);
    if (priorityFilter) params.set("priority", priorityFilter);
    return `/tasks?${params.toString()}`;
  }, [scope, statusFilter, priorityFilter]);

  const [extraTasks, setExtraTasks] = useState<Task[]>([]);
  const [pageState, setPageState] = useState<{ cursor: string | null; hasMore: boolean; fetchedPages: number }>({ cursor: null, hasMore: false, fetchedPages: 0 });
  const [loadingMore, setLoadingMore] = useState(false);
  const [dialog, setDialog] = useState<{ open: boolean; task: Task | null }>({ open: false, task: null });
  const [listError, setListError] = useState("");

  const { data, error, isLoading, mutate } = useSWR<TasksResponse>(listKey, fetcher, {
    refreshInterval: 20_000,
    revalidateOnFocus: false,
    dedupingInterval: 5_000
  });

  useEffect(() => {
    setExtraTasks([]);
    setPageState({ cursor: null, hasMore: false, fetchedPages: 0 });
    setLoadingMore(false);
  }, [listKey]);

  // O cursor âncora vem da página 1 e nunca é sobrescrito pelo poll quando
  // páginas extras já existem (senão "Carregar mais" duplicaria linhas).
  useEffect(() => {
    const page = data?.page;
    if (!page || pageState.fetchedPages > 0) return;
    setPageState((current) => current.fetchedPages > 0 ? current : { cursor: page.next_cursor, hasMore: page.has_more, fetchedPages: 0 });
  }, [data?.page, pageState.fetchedPages]);

  const tasks = useMemo(() => {
    const fresh = data?.items ?? [];
    if (!extraTasks.length) return fresh;
    const seen = new Set(fresh.map((task) => task.id));
    const merged = [...fresh];
    for (const task of extraTasks) {
      if (!seen.has(task.id)) {
        seen.add(task.id);
        merged.push(task);
      }
    }
    return merged;
  }, [data?.items, extraTasks]);

  // Agenda agrupa a MESMA lista carregada — nenhum fetch novo ao trocar de visão.
  const agendaGroups = useMemo<AgendaGroup<Task>[]>(
    () => view === "agenda" ? groupTasksByDay(tasks, new Date(), timezone) : [],
    [view, tasks, timezone]
  );
  const openEditor = (task: Task) => setDialog({ open: true, task });
  const loadMoreControl = pageState.hasMore ? (
    <div className={styles.loadMore}>
      <Button onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? "Carregando…" : "Carregar mais"}</Button>
    </div>
  ) : null;

  async function loadMore() {
    if (loadingMore || !pageState.cursor) return;
    setLoadingMore(true);
    setListError("");
    try {
      const cursorQuery = `cursor=${encodeURIComponent(pageState.cursor)}`;
      const response = await api<TasksResponse>(`${listKey}&${cursorQuery}`);
      setExtraTasks((current) => {
        const freshIds = new Set((data?.items ?? []).map((task) => task.id));
        const merged = [...current];
        for (const task of response.items) {
          if (![...freshIds, ...merged.map((item) => item.id)].includes(task.id)) merged.push(task);
        }
        return merged;
      });
      setPageState((current) => ({ ...current, cursor: response.page?.next_cursor ?? null, hasMore: Boolean(response.page?.has_more), fetchedPages: current.fetchedPages + 1 }));
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : "Falha ao carregar mais tarefas");
    } finally {
      setLoadingMore(false);
    }
  }

  function applyTaskUpdate(updated: Task) {
    // Atualiza a cópia local (inclusive páginas antigas) e revalida a página 1.
    setExtraTasks((current) => current.map((task) => task.id === updated.id ? updated : task));
    void mutate();
  }

  async function toggleDone(task: Task) {
    const nextStatus: TaskStatus = task.status === "concluida" ? "em_andamento" : "concluida";
    try {
      const response = await api<{ task: Task }>(`/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ status: nextStatus }) });
      applyTaskUpdate(response.task);
    } catch {
      // api() já reporta o erro global; o estado local permanece coerente.
    }
  }

  async function removeTask(task: Task) {
    if (!window.confirm(`Excluir a tarefa “${task.title}”? Esta ação não pode ser desfeita.`)) return;
    try {
      await api(`/tasks/${task.id}`, { method: "DELETE" });
      setExtraTasks((current) => current.filter((item) => item.id !== task.id));
      void mutate();
    } catch {
      // Erro reportado pelo tratador global.
    }
  }

  return (
    <Shell>
      <div className={styles.page}>
        <header className="pagehead">
          <div>
            <div className="mono mb-3 flex items-center gap-2 type-caption uppercase tracking-[.16em] text-[var(--primary-text)]">Tarefas internas</div>
            <h1>Tarefas</h1>
          </div>
          <div className={styles.toolbar}>
            <Segmented aria-label="Visualização de tarefas">
              <Button type="button" aria-pressed={view === "lista"} onClick={() => changeView("lista")}>Lista</Button>
              <Button type="button" aria-pressed={view === "agenda"} onClick={() => changeView("agenda")}>Agenda</Button>
            </Segmented>
            <span className={styles.toolbarSpacer} />
            <Button tone="primary" onClick={() => setDialog({ open: true, task: null })}>
              <Plus size={15} aria-hidden="true" />Nova tarefa
            </Button>
          </div>
        </header>

        <div className={styles.toolbar} role="group" aria-label="Filtros de tarefas">
          <Field label="Escopo">
            <Select value={scope} onChange={(event) => setScope(event.target.value as "mine" | "team")} disabled={!canAssign} aria-label="Escopo das tarefas">
              <option value="mine">Minhas</option>
              <option value="team">Equipe</option>
            </Select>
          </Field>
          <Field label="Status">
            <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "" | TaskStatus)} aria-label="Filtrar por status">
              <option value="">Todos</option>
              {STATUS_FILTER_OPTIONS.map((value) => <option key={value} value={value}>{STATUS_LABELS[value]}</option>)}
            </Select>
          </Field>
          <Field label="Prioridade">
            <Select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value as "" | TaskPriority)} aria-label="Filtrar por prioridade">
              <option value="">Todas</option>
              {PRIORITY_FILTER_OPTIONS.map((value) => <option key={value} value={value}>{PRIORITY_LABELS[value]}</option>)}
            </Select>
          </Field>
        </div>

        {error ? <p className="error" role="alert">{error.message}</p> : null}
        {listError ? <p className="error" role="alert">{listError}</p> : null}
        {isLoading && !data ? <div className="skeleton h-24" aria-label="Carregando tarefas" /> : null}

        {!isLoading && !tasks.length ? (
          <EmptyState
            title="Nenhuma tarefa"
            action={
              <Button tone="primary" onClick={() => setDialog({ open: true, task: null })}>
                <Plus size={15} aria-hidden="true" />Criar tarefa
              </Button>
            }
          >
            Organize o trabalho do time criando a primeira tarefa.
          </EmptyState>
        ) : null}

        {tasks.length ? (
          view === "agenda" ? (
            <div className={styles.agenda}>
              {agendaGroups.map((group) => (
                <section key={group.key} className={styles.agendaDay}>
                  <h2 className={styles.agendaDayTitle}>{group.label}</h2>
                  {group.tasks.map((task) => (
                    <TaskCard key={task.id} task={task} timezone={timezone} onToggle={toggleDone} onEdit={openEditor} onRemove={removeTask} />
                  ))}
                </section>
              ))}
              {loadMoreControl}
            </div>
          ) : (
            <div className={styles.list}>
              {tasks.map((task) => (
                <TaskCard key={task.id} task={task} timezone={timezone} onToggle={toggleDone} onEdit={openEditor} onRemove={removeTask} />
              ))}
              {loadMoreControl}
            </div>
          )
        ) : null}

        <TaskDialog
          open={dialog.open}
          task={dialog.task}
          canAssign={canAssign}
          currentUserId={currentUserId}
          onClose={() => setDialog({ open: false, task: null })}
          onSaved={(saved, created) => {
            if (created) void mutate();
            else applyTaskUpdate(saved);
            save.markDone();
          }}
        />
        <SaveToast show={save.done}>Tarefa salva</SaveToast>
      </div>
    </Shell>
  );
}
