import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { leadScopeCondition, resolveCaseScope } from "../../auth/case-scope.js";
import { requirePermission, type WorkspaceSession } from "../../auth/session.js";
import { db } from "../../db/client.js";
import { httpError } from "../scheduling/service.js";
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

// Mesmo escopo da exclusão de leads: fora do caso do operador é 404.
async function assertLeadsInScope(session: WorkspaceSession, leadIds: string[]) {
  const scope = await resolveCaseScope(db, session);
  if (scope.type === "workspace") return;
  const visible = await db.query<{ n: number }>(
    `SELECT count(*)::int n FROM scheduling_leads lead
     WHERE lead.tenant_id=$1 AND lead.id=ANY($2::uuid[]) AND (${leadScopeCondition(scope, "lead", "$3")})`,
    [session.tenantId, leadIds, scope.memberId]
  );
  if (visible.rows[0].n !== new Set(leadIds).size) throw httpError(404, "Contato não encontrado");
}

export async function registerLeadMergeRoutes(app: FastifyInstance) {
  // Preflight é leitura (contagens + igualdade de telefone normalizado).
  app.post("/organization/leads/merge/preflight", async (request) => {
    const session = await requirePermission(request, "leads.read");
    const input = leadMergeIdsSchema.parse(request.body);
    await assertLeadsInScope(session, [input.source_id, input.target_id]);
    return preflightLeadMerge(session.tenantId, input.source_id, input.target_id);
  });

  // Mesclar exclui o source: mesma autorização da exclusão de leads.
  app.post("/organization/leads/merge", async (request) => {
    const session = await requirePermission(request, "leads.delete");
    const input = leadMergeSchema.parse(request.body);
    await assertLeadsInScope(session, [input.source_id, input.target_id]);
    return mergeLeads(
      session.tenantId,
      { sourceId: input.source_id, targetId: input.target_id, confirmations: input.confirmations },
      actor(session.userId, session.actorScope, request.ip, request.headers["user-agent"])
    );
  });
}
