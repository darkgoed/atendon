import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePermission, type WorkspaceSession } from "../../auth/session.js";
import { createTask, deleteTask, listTasks, taskCreateSchema, taskListQuerySchema, taskUpdateSchema, updateTask } from "./service.js";

const taskIdParams = z.object({ id: z.string().uuid() });

function canAssign(session: WorkspaceSession) {
  return session.isRoot || session.permissions.includes("tasks.assign");
}

function actor(request: FastifyRequest, session: WorkspaceSession) {
  return {
    userId: session.userId,
    actorScope: session.actorScope,
    ipAddress: request.ip,
    userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined
  };
}

export async function registerTaskRoutes(app: FastifyInstance) {
  app.get("/tasks", async (request) => {
    const query = taskListQuerySchema.parse(request.query ?? {});
    // Escopo equipe exige tasks.assign; "mine" fica para qualquer agente.
    const session = query.scope === "team"
      ? await requirePermission(request, "tasks.assign")
      : await requirePermission(request, "tasks.read");
    return listTasks(session, query);
  });

  app.post("/tasks", async (request, reply) => {
    const input = taskCreateSchema.parse(request.body);
    // Criar tarefa para si mesmo basta tasks.read; atribuir a outro exige tasks.assign.
    const base = await requirePermission(request, "tasks.read");
    const session = !input.assignee_id || input.assignee_id === base.userId
      ? base
      : await requirePermission(request, "tasks.assign");
    const task = await createTask(session, input, actor(request, session));
    return reply.status(201).send({ task });
  });

  app.patch("/tasks/:id", async (request) => {
    const { id } = taskIdParams.parse(request.params);
    const input = taskUpdateSchema.parse(request.body);
    const session = await requirePermission(request, "tasks.read");
    const task = await updateTask(session, id, input, { canAssign: canAssign(session) }, actor(request, session));
    return { task };
  });

  app.delete("/tasks/:id", async (request) => {
    const { id } = taskIdParams.parse(request.params);
    const session = await requirePermission(request, "tasks.read");
    return deleteTask(session, id, { canAssign: canAssign(session) }, actor(request, session));
  });
}
