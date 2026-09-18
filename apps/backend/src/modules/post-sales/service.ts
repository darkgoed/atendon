import type { Pool, PoolClient } from "pg";
import { db } from "../../db/client.js";
import { isFeatureFlagEnabled } from "../operations/feature-flags.js";
import type {
  PostSaleChecklistEntryUpdateInput,
  PostSaleClientCreateInput,
  PostSaleClientsQuery,
  PostSaleClientUpdateInput,
  PostSaleDebtsQuery,
  PostSaleTemplateOrderInput
} from "./schemas.js";

export type PostSaleActor = {
  userId: string;
  actorScope: "root" | "workspace";
  ipAddress?: string;
  userAgent?: string;
};

type Queryable = Pool | PoolClient;
type PortfolioRow = Record<string, unknown> & {
  id: string;
  updated_at: string | Date;
};

export class PostSaleConflictError extends Error {
  statusCode = 409;
  code = "POST_SALE_PHONE_CONFLICT";
  existingId: string;

  constructor(existingId: string) {
    super("Telefone já cadastrado no pós-venda");
    this.existingId = existingId;
  }
}

function httpError(statusCode: number, message: string, code?: string) {
  return Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) });
}

async function withTransaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertAudit(
  client: PoolClient,
  tenantId: string,
  actor: PostSaleActor,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: Record<string, unknown> = {}
) {
  await client.query(
    `INSERT INTO audit_logs(
       actor_user_id,workspace_id,actor_scope,action,resource_type,
       resource_id,metadata,ip_address,user_agent
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      actor.userId,
      tenantId,
      actor.actorScope,
      action,
      resourceType,
      resourceId,
      metadata,
      actor.ipAddress ?? null,
      actor.userAgent ?? null
    ]
  );
}

const portfolioCte = `portfolio AS (
  SELECT client.id,client.tenant_id,client.name,client.phone_e164,client.email,
         client.notes,client.responsible_member_id,client.next_action,
         client.next_action_at,client.origin,client.lead_id,client.archived_at,
         client.version,client.created_at,client.updated_at,
         COALESCE(responsible_user.name,responsible_user.email) responsible_name,
         responsible_user.email responsible_email,
         COALESCE(progress.total,0)::int checklist_total,
         COALESCE(progress.completed,0)::int checklist_completed,
         COALESCE(progress.accepted,0)::int checklist_accepted,
         CASE
           WHEN client.next_action_at IS NULL THEN 'none'
           WHEN (client.next_action_at AT TIME ZONE tenant.timezone)::date
                < (now() AT TIME ZONE tenant.timezone)::date THEN 'overdue'
           WHEN (client.next_action_at AT TIME ZONE tenant.timezone)::date
                = (now() AT TIME ZONE tenant.timezone)::date THEN 'today'
           ELSE 'upcoming'
         END next_action_queue
  FROM post_sale_clients client
  JOIN tenants tenant ON tenant.id=client.tenant_id
  LEFT JOIN workspace_members responsible
    ON responsible.id=client.responsible_member_id
   AND responsible.workspace_id=client.tenant_id
  LEFT JOIN users responsible_user ON responsible_user.id=responsible.user_id
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (
             WHERE item.archived_at IS NULL AND item.is_active
           )::int total,
           count(*) FILTER (
             WHERE item.archived_at IS NULL AND item.is_active
               AND entry.result <> 'pendente'
           )::int completed,
           count(*) FILTER (
             WHERE item.archived_at IS NULL AND item.is_active
               AND entry.result = 'aceito'
           )::int accepted
    FROM post_sale_client_checklist entry
    JOIN post_sale_checklist_items item
      ON item.id=entry.item_id AND item.tenant_id=entry.tenant_id
    WHERE entry.tenant_id=client.tenant_id AND entry.client_id=client.id
  ) progress ON true
)`;

const stateSql = `CASE
  WHEN archived_at IS NOT NULL THEN 'archived'
  WHEN next_action_queue='overdue' THEN 'action_overdue'
  WHEN checklist_total=0 OR checklist_completed=0 THEN 'not_started'
  WHEN checklist_completed=checklist_total THEN 'checklist_complete'
  ELSE 'in_progress'
END`;

function encodeCursor(row: PortfolioRow) {
  return Buffer.from(JSON.stringify({ updatedAt: new Date(row.updated_at).toISOString(), id: row.id }))
    .toString("base64url");
}

function decodeCursor(value: string) {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.updatedAt !== "string" || Number.isNaN(Date.parse(parsed.updatedAt))) throw new Error();
    if (typeof parsed.id !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.id)) throw new Error();
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    throw httpError(400, "Cursor inválido");
  }
}

export async function listPostSaleClients(tenantId: string, query: PostSaleClientsQuery) {
  const values: unknown[] = [tenantId];
  const where = ["tenant_id=$1"];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };

  if (query.archived === "active") where.push("archived_at IS NULL");
  if (query.archived === "archived") where.push("archived_at IS NOT NULL");
  if (query.q) {
    const parameter = bind(`%${query.q}%`);
    where.push(`(name ILIKE ${parameter} OR phone_e164 ILIKE ${parameter} OR COALESCE(email,'') ILIKE ${parameter})`);
  }
  if (query.responsible_member_id === "unassigned") where.push("responsible_member_id IS NULL");
  else if (query.responsible_member_id) where.push(`responsible_member_id=${bind(query.responsible_member_id)}`);
  if (query.next_action) where.push(`next_action_queue=${bind(query.next_action)}`);
  if (query.progress === "not_started") where.push("(checklist_total=0 OR checklist_completed=0)");
  if (query.progress === "in_progress") where.push("checklist_total>0 AND checklist_completed>0 AND checklist_completed<checklist_total");
  if (query.progress === "complete") where.push("checklist_total>0 AND checklist_completed=checklist_total");
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    const date = bind(cursor.updatedAt);
    const id = bind(cursor.id);
    where.push(`(updated_at,id)<(${date}::timestamptz,${id}::uuid)`);
  }
  const limit = bind(query.limit + 1);
  const result = await db.query<PortfolioRow>(
    `WITH ${portfolioCte}
     SELECT portfolio.*,
            ${stateSql} state,
            CASE WHEN checklist_total=0 THEN 0
                 ELSE round(checklist_completed::numeric * 100 / checklist_total)::int END progress_percent
     FROM portfolio
     WHERE ${where.join(" AND ")}
     ORDER BY updated_at DESC,id DESC
     LIMIT ${limit}`,
    values
  );
  const hasMore = result.rows.length > query.limit;
  const clients = hasMore ? result.rows.slice(0, query.limit) : result.rows;

  const summary = await db.query(
    `WITH ${portfolioCte}
     SELECT
       count(*) FILTER (WHERE archived_at IS NULL)::int active,
       count(*) FILTER (WHERE archived_at IS NOT NULL)::int archived,
       count(*) FILTER (WHERE archived_at IS NULL AND (checklist_total=0 OR checklist_completed=0))::int not_started,
       count(*) FILTER (WHERE archived_at IS NULL AND checklist_total>0 AND checklist_completed>0 AND checklist_completed<checklist_total)::int in_progress,
       count(*) FILTER (WHERE archived_at IS NULL AND checklist_total>0 AND checklist_completed=checklist_total)::int complete,
       count(*) FILTER (WHERE archived_at IS NULL AND next_action_queue='overdue')::int overdue,
       count(*) FILTER (WHERE archived_at IS NULL AND next_action_queue='today')::int today,
       count(*) FILTER (WHERE archived_at IS NULL AND next_action_queue='upcoming')::int upcoming
     FROM portfolio WHERE tenant_id=$1`,
    [tenantId]
  );
  return {
    summary: summary.rows[0],
    clients,
    next_cursor: hasMore && clients.length ? encodeCursor(clients.at(-1)!) : null
  };
}

export async function getPostSaleClient(tenantId: string, clientId: string, includeConversation: boolean) {
  const result = await db.query<PortfolioRow & { state: string }>(
    `WITH ${portfolioCte}
     SELECT portfolio.*,
            ${stateSql} state,
            CASE WHEN checklist_total=0 THEN 0
                 ELSE round(checklist_completed::numeric * 100 / checklist_total)::int END progress_percent
     FROM portfolio WHERE tenant_id=$1 AND id=$2`,
    [tenantId, clientId]
  );
  const client = result.rows[0];
  if (!client) throw httpError(404, "Cliente de pós-venda não encontrado");
  const checklist = await db.query(
    `SELECT entry.id,entry.result,entry.note,entry.version,entry.updated_at,
            entry.updated_by_user_id,
            item.id item_id,item.description,item.position,item.is_active,
            item.archived_at item_archived_at,item.version item_version,
            COALESCE(updated_user.name,updated_user.email) updated_by_name
     FROM post_sale_client_checklist entry
     JOIN post_sale_checklist_items item
       ON item.id=entry.item_id AND item.tenant_id=entry.tenant_id
     LEFT JOIN users updated_user ON updated_user.id=entry.updated_by_user_id
     WHERE entry.tenant_id=$1 AND entry.client_id=$2
     ORDER BY (item.archived_at IS NOT NULL),item.position,item.id`,
    [tenantId, clientId]
  );
  let conversationId: string | null | undefined;
  if (includeConversation) {
    conversationId = (await db.query<{ id: string }>(
      `SELECT conversation.id
       FROM conversations conversation
       WHERE conversation.tenant_id=$1
         AND (($3::uuid IS NOT NULL AND conversation.lead_id=$3)
              OR conversation.contact_phone=$2)
       ORDER BY (conversation.lead_id=$3) DESC,conversation.last_message_at DESC,conversation.id
       LIMIT 1`,
      [tenantId, client.phone_e164, client.lead_id ?? null]
    )).rows[0]?.id ?? null;
  }
  return {
    client: {
      ...client,
      ...(includeConversation ? { conversation_id: conversationId } : {})
    },
    checklist: checklist.rows
  };
}

async function assertResponsibleMember(client: Queryable, tenantId: string, memberId: string | null | undefined) {
  if (!memberId) return;
  const member = await client.query(
    "SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND id=$2 AND status='active'",
    [tenantId, memberId]
  );
  if (!member.rows[0]) throw httpError(400, "Responsável não pertence à empresa ou está inativo");
}

async function existingClientId(client: Queryable, tenantId: string, phone: string, leadId?: string | null) {
  return (await client.query<{ id: string }>(
    `SELECT id FROM post_sale_clients
     WHERE tenant_id=$1 AND (phone_e164=$2 OR ($3::uuid IS NOT NULL AND lead_id=$3))
     ORDER BY (phone_e164=$2) DESC LIMIT 1`,
    [tenantId, phone, leadId ?? null]
  )).rows[0]?.id;
}

async function copyTemplateToClient(client: PoolClient, tenantId: string, clientId: string) {
  await client.query(
    `INSERT INTO post_sale_client_checklist(tenant_id,client_id,item_id)
     SELECT $1,$2,item.id
     FROM post_sale_checklist_items item
     WHERE item.tenant_id=$1 AND item.archived_at IS NULL AND item.is_active
     ON CONFLICT DO NOTHING`,
    [tenantId, clientId]
  );
}

export async function createManualPostSaleClient(
  tenantId: string,
  actor: PostSaleActor,
  input: PostSaleClientCreateInput
) {
  return withTransaction(async (client) => {
    await assertResponsibleMember(client, tenantId, input.responsible_member_id);
    let leadId = input.lead_id ?? null;
    if (leadId) {
      const lead = await client.query<{ id: string }>(
        "SELECT id FROM scheduling_leads WHERE tenant_id=$1 AND id=$2 AND phone=$3 AND deleted_at IS NULL",
        [tenantId, leadId, input.phone_e164]
      );
      if (!lead.rows[0]) throw httpError(400, "O lead informado não corresponde ao telefone do cliente");
    } else {
      leadId = (await client.query<{ id: string }>(
        "SELECT id FROM scheduling_leads WHERE tenant_id=$1 AND phone=$2 AND deleted_at IS NULL LIMIT 1",
        [tenantId, input.phone_e164]
      )).rows[0]?.id ?? null;
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO post_sale_clients(
         tenant_id,name,phone_e164,email,notes,responsible_member_id,
         next_action,next_action_at,origin,lead_id,created_by_user_id,updated_by_user_id
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'manual',$9,$10,$10)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        tenantId,
        input.name,
        input.phone_e164,
        input.email ?? null,
        input.notes ?? null,
        input.responsible_member_id ?? null,
        input.next_action ?? null,
        input.next_action_at ? new Date(input.next_action_at) : null,
        leadId,
        actor.userId
      ]
    );
    if (!inserted.rows[0]) {
      const existingId = await existingClientId(client, tenantId, input.phone_e164, leadId);
      if (existingId) throw new PostSaleConflictError(existingId);
      throw httpError(409, "Cliente de pós-venda já cadastrado");
    }
    const id = inserted.rows[0].id;
    await copyTemplateToClient(client, tenantId, id);
    await insertAudit(client, tenantId, actor, "post_sales.client.created", "post_sale_client", id, {
      origin: "manual",
      lead_id: leadId,
      has_responsible: Boolean(input.responsible_member_id),
      has_next_action: Boolean(input.next_action_at)
    });
    return getPostSaleClientWith(client, tenantId, id);
  });
}

async function getPostSaleClientWith(client: Queryable, tenantId: string, clientId: string) {
  const result = await client.query(
    `SELECT id,tenant_id,name,phone_e164,email,notes,responsible_member_id,
            next_action,next_action_at,origin,lead_id,archived_at,version,
            created_at,updated_at
     FROM post_sale_clients WHERE tenant_id=$1 AND id=$2`,
    [tenantId, clientId]
  );
  if (!result.rows[0]) throw httpError(404, "Cliente de pós-venda não encontrado");
  return result.rows[0];
}

export async function captureClosedSalePostSaleClient(
  client: PoolClient,
  tenantId: string,
  leadId: string,
  actorUserId: string | null,
  actorScope: "root" | "workspace" = "workspace"
) {
  if (!await isFeatureFlagEnabled(client, tenantId, "post_sales_v1")) {
    return { created: false, clientId: null, reason: "feature_disabled" as const };
  }
  const lead = (await client.query<{ id: string; name: string | null; phone: string }>(
    "SELECT id,name,phone FROM scheduling_leads WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE",
    [tenantId, leadId]
  )).rows[0];
  if (!lead) throw httpError(404, "Lead não encontrado");
  const responsibleMemberId = actorUserId
    ? (await client.query<{ id: string }>(
      `SELECT id FROM workspace_members
       WHERE workspace_id=$1 AND user_id=$2 AND status='active'
       LIMIT 1`,
      [tenantId, actorUserId]
    )).rows[0]?.id ?? null
    : null;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO post_sale_clients(
       tenant_id,name,phone_e164,responsible_member_id,origin,lead_id,
       created_by_user_id,updated_by_user_id
     ) VALUES($1,$2,$3,$4,'closed_sale',$5,$6,$6)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [tenantId, lead.name?.trim() || lead.phone, lead.phone, responsibleMemberId, lead.id, actorUserId]
  );
  const id = inserted.rows[0]?.id ?? await existingClientId(client, tenantId, lead.phone, lead.id);
  if (!id) throw httpError(409, "Não foi possível vincular a venda ao pós-venda");
  if (inserted.rows[0]) {
    await copyTemplateToClient(client, tenantId, id);
    await client.query(
      `INSERT INTO audit_logs(
         actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata
       ) VALUES($1,$2,$3,'post_sales.client.created_from_closed_sale','post_sale_client',$4,$5)`,
      [actorUserId, tenantId, actorScope, id, { lead_id: lead.id, has_responsible: Boolean(responsibleMemberId) }]
    );
  }
  return { created: Boolean(inserted.rows[0]), clientId: id, reason: inserted.rows[0] ? "created" as const : "existing" as const };
}

async function assertClientMutationResult(client: PoolClient, tenantId: string, clientId: string, updated: unknown) {
  if (updated) return;
  const current = await client.query<{ version: number }>(
    "SELECT version FROM post_sale_clients WHERE tenant_id=$1 AND id=$2",
    [tenantId, clientId]
  );
  if (!current.rows[0]) throw httpError(404, "Cliente de pós-venda não encontrado");
  throw httpError(409, "Cliente alterado em outra sessão", "VERSION_CONFLICT");
}

export async function updatePostSaleClient(
  tenantId: string,
  clientId: string,
  actor: PostSaleActor,
  input: PostSaleClientUpdateInput
) {
  try {
    return await withTransaction(async (client) => {
      await assertResponsibleMember(client, tenantId, input.responsible_member_id);
      const fields = Object.keys(input).filter((key) => key !== "version");
      const nextActionProvided = input.next_action !== undefined;
      const updated = await client.query(
        `UPDATE post_sale_clients SET
           name=CASE WHEN $4 THEN $5 ELSE name END,
           phone_e164=CASE WHEN $6 THEN $7 ELSE phone_e164 END,
           email=CASE WHEN $8 THEN $9 ELSE email END,
           notes=CASE WHEN $10 THEN $11 ELSE notes END,
           responsible_member_id=CASE WHEN $12 THEN $13 ELSE responsible_member_id END,
           next_action=CASE WHEN $14 THEN $15 ELSE next_action END,
           next_action_at=CASE WHEN $14 THEN $16 ELSE next_action_at END,
           updated_by_user_id=$17,updated_at=now(),version=version+1
         WHERE tenant_id=$1 AND id=$2 AND version=$3
         RETURNING *`,
        [
          tenantId,
          clientId,
          input.version,
          input.name !== undefined,
          input.name ?? null,
          input.phone_e164 !== undefined,
          input.phone_e164 ?? null,
          input.email !== undefined,
          input.email ?? null,
          input.notes !== undefined,
          input.notes ?? null,
          input.responsible_member_id !== undefined,
          input.responsible_member_id ?? null,
          nextActionProvided,
          input.next_action ?? null,
          input.next_action_at ? new Date(input.next_action_at) : null,
          actor.userId
        ]
      );
      await assertClientMutationResult(client, tenantId, clientId, updated.rows[0]);
      await insertAudit(client, tenantId, actor, "post_sales.client.updated", "post_sale_client", clientId, { fields });
      return updated.rows[0];
    });
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "23505" && input.phone_e164) {
      const id = await existingClientId(db, tenantId, input.phone_e164);
      if (id) throw new PostSaleConflictError(id);
    }
    throw error;
  }
}

export async function setPostSaleClientArchived(
  tenantId: string,
  clientId: string,
  actor: PostSaleActor,
  version: number,
  archived: boolean
) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE post_sale_clients SET archived_at=${archived ? "now()" : "NULL"},
              updated_by_user_id=$4,updated_at=now(),version=version+1
       WHERE tenant_id=$1 AND id=$2 AND version=$3
         AND archived_at IS ${archived ? "NULL" : "NOT NULL"}
       RETURNING *`,
      [tenantId, clientId, version, actor.userId]
    );
    await assertClientMutationResult(client, tenantId, clientId, result.rows[0]);
    await insertAudit(
      client,
      tenantId,
      actor,
      archived ? "post_sales.client.archived" : "post_sales.client.restored",
      "post_sale_client",
      clientId
    );
    return result.rows[0];
  });
}

