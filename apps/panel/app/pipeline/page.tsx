"use client";

import { ArrowClockwise } from "@/components/icons";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState, type CSSProperties } from "react";
import useSWR from "swr";
import { BulkLeadActions } from "@/components/bulk-lead-actions";
import { PipelineBoard } from "@/components/pipeline-board";
import { PipelineFilters } from "@/components/pipeline-filters";
import { PipelineList } from "@/components/pipeline-list";
import { PipelineManager } from "@/components/pipeline-manager";
import { PipelineTransitionDialog } from "@/components/pipeline-transition-dialog";
import { PipelineViewPreferences } from "@/components/pipeline-view-preferences";
import { SavedViewsControl } from "@/components/saved-views-control";
import { Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
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
  pipelineBoardStageId,
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
import {
  type PipelinesResponse,
  type PipelineSummary
} from "@/lib/pipeline";
import { usePipelinePreferences } from "@/lib/use-pipeline-preferences";
import { Button, IconButton, SaveToast } from "@/components/ui";
import { readPipelineViewPreference, writePipelineViewPreference } from "@/lib/pipeline-view";

type PipelinePageMeta = { limit: number; has_more: boolean; next_cursor: string | null };
type PipelineResponse = { leads: PipelineLead[]; timezone?: string; total?: number; page?: PipelinePageMeta };
type PipelineConfigResponse = { stages: PipelineStage[]; transitions: PipelineTransition[]; follow_up_config: PipelineFollowUpConfig; enforce_transitions?: boolean; pipeline?: PipelineSummary };
type MembersResponse = { members: PipelineMember[] };
type TransitionIntent = { lead: PipelineLead; target?: PipelineStage };
type StagePageState = { leads: PipelineLead[]; cursor: string | null; hasMore: boolean; loading: boolean };

const PIPELINE_PAGE_SIZE = 150;
const STAGE_PAGE_SIZE = 50;

// Mirrors the backend lead cursor: {v, updated_at, id} base64url (unpadded,
// url-safe — the server rejects non-canonical cursors).
function encodeLeadPageCursor(lead: { id: string; atualizado_em: string }): string {
  const json = JSON.stringify({ v: 1, updated_at: new Date(lead.atualizado_em).toISOString(), id: lead.id });
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

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
const fallbackColors = ["var(--text-muted)", "var(--info)", "var(--text-muted)", "var(--primary)", "var(--cat-3-text)", "var(--danger)", "var(--warning)", "var(--info)", "var(--success)", "var(--danger)"];
const fallbackStages: PipelineStage[] = CANONICAL_PIPELINE_STATUSES.map((status, index) => ({ id: `fallback:${status}`, name: pipelineStatusLabel(status), color: fallbackColors[index], position: (index + 1) * 10, capacity_target: null, technical_status: status, is_default: true }));

const fallbackTransitions = Object.entries(fallbackStatusTransitions).flatMap(([source, targets]) => targets.map((target) => `fallback:${source}:fallback:${target}`));

type Celebration = { key: number; name: string };

const PIPELINE_ACTIVE_KEY = "atendon.pipeline.active.v1";
function readStoredPipelineId(workspaceId: string | undefined, userId: string | undefined): string | null {
  if (!workspaceId || !userId || typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(`${PIPELINE_ACTIVE_KEY}:${workspaceId}:${userId}`);
  } catch {
    return null;
  }
}
function writeStoredPipelineId(workspaceId: string | undefined, userId: string | undefined, pipelineId: string | null) {
  if (!workspaceId || !userId || typeof window === "undefined") return;
  try {
    if (pipelineId) window.localStorage.setItem(`${PIPELINE_ACTIVE_KEY}:${workspaceId}:${userId}`, pipelineId);
    else window.localStorage.removeItem(`${PIPELINE_ACTIVE_KEY}:${workspaceId}:${userId}`);
  } catch {
    // storage cheio/bloqueado: a seleção continua válida só nesta sessão.
  }
}

/**
 * Pipeline ativo: ?pipeline=<id> na URL vence; senão o salvo por
 * workspace+usuário (se ainda existir entre os ativos); senão o padrão.
 */
function resolveActivePipeline(
  pipelines: PipelineSummary[],
  urlPipelineId: string | null,
  storedPipelineId: string | null
): PipelineSummary | null {
  if (pipelines.length === 0) return null;
  const byUrl = urlPipelineId ? pipelines.find((pipeline) => pipeline.id === urlPipelineId) : undefined;
  if (byUrl) return byUrl;
  const stored = storedPipelineId ? pipelines.find((pipeline) => pipeline.id === storedPipelineId) : undefined;
  if (stored) return stored;
  return pipelines.find((pipeline) => pipeline.is_default) ?? pipelines[0]!;
}

const CONFETTI_COLORS = ["var(--primary)", "var(--success)", "var(--warning)"];

/**
 * Confete do fechamento (DS v2, ref. Pipeline.dc.html): 12 partículas com
 * trajetória aleatória via variáveis CSS (--x/--y/--r), animação .on-burst de
 * 0,9s; os spans saem da árvore logo após a animação terminar.
 */
function PipelineWinBurst() {
  const [bursting, setBursting] = useState(true);
  const parts = useMemo(() => Array.from({ length: 12 }, (_, index) => ({
    x: Math.round((Math.random() * 2 - 1) * 80),
    y: -Math.round(30 + Math.random() * 90),
    r: Math.round((Math.random() * 2 - 1) * 220),
    color: CONFETTI_COLORS[index % CONFETTI_COLORS.length],
    delay: (index % 5) * 0.02
  })), []);
  useEffect(() => {
    const timer = window.setTimeout(() => setBursting(false), 1000);
    return () => window.clearTimeout(timer);
  }, []);
  if (!bursting) return null;
  return (
    <div className="pipeline-confetti" aria-hidden="true">
      {parts.map((part, index) => (
        <span
          key={index}
          style={{ "--x": `${part.x}px`, "--y": `${part.y}px`, "--r": `${part.r}deg`, "--c": part.color, "--d": `${part.delay}s` } as CSSProperties}
        />
      ))}
    </div>
  );
}

function PipelinePageContent() {
  const canMove = usePermission("leads.update_status");
  const canManagePipeline = usePermission("pipeline.manage");
  const organizationEnabled = useCaseOrganizationEnabled();
  const searchParams = useSearchParams();
  const urlPipelineId = searchParams?.get("pipeline") ?? null;
  const [manuallySelectedPipelineId, setManuallySelectedPipelineId] = useState<string | null>(null);
  const [filters, setFilters] = useState<PipelineFilterState>({ ...EMPTY_PIPELINE_FILTERS });
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [pendingLeadIds, setPendingLeadIds] = useState<Set<string>>(() => new Set());
  const [intent, setIntent] = useState<TransitionIntent | null>(null);
  const [viewMode, setViewMode] = useState<"kanban" | "list">("kanban");
  const [actionError, setActionError] = useState("");
  const [celebration, setCelebration] = useState<Celebration | null>(null);
  const { data: session } = useSWR<PanelSession>("/me", fetcher, { revalidateOnFocus: false, dedupingInterval: 10_000 });
  const [preferences, setPreferences] = usePipelinePreferences(session?.activeWorkspace?.id, session?.user.id);
  const hasWorkspaceScope = Boolean(session && hasWorkspaceWideCaseScope(session));
  const canReadMembers = Boolean(session && canAccessWithSession(session, ["members.read"]));

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(filters.busca.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [filters.busca]);

  useEffect(() => {
    if (!celebration) return;
    const timer = window.setTimeout(() => setCelebration(null), 2600);
    return () => window.clearTimeout(timer);
  }, [celebration]);

  useEffect(() => {
    if (!session?.activeWorkspace?.id || !session.user.id) return;
    const stored = readPipelineViewPreference(session.activeWorkspace.id, session.user.id);
    if (stored) setViewMode(stored);
  }, [session?.activeWorkspace?.id, session?.user.id]);

  function changeView(mode: "kanban" | "list") {
    setViewMode(mode);
    if (session?.activeWorkspace?.id && session.user.id) writePipelineViewPreference(session.activeWorkspace.id, session.user.id, mode);
  }

  const { data: pipelinesData, mutate: mutatePipelines } = useSWR<PipelinesResponse>(
    organizationEnabled === true ? "/organization/pipelines" : null,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 10_000 }
  );
  const pipelines = useMemo(() => pipelinesData?.pipelines ?? [], [pipelinesData?.pipelines]);
  // Persistência: leitura única após a sessão carregar; escrita na troca manual.
  const [storedPipelineId, setStoredPipelineId] = useState<string | null>(null);
  useEffect(() => {
    if (!session?.activeWorkspace?.id || !session.user.id) return;
    setStoredPipelineId(readStoredPipelineId(session.activeWorkspace.id, session.user.id));
  }, [session?.activeWorkspace?.id, session?.user.id]);
  const activePipeline = useMemo(
    () => resolveActivePipeline(pipelines, urlPipelineId, manuallySelectedPipelineId ?? storedPipelineId),
    [manuallySelectedPipelineId, pipelines, storedPipelineId, urlPipelineId]
  );

  // URL vence: ?pipeline=<id> na barra sempre reflete a seleção atual.
  function selectPipeline(pipelineId: string | null) {
    setManuallySelectedPipelineId(pipelineId);
    writeStoredPipelineId(session?.activeWorkspace?.id, session?.user.id, pipelineId);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (pipelineId) url.searchParams.set("pipeline", pipelineId);
    else url.searchParams.delete("pipeline");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function handlePipelinesChanged() {
    // Lista + configuração do pipeline ativo (cores/ordem/leads mudam juntos).
    void mutatePipelines();
    void mutatePipeline();
    return true;
  }

  const queryFilters = useMemo(() => ({
    ...filters,
    busca: debouncedSearch,
    pipeline_stage_id: (organizationEnabled === false && filters.pipeline_stage_id.startsWith("fallback:"))
      || isOperationalPipelineStageId(filters.pipeline_stage_id)
      ? ""
      : filters.pipeline_stage_id
  }), [debouncedSearch, filters, organizationEnabled]);
  const leadsKey = `/scheduling/leads?${[buildPipelineFilterQuery(queryFilters), activePipeline ? `pipeline_id=${activePipeline.id}` : "", `limit=${PIPELINE_PAGE_SIZE}`].filter(Boolean).join("&")}`;
  // Server-side keyset pagination: the SWR key fetches the first page (what
  // the 15s poll refreshes). List view appends older pages by cursor; kanban
  // loads more per column (anchored on that column's oldest loaded lead). The
  // poll never overwrites the anchor cursors once extra pages exist.
  const [extraLeads, setExtraLeads] = useState<PipelineLead[]>([]);
  const [pageState, setPageState] = useState<{ cursor: string | null; hasMore: boolean; fetchedPages: number }>({ cursor: null, hasMore: false, fetchedPages: 0 });
  const [loadingMore, setLoadingMore] = useState(false);
  const [stagePages, setStagePages] = useState<Record<string, StagePageState>>({});
  // Override otimista por lead: { pipeline_stage_id, status } aplicado sobre
  // TODAS as fontes (página 1 + extras + páginas por coluna) até a revalidação
  // terminar; em erro é limpo (rollback) e em 409 o quadro é revalidado.
  const [stageOverrides, setStageOverrides] = useState<Map<string, { pipeline_stage_id: string | null; status: string }>>(() => new Map());
  useEffect(() => {
    setExtraLeads([]);
    setPageState({ cursor: null, hasMore: false, fetchedPages: 0 });
    setLoadingMore(false);
    setStagePages({});
    setStageOverrides(new Map());
  }, [leadsKey]);
  const { data, error: leadsError, mutate } = useSWR<PipelineResponse>(leadsKey, fetcher, {
    refreshInterval: 15_000,
    revalidateOnFocus: false,
    dedupingInterval: 5_000
  });
  useEffect(() => {
    const page = data?.page;
    if (!page || pageState.fetchedPages > 0) return;
    setPageState((current) => current.fetchedPages > 0 ? current : { cursor: page.next_cursor, hasMore: page.has_more, fetchedPages: 0 });
  }, [data?.page, pageState.fetchedPages]);
  const pipelineConfigKey = organizationEnabled === true
    ? (activePipeline ? `/organization/pipeline?pipeline_id=${activePipeline.id}` : "/organization/pipeline")
    : null;
  const { data: pipelineData, error: pipelineError, mutate: mutatePipeline } = useSWR<PipelineConfigResponse>(
    pipelineConfigKey,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 10_000 }
  );
  const { data: membersData } = useSWR<MembersResponse>(canReadMembers ? "/workspaces/current/members" : null, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 30_000,
    shouldRetryOnError: false
  });

  const leads = useMemo(() => {
    const fresh = data?.leads ?? [];
    const extras = [...extraLeads, ...Object.values(stagePages).flatMap((page) => page.leads)];
    if (extras.length === 0) return fresh;
    const seen = new Set(fresh.map((lead) => lead.id));
    const merged = [...fresh];
    for (const lead of extras) {
      if (!seen.has(lead.id)) {
        seen.add(lead.id);
        merged.push(lead);
      }
    }
    return merged;
  }, [data?.leads, extraLeads, stagePages]);
  // Overrides por cima do merge: cada id recebe o override UMA vez (a cópia
  // vencedora do dedupe), então nenhuma fonte mostra o valor antigo.
  const overriddenLeads = useMemo(() => {
    if (stageOverrides.size === 0) return leads;
    return leads.map((lead) => {
      const override = stageOverrides.get(lead.id);
      return override ? { ...lead, status: override.status, pipeline_stage_id: override.pipeline_stage_id, ai_follow_up: null } : lead;
    });
  }, [leads, stageOverrides]);
  const total = data?.total ?? overriddenLeads.length;
  const configuredStages = useMemo(() => organizationEnabled === false
    ? fallbackStages
    : (pipelineData?.stages ?? []).filter((stage) => !stage.archived_at).sort((left, right) => left.position - right.position), [organizationEnabled, pipelineData?.stages]);
  const stages = useMemo(
    () => organizationEnabled === false
      ? configuredStages
      : buildOperationalPipelineStages(configuredStages, pipelineData?.follow_up_config),
    [configuredStages, organizationEnabled, pipelineData?.follow_up_config]
  );
  // Modo legado (organizationEnabled === false) mantém a projeção de colunas
  // comerciais; com organização ativa TODAS as etapas do pipeline são colunas.
  const boardStages = useMemo(() => (organizationEnabled === false
    ? stages.filter((stage) => ["novo", "em_atendimento", "qualificado", "em_negociacao", "fechado", "perdido"].includes(stage.technical_status))
    : stages), [organizationEnabled, stages]);
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
      return overriddenLeads.filter((lead) => `fallback:${lead.status}` === filters.pipeline_stage_id);
    }
    if (isOperationalPipelineStageId(filters.pipeline_stage_id)) {
      return overriddenLeads.filter((lead) => currentPipelineStageId(lead, stages, false) === filters.pipeline_stage_id);
    }
    return overriddenLeads;
  }, [filters.pipeline_stage_id, organizationEnabled, overriddenLeads, stages]);
  const loadError = leadsError?.message ?? pipelineError?.message;
  const hasActiveFilters = Object.values(filters).some(Boolean);
  const selectedItems = useMemo(() => overriddenLeads.filter((lead) => selectedIds.has(lead.id)).map((lead) => ({ id: lead.id, expected_updated_at: lead.atualizado_em })), [overriddenLeads, selectedIds]);

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

  async function loadMoreLeads() {
    if (!pageState.cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const response = await api<PipelineResponse>(`${leadsKey}&cursor=${encodeURIComponent(pageState.cursor)}`);
      setExtraLeads((current) => {
        const seen = new Set(current.map((lead) => lead.id));
        return [...current, ...response.leads.filter((lead) => !seen.has(lead.id))];
      });
      setPageState((current) => ({
        cursor: response.page?.next_cursor ?? null,
        hasMore: Boolean(response.page?.has_more),
        fetchedPages: current.fetchedPages + 1
      }));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Falha ao carregar mais leads");
    } finally {
      setLoadingMore(false);
    }
  }

  async function loadMoreForStage(stage: PipelineStage) {
    const state = stagePages[stage.id];
    if (state?.loading) return;
    // Anchor: the column's own keyset cursor once extras exist; otherwise the
    // oldest lead already loaded in that column (the global page-1 stream
    // interleaves stages, so the column defines its own page chain).
    const anchor = state?.cursor ?? (() => {
      const columnLeads = leads.filter((lead) => pipelineBoardStageId(lead, stages, organizationEnabled !== false) === stage.id);
      const last = columnLeads.at(-1);
      return last ? encodeLeadPageCursor(last) : null;
    })();
    if (!anchor && (state?.leads.length ?? 0) > 0) return;
    setStagePages((current) => ({
      ...current,
      [stage.id]: { leads: current[stage.id]?.leads ?? [], cursor: anchor, hasMore: current[stage.id]?.hasMore ?? false, loading: true }
    }));
    try {
      const params = new URLSearchParams(buildPipelineFilterQuery(queryFilters));
      params.delete("pipeline_stage_id");
      if (organizationEnabled === false) params.set("status", stage.technical_status);
      else params.set("pipeline_stage_id", stage.operational_source_stage_id ?? stage.id);
      params.set("limit", String(STAGE_PAGE_SIZE));
      if (anchor) params.set("cursor", anchor);
      const response = await api<PipelineResponse>(`/scheduling/leads?${params.toString()}`);
      setStagePages((current) => {
        const existing = current[stage.id];
        const seen = new Set((existing?.leads ?? []).map((lead) => lead.id));
        return {
          ...current,
          [stage.id]: {
            leads: [...(existing?.leads ?? []), ...response.leads.filter((lead) => !seen.has(lead.id))],
            cursor: response.page?.next_cursor ?? null,
            hasMore: Boolean(response.page?.has_more),
            loading: false
          }
        };
      });
    } catch (cause) {
      setStagePages((current) => ({
        ...current,
        [stage.id]: { leads: current[stage.id]?.leads ?? [], cursor: current[stage.id]?.cursor ?? null, hasMore: current[stage.id]?.hasMore ?? false, loading: false }
      }));
      setActionError(cause instanceof Error ? cause.message : "Falha ao carregar mais leads da etapa");
    }
  }

  const columnLoadMore = useMemo(() => {
    const map = new Map<string, { remaining: number | null; loading: boolean; visible: boolean }>();
    for (const stage of stages) {
      const state = stagePages[stage.id];
      const loaded = leads.filter((lead) => pipelineBoardStageId(lead, stages, organizationEnabled !== false) === stage.id).length;
      const serverCount = organizationEnabled === true
        ? pipelineData?.stages.find((candidate) => candidate.id === (stage.operational_source_stage_id ?? stage.id))?.lead_count
        : undefined;
      const remaining = typeof serverCount === "number" ? Math.max(0, serverCount - loaded) : null;
      // An exhausted column (a fetch that returned has_more=false) stays hidden
      // even if the server count drifted — retrying would re-fetch the same rows.
      const exhausted = state != null && !state.hasMore;
      const visible = !exhausted && (Boolean(state?.hasMore) || (remaining != null && remaining > 0));
      map.set(stage.id, { remaining, loading: Boolean(state?.loading), visible });
    }
    return map;
  }, [leads, organizationEnabled, pipelineData?.stages, stagePages, stages]);

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
    // Override otimista: vale para página 1 + extras + páginas por coluna até
    // a revalidação terminar (sucesso limpa; erro limpa = rollback visual).
    setStageOverrides((current) => new Map(current).set(lead.id, {
      pipeline_stage_id: persistenceStage.id,
      status: persistenceStage.technical_status
    }));
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
        await mutate();
        return undefined;
      }, { optimisticData: data, populateCache: false, rollbackOnError: false, revalidate: false });
      // Fechamento bem-sucedido: confete + toast (ref. Pipeline.dc.html).
      if (persistenceStage.technical_status === "fechado") {
        setCelebration({ key: Date.now(), name: lead.nome ?? "Lead" });
      }
      setIntent(null);
    } catch (cause) {
      // Erro = rollback visual (override some, card volta de onde estava).
      setStageOverrides((current) => {
        const next = new Map(current);
        next.delete(lead.id);
        return next;
      });
      setActionError(cause instanceof Error ? cause.message : "Falha ao mover lead");
      if (cause instanceof ApiError && cause.status === 409) {
        // Lead alterado por outra operação: o servidor é a verdade.
        void mutate();
      }
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
          {organizationEnabled === true ? <PipelineManager pipelines={pipelines} activePipeline={activePipeline} channels={pipelinesData?.channels ?? []} canManage={canManagePipeline} onSelect={selectPipeline} onChanged={handlePipelinesChanged} /> : null}
          <div className="pipeline-page__view" aria-label="Visualização do pipeline">
            <Button type="button" aria-pressed={viewMode === "kanban"} onClick={() => changeView("kanban")}>Kanban</Button>
            <Button type="button" aria-pressed={viewMode === "list"} onClick={() => changeView("list")}>Lista</Button>
          </div>
          <span className="mono pipeline-page__count" role="status" aria-live="polite">{loading ? "carregando…" : `${total} lead(s)`}</span>
        </div>
        <div className="pipeline-page__actions">
          <SavedViewsControl resource="pipeline" filters={pipelineFiltersForSavedView(filters)} onApply={(saved) => setFilters(applyPipelineSavedView(saved))} />
          <PipelineViewPreferences value={preferences} onChange={setPreferences} />
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

      {actionError && !intent ? <div className="pipeline-error"><span>{actionError}</span><IconButton label="Atualizar" onClick={retry}><ArrowClockwise size={15} aria-hidden="true" /></IconButton></div> : null}
      {loadError && leads.length > 0 ? <div className="pipeline-stale"><span>Os dados exibidos podem estar desatualizados: {loadError}</span><IconButton label="Tentar novamente" onClick={retry}><ArrowClockwise size={15} aria-hidden="true" /></IconButton></div> : null}

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
          pipelineId={activePipeline?.id}
          manageStages={canManagePipeline && organizationEnabled === true}
          onStagesChanged={handlePipelinesChanged}
          transitions={pipelineData?.transitions}
          enforceTransitions={pipelineData?.enforce_transitions}
          loading={loading}
          loadError={loadError}
          hasActiveFilters={hasActiveFilters}
          canMove={canMove}
          canSelect={organizationEnabled === true}
          selectedIds={selectedIds}
          pendingLeadIds={pendingLeadIds}
          preferences={preferences}
          timezone={data?.timezone ?? session?.activeWorkspace?.timezone}
          columnLoadMore={columnLoadMore}
          onColumnLoadMore={loadMoreForStage}
          onToggleSelected={toggleSelected}
          onMoveRequest={requestMove}
          onRetry={retry}
        />}
        {viewMode === "list" && !loading && pageState.hasMore ? (
          <div className="flex justify-center p-3">
            <Button type="button" onClick={() => void loadMoreLeads()} disabled={loadingMore}>{loadingMore ? "Carregando…" : "Carregar mais leads"}</Button>
          </div>
        ) : null}
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
      {celebration ? <PipelineWinBurst key={celebration.key} /> : null}
      <SaveToast show={celebration !== null}>Negócio fechado · {celebration?.name}</SaveToast>
      </div>
    </Shell>
  );
}

// useSearchParams exige Suspense no App Router (?pipeline=<id> seleciona o pipeline).
export default function PipelinePage() {
  return <Suspense fallback={null}><PipelinePageContent /></Suspense>;
}
