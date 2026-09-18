import { PoolClient } from "pg";
import { z } from "zod";
import { db } from "../../db/client.js";
import { httpError, withTransaction } from "../scheduling/service.js";
import type { WorkspaceSession } from "../../auth/session.js";

// Respostas rápidas do composer "/" (migration 0172; contrato "Quick replies").
// O backend guarda o texto cru; variáveis {{nome}}/{{atendente}}/{{data}} são
// resolvidas no frontend na inserção. Atalho é único por tenant — padronizamos
// minúsculas para tornar o UNIQUE efetivamente case-insensitive.

export const quickReplyCreateSchema = z.object({
  shortcut: z.string().trim().toLowerCase().min(1).max(50),
  body: z.string().trim().min(1).max(10_000)
}).strict();

export const quickReplyUpdateSchema = z.object({
  shortcut: z.string().trim().toLowerCase().min(1).max(50).optional(),
  body: z.string().trim().min(1).max(10_000).optional()
}).strict();

type QuickReplyActor = Pick<WorkspaceSession, "userId" | "actorScope"> & { ipAddress?: string; userAgent?: string };

type QuickReplyRow = {
  id: string;
  tenant_id: string;
  shortcut: string;
  body: string;
  created_by: string | null;
  author_name: string | null;
  created_at: Date;
  updated_at: Date;
};

function mapQuickReply(row: QuickReplyRow) {
  return {
    id: row.id,
    shortcut: row.shortcut,
    body: row.body,
    author: row.created_by ? { id: row.created_by, name: row.author_name } : null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

async function insertQuickReplyAudit(client: PoolClient, tenantId: string, quickReplyId: string, actor: QuickReplyActor, action: string, metadata: Record<string, unknown>) {
  await client.query(
    `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
     VALUES($1,$2,$3,$4,'quick_reply',$5,$6,$7,$8)`,
    [actor.userId, tenantId, actor.actorScope, action, quickReplyId, metadata, actor.ipAddress ?? null, actor.userAgent ?? null]
  );
}

export async function listQuickReplies(tenantId: string) {
  const rows = await db.query<QuickReplyRow>(
    `SELECT reply.id,reply.tenant_id,reply.shortcut,reply.body,
            reply.created_by,author.name author_name,reply.created_at,reply.updated_at
     FROM quick_replies reply
     LEFT JOIN users author ON author.id=reply.created_by
     WHERE reply.tenant_id=$1
     ORDER BY reply.shortcut`,
    [tenantId]
  );
  return { items: rows.rows.map(mapQuickReply) };
}

export async function createQuickReply(
  session: WorkspaceSession,
  input: z.infer<typeof quickReplyCreateSchema>,
  actor: QuickReplyActor
) {
  return withTransaction(async (client) => {
    const inserted = await client.query<QuickReplyRow>(
      `INSERT INTO quick_replies(tenant_id,shortcut,body,created_by)
       VALUES($1,$2,$3,$4)
       RETURNING id,tenant_id,shortcut,body,created_by,created_at,updated_at`,
      [session.tenantId, input.shortcut, input.body, session.userId]
    ).catch((error: unknown) => {
      if (isUniqueViolation(error)) throw httpError(409, "Já existe uma resposta rápida com esse atalho");
      throw error;
    });
    const row = inserted.rows[0];
    await insertQuickReplyAudit(client, session.tenantId, row.id, actor, "quick_reply.create", { shortcut: row.shortcut });
    return { reply: mapQuickReply({ ...row, author_name: null }) };
  });
}

export async function updateQuickReply(
  session: WorkspaceSession,
  quickReplyId: string,
  input: z.infer<typeof quickReplyUpdateSchema>,
  actor: QuickReplyActor
) {
  return withTransaction(async (client) => {
    const current = await client.query<QuickReplyRow>(
      "SELECT id,tenant_id,shortcut,body,created_by,created_at,updated_at FROM quick_replies WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [session.tenantId, quickReplyId]
    );
    if (!current.rows[0]) throw httpError(404, "Resposta rápida não encontrada");
    const updated = await client.query<QuickReplyRow>(
      `UPDATE quick_replies SET shortcut=$3,body=$4,updated_at=now()
       WHERE tenant_id=$1 AND id=$2
       RETURNING id,tenant_id,shortcut,body,created_by,created_at,updated_at`,
      [
        session.tenantId, quickReplyId,
        input.shortcut ?? current.rows[0].shortcut,
        input.body ?? current.rows[0].body
      ]
    ).catch((error: unknown) => {
      if (isUniqueViolation(error)) throw httpError(409, "Já existe uma resposta rápida com esse atalho");
      throw error;
    });
    await insertQuickReplyAudit(client, session.tenantId, quickReplyId, actor, "quick_reply.update", {
      shortcut_changed: input.shortcut !== undefined && input.shortcut !== current.rows[0].shortcut
    });
    return { reply: mapQuickReply(updated.rows[0]) };
  });
}

export async function deleteQuickReply(
  session: WorkspaceSession,
  quickReplyId: string,
  actor: QuickReplyActor
) {
  return withTransaction(async (client) => {
    const deleted = await client.query(
      "DELETE FROM quick_replies WHERE tenant_id=$1 AND id=$2 RETURNING id",
      [session.tenantId, quickReplyId]
    );
    if (!deleted.rows[0]) throw httpError(404, "Resposta rápida não encontrada");
    await insertQuickReplyAudit(client, session.tenantId, quickReplyId, actor, "quick_reply.delete", {});
    return { id: quickReplyId };
  });
}