export async function updatePostSaleChecklistEntry(
  tenantId: string,
  clientId: string,
  entryId: string,
  actor: PostSaleActor,
  input: PostSaleChecklistEntryUpdateInput
) {
  return withTransaction(async (client) => {
    const previous = await client.query<{ result: string; note: string | null }>(
      `SELECT entry.result,entry.note
       FROM post_sale_client_checklist entry
       JOIN post_sale_checklist_items item
         ON item.tenant_id=entry.tenant_id AND item.id=entry.item_id
       JOIN post_sale_clients post_client
         ON post_client.tenant_id=entry.tenant_id AND post_client.id=entry.client_id
       WHERE entry.tenant_id=$1 AND entry.client_id=$2 AND entry.id=$3
         AND item.archived_at IS NULL AND post_client.archived_at IS NULL
       FOR UPDATE OF entry,item,post_client`,
      [tenantId, clientId, entryId]
    );
    if (!previous.rows[0]) throw httpError(404, "Entrada do checklist não encontrada");
    const result = await client.query(
      `UPDATE post_sale_client_checklist SET
         result=$4,note=CASE WHEN $5 THEN $6 ELSE note END,
         updated_by_user_id=$7,updated_at=now(),version=version+1
       WHERE tenant_id=$1 AND client_id=$2 AND id=$3 AND version=$8
       RETURNING *`,
      [tenantId, clientId, entryId, input.result, input.note !== undefined, input.note ?? null, actor.userId, input.version]
    );
    if (!result.rows[0]) throw httpError(409, "Checklist alterado em outra sessão", "VERSION_CONFLICT");
    await client.query(
      "UPDATE post_sale_clients SET updated_at=now() WHERE tenant_id=$1 AND id=$2",
      [tenantId, clientId]
    );
    await insertAudit(client, tenantId, actor, "post_sales.checklist.updated", "post_sale_client_checklist", entryId, {
      client_id: clientId,
      previous_result: previous.rows[0].result,
      result: input.result,
      note_changed: input.note !== undefined && input.note !== previous.rows[0].note
    });
    return result.rows[0];
  });
}

