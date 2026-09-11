import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePermission } from "../../auth/session.js";
import { db } from "../../db/client.js";
import { withTenantTransaction } from "../../db/tenant-transaction.js";
import { conversationScopeCondition, resolveCaseScope } from "../../auth/case-scope.js";

const uuid = z.string().uuid();
const params = z.object({ id: uuid });
const createBody = z.object({ name: z.string().trim().min(1).max(60), color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional() }).strict();
const updateBody = z.object({ name: z.string().trim().min(1).max(60).optional(), color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(), position: z.number().int().min(0).optional() }).strict().refine((v) => Object.keys(v).length > 0, "Informe ao menos um campo");
const reorderBody = z.object({ ids: z.array(uuid).min(1) }).strict();
const moveBody = z.object({ queue_id: uuid });

type Queryable = { query: <T = unknown>(sql: string, values?: unknown[]) => Promise<{ rows: T[] }> };

async function audit(client: Queryable, request: FastifyRequest, session: { userId: string; tenantId: string; actorScope: "root" | "workspace" }, action: string, resourceId: string, metadata: Record<string, unknown> = {}) {
  await client.query(`INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent) VALUES($1,$2,$3,$4,'conversation_queue',$5,$6,$7,$8)`, [session.userId, session.tenantId, session.actorScope, action, resourceId, metadata, request.ip, request.headers["user-agent"] ?? null]);
}

async function queueRows(client: Queryable, tenantId: string, userId: string, includeArchived: boolean, scope: string): Promise<QueueRow[]> {
  const result = await client.query<QueueRow>(`SELECT q.id,q.name,q.color,q.position,q.is_initial,q.is_resolved,q.archived_at,
    (SELECT count(*)::int FROM conversations c WHERE c.tenant_id=q.tenant_id AND c.queue_id=q.id AND c.status='open' AND (${scope})) conversation_count
    FROM conversation_queues q WHERE q.tenant_id=$1 AND ($3::boolean OR q.archived_at IS NULL) ORDER BY q.position,q.id`, [tenantId, userId, includeArchived]);
  return result.rows;
}
type QueueRow = { id: string; name: string; color: string; position: number; is_initial: boolean; is_resolved: boolean; archived_at: Date | null; conversation_count: number };
function queue(row: QueueRow) { return { id: row.id, name: row.name, color: row.color, position: row.position, is_initial: row.is_initial, is_resolved: row.is_resolved, archived_at: row.archived_at, conversation_count: Number(row.conversation_count) }; }
function conflict(reply: { status: (code: number) => { send: (body: unknown) => unknown } }, message: string) { return reply.status(409).send({ error: message }); }

