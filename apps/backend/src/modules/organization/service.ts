import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { db } from "../../db/client.js";
import { httpError, withTransaction } from "../scheduling/service.js";
import { refreshAppointmentGroupNotificationsForLead } from "../scheduling/notification-repository.js";
import {
  DEFAULT_BOARD_STATUSES,
  configuredStageTransitionIsUndoable,
  domainAllowsStageTransition,
  type LeadTechnicalStatus
} from "./domain.js";
import { parseSavedViewFilters, type BulkApplyInput, type BulkPreviewInput, type StageCreateInput, type StageUpdateInput } from "./schemas.js";
import { stageRequiresCommercialPayload } from "../commercial-journey/domain.js";
import { applyStructuredStageEffects } from "../commercial-journey/service.js";
import type { CommercialTransitionPayload } from "../commercial-journey/schemas.js";

export type OrganizationActor = {
  userId: string;
  actorScope: "root" | "workspace";
  ipAddress?: string;
  userAgent?: string;
};

export type OrganizationCaseAccess = {
  workspaceWide: boolean;
  memberId: string | null;
};

type LeadRow = {
  id: string;
  status: LeadTechnicalStatus;
  pipeline_stage_id: string;
  pipeline_id?: string | null;
  assigned_member_id: string | null;
  updated_at: string | Date;
};

type StageRow = {
  id: string;
  tenant_id: string;
  pipeline_id: string;
  name: string;
  color: string;
  position: number;
  capacity_target: number | null;
  technical_status: LeadTechnicalStatus;
  is_default: boolean;
  automation: Record<string, unknown> | null;
  archived_at: string | null;
};

type PipelineRow = {
  id: string;
  tenant_id: string;
  name: string;
  color: string;
  position: number;
  is_default: boolean;
  enforce_transitions: boolean;
  archived_at: string | null;
};

export type PipelineSummary = {
  id: string;
  name: string;
  color: string;
  position: number;
  is_default: boolean;
  enforce_transitions: boolean;
  archived_at: string | null;
  stage_count: number;
  lead_count: number;
  channel_ids: string[];
};

type BulkValidation = {
  valid: boolean;
  count: number;
  items: Array<{ id: string; status: LeadTechnicalStatus; pipeline_stage_id: string; assigned_member_id: string | null; updated_at: string }>;
  errors: Array<{ id: string; code: string; message: string }>;
  undoable: boolean;
  enforceTransitions: boolean;
  targetStage?: StageRow;
  targetMemberUserId?: string | null;
};

function serializedDate(value: string | Date) {
  return new Date(value).toISOString();
}

// Modo de movimentação vem do PIPELINE da etapa alvo (0184). Cross-pipeline
// ignora o grafo (a sequência só vale dentro de um pipeline).
async function pipelineEnforcesTransitions(client: PoolClient, tenantId: string, targetStageId: string) {
  const result = await client.query<{ enforce_transitions: boolean }>(
    `SELECT pipeline.enforce_transitions
     FROM pipeline_stages stage
     JOIN pipelines pipeline ON pipeline.id=stage.pipeline_id AND pipeline.tenant_id=stage.tenant_id
     WHERE stage.tenant_id=$1 AND stage.id=$2 AND stage.archived_at IS NULL AND pipeline.archived_at IS NULL`,
    [tenantId,targetStageId]
  );
  if (!result.rows[0]) throw httpError(404,"Tenant não encontrado");
  return result.rows[0].enforce_transitions;
}

async function defaultPipeline(client: PoolClient, tenantId: string, lock = false): Promise<PipelineRow> {
  const result = await client.query<PipelineRow>(
    `SELECT * FROM pipelines
     WHERE tenant_id=$1 AND archived_at IS NULL
     ORDER BY is_default DESC,position,created_at,id LIMIT 1
     ${lock ? "FOR UPDATE" : ""}`,
    [tenantId]
  );
  if (!result.rows[0]) throw httpError(404,"Pipeline não encontrado");
  return result.rows[0];
}

async function loadPipelineRow(client: PoolClient, tenantId: string, pipelineId: string, lock = false): Promise<PipelineRow> {
  const result = await client.query<PipelineRow>(
    `SELECT * FROM pipelines WHERE tenant_id=$1 AND id=$2 ${lock ? "FOR UPDATE" : ""}`,
    [tenantId,pipelineId]
  );
  if (!result.rows[0] || result.rows[0].archived_at) throw httpError(404,"Pipeline não encontrado");
  return result.rows[0];
}

async function assertPipelineActive(client: PoolClient, tenantId: string, pipelineId: string) {
  const result = await client.query<PipelineRow>(
    "SELECT * FROM pipelines WHERE tenant_id=$1 AND id=$2",
    [tenantId,pipelineId]
  );
  if (!result.rows[0] || result.rows[0].archived_at) throw httpError(404,"Pipeline não encontrado");
}

async function stageById(client: PoolClient, tenantId: string, stageId: string, lock = false): Promise<StageRow> {
  const result = await client.query<StageRow>(
    `SELECT * FROM pipeline_stages WHERE tenant_id=$1 AND id=$2 ${lock ? "FOR UPDATE" : ""}`,
    [tenantId,stageId]
  );
  if (!result.rows[0] || result.rows[0].archived_at) throw httpError(404,"Etapa não encontrada");
  return result.rows[0];
}

async function memberUserId(client: PoolClient, tenantId: string, memberId: string | null | undefined) {
  if (!memberId) return null;
  const result = await client.query<{ user_id: string }>(
    "SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND id=$2",
    [tenantId,memberId]
  );
  return result.rows[0]?.user_id ?? null;
}

// Validação de `automation` no POST/PATCH (item 17): ids de tag/membro ativos do tenant, 400 senão.
async function assertStageAutomation(
  client: PoolClient,
  tenantId: string,
  automation: { add_tag_ids?: string[]; assign_member_id?: string | null } | undefined
) {
  if (!automation) return;
  const tagIds = automation.add_tag_ids ?? [];
  if (tagIds.length > 0) {
    const tags = await client.query<{ id: string }>(
      "SELECT id FROM lead_tags WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND archived_at IS NULL",
      [tenantId,tagIds]
    );
    if (tags.rows.length !== new Set(tagIds).size) throw httpError(400,"Etiqueta da automação não encontrada");
  }
  if (automation.assign_member_id) {
    const member = await client.query(
      "SELECT id FROM workspace_members WHERE workspace_id=$1 AND id=$2 AND status='active'",
      [tenantId,automation.assign_member_id]
    );
    if (!member.rows[0]) throw httpError(400,"Responsável da automação deve ser um membro ativo do workspace");
  }
}

// Execução da automação quando o lead ENTRA na etapa (item 17).
async function applyStageAutomation(
  client: PoolClient,
  tenantId: string,
  leadId: string,
  automation: StageRow["automation"],
  actorUserId: string
) {
  const parsed = (automation ?? {}) as { add_tag_ids?: string[]; assign_member_id?: string | null };
  const tagIds = parsed.add_tag_ids ?? [];
  if (tagIds.length > 0) {
    await client.query(
      `INSERT INTO lead_tag_assignments(tenant_id,lead_id,tag_id,created_by_user_id)
       SELECT $1,$2,tag.id,$4
       FROM unnest($3::uuid[]) AS requested(tag_id)
       JOIN lead_tags tag ON tag.tenant_id=$1 AND tag.id=requested.tag_id AND tag.archived_at IS NULL
       ON CONFLICT DO NOTHING`,
      [tenantId,leadId,tagIds,actorUserId]
    );
  }
  if (parsed.assign_member_id) {
    const member = await client.query<{ id: string; user_id: string }>(
      "SELECT id,user_id FROM workspace_members WHERE workspace_id=$1 AND id=$2 AND status='active'",
      [tenantId,parsed.assign_member_id]
    );
    if (member.rows[0]) {
      await client.query(
        "UPDATE scheduling_leads SET assigned_member_id=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",
        [tenantId,leadId,member.rows[0].id]
      );
      await client.query(
        "UPDATE conversations SET assigned_user_id=$3 WHERE tenant_id=$1 AND lead_id=$2",
        [tenantId,leadId,member.rows[0].user_id]
      );
    }
  }
}

// Sinal realtime (item 18): mesmo schema estrito de case.assignment.changed.
function notifyLeadMoved(
  client: PoolClient,
  tenantId: string,
  leadId: string,
  previousUserId: string | null,
  assignedUserId: string | null
) {
  return client.query("SELECT pg_notify('atendon_realtime_changes',$1)",[
    JSON.stringify({
      v: 1,
      type: "case.assignment.changed",
      tenantId,
      caseId: leadId,
      leadId,
      entityId: randomUUID(),
      previousUserId,
      assignedUserId
    })
  ]);
}

function databaseError(error: unknown, fallback: string): never {
  if (typeof error === "object" && error && "code" in error && error.code === "23505") {
    throw httpError(409, fallback);
  }
  throw error;
}

