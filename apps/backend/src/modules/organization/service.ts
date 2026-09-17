import type { PoolClient } from "pg";
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
  assigned_member_id: string | null;
  updated_at: string | Date;
};

type StageRow = {
  id: string;
  tenant_id: string;
  name: string;
  color: string;
  position: number;
  capacity_target: number | null;
  technical_status: LeadTechnicalStatus;
  is_default: boolean;
  archived_at: string | null;
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

async function pipelineEnforcesTransitions(client: PoolClient, tenantId: string) {
  const result = await client.query<{ pipeline_enforce_transitions: boolean | null }>(
    "SELECT pipeline_enforce_transitions FROM tenants WHERE id=$1 FOR SHARE",
    [tenantId]
  );
  if (!result.rows[0]) throw httpError(404,"Tenant não encontrado");
  // Somente `false` explícito libera sequência. Ausência/null falha fechado.
  return result.rows[0].pipeline_enforce_transitions !== false;
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
  const result = await client.query<LeadRow>(
    `SELECT id,status,pipeline_stage_id,assigned_member_id,updated_at
     FROM scheduling_leads
     WHERE tenant_id=$1 AND id=$2
       AND ($3::boolean OR assigned_member_id=$4)
     ${lock ? "FOR UPDATE" : ""}`,
    [tenantId,leadId,access.workspaceWide,access.memberId]
  );
  if (!result.rows[0]) throw httpError(404, "Lead não encontrado");
  return result.rows[0];
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

export async function loadPipeline(tenantId: string, includeArchived = false) {
  const [stages,transitions,followUpSettings,pipelineMode,members] = await Promise.all([
    db.query<StageRow & { lead_count: number; created_at: string; updated_at: string }>(
      `SELECT stage.id,stage.name,stage.color,stage.position,stage.capacity_target,
              stage.technical_status,stage.is_default,stage.archived_at,
              count(lead.id)::int lead_count,stage.created_at,stage.updated_at
       FROM pipeline_stages stage
       LEFT JOIN scheduling_leads lead
         ON lead.tenant_id=stage.tenant_id AND lead.pipeline_stage_id=stage.id
       WHERE stage.tenant_id=$1 AND ($2::boolean OR stage.archived_at IS NULL)
       GROUP BY stage.id
       ORDER BY stage.archived_at NULLS FIRST,stage.position,stage.id`,
      [tenantId,includeArchived]
    ),
    db.query(
      `SELECT transition.from_stage_id,transition.to_stage_id
       FROM pipeline_transitions transition
       JOIN pipeline_stages source ON source.id=transition.from_stage_id AND source.tenant_id=transition.tenant_id
       JOIN pipeline_stages target ON target.id=transition.to_stage_id AND target.tenant_id=transition.tenant_id
       WHERE transition.tenant_id=$1
         AND ($2::boolean OR (source.archived_at IS NULL AND target.archived_at IS NULL))
       ORDER BY transition.from_stage_id,transition.to_stage_id`,
      [tenantId,includeArchived]
    ),
    db.query<{ enabled: boolean; max_count: number }>(
      `SELECT ai_follow_up_enabled enabled,
              cardinality(ai_follow_up_delays_minutes)::int max_count
       FROM tenant_ai_settings
       WHERE tenant_id=$1`,
      [tenantId]
    ),
    db.query<{ pipeline_enforce_transitions: boolean | null }>(
      "SELECT pipeline_enforce_transitions FROM tenants WHERE id=$1",
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
  if (!pipelineMode.rows[0]) throw httpError(404,"Tenant não encontrado");
  return {
    stages: stages.rows.map((stage) => ({
      ...stage,
      is_default_board: (DEFAULT_BOARD_STATUSES as readonly string[]).includes(stage.technical_status)
    })),
    transitions: transitions.rows,
    members: members.rows,
    follow_up_config: followUpSettings.rows[0] ?? { enabled: false, max_count: 0 },
    enforce_transitions: pipelineMode.rows[0].pipeline_enforce_transitions !== false
  };
}

export async function updatePipelineSettings(
  tenantId: string,
  actor: OrganizationActor,
  input: { enforce_transitions: boolean }
) {
  return withTransaction(async (client) => {
    const current = await client.query<{ pipeline_enforce_transitions: boolean | null }>(
      "SELECT pipeline_enforce_transitions FROM tenants WHERE id=$1 FOR UPDATE",
      [tenantId]
    );
    if (!current.rows[0]) throw httpError(404,"Tenant não encontrado");
    await client.query(
      "UPDATE tenants SET pipeline_enforce_transitions=$2 WHERE id=$1",
      [tenantId,input.enforce_transitions]
    );
    await insertAudit(client,tenantId,actor,"pipeline.settings.updated","tenant",tenantId,{
      enforce_transitions: input.enforce_transitions,
      previous_enforce_transitions: current.rows[0].pipeline_enforce_transitions
    });
    return { enforce_transitions: input.enforce_transitions };
  });
}

async function setDefaultStage(client: PoolClient, tenantId: string, stage: StageRow) {
  await client.query(
    `UPDATE pipeline_stages SET is_default=false,updated_at=now()
     WHERE tenant_id=$1 AND technical_status=$2 AND id<>$3 AND is_default`,
    [tenantId,stage.technical_status,stage.id]
  );
  await client.query("UPDATE pipeline_stages SET is_default=true,updated_at=now() WHERE tenant_id=$1 AND id=$2",[tenantId,stage.id]);
}

export async function createPipelineStage(tenantId: string, actor: OrganizationActor, input: StageCreateInput) {
  try {
    return await withTransaction(async (client) => {
      const result = await client.query<StageRow>(
        `INSERT INTO pipeline_stages(
           tenant_id,name,color,position,capacity_target,technical_status,is_default,created_by_user_id
         ) VALUES($1,$2,$3,$4,$5,$6,false,$7)
         RETURNING *`,
        [tenantId,input.name,input.color,input.position,input.capacity_target ?? null,input.technical_status,actor.userId]
      );
      if (input.is_default) await setDefaultStage(client,tenantId,result.rows[0]);
      await insertAudit(client,tenantId,actor,"pipeline_stage.created","pipeline_stage",result.rows[0].id,{ technicalStatus: input.technical_status });
      return { ...result.rows[0], is_default: input.is_default };
    });
  } catch (error) {
    databaseError(error,"Já existe uma etapa ativa com esse nome");
  }
}

export async function updatePipelineStage(tenantId: string, stageId: string, actor: OrganizationActor, input: StageUpdateInput) {
  try {
    return await withTransaction(async (client) => {
      const current = await client.query<StageRow & { lead_count: number }>(
        `SELECT stage.*,
                (SELECT count(*)::int FROM scheduling_leads lead
                 WHERE lead.tenant_id=stage.tenant_id AND lead.pipeline_stage_id=stage.id) lead_count
         FROM pipeline_stages stage
         WHERE stage.tenant_id=$1 AND stage.id=$2 AND stage.archived_at IS NULL
         FOR UPDATE`,
        [tenantId,stageId]
      );
      const stage = current.rows[0];
      if (!stage) throw httpError(404,"Etapa não encontrada");
      if (input.technical_status && input.technical_status !== stage.technical_status && stage.is_default) {
        throw httpError(409,"Defina outra etapa padrão para este status antes de alterar o mapeamento técnico");
      }
      if (input.technical_status && input.technical_status !== stage.technical_status && stage.lead_count > 0) {
        throw httpError(409,"Não é possível alterar o status técnico de uma etapa em uso");
      }
      const result = await client.query<StageRow>(
        `UPDATE pipeline_stages SET
           name=$3,color=$4,position=$5,capacity_target=$6,technical_status=$7,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [tenantId,stageId,input.name ?? stage.name,input.color ?? stage.color,input.position ?? stage.position,
          input.capacity_target === undefined ? stage.capacity_target : input.capacity_target,
          input.technical_status ?? stage.technical_status]
      );
      if (input.is_default === true) await setDefaultStage(client,tenantId,result.rows[0]);
      if (input.is_default === false && stage.is_default) throw httpError(409,"Selecione outra etapa padrão antes de remover esta configuração");
      await insertAudit(client,tenantId,actor,"pipeline_stage.updated","pipeline_stage",stageId,{ before: stage, after: result.rows[0] });
      return { ...result.rows[0], is_default: input.is_default === true ? true : stage.is_default };
    });
  } catch (error) {
    databaseError(error,"Já existe uma etapa ativa com esse nome");
  }
}

export async function archivePipelineStage(
  tenantId: string,
  stageId: string,
  replacementStageId: string | undefined,
  actor: OrganizationActor
) {
  return withTransaction(async (client) => {
    const current = await client.query<StageRow & { lead_count: number }>(
      `SELECT stage.*,
              (SELECT count(*)::int FROM scheduling_leads lead
               WHERE lead.tenant_id=stage.tenant_id AND lead.pipeline_stage_id=stage.id) lead_count
       FROM pipeline_stages stage
       WHERE stage.tenant_id=$1 AND stage.id=$2 AND stage.archived_at IS NULL
       FOR UPDATE`,
      [tenantId,stageId]
    );
    const stage = current.rows[0];
    if (!stage) throw httpError(404,"Etapa não encontrada");
    let replacement: StageRow | undefined;
    if (replacementStageId) {
      replacement = (await client.query<StageRow>(
        "SELECT * FROM pipeline_stages WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE",
        [tenantId,replacementStageId]
      )).rows[0];
      if (!replacement || replacement.id === stage.id) throw httpError(400,"Etapa substituta inválida");
      if (replacement.technical_status !== stage.technical_status) throw httpError(409,"A substituta deve mapear para o mesmo status técnico");
    }
    if ((stage.lead_count > 0 || stage.is_default) && !replacement) {
      throw httpError(409,"Selecione uma etapa substituta");
    }
    if (replacement) {
      await client.query(
        "UPDATE scheduling_leads SET pipeline_stage_id=$3,updated_at=now() WHERE tenant_id=$1 AND pipeline_stage_id=$2",
        [tenantId,stageId,replacement.id]
      );
      if (stage.is_default) await setDefaultStage(client,tenantId,replacement);
    }
    await client.query("DELETE FROM pipeline_transitions WHERE tenant_id=$1 AND (from_stage_id=$2 OR to_stage_id=$2)",[tenantId,stageId]);
    await client.query("UPDATE pipeline_stages SET archived_at=now(),is_default=false,updated_at=now() WHERE tenant_id=$1 AND id=$2",[tenantId,stageId]);
    await insertAudit(client,tenantId,actor,"pipeline_stage.archived","pipeline_stage",stageId,{ replacementStageId: replacement?.id ?? null, movedLeads: stage.lead_count });
    return { id: stageId, archived: true, replacement_stage_id: replacement?.id ?? null, moved_leads: stage.lead_count };
  });
}

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
      if (!target) throw httpError(400,"Etapa de destino inválida");
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
  // Modo livre dispensa somente os dois grafos de sequência. Payload
  // comercial, escopo, locks, tenant e invariantes do banco continuam ativos.
  if (enforceTransitions && !domainAllowsStageTransition(lead.status,target.technical_status)) {
    throw httpError(409,`Transição proibida pelo domínio: ${lead.status} -> ${target.technical_status}`);
  }
  if (enforceTransitions && lead.pipeline_stage_id !== target.id && requireConfiguredTransition) {
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
  }
  await client.query(
    `INSERT INTO scheduling_lead_events(
       lead_id,tenant_id,event_type,previous_status,new_status,details,actor_user_id
     ) VALUES($1,$2,'pipeline_stage_updated',$3,$4,$5,$6)`,
    [lead.id,tenantId,lead.status,target.technical_status,{ previous_stage_id: lead.pipeline_stage_id, new_stage_id: target.id },actor.userId]
  );
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
    const enforceTransitions = await pipelineEnforcesTransitions(client,tenantId);
    if (expectedUpdatedAt && serializedDate(lead.updated_at) !== serializedDate(expectedUpdatedAt)) throw httpError(409,"Lead alterado por outra operação");
    const target = (await client.query<StageRow>(
      "SELECT * FROM pipeline_stages WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL",
      [tenantId,stageId]
    )).rows[0];
    if (!target) throw httpError(404,"Etapa não encontrada");
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
  const enforceTransitions = await pipelineEnforcesTransitions(client,tenantId);
  const ids = input.items.map((item) => item.id);
  const leads = await client.query<LeadRow>(
    `SELECT id,status,pipeline_stage_id,assigned_member_id,updated_at
     FROM scheduling_leads
     WHERE tenant_id=$1 AND id=ANY($2::uuid[])
       AND ($3::boolean OR assigned_member_id=$4)
     ${lock ? "FOR UPDATE" : ""}`,
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
      const transitionPairs = leads.rows.filter((lead) => lead.pipeline_stage_id !== targetStage?.id);
      const transitions = enforceTransitions ? await client.query<{ from_stage_id: string }>(
        `SELECT from_stage_id FROM pipeline_transitions
         WHERE tenant_id=$1 AND to_stage_id=$2 AND from_stage_id=ANY($3::uuid[])`,
        [tenantId,targetStage.id,transitionPairs.map((lead) => lead.pipeline_stage_id)]
      ) : { rows: [] as Array<{ from_stage_id: string }> };
      const configured = new Set(transitions.rows.map((row) => row.from_stage_id));
      for (const lead of transitionPairs) {
        if (enforceTransitions && !domainAllowsStageTransition(lead.status,targetStage.technical_status)) {
          errors.push({ id: lead.id, code: "domain_transition", message: `Transição técnica proibida: ${lead.status} -> ${targetStage.technical_status}` });
        } else if (enforceTransitions && !configured.has(lead.pipeline_stage_id)) {
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
