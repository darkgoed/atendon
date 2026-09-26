"use client";

import {
  Archive,
  ArrowLeft,
  ChatsCircle,
  CaretRight,
  ClipboardText,
  Funnel,
  MagnifyingGlass,
  NotePencil,
  Plus,
  UserCircle,
  X
} from "@/components/icons";
import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import useSWR from "swr";
import { ModalDialog } from "@/components/modal-dialog";
import { PostSalesChecklist } from "@/components/post-sales-checklist";
import { PostSalesSummaryStrip } from "@/components/post-sales-summary";
import { Shell } from "@/components/shell";
import { HelpHint, IconButton, Input, PageHeader, SaveButton, SaveToast, Select, Textarea, useSaveFeedback, type SaveState, Tooltip } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import {
  buildPostSaleQuery,
  EMPTY_POST_SALE_FILTERS,
  formatPostSalePhone,
  isPostSaleVersionConflict,
  postSaleOriginLabel,
  postSaleQueueLabel,
  postSaleStateLabel,
  type PostSaleChecklistEntry,
  type PostSaleChecklistResult,
  type PostSaleClient,
  type PostSaleFilters,
  type PostSaleMember,
  type PostSaleSummary
} from "@/lib/post-sales";
import type { PanelSession } from "@/lib/session";
import { instantFromLocalMinute, localMinute } from "@/lib/timezone";
import { usePermission } from "@/lib/use-permission";

type ClientsResponse = {
  summary: PostSaleSummary;
  clients: PostSaleClient[];
  next_cursor: string | null;
};
type DetailResponse = { client: PostSaleClient; checklist: PostSaleChecklistEntry[] };
type OptionsResponse = { members: PostSaleMember[] };

const fetcher = <T,>(url: string) => api<T>(url);