async function insertAudit(
  client: PoolClient,
  tenantId: string,
  actor: OrganizationActor,
  action: string,
  resourceType: string,
  resourceId: string | null,
  metadata: Record<string, unknown> = {}
) {
  await client.query(
    `INSERT INTO audit_logs(
       actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [actor.userId,tenantId,actor.actorScope,action,resourceType,resourceId,metadata,actor.ipAddress ?? null,actor.userAgent ?? null]
  );
}

async function assertAccessibleLead(
  client: PoolClient,
  tenantId: string,
  leadId: string,
  access: OrganizationCaseAccess,
  lock = false
) {
  // Sem JOIN no SELECT … FOR UPDATE: sob concorrência o recheck (EPQ) de um
  // JOIN pela etapa antiga descartaria a linha (404 em vez de 409).
  const result = await client.query<LeadRow>(
    `SELECT lead.id,lead.status,lead.pipeline_stage_id,lead.assigned_member_id,lead.updated_at
     FROM scheduling_leads lead
     WHERE lead.tenant_id=$1 AND lead.id=$2 AND lead.deleted_at IS NULL
       AND ($3::boolean OR lead.assigned_member_id=$4)
     ${lock ? "FOR UPDATE OF lead" : ""}`,
    [tenantId,leadId,access.workspaceWide,access.memberId]
  );
  if (!result.rows[0]) throw httpError(404, "Lead não encontrado");
  const stage = await client.query<{ pipeline_id: string }>(
    "SELECT pipeline_id FROM pipeline_stages WHERE tenant_id=$1 AND id=$2",
    [tenantId,result.rows[0].pipeline_stage_id]
  );
  return { ...result.rows[0], pipeline_id: stage.rows[0]?.pipeline_id ?? null };
}

export async function listTags(tenantId: string, includeArchived = false) {
  const result = await db.query(
    `SELECT tag.id,tag.name,tag.color,tag.archived_at,tag.created_at,tag.updated_at,
            count(assignment.lead_id)::int usage_count
     FROM lead_tags tag
     LEFT JOIN lead_tag_assignments assignment
       ON assignment.tenant_id=tag.tenant_id AND assignment.tag_id=tag.id
     WHERE tag.tenant_id=$1 AND ($2::boolean OR tag.archived_at IS NULL)
     GROUP BY tag.id
     ORDER BY tag.archived_at NULLS FIRST,lower(tag.name),tag.id`,
    [tenantId,includeArchived]
  );
  return result.rows;
}

export async function createTag(
  tenantId: string,
  actor: OrganizationActor,
  input: { name: string; color: string }
) {
  try {
    return await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO lead_tags(tenant_id,name,color,created_by_user_id)
         VALUES($1,$2,$3,$4)
         RETURNING id,name,color,archived_at,created_at,updated_at`,
        [tenantId,input.name,input.color,actor.userId]
      );
      await insertAudit(client,tenantId,actor,"lead_tag.created","lead_tag",result.rows[0].id,{ name: input.name });
      return result.rows[0];
    });
  } catch (error) {
    databaseError(error,"Já existe uma etiqueta ativa com esse nome");
  }
}

export async function updateTag(
  tenantId: string,
  tagId: string,
  actor: OrganizationActor,
  input: { name?: string; color?: string; archived?: boolean }
) {
  try {
    return await withTransaction(async (client) => {
      const current = await client.query<{ id: string; name: string; color: string; archived_at: string | null }>(
        "SELECT id,name,color,archived_at FROM lead_tags WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [tenantId,tagId]
      );
      if (!current.rows[0]) throw httpError(404,"Etiqueta não encontrada");
      const archivedAt = input.archived === undefined
        ? current.rows[0].archived_at
        : input.archived ? new Date().toISOString() : null;
      const result = await client.query(
        `UPDATE lead_tags SET name=$3,color=$4,archived_at=$5,updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING id,name,color,archived_at,created_at,updated_at`,
        [tenantId,tagId,input.name ?? current.rows[0].name,input.color ?? current.rows[0].color,archivedAt]
      );
      await insertAudit(client,tenantId,actor,"lead_tag.updated","lead_tag",tagId,{ before: current.rows[0], after: result.rows[0] });
      return result.rows[0];
    });
  } catch (error) {
    databaseError(error,"Já existe uma etiqueta ativa com esse nome");
  }
}

export async function setLeadTag(
  tenantId: string,
  leadId: string,
  tagId: string,
  present: boolean,
  access: OrganizationCaseAccess,
  actor: OrganizationActor
) {
  return withTransaction(async (client) => {
    await assertAccessibleLead(client,tenantId,leadId,access,true);
    const tag = await client.query("SELECT id FROM lead_tags WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL",[tenantId,tagId]);
    if (!tag.rows[0]) throw httpError(404,"Etiqueta ativa não encontrada");
    if (present) {
      await client.query(
        `INSERT INTO lead_tag_assignments(tenant_id,lead_id,tag_id,created_by_user_id)
         VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [tenantId,leadId,tagId,actor.userId]
      );
    } else {
      await client.query("DELETE FROM lead_tag_assignments WHERE tenant_id=$1 AND lead_id=$2 AND tag_id=$3",[tenantId,leadId,tagId]);
    }
    await insertAudit(client,tenantId,actor,present ? "lead_tag.applied" : "lead_tag.removed","scheduling_lead",leadId,{ tagId });
    return { lead_id: leadId, tag_id: tagId, applied: present };
  });
}

export async function listSavedViews(tenantId: string, userId: string, resources: string[], resource?: string) {
  const result = await db.query(
    `SELECT view.id,view.resource,view.name,view.filters,view.shared,view.owner_user_id,
            owner.email owner_email,view.created_at,view.updated_at
     FROM saved_views view
     JOIN users owner ON owner.id=view.owner_user_id
     WHERE view.tenant_id=$1 AND (view.owner_user_id=$2 OR view.shared)
       AND view.resource=ANY($3::text[])
       AND ($4::text IS NULL OR view.resource=$4)
     ORDER BY view.shared DESC,lower(view.name),view.id`,
    [tenantId,userId,resources,resource ?? null]
  );
  return result.rows;
}

export async function createSavedView(
  tenantId: string,
  actor: OrganizationActor,
  input: { resource: string; name: string; filters?: unknown; shared: boolean }
) {
  const filters = parseSavedViewFilters(input.resource as "conversations" | "leads" | "pipeline",input.filters);
  try {
    return await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO saved_views(tenant_id,owner_user_id,resource,name,filters,shared)
         VALUES($1,$2,$3,$4,$5,$6)
         RETURNING id,resource,name,filters,shared,owner_user_id,created_at,updated_at`,
        [tenantId,actor.userId,input.resource,input.name,filters,input.shared]
      );
      await insertAudit(client,tenantId,actor,input.shared ? "saved_view.published" : "saved_view.created","saved_view",result.rows[0].id,{ resource: input.resource });
      return result.rows[0];
    });
  } catch (error) {
    databaseError(error,"Já existe uma visão com esse nome");
  }
}

