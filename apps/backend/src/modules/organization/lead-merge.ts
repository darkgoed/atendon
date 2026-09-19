import type { PoolClient } from "pg";
import { db } from "../../db/client.js";
import { httpError, withTransaction } from "../scheduling/service.js";

/**
 * B5 Merge de contatos (specs/active/v7-port-crm-whatsapp.md, ONDA 2, R11).
 *
 * Regras da spec:
 * - Mesmo telefone NORMALIZADO = fluxo normal; telefone diferente SÓ com
 *   confirmação explícita no payload (`confirmations.different_phone`).
 * - JAMAIS merge por nome — o nome não participa de nenhuma decisão.
 * - Transação única move FKs para o target: conversas, tarefas, notas
 *   (scheduling_lead_notes + internal_notes de lead), tags, posições de
 *   pipeline (campo do próprio lead), custom values, agendamentos, flow
 *   states (lead_qualifications), log de execução, eventos de lead e carteira
 *   de pós-venda. Histórico de conversas/mensagens segue a conversa (nada é
 *   perdido).
 * - audit() com ator e ambos os ids; source fica soft-deleted
 *   (`deleted_at`, R17) apontando `merged_into_id` para o target.
 * - UNIQUE(tenant_id,phone) preservada: nenhuma linha é copiada por cima do
 *   target — o source mantém o próprio telefone e sai das leituras padrão
 *   pelo `deleted_at IS NULL`.
 *
 * Conflitos de destino (target já tem tag/valor/estado) resolvidos com
 * "target vence": a linha do source que conflita é descartada, nunca sobrescreve
 * o principal escolhido no diálogo de merge.
 */

export type LeadMergeActor = {
  userId: string;
  actorScope: "root" | "workspace";
  ipAddress?: string;
  userAgent?: string;
};

export type MergeConflicts = {
  conversations: number;
  tasks: number;
  tags: number;
  pipeline_positions: number;
  notes: number;
  custom_fields: number;
  appointments: number;
};

export type MergePreflight = {
  source_id: string;
  target_id: string;
  same_normalized_phone: boolean;
  conflicts: MergeConflicts;
};

export type MergeInput = {
  sourceId: string;
  targetId: string;
  confirmations?: { different_phone?: boolean };
};

export type MergeResult = {
  source: { id: string; merged_into_id: string | null; deleted_at: string | null };
  target: { id: string; phone: string; name: string | null; updated_at: string };
  same_normalized_phone: boolean;
  moved: Record<string, number>;
};

export function normalizePhone(value: string): string {
  return value.replace(/\D/g, "");
}

type LeadMergeRow = {
  id: string;
  phone: string;
  name: string | null;
  pipeline_stage_id: string;
  merged_into_id: string | null;
  deleted_at: Date | string | null;
};

async function loadMergeableLead(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  leadId: string
): Promise<LeadMergeRow> {
  const result = await client.query<LeadMergeRow>(
    `SELECT id,phone,name,pipeline_stage_id,merged_into_id,deleted_at
     FROM scheduling_leads
     WHERE tenant_id=$1 AND id=$2
     FOR UPDATE`,
    [tenantId, leadId]
  );
  const lead = result.rows[0];
  if (!lead) throw httpError(404, "Contato não encontrado");
  if (lead.merged_into_id || lead.deleted_at) {
    throw Object.assign(new Error("Este contato já foi mesclado ou está na lixeira"), {
      statusCode: 409,
      code: "LEAD_ALREADY_MERGED"
    });
  }
  return lead;
}

