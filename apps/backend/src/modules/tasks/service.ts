import { PoolClient } from "pg";
import { z } from "zod";
import { db } from "../../db/client.js";
import { httpError, instant, withTransaction } from "../scheduling/service.js";
import type { WorkspaceSession } from "../../auth/session.js";

// Tarefas internas por workspace (migration 0169; specs/active
// v6-evolucao-estrutural-atendon.md, R6 e contrato "Tarefas").

export const taskStatus = z.enum(["aberta", "em_andamento", "concluida"]);
export const taskPriority = z.enum(["baixa", "media", "alta"]);

export const taskCreateSchema = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().max(10_000).nullable().optional(),
  assignee_id: z.string().uuid().nullable().optional(),
  due_at: instant.nullable().optional(),
  priority: taskPriority.optional(),
  lead_id: z.string().uuid().nullable().optional()
}).strict();

export const taskUpdateSchema = z.object({
  status: taskStatus.optional(),
  title: z.string().trim().min(1).max(500).optional(),
  description: z.string().trim().max(10_000).nullable().optional(),
  assignee_id: z.string().uuid().nullable().optional(),
  due_at: instant.nullable().optional(),
  priority: taskPriority.optional()
}).strict();

export const taskListQuerySchema = z.object({
  scope: z.enum(["mine", "team"]).default("mine"),
  status: taskStatus.optional(),
  priority: taskPriority.optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30)
}).strict();

type TaskActor = Pick<WorkspaceSession, "userId" | "actorScope"> & { ipAddress?: string; userAgent?: string };

type TaskRow = {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  due_at: Date | null;
  assignee_id: string | null;
  assignee_name: string | null;
  created_by: string;
  author_name: string | null;
  lead_id: string | null;
  lead_name: string | null;
  lead_phone: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
};

function encodeCursor(row: { created_at: Date; id: string }) {
  return Buffer.from(JSON.stringify({ v: 1, created_at: new Date(row.created_at).toISOString(), id: row.id }))
    .toString("base64url");
}

function decodeCursor(value: string) {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.v !== 1 || typeof parsed.id !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.id)) throw new Error();
    if (typeof parsed.created_at !== "string" || Number.isNaN(Date.parse(parsed.created_at))) throw new Error();
    return { createdAt: parsed.created_at, id: parsed.id };
  } catch {
    throw httpError(400, "Cursor inválido");
  }
}

function mapTask(row: TaskRow) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    due_at: row.due_at,
    assignee: row.assignee_id ? { id: row.assignee_id, name: row.assignee_name } : null,
    author: { id: row.created_by, name: row.author_name },
    lead: row.lead_id ? { id: row.lead_id, name: row.lead_name, phone: row.lead_phone } : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at
  };
}

async function insertTaskAudit(client: PoolClient, tenantId: string, taskId: string, actor: TaskActor, action: string, metadata: Record<string, unknown>) {
  await client.query(
    `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
     VALUES($1,$2,$3,$4,'task',$5,$6,$7,$8)`,
    [actor.userId, tenantId, actor.actorScope, action, taskId, metadata, actor.ipAddress ?? null, actor.userAgent ?? null]
  );
}

// Mesma validação de membership usada pelas menções (internal/service.ts):
// o responsável precisa ser membro ativo do workspace e usuário ativo.
async function assertAssigneeIsMember(client: Pick<PoolClient, "query">, tenantId: string, userIds: string[]) {
  const unique = [...new Set(userIds)];
  const members = await client.query<{ user_id: string }>(
    `SELECT member.user_id
     FROM workspace_members member
     JOIN users member_user ON member_user.id=member.user_id AND member_user.status='active'
     WHERE member.workspace_id=$1 AND member.status='active' AND member.user_id=ANY($2::uuid[])`,
    [tenantId, unique]
  );
  if (members.rows.length !== unique.length) {
    throw httpError(400, "Responsável inválido: usuário não pertence à empresa ou está inativo");
  }
}

async function assertLeadExists(client: Pick<PoolClient, "query">, tenantId: string, leadId: string) {
  const lead = await client.query(
    "SELECT 1 FROM scheduling_leads WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL",
    [leadId, tenantId]
  );
  if (!lead.rows[0]) throw httpError(404, "Lead não encontrado");
}

