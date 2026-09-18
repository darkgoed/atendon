import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePermission } from "../../auth/session.js";
import {
  createQuickReply,
  deleteQuickReply,
  listQuickReplies,
  quickReplyCreateSchema,
  quickReplyUpdateSchema,
  updateQuickReply
} from "./service.js";

const quickReplyIdParams = z.object({ id: z.string().uuid() });

function actor(request: FastifyRequest, session: Awaited<ReturnType<typeof requirePermission>>) {
  return {
    userId: session.userId,
    actorScope: session.actorScope,
    ipAddress: request.ip,
    userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined
  };
}

export async function registerQuickReplyRoutes(app: FastifyInstance) {
  // Leitura liberada para qualquer agente (quick_replies.read).
  app.get("/quick-replies", async (request) => {
    const session = await requirePermission(request, "quick_replies.read");
    return listQuickReplies(session.tenantId);
  });

  app.post("/quick-replies", async (request, reply) => {
    const input = quickReplyCreateSchema.parse(request.body);
    const session = await requirePermission(request, "quick_replies.manage");
    return reply.status(201).send(await createQuickReply(session, input, actor(request, session)));
  });

  app.patch("/quick-replies/:id", async (request) => {
    const { id } = quickReplyIdParams.parse(request.params);
    const input = quickReplyUpdateSchema.parse(request.body);
    const session = await requirePermission(request, "quick_replies.manage");
    return updateQuickReply(session, id, input, actor(request, session));
  });

  app.delete("/quick-replies/:id", async (request) => {
    const { id } = quickReplyIdParams.parse(request.params);
    const session = await requirePermission(request, "quick_replies.manage");
    return deleteQuickReply(session, id, actor(request, session));
  });
}
