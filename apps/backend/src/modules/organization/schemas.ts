import { z } from "zod";
import { LEAD_TECHNICAL_STATUSES } from "./domain.js";
import { commercialTransitionPayloadSchema } from "../commercial-journey/schemas.js";

export const organizationUuid = z.string().uuid();
export const organizationIdParams = z.object({ id: organizationUuid }).strict();
export const leadTagParams = z.object({ leadId: organizationUuid, tagId: organizationUuid }).strict();
export const stageParams = z.object({ stageId: organizationUuid }).strict();
export const bulkOperationParams = z.object({ operationId: organizationUuid }).strict();
export const leadStageParams = z.object({ leadId: organizationUuid }).strict();

const color = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const operationalPipelineStageId = z.string().regex(
  /^operational:(?:ai-follow-up:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:(?:[1-9]|10)|call:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
);
const optionalNullableCapacity = z.number().int().positive().max(1_000_000).nullable().optional();
export const technicalStatusSchema = z.enum(LEAD_TECHNICAL_STATUSES);

export const tagCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  color
}).strict();

export const tagUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  color: color.optional(),
  archived: z.boolean().optional()
}).strict().refine((value) => Object.keys(value).length > 0, "Informe ao menos um campo");

export const lossReasonCreateSchema = z.object({
  chave: z.string().trim().regex(/^[a-z0-9_]{2,40}$/, "Use apenas letras minúsculas, números e underscore"),
  rotulo: z.string().trim().min(1).max(120),
  posicao: z.number().int().min(0).max(9999).optional(),
  exige_observacao: z.boolean().optional()
}).strict();

export const storageSettingsSchema = z.object({
  // Quota em bytes; NULL = sem limite próprio (plano). 0 bloqueia qualquer
  // upload novo de asset.
  storage_quota_bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  // Retenção em dias; NULL = sem autoexclusão. Job diário no worker.
  retention_days: z.number().int().min(1).max(36500).nullable().optional(),
  retention: z.object({ enabled: z.boolean(), months: z.number().int().min(1).max(1200).nullable() }).strict().optional()
}).strict().refine((value) => Object.keys(value).length > 0, "Informe ao menos um campo");

export const lossReasonUpdateSchema = z.object({
  rotulo: z.string().trim().min(1).max(120).optional(),
  posicao: z.number().int().min(0).max(9999).optional(),
  exige_observacao: z.boolean().optional(),
  arquivado: z.boolean().optional()
}).strict().refine((value) => Object.keys(value).length > 0, "Informe ao menos um campo");

export const savedViewResourceSchema = z.enum(["conversations", "leads", "pipeline"]);

const conversationFiltersSchema = z.object({
  filter: z.enum(["human", "ai", "mine", "unassigned", "scheduled", "resolved", "open"]).optional(),
  q: z.string().trim().max(200).optional(),
  assigned_user_id: organizationUuid.optional(),
  tag_ids: z.array(organizationUuid).max(20).optional(),
  pipeline_stage_ids: z.array(organizationUuid).max(20).optional()
}).strict();

const leadFiltersSchema = z.object({
  status: technicalStatusSchema.optional(),
  busca: z.string().trim().max(200).optional(),
  unidade_id: z.string().trim().max(100).optional(),
  categoria_id: z.string().trim().max(100).optional(),
  parceiro_id: z.string().trim().max(100).optional(),
  estrelas: z.number().int().min(1).max(5).optional(),
  assigned_member_id: organizationUuid.optional(),
  tag_ids: z.array(organizationUuid).max(20).optional(),
  pipeline_stage_ids: z.array(organizationUuid).max(20).optional()
}).strict();

const pipelineFiltersSchema = z.object({
  busca: z.string().trim().max(200).optional(),
  pipeline_stage_id: z.union([
    organizationUuid,
    operationalPipelineStageId
  ]).optional(),
  sdr_member_id: organizationUuid.optional(),
  closer_member_id: organizationUuid.optional(),
  origem: z.string().trim().max(200).optional(),
  campanha: z.string().trim().max(200).optional(),
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  appointment_status: z.enum(["confirmado","reagendado","concluido","no_show","cancelado"]).optional(),
  commercial_outcome: z.enum(["fechado","proposta_enviada","em_negociacao","follow_up","nao_avancou"]).optional(),
  action_bucket: z.enum(["result_pending","recovery","overdue_follow_up","today"]).optional()
}).strict();