// Notificação interna de atribuição (R2): nunca notifica o próprio autor.
async function insertTaskAssignedNotification(client: PoolClient, tenantId: string, taskId: string, taskTitle: string, actorId: string, assigneeIds: string[]) {
  const recipients = [...new Set(assigneeIds)].filter((id) => id !== actorId);
  if (!recipients.length) return;
  await client.query(
    `INSERT INTO internal_notifications(tenant_id,user_id,type,title,body,source_type,source_id,actor_id)
     SELECT $1, recipient, 'task_assigned', 'Você recebeu uma nova tarefa', $3, 'task', $4, $5
     FROM unnest($2::uuid[]) AS recipient`,
    [tenantId, recipients, taskTitle.slice(0, 500), taskId, actorId]
  );
}

export async function listTasks(
  session: WorkspaceSession,
  query: z.infer<typeof taskListQuerySchema>
) {
  const values: unknown[] = [];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const where = [`task.tenant_id=${bind(session.tenantId)}`];
  if (query.scope === "mine") where.push(`task.assignee_id=${bind(session.userId)}`);
  if (query.status) where.push(`task.status=${bind(query.status)}`);
  if (query.priority) where.push(`task.priority=${bind(query.priority)}`);
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    where.push(`(task.created_at,task.id)<(${bind(cursor.createdAt)}::timestamptz,${bind(cursor.id)}::uuid)`);
  }
  const limit = bind(query.limit + 1);
  const result = await db.query<TaskRow>(
    `SELECT task.id,task.tenant_id,task.title,task.description,task.status,task.priority,
            task.due_at,task.assignee_id,assignee.name assignee_name,
            task.created_by,author.name author_name,
            task.lead_id,lead.name lead_name,lead.phone lead_phone,
            task.created_at,task.updated_at,task.completed_at
     FROM tasks task
     LEFT JOIN users assignee ON assignee.id=task.assignee_id
     LEFT JOIN users author ON author.id=task.created_by
     LEFT JOIN scheduling_leads lead ON lead.id=task.lead_id AND lead.tenant_id=task.tenant_id
     WHERE ${where.join(" AND ")}
     ORDER BY task.created_at DESC,task.id DESC
     LIMIT ${limit}`,
    values
  );
  const hasMore = result.rows.length > query.limit;
  const pageRows = hasMore ? result.rows.slice(0, query.limit) : result.rows;
  const lastRow = pageRows.at(-1);
  return {
    items: pageRows.map(mapTask),
    page: {
      limit: query.limit,
      has_more: hasMore,
      next_cursor: hasMore && lastRow ? encodeCursor(lastRow) : null
    }
  };
}

export async function createTask(
  session: WorkspaceSession,
  input: z.infer<typeof taskCreateSchema>,
  actor: TaskActor
) {
  // A leitura de retorno acontece DEPOIS do commit (getTask usa o pool):
  // dentro da transação a linha ainda não é visível a outra conexão.
  const taskId = await withTransaction(async (client) => {
    if (input.lead_id) await assertLeadExists(client, session.tenantId, input.lead_id);
    const assigneeIds = input.assignee_id ? [input.assignee_id] : [];
    if (assigneeIds.length) await assertAssigneeIsMember(client, session.tenantId, assigneeIds);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO tasks(tenant_id,title,description,assignee_id,created_by,priority,due_at,lead_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        session.tenantId, input.title, input.description ?? null, input.assignee_id ?? null,
        session.userId, input.priority ?? "media", input.due_at ?? null, input.lead_id ?? null
      ]
    );
    const newTaskId = inserted.rows[0].id as string;
    await insertTaskAudit(client, session.tenantId, newTaskId, actor, "task.create", { title: input.title });
    if (input.assignee_id) {
      await insertTaskAssignedNotification(client, session.tenantId, newTaskId, input.title, session.userId, [input.assignee_id]);
    }
    return newTaskId;
  });
  return getTask(session.tenantId, taskId);
}

export async function getTask(tenantId: string, taskId: string): Promise<ReturnType<typeof mapTask>> {
  const result = await db.query<TaskRow>(
    `SELECT task.id,task.tenant_id,task.title,task.description,task.status,task.priority,
            task.due_at,task.assignee_id,assignee.name assignee_name,
            task.created_by,author.name author_name,
            task.lead_id,lead.name lead_name,lead.phone lead_phone,
            task.created_at,task.updated_at,task.completed_at
     FROM tasks task
     LEFT JOIN users assignee ON assignee.id=task.assignee_id
     LEFT JOIN users author ON author.id=task.created_by
     LEFT JOIN scheduling_leads lead ON lead.id=task.lead_id AND lead.tenant_id=task.tenant_id
     WHERE task.tenant_id=$1 AND task.id=$2`,
    [tenantId, taskId]
  );
  if (!result.rows[0]) throw httpError(404, "Tarefa não encontrada");
  return mapTask(result.rows[0]);
}

