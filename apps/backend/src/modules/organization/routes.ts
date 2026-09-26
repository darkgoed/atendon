import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PermissionKey } from "../../auth/rbac.js";
import { resolveCaseScope } from "../../auth/case-scope.js";
import { requirePermission, requireWorkspace, type WorkspaceSession } from "../../auth/session.js";
import { db } from "../../db/client.js";
import { isFeatureFlagEnabled } from "../operations/feature-flags.js";
import { httpError } from "../scheduling/service.js";
import {
  archiveStageSchema,
  bulkApplySchema,
  bulkOperationParams,
  bulkPreviewSchema,
  leadStageParams,
  leadTagParams,
  lossReasonCreateSchema,
  lossReasonUpdateSchema,
  moveLeadStageSchema,
  organizationIdParams,
  parseSavedViewFilters,
  pipelineArchiveSchema,
  pipelineChannelsSchema,
  pipelineCreateSchema,
  pipelineDuplicateSchema,
  pipelineGroupCreateSchema,
  pipelineGroupOrderSchema,
  pipelineGroupParams,
  pipelineGroupUpdateSchema,
  pipelineIdParams,
  pipelineListQuerySchema,
  pipelineOrderSchema,
  pipelineSettingsSchema,
  pipelineUpdateSchema,
  savedViewCreateSchema,
  savedViewListQuerySchema,
  savedViewUpdateSchema,
  stageCreateSchema,
  stageDuplicateParams,
  stageOrderSchema,
  stageParams,
  stageTransitionsSchema,
  stageUpdateSchema,
  storageSettingsSchema,
  tagCreateSchema,
  tagUpdateSchema
} from "./schemas.js";
import { getOrganizationStorage, updateStorageSettings } from "./storage.js";
import {
  createLossReason,
  listLossReasons,
  lossReasonMapper,
  updateLossReason
} from "../commercial-journey/loss-reasons.js";
import {
  applyBulkOperation,
  archivePipeline,
  archivePipelineGroup,
  archivePipelineStage,
  createPipeline,
  createPipelineGroup,
  createPipelineStage,
  createSavedView,
  createTag,
  deleteSavedView,
  duplicatePipeline,
  duplicatePipelineStage,
  listPipelines,
  listSavedViews,
  listTags,
  loadPipeline,
  moveLeadStage,
  previewBulkOperation,
  reorderPipelines,
  reorderPipelineGroups,
  reorderPipelineStages,
  replaceStageTransitions,
  setLeadTag,
  setPipelineChannels,
  undoBulkOperation,
  updatePipeline,
  updatePipelineGroup,
  updatePipelineSettings,
  updatePipelineStage,
  updateSavedView,
  updateTag,
  type OrganizationActor,
  type OrganizationCaseAccess
} from "./service.js";

const includeArchivedQuery = z.object({ include_archived: z.enum(["true"]).optional() }).strict();

function sessionHasPermission(session: WorkspaceSession, permission: PermissionKey) {
  return Boolean(session.isRoot && session.rootWorkspaceAccess) || session.permissions.includes(permission);
}

function assertSessionPermission(session: WorkspaceSession, permission: PermissionKey) {
  if (!sessionHasPermission(session,permission)) throw httpError(403,"Permissão insuficiente");
}

async function requireOrganization(request: FastifyRequest) {
  const session = await requireWorkspace(request);
  if (!await isFeatureFlagEnabled(db,session.tenantId,"case_organization_v1")) {
    throw httpError(409,"Organização de casos temporariamente desabilitada");
  }
  return session;
}

function actor(request: FastifyRequest, session: WorkspaceSession): OrganizationActor {
  return {
    userId: session.userId,
    actorScope: session.actorScope,
    ipAddress: request.ip,
    userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined
  };
}

async function caseAccess(session: WorkspaceSession): Promise<OrganizationCaseAccess> {
  const scope = await resolveCaseScope(db,session);
  return { workspaceWide: scope.type === "workspace", memberId: scope.memberId };
}

