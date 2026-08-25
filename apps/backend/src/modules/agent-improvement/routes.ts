import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { requireRootWorkspace } from "../../auth/session.js";
import { db } from "../../db/client.js";
import { enqueueAiEvaluation } from "../../queue/ai-evaluation-queue.js";
import { diffVersions, listVersions, rollbackToVersion, type AgentVersionSnapshot } from "./versions.js";
import { RUBRIC_VERSION, sanitizeRegressionScenario, sanitizeRegressionText } from "./rubric.js";
import { ImprovementProposalService, publishProposal } from "./proposals.js";
import { OpenRouterClient } from "../ai-router/openrouter.js";
import { AVAILABLE_TOOL_NAMES } from "../ai-router/tools.js";
import { config } from "../../config.js";
import { enqueueAiReplay } from "../../queue/ai-replay-queue.js";
import { lockReplaySuite } from "./publication-authorization.js";

const versionParams = z.object({ id: z.string().uuid() });
const diffQuery = z.object({ against: z.string().uuid() });
const rollbackBody = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.literal("REVERTER")
});
const evaluationParams = z.object({ id: z.string().uuid() });
const evaluationListQuery = z.object({
  status: z.enum(["automatic", "confirmed", "rejected"]).optional(),
  issue: z.string().regex(/^[A-Z][A-Z0-9_]{2,80}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).catch(25),
  offset: z.coerce.number().int().min(0).catch(0)
});
const qualitySummaryQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional()
}).refine((value) => !value.from || !value.to || value.to >= value.from, "Período inválido");
const evaluationRunBody = z.object({ conversationId: z.string().uuid() });
const evaluationReviewBody = z.object({
  decision: z.enum(["confirm", "reject"]),
  note: z.string().trim().min(3).max(2_000)
});
const evaluatorSettingsBody = z.object({
  evaluatorModel: z.string().trim().min(1).max(200).nullable(),
  automaticEnabled: z.boolean(),
  proposalsEnabled: z.boolean().default(false),
  publicationEnabled: z.boolean().default(false)
}).refine((value) => !value.automaticEnabled || Boolean(value.evaluatorModel), {
  path: ["evaluatorModel"],
  message: "Escolha o modelo antes de habilitar avaliações automáticas"
}).refine((value) => !value.publicationEnabled || value.proposalsEnabled, {
  path: ["proposalsEnabled"],
  message: "Habilite propostas antes da publicação"
});
const regressionScenarioSchema = z.object({
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(4_096)
  })).max(100),
  targetMessage: z.string().trim().min(1).max(4_096),
  fixedTime: z.string().datetime(),
  context: z.record(z.string(), z.unknown()).default({})
});
const regressionExpectedSchema = z.object({
  required: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  forbidden: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  targetDimensions: z.array(z.string().trim().min(1).max(80)).min(1).max(7),
  simulatedTools: z.array(z.object({
    name: z.string().trim().min(1).max(100),
    arguments: z.record(z.string(), z.unknown()).optional(),
    result: z.string().max(4_000),
    transactionalOutcome: z.object({
      status: z.enum(["succeeded", "failed", "pending"]),
      claims: z.array(z.object({
        claimType: z.string().trim().min(1).max(100),
        normalizedValue: z.string().trim().min(1).max(2_000)
      })).min(1).max(30)
    }).optional()
  })).max(20).default([])
});
const regressionCaseBody = z.object({
  name: z.string().trim().min(3).max(200),
  description: z.string().trim().max(2_000).default(""),
  sourceConversationId: z.string().uuid().nullable().optional(),
  sourceEvaluationId: z.string().uuid().nullable().optional(),
  scenario: regressionScenarioSchema,
  expectedBehavior: regressionExpectedSchema,
  severity: z.enum(["critical", "high", "medium", "low"])
});
const regressionStatusBody = z.object({ isActive: z.boolean() });
const proposalGenerateBody = z.object({
  evaluationId: z.string().uuid().optional(),
  issueCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{2,80}$/)).min(1).max(20).optional()
}).refine((value) => value.evaluationId || value.issueCodes?.length, "Informe avaliação ou códigos de problema");
const proposalRejectBody = z.object({ note: z.string().trim().min(3).max(2_000) });
const proposalPublishBody = z.object({ confirmation: z.literal("PUBLICAR") });
const proposalCandidateEditBody = z.object({
  systemPrompt: z.string().min(1).refine((value) => value.trim().length > 0, "Informe as instruções do agente"),
  aiModel: z.string().trim().min(1).max(200),
  modelParams: z.object({
    temperature: z.number().min(0).max(2),
    max_tokens: z.number().int().min(64).max(8_192),
    reasoning_effort: z.enum(["low", "medium", "high"]).default("medium")
  }),
  enabledTools: z.array(z.string()).min(1).max(AVAILABLE_TOOL_NAMES.length)
    .refine((tools) => tools.every((tool) => AVAILABLE_TOOL_NAMES.includes(tool)), "Ferramenta fora do catálogo")
    .transform((tools) => [...new Set(tools)]),
  note: z.string().trim().min(3).max(2_000)
});

