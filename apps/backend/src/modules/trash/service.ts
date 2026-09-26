import { PoolClient } from "pg";
import { z } from "zod";
import { db } from "../../db/client.js";
import { httpError, withTransaction } from "../scheduling/service.js";
import type { WorkspaceSession } from "../../auth/session.js";

// Lixeira de contatos (migration 0171; contrato "Lixeira" do
// specs/active/v6-evolucao-estrutural-atendon.md). O DELETE de contato em
// /scheduling/leads/:id virou soft delete (deleted_at/deleted_by); aqui ficam
// a listagem keyset, a restauração e a exclusão definitiva — que reproduz a
// limpeza do hard delete anterior (appointments RESTRICT, conversations
// RESTRICT e usage_logs), mantendo tarefas/valores personalizados coerentes
// via FK (SET NULL/CASCADE).

export const trashListQuerySchema = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30)
}).strict();

type TrashActor = Pick<WorkspaceSession, "userId" | "actorScope"> & { ipAddress?: string; userAgent?: string };

type TrashedLeadRow = {
  id: string;
  tenant_id: string;
  name: string | null;
  phone: string;
  status: string;
  deleted_at: Date;
  deleted_by: string | null;
  deleter_name: string | null;
  created_at: Date;
};

function encodeCursor(row: { deleted_at: Date; id: string }) {
  return Buffer.from(JSON.stringify({ v: 1, deleted_at: new Date(row.deleted_at).toISOString(), id: row.id }))
    .toString("base64url");
}

function decodeCursor(value: string) {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.v !== 1 || typeof parsed.id !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.id)) throw new Error();
    if (typeof parsed.deleted_at !== "string" || Number.isNaN(Date.parse(parsed.deleted_at))) throw new Error();
    return { deletedAt: parsed.deleted_at, id: parsed.id };
  } catch {
    throw httpError(400, "Cursor inválido");
  }
}

function mapTrashedLead(row: TrashedLeadRow) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    status: row.status,
    deleted_at: row.deleted_at,
    deleted_by: row.deleted_by ? { id: row.deleted_by, name: row.deleter_name } : null,
    created_at: row.created_at
  };
}

async function insertTrashAudit(client: PoolClient, tenantId: string, leadId: string, actor: TrashActor, action: string, metadata: Record<string, unknown>) {
  await client.query(
    `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
     VALUES($1,$2,$3,$4,'scheduling_lead',$5,$6,$7,$8)`,
    [actor.userId, tenantId, actor.actorScope, action, leadId, metadata, actor.ipAddress ?? null, actor.userAgent ?? null]
  );
}

export async function listTrashedLeads(
  session: WorkspaceSession,
  query: z.infer<typeof trashListQuerySchema>
) {
  const values: unknown[] = [];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const where = [`lead.tenant_id=${bind(session.tenantId)}`, "lead.deleted_at IS NOT NULL"];
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    where.push(`(lead.deleted_at,lead.id)<(${bind(cursor.deletedAt)}::timestamptz,${bind(cursor.id)}::uuid)`);
  }
  const limit = bind(query.limit + 1);
  const result = await db.query<TrashedLeadRow>(
    `SELECT lead.id,lead.tenant_id,lead.name,lead.phone,lead.status,
            lead.deleted_at,lead.deleted_by,deleter.name deleter_name,lead.created_at
     FROM scheduling_leads lead
     LEFT JOIN users deleter ON deleter.id=lead.deleted_by
     WHERE ${where.join(" AND ")}
     ORDER BY lead.deleted_at DESC,lead.id DESC
     LIMIT ${limit}`,
    values
  );
  const hasMore = result.rows.length > query.limit;
  const pageRows = hasMore ? result.rows.slice(0, query.limit) : result.rows;
  const lastRow = pageRows.at(-1);
  return {
    items: pageRows.map(mapTrashedLead),
    page: {
      limit: query.limit,
      has_more: hasMore,
      next_cursor: hasMore && lastRow ? encodeCursor(lastRow) : null
    }
  };
}

export async function restoreTrashedLead(
  session: WorkspaceSession,
  leadId: string,
  actor: TrashActor
) {
  return withTransaction(async (client) => {
    const restored = await client.query(
      `UPDATE scheduling_leads
       SET deleted_at=NULL,deleted_by=NULL,updated_at=now()
       WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NOT NULL
       RETURNING id`,
      [session.tenantId, leadId]
    );
    if (!restored.rows[0]) throw httpError(404, "Lead não encontrado na lixeira");
    await insertTrashAudit(client, session.tenantId, leadId, actor, "trash.restore", {});
    return { id: leadId, restored: true };
  });
}

