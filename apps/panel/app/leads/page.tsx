"use client";

import { MagicWand, MagnifyingGlass } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { BulkLeadActions } from "@/components/bulk-lead-actions";
import { ContactAvatar } from "@/components/contact-avatar";
import { Empty } from "@/components/page-state";
import { LeadTagChips, LeadTagPicker, type LeadTag } from "@/components/lead-tag-picker";
import { SavedViewsControl } from "@/components/saved-views-control";
import { TagCatalogSettings } from "@/components/tag-catalog-settings";
import { Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { buildLeadFilterQuery, type LeadFilters } from "@/lib/lead-filters";
import { leadStatusLabel } from "@/lib/labels";
import { applyLeadSavedViewFilters, leadFiltersForSavedView, useCaseOrganizationEnabled } from "@/lib/organization";
import { useRealtimeSignals } from "@/lib/realtime";
import { hasWorkspaceWideCaseScope, type PanelSession } from "@/lib/session";
import { usePermission } from "@/lib/use-permission";
import { Button, Select } from "@/components/ui";

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
type LeadsResponse = { leads: Lead[]; timezone?: string };
const fetcher = <T,>(url: string) => api<T>(url);

export default function LeadsPage() {
  const canReadFollowUp = usePermission("leads.follow_up.read");
  const canQualifyLeads = usePermission("leads.update_status");
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
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
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
  const { data, error: swrError, mutate } = useSWR<LeadsResponse>(`/scheduling/leads?${query}`, fetcher, {
    refreshInterval: 15_000, revalidateOnFocus: false, dedupingInterval: 5_000
  });
  const leads = useMemo(() => data?.leads ?? [], [data?.leads]);
  const timezone = data?.timezone ?? "UTC";
  const loading = !data && !swrError;
  const selectedItems = useMemo(() => leads.filter((lead) => selectedIds.has(lead.id)).map((lead) => ({ id: lead.id, expected_updated_at: lead.atualizado_em })), [leads, selectedIds]);
  const change = (key: keyof LeadFilters, value: string) => setFilters((current) => ({ ...current, [key]: value }));
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

  const activeFilterCount = Object.entries(filters).filter(([key, value]) => key !== "busca" ? Boolean(value) : Boolean(value.trim())).length;
  const clearFilters = () => setFilters({ status: "", unidade_id: "", categoria_id: "", parceiro_id: "", busca: "", estrelas: "", fila_humana: "" });
  return <Shell fitViewport>
    <div className="leads-page">
    <header className="leads-page__header">
      <div><h1>{hasWorkspaceScope ? "Leads" : "Meus leads"}</h1><p>{hasWorkspaceScope ? "Qualificação contextual, decisão humana e reuniões em um só fluxo." : "Leads atribuídos a você, com qualificação, histórico e próximas ações."}</p></div>
      <div className="leads-page__actions flex min-h-8 flex-nowrap items-center">
        <SavedViewsControl resource="leads" filters={leadFiltersForSavedView(filters)} onApply={applySavedFilters} />
        <Button aria-expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)}>Filtros{activeFilterCount ? ` (${activeFilterCount})` : ""}</Button>
        <TagCatalogSettings />
        <BulkLeadActions selected={selectedItems} onClear={() => setSelectedIds(new Set())} onChanged={mutate} />
        <span className="crm-meta mono" role="status" aria-live="polite">{loading ? "carregando…" : `${leads.length} resultado(s)`}</span>
      </div>
    </header>
    {filtersOpen ? <section className="leads-filters" aria-label="Filtros de leads">
      <label className="field"><span className="label">Busca</span><span className="search-field"><MagnifyingGlass aria-hidden="true" /><input className="input" value={filters.busca} onChange={(event) => change("busca", event.target.value)} placeholder="Nome ou telefone" /></span></label>
      <Filter label="Status" value={filters.status} onChange={(value) => change("status", value)} options={statuses.map((id) => ({ id, nome: id ? leadStatusLabel(id) : "Todos" }))} /><Filter label="Avaliação" value={filters.estrelas} onChange={(value) => change("estrelas", value)} options={[{ id: "", nome: "Todas" }, ...[1, 2, 3, 4, 5].map((stars) => ({ id: String(stars), nome: `${stars} ${stars === 1 ? "estrela" : "estrelas"}` }))]} /><Filter label="Fila humana" value={filters.fila_humana} onChange={(value) => change("fila_humana", value)} options={[{ id: "", nome: "Todos" }, { id: "true", nome: "Requer decisão humana" }]} /><Filter label="Agenda" value={filters.unidade_id} onChange={(value) => change("unidade_id", value)} options={[{ id: "", nome: "Todas" }, ...options.unidades]} /><Filter label="Categoria" value={filters.categoria_id} onChange={(value) => change("categoria_id", value)} options={[{ id: "", nome: "Todas" }, ...options.categorias]} /><Filter label="Parceiro" value={filters.parceiro_id} onChange={(value) => change("parceiro_id", value)} options={[{ id: "", nome: "Todos" }, ...options.parceiros]} /><button type="button" className="btn" onClick={clearFilters}>Limpar</button>
    </section> : null}
    {error ? <p className="error mb-4" role="alert">{error}</p> : null}
    {feedback ? <p className="accent mb-4" role="status" aria-live="polite">{feedback}</p> : null}
    {accessNotice ? <p className="mb-4 rounded border border-[var(--border-ai)] p-3 text-sm text-[var(--accent-soft)]" role="status">{accessNotice}</p> : null}
    {swrError ? <p className="error mb-4" role="alert">{swrError.message}</p> : null}
    <section className="leads-table-surface responsive-table-wrap overflow-y-auto">
      {loading ? <div className="grid gap-2 p-4" role="status" aria-label="Carregando leads">{[1, 2, 3, 4].map((item) => <div key={item} className="skeleton h-12" aria-hidden="true" />)}</div>
        : leads.length === 0 ? <Empty>Nenhum lead corresponde aos filtros.</Empty>
          : <table className={`responsive-table leads-table crm-lead-table whitespace-nowrap ${canReadFollowUp ? "crm-lead-table--follow-up" : "crm-lead-table--basic"}`}>
            <thead><tr>{["Lead", "Etapa", "Contexto", ...(canReadFollowUp ? ["Acompanhamento"] : []), "Atualizado", "Ações"].map((label) => <th key={label}>{label}</th>)}</tr></thead>
            <tbody>{leads.map((lead) => <tr key={lead.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--active)]">
              <td data-label="Lead">
                <div className="leads-table__identity">
                  {organizationEnabled === true ? <input type="checkbox" checked={selectedIds.has(lead.id)} onChange={() => setSelectedIds((current) => { const next = new Set(current); if (next.has(lead.id)) next.delete(lead.id); else if (next.size < 200) next.add(lead.id); return next; })} aria-label={`Selecionar ${lead.nome ?? lead.telefone}`} /> : null}
                  <ContactAvatar name={lead.nome ?? lead.telefone} src={lead.avatar_url} className="h-8 w-8 text-xs" />
                  <div className="min-w-0"><strong>{lead.nome ?? "Sem nome"}</strong><span className="mono">{lead.telefone}</span><LeadTagChips tags={lead.tags} compact /></div>
                </div>
              </td>
              <td data-label="Etapa"><div className="leads-table__stage"><span>{leadStatusLabel(lead.status)}</span><small className="mono">{lead.qualificacao ? `${lead.qualificacao.estrelas}/5` : "sem score"}</small>{lead.qualificacao?.requer_decisao_humana ? <em>Decisão humana</em> : null}</div></td>
              <td data-label="Resumo"><div className="leads-table__context"><strong className="block truncate" title={lead.qualificacao?.resumo ?? undefined}>{lead.qualificacao?.resumo ?? "Sem resumo de qualificação"}</strong><span>{lead.qualificacao?.origem_facebook?.headline ?? lead.origem_facebook?.headline ?? lead.origem ?? "Origem não informada"}</span><small>{lead.unidade_nome ?? lead.categoria_nome ?? "Sem agenda associada"}</small></div></td>
              {canReadFollowUp ? <td data-label="Acompanhamento"><div className="leads-table__follow-up"><strong>{lead.proxima_acao ?? "Nenhuma ação"}</strong>{lead.proxima_acao_em ? <time className="mono">{new Date(lead.proxima_acao_em).toLocaleString("pt-BR", { timeZone: timezone })}</time> : null}<span>{lead.responsavel_email ?? "Não atribuído"}</span><small>{lead.responsavel_disponibilidade === "available" ? "Disponível" : lead.responsavel_disponibilidade === "unavailable" ? "Indisponível" : "Fora do pool"}</small></div></td> : null}
              <td data-label="Atualizado" className="mono leads-table__updated">{new Date(lead.atualizado_em).toLocaleString("pt-BR")}</td>
              <td data-label="Ações">
                <div className="leads-table__actions flex flex-nowrap">
                  <LeadTagPicker leadId={lead.id} assigned={lead.tags} onChanged={mutate} />
                  {!lead.qualificacao && canQualifyLeads ? (
                    <button
                      type="button"
                      className="btn primary crm-compact-button"
                      onClick={() => void qualifyLead(lead)}
                      disabled={qualifyingLeadId !== null}
                    >
                      <MagicWand size={16} aria-hidden="true" />
                      {qualifyingLeadId === lead.id ? "Qualificando…" : "Qualificar com IA"}
                    </button>
                  ) : null}
                  <Link className="btn crm-compact-button" href={`/leads/${lead.id}`}>Ver detalhes</Link>
                </div>
              </td>
            </tr>)}</tbody>
          </table>}
    </section>
    </div>
  </Shell>;
}

function Filter({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Option[] }) {
  return <label className="field"><span className="label">{label}</span><Select value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option.id} value={option.id}>{option.nome}</option>)}</Select></label>;
}
