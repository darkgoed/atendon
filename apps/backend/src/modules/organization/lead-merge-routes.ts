import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission } from "../../auth/session.js";
import {
  mergeLeads,
  preflightLeadMerge,
  type LeadMergeActor
} from "./lead-merge.js";

const leadMergeIdsSchema = z.object({
  source_id: z.string().uuid(),
  target_id: z.string().uuid()
}).strict();

const leadMergeSchema = leadMergeIdsSchema.extend({
  // Telefone DIFERENTE exige confirmação explícita (spec B5); JAMAIS merge
  // por nome — o nome não participa de nenhuma decisão.
  confirmations: z.object({
    different_phone: z.literal(true).optional()
  }).optional()
}).strict();

function actor(
  userId: string,
  actorScope: "root" | "workspace",
  ip?: string,
  userAgent?: string
): LeadMergeActor {
  return { userId, actorScope, ipAddress: ip, userAgent };
}

export async function registerLeadMergeRoutes(app: FastifyInstance) {
  // Preflight é leitura (contagens + igualdade de telefone normalizado).
  app.post("/organization/leads/merge/preflight", async (request) => {
    const session = await requirePermission(request, "leads.read");
    const input = leadMergeIdsSchema.parse(request.body);
    return preflightLeadMerge(session.tenantId, input.source_id, input.target_id);
  });

  // Mesclar exclui o source: mesma autorização da exclusão de leads.
  app.post("/organization/leads/merge", async (request) => {
    const session = await requirePermission(request, "leads.delete");
    const input = leadMergeSchema.parse(request.body);
    return mergeLeads(
      session.tenantId,
      { sourceId: input.source_id, targetId: input.target_id, confirmations: input.confirmations },
      actor(session.userId, session.actorScope, request.ip, request.headers["user-agent"])
    );
  });
}