export async function listPostSaleDebts(tenantId: string, query: PostSaleDebtsQuery) {
  const values: unknown[] = [tenantId];
  const where = ["tenant_id=$1"];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  if (query.q) {
    const parameter = bind(`%${query.q}%`);
    where.push(`(customer_name ILIKE ${parameter} OR COALESCE(phone_raw,'') ILIKE ${parameter} OR COALESCE(phone_e164,'') ILIKE ${parameter})`);
  }
  if (query.store) where.push(`store=${bind(query.store)}`);
  if (query.status) where.push(`status=${bind(query.status)}`);
  const limit = bind(query.limit);
  const result = await db.query(
    `SELECT id,store,customer_name,phone_raw,phone_e164,reference_date,amount_open,amount_recovered,
            status,contact_method,payment_method,reason,promise_date,notes,days_without_contact,alert,created_at
     FROM post_sale_debts
     WHERE ${where.join(" AND ")}
     ORDER BY days_without_contact DESC NULLS LAST,reference_date DESC,id
     LIMIT ${limit}`,
    values
  );

  const summary = await db.query(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE status='Pago')::int paid,
            coalesce(sum(amount_open) FILTER (WHERE status IS DISTINCT FROM 'Pago'),0)::float8 amount_open_total,
            coalesce(sum(amount_recovered),0)::float8 amount_recovered_total
     FROM post_sale_debts WHERE tenant_id=$1`,
    [tenantId]
  );

  return { summary: summary.rows[0], debts: result.rows };
}

export async function listPostSaleDebtFilters(tenantId: string) {
  const result = await db.query<{ store: string; status: string | null }>(
    `SELECT DISTINCT store,status FROM post_sale_debts WHERE tenant_id=$1`,
    [tenantId]
  );
  const stores = [...new Set(result.rows.map((row) => row.store))].sort();
  const statuses = [...new Set(result.rows.map((row) => row.status).filter((value): value is string => Boolean(value)))].sort();
  return { stores, statuses };
}

export async function listPostSaleOptions(tenantId: string) {
  const members = await db.query(
    `SELECT member.id,member.user_id,COALESCE(user_row.name,user_row.email) name,user_row.email
     FROM workspace_members member
     JOIN users user_row ON user_row.id=member.user_id AND user_row.status='active'
     WHERE member.workspace_id=$1 AND member.status='active'
     ORDER BY COALESCE(user_row.name,user_row.email),member.id`,
    [tenantId]
  );
  return { members: members.rows };
}

async function listTemplateWith(client: Queryable, tenantId: string) {
  const result = await client.query(
    `SELECT item.id,item.description,item.position,item.is_active,item.archived_at,
            item.version,item.created_at,item.updated_at,
            count(entry.id)::int client_count,
            count(entry.id) FILTER (WHERE entry.result <> 'pendente')::int answered_count
     FROM post_sale_checklist_items item
     LEFT JOIN post_sale_client_checklist entry
       ON entry.tenant_id=item.tenant_id AND entry.item_id=item.id
     WHERE item.tenant_id=$1
     GROUP BY item.id
     ORDER BY (item.archived_at IS NOT NULL),item.position,item.id`,
    [tenantId]
  );
  return { items: result.rows };
}

export function listPostSaleTemplate(tenantId: string) {
  return listTemplateWith(db, tenantId);
}

export async function createPostSaleTemplateItem(
  tenantId: string,
  actor: PostSaleActor,
  description: string
) {
  return withTransaction(async (client) => {
    const item = (await client.query<{ id: string } & Record<string, unknown>>(
      `INSERT INTO post_sale_checklist_items(
         tenant_id,description,position,created_by_user_id,updated_by_user_id
       ) SELECT $1,$2,COALESCE(max(position)+1,0),$3,$3
         FROM post_sale_checklist_items WHERE tenant_id=$1
       RETURNING *`,
      [tenantId, description, actor.userId]
    )).rows[0];
    const propagated = await client.query(
      `INSERT INTO post_sale_client_checklist(tenant_id,client_id,item_id)
       SELECT $1,client.id,$2
       FROM post_sale_clients client
       WHERE client.tenant_id=$1 AND client.archived_at IS NULL
       ON CONFLICT DO NOTHING`,
      [tenantId, item.id]
    );
    await insertAudit(client, tenantId, actor, "post_sales.template_item.created", "post_sale_checklist_item", item.id, {
      propagated_clients: propagated.rowCount ?? 0
    });
    return item;
  });
}

async function assertTemplateMutationResult(client: PoolClient, tenantId: string, itemId: string, updated: unknown) {
  if (updated) return;
  const current = await client.query("SELECT version FROM post_sale_checklist_items WHERE tenant_id=$1 AND id=$2", [tenantId, itemId]);
  if (!current.rows[0]) throw httpError(404, "Item do checklist não encontrado");
  throw httpError(409, "Item alterado em outra sessão", "VERSION_CONFLICT");
}

export async function updatePostSaleTemplateItem(
  tenantId: string,
  itemId: string,
  actor: PostSaleActor,
  version: number,
  description: string
) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE post_sale_checklist_items SET
       description=$4,updated_by_user_id=$5,updated_at=now(),version=version+1
       WHERE tenant_id=$1 AND id=$2 AND version=$3 AND archived_at IS NULL
       RETURNING *`,
      [tenantId, itemId, version, description, actor.userId]
    );
    await assertTemplateMutationResult(client, tenantId, itemId, result.rows[0]);
    await insertAudit(client, tenantId, actor, "post_sales.template_item.updated", "post_sale_checklist_item", itemId);
    return result.rows[0];
  });
}

