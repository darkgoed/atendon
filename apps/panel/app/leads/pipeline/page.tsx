"use client";

import { ArrowClockwise } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { BulkLeadActions } from "@/components/bulk-lead-actions";
import { PipelineBoard } from "@/components/pipeline-board";
import { PipelineFilters } from "@/components/pipeline-filters";
import { PipelineList } from "@/components/pipeline-list";
import { PipelineSettings } from "@/components/pipeline-settings";
import { PipelineTransitionDialog } from "@/components/pipeline-transition-dialog";
import { PipelineViewPreferences } from "@/components/pipeline-view-preferences";
import { SavedViewsControl } from "@/components/saved-views-control";
import { Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { updateLeadStatus } from "@/lib/leads-api";
import { useCaseOrganizationEnabled } from "@/lib/organization";
import {
  applyPipelineSavedView,
  buildOperationalPipelineStages,
  buildPipelineFilterQuery,
  buildPipelineTransitionPayload,
  CANONICAL_PIPELINE_STATUSES,
  currentPipelineStageId,
  EMPTY_PIPELINE_FILTERS,
  isOperationalPipelineStageId,
  pipelineFiltersForSavedView,
  pipelineStatusLabel,
  pipelineTransitionRequirement,
  type PipelineCommercialInput,
  type PipelineFollowUpConfig,
  type PipelineFilters as PipelineFilterState,
  type PipelineLead,
  type PipelineMember,
  type PipelineStage,
  type PipelineTransition
} from "@/lib/pipeline";
import { useRealtimeSignals } from "@/lib/realtime";
import { canAccessWithSession, hasWorkspaceWideCaseScope, type PanelSession } from "@/lib/session";
import { usePermission } from "@/lib/use-permission";
import { usePipelinePreferences } from "@/lib/use-pipeline-preferences";
import { Button } from "@/components/ui";
import { readPipelineViewPreference, writePipelineViewPreference } from "@/lib/pipeline-view";

type PipelineResponse = { leads: PipelineLead[]; timezone?: string };
type PipelineConfigResponse = { stages: PipelineStage[]; transitions: PipelineTransition[]; follow_up_config: PipelineFollowUpConfig; enforce_transitions?: boolean };
type MembersResponse = { members: PipelineMember[] };
type TransitionIntent = { lead: PipelineLead; target?: PipelineStage };

const fetcher = <T,>(url: string) => api<T>(url);
const fallbackStatusTransitions: Record<string, readonly string[]> = {
  novo: ["em_atendimento", "perdido"],
  em_atendimento: ["aguardando_resposta", "qualificado", "proposta_enviada", "follow_up", "perdido"],
  aguardando_resposta: ["em_atendimento", "qualificado", "proposta_enviada", "follow_up", "perdido"],
  qualificado: ["em_atendimento", "agendado", "em_negociacao", "proposta_enviada", "follow_up", "perdido"],
  agendado: ["qualificado", "em_negociacao", "proposta_enviada", "follow_up", "fechado", "perdido"],
  em_negociacao: ["proposta_enviada", "follow_up", "fechado", "perdido"],
  proposta_enviada: ["em_negociacao", "qualificado", "follow_up", "fechado", "perdido"],
  follow_up: ["em_atendimento", "aguardando_resposta", "qualificado", "agendado", "em_negociacao", "proposta_enviada", "fechado", "perdido"],
  fechado: [],
  perdido: ["em_atendimento", "follow_up", "fechado"]
};
const fallbackColors = ["var(--text-muted)", "var(--info)", "var(--text-muted)", "var(--primary)", "var(--cat-3)", "var(--danger)", "var(--warning)", "var(--info)", "var(--success)", "var(--danger)"];
const fallbackStages: PipelineStage[] = CANONICAL_PIPELINE_STATUSES.map((status, index) => ({ id: `fallback:${status}`, name: pipelineStatusLabel(status), color: fallbackColors[index], position: (index + 1) * 10, capacity_target: null, technical_status: status, is_default: true }));

const fallbackTransitions = Object.entries(fallbackStatusTransitions).flatMap(([source, targets]) => targets.map((target) => `fallback:${source}:fallback:${target}`));

export default function PipelinePage() {
  const canMove = usePermission("leads.update_status");
  const organizationEnabled = useCaseOrganizationEnabled();
  const [filters, setFilters] = useState<PipelineFilterState>({ ...EMPTY_PIPELINE_FILTERS });
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [pendingLeadIds, setPendingLeadIds] = useState<Set<string>>(() => new Set());
  const [intent, setIntent] = useState<TransitionIntent | null>(null);
  const [viewMode, setViewMode] = useState<"kanban" | "list">("kanban");
  const [showAllStages, setShowAllStages] = useState(false);
  const [actionError, setActionError] = useState("");
  const { data: session } = useSWR<PanelSession>("/me", fetcher, { revalidateOnFocus: false, dedupingInterval: 10_000 });
  const [preferences, setPreferences] = usePipelinePreferences(session?.activeWorkspace?.id, session?.user.id);
  const hasWorkspaceScope = Boolean(session && hasWorkspaceWideCaseScope(session));
  const canReadMembers = Boolean(session && canAccessWithSession(session, ["members.read"]));

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(filters.busca.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [filters.busca]);

  useEffect(() => {
    if (!session?.activeWorkspace?.id || !session.user.id) return;
    const stored = readPipelineViewPreference(session.activeWorkspace.id, session.user.id);
    if (stored) setViewMode(stored);
  }, [session?.activeWorkspace?.id, session?.user.id]);

  function changeView(mode: "kanban" | "list") {
    setViewMode(mode);
    if (session?.activeWorkspace?.id && session.user.id) writePipelineViewPreference(session.activeWorkspace.id, session.user.id, mode);
  }

  const queryFilters = useMemo(() => ({
    ...filters,
    busca: debouncedSearch,
    pipeline_stage_id: (organizationEnabled === false && filters.pipeline_stage_id.startsWith("fallback:"))
      || isOperationalPipelineStageId(filters.pipeline_stage_id)
      ? ""
      : filters.pipeline_stage_id
  }), [debouncedSearch, filters, organizationEnabled]);
  const leadsKey = `/scheduling/leads?${buildPipelineFilterQuery(queryFilters)}`;
  const { data, error: leadsError, mutate } = useSWR<PipelineResponse>(leadsKey, fetcher, {
    refreshInterval: 15_000,
    revalidateOnFocus: false,
    dedupingInterval: 5_000
  });
  const { data: pipelineData, error: pipelineError, mutate: mutatePipeline } = useSWR<PipelineConfigResponse>(
    organizationEnabled === true ? "/organization/pipeline" : null,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 10_000 }
  );
  const { data: membersData } = useSWR<MembersResponse>(canReadMembers ? "/workspaces/current/members" : null, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 30_000,
    shouldRetryOnError: false
  });

  const leads = useMemo(() => data?.leads ?? [], [data?.leads]);
  const configuredStages = useMemo(() => organizationEnabled === false
    ? fallbackStages
    : (pipelineData?.stages ?? []).filter((stage) => !stage.archived_at).sort((left, right) => left.position - right.position), [organizationEnabled, pipelineData?.stages]);
  const stages = useMemo(
    () => organizationEnabled === false
      ? configuredStages
      : buildOperationalPipelineStages(configuredStages, pipelineData?.follow_up_config),
    [configuredStages, organizationEnabled, pipelineData?.follow_up_config]
  );
  const boardStages = useMemo(() => showAllStages
    ? stages
    : stages.filter((stage) => ["novo", "em_atendimento", "qualificado", "em_negociacao", "fechado", "perdido"].includes(stage.technical_status)), [showAllStages, stages]);
  const allowedTransitions = useMemo(() => new Set(organizationEnabled === false
    ? fallbackTransitions
    : pipelineData?.enforce_transitions === false
      ? configuredStages.flatMap((source) => configuredStages.filter((target) => target.id !== source.id).map((target) => `${source.id}:${target.id}`))
      : (pipelineData?.transitions ?? []).map((transition) => `${transition.from_stage_id}:${transition.to_stage_id}`)), [configuredStages, organizationEnabled, pipelineData?.enforce_transitions, pipelineData?.transitions]);
  const members = useMemo(() => {
    if (membersData?.members) return membersData.members.filter((member) => member.status !== "suspended");
    const derived = new Map<string, PipelineMember>();
    for (const lead of leads) {
      for (const [id, email] of [[lead.sdr_member_id, lead.sdr_email], [lead.closer_member_id, lead.closer_email], [lead.recovery_member_id, lead.recovery_email]] as const) {
        if (id && email) derived.set(id, { id, email });
      }
    }
    return [...derived.values()].sort((left, right) => left.email.localeCompare(right.email));
  }, [leads, membersData?.members]);
  const loading = (!data && !leadsError) || organizationEnabled === null || (organizationEnabled === true && !pipelineData && !pipelineError);
  const visibleLeads = useMemo(() => {
    if (organizationEnabled === false && filters.pipeline_stage_id.startsWith("fallback:")) {
      return leads.filter((lead) => `fallback:${lead.status}` === filters.pipeline_stage_id);
    }
    if (isOperationalPipelineStageId(filters.pipeline_stage_id)) {
      return leads.filter((lead) => currentPipelineStageId(lead, stages, false) === filters.pipeline_stage_id);
    }
    return leads;
  }, [filters.pipeline_stage_id, leads, organizationEnabled, stages]);
  const loadError = leadsError?.message ?? pipelineError?.message;
  const hasActiveFilters = Object.values(filters).some(Boolean);
  const selectedItems = useMemo(() => leads.filter((lead) => selectedIds.has(lead.id)).map((lead) => ({ id: lead.id, expected_updated_at: lead.atualizado_em })), [leads, selectedIds]);

  useRealtimeSignals({
    onCatchUp: () => { if (document.visibilityState === "visible") void mutate(); },
    onSignal: (signal) => {
      if (document.visibilityState === "visible" && (
        signal.type === "conversation.messages.changed"
        || signal.type === "case.assignment.changed"
        || signal.type === "appointment.changed"
      )) void mutate();
    }
  });

  function toggleSelected(leadId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(leadId)) next.delete(leadId);
      else if (next.size < 200) next.add(leadId);
      return next;
    });
  }

  function targetsForLead(lead: PipelineLead): PipelineStage[] {
    const sourceId = organizationEnabled === false ? `fallback:${lead.status}` : lead.pipeline_stage_id;
    if (!sourceId) return [];
    const callStage = stages.find((stage) => stage.operational_kind === "call");
    return configuredStages
      .filter((target) => allowedTransitions.has(`${sourceId}:${target.id}`))
      .map((target) => callStage?.operational_source_stage_id === target.id ? callStage : target);
  }

  function requestMove(lead: PipelineLead, target?: PipelineStage) {
    if (pendingLeadIds.has(lead.id)) return;
    setActionError("");
    const targets = targetsForLead(lead);
    if (target && pipelineTransitionRequirement(target.technical_status) === null) {
      void moveLead(lead, target);
      return;
    }
    if (target || targets.length) setIntent({ lead, target });
    else setActionError(`Não há movimentos permitidos para ${lead.nome ?? "este lead"}.`);
  }

  async function moveLead(lead: PipelineLead, stage: PipelineStage, commercial?: PipelineCommercialInput) {
    setActionError("");
    const persistenceStage = stage.operational_source_stage_id
      ? configuredStages.find((candidate) => candidate.id === stage.operational_source_stage_id)
      : stage;
    if (!persistenceStage) {
      setActionError("A etapa técnica deste movimento não está mais disponível. Atualize o pipeline.");
      return;
    }
    if (organizationEnabled === false && pipelineTransitionRequirement(stage.technical_status) !== null) {
      setActionError("Este movimento exige o pipeline configurado para registrar os dados comerciais com segurança.");
      return;
    }
    setPendingLeadIds((current) => new Set(current).add(lead.id));
    const optimisticLeads = leads.map((item) => item.id === lead.id ? {
      ...item,
      status: persistenceStage.technical_status,
      pipeline_stage_id: persistenceStage.id,
      ai_follow_up: null
    } : item);
    const optimisticData: PipelineResponse = { ...(data ?? {}), leads: optimisticLeads };
    try {
      let expectedUpdatedAt = lead.atualizado_em;
      if (commercial && "responsavel_member_id" in commercial && commercial.responsavel_member_id) {
        await api(`/scheduling/leads/${lead.id}/follow-up`, {
          method: "PATCH",
          body: JSON.stringify({ responsavel_member_id: commercial.responsavel_member_id })
        });
        const refreshed = await api<{ lead?: { atualizado_em?: string } }>(`/scheduling/leads/${lead.id}`);
        expectedUpdatedAt = refreshed.lead?.atualizado_em ?? expectedUpdatedAt;
      }
      await mutate(async () => {
        if (stage.id.startsWith("fallback:")) {
          await updateLeadStatus(lead.id, persistenceStage.technical_status);
        } else {
          await api(`/organization/leads/${lead.id}/stage`, {
            method: "PATCH",
            body: JSON.stringify(buildPipelineTransitionPayload({ stage: persistenceStage, expectedUpdatedAt, commercial }))
          });
        }
        return optimisticData;
      }, { optimisticData, rollbackOnError: true, revalidate: true });
      setIntent(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Falha ao mover lead");
    } finally {
      setPendingLeadIds((current) => {
        const next = new Set(current);
        next.delete(lead.id);
        return next;
      });
    }
  }

  const retry = () => { void Promise.all([mutate(), organizationEnabled === true ? mutatePipeline() : Promise.resolve()]); };
  const dialogTargets = intent ? targetsForLead(intent.lead) : [];

  return (
    <Shell fitViewport>
      <div className="pipeline-page">
      <header className="pipeline-page__header">
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="truncate">{hasWorkspaceScope ? "Pipeline" : "Meu pipeline"}</h1>
          <div className="pipeline-page__view" aria-label="Visualização do pipeline">
            <Button type="button" aria-pressed={viewMode === "kanban"} onClick={() => changeView("kanban")}>Kanban</Button>
            <Button type="button" aria-pressed={viewMode === "list"} onClick={() => changeView("list")}>Lista</Button>
          </div>
          <span className="mono pipeline-page__count" role="status" aria-live="polite">{loading ? "carregando…" : `${leads.length} lead(s)`}</span>
        </div>
        <div className="pipeline-page__actions">
          <SavedViewsControl resource="pipeline" filters={pipelineFiltersForSavedView(filters)} onApply={(saved) => setFilters(applyPipelineSavedView(saved))} />
          <Button type="button" className="pipeline-page__stage-toggle" aria-pressed={showAllStages} onClick={() => setShowAllStages((current) => !current)}>Mostrar todas as etapas</Button>
          <PipelineViewPreferences value={preferences} onChange={setPreferences} />
          <PipelineSettings stages={pipelineData?.stages ?? []} transitions={pipelineData?.transitions ?? []} followUpConfig={pipelineData?.follow_up_config} onChanged={mutatePipeline} />
        </div>
      </header>

      <div className="pipeline-page__filterbar">
        <PipelineFilters filters={filters} stages={stages} members={members} hasWorkspaceScope={hasWorkspaceScope} onChange={setFilters} />
        <dl className="pipeline-page__stats" aria-label="Estatísticas do pipeline filtrado">
          <div><dt>Total</dt><dd>{visibleLeads.reduce((total, lead) => total + (lead.sale_value ?? 0), 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 })}</dd></div>
          <div><dt>Leads</dt><dd>{visibleLeads.length}</dd></div>
          <div><dt>Conversão</dt><dd>{visibleLeads.length ? `${Math.round((visibleLeads.filter((lead) => lead.status === "fechado").length / visibleLeads.length) * 100)}%` : "—"}</dd></div>
        </dl>
      </div>

      {actionError && !intent ? <div className="pipeline-error"><span>{actionError}</span><button type="button" className="btn crm-compact-button" onClick={retry}><ArrowClockwise size={13} aria-hidden="true" />Atualizar</button></div> : null}
      {loadError && leads.length > 0 ? <div className="pipeline-stale"><span>Os dados exibidos podem estar desatualizados: {loadError}</span><button type="button" className="btn crm-compact-button" onClick={retry}><ArrowClockwise size={13} aria-hidden="true" />Tentar novamente</button></div> : null}

      <div className="pipeline-page__board">
        {viewMode === "list" ? <PipelineList
          leads={visibleLeads}
          stages={stages}
          members={members}
          legacy={organizationEnabled === false}
          loading={loading}
          canMove={canMove}
          canSelect={organizationEnabled === true}
          selectedIds={selectedIds}
          pendingLeadIds={pendingLeadIds}
          onToggleSelected={toggleSelected}
          onMoveRequest={requestMove}
        /> : <PipelineBoard
          stages={boardStages}
          leads={visibleLeads}
          allowedTransitions={allowedTransitions}
          legacy={organizationEnabled === false}
          showAllStages={showAllStages}
          loading={loading}
          loadError={loadError}
          hasActiveFilters={hasActiveFilters}
          canMove={canMove}
          canSelect={organizationEnabled === true}
          selectedIds={selectedIds}
          pendingLeadIds={pendingLeadIds}
          preferences={preferences}
          timezone={data?.timezone ?? session?.activeWorkspace?.timezone}
          onToggleSelected={toggleSelected}
          onMoveRequest={requestMove}
          onRetry={retry}
        />}
      </div>

      {intent && dialogTargets.length ? (
        <PipelineTransitionDialog
          lead={intent.lead}
          targets={dialogTargets}
          initialTarget={intent.target}
          pending={pendingLeadIds.has(intent.lead.id)}
          error={actionError}
          timezone={data?.timezone ?? session?.activeWorkspace?.timezone ?? "UTC"}
          members={members}
          onClose={() => { if (!pendingLeadIds.has(intent.lead.id)) { setIntent(null); setActionError(""); } }}
          onSubmit={(stage, commercial) => moveLead(intent.lead, stage, commercial)}
        />
      ) : null}
      <BulkLeadActions selected={selectedItems} onClear={() => setSelectedIds(new Set())} onChanged={mutate} />
      </div>
    </Shell>
  );
}
