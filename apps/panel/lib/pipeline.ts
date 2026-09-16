import type { LeadTag } from "@/components/lead-tag-picker";

export const PIPELINE_FILTER_KEYS = [
  "busca",
  "pipeline_stage_id",
  "sdr_member_id",
  "closer_member_id",
  "origem",
  "campanha",
  "period_start",
  "period_end",
  "appointment_status",
  "commercial_outcome",
  "action_bucket"
] as const;

export type PipelineFilterKey = (typeof PIPELINE_FILTER_KEYS)[number];
export type PipelineFilters = Record<PipelineFilterKey, string>;
export type PipelineActionBucket = "result_pending" | "recovery" | "overdue_follow_up" | "today";

export const EMPTY_PIPELINE_FILTERS: PipelineFilters = {
  busca: "",
  pipeline_stage_id: "",
  sdr_member_id: "",
  closer_member_id: "",
  origem: "",
  campanha: "",
  period_start: "",
  period_end: "",
  appointment_status: "",
  commercial_outcome: "",
  action_bucket: ""
};

export const CANONICAL_PIPELINE_STATUSES = [
  "novo",
  "em_atendimento",
  "aguardando_resposta",
  "qualificado",
  "agendado",
  "em_negociacao",
  "proposta_enviada",
  "follow_up",
  "fechado",
  "perdido"
] as const;

export type CanonicalPipelineStatus = (typeof CANONICAL_PIPELINE_STATUSES)[number];

const canonicalStatusLabels: Record<CanonicalPipelineStatus, string> = {
  novo: "Novo",
  em_atendimento: "Em atendimento",
  aguardando_resposta: "Aguardando resposta",
  qualificado: "Qualificado",
  agendado: "Agendado",
  em_negociacao: "Em negociação",
  proposta_enviada: "Proposta enviada",
  follow_up: "Follow-up",
  fechado: "Fechado",
  perdido: "Perdido"
};

export type PipelineStage = {
  id: string;
  name: string;
  color: string;
  position: number;
  capacity_target?: number | null;
  technical_status: string;
  is_default: boolean;
  lead_count?: number;
  archived_at?: string | null;
  operational_kind?: "ai_follow_up" | "call";
  operational_source_stage_id?: string;
  follow_up_attempt?: number;
};

export type PipelineTransition = { from_stage_id: string; to_stage_id: string };
export type PipelineFollowUpConfig = { enabled: boolean; max_count: number };
export type PipelineAiFollowUpProgress = {
  count: number;
  status: "scheduled" | "processing" | "cancelled" | "completed" | "failed";
  next_run_at?: string | null;
  cancellation_reason?: string | null;
};

export type PipelineLead = {
  id: string;
  telefone: string;
  nome?: string;
  avatar_url?: string | null;
  status: string;
  interesse?: string | null;
  situacao?: string | null;
  origem?: string | null;
  campanha?: string | null;
  unidade_nome?: string;
  atualizado_em: string;
  pipeline_stage_id?: string | null;
  tags?: LeadTag[];
  qualificacao?: { estrelas: number; requer_decisao_humana: boolean } | null;
  responsavel_member_id?: string | null;
  responsavel_email?: string | null;
  sdr_member_id?: string | null;
  sdr_email?: string | null;
  closer_member_id?: string | null;
  closer_email?: string | null;
  recovery_required?: boolean;
  recovery_member_id?: string | null;
  recovery_email?: string | null;
  commercial_outcome?: string | null;
  sale_value?: number | null;
  loss_reason?: string | null;
  loss_reason_note?: string | null;
  proxima_acao?: string | null;
  proxima_acao_em?: string | null;
  ai_follow_up?: PipelineAiFollowUpProgress | null;
  latest_appointment?: {
    id: string;
    start: string;
    end: string;
    status: string;
    result_pending_at?: string | null;
    result_pending?: boolean;
  } | null;
};

export type PipelineMember = {
  id: string;
  user_id?: string;
  name?: string | null;
  email: string;
  status?: string;
};

