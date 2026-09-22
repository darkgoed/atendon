import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requirePermission } from "../../auth/session.js";
import { leadScopeCondition, resolveCaseScope } from "../../auth/case-scope.js";
import { db } from "../../db/client.js";
import { httpError, slug, uuid, withTransaction } from "../scheduling/service.js";
import { activationIssues, flowDefinitionSchema, DEFAULT_QUALIFICATION_FLOW, type FlowDefinition } from "./flow.js";
import { simulateFlow, QualificationService } from "./service.js";

const flowUpsertBody = z.object({
  nome: z.string().trim().min(1).max(200),
  ativo: z.boolean().default(false),
  ctwa: z.boolean().optional(),
  sessoes: z.array(uuid).max(100).optional(),
  palavras_chave: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  definition: z.record(z.string(), z.unknown()).optional(),
  // F4-r1 (WP-B, B2/B5): CAS obrigatório em TODA mutação. 0 = criação nova;
  // ≥1 precisa igualar a revisão viva da linha.
  revisao_base: z.number().int().min(0)
}).strict();

function flowMapper(row: Record<string, unknown>) {
  const definition = row.definition as { origem?: string; triggers?: unknown };
  return {
    id: row.id, tenant: row.tenant_id, nome: row.name, ativo: row.active,
    origem: definition?.origem,
    gatilhos: definition?.triggers ?? { ctwa: false, session_ids: [], keywords: [] },
    allowed_role_ids: row.allowed_role_ids ?? [],
    definition: row.definition, revisao: row.revision, atualizado_em: row.updated_at
  };
}

// F4-r1 (WP-B, decisões B1-B6): CAS por revisão de linha. O token é a coluna
// qualification_flows.revision (trigger BEFORE UPDATE incrementa em QUALQUER
// UPDATE — migration 0182), nunca derivado de snapshot. Toda mutação exige
// revisao_base: 0 só cria (fluxo existente ⇒ 409); ≥1 precisa igualar a revisão
// viva; divergente ⇒ 409 FLOW_VERSION_CONFLICT com a revisão corrente, sem
// gravar nada (nem snapshot fantasma).
class FlowVersionConflict extends Error {
  constructor(readonly revisao: number) {
    super("Conflito de versão do fluxo — recarregue a revisão atual e tente novamente");
  }
}

/** CAS (B2/B4): compara revisao_base com a revisão viva LIDA DENTRO do lock por tenant. */
function assertFlowCas(existing: { revision: number } | undefined, revisaoBase: number): void {
  const current = existing?.revision;
  if (revisaoBase === 0) {
    if (current !== undefined) throw new FlowVersionConflict(current);
    return;
  }
  if (current === undefined || current !== revisaoBase) throw new FlowVersionConflict(current ?? 0);
}

/** B3: serialização transacional por tenant (padrão billing/ledger.ts:17) —
 *  criação concorrente, upsert, ativação, restore e PATCH passam por este lock,
 *  tomado como PRIMEIRO statement da transação (guards desde o começo da tx). */
async function lockTenantFlows(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('flow:' || $1))", [tenantId]);
}

/** Referências do tenant em triggers (sessões) e steps action (tags/estágios/
 *  agentes) — validadas DENTRO da tx no PUT e no RESTORE (400 acionável). */
