import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission } from "../../auth/session.js";
import { leadScopeCondition, resolveCaseScope } from "../../auth/case-scope.js";
import { db } from "../../db/client.js";
import { httpError, slug, uuid, withTransaction } from "../scheduling/service.js";
import { activationIssues, flowDefinitionSchema, DEFAULT_QUALIFICATION_FLOW } from "./flow.js";
import { QualificationService } from "./service.js";

const flowUpsertBody = z.object({
  nome: z.string().trim().min(1).max(200),
  ativo: z.boolean().default(false),
  ctwa: z.boolean().optional(),
  sessoes: z.array(uuid).max(100).optional(),
  palavras_chave: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  definition: z.record(z.string(), z.unknown()).optional()
}).strict();

function flowMapper(row: Record<string, unknown>) {
  const definition = row.definition as { origem?: string; triggers?: unknown };
  return {
    id: row.id, tenant: row.tenant_id, nome: row.name, ativo: row.active,
    origem: definition?.origem,
    gatilhos: definition?.triggers ?? { ctwa: false, session_ids: [], keywords: [] },
    definition: row.definition, atualizado_em: row.updated_at
  };
}

export async function registerQualificationRoutes(app: FastifyInstance) {
  const service = new QualificationService();

  app.get("/qualification/flows", async (request) => {
    const session = await requirePermission(request, "agent.read");
    const result = await db.query("SELECT * FROM qualification_flows WHERE tenant_id=$1 ORDER BY updated_at DESC", [session.tenantId]);
    return { flows: result.rows.map(flowMapper) };
  });

  app.get("/qualification/flows/:id", async (request, reply) => {
    const session = await requirePermission(request, "agent.read");
    const { id } = z.object({ id: slug }).parse(request.params);
    const result = await db.query("SELECT * FROM qualification_flows WHERE tenant_id=$1 AND id=$2", [session.tenantId, id]);
    return result.rows[0] ? { flow: flowMapper(result.rows[0]) } : reply.status(404).send({ error: "Fluxo não encontrado" });
  });

  app.get("/qualification/sessions", async (request) => {
    const session = await requirePermission(request, "agent.read");
    const result = await db.query(
      "SELECT id,phone_number,status,created_at FROM whatsapp_sessions WHERE tenant_id=$1 ORDER BY created_at DESC",
      [session.tenantId]
    );
    return { sessions: result.rows };
  });

  app.put("/qualification/flows/:id", async (request, reply) => {
    const session = await requirePermission(request, "agent.manage");
    const { id } = z.object({ id: slug }).parse(request.params);
    const body = flowUpsertBody.parse(request.body);
    const existing = body.definition ? null : await db.query<{ definition: Record<string, unknown> }>(
      "SELECT definition FROM qualification_flows WHERE tenant_id=$1 AND id=$2", [session.tenantId, id]
    );
    const base = (body.definition ?? existing?.rows[0]?.definition ?? DEFAULT_QUALIFICATION_FLOW) as Record<string, unknown>;
    const previousTriggers = typeof base.triggers === "object" && base.triggers ? base.triggers as Record<string, unknown> : {};
    const triggers = {
      ...previousTriggers,
      ...(body.ctwa !== undefined ? { ctwa: body.ctwa } : {}),
      ...(body.sessoes !== undefined ? { session_ids: body.sessoes } : {}),
      ...(body.palavras_chave !== undefined ? { keywords: body.palavras_chave } : {})
    };
    const definition = flowDefinitionSchema.parse({ ...base, triggers });
    if (definition.triggers.session_ids.length) {
      const valid = await db.query<{ id: string }>(
        "SELECT id FROM whatsapp_sessions WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
        [session.tenantId, definition.triggers.session_ids]
      );
      if (valid.rowCount !== definition.triggers.session_ids.length) throw httpError(400, "Uma ou mais sessões não pertencem à organização");
    }
    if (body.ativo) {
      const issues = activationIssues(definition);
      if (issues.length) throw httpError(400, issues.join("; "));
    }
    const result = await withTransaction(async (client) => {
      if (body.ativo) await client.query("UPDATE qualification_flows SET active=false,updated_at=now() WHERE tenant_id=$1 AND id<>$2 AND active", [session.tenantId, id]);
      return client.query(
        `INSERT INTO qualification_flows(tenant_id,id,name,active,definition) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id,id) DO UPDATE SET name=EXCLUDED.name,active=EXCLUDED.active,definition=EXCLUDED.definition,updated_at=now()
         RETURNING *,(xmax=0) AS created`, [session.tenantId, id, body.nome, body.ativo, definition]
      );
    });
    return reply.status(result.rows[0].created ? 201 : 200).send({ flow: flowMapper(result.rows[0]) });
  });

  app.post("/scheduling/leads/:id/qualification/:acao", async (request, reply) => {
    const session = await requirePermission(request, "leads.update_status");
    const { id, acao } = z.object({ id: uuid, acao: z.enum(["pausar", "retomar", "reiniciar"]) }).parse(request.params);
    const scope = await resolveCaseScope(db, session);
    const visible = await db.query(
      `SELECT 1 FROM scheduling_leads lead
       WHERE lead.tenant_id=$1 AND lead.id=$2
         AND (${leadScopeCondition(scope, "lead", "$3")})`,
      [session.tenantId, id, scope.memberId]
    );
    if (!visible.rows[0]) return reply.status(404).send({ error: "Lead não encontrado" });
    const action = ({ pausar: "pause", retomar: "resume", reiniciar: "restart" } as const)[acao];
    return { qualificacao: await service.setFlowAction(session.tenantId, id, action) };
  });
}