export default function PostSalesPage() {
  const canManage = usePermission("post_sales.manage");
  const [filters, setFilters] = useState<PostSaleFilters>({ ...EMPTY_POST_SALE_FILTERS });
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  const [createOpen, setCreateOpen] = useState(false);
  const [extraClients, setExtraClients] = useState<PostSaleClient[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [savingEntryId, setSavingEntryId] = useState<string | null>(null);
  const [entryErrors, setEntryErrors] = useState<Record<string, string>>({});
  const updateSave = useSaveFeedback();
  const createSave = useSaveFeedback();

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(filters.q.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [filters.q]);

  const query = useMemo(
    () => buildPostSaleQuery({ ...filters, q: debouncedSearch }),
    [debouncedSearch, filters]
  );
  const listKey = `/post-sales/clients?${query}`;
  const { data, error: listError, isLoading, mutate: mutateList } = useSWR<ClientsResponse>(listKey, fetcher, {
    refreshInterval: 15_000,
    revalidateOnFocus: true,
    keepPreviousData: true
  });
  const { data: options } = useSWR<OptionsResponse>("/post-sales/options", fetcher, { revalidateOnFocus: false });
  const { data: session } = useSWR<PanelSession>("/me", fetcher, { revalidateOnFocus: false, dedupingInterval: 10_000 });
  const {
    data: detail,
    error: detailError,
    isLoading: detailLoading,
    mutate: mutateDetail
  } = useSWR<DetailResponse>(selectedId ? `/post-sales/clients/${selectedId}` : null, fetcher, {
    refreshInterval: 15_000,
    revalidateOnFocus: true
  });

  useEffect(() => {
    setExtraClients([]);
    setNextCursor(data?.next_cursor ?? null);
  }, [data?.next_cursor, listKey]);

  const clients = useMemo(() => {
    const seen = new Set<string>();
    return [...(data?.clients ?? []), ...extraClients].filter((client) => {
      if (seen.has(client.id)) return false;
      seen.add(client.id);
      return true;
    });
  }, [data?.clients, extraClients]);

  useEffect(() => {
    if (selectedId || !clients[0]) return;
    setSelectedId(clients[0].id);
  }, [clients, selectedId]);

  function selectClient(id: string) {
    setSelectedId(id);
    setMobileView("detail");
    setActionError("");
    setActionMessage("");
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError("");
    try {
      const separator = query ? "&" : "";
      const page = await api<ClientsResponse>(`/post-sales/clients?${query}${separator}cursor=${encodeURIComponent(nextCursor)}`);
      setExtraClients((current) => [...current, ...page.clients]);
      setNextCursor(page.next_cursor);
    } catch (error) {
      setLoadMoreError(error instanceof Error ? error.message : "Falha ao carregar mais clientes");
    } finally {
      setLoadingMore(false);
    }
  }

  async function refresh() {
    await Promise.all([mutateList(), selectedId ? mutateDetail() : Promise.resolve()]);
  }

  async function saveChecklist(entry: PostSaleChecklistEntry, result: PostSaleChecklistResult, note: string | null) {
    if (!selectedId || savingEntryId) return;
    setSavingEntryId(entry.id);
    setEntryErrors((current) => ({ ...current, [entry.id]: "" }));
    try {
      await api(`/post-sales/clients/${selectedId}/checklist/${entry.id}`, {
        method: "PATCH",
        body: JSON.stringify({ version: entry.version, result, note })
      });
      await refresh();
      setActionMessage("Checklist atualizado.");
    } catch (error) {
      if (isPostSaleVersionConflict(error)) await mutateDetail();
      setEntryErrors((current) => ({
        ...current,
        [entry.id]: isPostSaleVersionConflict(error)
          ? "Este item mudou em outra sessão. Recarregamos a versão mais recente."
          : error instanceof Error ? error.message : "Falha ao atualizar o checklist"
      }));
    } finally {
      setSavingEntryId(null);
    }
  }

  async function archiveClient(client: PostSaleClient) {
    setActionError("");
    setActionMessage("");
    try {
      const action = client.archived_at ? "restore" : "archive";
      await api(`/post-sales/clients/${client.id}/${action}`, {
        method: "POST",
        body: JSON.stringify({ version: client.version })
      });
      await refresh();
      setActionMessage(client.archived_at ? "Cliente restaurado." : "Cliente arquivado sem apagar o histórico.");
    } catch (error) {
      if (isPostSaleVersionConflict(error)) await refresh();
      setActionError(error instanceof Error ? error.message : "Falha ao atualizar o cliente");
    }
  }

  const changeFilter = <K extends keyof PostSaleFilters>(key: K, value: PostSaleFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setSelectedId(null);
    setMobileView("list");
  };
  const timezone = session?.activeWorkspace?.timezone ?? "UTC";

  return (
    <Shell fitViewport>
      <div className="post-sales-page">
        <PageHeader
          className="post-sales-head"
          title={<>Carteira de pós-venda <HelpHint label="Ajuda: o que é a carteira" title="Carteira de pós-venda">Clientes que já compraram e agora recebem acompanhamento: checklist de relacionamento, responsável e próxima ação.</HelpHint></>}
          actions={
            <div className="post-sales-head__actions">
              <Link className="btn" href="/pos-venda/cobranca">Cobranças de crediário</Link>
              {canManage ? <Tooltip content="Configurar checklist"><Link className="btn icon-button" href="/pos-venda/configurar"><ClipboardText size={16} aria-hidden="true" /><span className="sr-only">Configurar checklist</span></Link></Tooltip> : null}
              <button className="btn primary" type="button" onClick={() => setCreateOpen(true)}><Plus size={16} aria-hidden="true" /> Novo cliente</button>
            </div>
          }
        />

        {data?.summary ? <PostSalesSummaryStrip summary={data.summary} /> : (
          <div className="post-sales-summary-wrap"><div className="post-sales-summary post-sales-summary--loading" role="status" aria-label="Carregando resumo">
            {[1, 2, 3, 4, 5].map((item) => <span className="skeleton" key={item} aria-hidden="true" />)}
          </div></div>
        )}

        <section className="post-sales-layout" data-mobile-view={mobileView}>
          <aside className="post-sales-list" aria-label="Lista de clientes">
            <div className="post-sales-list__toolbar">
              <label className="post-sales-search">
                <MagnifyingGlass size={16} aria-hidden="true" />
                <span className="sr-only">Buscar cliente</span>
                <Input value={filters.q} onChange={(event) => changeFilter("q", event.target.value)} placeholder="Nome, telefone ou e-mail" />
                {filters.q ? <button type="button" onClick={() => changeFilter("q", "")} aria-label="Limpar busca"><X size={14} aria-hidden="true" /></button> : null}
              </label>
              <div className="post-sales-filters" aria-label="Filtros da carteira">
                <Funnel size={15} aria-hidden="true" />
                <HelpHint label="Ajuda: Filtros da carteira">“Atrasadas” reúne clientes com próxima ação vencida; “Sem ação”, quem não tem nada agendado.</HelpHint>
                <Select value={filters.progress} onChange={(event) => changeFilter("progress", event.target.value as PostSaleFilters["progress"])} aria-label="Filtrar por progresso">
                  <option value="">Todo progresso</option>
                  <option value="not_started">Não iniciados</option>
                  <option value="in_progress">Em andamento</option>
                  <option value="complete">Completos</option>
                </Select>
                <Select value={filters.responsible_member_id} onChange={(event) => changeFilter("responsible_member_id", event.target.value)} aria-label="Filtrar por responsável">
                  <option value="">Todos responsáveis</option>
                  <option value="unassigned">Sem responsável</option>
                  {options?.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
                </Select>
                <Select value={filters.next_action} onChange={(event) => changeFilter("next_action", event.target.value as PostSaleFilters["next_action"])} aria-label="Filtrar por próxima ação">
                  <option value="">Todas as ações</option>
                  <option value="overdue">Atrasadas</option>
                  <option value="today">Para hoje</option>
                  <option value="upcoming">Próximas</option>
                  <option value="none">Sem ação</option>
                </Select>
                <Select value={filters.archived} onChange={(event) => changeFilter("archived", event.target.value as PostSaleFilters["archived"])} aria-label="Filtrar por arquivamento">
                  <option value="active">Ativos</option>
                  <option value="archived">Arquivados</option>
                  <option value="all">Todos</option>
                </Select>
              </div>
            </div>

            <div className="post-sales-list__results" aria-live="polite">
              {isLoading && !data ? <PortfolioSkeleton /> : listError ? (
                <InlineFailure message={listError.message} onRetry={() => void mutateList()} />
              ) : clients.length === 0 ? (
                <div className="post-sales-empty">
                  <UserCircle size={32} aria-hidden="true" />
                  <strong>Nenhum cliente nesta visão</strong>
                  <p>Ajuste os filtros ou cadastre o primeiro cliente manualmente.</p>
                  <button className="btn primary" type="button" onClick={() => setCreateOpen(true)}>Cadastrar cliente</button>
                </div>
              ) : clients.map((client, index) => (
                <button
                  className={`post-sales-client-row${selectedId === client.id ? " is-active" : ""}`}
                  style={{ "--item-index": index } as React.CSSProperties}
                  key={client.id}
                  type="button"
                  onClick={() => selectClient(client.id)}
                  aria-current={selectedId === client.id ? "true" : undefined}
                >
                  <span className="post-sales-client-row__main">
                    <strong>{client.name}</strong>
                    <small className="mono">{formatPostSalePhone(client.phone_e164)}</small>
                  </span>
                  <span className={`post-sales-state post-sales-state--${client.state}`}>{postSaleStateLabel(client.state)}</span>
                  <span className="post-sales-client-row__meta">
                    <span>{client.responsible_name ?? "Sem responsável"}</span>
                    <span data-queue={client.next_action_queue}>{postSaleQueueLabel(client.next_action_queue)}</span>
                  </span>
                  <span className="post-sales-progress" aria-label={`${client.progress_percent}% do checklist concluído`}>
                    <i style={{ transform: `scaleX(${client.progress_percent / 100})` }} />
                  </span>
                  <CaretRight size={16} aria-hidden="true" />
                </button>
              ))}
              {loadMoreError ? <p className="post-sales-pagination-error error" role="alert">{loadMoreError}</p> : null}
              {nextCursor ? <button className="post-sales-load-more" type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Carregando…" : "Carregar mais clientes"}</button> : null}
            </div>
          </aside>

          <section className="post-sales-detail" aria-label="Detalhe do cliente">
            {!selectedId ? <SelectClientState /> : detailLoading && !detail ? <DetailSkeleton /> : detailError ? (
              <InlineFailure message={detailError.message} onRetry={() => void mutateDetail()} />
            ) : detail ? (
              <>
                <div className="post-sales-detail__scroll">
                  <button className="post-sales-mobile-back" type="button" onClick={() => setMobileView("list")}><ArrowLeft size={16} aria-hidden="true" /> Voltar à carteira</button>
                  <header className="post-sales-detail__header">
                    <div>
                      <span className="label">{postSaleOriginLabel(detail.client.origin)}</span>
                      <h2>{detail.client.name}</h2>
                      <p className="mono">{formatPostSalePhone(detail.client.phone_e164)}{detail.client.email ? ` · ${detail.client.email}` : ""}</p>
                    </div>
                    <div className="post-sales-detail__links">
                      {detail.client.lead_id ? <Tooltip content="Ver contato"><Link className="btn icon-button" href={`/contatos/${detail.client.lead_id}`}><UserCircle size={15} aria-hidden="true" /><span className="sr-only">Ver contato</span></Link></Tooltip> : null}
                      {detail.client.conversation_id ? <Tooltip content="Abrir conversa"><Link className="btn icon-button" href={`/conversas?id=${detail.client.conversation_id}`}><ChatsCircle size={15} aria-hidden="true" /><span className="sr-only">Abrir conversa</span></Link></Tooltip> : null}
                    </div>
                  </header>

                  {actionMessage ? <p className="post-sales-feedback accent" role="status">{actionMessage}</p> : null}
                  {actionError ? <p className="post-sales-feedback error" role="alert">{actionError}</p> : null}

                  <section className="post-sales-detail__overview" aria-label="Resumo do cliente">
                    <div className="post-sales-progress-ring" style={{ "--progress": `${detail.client.progress_percent * 3.6}deg` } as React.CSSProperties}>
                      <span className="mono">{detail.client.progress_percent}%</span>
                    </div>
                    <dl>
                      <div><dt>Estado</dt><dd><span className={`post-sales-state post-sales-state--${detail.client.state}`}>{postSaleStateLabel(detail.client.state)}</span></dd></div>
                      <div><dt>Responsável</dt><dd>{detail.client.responsible_name ?? "Não atribuído"}</dd></div>
                      <div><dt>Próxima ação</dt><dd>{detail.client.next_action ?? "Nenhuma ação agendada"}{detail.client.next_action_at ? <time>{new Date(detail.client.next_action_at).toLocaleString("pt-BR", { timeZone: timezone })}</time> : null}</dd></div>
                      <div><dt>Checklist</dt><dd>{detail.client.checklist_completed} de {detail.client.checklist_total} itens registrados</dd></div>
                    </dl>
                  </section>

                  <section className="post-sales-detail__section post-sales-detail__section--checklist">
                    <div className="post-sales-section-title">
                      <div><span className="label">Elemento principal</span><h3>Checklist de relacionamento <HelpHint label="Ajuda: Checklist de relacionamento">Lista de compromissos pós-venda definida pela empresa. Registre o resultado de cada item para acompanhar o progresso do cliente.</HelpHint></h3></div>
                      <span className="mono">{detail.client.checklist_accepted} aceito(s)</span>
                    </div>
                    <PostSalesChecklist entries={detail.checklist} savingId={savingEntryId} errors={entryErrors} onSave={saveChecklist} />
                  </section>

                  <ClientEditor
                    key={`${detail.client.id}:${detail.client.version}`}
                    client={detail.client}
                    members={options?.members ?? []}
                    timezone={timezone}
                    saveState={updateSave.state}
                    onSaved={async (message) => { updateSave.markDone(); await refresh(); setActionMessage(message); }}
                    onConflict={refresh}
                    onError={(message) => setActionError(message)}
                  />
                </div>
                <div className="post-sales-detail__sticky">
                  <span><NotePencil size={15} aria-hidden="true" /> Alterações são salvas automaticamente</span>
                  <IconButton type="button" label={detail.client.archived_at ? "Restaurar cliente" : "Arquivar cliente"} onClick={() => void archiveClient(detail.client)}>
                    <Archive size={15} aria-hidden="true" />
                  </IconButton>
                </div>
              </>
            ) : null}
          </section>
        </section>
      </div>

      <SaveToast show={updateSave.done}>Dados do cliente atualizados</SaveToast>
      <SaveToast show={createSave.done}>Cliente adicionado à carteira</SaveToast>

      {createOpen ? (
        <CreateClientDialog
          members={options?.members ?? []}
          timezone={timezone}
          onClose={() => setCreateOpen(false)}
          saveState={createSave.state}
          onCreated={async (client) => {
            createSave.markDone();
            await mutateList();
            setSelectedId(client.id);
            setMobileView("detail");
            setCreateOpen(false);
            setActionMessage("Cliente adicionado à carteira.");
          }}
          onExisting={(id) => {
            setSelectedId(id);
            setMobileView("detail");
            setCreateOpen(false);
          }}
        />
      ) : null}
    </Shell>
  );
}

function ClientEditor({
  client,
  members,
  timezone,
  saveState,
  onSaved,
  onConflict,
  onError
}: {
  client: PostSaleClient;
  members: PostSaleMember[];
  timezone: string;
  saveState: SaveState;
  onSaved: (message: string) => Promise<void> | void;
  onConflict: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [inlineError, setInlineError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const nextAction = String(data.get("next_action") ?? "").trim();
    const nextActionLocal = String(data.get("next_action_at") ?? "").trim();
    if (Boolean(nextAction) !== Boolean(nextActionLocal)) {
      setInlineError("Informe a próxima ação e a data juntas.");
      return;
    }
    const nextActionAt = nextActionLocal ? instantFromLocalMinute(nextActionLocal, timezone) : null;
    if (nextActionLocal && !nextActionAt) {
      setInlineError("A data informada não existe no fuso da empresa.");
      return;
    }
    setSaving(true);
    setInlineError("");
    onError("");
    try {
      await api(`/post-sales/clients/${client.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          version: client.version,
          name: String(data.get("name") ?? "").trim(),
          phone_e164: String(data.get("phone_e164") ?? "").trim(),
          email: String(data.get("email") ?? "").trim() || null,
          responsible_member_id: String(data.get("responsible_member_id") ?? "") || null,
          notes: String(data.get("notes") ?? "").trim() || null,
          next_action: nextAction || null,
          next_action_at: nextActionAt
        })
      });
      setOpen(false);
      await onSaved("Dados do cliente atualizados.");
    } catch (error) {
      if (isPostSaleVersionConflict(error)) await onConflict();
      const message = isPostSaleVersionConflict(error)
        ? "Este cliente mudou em outra sessão. Recarregamos a versão mais recente."
        : error instanceof Error ? error.message : "Falha ao salvar o cliente";
      setInlineError(message);
      onError(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="post-sales-detail__section post-sales-client-editor">
      <button className="post-sales-section-toggle" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span><NotePencil size={17} aria-hidden="true" /> Dados, observação e próxima ação</span>
        <CaretRight size={16} aria-hidden="true" />
      </button>
      {open ? (
        <form className="post-sales-client-editor__form" onSubmit={submit} aria-busy={saving}>
          <label className="field"><span className="label">Nome</span><Input name="name" defaultValue={client.name} required disabled={saving} /></label>
          <label className="field"><span className="label">Telefone</span><Input name="phone_e164" defaultValue={client.phone_e164} required disabled={saving} /></label>
          <label className="field"><span className="label">E-mail</span><Input name="email" type="email" defaultValue={client.email ?? ""} disabled={saving} /></label>
          <label className="field"><span className="label">Responsável</span><Select className="input" name="responsible_member_id" defaultValue={client.responsible_member_id ?? ""} disabled={saving}><option value="">Sem responsável</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</Select></label>
          <label className="field"><span className="label">Próxima ação</span><Input name="next_action" defaultValue={client.next_action ?? ""} placeholder="Ex.: confirmar implantação" disabled={saving} /></label>
          <label className="field"><span className="label">Data da ação</span><Input name="next_action_at" type="datetime-local" defaultValue={client.next_action_at ? localMinute(client.next_action_at, timezone) : ""} disabled={saving} /></label>
          <label className="field post-sales-client-editor__notes"><span className="label">Observação</span><Textarea name="notes" rows={4} defaultValue={client.notes ?? ""} disabled={saving} /></label>
          {inlineError ? <p className="error post-sales-client-editor__error" role="alert">{inlineError}</p> : null}
          <div className="post-sales-client-editor__actions"><IconButton type="button" label="Cancelar" onClick={() => setOpen(false)} disabled={saving}><X size={16} aria-hidden="true" /></IconButton><SaveButton type="submit" state={saving ? "busy" : saveState} disabled={saving}>Salvar alterações</SaveButton></div>
        </form>
      ) : client.notes ? <p className="post-sales-client-editor__preview">{client.notes}</p> : null}
    </section>
  );
}

function CreateClientDialog({
  members,
  timezone,
  saveState,
  onClose,
  onCreated,
  onExisting
}: {
  members: PostSaleMember[];
  timezone: string;
  saveState: SaveState;
  onClose: () => void;
  onCreated: (client: PostSaleClient) => Promise<void> | void;
  onExisting: (id: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [existingId, setExistingId] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const nextAction = String(data.get("next_action") ?? "").trim();
    const localDate = String(data.get("next_action_at") ?? "").trim();
    if (Boolean(nextAction) !== Boolean(localDate)) {
      setError("Informe a próxima ação e a data juntas.");
      return;
    }
    const nextActionAt = localDate ? instantFromLocalMinute(localDate, timezone) : undefined;
    if (localDate && !nextActionAt) {
      setError("A data informada não existe no fuso da empresa.");
      return;
    }
    setSaving(true);
    setError("");
    setExistingId(null);
    try {
      const response = await api<{ client: PostSaleClient }>("/post-sales/clients", {
        method: "POST",
        body: JSON.stringify({
          name: String(data.get("name") ?? "").trim(),
          phone_e164: String(data.get("phone_e164") ?? "").trim(),
          email: String(data.get("email") ?? "").trim() || undefined,
          notes: String(data.get("notes") ?? "").trim() || undefined,
          responsible_member_id: String(data.get("responsible_member_id") ?? "") || undefined,
          ...(nextAction ? { next_action: nextAction, next_action_at: nextActionAt } : {})
        })
      });
      await onCreated(response.client);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409 && caught.body && typeof caught.body === "object") {
        const existingId = (caught.body as { existing_id?: unknown }).existing_id;
        if (typeof existingId === "string") {
          setError("Este telefone já está na carteira.");
          setExistingId(existingId);
          return;
        }
      }
      setError(caught instanceof Error ? caught.message : "Falha ao cadastrar cliente");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalDialog labelledBy="post-sales-create-title" describedBy="post-sales-create-description" onClose={onClose} className="post-sales-create-dialog">
      <div className="post-sales-dialog-head">
        <div><span className="label">Entrada manual</span><h2 id="post-sales-create-title">Adicionar à carteira</h2></div>
        <button type="button" onClick={onClose} aria-label="Fechar"><X size={18} aria-hidden="true" /></button>
      </div>
      <p id="post-sales-create-description">Nome e telefone são obrigatórios. Se houver um lead com o mesmo telefone, o vínculo será feito sem alterá-lo.</p>
      <form className="post-sales-create-form" onSubmit={submit} aria-busy={saving}>
        <label className="field"><span className="label">Nome</span><Input name="name" required data-autofocus disabled={saving} /></label>
        <label className="field"><span className="label">Telefone</span><Input name="phone_e164" inputMode="tel" placeholder="+5511999999999" required disabled={saving} /></label>
        <label className="field"><span className="label">E-mail</span><Input name="email" type="email" disabled={saving} /></label>
        <label className="field"><span className="label">Responsável</span><Select className="input" name="responsible_member_id" defaultValue="" disabled={saving}><option value="">Sem responsável</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</Select></label>
        <label className="field"><span className="label">Próxima ação</span><Input name="next_action" placeholder="Opcional" disabled={saving} /></label>
        <label className="field"><span className="label">Data da ação</span><Input name="next_action_at" type="datetime-local" disabled={saving} /></label>
        <label className="field post-sales-create-form__notes"><span className="label">Observação</span><Textarea name="notes" rows={3} disabled={saving} /></label>
        {error ? <p className="error post-sales-create-form__error" role="alert">{error}</p> : null}
        {existingId ? <button className="btn post-sales-create-form__existing" type="button" onClick={() => onExisting(existingId)}>Abrir cadastro existente</button> : null}
        <div className="post-sales-create-form__actions"><button className="btn" type="button" onClick={onClose} disabled={saving}>Cancelar</button><SaveButton type="submit" state={saving ? "busy" : saveState} disabled={saving} busyLabel="Adicionando…">Adicionar cliente</SaveButton></div>
      </form>
    </ModalDialog>
  );
}

function PortfolioSkeleton() {
  return <div className="post-sales-skeleton" role="status" aria-label="Carregando carteira">{[1, 2, 3, 4, 5].map((item) => <div key={item} className="skeleton" aria-hidden="true" />)}</div>;
}

function DetailSkeleton() {
  return <div className="post-sales-detail-skeleton" role="status" aria-label="Carregando cliente"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>;
}

function SelectClientState() {
  return <div className="post-sales-select-state" role="status"><ClipboardText size={34} aria-hidden="true" /><strong>Selecione um cliente</strong><p>O detalhe mantém o checklist em primeiro plano e a carteira sempre ao alcance.</p></div>;
}

function InlineFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="post-sales-failure" role="alert"><strong>Não foi possível carregar</strong><p>{message}</p><button className="btn warn" type="button" onClick={onRetry}>Tentar novamente</button></div>;
}
