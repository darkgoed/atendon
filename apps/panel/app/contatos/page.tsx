"use client";

import { DotsThreeVertical, DownloadSimple, Eye, MagicWand, MagnifyingGlass, Plus, Star, UploadSimple, UsersThree } from "@/components/icons";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { BulkLeadActions } from "@/components/bulk-lead-actions";
import { ContactChatLink } from "@/components/contact-chat-link";
import { ContactAvatar } from "@/components/contact-avatar";
import { NewLeadDialog } from "@/components/new-lead-dialog";
import { LeadTagChips, LeadTagMenuItems, type LeadTag } from "@/components/lead-tag-picker";
import { PopoverMenu } from "@/components/popover-menu";
import { SavedViewsControl } from "@/components/saved-views-control";
import { TagCatalogSettings } from "@/components/tag-catalog-settings";
import { Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { buildLeadFilterQuery, type LeadFilters } from "@/lib/lead-filters";
import { leadStatusLabel } from "@/lib/labels";
import { apiContentUrl } from "@/lib/meet";
import { applyLeadSavedViewFilters, leadFiltersForSavedView, useCaseOrganizationEnabled } from "@/lib/organization";
import { useRealtimeSignals } from "@/lib/realtime";
import { hasWorkspaceWideCaseScope, type PanelSession } from "@/lib/session";
import { usePermission } from "@/lib/use-permission";
import { Button, EmptyState, HelpHint, IconButton, SaveToast } from "@/components/ui";
import { leadStatusTone } from "./lead-domain";
import { ListFiltersBar, type ListFilterDef } from "@/components/ui/filters";

type Option = { id: string; nome: string };
type Qualification = {
  estrelas: number;
  resumo?: string | null;
  requer_decisao_humana: boolean;
  origem_facebook?: { headline?: string; source_id?: string };
};
type Lead = {
  id: string; telefone: string; nome?: string; status: string; origem?: string;
  avatar_url?: string | null;
  conversation_id?: string | null;
  instagram_username?: string | null;
  categoria_nome?: string; unidade_nome?: string; parceiro_nome?: string;
  responsavel_email?: string | null;
  responsavel_disponibilidade?: "available" | "unavailable" | null;
  proxima_acao?: string | null;
  proxima_acao_em?: string | null;
  tags?: LeadTag[];
  atualizado_em: string; qualificacao?: Qualification | null;
  origem_facebook?: { headline?: string; source_id?: string };
};

const statuses = ["", "novo", "em_atendimento", "aguardando_resposta", "qualificado", "agendado", "em_negociacao", "proposta_enviada", "follow_up", "fechado", "perdido"];
type LeadsPage = { limit: number; has_more: boolean; next_cursor: string | null };
type LeadsResponse = { leads: Lead[]; timezone?: string; total?: number; page?: LeadsPage };
const LEADS_PAGE_SIZE = 50;
const fetcher = <T,>(url: string) => api<T>(url);

export default function LeadsPage() {
  const canReadFollowUp = usePermission("leads.follow_up.read");
  const canQualifyLeads = usePermission("leads.update_status");
  const canCreateLeads = usePermission("leads.create");
  const organizationEnabled = useCaseOrganizationEnabled();
  const [filters, setFilters] = useState<LeadFilters>({
    status: "", unidade_id: "", categoria_id: "", parceiro_id: "", busca: "", estrelas: "", fila_humana: ""
  });
  const [options, setOptions] = useState<{ unidades: Option[]; categorias: Option[]; parceiros: Option[] }>({ unidades: [], categorias: [], parceiros: [] });
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [accessNotice, setAccessNotice] = useState("");
  const [qualifyingLeadId, setQualifyingLeadId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  // Modo de seleção em massa: o rodapé (BulkLeadActions) avisa quantos contatos
  // estão marcados; Esc encerra o modo.
  const hasSelection = selectedIds.size > 0;
  useEffect(() => {
    if (!hasSelection) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Esc que fecha diálogo/menu/popover ou sai de um campo não limpa a seleção.
      if (event.defaultPrevented || document.querySelector('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]')) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      setSelectedIds(new Set());
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hasSelection]);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createToast, setCreateToast] = useState(false);
  const { data: session } = useSWR<PanelSession>("/me", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 10_000
  });
  const hasWorkspaceScope = Boolean(session && hasWorkspaceWideCaseScope(session));

  useEffect(() => {
    const currentUrl = new URL(window.location.href);
    if (currentUrl.searchParams.get("acesso") !== "atualizado") return;
    setAccessNotice("A atribuição foi atualizada. Esta lista mostra somente os leads que você pode acessar.");
    currentUrl.searchParams.delete("acesso");
    window.history.replaceState({}, "", `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
  }, []);

  useEffect(() => {
    Promise.all([
      api<{ unidades: Option[] }>("/scheduling/config/unidades"),
      api<{ categorias: Option[] }>("/scheduling/config/categorias"),
      api<{ parceiros: Option[] }>("/scheduling/config/parceiros")
    ]).then(([units, categories, partners]) => setOptions({ unidades: units.unidades, categorias: categories.categorias, parceiros: partners.parceiros }))
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Falha ao carregar filtros"));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(filters.busca.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [filters.busca]);

  const query = useMemo(() => buildLeadFilterQuery({ ...filters, busca: debouncedSearch }), [debouncedSearch, filters]);
  const listQuery = query ? `${query}&limit=${LEADS_PAGE_SIZE}` : `limit=${LEADS_PAGE_SIZE}`;
  // Server-side keyset pagination: the SWR key always fetches the first page
  // (what the 15s poll refreshes); "Carregar mais" appends older pages by
  // cursor. Once extra pages exist, the poll must not overwrite the anchor
  // cursor (it would make the next page duplicate already-loaded rows).
  const [olderLeads, setOlderLeads] = useState<Lead[]>([]);
  const [pageState, setPageState] = useState<{ cursor: string | null; hasMore: boolean; fetchedPages: number }>({ cursor: null, hasMore: false, fetchedPages: 0 });
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    setOlderLeads([]);
    setPageState({ cursor: null, hasMore: false, fetchedPages: 0 });
    setLoadingMore(false);
  }, [listQuery]);
  const { data, error: swrError, mutate } = useSWR<LeadsResponse>(`/scheduling/leads?${listQuery}`, fetcher, {
    refreshInterval: 15_000, revalidateOnFocus: false, dedupingInterval: 5_000
  });
  useEffect(() => {
    const page = data?.page;
    if (!page || pageState.fetchedPages > 0) return;
    setPageState((current) => current.fetchedPages > 0 ? current : { cursor: page.next_cursor, hasMore: page.has_more, fetchedPages: 0 });
  }, [data?.page, pageState.fetchedPages]);
  const leads = useMemo(() => {
    const fresh = data?.leads ?? [];
    if (olderLeads.length === 0) return fresh;
    const seen = new Set(fresh.map((lead) => lead.id));
    return [...fresh, ...olderLeads.filter((lead) => !seen.has(lead.id))];
  }, [data?.leads, olderLeads]);
  const total = data?.total ?? leads.length;
  const timezone = data?.timezone ?? "UTC";
  const loading = !data && !swrError;
  const selectedItems = useMemo(() => leads.filter((lead) => selectedIds.has(lead.id)).map((lead) => ({ id: lead.id, expected_updated_at: lead.atualizado_em })), [leads, selectedIds]);
  const applySavedFilters = (saved: Record<string, unknown>) => setFilters((current) => applyLeadSavedViewFilters(current, saved));

  useRealtimeSignals({
    onCatchUp: () => {
      if (document.visibilityState === "visible") void mutate();
    },
    onSignal: (signal) => {
      if (
        document.visibilityState === "visible"
        && (
          signal.type === "conversation.messages.changed"
          || signal.type === "case.assignment.changed"
        )
      ) {
        void mutate();
      }
    }
  });

  async function qualifyLead(lead: Lead) {
    if (!canQualifyLeads || lead.qualificacao || qualifyingLeadId) return;
    setQualifyingLeadId(lead.id);
    setError("");
    setFeedback("");
    try {
      const result = await api<{ mensagens_analisadas: number }>(`/scheduling/leads/${lead.id}/qualify-context`, {
        method: "POST"
      });
      await mutate();
      setFeedback(`${lead.nome ?? "Lead"} qualificado pela IA com base em ${result.mensagens_analisadas} mensagem(ns).`);
    } catch (qualificationError) {
      setError(qualificationError instanceof Error ? qualificationError.message : "Falha ao qualificar o lead com IA");
    } finally {
      setQualifyingLeadId(null);
    }
  }

  async function loadMoreLeads() {
    if (!pageState.cursor || loadingMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const cursorQuery = `cursor=${encodeURIComponent(pageState.cursor)}&limit=${LEADS_PAGE_SIZE}`;
      const response = await api<LeadsResponse>(`/scheduling/leads?${listQuery}&${cursorQuery}`);
      setOlderLeads((current) => {
        const seen = new Set(current.map((lead) => lead.id));
        return [...current, ...response.leads.filter((lead) => !seen.has(lead.id))];
      });
      setPageState((current) => ({
        cursor: response.page?.next_cursor ?? null,
        hasMore: Boolean(response.page?.has_more),
        fetchedPages: current.fetchedPages + 1
      }));
    } catch (paginationError) {
      setError(paginationError instanceof Error ? paginationError.message : "Falha ao carregar mais leads");
    } finally {
      setLoadingMore(false);
    }
  }

  const clearFilters = () => setFilters({ status: "", unidade_id: "", categoria_id: "", parceiro_id: "", busca: "", estrelas: "", fila_humana: "" });
  const filterDefs: Array<ListFilterDef<LeadFilters>> = [
    { key: "status", label: "Status", kind: "option", options: statuses.filter(Boolean).map((id) => ({ id, nome: leadStatusLabel(id) })) },
    { key: "estrelas", label: "Avaliação", kind: "option", options: [1, 2, 3, 4, 5].map((stars) => ({ id: String(stars), nome: `${stars} ${stars === 1 ? "estrela" : "estrelas"}` })) },
    { key: "fila_humana", label: "Fila humana", kind: "option", options: [{ id: "true", nome: "Requer decisão humana" }] },
    { key: "unidade_id", label: "Agenda", kind: "option", options: options.unidades },
    { key: "categoria_id", label: "Categoria", kind: "option", options: options.categorias },
    { key: "parceiro_id", label: "Parceiro", kind: "option", options: options.parceiros }
  ];
  const setFilter = (key: keyof LeadFilters & string, value: string) => setFilters((current) => ({ ...current, [key]: value }));
  const hasActiveFilters = Object.values(filters).some((value) => Boolean(value));
  return <Shell fitViewport>
    <div className="leads-page">
    <header className="leads-page__header">
      <div>
        <h1>{hasWorkspaceScope ? "Contatos" : "Meus contatos"}</h1>
        <span className="leads-page__count" role="status" aria-live="polite">{loading ? "carregando…" : `${total} resultado(s)`}</span>
      </div>
      <div className="leads-page__actions flex min-h-8 flex-wrap items-center gap-2">
        <label className="field leads-page__search m-0">
          <span className="sr-only">Buscar contato</span>
          <span className="search-field"><MagnifyingGlass size={14} aria-hidden="true" /><input className="input" type="search" value={filters.busca} onChange={(event) => setFilter("busca", event.target.value)} placeholder="Nome ou telefone" /></span>
        </label>
        <ListFiltersBar filters={filters} defs={filterDefs} onSet={setFilter} onClearAll={clearFilters} />
        <SavedViewsControl resource="leads" filters={leadFiltersForSavedView(filters)} onApply={applySavedFilters} />
        <TagCatalogSettings />
        <span className="leads-page__divider" aria-hidden="true" />
        {canReadFollowUp ? (
          <IconButton
            label="Exportar CSV"
            size="sm"
            onClick={() => window.location.assign(apiContentUrl(query ? `/contact-ops/export.csv?${query}` : "/contact-ops/export.csv"))}
          >
            <DownloadSimple size={14} aria-hidden="true" />
          </IconButton>
        ) : null}
        <Link className="btn crm-compact-button" href="/contatos/importar"><UploadSimple size={14} aria-hidden="true" />Importar</Link>
        {canCreateLeads ? <Button className="crm-compact-button" tone="primary" onClick={() => setCreateOpen(true)}><Plus size={14} aria-hidden="true" />Novo contato</Button> : null}
        <BulkLeadActions selected={selectedItems} onClear={() => setSelectedIds(new Set())} onChanged={mutate} />
      </div>
    </header>
    {error ? <p className="error mb-4" role="alert">{error}</p> : null}
    {feedback ? <p className="accent mb-4" role="status" aria-live="polite">{feedback}</p> : null}
    {accessNotice ? <p className="mb-4 rounded border border-[var(--primary-border)] p-3 text-sm text-[var(--primary-text)]" role="status">{accessNotice}</p> : null}
    {swrError ? <p className="error mb-4" role="alert">{swrError.message}</p> : null}
    <section className="leads-table-surface responsive-table-wrap overflow-y-auto">
      {loading ? <div className="grid gap-2 p-4" role="status" aria-label="Carregando contatos">{[1, 2, 3, 4, 5, 6].map((item) => <div key={item} className="skeleton h-12" aria-hidden="true" />)}</div>
        : leads.length === 0 ? (
          <EmptyState
            icon={<UsersThree size={18} aria-hidden="true" />}
            title={hasActiveFilters ? "Nenhum contato encontrado" : "Nenhum contato ainda"}
            action={hasActiveFilters
              ? <Button size="sm" onClick={clearFilters}>Limpar filtros</Button>
              : canCreateLeads ? <Button size="sm" tone="primary" onClick={() => setCreateOpen(true)}><Plus size={14} aria-hidden="true" />Novo contato</Button> : null}
          >
            {hasActiveFilters ? "Nenhum contato corresponde aos filtros." : "Crie um contato ou importe uma planilha para começar."}
          </EmptyState>
        )
          : <table className={`responsive-table leads-table crm-lead-table whitespace-nowrap ${canReadFollowUp ? "crm-lead-table--follow-up" : "crm-lead-table--basic"}`}>
            <thead><tr>
              <th>Contato</th>
              <th>Etapa <HelpHint label="Ajuda: Etapa" title="Etapa e qualificação">Situação comercial do contato. O número (ex.: 4/5) é a nota da qualificação da IA; “Decisão humana” marca contatos que aguardam decisão de uma pessoa.</HelpHint></th>
              <th>Contexto <HelpHint label="Ajuda: Contexto" title="Contexto">Resumo gerado pela IA na qualificação, com a origem do contato e a agenda associada.</HelpHint></th>
              {canReadFollowUp ? <th>Acompanhamento</th> : null}
              <th>Atualizado</th>
              <th>Ações</th>
            </tr></thead>
            <tbody>{leads.map((lead) => <tr key={lead.id} className={selectedIds.has(lead.id) ? "is-selected" : undefined}>
              <td data-label="Contato">
                <div className="leads-table__identity">
                  {organizationEnabled === true ? <input type="checkbox" checked={selectedIds.has(lead.id)} onChange={() => setSelectedIds((current) => { const next = new Set(current); if (next.has(lead.id)) next.delete(lead.id); else if (next.size < 200) next.add(lead.id); return next; })} aria-label={`Selecionar ${lead.nome ?? lead.telefone}`} /> : null}
                  <ContactAvatar name={lead.nome ?? lead.telefone} src={lead.avatar_url} className="h-8 w-8 text-xs" />
                  <div className="min-w-0"><Link className="leads-table__name" href={`/contatos/${lead.id}`} tabIndex={-1}><strong>{lead.nome ?? "Sem nome"}</strong></Link><span className="mono">{lead.instagram_username ? `@${lead.instagram_username}` : lead.telefone}</span><LeadTagChips tags={lead.tags} compact /></div>
                </div>
              </td>
              <td data-label="Etapa">
                <div className="leads-table__stage">
                  <span className="lead-status" data-tone={leadStatusTone(lead.status)}>{leadStatusLabel(lead.status)}</span>
                  <div className="leads-table__stage-meta">
                    {lead.qualificacao
                      ? <small className="lead-score" aria-label={`${lead.qualificacao.estrelas} de 5 na qualificação`}><Star size={11} weight="fill" aria-hidden="true" />{lead.qualificacao.estrelas}/5</small>
                      : <small className="lead-score lead-score--empty">sem score</small>}
                    {lead.qualificacao?.requer_decisao_humana ? <em>Decisão humana</em> : null}
                  </div>
                </div>
              </td>
              <td data-label="Resumo"><div className="leads-table__context"><strong className="block truncate" title={lead.qualificacao?.resumo ?? undefined}>{lead.qualificacao?.resumo ?? "Sem resumo de qualificação"}</strong><span>{lead.qualificacao?.origem_facebook?.headline ?? lead.origem_facebook?.headline ?? lead.origem ?? "Origem não informada"}</span><small>{lead.unidade_nome ?? lead.categoria_nome ?? "Sem agenda associada"}</small></div></td>
              {canReadFollowUp ? <td data-label="Acompanhamento"><div className="leads-table__follow-up"><strong>{lead.proxima_acao ?? "Nenhuma ação"}</strong>{lead.proxima_acao_em ? <time className="mono">{new Date(lead.proxima_acao_em).toLocaleString("pt-BR", { timeZone: timezone, dateStyle: "short", timeStyle: "short" })}</time> : null}<span>{lead.responsavel_email ?? "Não atribuído"}</span><small data-availability={lead.responsavel_disponibilidade ?? "none"}>{lead.responsavel_disponibilidade === "available" ? "Disponível" : lead.responsavel_disponibilidade === "unavailable" ? "Indisponível" : "Fora do pool"}</small></div></td> : null}
              <td data-label="Atualizado" className="mono leads-table__updated"><time dateTime={lead.atualizado_em} title={new Date(lead.atualizado_em).toLocaleString("pt-BR")}>{new Date(lead.atualizado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</time></td>
              <td data-label="Ações">
                <div className="leads-table__actions">
                  <ContactChatLink conversationId={lead.conversation_id} name={lead.nome} />
                  <IconButton asChild label="Ver detalhes" size="sm">
                    <Link href={`/contatos/${lead.id}`}><Eye size={14} aria-hidden="true" /></Link>
                  </IconButton>
                  <PopoverMenu
                    buttonClassName="btn crm-compact-button"
                    icon={<DotsThreeVertical size={14} weight="bold" aria-hidden="true" />}
                    ariaLabel={`Mais ações de ${lead.nome ?? lead.telefone}`}
                    title="Mais ações"
                    align="end"
                    panelClassName="pipeline-popover pipeline-popover--tags grid gap-1"
                  >
                    {(close) => (<>
                      {!lead.qualificacao && canQualifyLeads ? (
                        <button
                          type="button"
                          className="flex min-h-9 items-center gap-2 rounded px-2 text-left text-xs transition-colors hover:bg-[var(--surface-active)] active:scale-[.98] disabled:opacity-50"
                          onClick={() => { void qualifyLead(lead); close(); }}
                          disabled={qualifyingLeadId !== null}
                        >
                          <MagicWand size={14} aria-hidden="true" />
                          {qualifyingLeadId === lead.id ? "Qualificando…" : "Qualificar com IA"}
                        </button>
                      ) : null}
                      <LeadTagMenuItems leadId={lead.id} assigned={lead.tags} onChanged={mutate} />
                    </>)}
                  </PopoverMenu>
                </div>
              </td>
            </tr>)}</tbody>
          </table>}
        {!loading && pageState.hasMore ? <div className="flex justify-center p-3"><Button onClick={() => void loadMoreLeads()} disabled={loadingMore}>{loadingMore ? "Carregando…" : "Carregar mais contatos"}</Button></div> : null}
    </section>
    {canCreateLeads ? (
      <NewLeadDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={async () => { await mutate(); setCreateToast(true); window.setTimeout(() => setCreateToast(false), 2600); }}
      />
    ) : null}
    <SaveToast show={createToast}>Contato criado</SaveToast>
    </div>
  </Shell>;
}