export function pipelineStatusLabel(status: string): string {
  return canonicalStatusLabels[status as CanonicalPipelineStatus]
    ?? status.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

export function buildPipelineFilterQuery(filters: PipelineFilters): string {
  return new URLSearchParams(
    PIPELINE_FILTER_KEYS.flatMap((key) => filters[key] ? [[key, filters[key]]] : [])
  ).toString();
}

export function pipelineFiltersForSavedView(filters: PipelineFilters): Record<string, string> {
  return Object.fromEntries(PIPELINE_FILTER_KEYS.flatMap((key) => filters[key] ? [[key, filters[key]]] : []));
}

export function applyPipelineSavedView(saved: Record<string, unknown>): PipelineFilters {
  const next = { ...EMPTY_PIPELINE_FILTERS };
  for (const key of PIPELINE_FILTER_KEYS) {
    if (typeof saved[key] === "string") next[key] = saved[key];
  }
  return next;
}

const AI_FOLLOW_UP_STAGE_PREFIX = "operational:ai-follow-up:";
const CALL_STAGE_PREFIX = "operational:call:";

export function isOperationalPipelineStageId(stageId: string): boolean {
  return stageId.startsWith(AI_FOLLOW_UP_STAGE_PREFIX) || stageId.startsWith(CALL_STAGE_PREFIX);
}

/**
 * Follow-up attempts are an operational projection of the existing pipeline.
 * They deliberately do not become persisted stages: the configured delays and
 * ai_follow_up_schedules remain the single source of truth for sequence progress.
 */
export function buildOperationalPipelineStages(
  stages: PipelineStage[],
  config?: PipelineFollowUpConfig | null
): PipelineStage[] {
  const activeStages = stages.filter((stage) => !stage.archived_at).sort((left, right) => left.position - right.position);
  const followUpStages = activeStages.filter((stage) => stage.technical_status === "follow_up");
  const source = followUpStages.find((stage) => stage.is_default) ?? followUpStages[0];
  const maxCount = Math.min(10, Math.max(0, Math.trunc(config?.max_count ?? 0)));
  if (!config?.enabled || !source || maxCount === 0) return activeStages;

  const operational: PipelineStage[] = Array.from({ length: maxCount }, (_, index) => ({
    id: `${AI_FOLLOW_UP_STAGE_PREFIX}${source.id}:${index + 1}`,
    name: `Follow-up ${index + 1}`,
    color: source.color,
    position: source.position + index / 100,
    capacity_target: null,
    technical_status: "follow_up",
    is_default: false,
    operational_kind: "ai_follow_up",
    operational_source_stage_id: source.id,
    follow_up_attempt: index + 1
  }));
  operational.push({
    id: `${CALL_STAGE_PREFIX}${source.id}`,
    name: "Ligação",
    color: "var(--danger)",
    position: source.position + maxCount / 100,
    capacity_target: null,
    technical_status: "follow_up",
    is_default: false,
    operational_kind: "call",
    operational_source_stage_id: source.id
  });

  const firstFollowUpIndex = activeStages.findIndex((stage) => stage.technical_status === "follow_up");
  return [
    ...activeStages.slice(0, firstFollowUpIndex),
    ...operational,
    ...activeStages.slice(firstFollowUpIndex).filter((stage) => stage.technical_status !== "follow_up")
  ];
}

export const PIPELINE_OPTIONAL_FIELDS = ["origin", "ownership", "qualification", "nextMeeting", "nextAction", "stalled"] as const;
export type PipelineOptionalField = (typeof PIPELINE_OPTIONAL_FIELDS)[number];
export const PIPELINE_AUXILIARY_BADGES = ["resultPending", "recovery", "overdueFollowUp"] as const;
export type PipelineAuxiliaryBadge = (typeof PIPELINE_AUXILIARY_BADGES)[number];
export type PipelinePreferences = {
  density: "compact" | "comfortable";
  visibleFields: PipelineOptionalField[];
  auxiliaryBadges: PipelineAuxiliaryBadge[];
  columnWidth: 240 | 280 | 320;
};

export const DEFAULT_PIPELINE_PREFERENCES: PipelinePreferences = {
  density: "compact",
  visibleFields: ["ownership", "nextAction"],
  auxiliaryBadges: [],
  columnWidth: 280
};

export function pipelinePreferenceStorageKey(tenantId: string, userId: string): string {
  return `atendon.pipeline.preferences.v3:${tenantId}:${userId}`;
}

export function normalizePipelinePreferences(value: unknown): PipelinePreferences {
  if (!value || typeof value !== "object") return { ...DEFAULT_PIPELINE_PREFERENCES };
  const candidate = value as Partial<PipelinePreferences>;
  const visibleFields = Array.isArray(candidate.visibleFields)
    ? candidate.visibleFields.filter((field): field is PipelineOptionalField => PIPELINE_OPTIONAL_FIELDS.includes(field as PipelineOptionalField))
    : DEFAULT_PIPELINE_PREFERENCES.visibleFields;
  const auxiliaryBadges = Array.isArray(candidate.auxiliaryBadges)
    ? candidate.auxiliaryBadges.filter((badge): badge is PipelineAuxiliaryBadge => PIPELINE_AUXILIARY_BADGES.includes(badge as PipelineAuxiliaryBadge))
    : DEFAULT_PIPELINE_PREFERENCES.auxiliaryBadges;
  return {
    density: candidate.density === "compact" || candidate.density === "comfortable"
      ? candidate.density
      : DEFAULT_PIPELINE_PREFERENCES.density,
    visibleFields,
    auxiliaryBadges,
    columnWidth: candidate.columnWidth === 240 || candidate.columnWidth === 320 ? candidate.columnWidth : 280
  };
}

export type PipelineCommercialInput =
  | { sale_value: number; sale_product?: string; sale_source?: string; sale_channel?: string; responsavel_member_id?: string }
  | { next_action: string; next_action_at: string }
  | { loss_reason: string; loss_reason_note?: string };

export type PipelineTransitionRequirement = "sale" | "next_action" | "loss" | null;

export function pipelineTransitionRequirement(technicalStatus: string): PipelineTransitionRequirement {
  if (technicalStatus === "fechado") return "sale";
  if (technicalStatus === "perdido") return "loss";
  if (["em_negociacao", "proposta_enviada", "follow_up"].includes(technicalStatus)) return "next_action";
  return null;
}

const DEFAULT_BOARD_STATUS_SET = new Set(["novo", "em_atendimento", "qualificado", "em_negociacao", "fechado", "perdido"]);
const LEGACY_BOARD_PROJECTION: Record<string, string> = {
  aguardando_resposta: "em_atendimento",
  agendado: "qualificado",
  proposta_enviada: "em_negociacao",
  follow_up: "em_negociacao"
};

/** Projects technical legacy stages into commercial columns without persistence changes. */
export function pipelineBoardStageId(lead: PipelineLead, stages: PipelineStage[], showAllStages: boolean): string | null {
  const persisted = currentPipelineStageId(lead, stages, false);
  if (showAllStages) return persisted;
  const status = LEGACY_BOARD_PROJECTION[lead.status] ?? lead.status;
  if (!DEFAULT_BOARD_STATUS_SET.has(status)) return persisted;
  return stages.find((stage) => !stage.operational_kind && stage.technical_status === status)?.id ?? `fallback:${status}`;
}

export function buildPipelineTransitionPayload(input: {
  stage: PipelineStage;
  expectedUpdatedAt: string;
  commercial?: PipelineCommercialInput;
}) {
  const commercialPayload = input.commercial;
  return {
    stage_id: input.stage.id,
    expected_updated_at: input.expectedUpdatedAt,
    ...(commercialPayload ? { commercial: commercialPayload } : {})
  };
}

export function currentPipelineStageId(lead: PipelineLead, stages: PipelineStage[], legacy: boolean): string | null {
  if (legacy) return `fallback:${lead.status}`;
  const followUpStages = stages.filter((stage) => stage.operational_kind === "ai_follow_up");
  const callStage = stages.find((stage) => stage.operational_kind === "call");
  if (followUpStages.length && callStage) {
    const progress = lead.ai_follow_up;
    const exhausted = progress && (
      progress.status === "failed"
      || (progress.status === "completed" && (
        progress.count >= followUpStages.length
        || progress.cancellation_reason === "maximum_reached"
      ))
    );
    if (exhausted) return callStage.id;
    if (progress && ["scheduled", "processing"].includes(progress.status)) {
      const attempt = Math.min(followUpStages.length, Math.max(1, progress.count + 1));
      return followUpStages.find((stage) => stage.follow_up_attempt === attempt)?.id ?? followUpStages[0]!.id;
    }
    const sourceIds = new Set(stages.flatMap((stage) => stage.operational_source_stage_id ? [stage.operational_source_stage_id] : []));
    if (lead.pipeline_stage_id && sourceIds.has(lead.pipeline_stage_id)) return callStage.id;
  }
  return lead.pipeline_stage_id
    ?? stages.find((candidate) => !candidate.operational_kind && candidate.is_default && candidate.technical_status === lead.status)?.id
    ?? null;
}

export function isOverdueFollowUp(lead: PipelineLead, now = new Date()): boolean {
  return Boolean(lead.proxima_acao_em && new Date(lead.proxima_acao_em).getTime() < now.getTime());
}

export function formatPipelineAge(value: string, now = new Date()): string {
  const elapsed = Math.max(0, now.getTime() - new Date(value).getTime());
  const hours = Math.floor(elapsed / 3_600_000);
  if (hours < 1) return "há menos de 1h";
  if (hours < 24) return `há ${hours}h`;
  const days = Math.floor(hours / 24);
  return `há ${days}d`;
}