export async function updateTask(
  session: WorkspaceSession,
  taskId: string,
  input: z.infer<typeof taskUpdateSchema>,
  options: { canAssign: boolean },
  actor: TaskActor
) {
  // A leitura de retorno acontece DEPOIS do commit (getTask usa o pool):
  // dentro da transação a linha atualizada ainda não é visível a outra conexão.
  await withTransaction(async (client) => {
    const current = (await client.query<TaskRow>(
      `SELECT task.id,task.tenant_id,task.title,task.description,task.status,task.priority,
              task.due_at,task.assignee_id,assignee.name assignee_name,
              task.created_by,author.name author_name,
              task.lead_id,lead.name lead_name,lead.phone lead_phone,
              task.created_at,task.updated_at,task.completed_at
       FROM tasks task
       LEFT JOIN users assignee ON assignee.id=task.assignee_id
       LEFT JOIN users author ON author.id=task.created_by
       LEFT JOIN scheduling_leads lead ON lead.id=task.lead_id AND lead.tenant_id=task.tenant_id
       WHERE task.tenant_id=$1 AND task.id=$2 FOR UPDATE OF task`,
      [session.tenantId, taskId]
    )).rows[0];
    if (!current) throw httpError(404, "Tarefa não encontrada");

    const touchesAssignment = input.assignee_id !== undefined || input.due_at !== undefined || input.priority !== undefined;
    if (touchesAssignment && !options.canAssign) {
      throw httpError(403, "Permissão insuficiente");
    }
    if (input.status !== undefined && !options.canAssign
      && current.assignee_id !== session.userId && current.created_by !== session.userId) {
      throw httpError(403, "Somente o responsável pela tarefa pode alterar o status");
    }
    // Conteúdo (título/descrição): só gestão, responsável atual ou autor.
    if ((input.title !== undefined || input.description !== undefined) && !options.canAssign
      && current.assignee_id !== session.userId && current.created_by !== session.userId) {
      throw httpError(403, "Permissão insuficiente");
    }
    if (input.assignee_id) await assertAssigneeIsMember(client, session.tenantId, [input.assignee_id]);

    const nextStatus = input.status ?? current.status;
    const completedAt = nextStatus === "concluida" ? (current.completed_at ?? new Date()) : null;
    await client.query(
      `UPDATE tasks SET
         title=$3,description=$4,assignee_id=$5,due_at=$6,priority=$7,status=$8,
         completed_at=$9,updated_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [
        session.tenantId, taskId,
        input.title ?? current.title, input.description !== undefined ? input.description : current.description,
        input.assignee_id !== undefined ? input.assignee_id : current.assignee_id,
        input.due_at !== undefined ? input.due_at : current.due_at,
        input.priority ?? current.priority, nextStatus, completedAt
      ]
    );
    await insertTaskAudit(client, session.tenantId, taskId, actor, "task.update", {
      status: nextStatus,
      reassigned: input.assignee_id !== undefined && input.assignee_id !== current.assignee_id
    });
    if (input.assignee_id && input.assignee_id !== current.assignee_id) {
      await insertTaskAssignedNotification(
        client, session.tenantId, taskId, input.title ?? current.title, session.userId, [input.assignee_id]
      );
    }
  });
  return getTask(session.tenantId, taskId);
}

export async function deleteTask(
  session: WorkspaceSession,
  taskId: string,
  options: { canAssign: boolean },
  actor: TaskActor
) {
  return withTransaction(async (client) => {
    const current = await client.query(
      "SELECT id,created_by FROM tasks WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [session.tenantId, taskId]
    );
    if (!current.rows[0]) throw httpError(404, "Tarefa não encontrada");
    const row = current.rows[0] as { id: string; created_by: string };
    if (row.created_by !== session.userId && !options.canAssign) {
      throw httpError(403, "Somente o autor ou a gestão pode excluir a tarefa");
    }
    await client.query("DELETE FROM tasks WHERE tenant_id=$1 AND id=$2", [session.tenantId, taskId]);
    await insertTaskAudit(client, session.tenantId, taskId, actor, "task.delete", {});
    return { id: taskId };
  });
}
