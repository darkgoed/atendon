import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requirePermission } from "../../auth/session.js";
import { leadScopeCondition, resolveCaseScope } from "../../auth/case-scope.js";
import { db } from "../../db/client.js";
import { httpError, slug, uuid, withTransaction } from "../scheduling/service.js";
import { activationIssues, flowDefinitionSchema, DEFAULT_QUALIFICATION_FLOW } from "./flow.js";
import { simulateFlow, QualificationService } from "./service.js";

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
      `SELECT id,label,phone_number,is_primary,status,created_at FROM whatsapp_sessions
       WHERE tenant_id=$1 AND channel='whatsapp' AND archived_at IS NULL
       ORDER BY is_primary DESC, created_at DESC`,
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
        "SELECT id FROM whatsapp_sessions WHERE tenant_id=$1 AND channel='whatsapp' AND archived_at IS NULL AND id=ANY($2::uuid[])",
        [session.tenantId, definition.triggers.session_ids]
      );
      if (valid.rowCount !== definition.triggers.session_ids.length) throw httpError(400, "Uma ou mais sessões não pertencem à organização ou não são WhatsApp");
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

  // R22: histórico de execução do fluxo. Paginação keyset (created_at DESC, id DESC),
  // filtro opcional por conversa ("como entrou → o que aconteceu").
  const executionsQuery = z.object({
    conversation_id: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().max(500).optional()
  });

  function encodeExecutionCursor(row: { created_at: Date | string; id: string }): string {
    return Buffer.from(JSON.stringify({ created_at: new Date(row.created_at).toISOString(), id: row.id })).toString("base64url");
  }

  function decodeExecutionCursor(raw: string): { created_at: Date; id: string } {
    try {
      const parsed = z.object({ created_at: z.string().datetime(), id: uuid }).parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
      return { created_at: new Date(parsed.created_at), id: parsed.id };
    } catch {
      throw httpError(400, "Cursor inválido");
    }
  }

  app.get("/qualification/flows/:id/executions", async (request, reply) => {
    const session = await requirePermission(request, "agent.read");
    const { id } = z.object({ id: slug }).parse(request.params);
    const query = executionsQuery.parse(request.query);
    const flow = await db.query("SELECT 1 FROM qualification_flows WHERE tenant_id=$1 AND id=$2", [session.tenantId, id]);
    if (!flow.rows[0]) return reply.status(404).send({ error: "Fluxo não encontrado" });
    const conditions = ["tenant_id=$1", "flow_id=$2"];
    const params: unknown[] = [session.tenantId, id];
    if (query.conversation_id) {
      params.push(query.conversation_id);
      conditions.push(`conversation_id=$${params.length}::uuid`);
    }
    if (query.cursor) {
      const cursor = decodeExecutionCursor(query.cursor);
      params.push(cursor.created_at, cursor.id);
      conditions.push(`(created_at,id) < ($${params.length - 1},$${params.length})`);
    }
    params.push(query.limit + 1);
    const result = await db.query(
      `SELECT id,conversation_id,lead_id,node_id,kind,status,detail,created_at FROM flow_execution_log
       WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params
    );
    const hasMore = result.rows.length > query.limit;
    const executions = hasMore ? result.rows.slice(0, query.limit) : result.rows;
    return {
      executions,
      next_cursor: hasMore && executions.length ? encodeExecutionCursor(executions[executions.length - 1]) : null
    };
  });

  // Dry-run do editor: aceita camel/snake do chamador ({text|entrada|maxSteps|max_steps})
  // e devolve o traço determinístico. Zero efeito colateral (lição 2: grafo em memória).
  const simulateBody = z.object({
    definition: z.record(z.string(), z.unknown()),
    text: z.string().max(4_000).optional(),
    entrada: z.string().max(4_000).optional(),
    maxSteps: z.number().int().min(1).max(200).optional(),
    max_steps: z.number().int().min(1).max(200).optional()
  }).strict();

  app.post("/qualification/flows/:id/simulate", async (request) => {
    await requirePermission(request, "agent.read");
    const body = simulateBody.parse(request.body);
    const definition = flowDefinitionSchema.parse(body.definition);
    const trace = simulateFlow(definition, body.text ?? body.entrada ?? "", body.maxSteps ?? body.max_steps);
    return { trace: trace.map((item) => ({ ...item, nodeId: item.node_id })) };
  });

  const duplicateBody = z.object({ name: z.string().trim().min(1).max(200) }).strict();

  app.post("/qualification/flows/:id/duplicate", async (request, reply) => {
    const session = await requirePermission(request, "agent.manage");
    const { id } = z.object({ id: slug }).parse(request.params);
    const { name } = duplicateBody.parse(request.body);
    const source = await db.query<{ definition: unknown }>(
      "SELECT definition FROM qualification_flows WHERE tenant_id=$1 AND id=$2", [session.tenantId, id]
    );
    if (!source.rows[0]) return reply.status(404).send({ error: "Fluxo não encontrado" });
    const definition = flowDefinitionSchema.parse(source.rows[0].definition);
    const baseId = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "fluxo";
    let newId = baseId;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        // Duplicata nasce INATIVA (R25): a cópia precisa de revisão antes de assumir o tráfego.
        const inserted = await db.query(
          "INSERT INTO qualification_flows(tenant_id,id,name,active,definition) VALUES($1,$2,$3,false,$4) RETURNING *",
          [session.tenantId, newId, name, definition]
        );
        return reply.status(201).send({ flow: flowMapper(inserted.rows[0]) });
      } catch (error) {
        if ((error as { code?: string }).code !== "23505") throw error;
        newId = `${baseId}-${randomUUID().slice(0, 8)}`;
      }
    }
    throw httpError(409, "Não foi possível gerar um identificador único para o fluxo");
  });

  app.post("/scheduling/leads/:id/qualification/:acao", async (request, reply) => {
    const session = await requirePermission(request, "leads.update_status");
    const { id, acao } = z.object({ id: uuid, acao: z.enum(["pausar", "retomar", "reiniciar"]) }).parse(request.params);
    const scope = await resolveCaseScope(db, session);
    const visible = await db.query(
      `SELECT 1 FROM scheduling_leads lead
       WHERE lead.tenant_id=$1 AND lead.id=$2 AND lead.deleted_at IS NULL
         AND (${leadScopeCondition(scope, "lead", "$3")})`,
      [session.tenantId, id, scope.memberId]
    );
    if (!visible.rows[0]) return reply.status(404).send({ error: "Lead não encontrado" });
    const action = ({ pausar: "pause", retomar: "resume", reiniciar: "restart" } as const)[acao];
    return { qualificacao: await service.setFlowAction(session.tenantId, id, action) };
  });
}