export async function updateSavedView(
  tenantId: string,
  viewId: string,
  actor: OrganizationActor,
  canPublish: boolean,
  input: { name?: string; filters?: unknown; shared?: boolean }
) {
  try {
    return await withTransaction(async (client) => {
      const current = await client.query<{
        id: string; owner_user_id: string; resource: "conversations" | "leads" | "pipeline"; name: string; filters: unknown; shared: boolean;
      }>("SELECT id,owner_user_id,resource,name,filters,shared FROM saved_views WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[tenantId,viewId]);
      const view = current.rows[0];
      if (!view || (view.owner_user_id !== actor.userId && (!view.shared || !canPublish))) throw httpError(404,"Visão não encontrada");
      const shared = input.shared ?? view.shared;
      if (shared && !canPublish) throw httpError(403,"Somente gestores podem publicar visões");
      const filters = input.filters === undefined ? view.filters : parseSavedViewFilters(view.resource,input.filters);
      const result = await client.query(
        `UPDATE saved_views SET name=$3,filters=$4,shared=$5,updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING id,resource,name,filters,shared,owner_user_id,created_at,updated_at`,
        [tenantId,viewId,input.name ?? view.name,filters,shared]
      );
      await insertAudit(client,tenantId,actor,shared ? "saved_view.published" : "saved_view.updated","saved_view",viewId,{ previousShared: view.shared });
      return result.rows[0];
    });
  } catch (error) {
    databaseError(error,"Já existe uma visão com esse nome");
  }
}

export async function deleteSavedView(tenantId: string, viewId: string, actor: OrganizationActor, canPublish: boolean) {
  return withTransaction(async (client) => {
    const current = await client.query<{ owner_user_id: string; shared: boolean }>(
      "SELECT owner_user_id,shared FROM saved_views WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [tenantId,viewId]
    );
    if (!current.rows[0] || (current.rows[0].owner_user_id !== actor.userId && (!current.rows[0].shared || !canPublish))) throw httpError(404,"Visão não encontrada");
    await client.query("DELETE FROM saved_views WHERE tenant_id=$1 AND id=$2",[tenantId,viewId]);
    await insertAudit(client,tenantId,actor,"saved_view.deleted","saved_view",viewId,{ shared: current.rows[0].shared });
    return { id: viewId, deleted: true };
  });
}

export async function loadPipeline(
  tenantId: string,
  options: { pipelineId?: string; includeArchived?: boolean } = {}
) {
  const includeArchived = options.includeArchived ?? false;
  const tenantExists = await db.query("SELECT id FROM tenants WHERE id=$1",[tenantId]);
  if (!tenantExists.rows[0]) throw httpError(404,"Tenant não encontrado");
  let pipeline: PipelineRow;
  if (options.pipelineId) {
    const found = await db.query<PipelineRow>(
      "SELECT * FROM pipelines WHERE tenant_id=$1 AND id=$2",
      [tenantId,options.pipelineId]
    );
    if (!found.rows[0] || (!includeArchived && found.rows[0].archived_at)) throw httpError(404,"Pipeline não encontrado");
    pipeline = found.rows[0];
  } else {
    const found = await db.query<PipelineRow>(
      `SELECT * FROM pipelines WHERE tenant_id=$1 AND archived_at IS NULL
       ORDER BY is_default DESC,position,created_at,id LIMIT 1`,
      [tenantId]
    );
    if (!found.rows[0]) throw httpError(404,"Pipeline não encontrado");
    pipeline = found.rows[0];
  }
  const [stages,transitions,followUpSettings,members] = await Promise.all([
    db.query<StageRow & { lead_count: number; created_at: string; updated_at: string }>(
      `SELECT stage.id,stage.pipeline_id,stage.name,stage.color,stage.position,stage.capacity_target,
              stage.technical_status,stage.is_default,stage.automation,stage.archived_at,
              count(lead.id)::int lead_count,stage.created_at,stage.updated_at
       FROM pipeline_stages stage
       LEFT JOIN scheduling_leads lead
         ON lead.tenant_id=stage.tenant_id AND lead.pipeline_stage_id=stage.id AND lead.deleted_at IS NULL
       WHERE stage.tenant_id=$1 AND stage.pipeline_id=$2 AND ($3::boolean OR stage.archived_at IS NULL)
       GROUP BY stage.id
       ORDER BY stage.archived_at NULLS FIRST,stage.position,stage.id`,
      [tenantId,pipeline.id,includeArchived]
    ),
    db.query(
      `SELECT transition.from_stage_id,transition.to_stage_id
       FROM pipeline_transitions transition
       JOIN pipeline_stages source ON source.id=transition.from_stage_id AND source.tenant_id=transition.tenant_id
       JOIN pipeline_stages target ON target.id=transition.to_stage_id AND target.tenant_id=transition.tenant_id
       WHERE transition.tenant_id=$1 AND source.pipeline_id=$2 AND target.pipeline_id=$2
         AND ($3::boolean OR (source.archived_at IS NULL AND target.archived_at IS NULL))
       ORDER BY transition.from_stage_id,transition.to_stage_id`,
      [tenantId,pipeline.id,includeArchived]
    ),
    db.query<{ enabled: boolean; max_count: number }>(
      `SELECT ai_follow_up_enabled enabled,
              cardinality(ai_follow_up_delays_minutes)::int max_count
       FROM tenant_ai_settings
       WHERE tenant_id=$1`,
      [tenantId]
    ),
    db.query<{ id: string; name: string | null; email: string; status: "active" }>(
      `SELECT member.id,usr.name,usr.email,member.status
       FROM workspace_members member
       JOIN users usr ON usr.id=member.user_id
       WHERE member.workspace_id=$1 AND member.status='active' AND usr.status='active'
       ORDER BY lower(COALESCE(usr.name,usr.email)),usr.email,member.id`,
      [tenantId]
    )
  ]);
  return {
    stages: stages.rows.map((stage) => ({
      ...stage,
      is_default_board: (DEFAULT_BOARD_STATUSES as readonly string[]).includes(stage.technical_status)
    })),
    transitions: transitions.rows,
    members: members.rows,
    follow_up_config: followUpSettings.rows[0] ?? { enabled: false, max_count: 0 },
    enforce_transitions: pipeline.enforce_transitions,
    pipeline: pipelineSummary(pipeline,stages.rows.length,await pipelineLeadCount(tenantId,pipeline.id))
  };
}

async function pipelineLeadCount(tenantId: string, pipelineId: string) {
  const result = await db.query<{ count: number }>(
    `SELECT count(*)::int count FROM scheduling_leads lead
     JOIN pipeline_stages stage ON stage.tenant_id=lead.tenant_id AND stage.id=lead.pipeline_stage_id
     WHERE lead.tenant_id=$1 AND stage.pipeline_id=$2 AND lead.deleted_at IS NULL`,
    [tenantId,pipelineId]
  );
  return result.rows[0]?.count ?? 0;
}

function pipelineSummary(pipeline: PipelineRow, stageCount: number, leadCount: number, channelIds: string[] = []): PipelineSummary {
  return {
    id: pipeline.id,
    name: pipeline.name,
    color: pipeline.color,
    position: pipeline.position,
    is_default: pipeline.is_default,
    enforce_transitions: pipeline.enforce_transitions,
    archived_at: pipeline.archived_at,
    stage_count: stageCount,
    lead_count: leadCount,
    channel_ids: channelIds
  };
}

// Item 1: lista de pipelines ativos + contagens + canais (só com pipeline.manage).
export async function listPipelines(tenantId: string, includeChannels: boolean) {
  const pipelines = (await db.query<PipelineRow & { stage_count: number; lead_count: number }>(
    `SELECT pipeline.*,
            (SELECT count(*)::int FROM pipeline_stages stage
             WHERE stage.tenant_id=pipeline.tenant_id AND stage.pipeline_id=pipeline.id AND stage.archived_at IS NULL) stage_count,
            (SELECT count(*)::int FROM scheduling_leads lead
             JOIN pipeline_stages stage ON stage.tenant_id=lead.tenant_id AND stage.id=lead.pipeline_stage_id
             WHERE lead.tenant_id=pipeline.tenant_id AND stage.pipeline_id=pipeline.id AND lead.deleted_at IS NULL) lead_count
     FROM pipelines pipeline
     WHERE pipeline.tenant_id=$1 AND pipeline.archived_at IS NULL
     ORDER BY pipeline.position,pipeline.created_at,pipeline.id`,
    [tenantId]
  )).rows;
  const channelIds = (await db.query<{ pipeline_id: string; session_id: string }>(
    `SELECT pipeline_id,id session_id FROM whatsapp_sessions
     WHERE tenant_id=$1 AND pipeline_id IS NOT NULL AND archived_at IS NULL`,
    [tenantId]
  )).rows;
  const byPipeline = new Map<string, string[]>();
  for (const row of channelIds) {
    const list = byPipeline.get(row.pipeline_id) ?? [];
    list.push(row.session_id);
    byPipeline.set(row.pipeline_id,list);
  }
  const summaries = pipelines.map((pipeline) => pipelineSummary(pipeline,pipeline.stage_count,pipeline.lead_count,byPipeline.get(pipeline.id) ?? []));
  if (!includeChannels) return { pipelines: summaries };
  const channels = (await db.query<{ id: string; label: string | null; channel: string; phone_number: string | null; instagram_username: string | null; pipeline_id: string | null }>(
    `SELECT session.id,session.label,session.channel,session.phone_number,session.provider_username instagram_username,session.pipeline_id
     FROM whatsapp_sessions session
     WHERE session.tenant_id=$1 AND session.archived_at IS NULL
     ORDER BY session.created_at,session.id`,
    [tenantId]
  )).rows;
  return {
    pipelines: summaries,
    channels: channels.map((channel) => ({
      id: channel.id,
      label: channel.label ?? channel.phone_number ?? channel.instagram_username ?? channel.channel,
      channel: channel.channel,
      phone_number: channel.phone_number,
      instagram_username: channel.instagram_username,
      pipeline_id: channel.pipeline_id
    }))
  };
}

// Item 2: cria o pipeline com 1 etapa "Primeiro contato"; nome ativo duplicado → 409.
export async function createPipeline(tenantId: string, actor: OrganizationActor, input: { name: string; color?: string }) {
  try {
    return await withTransaction(async (client) => {
      await client.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE",[tenantId]);
      const position = (await client.query<{ max: number }>(
        "SELECT COALESCE(max(position),-1)+1 max FROM pipelines WHERE tenant_id=$1 AND archived_at IS NULL",
        [tenantId]
      )).rows[0].max;
      const pipeline = (await client.query<PipelineRow>(
        `INSERT INTO pipelines(tenant_id,name,color,position,is_default,enforce_transitions,created_by_user_id)
         VALUES($1,$2,$3,$4,false,false,$5) RETURNING *`,
        [tenantId,input.name,input.color ?? "#22D3EE",position,actor.userId]
      )).rows[0];
      const stage = (await client.query<StageRow>(
        `INSERT INTO pipeline_stages(tenant_id,pipeline_id,name,color,position,technical_status,is_default,created_by_user_id)
         VALUES($1,$2,'Primeiro contato','#64748B',0,'novo',true,$3) RETURNING *`,
        [tenantId,pipeline.id,actor.userId]
      )).rows[0];
      await insertAudit(client,tenantId,actor,"pipeline.created","pipeline",pipeline.id,{ name: pipeline.name });
      return { pipeline: pipelineSummary(pipeline,1,0), stage };
    });
  } catch (error) {
    databaseError(error,"Já existe um pipeline com esse nome");
  }
}

// Item 3: renomeia/recolor/set_default/enforce_transitions. Espelha o modo no
// tenant quando o pipeline é o padrão.
export async function updatePipeline(
  tenantId: string,
  pipelineId: string,
  actor: OrganizationActor,
  input: { name?: string; color?: string; is_default?: true; enforce_transitions?: boolean }
) {
  try {
    return await withTransaction(async (client) => {
      const pipeline = await loadPipelineRow(client,tenantId,pipelineId,true);
      const name = input.name ?? pipeline.name;
      const color = input.color ?? pipeline.color;
      if (input.is_default) {
        await client.query("UPDATE pipelines SET is_default=false,updated_at=now() WHERE tenant_id=$1 AND is_default AND archived_at IS NULL",[tenantId]);
      }
      const enforce = input.enforce_transitions ?? pipeline.enforce_transitions;
      const updated = (await client.query<PipelineRow>(
        `UPDATE pipelines SET name=$3,color=$4,is_default=$5,enforce_transitions=$6,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [tenantId,pipelineId,name,color,input.is_default === true || pipeline.is_default,enforce]
      )).rows[0];
      if ((input.enforce_transitions !== undefined && enforce !== pipeline.enforce_transitions) && updated.is_default) {
        await client.query("UPDATE tenants SET pipeline_enforce_transitions=$2 WHERE id=$1",[tenantId,enforce]);
      }
      await insertAudit(client,tenantId,actor,"pipeline.updated","pipeline",pipelineId,{ before: { name: pipeline.name,color: pipeline.color,is_default: pipeline.is_default,enforce_transitions: pipeline.enforce_transitions }, after: { name,color,is_default: updated.is_default,enforce_transitions: enforce } });
      const stageCount = (await client.query<{ count: number }>(
        "SELECT count(*)::int count FROM pipeline_stages WHERE tenant_id=$1 AND pipeline_id=$2 AND archived_at IS NULL",
        [tenantId,pipelineId]
      )).rows[0].count;
      const leadCount = (await client.query<{ count: number }>(
        `SELECT count(*)::int count FROM scheduling_leads lead
         JOIN pipeline_stages stage ON stage.tenant_id=lead.tenant_id AND stage.id=lead.pipeline_stage_id
         WHERE lead.tenant_id=$1 AND stage.pipeline_id=$2 AND lead.deleted_at IS NULL`,
        [tenantId,pipelineId]
      )).rows[0].count;
      return { pipeline: pipelineSummary(updated,stageCount,leadCount) };
    });
  } catch (error) {
    databaseError(error,"Já existe um pipeline com esse nome");
  }
}

// Item 4: duplica o pipeline com etapas (ids novos, mesma ordem) e transições
// remapeadas; não copia leads nem canais; novo nunca é padrão.
export async function duplicatePipeline(tenantId: string, pipelineId: string, actor: OrganizationActor, input: { name?: string }) {
  try {
    return await withTransaction(async (client) => {
      const source = await loadPipelineRow(client,tenantId,pipelineId);
      const activeNames = (await client.query<{ name: string }>(
        "SELECT name FROM pipelines WHERE tenant_id=$1 AND archived_at IS NULL",
        [tenantId]
      )).rows.map((row) => row.name.toLowerCase());
      const baseName = input.name ?? `${source.name} (cópia)`;
      let name = baseName;
      let suffix = 2;
      while (activeNames.includes(name.toLowerCase())) {
        name = `${baseName} ${suffix}`;
        suffix += 1;
      }
      const position = (await client.query<{ max: number }>(
        "SELECT COALESCE(max(position),-1)+1 max FROM pipelines WHERE tenant_id=$1 AND archived_at IS NULL",
        [tenantId]
      )).rows[0].max;
      const pipeline = (await client.query<PipelineRow>(
        `INSERT INTO pipelines(tenant_id,name,color,position,is_default,enforce_transitions,created_by_user_id)
         VALUES($1,$2,$3,$4,false,$5,$6) RETURNING *`,
        [tenantId,name,source.color,position,source.enforce_transitions,actor.userId]
      )).rows[0];
      const stages = (await client.query<StageRow>(
        `SELECT * FROM pipeline_stages WHERE tenant_id=$1 AND pipeline_id=$2 AND archived_at IS NULL ORDER BY position,created_at,id`,
        [tenantId,source.id]
      )).rows;
      const idMap = new Map<string,string>();
      for (const stage of stages) {
        const created = (await client.query<{ id: string }>(
          `INSERT INTO pipeline_stages(
             tenant_id,pipeline_id,name,color,position,capacity_target,technical_status,is_default,automation,created_by_user_id
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING id`,
          [tenantId,pipeline.id,stage.name,stage.color,stage.position,stage.capacity_target,stage.technical_status,stage.is_default,JSON.stringify(stage.automation ?? {}),actor.userId]
        )).rows[0];
        idMap.set(stage.id,created.id);
      }
      const transitions = (await client.query<{ from_stage_id: string; to_stage_id: string }>(
        `SELECT transition.from_stage_id,transition.to_stage_id
         FROM pipeline_transitions transition
         JOIN pipeline_stages source_stage ON source_stage.id=transition.from_stage_id AND source_stage.tenant_id=transition.tenant_id
         JOIN pipeline_stages target_stage ON target_stage.id=transition.to_stage_id AND target_stage.tenant_id=transition.tenant_id
         WHERE transition.tenant_id=$1 AND source_stage.pipeline_id=$2 AND target_stage.pipeline_id=$2`,
        [tenantId,source.id]
      )).rows;
      for (const transition of transitions) {
        await client.query(
          `INSERT INTO pipeline_transitions(tenant_id,from_stage_id,to_stage_id,created_by_user_id)
           VALUES($1,$2,$3,$4)`,
          [tenantId,idMap.get(transition.from_stage_id)!,idMap.get(transition.to_stage_id)!,actor.userId]
        );
      }
      await insertAudit(client,tenantId,actor,"pipeline.duplicated","pipeline",pipeline.id,{ sourcePipelineId: source.id });
      return { pipeline: pipelineSummary(pipeline,stages.length,0) };
    });
  } catch (error) {
    databaseError(error,"Já existe um pipeline com esse nome");
  }
}

// Item 5: arquiva o pipeline; 409 se for o único ativo; leads vão para a etapa
// de entrada do substituto; canais vinculados voltam para o padrão (NULL).
export async function archivePipeline(
  tenantId: string,
  pipelineId: string,
  replacementPipelineId: string | undefined,
  actor: OrganizationActor
) {
  return withTransaction(async (client) => {
    const pipeline = await loadPipelineRow(client,tenantId,pipelineId,true);
    const activeCount = (await client.query<{ count: number }>(
      "SELECT count(*)::int count FROM pipelines WHERE tenant_id=$1 AND archived_at IS NULL",
      [tenantId]
    )).rows[0].count;
    if (activeCount <= 1) throw httpError(409,"A empresa precisa de pelo menos um pipeline");
    let replacement: PipelineRow | undefined;
    if (replacementPipelineId) {
      replacement = await loadPipelineRow(client,tenantId,replacementPipelineId,true);
      if (replacement.id === pipeline.id) throw httpError(400,"Pipeline substituto inválido");
    } else {
      const leadCount = (await client.query<{ count: number }>(
        `SELECT count(*)::int count FROM scheduling_leads lead
         JOIN pipeline_stages stage ON stage.tenant_id=lead.tenant_id AND stage.id=lead.pipeline_stage_id
         WHERE lead.tenant_id=$1 AND stage.pipeline_id=$2 AND lead.deleted_at IS NULL`,
        [tenantId,pipeline.id]
      )).rows[0].count;
      if (leadCount > 0) throw httpError(409,"Selecione o pipeline que receberá os contatos");
    }
    let movedLeads = 0;
    if (replacement) {
      const entryStage = (await client.query<{ entry: string | null }>(
        "SELECT pipeline_entry_stage($1,$2) entry",
        [tenantId,replacement.id]
      )).rows[0].entry;
      if (!entryStage) throw httpError(409,"Pipeline substituto sem etapa de entrada");
      const moved = await client.query<{ id: string; status: string }>(
        `UPDATE scheduling_leads lead SET pipeline_stage_id=$3,updated_at=now()
         FROM pipeline_stages stage
         WHERE lead.tenant_id=$1 AND lead.pipeline_stage_id=stage.id AND stage.pipeline_id=$2
         RETURNING lead.id,lead.status`,
        [tenantId,pipeline.id,entryStage]
      );
      movedLeads = moved.rowCount ?? 0;
      if (movedLeads > 0) {
        await client.query(
          `INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,previous_status,new_status,details,actor_user_id)
           SELECT moved.id,$1,'pipeline_changed',moved.status,moved.status,$2::jsonb,$3
           FROM unnest($4::uuid[],$5::text[]) AS moved(id,status)`,
          [tenantId,{ previous_pipeline_id: pipeline.id, new_pipeline_id: replacement.id, reason: "pipeline_archived" },actor.userId,moved.rows.map((row) => row.id),moved.rows.map((row) => row.status)]
        );
      }
    }
    if (pipeline.is_default) {
      const next = (await client.query<{ id: string }>(
        `SELECT id FROM pipelines WHERE tenant_id=$1 AND archived_at IS NULL AND id<>$2
         ORDER BY position,created_at,id LIMIT 1`,
        [tenantId,pipeline.id]
      )).rows[0];
      // O substituto escolhido herda o padrão; sem ele, o próximo na ordem.
      const heir = replacement?.id ?? next?.id;
      await client.query("UPDATE pipelines SET is_default=false,updated_at=now() WHERE tenant_id=$1 AND id=$2",[tenantId,pipeline.id]);
      if (heir) await client.query("UPDATE pipelines SET is_default=true,updated_at=now() WHERE tenant_id=$1 AND id=$2",[tenantId,heir]);
    }
    await client.query(
      "UPDATE whatsapp_sessions SET pipeline_id=NULL WHERE tenant_id=$1 AND pipeline_id=$2",
      [tenantId,pipeline.id]
    );
    await client.query("UPDATE pipeline_stages SET archived_at=now(),updated_at=now() WHERE tenant_id=$1 AND pipeline_id=$2",[tenantId,pipeline.id]);
    await client.query("UPDATE pipelines SET archived_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2",[tenantId,pipeline.id]);
    await insertAudit(client,tenantId,actor,"pipeline.archived","pipeline",pipeline.id,{ replacementPipelineId: replacement?.id ?? null });
    return { id: pipeline.id, archived: true, moved_leads: movedLeads };
  });
}

// Item 6: reordena os pipelines ativos; conjunto deve ser exatamente os ativos.
export async function reorderPipelines(tenantId: string, actor: OrganizationActor, pipelineIds: string[]) {
  return withTransaction(async (client) => {
    const active = (await client.query<{ id: string }>(
      "SELECT id FROM pipelines WHERE tenant_id=$1 AND archived_at IS NULL ORDER BY position,created_at,id",
      [tenantId]
    )).rows.map((row) => row.id);
    if (active.length !== pipelineIds.length || [...active].sort().join() !== [...pipelineIds].sort().join()) {
      throw httpError(400,"Lista de pipelines não corresponde aos pipelines ativos");
    }
    for (const [index,pipelineId] of pipelineIds.entries()) {
      await client.query("UPDATE pipelines SET position=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",[tenantId,pipelineId,index]);
    }
    await insertAudit(client,tenantId,actor,"pipeline.reordered","pipeline",pipelineIds[0],{ pipeline_ids: pipelineIds });
    return listPipelines(tenantId,false);
  });
}

// Item 7: define o conjunto de canais do pipeline; sessões devem ser do tenant
// e ativas; quem sai da lista volta para NULL (pipeline padrão).
export async function setPipelineChannels(
  tenantId: string,
  pipelineId: string,
  actor: OrganizationActor,
  sessionIds: string[]
) {
  return withTransaction(async (client) => {
    const pipeline = await loadPipelineRow(client,tenantId,pipelineId,true);
    if (sessionIds.length > 0) {
      const sessions = await client.query<{ id: string }>(
        "SELECT id FROM whatsapp_sessions WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND archived_at IS NULL",
        [tenantId,sessionIds]
      );
      if (sessions.rows.length !== new Set(sessionIds).size) throw httpError(400,"Canal inválido ou inativo");
    }
    await client.query(
      "UPDATE whatsapp_sessions SET pipeline_id=NULL WHERE tenant_id=$1 AND pipeline_id=$2 AND NOT (id=ANY($3::uuid[]))",
      [tenantId,pipeline.id,sessionIds]
    );
    await client.query(
      "UPDATE whatsapp_sessions SET pipeline_id=$3 WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
      [tenantId,sessionIds,pipeline.id]
    );
    await insertAudit(client,tenantId,actor,"pipeline.channels.updated","pipeline",pipeline.id,{ session_ids: sessionIds });
    return { pipeline_id: pipeline.id, session_ids: sessionIds };
  });
}

// Item 8: reordena as etapas ATIVAS do pipeline sob lock do pipeline.
export async function reorderPipelineStages(
  tenantId: string,
  pipelineId: string,
  actor: OrganizationActor,
  stageIds: string[]
) {
  return withTransaction(async (client) => {
    const pipeline = await loadPipelineRow(client,tenantId,pipelineId);
    await client.query("SELECT id FROM pipelines WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[tenantId,pipeline.id]);
    const active = (await client.query<{ id: string }>(
      "SELECT id FROM pipeline_stages WHERE tenant_id=$1 AND pipeline_id=$2 AND archived_at IS NULL ORDER BY position,created_at,id",
      [tenantId,pipeline.id]
    )).rows.map((row) => row.id);
    if (active.length !== stageIds.length || [...active].sort().join() !== [...stageIds].sort().join()) {
      throw httpError(400,"Lista de etapas não corresponde às etapas ativas do pipeline");
    }
    for (const [index,stageId] of stageIds.entries()) {
      await client.query("UPDATE pipeline_stages SET position=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",[tenantId,stageId,index]);
    }
    await insertAudit(client,tenantId,actor,"pipeline_stage.reordered","pipeline",pipeline.id,{ stage_ids: stageIds });
    return { stages: stageIds.map((stageId,index) => ({ id: stageId,position: index })) };
  });
}

// Item 15: atualiza o pipeline (padrão quando pipeline_id ausente) e espelha no
// tenant quando o pipeline alterado é o padrão.
export async function updatePipelineSettings(
  tenantId: string,
  actor: OrganizationActor,
  input: { enforce_transitions: boolean; pipeline_id?: string }
) {
  return withTransaction(async (client) => {
    const pipeline = input.pipeline_id
      ? await loadPipelineRow(client,tenantId,input.pipeline_id,true)
      : await defaultPipeline(client,tenantId,true);
    const previous = pipeline.enforce_transitions;
    await client.query("UPDATE pipelines SET enforce_transitions=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",[tenantId,pipeline.id,input.enforce_transitions]);
    if (pipeline.is_default) {
      await client.query("UPDATE tenants SET pipeline_enforce_transitions=$2 WHERE id=$1",[tenantId,input.enforce_transitions]);
    }
    await insertAudit(client,tenantId,actor,"pipeline.settings.updated","pipeline",pipeline.id,{
      pipeline_id: pipeline.id,
      enforce_transitions: input.enforce_transitions,
      previous_enforce_transitions: previous
    });
    return { enforce_transitions: input.enforce_transitions };
  });
}

async function setDefaultStage(client: PoolClient, tenantId: string, stage: StageRow) {
  await client.query(
    `UPDATE pipeline_stages SET is_default=false,updated_at=now()
     WHERE tenant_id=$1 AND pipeline_id=$2 AND technical_status=$3 AND id<>$4 AND is_default`,
    [tenantId,stage.pipeline_id,stage.technical_status,stage.id]
  );
  await client.query("UPDATE pipeline_stages SET is_default=true,updated_at=now() WHERE tenant_id=$1 AND id=$2",[tenantId,stage.id]);
}

export async function createPipelineStage(tenantId: string, actor: OrganizationActor, input: StageCreateInput) {
  try {
    return await withTransaction(async (client) => {
      const pipeline = input.pipeline_id
        ? await loadPipelineRow(client,tenantId,input.pipeline_id)
        : await defaultPipeline(client,tenantId);
      const position = input.position ?? await client.query<{ max: number }>(
        "SELECT COALESCE(max(position),-1)+1 max FROM pipeline_stages WHERE tenant_id=$1 AND pipeline_id=$2",
        [tenantId,pipeline.id]
      ).then((result) => result.rows[0].max);
      await assertStageAutomation(client,tenantId,input.automation);
      const result = await client.query<StageRow>(
        `INSERT INTO pipeline_stages(
           tenant_id,pipeline_id,name,color,position,capacity_target,technical_status,is_default,automation,created_by_user_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
         RETURNING *`,
        [tenantId,pipeline.id,input.name,input.color,position,input.capacity_target ?? null,input.technical_status,input.is_default === true,JSON.stringify(input.automation ?? {}),actor.userId]
      );
      if (input.is_default) await setDefaultStage(client,tenantId,result.rows[0]);
      await insertAudit(client,tenantId,actor,"pipeline_stage.created","pipeline_stage",result.rows[0].id,{ technicalStatus: input.technical_status });
      return { ...result.rows[0], is_default: input.is_default === true };
    });
  } catch (error) {
    databaseError(error,"Já existe uma etapa ativa com esse nome");
  }
}

export async function updatePipelineStage(tenantId: string, stageId: string, actor: OrganizationActor, input: StageUpdateInput) {
  try {
    return await withTransaction(async (client) => {
      const stage = await stageById(client,tenantId,stageId,true);
      // 0184 item 11: mudar comportamento é permitido mesmo com leads/etapa
      // preferida — a etapa perde is_default se trocar de comportamento.
      const result = await client.query<StageRow>(
        `UPDATE pipeline_stages SET
           name=$3,color=$4,position=$5,capacity_target=$6,technical_status=$7,automation=$8::jsonb,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [tenantId,stageId,input.name ?? stage.name,input.color ?? stage.color,input.position ?? stage.position,
          input.capacity_target === undefined ? stage.capacity_target : input.capacity_target,
          input.technical_status ?? stage.technical_status,
          input.automation === undefined ? JSON.stringify(stage.automation ?? {}) : JSON.stringify(input.automation)]
      );
      if (input.technical_status && input.technical_status !== stage.technical_status) {
        await client.query("UPDATE pipeline_stages SET is_default=false,updated_at=now() WHERE tenant_id=$1 AND id=$2",[tenantId,stageId]);
      }
      if (input.is_default === true) await setDefaultStage(client,tenantId,result.rows[0]);
      if (input.is_default === false && stage.is_default) throw httpError(409,"Selecione outra etapa padrão antes de remover esta configuração");
      await insertAudit(client,tenantId,actor,"pipeline_stage.updated","pipeline_stage",stageId,{ before: stage, after: result.rows[0] });
      const updated = (await client.query<StageRow>("SELECT * FROM pipeline_stages WHERE tenant_id=$1 AND id=$2",[tenantId,stageId])).rows[0];
      return updated;
    });
  } catch (error) {
    databaseError(error,"Já existe uma etapa ativa com esse nome");
  }
}

// Item 13: substituta deve ser do MESMO pipeline (400 senão); obrigatória só
// quando há leads; 409 se for a última etapa ativa do pipeline. is_default do
// comportamento é herdado por substituta do MESMO comportamento, se houver.
export async function archivePipelineStage(
  tenantId: string,
  stageId: string,
  replacementStageId: string | undefined,
  actor: OrganizationActor
) {
  return withTransaction(async (client) => {
    const stage = await stageById(client,tenantId,stageId,true);
    const stageLeadCount = (await client.query<{ count: number }>(
      "SELECT count(*)::int count FROM scheduling_leads WHERE tenant_id=$1 AND pipeline_stage_id=$2 AND deleted_at IS NULL",
      [tenantId,stageId]
    )).rows[0].count;
    const activeCount = (await client.query<{ count: number }>(
      "SELECT count(*)::int count FROM pipeline_stages WHERE tenant_id=$1 AND pipeline_id=$2 AND archived_at IS NULL",
      [tenantId,stage.pipeline_id]
    )).rows[0].count;
    if (activeCount <= 1) throw httpError(409,"O pipeline precisa de pelo menos uma etapa");
    let replacement: StageRow | undefined;
    if (replacementStageId) {
      replacement = await stageById(client,tenantId,replacementStageId,true);
      if (replacement.id === stage.id) throw httpError(400,"Etapa substituta inválida");
      if (replacement.pipeline_id !== stage.pipeline_id) throw httpError(400,"Etapa substituta inválida");
    }
    if (stageLeadCount > 0 && !replacement) {
      throw httpError(409,"Selecione uma etapa substituta");
    }
    if (replacement) {
      await client.query(
        "UPDATE scheduling_leads SET pipeline_stage_id=$3,updated_at=now() WHERE tenant_id=$1 AND pipeline_stage_id=$2",
        [tenantId,stageId,replacement.id]
      );
    }
    if (stage.is_default && replacement && replacement.technical_status === stage.technical_status) {
      await setDefaultStage(client,tenantId,replacement);
    }
    await client.query("DELETE FROM pipeline_transitions WHERE tenant_id=$1 AND (from_stage_id=$2 OR to_stage_id=$2)",[tenantId,stageId]);
    await client.query("UPDATE pipeline_stages SET archived_at=now(),is_default=false,updated_at=now() WHERE tenant_id=$1 AND id=$2",[tenantId,stageId]);
    await insertAudit(client,tenantId,actor,"pipeline_stage.archived","pipeline_stage",stageId,{ replacementStageId: replacement?.id ?? null, movedLeads: stageLeadCount });
    return { id: stageId, archived: true, replacement_stage_id: replacement?.id ?? null, moved_leads: stageLeadCount };
  });
}

// Item 12: duplica a etapa logo após a original (reposiciona as seguintes +1),
// nome com sufixo numérico em colisão, is_default false, sem leads.
export async function duplicatePipelineStage(tenantId: string, stageId: string, actor: OrganizationActor) {
  return withTransaction(async (client) => {
    const source = await stageById(client,tenantId,stageId,true);
    const siblings = (await client.query<StageRow>(
      `SELECT * FROM pipeline_stages
       WHERE tenant_id=$1 AND pipeline_id=$2 AND archived_at IS NULL
       ORDER BY position,created_at,id FOR UPDATE`,
      [tenantId,source.pipeline_id]
    )).rows;
    const baseName = `${source.name} (cópia)`;
    let name = baseName;
    let suffix = 2;
    const taken = new Set(siblings.map((stage) => stage.name.toLowerCase()));
    while (taken.has(name.toLowerCase())) {
      name = `${baseName} ${suffix}`;
      suffix += 1;
    }
    await client.query(
      "UPDATE pipeline_stages SET position=position+1,updated_at=now() WHERE tenant_id=$1 AND pipeline_id=$2 AND archived_at IS NULL AND position>$3",
      [tenantId,source.pipeline_id,source.position]
    );
    const created = (await client.query<StageRow>(
      `INSERT INTO pipeline_stages(
         tenant_id,pipeline_id,name,color,position,capacity_target,technical_status,is_default,automation,created_by_user_id
       ) VALUES($1,$2,$3,$4,$5,$6,$7,false,$8::jsonb,$9)
       RETURNING *`,
      [tenantId,source.pipeline_id,name,source.color,source.position + 1,source.capacity_target,source.technical_status,JSON.stringify(source.automation ?? {}),actor.userId]
    )).rows[0];
    await insertAudit(client,tenantId,actor,"pipeline_stage.duplicated","pipeline_stage",created.id,{ sourceStageId: source.id });
    return created;
  });
}

// Item 14: origem e destinos devem pertencer ao MESMO pipeline (400 senão).
export async function replaceStageTransitions(tenantId: string, stageId: string, targetIds: string[], actor: OrganizationActor) {
  return withTransaction(async (client) => {
    const stages = await client.query<StageRow>(
      `SELECT * FROM pipeline_stages
       WHERE tenant_id=$1 AND archived_at IS NULL AND id=ANY($2::uuid[])
       FOR UPDATE`,
      [tenantId,[stageId,...targetIds]]
    );
    const byId = new Map(stages.rows.map((stage) => [stage.id,stage]));
    const source = byId.get(stageId);
    if (!source) throw httpError(404,"Etapa de origem não encontrada");
    for (const targetId of targetIds) {
      const target = byId.get(targetId);
      if (!target || target.pipeline_id !== source.pipeline_id) throw httpError(400,"Etapa de destino inválida");
      if (target.id === source.id) throw httpError(400,"Uma etapa não pode transicionar para si mesma");
      if (!domainAllowsStageTransition(source.technical_status,target.technical_status)) {
        throw httpError(409,`Transição proibida pelo domínio: ${source.technical_status} -> ${target.technical_status}`);
      }
    }
    await client.query("DELETE FROM pipeline_transitions WHERE tenant_id=$1 AND from_stage_id=$2",[tenantId,stageId]);
    for (const targetId of targetIds) {
      await client.query(
        `INSERT INTO pipeline_transitions(tenant_id,from_stage_id,to_stage_id,created_by_user_id)
         VALUES($1,$2,$3,$4)`,
        [tenantId,stageId,targetId,actor.userId]
      );
    }
    await insertAudit(client,tenantId,actor,"pipeline_transitions.replaced","pipeline_stage",stageId,{ targetIds });
    return { from_stage_id: stageId, to_stage_ids: targetIds };
  });
}

// Itens 16/17/18: mover o lead (single ou bulk). enforce_transitions vem do
// PIPELINE ALVO; sequência só vale dentro do mesmo pipeline (cross-pipeline
// ignora o grafo). Automação da etapa alvo roda quando o lead entra nela e o
// sinal realtime sai na mesma transação, uma vez por lead.
async function moveLeadToStage(
  client: PoolClient,
  tenantId: string,
  lead: LeadRow,
  target: StageRow,
  actor: OrganizationActor,
  requireConfiguredTransition = true,
  commercial?: CommercialTransitionPayload,
  enforceTransitions = true
) {
  const samePipeline = lead.pipeline_id === target.pipeline_id;
  if (enforceTransitions && samePipeline && !domainAllowsStageTransition(lead.status,target.technical_status)) {
    throw httpError(409,`Transição proibida pelo domínio: ${lead.status} -> ${target.technical_status}`);
  }
  if (enforceTransitions && samePipeline && lead.pipeline_stage_id !== target.id && requireConfiguredTransition) {
    const transition = await client.query(
      `SELECT 1 FROM pipeline_transitions
       WHERE tenant_id=$1 AND from_stage_id=$2 AND to_stage_id=$3`,
      [tenantId,lead.pipeline_stage_id,target.id]
    );
    if (!transition.rows[0]) throw httpError(409,"Transição não habilitada na configuração do Pipeline");
  }
  if (stageRequiresCommercialPayload(target.technical_status) && !commercial) {
    throw httpError(400,"Esta etapa exige dados comerciais antes da movimentação");
  }
  if (!stageRequiresCommercialPayload(target.technical_status) && commercial) {
    throw httpError(400,"Esta etapa não aceita dados comerciais");
  }
  const previousUserId = await memberUserId(client,tenantId,lead.assigned_member_id);
  const result = await applyStructuredStageEffects(client,{
    tenantId,
    lead,
    targetStatus: target.technical_status,
    targetStageId: target.id,
    payload: commercial,
    actor
  });
  if (lead.pipeline_stage_id !== target.id) {
    await client.query(
      `UPDATE ai_follow_up_schedules schedule
       SET status='cancelled',next_run_at=NULL,processing_started_at=NULL,
           sequence_version=schedule.sequence_version+1,
           cancellation_reason='pipeline_stage_changed',updated_at=now()
       FROM conversations conversation,scheduling_leads current_lead
       WHERE current_lead.tenant_id=$1 AND current_lead.id=$2
         AND conversation.tenant_id=current_lead.tenant_id
         AND regexp_replace(conversation.contact_phone,'\\D','','g')=regexp_replace(current_lead.phone,'\\D','','g')
         AND schedule.tenant_id=conversation.tenant_id
         AND schedule.conversation_id=conversation.id
         AND schedule.status IN ('scheduled','processing','completed','failed')`,
      [tenantId,lead.id]
    );
    await applyStageAutomation(client,tenantId,lead.id,target.automation,actor.userId);
  }
  await client.query(
    `INSERT INTO scheduling_lead_events(
       lead_id,tenant_id,event_type,previous_status,new_status,details,actor_user_id
     ) VALUES($1,$2,'pipeline_stage_updated',$3,$4,$5,$6)`,
    [lead.id,tenantId,lead.status,target.technical_status,{ previous_stage_id: lead.pipeline_stage_id, new_stage_id: target.id },actor.userId]
  );
  if (!samePipeline) {
    await client.query(
      `INSERT INTO scheduling_lead_events(
         lead_id,tenant_id,event_type,details,actor_user_id
       ) VALUES($1,$2,'pipeline_changed',$3,$4)`,
      [lead.id,tenantId,{ previous_pipeline_id: lead.pipeline_id ?? null, new_pipeline_id: target.pipeline_id },actor.userId]
    );
  }
  // Sinal realtime (item 18), na mesma transação, uma vez por lead.
  const assignedUserAfter = await memberUserId(
    client,
    tenantId,
    (await client.query<{ assigned_member_id: string | null }>(
      "SELECT assigned_member_id FROM scheduling_leads WHERE tenant_id=$1 AND id=$2",
      [tenantId,lead.id]
    )).rows[0]?.assigned_member_id ?? null
  );
  await notifyLeadMoved(client,tenantId,lead.id,previousUserId,assignedUserAfter ?? null);
  return result;
}

export async function moveLeadStage(
  tenantId: string,
  leadId: string,
  stageId: string,
  expectedUpdatedAt: string | undefined,
  access: OrganizationCaseAccess,
  actor: OrganizationActor,
  commercial?: CommercialTransitionPayload
) {
  return withTransaction(async (client) => {
    const lead = await assertAccessibleLead(client,tenantId,leadId,access,true);
    if (expectedUpdatedAt && serializedDate(lead.updated_at) !== serializedDate(expectedUpdatedAt)) throw httpError(409,"Lead alterado por outra operação");
    const target = await stageById(client,tenantId,stageId);
    // Sequência (quando governado) é a do PIPELINE ALVO; cross-pipeline ignora o grafo.
    const enforceTransitions = await pipelineEnforcesTransitions(client,tenantId,target.id);
    const updated = await moveLeadToStage(client,tenantId,lead,target,actor,true,commercial,enforceTransitions);
    await insertAudit(client,tenantId,actor,"pipeline_stage.lead_moved","scheduling_lead",leadId,{ previousStageId: lead.pipeline_stage_id, stageId });
    return updated;
  });
}

async function validateBulk(
  client: PoolClient,
  tenantId: string,
  access: OrganizationCaseAccess,
  input: BulkPreviewInput,
  lock: boolean
): Promise<BulkValidation> {
  const ids = input.items.map((item) => item.id);
  const leads = await client.query<LeadRow>(
    `SELECT lead.id,lead.status,lead.pipeline_stage_id,
            (SELECT stage.pipeline_id FROM pipeline_stages stage WHERE stage.tenant_id=lead.tenant_id AND stage.id=lead.pipeline_stage_id) pipeline_id,
            lead.assigned_member_id,lead.updated_at
     FROM scheduling_leads lead
     WHERE lead.tenant_id=$1 AND lead.id=ANY($2::uuid[]) AND lead.deleted_at IS NULL
       AND ($3::boolean OR lead.assigned_member_id=$4)
     ${lock ? "FOR UPDATE OF lead" : ""}`,
    [tenantId,ids,access.workspaceWide,access.memberId]
  );
  const byId = new Map(leads.rows.map((lead) => [lead.id,lead]));
  const errors: BulkValidation["errors"] = [];
  for (const item of input.items) {
    const lead = byId.get(item.id);
    if (!lead) errors.push({ id: item.id, code: "not_found_or_forbidden", message: "Registro não encontrado ou sem permissão" });
    else if (item.expected_updated_at && serializedDate(lead.updated_at) !== serializedDate(item.expected_updated_at)) {
      errors.push({ id: item.id, code: "concurrent_change", message: "Registro alterado desde a seleção" });
    }
  }
  let undoable = true;
  let targetStage: StageRow | undefined;
  let targetMemberUserId: string | null | undefined;
  let enforceTransitions = false;
  if (input.action === "assign") {
    if (input.assigned_member_id) {
      const member = await client.query<{ user_id: string }>(
        `SELECT user_id FROM workspace_members
         WHERE workspace_id=$1 AND id=$2 AND status='active'`,
        [tenantId,input.assigned_member_id]
      );
      if (!member.rows[0]) errors.push({ id: input.assigned_member_id, code: "invalid_assignee", message: "Responsável ativo não encontrado" });
      else targetMemberUserId = member.rows[0].user_id;
    } else targetMemberUserId = null;
  } else if (input.action === "tags_add" || input.action === "tags_remove") {
    const tags = await client.query<{ id: string }>(
      "SELECT id FROM lead_tags WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND archived_at IS NULL",
      [tenantId,input.tag_ids]
    );
    const found = new Set(tags.rows.map((tag) => tag.id));
    for (const tagId of input.tag_ids) if (!found.has(tagId)) errors.push({ id: tagId, code: "invalid_tag", message: "Etiqueta ativa não encontrada" });
  } else {
    targetStage = (await client.query<StageRow>(
      "SELECT * FROM pipeline_stages WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL",
      [tenantId,input.stage_id]
    )).rows[0];
    if (!targetStage) errors.push({ id: input.stage_id, code: "invalid_stage", message: "Etapa ativa não encontrada" });
    else {
      if (stageRequiresCommercialPayload(targetStage.technical_status)) {
        errors.push({ id: targetStage.id, code: "commercial_payload_required", message: "Esta etapa exige dados comerciais e não pode ser aplicada em lote" });
      }
      // Modo de movimentação é o do pipeline ALVO; sequência só vale dentro do
      // mesmo pipeline (cross-pipeline ignora o grafo).
      enforceTransitions = await pipelineEnforcesTransitions(client,tenantId,targetStage.id);
      const transitionPairs = leads.rows.filter((lead) => lead.pipeline_stage_id !== targetStage?.id);
      const governedPairs = transitionPairs.filter((lead) => lead.pipeline_id === targetStage!.pipeline_id);
      const transitions = enforceTransitions && governedPairs.length > 0 ? await client.query<{ from_stage_id: string }>(
        `SELECT from_stage_id FROM pipeline_transitions
         WHERE tenant_id=$1 AND to_stage_id=$2 AND from_stage_id=ANY($3::uuid[])`,
        [tenantId,targetStage.id,governedPairs.map((lead) => lead.pipeline_stage_id)]
      ) : { rows: [] as Array<{ from_stage_id: string }> };
      const configured = new Set(transitions.rows.map((row) => row.from_stage_id));
      for (const lead of transitionPairs) {
        const governed = enforceTransitions && lead.pipeline_id === targetStage!.pipeline_id;
        if (governed && !domainAllowsStageTransition(lead.status,targetStage.technical_status)) {
          errors.push({ id: lead.id, code: "domain_transition", message: `Transição técnica proibida: ${lead.status} -> ${targetStage.technical_status}` });
        } else if (governed && !configured.has(lead.pipeline_stage_id)) {
          errors.push({ id: lead.id, code: "pipeline_transition", message: "Transição não habilitada na configuração do Pipeline" });
        }
      }
      undoable = leads.rows.every((lead) => configuredStageTransitionIsUndoable(lead.status,targetStage!.technical_status));
    }
  }
  return {
    valid: errors.length === 0,
    count: input.items.length,
    items: leads.rows.map((lead) => ({ ...lead, updated_at: serializedDate(lead.updated_at) })),
    errors,
    undoable,
    enforceTransitions,
    ...(targetStage ? { targetStage } : {}),
    ...(targetMemberUserId !== undefined ? { targetMemberUserId } : {})
  };
}

export async function previewBulkOperation(
  tenantId: string,
  access: OrganizationCaseAccess,
  input: BulkPreviewInput
) {
  return withTransaction((client) => validateBulk(client,tenantId,access,input,false));
}

function bulkConflict(validation: BulkValidation): never {
  const error = httpError(409,"Operação em lote bloqueada: um ou mais itens são inválidos") as Error & { details?: unknown };
  error.details = validation.errors;
  throw error;
}

export async function applyBulkOperation(
  tenantId: string,
  access: OrganizationCaseAccess,
  actor: OrganizationActor,
  input: BulkApplyInput
) {
  const result = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`organization-bulk:${tenantId}:${actor.userId}:${input.idempotency_key}`]);
    const existing = await client.query<{ id: string; action: string; response_payload: Record<string, unknown>; undo_expires_at: string | null; undone_at: string | null }>(
      `SELECT id,action,response_payload,undo_expires_at,undone_at FROM bulk_operations
       WHERE tenant_id=$1 AND actor_user_id=$2 AND idempotency_key=$3`,
      [tenantId,actor.userId,input.idempotency_key]
    );
    if (existing.rows[0]) return { operation: existing.rows[0], result: existing.rows[0].response_payload, idempotent_replay: true };
    const validation = await validateBulk(client,tenantId,access,input,true);
    if (!validation.valid) bulkConflict(validation);
    const leadIds = input.items.map((item) => item.id);
    let undoPayload: Record<string, unknown> | null = null;
    if (input.action === "assign") {
      undoPayload = {
        action: input.action,
        applied_member_id: input.assigned_member_id,
        items: validation.items.map((lead) => ({ id: lead.id, previous_member_id: lead.assigned_member_id }))
      };
      await client.query(
        "UPDATE scheduling_leads SET assigned_member_id=$3,updated_at=now() WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
        [tenantId,leadIds,input.assigned_member_id]
      );
      await client.query(
        `UPDATE conversations conversation SET assigned_user_id=$3
         WHERE conversation.tenant_id=$1 AND conversation.lead_id=ANY($2::uuid[])`,
        [tenantId,leadIds,validation.targetMemberUserId ?? null]
      );
    } else if (input.action === "tags_add" || input.action === "tags_remove") {
      const present = await client.query<{ lead_id: string; tag_id: string }>(
        `SELECT lead_id,tag_id FROM lead_tag_assignments
         WHERE tenant_id=$1 AND lead_id=ANY($2::uuid[]) AND tag_id=ANY($3::uuid[])`,
        [tenantId,leadIds,input.tag_ids]
      );
      const before = new Set(present.rows.map((row) => `${row.lead_id}:${row.tag_id}`));
      undoPayload = {
        action: input.action,
        items: leadIds.flatMap((leadId) => input.tag_ids.map((tagId) => ({ lead_id: leadId, tag_id: tagId, was_present: before.has(`${leadId}:${tagId}`) })))
      };
      if (input.action === "tags_add") {
        await client.query(
          `INSERT INTO lead_tag_assignments(tenant_id,lead_id,tag_id,created_by_user_id)
           SELECT $1,lead_id,tag_id,$4
           FROM unnest($2::uuid[]) lead_id CROSS JOIN unnest($3::uuid[]) tag_id
           ON CONFLICT DO NOTHING`,
          [tenantId,leadIds,input.tag_ids,actor.userId]
        );
      } else {
        await client.query(
          "DELETE FROM lead_tag_assignments WHERE tenant_id=$1 AND lead_id=ANY($2::uuid[]) AND tag_id=ANY($3::uuid[])",
          [tenantId,leadIds,input.tag_ids]
        );
      }
    } else {
      const target = validation.targetStage!;
      undoPayload = validation.undoable ? {
        action: input.action,
        target_stage_id: target.id,
        target_status: target.technical_status,
        items: validation.items.map((lead) => ({ id: lead.id, previous_stage_id: lead.pipeline_stage_id, previous_status: lead.status }))
      } : null;
      for (const lead of validation.items) await moveLeadToStage(client,tenantId,lead,target,actor,true,undefined,validation.enforceTransitions);
    }
    const undoExpiresAt = undoPayload ? new Date(Date.now()+30_000).toISOString() : null;
    const resultPayload = { action: input.action, count: leadIds.length, undoable: Boolean(undoPayload), undo_expires_at: undoExpiresAt };
    const operation = await client.query<{ id: string; action: string; created_at: string; undo_expires_at: string | null; undone_at: string | null }>(
      `INSERT INTO bulk_operations(
         tenant_id,actor_user_id,action,idempotency_key,request_payload,response_payload,undo_payload,undo_expires_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id,action,created_at,undo_expires_at,undone_at`,
      [tenantId,actor.userId,input.action,input.idempotency_key,input,resultPayload,undoPayload,undoExpiresAt]
    );
    await insertAudit(client,tenantId,actor,"bulk_operation.applied","bulk_operation",operation.rows[0].id,{ action: input.action, count: leadIds.length, undoable: Boolean(undoPayload) });
    return { operation: operation.rows[0], result: resultPayload, idempotent_replay: false };
  });
  if (input.action === "assign" && !result.idempotent_replay) {
    await Promise.allSettled(input.items.map((item) =>
      refreshAppointmentGroupNotificationsForLead(tenantId, item.id)
    ));
  }
  return result;
}

