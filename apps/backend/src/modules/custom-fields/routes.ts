import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "../../db/client.js";
import { requirePermission, type WorkspaceSession } from "../../auth/session.js";
import { leadScopeCondition, resolveCaseScope, type CaseScope } from "../../auth/case-scope.js";
import {
  createCustomField,
  customFieldCreateSchema,
  customFieldUpdateSchema,
  deleteCustomField,
  listCustomFields,
  listLeadCustomValues,
  leadCustomValueSchema,
  setLeadCustomValue,
  updateCustomField
} from "./service.js";

const fieldIdParams = z.object({ fieldId: z.string().uuid() });
const leadIdParams = z.object({ leadId: z.string().uuid() });

function actor(request: FastifyRequest, session: Awaited<ReturnType<typeof requirePermission>>) {
  return {
    userId: session.userId,
    actorScope: session.actorScope,
    ipAddress: request.ip,
    userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined
  };
}

// Espelhos de internal/routes.ts: escopo de caso por lead (gestor vê tudo,
// operador só o próprio) + leads inexistentes/na lixeira viram 404.
function leadReadScopeCondition(scope: CaseScope, alias: string, memberParameter: string): string {
  if (scope.type === "workspace") return `(${memberParameter}::uuid IS NULL OR ${memberParameter}::uuid IS NOT NULL)`;
  if (!scope.memberId) return "FALSE";
  return `(${alias}.assigned_member_id=${memberParameter} OR ${alias}.sdr_member_id=${memberParameter} OR ${alias}.closer_member_id=${memberParameter} OR ${alias}.recovery_member_id=${memberParameter})`;
}

async function canReadLead(session: WorkspaceSession, scope: CaseScope, leadId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM scheduling_leads lead
     WHERE lead.tenant_id=$1 AND lead.id=$2 AND lead.deleted_at IS NULL
       AND (${leadReadScopeCondition(scope, "lead", "$3")})`,
    [session.tenantId, leadId, scope.memberId]
  );
  return Boolean(result.rows[0]);
}

async function canAccessLead(session: WorkspaceSession, scope: CaseScope, leadId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM scheduling_leads lead
     WHERE lead.tenant_id=$1 AND lead.id=$2 AND lead.deleted_at IS NULL
       AND (${leadScopeCondition(scope, "lead", "$3")})`,
    [session.tenantId, leadId, scope.memberId]
  );
  return Boolean(result.rows[0]);
}

export async function registerCustomFieldRoutes(app: FastifyInstance) {
  app.get("/organization/custom-fields", async (request) => {
    const session = await requirePermission(request, "fields.manage");
    return { fields: await listCustomFields(session.tenantId) };
  });

  app.post("/organization/custom-fields", async (request, reply) => {
    const input = customFieldCreateSchema.parse(request.body);
    const session = await requirePermission(request, "fields.manage");
    const field = await createCustomField(session.tenantId, input, actor(request, session));
    return reply.status(201).send({ field });
  });

  app.patch("/organization/custom-fields/:fieldId", async (request) => {
    const { fieldId } = fieldIdParams.parse(request.params);
    const input = customFieldUpdateSchema.parse(request.body);
    const session = await requirePermission(request, "fields.manage");
    return { field: await updateCustomField(session.tenantId, fieldId, input, actor(request, session)) };
  });

  app.delete("/organization/custom-fields/:fieldId", async (request) => {
    const { fieldId } = fieldIdParams.parse(request.params);
    const session = await requirePermission(request, "fields.manage");
    return deleteCustomField(session.tenantId, fieldId, actor(request, session));
  });

  // Valores do lead junto ao perfil (R7): leitura liberada para quem lê leads,
  // escopada ao caso e a leads fora da lixeira (inexistente/outro/na lixeira → 404).
  app.get("/organization/leads/:leadId/custom-values", async (request, reply) => {
    const session = await requirePermission(request, "leads.read");
    const { leadId } = leadIdParams.parse(request.params);
    const scope = await resolveCaseScope(db, session);
    if (!await canReadLead(session, scope, leadId)) return reply.status(404).send({ error: "Lead não encontrado" });
    return listLeadCustomValues(session.tenantId, leadId);
  });

  app.put("/organization/leads/:leadId/custom-values", async (request, reply) => {
    const session = await requirePermission(request, "fields.manage");
    const { leadId } = leadIdParams.parse(request.params);
    const scope = await resolveCaseScope(db, session);
    if (!await canAccessLead(session, scope, leadId)) return reply.status(404).send({ error: "Lead não encontrado" });
    const input = leadCustomValueSchema.parse(request.body);
    return setLeadCustomValue(session, leadId, input, actor(request, session));
  });
}