export async function purgeTrashedLead(
  session: WorkspaceSession,
  leadId: string,
  actor: TrashActor
) {
  return withTransaction(async (client) => {
    const lead = await client.query(
      "SELECT id FROM scheduling_leads WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NOT NULL FOR UPDATE",
      [session.tenantId, leadId]
    );
    if (!lead.rows[0]) throw httpError(404, "Lead não encontrado na lixeira");
    // Eventos do Google Calendar (0185): o FK CASCADE apagaria o vínculo e a
    // outbox com o evento remoto ainda vivo — órfão no Google. Mesma proteção
    // da exclusão individual de agendamento (deleteAppointment): o lock da
    // outbox trava o claim do worker e o lock do agendamento trava o INSERT
    // do vínculo; vínculo confirmado ou claim em voo bloqueiam o purge.
    const linked = await client.query(
      `SELECT a.id
       FROM scheduling_appointments a
       JOIN scheduling_appointment_calendar_events e
         ON e.tenant_id=a.tenant_id AND e.appointment_id=a.id
       WHERE a.tenant_id=$1 AND a.lead_id=$2
       FOR UPDATE OF a`,
      [session.tenantId, leadId]
    );
    const syncOutbox = await client.query<{ claimed_at: Date | null }>(
      `SELECT o.claimed_at
       FROM scheduling_calendar_sync_outbox o
       JOIN scheduling_appointments a
         ON a.tenant_id=o.tenant_id AND a.id=o.appointment_id
       WHERE a.tenant_id=$1 AND a.lead_id=$2
       FOR UPDATE OF o`,
      [session.tenantId, leadId]
    );
    if (linked.rows[0] || syncOutbox.rows.some((row) => row.claimed_at != null)) {
      throw httpError(409, "Exclua os agendamentos do Google Calendar do lead (ou aguarde a sincronização) antes de excluir definitivamente");
    }
    // Mesma sequência do hard delete que existia antes da lixeira:
    // usage_logs perde a referência; appointments e conversations (RESTRICT)
    // são removidos antes do lead. Tarefas e valores personalizados seguem
    // as FKs (tasks SET NULL; lead_custom_values CASCADE).
    await client.query(
      `UPDATE usage_logs SET conversation_id=NULL
       WHERE tenant_id=$1 AND conversation_id IN (SELECT id FROM conversations WHERE tenant_id=$1 AND lead_id=$2)`,
      [session.tenantId, leadId]
    );
    // Outbox de confirmação de reunião (0127) referencia appointments e
    // conversations. A FK de appointments virou CASCADE (0131), mas a de
    // conversations continua restritiva — sem a limpeza explícita abaixo o
    // DELETE de conversations do lead explode com confirmação pendente.
    await client.query(
      `DELETE FROM scheduling_meeting_confirmation_outbox
       WHERE tenant_id=$1 AND (
         appointment_id IN (SELECT id FROM scheduling_appointments WHERE tenant_id=$1 AND lead_id=$2)
         OR conversation_id IN (SELECT id FROM conversations WHERE tenant_id=$1 AND lead_id=$2)
       )`,
      [session.tenantId, leadId]
    );
    await client.query("DELETE FROM scheduling_appointments WHERE tenant_id=$1 AND lead_id=$2", [session.tenantId, leadId]);
    await client.query("DELETE FROM conversations WHERE tenant_id=$1 AND lead_id=$2", [session.tenantId, leadId]);
    // Notas internas (0167) apontam o lead por context_id genérico, sem FK:
    // sem isto, nota órfã sobreviveria ao purge. flow_execution_log fica —
    // é histórico imutável e não quebra nada com o lead apagado.
    await client.query("DELETE FROM internal_notes WHERE tenant_id=$1 AND context_type='lead' AND context_id=$2", [session.tenantId, leadId]);
    await client.query("DELETE FROM scheduling_leads WHERE tenant_id=$1 AND id=$2", [session.tenantId, leadId]);
    await insertTrashAudit(client, session.tenantId, leadId, actor, "trash.purge", {});
    return { id: leadId, purged: true };
  });
}