export async function registerConversationQueueRoutes(app: FastifyInstance) {
  app.get("/conversation-queues", async (request) => {
    const session = await requirePermission(request, "conversations.read");
    const query = z.object({ include_archived: z.enum(["true", "false"]).optional() }).parse(request.query);
    const scope = await resolveCaseScope(db, session);
    const rows = await queueRows(db, session.tenantId, scope.userId, query.include_archived === "true", conversationScopeCondition(scope, "c", "$2"));
    return { queues: rows.map(queue) };
  });

  app.post("/conversation-queues", async (request, reply) => {
    const session = await requirePermission(request, "conversations.queues.manage");
    const body = createBody.parse(request.body);
    try {
      const result = await withTenantTransaction(db, session.tenantId, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`conversation-queues:${session.tenantId}`]);
        const inserted = await client.query<QueueRow>(`INSERT INTO conversation_queues(tenant_id,name,color,position,created_by_user_id) VALUES($1,$2,COALESCE($3,'#64748B'),COALESCE((SELECT max(position) FROM conversation_queues WHERE tenant_id=$1 AND archived_at IS NULL),0)+10,$4) RETURNING *`, [session.tenantId, body.name, body.color ?? null, session.userId]);
        await audit(client, request, session, "conversation_queue.created", inserted.rows[0].id);
        return inserted.rows[0];
      });
      return reply.status(201).send({ queue: queue({ ...result, conversation_count: 0 }) });
    } catch (error) { if ((error as { code?: string }).code === "23505") return conflict(reply, "Nome de fila já existe"); throw error; }
  });

  app.patch("/conversation-queues/:id", async (request, reply) => {
    const session = await requirePermission(request, "conversations.queues.manage");
    const { id } = params.parse(request.params); const body = updateBody.parse(request.body);
    try {
      const result = await withTenantTransaction(db, session.tenantId, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`conversation-queues:${session.tenantId}`]);
        if (body.position !== undefined) await client.query("SELECT id FROM conversation_queues WHERE tenant_id=$1 AND archived_at IS NULL ORDER BY position,id FOR UPDATE", [session.tenantId]);
        const updated = await client.query<QueueRow>(`UPDATE conversation_queues SET name=COALESCE($3,name),color=COALESCE($4,color),position=COALESCE($5,position),updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`, [session.tenantId, id, body.name ?? null, body.color ?? null, body.position ?? null]);
        if (!updated.rows[0]) return null;
        await audit(client, request, session, "conversation_queue.updated", id, body);
        return updated.rows[0];
      });
      if (!result) return reply.status(404).send({ error: "Fila não encontrada" });
      const scope = await resolveCaseScope(db, session);
      const rows = await queueRows(db, session.tenantId, scope.userId, true, conversationScopeCondition(scope, "c", "$2"));
      const current = rows.find((row) => row.id === id);
      return { queue: queue(current ?? { ...result, conversation_count: 0 }) };
    } catch (error) { if ((error as { code?: string }).code === "23505") return conflict(reply, "Nome de fila já existe"); throw error; }
  });

  app.post("/conversation-queues/reorder", async (request, reply) => {
    const session = await requirePermission(request, "conversations.queues.manage"); const body = reorderBody.parse(request.body);
    if (new Set(body.ids).size !== body.ids.length) return reply.status(400).send({ error: "IDs repetidos" });
    const result = await withTenantTransaction(db, session.tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`conversation-queues:${session.tenantId}`]);
      const locked = await client.query<{ id: string }>("SELECT id FROM conversation_queues WHERE tenant_id=$1 AND archived_at IS NULL ORDER BY position,id FOR UPDATE", [session.tenantId]);
      if (locked.rows.length !== body.ids.length || locked.rows.some((r) => !body.ids.includes(r.id))) return null;
      for (const [index, id] of body.ids.entries()) await client.query("UPDATE conversation_queues SET position=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2", [session.tenantId, id, (index + 1) * 10]);
      await audit(client, request, session, "conversation_queue.reordered", session.tenantId, { ids: body.ids });
      const scope = await resolveCaseScope(client, session); const rows = await queueRows(client, session.tenantId, scope.userId, false, conversationScopeCondition(scope, "c", "$2"));
      return rows.map(queue);
    });
    if (!result) return reply.status(400).send({ error: "IDs devem ser exatamente todas as filas ativas" });
    return { queues: result };
  });

  app.delete("/conversation-queues/:id", async (request, reply) => {
    const session = await requirePermission(request, "conversations.queues.manage"); const { id } = params.parse(request.params);
    const result = await withTenantTransaction(db, session.tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`conversation-queues:${session.tenantId}`]);
      const locked = await client.query<{ id: string; is_initial: boolean; is_resolved: boolean }>("SELECT id,is_initial,is_resolved FROM conversation_queues WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [session.tenantId, id]);
      if (!locked.rows[0]) return "missing"; if (locked.rows[0].is_initial || locked.rows[0].is_resolved) return "protected";
      const initial = await client.query<{ id: string }>("SELECT id FROM conversation_queues WHERE tenant_id=$1 AND is_initial AND archived_at IS NULL FOR UPDATE", [session.tenantId]);
      if (!initial.rows[0]) return "no_initial";
      await client.query("UPDATE conversations SET queue_id=$3 WHERE tenant_id=$1 AND queue_id=$2", [session.tenantId, id, initial.rows[0].id]);
      await client.query("UPDATE conversation_queues SET archived_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2", [session.tenantId, id]);
      await audit(client, request, session, "conversation_queue.archived", id, { movedTo: initial.rows[0].id }); return "ok";
    });
    if (result === "missing") return reply.status(404).send({ error: "Fila não encontrada" }); if (result === "protected") return conflict(reply, "Fila inicial ou resolvida não pode ser arquivada"); if (result === "no_initial") return conflict(reply, "Tenant sem fila inicial"); return reply.status(204).send();
  });

  app.patch("/conversations/:id/queue", async (request, reply) => {
    const session = await requirePermission(request, "conversations.reply"); const { id } = params.parse(request.params); const body = moveBody.parse(request.body); const scope = await resolveCaseScope(db, session);
    const result = await withTenantTransaction(db, session.tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`conversation-queues:${session.tenantId}`]);
      const target = await client.query<{ id: string; is_resolved: boolean }>("SELECT id,is_resolved FROM conversation_queues WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE", [session.tenantId, body.queue_id]); if (!target.rows[0]) return "queue";
      const updated = await client.query<{ id: string; status: "open" | "closed" }>(`UPDATE conversations c SET queue_id=$3 WHERE c.id=$1 AND c.tenant_id=$2 AND (${conversationScopeCondition(scope, "c", "$4")}) RETURNING c.id,c.status`, [id, session.tenantId, body.queue_id, scope.userId]); if (!updated.rows[0]) return "conversation";
      await audit(client, request, session, "conversation_queue.moved", id, { queueId: body.queue_id }); return updated.rows[0];
    });
    if (result === "queue") return reply.status(404).send({ error: "Fila não encontrada" }); if (result === "conversation") return reply.status(404).send({ error: "Conversa não encontrada" }); return { ok: true, queue_id: body.queue_id, status: result.status };
  });
}