function allowedViewResources(session: WorkspaceSession) {
  const resources: Array<"conversations" | "leads" | "pipeline"> = [];
  if (sessionHasPermission(session,"conversations.read")) resources.push("conversations");
  if (sessionHasPermission(session,"leads.read")) resources.push("leads","pipeline");
  return resources;
}

function assertViewResource(session: WorkspaceSession, resource: "conversations" | "leads" | "pipeline") {
  if (!allowedViewResources(session).includes(resource)) throw httpError(403,"Sem permissão para esse tipo de visão");
}

function assertSavedViewFilterPermissions(
  session: WorkspaceSession,
  resource: "conversations" | "leads" | "pipeline",
  filters: unknown
) {
  const parsed = parseSavedViewFilters(resource,filters);
  if (("assigned_user_id" in parsed || "assigned_member_id" in parsed || "sdr_member_id" in parsed || "closer_member_id" in parsed) && !sessionHasPermission(session,"leads.transfer")) {
    throw httpError(403,"Sem permissão para filtrar por responsável");
  }
  if ("tag_ids" in parsed && !sessionHasPermission(session,"tags.apply")) {
    throw httpError(403,"Sem permissão para filtrar por etiquetas");
  }
  return parsed;
}

function assertBulkPermission(session: WorkspaceSession, action: "assign" | "tags_add" | "tags_remove" | "move_stage") {
  if (action === "assign") assertSessionPermission(session,"leads.transfer");
  else if (action === "move_stage") assertSessionPermission(session,"leads.update_status");
  else assertSessionPermission(session,"tags.apply");
}