export function parseSavedViewFilters(resource: z.infer<typeof savedViewResourceSchema>, filters: unknown) {
  if (resource === "conversations") return conversationFiltersSchema.parse(filters);
  if (resource === "leads") return leadFiltersSchema.parse(filters);
  return pipelineFiltersSchema.parse(filters);
}

export const savedViewCreateSchema = z.object({
  resource: savedViewResourceSchema,
  name: z.string().trim().min(1).max(100),
  filters: z.unknown(),
  shared: z.boolean().default(false)
}).strict();

export const savedViewUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  filters: z.unknown().optional(),
  shared: z.boolean().optional()
}).strict().refine((value) => Object.keys(value).length > 0, "Informe ao menos um campo");

export const savedViewListQuerySchema = z.object({
  resource: savedViewResourceSchema.optional()
}).strict();

export const stageCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  color,
  position: z.number().int().min(0).max(1_000_000),
  capacity_target: optionalNullableCapacity,
  technical_status: technicalStatusSchema,
  is_default: z.boolean().default(false)
}).strict();

export const stageUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  color: color.optional(),
  position: z.number().int().min(0).max(1_000_000).optional(),
  capacity_target: optionalNullableCapacity,
  technical_status: technicalStatusSchema.optional(),
  is_default: z.boolean().optional()
}).strict().refine((value) => Object.keys(value).length > 0, "Informe ao menos um campo");

export const archiveStageSchema = z.object({
  replacement_stage_id: organizationUuid.optional()
}).strict();

export const stageTransitionsSchema = z.object({
  to_stage_ids: z.array(organizationUuid).max(100)
}).strict().superRefine((value, context) => {
  if (new Set(value.to_stage_ids).size !== value.to_stage_ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Etapas de destino duplicadas" });
  }
});

export const moveLeadStageSchema = z.object({
  stage_id: organizationUuid,
  expected_updated_at: z.string().datetime({ offset: true }).optional(),
  commercial: commercialTransitionPayloadSchema.optional()
}).strict();

export const pipelineSettingsSchema = z.object({
  enforce_transitions: z.boolean()
}).strict();

const bulkItems = z.array(z.object({
  id: organizationUuid,
  expected_updated_at: z.string().datetime({ offset: true }).optional()
}).strict()).min(1).max(200).superRefine((items, context) => {
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Registros duplicados" });
  }
});

const bulkAssign = z.object({
  action: z.literal("assign"),
  items: bulkItems,
  assigned_member_id: organizationUuid.nullable()
}).strict();
const bulkTagsAdd = z.object({
  action: z.literal("tags_add"),
  items: bulkItems,
  tag_ids: z.array(organizationUuid).min(1).max(20)
}).strict();
const bulkTagsRemove = z.object({
  action: z.literal("tags_remove"),
  items: bulkItems,
  tag_ids: z.array(organizationUuid).min(1).max(20)
}).strict();
const bulkMoveStage = z.object({
  action: z.literal("move_stage"),
  items: bulkItems,
  stage_id: organizationUuid
}).strict();

export const bulkPreviewSchema = z.discriminatedUnion("action", [
  bulkAssign,
  bulkTagsAdd,
  bulkTagsRemove,
  bulkMoveStage
]);

const idempotency = { idempotency_key: z.string().trim().min(1).max(200) };
export const bulkApplySchema = z.discriminatedUnion("action", [
  bulkAssign.extend(idempotency),
  bulkTagsAdd.extend(idempotency),
  bulkTagsRemove.extend(idempotency),
  bulkMoveStage.extend(idempotency)
]);

export type BulkPreviewInput = z.infer<typeof bulkPreviewSchema>;
export type BulkApplyInput = z.infer<typeof bulkApplySchema>;
export type StageCreateInput = z.infer<typeof stageCreateSchema>;
export type StageUpdateInput = z.infer<typeof stageUpdateSchema>;