export async function preflightLeadMerge(
  tenantId: string,
  sourceId: string,
  targetId: string
): Promise<MergePreflight> {
  if (sourceId === targetId) throw httpError(400, "Selecione dois contatos diferentes");
  const result = await db.query<{
    id: string;
    phone: string;
    name: string | null;
    pipeline_stage_id: string;
    merged_into_id: string | null;
    deleted_at: Date | string | null;
    conversations: string;
    tasks: string;
    tags: string;
    notes: string;
    custom_fields: string;
    appointments: string;
  }>(
    `WITH
       conversations_count AS (
         SELECT count(*)::text n FROM conversations
         WHERE tenant_id=$1 AND lead_id=$2
       ),
       tasks_count AS (
         SELECT count(*)::text n FROM tasks
         WHERE tenant_id=$1 AND lead_id=$2
       ),
       tags_count AS (
         SELECT count(*)::text n FROM lead_tag_assignments
         WHERE tenant_id=$1 AND lead_id=$2
       ),
       notes_count AS (
         SELECT ((SELECT count(*)::text FROM scheduling_lead_notes WHERE tenant_id=$1 AND lead_id=$2)
              || '|' ||
                (SELECT count(*)::text FROM internal_notes WHERE tenant_id=$1 AND context_type='lead' AND context_id=$2)) AS n
       ),
       custom_values_count AS (
         SELECT count(*)::text n
         FROM lead_custom_values cv
         JOIN custom_field_defs fd ON fd.id=cv.field_id
         WHERE fd.tenant_id=$1 AND cv.lead_id=$2
       ),
       appointments_count AS (
         SELECT count(*)::text n FROM scheduling_appointments
         WHERE tenant_id=$1 AND lead_id=$2
       )
     SELECT lead.id,lead.phone,lead.name,lead.pipeline_stage_id,lead.merged_into_id,lead.deleted_at,
            conversations_count.n conversations,
            tasks_count.n tasks,
            tags_count.n tags,
            notes_count.n notes,
            custom_values_count.n custom_fields,
            appointments_count.n appointments
     FROM scheduling_leads lead,
          conversations_count,tasks_count,tags_count,notes_count,custom_values_count,appointments_count
     WHERE lead.tenant_id=$1 AND lead.id=$2`,
    [tenantId, sourceId]
  );
  const source = result.rows[0];
  if (!source) throw httpError(404, "Contato não encontrado");
  const target = await db.query<{ phone: string; pipeline_stage_id: string }>(
    "SELECT phone,pipeline_stage_id FROM scheduling_leads WHERE tenant_id=$1 AND id=$2",
    [tenantId, targetId]
  );
  if (!target.rows[0]) throw httpError(404, "Contato não encontrado");
  const [sourceNotes, targetNotes] = source.notes.split("|");
  return {
    source_id: source.id,
    target_id: targetId,
    same_normalized_phone: normalizePhone(source.phone) === normalizePhone(target.rows[0].phone),
    conflicts: {
      conversations: Number(source.conversations),
      tasks: Number(source.tasks),
      tags: Number(source.tags),
      pipeline_positions: source.pipeline_stage_id !== target.rows[0].pipeline_stage_id ? 1 : 0,
      notes: Number(sourceNotes ?? "0") + Number(targetNotes ?? "0"),
      custom_fields: Number(source.custom_fields),
      appointments: Number(source.appointments)
    }
  };
}