export async function registerOrganizationRoutes(app: FastifyInstance) {
  app.get("/organization/tags", async (request) => {
    const session = await requireOrganization(request);
    assertSessionPermission(session,"tags.apply");
    const { include_archived } = includeArchivedQuery.parse(request.query);
    if (include_archived) assertSessionPermission(session,"tags.manage");
    return { tags: await listTags(session.tenantId,Boolean(include_archived)) };
  });

  app.post("/organization/tags", async (request, reply) => {
    const session = await requirePermission(request,"tags.manage");
    if (!await isFeatureFlagEnabled(db,session.tenantId,"case_organization_v1")) throw httpError(409,"Organização de casos temporariamente desabilitada");
    const tag = await createTag(session.tenantId,actor(request,session),tagCreateSchema.parse(request.body));
    return reply.status(201).send({ tag });
  });

  app.patch("/organization/tags/:id", async (request) => {
    const session = await requirePermission(request,"tags.manage");
    if (!await isFeatureFlagEnabled(db,session.tenantId,"case_organization_v1")) throw httpError(409,"Organização de casos temporariamente desabilitada");
    const { id } = organizationIdParams.parse(request.params);
    return { tag: await updateTag(session.tenantId,id,actor(request,session),tagUpdateSchema.parse(request.body)) };
  });

  app.put("/organization/leads/:leadId/tags/:tagId", async (request) => {
    const session = await requirePermission(request,"tags.apply");
    if (!await isFeatureFlagEnabled(db,session.tenantId,"case_organization_v1")) throw httpError(409,"Organização de casos temporariamente desabilitada");
    const { leadId,tagId } = leadTagParams.parse(request.params);
    return { assignment: await setLeadTag(session.tenantId,leadId,tagId,true,await caseAccess(session),actor(request,session)) };
  });

  app.delete("/organization/leads/:leadId/tags/:tagId", async (request) => {
    const session = await requirePermission(request,"tags.apply");
    if (!await isFeatureFlagEnabled(db,session.tenantId,"case_organization_v1")) throw httpError(409,"Organização de casos temporariamente desabilitada");
    const { leadId,tagId } = leadTagParams.parse(request.params);
    return { assignment: await setLeadTag(session.tenantId,leadId,tagId,false,await caseAccess(session),actor(request,session)) };
  });

  // Motivos de perda pertencem à jornada comercial, não à organização de
  // casos: o diálogo de pipeline e os formulários da agenda que consomem este
  // catálogo não estão atrás de `case_organization_v1`. Usar
  // `requireOrganization` aqui deixaria o select vazio (409) e impediria
  // qualquer desqualificação nos workspaces com a flag desligada.
  app.get("/organization/loss-reasons", async (request) => {
    const session = await requireWorkspace(request);
    const { include_archived } = includeArchivedQuery.parse(request.query);
    if (include_archived) assertSessionPermission(session,"loss_reasons.manage");
    const reasons = await listLossReasons(session.tenantId,Boolean(include_archived));
    return { motivos: reasons.map(lossReasonMapper) };
  });

  app.post("/organization/loss-reasons", async (request, reply) => {
    const session = await requirePermission(request,"loss_reasons.manage");
    const body = lossReasonCreateSchema.parse(request.body);
    const created = await createLossReason(session.tenantId,body);
    return reply.status(201).send({ motivo: lossReasonMapper(created) });
  });

  app.patch("/organization/loss-reasons/:id", async (request) => {
    const session = await requirePermission(request,"loss_reasons.manage");
    const { id } = organizationIdParams.parse(request.params);
    const body = lossReasonUpdateSchema.parse(request.body);
    return { motivo: lossReasonMapper(await updateLossReason(session.tenantId,id,body)) };
  });

  app.get("/organization/saved-views", async (request) => {
    const session = await requireOrganization(request);
    const { resource } = savedViewListQuerySchema.parse(request.query);
    if (resource) assertViewResource(session,resource);
    const resources = allowedViewResources(session);
    return { saved_views: await listSavedViews(session.tenantId,session.userId,resources,resource) };
  });

  app.post("/organization/saved-views", async (request, reply) => {
    const session = await requireOrganization(request);
    const input = savedViewCreateSchema.parse(request.body);
    assertViewResource(session,input.resource);
    if (input.shared) assertSessionPermission(session,"saved_views.publish");
    const filters = assertSavedViewFilterPermissions(session,input.resource,input.filters);
    const savedView = await createSavedView(session.tenantId,actor(request,session),{ ...input,filters });
    return reply.status(201).send({ saved_view: savedView });
  });

  app.patch("/organization/saved-views/:id", async (request) => {
    const session = await requireOrganization(request);
    const { id } = organizationIdParams.parse(request.params);
    const canPublish = sessionHasPermission(session,"saved_views.publish");
    const input = savedViewUpdateSchema.parse(request.body);
    if (input.filters !== undefined) {
      const current = await db.query<{ resource: "conversations" | "leads" | "pipeline" }>(
        "SELECT resource FROM saved_views WHERE tenant_id=$1 AND id=$2",
        [session.tenantId,id]
      );
      if (!current.rows[0]) throw httpError(404,"Visão salva não encontrada");
      input.filters = assertSavedViewFilterPermissions(session,current.rows[0].resource,input.filters);
    }
    return { saved_view: await updateSavedView(session.tenantId,id,actor(request,session),canPublish,input) };
  });

  app.delete("/organization/saved-views/:id", async (request) => {
    const session = await requireOrganization(request);
    const { id } = organizationIdParams.parse(request.params);
    return { saved_view: await deleteSavedView(session.tenantId,id,actor(request,session),sessionHasPermission(session,"saved_views.publish")) };
  });

  // Item 9: escopo por pipeline (ausente = padrão; outro tenant/arquivado = 404).
  app.get("/organization/pipeline", async (request) => {
    const session = await requireOrganization(request);
    assertSessionPermission(session,"leads.read");
    const { pipeline_id,include_archived } = pipelineListQuerySchema.parse(request.query);
    if (include_archived) assertSessionPermission(session,"pipeline.manage");
    return loadPipeline(session.tenantId,{ pipelineId: pipeline_id,includeArchived: Boolean(include_archived) });
  });

  // Item 1: lista de pipelines ativos; canais só para quem gerencia pipeline.
  app.get("/organization/pipelines", async (request) => {
    const session = await requireOrganization(request);
    assertSessionPermission(session,"leads.read");
    const canManage = sessionHasPermission(session,"pipeline.manage");
    return listPipelines(session.tenantId,canManage);
  });

  // Item 2
  app.post("/organization/pipelines", async (request, reply) => {
    const session = await requirePermission(request,"pipeline.manage");
    if (!await isFeatureFlagEnabled(db,session.tenantId,"case_organization_v1")) throw httpError(409,"Organização de casos temporariamente desabilitada");
    const created = await createPipeline(session.tenantId,actor(request,session),pipelineCreateSchema.parse(request.body));
    return reply.status(201).send(created);
  });

  // Item 3
  app.patch("/organization/pipelines/:pipelineId", async (request) => {
    const session = await requirePermission(request,"pipeline.manage");
    if (!await isFeatureFlagEnabled(db,session.tenantId,"case_organization_v1")) throw httpError(409,"Organização de casos temporariamente desabilitada");
    const { pipelineId } = pipelineIdParams.parse(request.params);
    return updatePipeline(session.tenantId,pipelineId,actor(request,session),pipelineUpdateSchema.parse(request.body));
  });

  // Item 4
  app.post("/organization/pipelines/:pipelineId/duplicate", async (request, reply) => {
    const session = await requirePermission(request,"pipeline.manage");
    if (!await isFeatureFlagEnabled(db,session.tenantId,"case_organization_v1")) throw httpError(409,"Organização de casos temporariamente desabilitada");
    const { pipelineId } = pipelineIdParams.parse(request.params);
    const created = await duplicatePipeline(session.tenantId,pipelineId,actor(request,session),pipelineDuplicateSchema.parse(request.body ?? {}));
    return reply.status(201).send(created);
  });

  // Item 5
  app.post("/organization/pipelines/:pipelineId/archive", async (request) => {
    const session = await requirePermission(request,"pipeline.manage");
    if (!await isFeatureFlagEnabled(db,session.tenantId,"case_organization_v1")) throw httpError(409,"Organização de casos temporariamente desabilitada");
    const { pipelineId } = pipelineIdParams.parse(request.params);
    const { replacement_pipeline_id } = pipelineArchiveSchema.parse(request.body ?? {});
    return archivePipeline(session.tenantId,pipelineId,replacement_pipeline_id,actor(request,session));
  });

  // Item 6
  app.put("/organization/pipelines/order", async (request) => {
    const session = await requirePermission(request,"pipeline.manage");
    if (!await isFeatureFlagEnabled(db,session.tenantId,"case_organization_v1")) throw httpError(409,"Organização de casos temporariamente desabilitada");
    const { pipeline_ids } = pipelineOrderSchema.parse(request.body);
    return reorderPipelines(session.tenantId,actor(request,session),pipeline_ids);
  });

  // 0185: grupos opcionais de pipelines (mesma flag e permissão dos pipelines).
  app.post("/organization/pipeline-groups", async (request, reply) => {
    const session = await requirePermission(request,"pipeline.manage");
    if (!await isFeatureFlagEnabled(db,session.tenantId,"case_organization_v1")) throw httpError(409,"Organização de casos temporariamente desabilitada");
    const created = await createPipelineGroup(session.tenantId,actor(request,session),pipelineGroupCreateSchema.parse(request.body));
    return reply.status(201).send(created);
  });

  app.patch("/organization/pipeline-groups/:groupId", async (request) => {
    const session = await requirePermission(request,"pipeline.manage");
    if (!await isFeatureFlagEnabled(db,session.tenantId,"case_organization_v1")) throw httpError(409,"Organização de casos temporariamente desabilitada");
    const { groupId } = pipelineGroupParams.parse(request.params);
    return updatePipelineGroup(session.tenantId,groupId,actor(request,session),pipelineGroupUpdateSchema.parse(request.body));
  });

  app.post("/organization/pipeline-groups/:groupId/archive", async (request) => {
    const session = await requirePermission(request,"pipeline.manage");
    if (!await isFeatureFlagEnabled(db,session.tenantId,"case_organization_v1")) throw httpError(409,"Organização de casos temporariamente desabilitada");
    const { groupId } = pipelineGroupParams.parse(request.params);
    return archivePipelineGroup(session.tenantId,groupId,actor(request,session));
  });

  app.put("/organization/pipeline-groups/order", async (request) => {
    const session = await requirePermission(request,"pipeline.manage");
    if (!await isFeatureFlagEnabled(db,session.tenantId,"case_organization_v1")) throw httpError(409,"Organização de casos temporariamente desabilitada");
    const { group_ids } = pipelineGroupOrderSchema.parse(request.body);
    return reorderPipelineGroups(session.tenantId,actor(request,session),group_ids);
  });

  // Item 7
  app.put("/organization/pipelines/:pipelineId/channels", async (request) => {
    const session = await requirePermission(request,"pipeline.manage");
    if (!await isFeatureFlagEnabled(db,session.tenantId,"case_organization_v1")) throw httpError(409,"Organização de casos temporariamente desabilitada");
    const { pipelineId } = pipelineIdParams.parse(request.params);
    const { session_ids } = pipelineChannelsSchema.parse(request.body);
    return setPipelineChannels(session.tenantId,pipelineId,actor(request,session),session_ids);
  });

  // Item 8
  app.put("/organization/pipelines/:pipelineId/stages/order", async (request) => {
    const session = await requirePermission(request,"pipeline.manage");
    if (!await isFeatureFlagEnabled(db,session.tenantId,"case_organization_v1")) throw httpError(409,"Organização de casos temporariamente desabilitada");
    const { pipelineId } = pipelineIdParams.parse(request.params);
    const { stage_ids } = stageOrderSchema.parse(request.body);
    return reorderPipelineStages(session.tenantId,pipelineId,actor(request,session),stage_ids);
  });

  app.post("/organization/pipeline/stages", async (request, reply) => {
    const session = await requirePermission(request,"pipeline.manage");
    if (!await isFeatureFlagEnabled(db,session.tenantId,"case_organization_v1")) throw httpError(409,"Organização de casos temporariamente desabilitada");
    const stage = await createPipelineStage(session.tenantId,actor(request,session),stageCreateSchema.parse(request.body));
    return reply.status(201).send({ stage });
  });

  app.patch("/organization/pipeline/stages/:stageId", async (request) => {
    const session = await requirePermission(request,"pipeline.manage");
    if (!await isFeatureFlagEnabled(db,session.tenantId,"case_organization_v1")) throw httpError(409,"Organização de casos temporariamente desabilitada");
    const { stageId } = stageParams.parse(request.params);
    return { stage: await updatePipelineStage(session.tenantId,stageId,actor(request,session),stageUpdateSchema.parse(request.body)) };
  });

  // Item 12: duplica etapa (logo após a original, ids novos, sem leads).
  app.post("/organization/pipeline/stages/:stageId/duplicate", async (request, reply) => {
    const session = await requirePermission(request,"pipeline.manage");
    if (!await isFeatureFlagEnabled(db,session.tenantId,"case_organization_v1")) throw httpError(409,"Organização de casos temporariamente desabilitada");
    const { stageId } = stageDuplicateParams.parse(request.params);
    const stage = await duplicatePipelineStage(session.tenantId,stageId,actor(request,session));
    return reply.status(201).send({ stage });
  });

  app.post("/organization/pipeline/stages/:stageId/archive", async (request) => {
    const session = await requirePermission(request,"pipeline.manage");
    if (!await isFeatureFlagEnabled(db,session.tenantId,"case_organization_v1")) throw httpError(409,"Organização de casos temporariamente desabilitada");
    const { stageId } = stageParams.parse(request.params);
    const { replacement_stage_id } = archiveStageSchema.parse(request.body ?? {});
    return { stage: await archivePipelineStage(session.tenantId,stageId,replacement_stage_id,actor(request,session)) };
  });

  app.put("/organization/pipeline/stages/:stageId/transitions", async (request) => {
    const session = await requirePermission(request,"pipeline.manage");
    if (!await isFeatureFlagEnabled(db,session.tenantId,"case_organization_v1")) throw httpError(409,"Organização de casos temporariamente desabilitada");
    const { stageId } = stageParams.parse(request.params);
    const { to_stage_ids } = stageTransitionsSchema.parse(request.body);
    return { transitions: await replaceStageTransitions(session.tenantId,stageId,to_stage_ids,actor(request,session)) };
  });

  // Item 15: enforce_transitions do pipeline (padrão se pipeline_id ausente).
  app.patch("/organization/pipeline/settings", async (request) => {
    const session = await requirePermission(request,"pipeline.manage");
    if (!await isFeatureFlagEnabled(db,session.tenantId,"case_organization_v1")) throw httpError(409,"Organização de casos temporariamente desabilitada");
    const { enforce_transitions } = await updatePipelineSettings(session.tenantId,actor(request,session),pipelineSettingsSchema.parse(request.body));
    return { enforce_transitions };
  });

  app.patch("/organization/leads/:leadId/stage", async (request) => {
    const session = await requirePermission(request,"leads.update_status");
    if (!await isFeatureFlagEnabled(db,session.tenantId,"case_organization_v1")) throw httpError(409,"Organização de casos temporariamente desabilitada");
    const { leadId } = leadStageParams.parse(request.params);
    const input = moveLeadStageSchema.parse(request.body);
    return { lead: await moveLeadStage(session.tenantId,leadId,input.stage_id,input.expected_updated_at,await caseAccess(session),actor(request,session),input.commercial) };
  });

  app.post("/organization/bulk/preview", async (request) => {
    const session = await requireOrganization(request);
    const input = bulkPreviewSchema.parse(request.body);
    assertBulkPermission(session,input.action);
    return previewBulkOperation(session.tenantId,await caseAccess(session),input);
  });

  app.post("/organization/bulk/apply", async (request) => {
    const session = await requireOrganization(request);
    const input = bulkApplySchema.parse(request.body);
    assertBulkPermission(session,input.action);
    return applyBulkOperation(session.tenantId,await caseAccess(session),actor(request,session),input);
  });

  app.post("/organization/bulk/:operationId/undo", async (request) => {
    const session = await requireOrganization(request);
    const { operationId } = bulkOperationParams.parse(request.params);
    const operation = await db.query<{ action: "assign" | "tags_add" | "tags_remove" | "move_stage" }>(
      `SELECT action FROM bulk_operations
       WHERE tenant_id=$1 AND id=$2 AND actor_user_id=$3`,
      [session.tenantId,operationId,session.userId]
    );
    if (operation.rows[0]) assertBulkPermission(session,operation.rows[0].action);
    return undoBulkOperation(session.tenantId,operationId,actor(request,session));
  });

  // R4 — Armazenamento da empresa. storage.manage é de gestores
  // (espelho de pipeline.manage: OWNER/ADMIN/SUPERVISOR), então GET e PATCH
  // usam a mesma chave; leitura de uso e configuração de quota/retenção não
  // dependem de case_organization_v1 (configuração de workspace, não de
  // organização de casos).
  app.get("/organization/storage", async (request) => {
    const session = await requirePermission(request,"storage.manage");
    return { storage: await getOrganizationStorage(session.tenantId) };
  });

  app.patch("/organization/storage/settings", async (request) => {
    const session = await requirePermission(request,"storage.manage");
    const input = storageSettingsSchema.parse(request.body);
    const storage = await updateStorageSettings(session.tenantId,input,actor(request,session));
    return { storage };
  });
}