const proposalService = new ImprovementProposalService(db, new OpenRouterClient(config), config);

function sanitizeRegressionCase(body: z.infer<typeof regressionCaseBody>) {
  return {
    name: sanitizeRegressionText(body.name).slice(0, 200),
    description: sanitizeRegressionText(body.description).slice(0, 2_000),
    scenario: sanitizeRegressionScenario(body.scenario),
    expectedBehavior: sanitizeRegressionScenario(body.expectedBehavior)
  };
}

async function requireConfirmedEvaluation(client: PoolClient, tenantId: string, evaluationId?: string | null) {
  if (!evaluationId) return;
  const confirmed = await client.query(
    "SELECT 1 FROM ai_attendance_evaluations WHERE id=$1 AND tenant_id=$2 AND status='confirmed'",
    [evaluationId, tenantId]
  );
  if (!confirmed.rows[0]) {
    throw Object.assign(new Error("A avaliação de origem precisa estar confirmada"), { statusCode: 409 });
  }
}

export async function markReplayEnqueueFailure(runId: string, proposalId: string, tenantId: string) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE ai_evaluation_runs SET status='technical_error',
         error_message='Falha ao enfileirar replay',completed_at=now()
       WHERE id=$1 AND tenant_id=$2`,
      [runId, tenantId]
    );
    await client.query(
      `UPDATE ai_improvement_proposals SET status='test_failed',updated_at=now()
       WHERE id=$1 AND tenant_id=$2 AND status='testing'`,
      [proposalId, tenantId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function registerAgentImprovementRoutes(app: FastifyInstance) {
  app.get("/agent/evaluator-settings", async (request) => {
    const session = await requireRootWorkspace(request);
    const settings = await db.query(
      `SELECT evaluator_model,ai_evaluations_enabled,ai_proposals_enabled,ai_publication_enabled
       FROM tenant_ai_settings WHERE tenant_id=$1`,
      [session.tenantId]
    );
    return { settings: settings.rows[0] ?? {
      evaluator_model: null,
      ai_evaluations_enabled: false,
      ai_proposals_enabled: false,
      ai_publication_enabled: false
    } };
  });

  app.put("/agent/evaluator-settings", async (request) => {
    const session = await requireRootWorkspace(request);
    const body = evaluatorSettingsBody.parse(request.body);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const settings = await client.query(
        `UPDATE tenant_ai_settings SET
           evaluator_model=$2,ai_evaluations_enabled=$3,ai_proposals_enabled=$4,
           ai_publication_enabled=$5,updated_at=now()
         WHERE tenant_id=$1
         RETURNING evaluator_model,ai_evaluations_enabled,ai_proposals_enabled,ai_publication_enabled`,
        [session.tenantId, body.evaluatorModel, body.automaticEnabled,body.proposalsEnabled,body.publicationEnabled]
      );
      if (!settings.rows[0]) throw Object.assign(new Error("Configuração de IA não encontrada"), { statusCode: 404 });
      await client.query(
        `INSERT INTO audit_logs(
           actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent
         ) VALUES($1,$2,$3,'agent.evaluator.updated','tenant_ai_settings',$4,$5,$6,$7)`,
        [session.userId, session.tenantId, session.actorScope, session.tenantId, {
          evaluatorModel: body.evaluatorModel,
          automaticEnabled: body.automaticEnabled,
          proposalsEnabled: body.proposalsEnabled,
          publicationEnabled: body.publicationEnabled
        }, request.ip, request.headers["user-agent"] ?? null]
      );
      await client.query("COMMIT");
      return { settings: settings.rows[0] };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/agent/quality/summary", async (request) => {
    const session = await requireRootWorkspace(request);
    const query = qualitySummaryQuery.parse(request.query);
    const from = query.from ?? new Date(Date.now() - 30 * 86_400_000);
    const to = query.to ?? new Date();
    const [summary, dimensions, violations, trend, operations, usage, versionMetrics, lifecycle] = await Promise.all([
      db.query(
        `SELECT count(*)::int evaluations,
          round(COALESCE(avg(overall_score),0),2) overall_score,
          count(*) FILTER (WHERE has_critical_failure)::int critical_failures,
          count(*) FILTER (WHERE status='confirmed')::int confirmed,
          count(*) FILTER (WHERE status='rejected')::int rejected
         FROM ai_attendance_evaluations
         WHERE tenant_id=$1 AND created_at BETWEEN $2 AND $3`,
        [session.tenantId, from, to]
      ),
      db.query(
        `SELECT key dimension,round(avg((value->>'score')::numeric),2) score
         FROM ai_attendance_evaluations e
         CROSS JOIN LATERAL jsonb_each(e.scores)
         WHERE tenant_id=$1 AND created_at BETWEEN $2 AND $3
         GROUP BY key ORDER BY key`,
        [session.tenantId, from, to]
      ),
      db.query(
        `SELECT violation->>'code' code,violation->>'severity' severity,count(*)::int count
         FROM ai_attendance_evaluations e
         CROSS JOIN LATERAL jsonb_array_elements(e.violations) violation
         WHERE tenant_id=$1 AND created_at BETWEEN $2 AND $3
         GROUP BY 1,2 ORDER BY count DESC,code`,
        [session.tenantId, from, to]
      ),
      db.query(
        `SELECT to_char(date_trunc('day',created_at),'YYYY-MM-DD') AS "day",
          round(avg(overall_score),2) overall_score,count(*)::int evaluations
         FROM ai_attendance_evaluations
         WHERE tenant_id=$1 AND created_at BETWEEN $2 AND $3
         GROUP BY 1 ORDER BY 1`,
        [session.tenantId, from, to]
      ),
      db.query(
        `SELECT
          (SELECT count(*)::int FROM conversations c
           WHERE c.tenant_id=$1 AND c.last_message_at BETWEEN $2 AND $3) total_conversations,
          (SELECT count(*)::int FROM conversations c
           WHERE c.tenant_id=$1 AND c.handoff_reason IS NOT NULL AND c.last_message_at BETWEEN $2 AND $3) handoffs,
          round(100.0*(SELECT count(*) FROM conversations c
            WHERE c.tenant_id=$1 AND c.handoff_reason IS NOT NULL AND c.last_message_at BETWEEN $2 AND $3)/
            NULLIF((SELECT count(*) FROM conversations c
              WHERE c.tenant_id=$1 AND c.last_message_at BETWEEN $2 AND $3),0),2) handoff_rate_percent,
          (SELECT COALESCE(jsonb_object_agg(reason,count),'{}'::jsonb) FROM (
             SELECT c.handoff_reason reason,count(*)::int count FROM conversations c
             WHERE c.tenant_id=$1 AND c.handoff_reason IS NOT NULL AND c.last_message_at BETWEEN $2 AND $3
             GROUP BY c.handoff_reason
           ) handoff_counts) handoff_reasons,
          (SELECT count(*)::int FROM ai_tool_call_journal j
           WHERE j.tenant_id=$1 AND j.status='failed' AND j.created_at BETWEEN $2 AND $3) tool_errors,
          (SELECT count(*)::int FROM ai_evaluation_signals signal
           WHERE signal.tenant_id=$1 AND signal.kind='tool_limit' AND signal.created_at BETWEEN $2 AND $3) tool_limits,
          (SELECT count(*)::int FROM ai_evaluation_signals signal
           WHERE signal.tenant_id=$1 AND signal.kind='ai_error' AND signal.created_at BETWEEN $2 AND $3) ai_errors,
          (SELECT count(*)::int FROM ai_evaluation_signals signal
           WHERE signal.tenant_id=$1
             AND signal.kind IN ('repeated_offer','unnecessary_reconfirmation','open_scheduling_question','incorrect_slot_rejection')
             AND signal.created_at BETWEEN $2 AND $3) quality_signals,
          (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id=m.conversation_id
           WHERE c.tenant_id=$1 AND m.sender='agent' AND m.agent_config_version_id IS NULL
             AND m.created_at BETWEEN $2 AND $3) unversioned_agent_messages`,
        [session.tenantId, from, to]
      ),
      db.query(
        `SELECT purpose,count(*)::int calls,COALESCE(sum(input_tokens+output_tokens),0)::bigint tokens,
          COALESCE(sum(cost_usd),0)::numeric cost_usd
         FROM usage_logs WHERE tenant_id=$1 AND created_at BETWEEN $2 AND $3
         GROUP BY purpose ORDER BY purpose`,
        [session.tenantId, from, to]
      ),
      db.query(
        `SELECT v.id version_id,v.version_number,v.status,count(e.id)::int evaluations,
          round(COALESCE(avg(e.overall_score),0),2) overall_score,
          count(e.id) FILTER (WHERE e.has_critical_failure)::int critical_failures
         FROM agent_config_versions v
         LEFT JOIN ai_attendance_evaluations e ON e.agent_config_version_id=v.id
           AND e.tenant_id=v.tenant_id AND e.created_at BETWEEN $2 AND $3
         WHERE v.tenant_id=$1
         GROUP BY v.id,v.version_number,v.status ORDER BY v.version_number`,
        [session.tenantId, from, to]
      ),
      db.query(
        `WITH proposal_lifecycle AS (
           SELECT p.*,
             evidence.detected_at,evidence.confirmed_at
           FROM ai_improvement_proposals p
           LEFT JOIN LATERAL (
             SELECT min(e.created_at) detected_at,
               min(e.reviewed_at) FILTER (WHERE e.status='confirmed') confirmed_at
             FROM jsonb_array_elements_text(p.evidence_evaluation_ids) evidence_id
             JOIN ai_attendance_evaluations e
               ON e.id::text=evidence_id AND e.tenant_id=p.tenant_id
           ) evidence ON true
           WHERE p.tenant_id=$1 AND p.created_at BETWEEN $2 AND $3
         ), rollback_counts AS (
           SELECT count(DISTINCT source_proposal_id)::int reverted
           FROM agent_config_versions
           WHERE tenant_id=$1 AND source='rollback' AND source_proposal_id IS NOT NULL
             AND created_at BETWEEN $2 AND $3
         )
         SELECT count(*)::int generated,
           count(*) FILTER (WHERE status='rejected')::int rejected,
           count(*) FILTER (WHERE status='published')::int published,
           rollback_counts.reverted,
           round(100.0*rollback_counts.reverted/
             NULLIF(count(*) FILTER (WHERE status='published'),0),2) reverted_rate_percent,
           round(avg(extract(epoch FROM (confirmed_at-detected_at))/3600)
             FILTER (WHERE confirmed_at IS NOT NULL),2) detection_to_confirmation_hours,
           round(avg(extract(epoch FROM (published_at-detected_at))/3600)
             FILTER (WHERE published_at IS NOT NULL AND detected_at IS NOT NULL),2) detection_to_publication_hours,
           round(avg(extract(epoch FROM (published_at-confirmed_at))/3600)
             FILTER (WHERE published_at IS NOT NULL AND confirmed_at IS NOT NULL),2) confirmation_to_publication_hours
         FROM proposal_lifecycle CROSS JOIN rollback_counts
         GROUP BY rollback_counts.reverted`,
        [session.tenantId, from, to]
      )
    ]);
    return {
      from,to,summary:summary.rows[0],dimensions:dimensions.rows,violations:violations.rows,
      trend:trend.rows,operations:operations.rows[0],usage:usage.rows,version_metrics:versionMetrics.rows,
      lifecycle:lifecycle.rows[0] ?? {
        generated:0,rejected:0,published:0,reverted:0,reverted_rate_percent:null,
        detection_to_confirmation_hours:null,detection_to_publication_hours:null,
        confirmation_to_publication_hours:null
      }
    };
  });

  app.get("/agent/evaluations", async (request) => {
    const session = await requireRootWorkspace(request);
    const query = evaluationListQuery.parse(request.query);
    const values: unknown[] = [session.tenantId];
    const filters = ["e.tenant_id=$1"];
    if (query.status) { values.push(query.status); filters.push(`e.status=$${values.length}`); }
    if (query.issue) {
      values.push(JSON.stringify([{ code: query.issue }]));
      filters.push(`e.violations @> $${values.length}::jsonb`);
    }
    values.push(query.limit, query.offset);
    const result = await db.query(
      `SELECT e.id,e.conversation_id,e.agent_config_version_id,e.trigger,e.rubric_version,
        e.overall_score,e.has_critical_failure,e.summary,e.violations,e.status,e.reviewed_at,e.created_at,
        count(*) OVER()::int total
       FROM ai_attendance_evaluations e
       WHERE ${filters.join(" AND ")}
       ORDER BY e.created_at DESC,e.id DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { evaluations: result.rows, total: result.rows[0]?.total ?? 0, limit: query.limit, offset: query.offset };
  });

  app.get("/agent/evaluations/:id", async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const { id } = evaluationParams.parse(request.params);
    const result = await db.query(
      `SELECT e.*,u.email reviewed_by_email
       FROM ai_attendance_evaluations e
       LEFT JOIN users u ON u.id=e.reviewed_by_user_id
       WHERE e.id=$1 AND e.tenant_id=$2`,
      [id, session.tenantId]
    );
    if (!result.rows[0]) return reply.status(404).send({ error: "Avaliação não encontrada" });
    const evidenceIds = Array.from(new Set((result.rows[0].violations as Array<{ evidenceMessageIds?: string[] }>)
      .flatMap((violation) => violation.evidenceMessageIds ?? []))).slice(0, 100);
    const evidence = evidenceIds.length ? await db.query(
      `SELECT m.id,m.sender,left(m.content,500) excerpt,m.created_at
       FROM messages m JOIN conversations c ON c.id=m.conversation_id
       WHERE c.tenant_id=$1 AND c.id=$2 AND m.id=ANY($3::uuid[])
       ORDER BY m.created_at,m.id`,
      [session.tenantId, result.rows[0].conversation_id, evidenceIds]
    ) : { rows: [] };
    return { evaluation: result.rows[0], evidence: evidence.rows };
  });

  app.post("/agent/evaluations/run", async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const body = evaluationRunBody.parse(request.body);
    const target = await db.query<{ agent_config_version_id: string }>(
      `SELECT m.agent_config_version_id
       FROM conversations c
       JOIN messages m ON m.conversation_id=c.id
       JOIN tenant_ai_settings s ON s.tenant_id=c.tenant_id
       WHERE c.id=$2 AND c.tenant_id=$1 AND m.sender='agent'
         AND m.agent_config_version_id IS NOT NULL AND s.evaluator_model IS NOT NULL
       ORDER BY m.created_at DESC,m.id DESC LIMIT 1`,
      [session.tenantId, body.conversationId]
    );
    if (!target.rows[0]) return reply.status(409).send({ error: "Conversa inelegível ou modelo avaliador não configurado" });
    await enqueueAiEvaluation({
      tenantId: session.tenantId,
      conversationId: body.conversationId,
      agentConfigVersionId: target.rows[0].agent_config_version_id,
      trigger: "manual"
    });
    await db.query(
      `INSERT INTO audit_logs(
         actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent
       ) VALUES($1,$2,$3,'agent.evaluation.manual_queued','conversation',$4,$5,$6,$7)`,
      [session.userId, session.tenantId, session.actorScope, body.conversationId,
        { agentConfigVersionId: target.rows[0].agent_config_version_id }, request.ip, request.headers["user-agent"] ?? null]
    );
    return reply.status(202).send({ status: "queued" });
  });

  app.post("/agent/evaluations/:id/review", async (request) => {
    const session = await requireRootWorkspace(request);
    const { id } = evaluationParams.parse(request.params);
    const body = evaluationReviewBody.parse(request.body);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE ai_attendance_evaluations SET
           status=$3,reviewed_by_user_id=$4,reviewed_at=now(),updated_at=now()
         WHERE id=$1 AND tenant_id=$2 AND status='automatic'
         RETURNING *`,
        [id, session.tenantId, body.decision === "confirm" ? "confirmed" : "rejected", session.userId]
      );
      if (!updated.rows[0]) {
        const exists = await client.query("SELECT 1 FROM ai_attendance_evaluations WHERE id=$1 AND tenant_id=$2", [id, session.tenantId]);
        throw Object.assign(new Error(exists.rows[0] ? "Avaliação já revisada" : "Avaliação não encontrada"), {
          statusCode: exists.rows[0] ? 409 : 404
        });
      }
      await client.query(
        `INSERT INTO audit_logs(
           actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent
         ) VALUES($1,$2,$3,$4,'ai_attendance_evaluation',$5,$6,$7,$8)`,
        [session.userId, session.tenantId, session.actorScope,
          body.decision === "confirm" ? "agent.evaluation.confirmed" : "agent.evaluation.rejected",
          id, { note: body.note }, request.ip, request.headers["user-agent"] ?? null]
      );
      await client.query("COMMIT");
      return { evaluation: updated.rows[0] };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/agent/regression-cases", async (request) => {
    const session = await requireRootWorkspace(request);
    const result = await db.query(
      `SELECT c.*,u.email created_by_email
       FROM ai_regression_cases c LEFT JOIN users u ON u.id=c.created_by_user_id
       WHERE c.tenant_id=$1 ORDER BY c.is_active DESC,c.created_at DESC`,
      [session.tenantId]
    );
    return { cases: result.rows };
  });

  app.post("/agent/regression-cases", async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const body = regressionCaseBody.parse(request.body);
    const sanitized = sanitizeRegressionCase(body);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await lockReplaySuite(client, session.tenantId);
      await requireConfirmedEvaluation(client, session.tenantId, body.sourceEvaluationId);
      const result = await client.query(
        `INSERT INTO ai_regression_cases(
           tenant_id,name,description,source_conversation_id,source_evaluation_id,
           scenario,expected_behavior,severity,created_by_user_id
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [session.tenantId, sanitized.name, sanitized.description, body.sourceConversationId ?? null,
          body.sourceEvaluationId ?? null, sanitized.scenario, sanitized.expectedBehavior, body.severity, session.userId]
      );
      await client.query(
        `INSERT INTO audit_logs(
           actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent
         ) VALUES($1,$2,$3,'agent.regression_case.created','ai_regression_case',$4,$5,$6,$7)`,
        [session.userId, session.tenantId, session.actorScope, result.rows[0].id,
          { severity: body.severity }, request.ip, request.headers["user-agent"] ?? null]
      );
      await client.query("COMMIT");
      return reply.status(201).send({ case: result.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/agent/regression-cases/preview", async (request) => {
    await requireRootWorkspace(request);
    const body = regressionCaseBody.parse(request.body);
    const sanitized = sanitizeRegressionCase(body);
    return {
      case: {
        ...body,
        ...sanitized
      }
    };
  });

  app.put("/agent/regression-cases/:id", async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const { id } = evaluationParams.parse(request.params);
    const body = regressionCaseBody.parse(request.body);
    const sanitized = sanitizeRegressionCase(body);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await lockReplaySuite(client, session.tenantId);
      await requireConfirmedEvaluation(client, session.tenantId, body.sourceEvaluationId);
      const result = await client.query(
        `UPDATE ai_regression_cases SET
           name=$3,description=$4,source_conversation_id=$5,source_evaluation_id=$6,
           scenario=$7,expected_behavior=$8,severity=$9,updated_at=now()
         WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        [id, session.tenantId, sanitized.name, sanitized.description, body.sourceConversationId ?? null,
          body.sourceEvaluationId ?? null, sanitized.scenario,
          sanitized.expectedBehavior, body.severity]
      );
      if (!result.rows[0]) { await client.query("ROLLBACK"); return reply.status(404).send({ error: "Caso não encontrado" }); }
      await client.query(
        `INSERT INTO audit_logs(
           actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent
         ) VALUES($1,$2,$3,'agent.regression_case.updated','ai_regression_case',$4,$5,$6,$7)`,
        [session.userId,session.tenantId,session.actorScope,id,{ severity:body.severity },request.ip,request.headers["user-agent"]??null]
      );
      await client.query("COMMIT");
      return { case: result.rows[0] };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  });

  app.patch("/agent/regression-cases/:id/status", async (request) => {
    const session = await requireRootWorkspace(request);
    const { id } = evaluationParams.parse(request.params);
    const body = regressionStatusBody.parse(request.body);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await lockReplaySuite(client, session.tenantId);
      const result = await client.query(
        `UPDATE ai_regression_cases SET is_active=$3,updated_at=now()
         WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        [id, session.tenantId, body.isActive]
      );
      if (!result.rows[0]) throw Object.assign(new Error("Caso não encontrado"), { statusCode: 404 });
      await client.query(
        `INSERT INTO audit_logs(
           actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent
         ) VALUES($1,$2,$3,'agent.regression_case.status_changed','ai_regression_case',$4,$5,$6,$7)`,
        [session.userId, session.tenantId, session.actorScope, id,
          { isActive: body.isActive }, request.ip, request.headers["user-agent"] ?? null]
      );
      await client.query("COMMIT");
      return { case: result.rows[0] };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/agent/improvement-proposals", async (request) => {
    const session = await requireRootWorkspace(request);
    const result = await db.query(
      `SELECT p.*,b.version_number baseline_version_number,c.version_number candidate_version_number,
        (SELECT status FROM ai_evaluation_runs r WHERE r.proposal_id=p.id AND r.tenant_id=p.tenant_id
         ORDER BY r.created_at DESC LIMIT 1) latest_run_status
       FROM ai_improvement_proposals p
       JOIN agent_config_versions b ON b.id=p.baseline_version_id AND b.tenant_id=p.tenant_id
       JOIN agent_config_versions c ON c.id=p.candidate_version_id AND c.tenant_id=p.tenant_id
       WHERE p.tenant_id=$1 ORDER BY p.created_at DESC`,
      [session.tenantId]
    );
    return { proposals: result.rows };
  });

  app.get("/agent/improvement-proposals/:id", async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const { id } = evaluationParams.parse(request.params);
    const proposal = await db.query(
      `SELECT p.*,row_to_json(b) baseline_version,row_to_json(c) candidate_version
       FROM ai_improvement_proposals p
       JOIN agent_config_versions b ON b.id=p.baseline_version_id AND b.tenant_id=p.tenant_id
       JOIN agent_config_versions c ON c.id=p.candidate_version_id AND c.tenant_id=p.tenant_id
       WHERE p.id=$1 AND p.tenant_id=$2`,
      [id, session.tenantId]
    );
    if (!proposal.rows[0]) return reply.status(404).send({ error: "Proposta não encontrada" });
    const runs = await db.query(
      `SELECT r.*,(SELECT count(*)::int FROM ai_evaluation_case_results cr WHERE cr.run_id=r.id) case_count
       FROM ai_evaluation_runs r WHERE r.proposal_id=$1 AND r.tenant_id=$2 ORDER BY r.created_at DESC`,
      [id, session.tenantId]
    );
    const caseResults = await db.query(
      `SELECT cr.*,rc.name case_name,rc.severity
       FROM ai_evaluation_case_results cr
       JOIN ai_evaluation_runs r ON r.id=cr.run_id AND r.tenant_id=cr.tenant_id
       JOIN ai_regression_cases rc ON rc.id=cr.regression_case_id AND rc.tenant_id=cr.tenant_id
       WHERE r.proposal_id=$1 AND r.tenant_id=$2
       ORDER BY r.created_at DESC,rc.severity,rc.name`,
      [id, session.tenantId]
    );
    return { proposal: proposal.rows[0], runs: runs.rows, caseResults: caseResults.rows };
  });

  app.post("/agent/improvement-proposals/generate", async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const body = proposalGenerateBody.parse(request.body);
    const result = await proposalService.generate({
      tenantId: session.tenantId,
      evaluationId: body.evaluationId,
      issueCodes: body.issueCodes,
      userId: session.userId,
      actorScope: session.actorScope,
      ipAddress: request.ip,
      userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined
    });
    return reply.status(201).send(result);
  });

  app.put("/agent/improvement-proposals/:id/candidate", async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const { id } = evaluationParams.parse(request.params);
    const body = proposalCandidateEditBody.parse(request.body);
    const client = await db.connect();
    let runId = "";
    let candidateVersionId = "";
    try {
      await client.query("BEGIN");
      const proposal = await client.query<{
        baseline_version_id: string;
        candidate_version_id: string;
        agent_config_id: string;
        status: string;
      }>(
        `SELECT p.baseline_version_id,p.candidate_version_id,c.agent_config_id,p.status
         FROM ai_improvement_proposals p
         JOIN agent_config_versions c ON c.id=p.candidate_version_id AND c.tenant_id=p.tenant_id
         WHERE p.id=$1 AND p.tenant_id=$2 FOR UPDATE OF p`,
        [id, session.tenantId]
      );
      if (!proposal.rows[0]) throw Object.assign(new Error("Proposta não encontrada"), { statusCode: 404 });
      if (!["draft", "proposed", "test_failed", "ready"].includes(proposal.rows[0].status)) {
        throw Object.assign(new Error("A candidata não pode ser editada neste estado"), { statusCode: 409 });
      }
      const next = await client.query<{ version_number: number }>(
        `SELECT COALESCE(max(version_number),0)+1 version_number
         FROM agent_config_versions WHERE agent_config_id=$1`,
        [proposal.rows[0].agent_config_id]
      );
      await client.query(
        `UPDATE agent_config_versions SET status='rejected'
         WHERE id=$1 AND tenant_id=$2 AND status='candidate'`,
        [proposal.rows[0].candidate_version_id, session.tenantId]
      );
      candidateVersionId = (await client.query<{ id: string }>(
        `INSERT INTO agent_config_versions(
           tenant_id,agent_config_id,version_number,source,status,system_prompt,ai_model,
           model_params,enabled_tools,created_by_user_id,source_proposal_id
         ) VALUES($1,$2,$3,'proposal','candidate',$4,$5,$6,$7::jsonb,$8,$9)
         RETURNING id`,
        [session.tenantId, proposal.rows[0].agent_config_id, next.rows[0].version_number,
          body.systemPrompt, body.aiModel, body.modelParams, JSON.stringify(body.enabledTools),
          session.userId, id]
      )).rows[0].id;
      await client.query(
        `UPDATE ai_improvement_proposals SET
           candidate_version_id=$3,status='testing',reviewed_by_user_id=$4,
           review_note=$5,reviewed_at=now(),updated_at=now()
         WHERE id=$1 AND tenant_id=$2`,
        [id, session.tenantId, candidateVersionId, session.userId, body.note]
      );
      runId = (await client.query<{ id: string }>(
        `INSERT INTO ai_evaluation_runs(
           tenant_id,proposal_id,baseline_version_id,candidate_version_id,rubric_version,status
         ) VALUES($1,$2,$3,$4,$5,'queued') RETURNING id`,
        [session.tenantId, id, proposal.rows[0].baseline_version_id, candidateVersionId, RUBRIC_VERSION]
      )).rows[0].id;
      await client.query(
        `INSERT INTO audit_logs(
           actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent
         ) VALUES($1,$2,$3,'agent.improvement.candidate_edited','ai_improvement_proposal',$4,$5,$6,$7)`,
        [session.userId, session.tenantId, session.actorScope, id, {
          previousCandidateVersionId: proposal.rows[0].candidate_version_id,
          candidateVersionId,
          runId,
          note: body.note
        }, request.ip, request.headers["user-agent"] ?? null]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
    try {
      await enqueueAiReplay(runId);
    } catch (error) {
      await markReplayEnqueueFailure(runId, id, session.tenantId);
      throw error;
    }
    return reply.status(202).send({ candidateVersionId, runId, status: "queued" });
  });

  app.post("/agent/improvement-proposals/:id/reject", async (request) => {
    const session = await requireRootWorkspace(request);
    const { id } = evaluationParams.parse(request.params);
    const body = proposalRejectBody.parse(request.body);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const proposal = await client.query<{ candidate_version_id: string }>(
        `UPDATE ai_improvement_proposals SET status='rejected',reviewed_by_user_id=$3,
           review_note=$4,reviewed_at=now(),updated_at=now()
         WHERE id=$1 AND tenant_id=$2 AND status IN ('draft','proposed','test_failed','ready')
         RETURNING candidate_version_id`,
        [id, session.tenantId, session.userId, body.note]
      );
      if (!proposal.rows[0]) {
        const exists = await client.query("SELECT 1 FROM ai_improvement_proposals WHERE id=$1 AND tenant_id=$2", [id, session.tenantId]);
        throw Object.assign(new Error(exists.rows[0] ? "Proposta não pode ser rejeitada neste estado" : "Proposta não encontrada"), {
          statusCode: exists.rows[0] ? 409 : 404
        });
      }
      await client.query(
        "UPDATE agent_config_versions SET status='rejected' WHERE id=$1 AND tenant_id=$2 AND status='candidate'",
        [proposal.rows[0].candidate_version_id, session.tenantId]
      );
      await client.query(
        `INSERT INTO audit_logs(
           actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent
         ) VALUES($1,$2,$3,'agent.improvement.rejected','ai_improvement_proposal',$4,$5,$6,$7)`,
        [session.userId, session.tenantId, session.actorScope, id, { note: body.note },
          request.ip, request.headers["user-agent"] ?? null]
      );
      await client.query("COMMIT");
      return { status: "rejected" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  });

  app.post("/agent/improvement-proposals/:id/test", async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const { id } = evaluationParams.parse(request.params);
    const client = await db.connect();
    let runId = "";
    try {
      await client.query("BEGIN");
      const proposal = await client.query<{
        baseline_version_id: string;
        candidate_version_id: string;
        status: string;
      }>(
        `SELECT baseline_version_id,candidate_version_id,status
         FROM ai_improvement_proposals WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
        [id, session.tenantId]
      );
      if (!proposal.rows[0]) throw Object.assign(new Error("Proposta não encontrada"), { statusCode: 404 });
      if (!['proposed', 'test_failed', 'ready'].includes(proposal.rows[0].status)) {
        throw Object.assign(new Error("Proposta não pode ser testada neste estado"), { statusCode: 409 });
      }
      const run = await client.query<{ id: string }>(
        `INSERT INTO ai_evaluation_runs(
           tenant_id,proposal_id,baseline_version_id,candidate_version_id,rubric_version,status
         ) VALUES($1,$2,$3,$4,$5,'queued') RETURNING id`,
        [session.tenantId, id, proposal.rows[0].baseline_version_id,
          proposal.rows[0].candidate_version_id, RUBRIC_VERSION]
      );
      runId = run.rows[0].id;
      await client.query(
        "UPDATE ai_improvement_proposals SET status='testing',updated_at=now() WHERE id=$1 AND tenant_id=$2",
        [id, session.tenantId]
      );
      await client.query(
        `INSERT INTO audit_logs(
           actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent
         ) VALUES($1,$2,$3,'agent.improvement.test_queued','ai_improvement_proposal',$4,$5,$6,$7)`,
        [session.userId,session.tenantId,session.actorScope,id,{ runId },request.ip,request.headers["user-agent"]??null]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
    try {
      await enqueueAiReplay(runId);
    } catch (error) {
      await markReplayEnqueueFailure(runId, id, session.tenantId);
      throw error;
    }
    return reply.status(202).send({ runId, status: "queued" });
  });

  app.post("/agent/improvement-proposals/:id/publish", async (request) => {
    const session = await requireRootWorkspace(request);
    const { id } = evaluationParams.parse(request.params);
    proposalPublishBody.parse(request.body);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const version = await publishProposal(client, {
        tenantId: session.tenantId,
        proposalId: id,
        userId: session.userId,
        actorScope: session.actorScope,
        ipAddress: request.ip,
        userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined
      });
      await client.query("COMMIT");
      return { version };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  });

  app.get("/agent/versions", async (request) => {
    const session = await requireRootWorkspace(request);
    return { versions: await listVersions(db, session.tenantId) };
  });

  app.get("/agent/versions/:id/diff", async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const { id } = versionParams.parse(request.params);
    const { against } = diffQuery.parse(request.query);
    const versions = await db.query<AgentVersionSnapshot>(
      `SELECT v.* FROM agent_config_versions v
       JOIN agent_configs a ON a.id=v.agent_config_id AND a.tenant_id=v.tenant_id
       WHERE v.tenant_id=$1 AND v.id=ANY($2::uuid[])`,
      [session.tenantId, [id, against]]
    );
    const target = versions.rows.find((version) => version.id === id);
    const baseline = versions.rows.find((version) => version.id === against);
    if (!target || !baseline) return reply.status(404).send({ error: "Versão não encontrada" });
    if (target.agent_config_id !== baseline.agent_config_id) {
      return reply.status(409).send({ error: "As versões pertencem a agentes diferentes" });
    }
    return { baseline, target, diff: diffVersions(baseline, target) };
  });

  app.post("/agent/versions/:id/rollback", async (request, reply) => {
    const session = await requireRootWorkspace(request);
    const { id } = versionParams.parse(request.params);
    const body = rollbackBody.parse(request.body);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const version = await rollbackToVersion(client, {
        tenantId: session.tenantId,
        sourceVersionId: id,
        reason: body.reason,
        userId: session.userId,
        actorScope: session.actorScope,
        ipAddress: request.ip,
        userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined
      });
      await client.query("COMMIT");
      return reply.status(201).send({ version });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}