export async function mergeLeads(
  tenantId: string,
  input: MergeInput,
  actor: LeadMergeActor
): Promise<MergeResult> {
  if (input.sourceId === input.targetId) throw httpError(400, "Selecione dois contatos diferentes");

  const moved = await withTransaction(async (client) => {
    const source = await loadMergeableLead(client, tenantId, input.sourceId);
    const target = await loadMergeableLead(client, tenantId, input.targetId);

    const sameNormalizedPhone = normalizePhone(source.phone) === normalizePhone(target.phone);
    if (!sameNormalizedPhone && input.confirmations?.different_phone !== true) {
      throw Object.assign(
        new Error("Telefones diferentes: confirme explicitamente a mesclagem entre contatos distintos"),
        { statusCode: 400, code: "PHONE_MISMATCH" }
      );
    }

    const conversations = await client.query(
      "UPDATE conversations SET lead_id=$3 WHERE tenant_id=$1 AND lead_id=$2",
      [tenantId, source.id, target.id]
    );
    const tasks = await client.query(
      "UPDATE tasks SET lead_id=$3 WHERE tenant_id=$1 AND lead_id=$2",
      [tenantId, source.id, target.id]
    );
    const leadNotes = await client.query(
      "UPDATE scheduling_lead_notes SET lead_id=$3 WHERE tenant_id=$1 AND lead_id=$2",
      [tenantId, source.id, target.id]
    );
    const internalNotes = await client.query(
      `UPDATE internal_notes
       SET context_id=$3
       WHERE tenant_id=$1 AND context_type='lead' AND context_id=$2`,
      [tenantId, source.id, target.id]
    );
    // Tags: target vence quando já tem a mesma etiqueta.
    await client.query(
      `UPDATE lead_tag_assignments assignment
       SET lead_id=$3
       WHERE assignment.tenant_id=$1 AND assignment.lead_id=$2
         AND NOT EXISTS (
           SELECT 1 FROM lead_tag_assignments existing
           WHERE existing.tenant_id=$1 AND existing.lead_id=$3 AND existing.tag_id=assignment.tag_id
         )`,
      [tenantId, source.id, target.id]
    );
    const tags = await client.query(
      `DELETE FROM lead_tag_assignments
       WHERE tenant_id=$1 AND lead_id=$2
       RETURNING 1 AS moved`,
      [tenantId, source.id]
    );
    // Valores personalizados: target vence quando já tem valor no mesmo campo.
    await client.query(
      `UPDATE lead_custom_values cv
       SET lead_id=$3
       FROM custom_field_defs fd
       WHERE cv.field_id=fd.id
         AND fd.tenant_id=$1
         AND cv.lead_id=$2
         AND NOT EXISTS (
           SELECT 1 FROM lead_custom_values existing
           WHERE existing.field_id=cv.field_id AND existing.lead_id=$3
         )`,
      [tenantId, source.id, target.id]
    );
    const customValues = await client.query(
      `DELETE FROM lead_custom_values cv
       USING custom_field_defs fd
       WHERE cv.field_id=fd.id
         AND fd.tenant_id=$1 AND cv.lead_id=$2
       RETURNING 1 AS moved`,
      [tenantId, source.id]
    );
    const appointments = await client.query(
      `UPDATE scheduling_appointments
       SET lead_id=$3,updated_at=now()
       WHERE tenant_id=$1 AND lead_id=$2`,
      [tenantId, source.id, target.id]
    );
    // Flow states: target vence (target já em fluxo → estado do source descartado).
    await client.query(
      `UPDATE lead_qualifications qualification
       SET lead_id=$3
       WHERE qualification.tenant_id=$1 AND qualification.lead_id=$2
         AND NOT EXISTS (
           SELECT 1 FROM lead_qualifications existing
           WHERE existing.tenant_id=$1 AND existing.lead_id=$3
         )`,
      [tenantId, source.id, target.id]
    );
    const flowStates = await client.query(
      "DELETE FROM lead_qualifications WHERE tenant_id=$1 AND lead_id=$2 RETURNING 1 AS moved",
      [tenantId, source.id]
    );
    const flowLog = await client.query(
      "UPDATE flow_execution_log SET lead_id=$3 WHERE tenant_id=$1 AND lead_id=$2",
      [tenantId, source.id, target.id]
    );
    const leadEvents = await client.query(
      `UPDATE scheduling_lead_events
       SET lead_id=$3
       WHERE tenant_id=$1 AND lead_id=$2`,
      [tenantId, source.id, target.id]
    );
    const postSales = await client.query(
      "UPDATE post_sale_clients SET lead_id=$3 WHERE tenant_id=$1 AND lead_id=$2",
      [tenantId, source.id, target.id]
    );

    const softDeleted = await client.query<{ id: string; deleted_at: Date | null }>(
      `UPDATE scheduling_leads
       SET merged_into_id=$3,deleted_at=COALESCE(deleted_at,now()),updated_at=now()
       WHERE tenant_id=$1 AND id=$2
       RETURNING id,deleted_at`,
      [tenantId, source.id, target.id]
    );
    if (!softDeleted.rows[0]) throw httpError(404, "Contato não encontrado");

    const counts = {
      conversations: conversations.rowCount ?? 0,
      tasks: tasks.rowCount ?? 0,
      notes: (leadNotes.rowCount ?? 0) + (internalNotes.rowCount ?? 0),
      tags: tags.rowCount ?? 0,
      custom_values: customValues.rowCount ?? 0,
      appointments: appointments.rowCount ?? 0,
      flow_states: flowStates.rowCount ?? 0,
      flow_log: flowLog.rowCount ?? 0,
      lead_events: leadEvents.rowCount ?? 0,
      post_sales: postSales.rowCount ?? 0
    };

    await client.query(
      `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
       VALUES($1,$2,$3,'leads.merged','scheduling_lead',$4,$5,$6,$7)`,
      [
        actor.userId,
        tenantId,
        actor.actorScope,
        target.id,
        {
          source_id: source.id,
          target_id: target.id,
          same_normalized_phone: sameNormalizedPhone,
          confirmed_different_phone: !sameNormalizedPhone,
          source_phone: source.phone,
          target_phone: target.phone,
          moved: counts
        },
        actor.ipAddress ?? null,
        actor.userAgent ?? null
      ]
    );
    return { counts, softDeleted: softDeleted.rows[0], sameNormalizedPhone };
  });

  // Leitura de retorno DEPOIS do commit (padrão da casa).
  const [freshSource, freshTarget] = await Promise.all([
    db.query<{ id: string; merged_into_id: string | null; deleted_at: Date | null }>(
      "SELECT id,merged_into_id,deleted_at FROM scheduling_leads WHERE tenant_id=$1 AND id=$2",
      [tenantId, input.sourceId]
    ),
    db.query<{ id: string; phone: string; name: string | null; updated_at: Date }>(
      "SELECT id,phone,name,updated_at FROM scheduling_leads WHERE tenant_id=$1 AND id=$2",
      [tenantId, input.targetId]
    )
  ]);
  if (!freshSource.rows[0] || !freshTarget.rows[0]) {
    throw Object.assign(new Error("Mesclagem registrada, mas leitura de retorno falhou"), { statusCode: 500 });
  }
  return {
    source: {
      id: freshSource.rows[0].id,
      merged_into_id: freshSource.rows[0].merged_into_id,
      deleted_at: freshSource.rows[0].deleted_at ? new Date(freshSource.rows[0].deleted_at).toISOString() : null
    },
    target: {
      id: freshTarget.rows[0].id,
      phone: freshTarget.rows[0].phone,
      name: freshTarget.rows[0].name,
      updated_at: new Date(freshTarget.rows[0].updated_at).toISOString()
    },
    same_normalized_phone: moved.sameNormalizedPhone,
    moved: moved.counts
  };
}