export async function setPostSaleTemplateItemArchived(
  tenantId: string,
  itemId: string,
  actor: PostSaleActor,
  version: number,
  archived: boolean
) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE post_sale_checklist_items SET
         archived_at=${archived ? "now()" : "NULL"},is_active=${archived ? "false" : "true"},
         updated_by_user_id=$4,updated_at=now(),version=version+1
       WHERE tenant_id=$1 AND id=$2 AND version=$3
         AND archived_at IS ${archived ? "NULL" : "NOT NULL"}
       RETURNING *`,
      [tenantId, itemId, version, actor.userId]
    );
    await assertTemplateMutationResult(client, tenantId, itemId, result.rows[0]);
    let propagated = 0;
    if (!archived) {
      const entries = await client.query(
        `INSERT INTO post_sale_client_checklist(tenant_id,client_id,item_id)
         SELECT $1,client.id,$2
         FROM post_sale_clients client
         WHERE client.tenant_id=$1 AND client.archived_at IS NULL
         ON CONFLICT DO NOTHING`,
        [tenantId, itemId]
      );
      propagated = entries.rowCount ?? 0;
    }
    await insertAudit(
      client,
      tenantId,
      actor,
      archived ? "post_sales.template_item.archived" : "post_sales.template_item.restored",
      "post_sale_checklist_item",
      itemId,
      { propagated_clients: propagated }
    );
    return result.rows[0];
  });
}

export async function reorderPostSaleTemplate(
  tenantId: string,
  actor: PostSaleActor,
  input: PostSaleTemplateOrderInput
) {
  return withTransaction(async (client) => {
    const current = await client.query<{ id: string; version: number }>(
      `SELECT id,version FROM post_sale_checklist_items
       WHERE tenant_id=$1 AND archived_at IS NULL
       ORDER BY position,id FOR UPDATE`,
      [tenantId]
    );
    const expected = new Map(input.items.map((item) => [item.id, item.version]));
    if (current.rows.length !== input.items.length || current.rows.some((item) => !expected.has(item.id))) {
      throw httpError(409, "A lista do checklist mudou; recarregue antes de ordenar", "VERSION_CONFLICT");
    }
    if (current.rows.some((item) => expected.get(item.id) !== item.version)) {
      throw httpError(409, "Um item foi alterado em outra sessão", "VERSION_CONFLICT");
    }
    for (const [position, item] of input.items.entries()) {
      await client.query(
        `UPDATE post_sale_checklist_items SET
           position=$3,version=version+1,updated_by_user_id=$4,updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [tenantId, item.id, position, actor.userId]
      );
    }
    await insertAudit(client, tenantId, actor, "post_sales.template.reordered", "post_sale_checklist", tenantId, {
      item_ids: input.items.map((item) => item.id)
    });
    return listTemplateWith(client, tenantId);
  });
}
