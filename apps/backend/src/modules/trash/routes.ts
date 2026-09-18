import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePermission } from "../../auth/session.js";
import { listTrashedLeads, purgeTrashedLead, restoreTrashedLead, trashListQuerySchema } from "./service.js";

const leadIdParams = z.object({ id: z.string().uuid() });

function actor(request: FastifyRequest, session: Awaited<ReturnType<typeof requirePermission>>) {
  return {
    userId: session.userId,
    actorScope: session.actorScope,
    ipAddress: request.ip,
    userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined
  };
}

export async function registerTrashRoutes(app: FastifyInstance) {
  app.get("/trash", async (request) => {
    const query = trashListQuerySchema.parse(request.query ?? {});
    const session = await requirePermission(request, "trash.manage");
    return listTrashedLeads(session, query);
  });

  app.post("/trash/leads/:id/restore", async (request) => {
    const { id } = leadIdParams.parse(request.params);
    const session = await requirePermission(request, "trash.manage");
    return restoreTrashedLead(session, id, actor(request, session));
  });

  // Exclusão definitiva (única forma de apagar de vez um contato).
  app.delete("/trash/leads/:id", async (request) => {
    const { id } = leadIdParams.parse(request.params);
    const session = await requirePermission(request, "trash.manage");
    return purgeTrashedLead(session, id, actor(request, session));
  });
}