async function assertDefinitionTenantRefs(client: PoolClient, tenantId: string, definition: FlowDefinition): Promise<void> {
  const sessionIds = definition.triggers.session_ids;
  if (sessionIds.length) {
    const valid = await client.query<{ id: string }>(
      "SELECT id FROM whatsapp_sessions WHERE tenant_id=$1 AND channel='whatsapp' AND archived_at IS NULL AND id=ANY($2::uuid[])",
      [tenantId, sessionIds]
    );
    if (valid.rowCount !== sessionIds.length) throw httpError(400, "Uma ou mais sessões não pertencem à organização ou não são WhatsApp");
  }
  const tagIds = [...new Set(Object.values(definition.steps).flatMap((step) => step.tag_ids ?? []))];
  if (tagIds.length) {
    const valid = await client.query<{ id: string }>("SELECT id FROM lead_tags WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [tenantId, tagIds]);
    if (valid.rowCount !== tagIds.length) throw httpError(400, "Uma ou mais tags não pertencem à organização");
  }
  const stageIds = [...new Set(Object.values(definition.steps).map((step) => step.stage_id).filter((stageId): stageId is string => Boolean(stageId)))];
  if (stageIds.length) {
    const valid = await client.query<{ id: string }>("SELECT id FROM pipeline_stages WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [tenantId, stageIds]);
    if (valid.rowCount !== stageIds.length) throw httpError(400, "Um ou mais estágios não pertencem à organização");
  }
  const agentIds = [...new Set(Object.values(definition.steps).map((step) => step.agent_id).filter((agentId): agentId is string => Boolean(agentId)))];
  if (agentIds.length) {
    const valid = await client.query<{ id: string }>(
      "SELECT id FROM workspace_members WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND status='active'", [tenantId, agentIds]
    );
    if (valid.rowCount !== agentIds.length) throw httpError(400, "Um ou mais agentes não pertencem à organização");
  }
}

/** Versão nova por salvamento/restauração: snapshot serializado sob lock do fluxo. */
async function insertFlowVersion(
  client: PoolClient,
  tenantId: string,
  flowId: string,
  definition: unknown,
  flowName: string,
  createdBy: string | null
): Promise<number> {
  const next = await client.query<{ version: number }>(
    "SELECT COALESCE(MAX(version),0)+1 AS version FROM flow_versions WHERE tenant_id=$1 AND flow_id=$2",
    [tenantId, flowId]
  );
  const version = next.rows[0].version;
  await client.query(
    "INSERT INTO flow_versions(tenant_id,flow_id,version,definition,flow_name,created_by) VALUES($1,$2,$3,$4,$5,$6)",
    [tenantId, flowId, version, definition, flowName, createdBy]
  );
  return version;
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
    try {
      const result = await withTransaction(async (client) => {
        // B3/B4: lock por tenant ANTES de qualquer leitura; a definition do fluxo
        // vivo é lida e mesclada DENTRO do lock (stale-read eliminado) e o
        // snapshot da versão é gravado na MESMA transação do upsert.
        await lockTenantFlows(client, session.tenantId);
        const existing = await client.query<{ definition: Record<string, unknown>; revision: number }>(
          "SELECT definition,revision FROM qualification_flows WHERE tenant_id=$1 AND id=$2", [session.tenantId, id]
        );
        assertFlowCas(existing.rows[0], body.revisao_base);
        const base = (body.definition ?? existing.rows[0]?.definition ?? DEFAULT_QUALIFICATION_FLOW) as Record<string, unknown>;
        const previousTriggers = typeof base.triggers === "object" && base.triggers ? base.triggers as Record<string, unknown> : {};
        const triggers = {
          ...previousTriggers,
          ...(body.ctwa !== undefined ? { ctwa: body.ctwa } : {}),
          ...(body.sessoes !== undefined ? { session_ids: body.sessoes } : {}),
          ...(body.palavras_chave !== undefined ? { keywords: body.palavras_chave } : {})
        };
        const definition = flowDefinitionSchema.parse({ ...base, triggers });
        await assertDefinitionTenantRefs(client, session.tenantId, definition);
        if (body.ativo) {
          const issues = activationIssues(definition);
          if (issues.length) throw httpError(400, issues.join("; "));
        }
        if (body.ativo) await client.query("UPDATE qualification_flows SET active=false,updated_at=now() WHERE tenant_id=$1 AND id<>$2 AND active", [session.tenantId, id]);
        const upserted = await client.query(
          `INSERT INTO qualification_flows(tenant_id,id,name,active,definition) VALUES($1,$2,$3,$4,$5)
           ON CONFLICT (tenant_id,id) DO UPDATE SET name=EXCLUDED.name,active=EXCLUDED.active,definition=EXCLUDED.definition,updated_at=now()
           RETURNING *,(xmax=0) AS created`, [session.tenantId, id, body.nome, body.ativo, definition]
        );
        if (body.definition) {
          await insertFlowVersion(client, session.tenantId, id, definition, body.nome, session.userId);
        }
        return upserted;
      });
      return reply.status(result.rows[0].created ? 201 : 200).send({ flow: flowMapper(result.rows[0]) });
    } catch (error) {
      if (error instanceof FlowVersionConflict) {
        return reply.status(409).send({ error: error.message, code: "FLOW_VERSION_CONFLICT", revisao: error.revisao });
      }
      throw error;
    }
  });

  // C1-c: restrição opcional de execução por papel (vazio = sem restrição).
  // B5: nome/ativo também por PATCH — bypass REMOVIDO, toda mutação é
  // CAS-guardada (revisao_base obrigatório) e o trigger incrementa a revisão.
  const flowPatchBody = z.object({
    allowed_role_ids: z.array(uuid).max(100).optional(),
    nome: z.string().trim().min(1).max(200).optional(),
    ativo: z.boolean().optional(),
    revisao_base: z.number().int().min(0)
  }).strict().refine(
    (body) => body.allowed_role_ids !== undefined || body.nome !== undefined || body.ativo !== undefined,
    { message: "Informe ao menos um campo: allowed_role_ids, nome ou ativo" }
  );

  app.patch("/qualification/flows/:id", async (request, reply) => {
    const session = await requirePermission(request, "agent.manage");
    const { id } = z.object({ id: slug }).parse(request.params);
    const body = flowPatchBody.parse(request.body);
    const roles = body.allowed_role_ids !== undefined ? [...new Set(body.allowed_role_ids)] : undefined;
    try {
      const updated = await withTransaction(async (client) => {
        await lockTenantFlows(client, session.tenantId);
        if (roles?.length) {
          const valid = await client.query<{ id: string }>(
            "SELECT id FROM workspace_roles WHERE workspace_id=$1 AND id=ANY($2::uuid[])",
            [session.tenantId, roles]
          );
          if (valid.rowCount !== roles.length) throw httpError(400, "Um ou mais papéis não pertencem à organização");
        }
        const current = await client.query<{ revision: number; active: boolean; definition: unknown }>(
          "SELECT revision,active,definition FROM qualification_flows WHERE tenant_id=$1 AND id=$2", [session.tenantId, id]
        );
        if (!current.rows[0]) throw httpError(404, "Fluxo não encontrado");
        assertFlowCas(current.rows[0], body.revisao_base);
        // Ativação via PATCH passa pelo mesmo gate do PUT (grafo válidos + 1 ativo/tenant).
        if (body.ativo && !current.rows[0].active) {
          const issues = activationIssues(flowDefinitionSchema.parse(current.rows[0].definition));
          if (issues.length) throw httpError(400, issues.join("; "));
        }
        if (body.ativo === true) await client.query("UPDATE qualification_flows SET active=false,updated_at=now() WHERE tenant_id=$1 AND id<>$2 AND active", [session.tenantId, id]);
        const result = await client.query(
          `UPDATE qualification_flows SET
             name=COALESCE($3,name),active=COALESCE($4,active),allowed_role_ids=COALESCE($5,allowed_role_ids),updated_at=now()
           WHERE tenant_id=$1 AND id=$2 RETURNING *`,
          [session.tenantId, id, body.nome ?? null, body.ativo ?? null, roles ?? null]
        );
        return result.rows[0];
      });
      return { flow: flowMapper(updated) };
    } catch (error) {
      if (error instanceof FlowVersionConflict) {
        return reply.status(409).send({ error: error.message, code: "FLOW_VERSION_CONFLICT", revisao: error.revisao });
      }
      throw error;
    }
  });

  // C1-b: histórico de versões (snapshot por salvamento/restauração).
  // Keyset por version DESC (inteiro monotônico, cursor exato — sem µs).
  const versionsQuery = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().max(500).optional()
  });

  app.get("/qualification/flows/:id/versions", async (request, reply) => {
    const session = await requirePermission(request, "agent.read");
    const { id } = z.object({ id: slug }).parse(request.params);
    const query = versionsQuery.parse(request.query);
    const flow = await db.query("SELECT 1 FROM qualification_flows WHERE tenant_id=$1 AND id=$2", [session.tenantId, id]);
    if (!flow.rows[0]) return reply.status(404).send({ error: "Fluxo não encontrado" });
    const conditions = ["tenant_id=$1", "flow_id=$2"];
    const params: unknown[] = [session.tenantId, id];
    if (query.cursor) {
      const decoded = z.object({ version: z.number().int().min(1) }).safeParse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")));
      if (!decoded.success) throw httpError(400, "Cursor inválido");
      params.push(decoded.data.version);
      conditions.push(`version < $${params.length}`);
    }
    params.push(query.limit + 1);
    const result = await db.query<{ id: string; version: number; flow_name: string; created_by: string | null; created_at: Date }>(
      `SELECT id,version,flow_name,created_by,created_at FROM flow_versions
       WHERE ${conditions.join(" AND ")} ORDER BY version DESC LIMIT $${params.length}`,
      params
    );
    const hasMore = result.rows.length > query.limit;
    const versions = hasMore ? result.rows.slice(0, query.limit) : result.rows;
    return {
      versions,
      next_cursor: hasMore && versions.length
        ? Buffer.from(JSON.stringify({ version: versions[versions.length - 1].version })).toString("base64url")
        : null
    };
  });

  // C1-b: diff entre duas versões — nós adicionados/removidos/modificados e
  // conexões (edges derivadas de next/transitions/on_* com rótulo da saída).
  type FlowEdge = { from: string; to: string; label: string };

  function definitionEdges(definition: FlowDefinition): FlowEdge[] {
    const edges = new Map<string, FlowEdge>();
    for (const [id, step] of Object.entries(definition.steps)) {
      for (const [label, target] of Object.entries(step.transitions ?? {})) {
        edges.set(`${id}>${target}|${label}`, { from: id, to: target, label });
      }
      if (step.next) edges.set(`${id}>${step.next}|next`, { from: id, to: step.next, label: "next" });
      if (step.on_timeout) edges.set(`${id}>${step.on_timeout}|on_timeout`, { from: id, to: step.on_timeout, label: "on_timeout" });
      if (step.on_invalid_reply) edges.set(`${id}>${step.on_invalid_reply}|on_invalid_reply`, { from: id, to: step.on_invalid_reply, label: "on_invalid_reply" });
    }
    return [...edges.values()];
  }

  function edgeKey(edge: FlowEdge): string {
    return `${edge.from}>${edge.to}|${edge.label}`;
  }

  app.get("/qualification/flows/:id/versions/diff", async (request, reply) => {
    const session = await requirePermission(request, "agent.read");
    const { id } = z.object({ id: slug }).parse(request.params);
    const { from, to } = z.object({ from: z.coerce.number().int().min(1), to: z.coerce.number().int().min(1) }).parse(request.query);
    const flow = await db.query("SELECT 1 FROM qualification_flows WHERE tenant_id=$1 AND id=$2", [session.tenantId, id]);
    if (!flow.rows[0]) return reply.status(404).send({ error: "Fluxo não encontrado" });
    const result = await db.query<{ version: number; definition: unknown; created_at: Date }>(
      "SELECT version,definition,created_at FROM flow_versions WHERE tenant_id=$1 AND flow_id=$2 AND version IN ($3,$4) ORDER BY version",
      [session.tenantId, id, Math.min(from, to), Math.max(from, to)]
    );
    if (result.rows.length !== 2) return reply.status(404).send({ error: "Uma das versões não existe" });
    const fromRow = result.rows.find((row) => row.version === from)!;
    const toRow = result.rows.find((row) => row.version === to)!;
    const fromDefinition = flowDefinitionSchema.parse(fromRow.definition);
    const toDefinition = flowDefinitionSchema.parse(toRow.definition);
    const fromIds = new Set(Object.keys(fromDefinition.steps));
    const toIds = new Set(Object.keys(toDefinition.steps));
    const modified = Object.keys(toDefinition.steps)
      .filter((stepId) => fromIds.has(stepId) && JSON.stringify(fromDefinition.steps[stepId]) !== JSON.stringify(toDefinition.steps[stepId]));
    const fromEdges = new Map(definitionEdges(fromDefinition).map((edge) => [edgeKey(edge), edge]));
    const toEdges = new Map(definitionEdges(toDefinition).map((edge) => [edgeKey(edge), edge]));
    return {
      from: { version: fromRow.version, created_at: fromRow.created_at },
      to: { version: toRow.version, created_at: toRow.created_at },
      diff: {
        added: [...toIds].filter((stepId) => !fromIds.has(stepId)),
        removed: [...fromIds].filter((stepId) => !toIds.has(stepId)),
        modified,
        edges: {
          added: [...toEdges.values()].filter((edge) => !fromEdges.has(edgeKey(edge))),
          removed: [...fromEdges.values()].filter((edge) => !toEdges.has(edgeKey(edge)))
        }
      }
    };
  });

  // C1-b: restauração — definição da versão volta ao fluxo e um snapshot NOVO
  // é criado (a versão restaurada permanece no histórico). B6: revalida refs do
  // tenant E ativação (mesmo gate do PUT); CAS revisao_base obrigatório.
  const restoreBody = z.object({ revisao_base: z.number().int().min(0) }).strict();

  app.post("/qualification/flows/:id/versions/:versionId/restore", async (request, reply) => {
    const session = await requirePermission(request, "agent.manage");
    const { id, versionId } = z.object({ id: slug, versionId: uuid }).parse(request.params);
    const body = restoreBody.parse(request.body);
    try {
      const result = await withTransaction(async (client) => {
        await lockTenantFlows(client, session.tenantId);
        const flow = await client.query<{ name: string; active: boolean; revision: number }>(
          "SELECT name,active,revision FROM qualification_flows WHERE tenant_id=$1 AND id=$2", [session.tenantId, id]
        );
        if (!flow.rows[0]) throw httpError(404, "Fluxo não encontrado");
        assertFlowCas(flow.rows[0], body.revisao_base);
        const version = await client.query<{ definition: unknown; version: number }>(
          "SELECT definition,version FROM flow_versions WHERE tenant_id=$1 AND flow_id=$2 AND id=$3",
          [session.tenantId, id, versionId]
        );
        if (!version.rows[0]) throw httpError(404, "Versão não encontrada");
        const definition = flowDefinitionSchema.parse(version.rows[0].definition);
        await assertDefinitionTenantRefs(client, session.tenantId, definition);
        if (flow.rows[0].active) {
          const issues = activationIssues(definition);
          if (issues.length) throw httpError(400, issues.join("; "));
        }
        const updated = await client.query(
          "UPDATE qualification_flows SET definition=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *",
          [session.tenantId, id, definition]
        );
        const newVersion = await insertFlowVersion(client, session.tenantId, id, definition, flow.rows[0].name, session.userId);
        return { flow: updated.rows[0], restored_from: version.rows[0].version, version: newVersion };
      });
      return reply.status(200).send({ flow: flowMapper(result.flow), restored_from: result.restored_from, version: result.version });
    } catch (error) {
      if (error instanceof FlowVersionConflict) {
        return reply.status(409).send({ error: error.message, code: "FLOW_VERSION_CONFLICT", revisao: error.revisao });
      }
      if (error instanceof z.ZodError) throw httpError(409, "A versão armazenada não é mais válida para o schema atual");
      throw error;
    }
  });

  // C1-f: templates de fluxo — snapshots nomeados por tenant (salvar/carregar).
  const templateCreateBody = z.object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(500).optional(),
    definition: z.record(z.string(), z.unknown())
  }).strict();
  const templateUpdateBody = z.object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    definition: z.record(z.string(), z.unknown()).optional()
  }).strict();

  function templateMapper(row: Record<string, unknown>, withDefinition = false) {
    return {
      id: row.id, nome: row.name, descricao: row.description ?? null,
      criado_em: row.created_at, atualizado_em: row.updated_at,
      ...(withDefinition ? { definition: row.definition } : {})
    };
  }

  app.get("/qualification/flow-templates", async (request) => {
    const session = await requirePermission(request, "agent.read");
    const result = await db.query(
      "SELECT id,name,description,created_at,updated_at FROM flow_templates WHERE tenant_id=$1 ORDER BY updated_at DESC",
      [session.tenantId]
    );
    return { templates: result.rows.map((row) => templateMapper(row)) };
  });

  app.get("/qualification/flow-templates/:id", async (request, reply) => {
    const session = await requirePermission(request, "agent.read");
    const { id } = z.object({ id: uuid }).parse(request.params);
    const result = await db.query("SELECT * FROM flow_templates WHERE tenant_id=$1 AND id=$2", [session.tenantId, id]);
    return result.rows[0]
      ? { template: templateMapper(result.rows[0], true) }
      : reply.status(404).send({ error: "Template não encontrado" });
  });

  app.post("/qualification/flow-templates", async (request, reply) => {
    const session = await requirePermission(request, "agent.manage");
    const body = templateCreateBody.parse(request.body);
    const definition = flowDefinitionSchema.parse(body.definition);
    try {
      const inserted = await db.query(
        `INSERT INTO flow_templates(tenant_id,name,description,definition,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [session.tenantId, body.name, body.description ?? null, definition, session.userId]
      );
      return reply.status(201).send({ template: templateMapper(inserted.rows[0], true) });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw httpError(409, "Já existe um template com este nome");
      throw error;
    }
  });

  app.put("/qualification/flow-templates/:id", async (request, reply) => {
    const session = await requirePermission(request, "agent.manage");
    const { id } = z.object({ id: uuid }).parse(request.params);
    const body = templateUpdateBody.parse(request.body);
    if (body.definition) {
      flowDefinitionSchema.parse(body.definition); // 400 (Zod) quando inválido
    }
    try {
      const updated = await db.query(
        `UPDATE flow_templates SET
           name=COALESCE($3,name),
           description=CASE WHEN $4::text IS NOT NULL THEN $4 ELSE description END,
           definition=COALESCE($5::jsonb,definition),updated_at=now()
         WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [session.tenantId, id, body.name ?? null, body.description ?? null, body.definition ?? null]
      );
      if (!updated.rows[0]) return reply.status(404).send({ error: "Template não encontrado" });
      return { template: templateMapper(updated.rows[0], true) };
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw httpError(409, "Já existe um template com este nome");
      throw error;
    }
  });

  app.delete("/qualification/flow-templates/:id", async (request, reply) => {
    const session = await requirePermission(request, "agent.manage");
    const { id } = z.object({ id: uuid }).parse(request.params);
    const deleted = await db.query("DELETE FROM flow_templates WHERE tenant_id=$1 AND id=$2", [session.tenantId, id]);
    if (!deleted.rowCount) return reply.status(404).send({ error: "Template não encontrado" });
    return reply.status(204).send();
  });

  // C1-d: agregados do flow_execution_log para o painel (auto-refresh no client).
  app.get("/qualification/flows/:id/analytics", async (request, reply) => {
    const session = await requirePermission(request, "agent.read");
    const { id } = z.object({ id: slug }).parse(request.params);
    const flow = await db.query("SELECT 1 FROM qualification_flows WHERE tenant_id=$1 AND id=$2", [session.tenantId, id]);
    if (!flow.rows[0]) return reply.status(404).send({ error: "Fluxo não encontrado" });
    const result = await db.query<{ executions: number; completed: number; errors: number }>(
      `SELECT
         COUNT(DISTINCT lead_id)::int AS executions,
         COUNT(*) FILTER (WHERE kind IN ('final','finalize') AND status='completed')::int AS completed,
         COUNT(*) FILTER (WHERE status='failed')::int AS errors
       FROM flow_execution_log WHERE tenant_id=$1 AND flow_id=$2`,
      [session.tenantId, id]
    );
    const analytics = result.rows[0];
    return { executions: analytics.executions, completed: analytics.completed, errors: analytics.errors };
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