type AssignUndo = { action: "assign"; applied_member_id: string | null; items: Array<{ id: string; previous_member_id: string | null }> };
type TagsUndo = { action: "tags_add" | "tags_remove"; items: Array<{ lead_id: string; tag_id: string; was_present: boolean }> };
type StageUndo = { action: "move_stage"; target_stage_id: string; target_status: LeadTechnicalStatus; items: Array<{ id: string; previous_stage_id: string; previous_status: LeadTechnicalStatus }> };

export async function undoBulkOperation(tenantId: string, operationId: string, actor: OrganizationActor) {
  const response = await withTransaction(async (client) => {
    const result = await client.query<{ id: string; action: string; undo_payload: AssignUndo | TagsUndo | StageUndo | null; undo_expires_at: string | null; undone_at: string | null }>(
      `SELECT id,action,undo_payload,undo_expires_at,undone_at
       FROM bulk_operations
       WHERE tenant_id=$1 AND id=$2 AND actor_user_id=$3 FOR UPDATE`,
      [tenantId,operationId,actor.userId]
    );
    const operation = result.rows[0];
    if (!operation) throw httpError(404,"Operação em lote não encontrada");
    if (operation.undone_at) throw httpError(409,"Operação já desfeita");
    if (!operation.undo_payload || !operation.undo_expires_at) throw httpError(409,"Esta operação não pode ser desfeita");
    if (new Date(operation.undo_expires_at).getTime() <= Date.now()) throw httpError(410,"Prazo de 30 segundos para desfazer expirou");
    const undo = operation.undo_payload;
    if (undo.action === "assign") {
      const ids = undo.items.map((item) => item.id);
      const current = await client.query<{ id: string; assigned_member_id: string | null }>(
        "SELECT id,assigned_member_id FROM scheduling_leads WHERE tenant_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE",
        [tenantId,ids]
      );
      if (current.rows.length !== ids.length || current.rows.some((lead) => lead.assigned_member_id !== undo.applied_member_id)) {
        throw httpError(409,"Não é possível desfazer após alterações concorrentes");
      }
      for (const item of undo.items) {
        const member = item.previous_member_id ? await client.query<{ user_id: string }>(
          "SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND id=$2",
          [tenantId,item.previous_member_id]
        ) : null;
        await client.query("UPDATE scheduling_leads SET assigned_member_id=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",[tenantId,item.id,item.previous_member_id]);
        await client.query("UPDATE conversations SET assigned_user_id=$3 WHERE tenant_id=$1 AND lead_id=$2",[tenantId,item.id,member?.rows[0]?.user_id ?? null]);
      }
    } else if (undo.action === "tags_add" || undo.action === "tags_remove") {
      const leadIds = [...new Set(undo.items.map((item) => item.lead_id))];
      const tagIds = [...new Set(undo.items.map((item) => item.tag_id))];
      const current = await client.query<{ lead_id: string; tag_id: string }>(
        "SELECT lead_id,tag_id FROM lead_tag_assignments WHERE tenant_id=$1 AND lead_id=ANY($2::uuid[]) AND tag_id=ANY($3::uuid[])",
        [tenantId,leadIds,tagIds]
      );
      const present = new Set(current.rows.map((row) => `${row.lead_id}:${row.tag_id}`));
      const appliedPresence = undo.action === "tags_add";
      if (undo.items.some((item) => present.has(`${item.lead_id}:${item.tag_id}`) !== appliedPresence)) {
        throw httpError(409,"Não é possível desfazer após alterações concorrentes");
      }
      for (const item of undo.items) {
        if (item.was_present) {
          await client.query(
            `INSERT INTO lead_tag_assignments(tenant_id,lead_id,tag_id,created_by_user_id)
             VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
            [tenantId,item.lead_id,item.tag_id,actor.userId]
          );
        } else {
          await client.query("DELETE FROM lead_tag_assignments WHERE tenant_id=$1 AND lead_id=$2 AND tag_id=$3",[tenantId,item.lead_id,item.tag_id]);
        }
      }
    } else {
      const stageUndo = undo as StageUndo;
      const ids = stageUndo.items.map((item) => item.id);
      const current = await client.query<LeadRow>(
        "SELECT id,status,pipeline_stage_id,assigned_member_id,updated_at FROM scheduling_leads WHERE tenant_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE",
        [tenantId,ids]
      );
      if (current.rows.length !== ids.length || current.rows.some((lead) => lead.pipeline_stage_id !== stageUndo.target_stage_id || lead.status !== stageUndo.target_status)) {
        throw httpError(409,"Não é possível desfazer após alterações concorrentes");
      }
      for (const item of stageUndo.items) {
        await client.query(
          "UPDATE scheduling_leads SET status=$3,pipeline_stage_id=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2",
          [tenantId,item.id,item.previous_status,item.previous_stage_id]
        );
        await client.query(
          `INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,previous_status,new_status,details)
           VALUES($1,$2,'bulk_pipeline_undo',$3,$4,$5)`,
          [item.id,tenantId,stageUndo.target_status,item.previous_status,{ previous_stage_id: stageUndo.target_stage_id, new_stage_id: item.previous_stage_id }]
        );
      }
    }
    const updated = await client.query<{ id: string; undone_at: string }>(
      "UPDATE bulk_operations SET undone_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,undone_at",
      [tenantId,operationId]
    );
    await insertAudit(client,tenantId,actor,"bulk_operation.undone","bulk_operation",operationId,{ action: operation.action });
    return { operation: updated.rows[0], result: { action: operation.action, undone: true } };
  });
  if (response.result.action === "assign") {
    const stored = await db.query<{ undo_payload: AssignUndo | null }>(
      "SELECT undo_payload FROM bulk_operations WHERE tenant_id=$1 AND id=$2",
      [tenantId, operationId]
    );
    const undo = stored.rows[0]?.undo_payload;
    if (undo?.action === "assign") {
      await Promise.allSettled(undo.items.map((item) =>
        refreshAppointmentGroupNotificationsForLead(tenantId, item.id)
      ));
    }
  }
  return response;
}
