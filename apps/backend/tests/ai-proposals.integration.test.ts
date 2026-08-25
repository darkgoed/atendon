import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSessionToken } from "../src/auth/session.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import type { AiRouter } from "../src/modules/ai-router/openrouter.js";
import { ImprovementProposalService, publishProposal } from "../src/modules/agent-improvement/proposals.js";
import { rollbackToVersion } from "../src/modules/agent-improvement/versions.js";
import { buildReplayPublicationAuthorization } from "../src/modules/agent-improvement/publication-authorization.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
let tenantId = "";
let userId = "";
let rootCookie = "";
let evaluationId = "";
let baselineId = "";
let conversationId = "";
let proposalId = "";
let candidateId = "";

beforeAll(async () => {
  await app.ready();
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`Proposal ${randomUUID()}`]
  )).rows[0].id;
  const rootEmail = `proposal-${randomUUID()}@example.com`;
  userId = (await pool.query<{ id: string }>(
    "INSERT INTO users(email,status,is_root) VALUES($1,'active',true) RETURNING id",
    [rootEmail]
  )).rows[0].id;
  rootCookie = `atendon_session=${await createSessionToken({
    userId,
    tenantId,
    email: rootEmail,
    isRoot: true,
    rootWorkspaceAccess: true
  })}`;
  const sessionId = (await pool.query<{ id: string }>(
    "INSERT INTO whatsapp_sessions(tenant_id) VALUES($1) RETURNING id",
    [tenantId]
  )).rows[0].id;
  const agentId = (await pool.query<{ id: string }>(
    `INSERT INTO agent_configs(tenant_id,system_prompt,ai_model,enabled_tools)
     VALUES($1,'Prompt base','model/base','["registrar_lead"]') RETURNING id`,
    [tenantId]
  )).rows[0].id;
  baselineId = (await pool.query<{ active_version_id: string }>(
    "SELECT active_version_id FROM agent_configs WHERE id=$1",
    [agentId]
  )).rows[0].active_version_id;
  conversationId = (await pool.query<{ id: string }>(
    "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3) RETURNING id",
    [tenantId, sessionId, `5511${Date.now().toString().slice(-8)}`]
  )).rows[0].id;
  const messageId = (await pool.query<{ id: string }>(
    `INSERT INTO messages(conversation_id,sender,content,agent_config_version_id)
     VALUES($1,'agent','Resposta repetida',$2) RETURNING id`,
    [conversationId, baselineId]
  )).rows[0].id;
  evaluationId = (await pool.query<{ id: string }>(
    `INSERT INTO ai_attendance_evaluations(
       tenant_id,conversation_id,agent_config_version_id,trigger,rubric_version,evaluator_model,
       evaluator_prompt_version,scores,violations,overall_score,has_critical_failure,summary,status
     ) VALUES($1,$2,$3,'manual','v1','model/evaluator','v1','{}',$4,70,false,'Repete perguntas','confirmed')
     RETURNING id`,
    [tenantId, conversationId, baselineId, JSON.stringify([{
      code: "NEAR_DUPLICATE_QUESTION",
      dimension: "continuity",
      severity: "medium",
      confidence: 1,
      evidenceMessageIds: [messageId],
      detail: "Repete"
    }])]
  )).rows[0].id;
  await pool.query(
    "UPDATE tenant_ai_settings SET evaluator_model='model/evaluator',ai_proposals_enabled=true,ai_publication_enabled=true WHERE tenant_id=$1",
    [tenantId]
  );
});

afterAll(async () => {
  if (tenantId) await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  if (userId) await pool.query("DELETE FROM audit_logs WHERE actor_user_id=$1", [userId]);
  if (userId) await pool.query("DELETE FROM users WHERE id=$1", [userId]);
  await pool.end();
  await app.close();
});

describe("AI improvement proposals", () => {
  it("sanitizes regression metadata and preserves simulated tool names in preview and storage", async () => {
    const payload = {
      name: "Caso ana@example.com",
      description: "Ligar +55 11 99999-1234 via https://private.example com token abcdefghijklmnop",
      scenario: {
        history: [{ role: "user", content: "Preciso de atendimento" }],
        targetMessage: "Ajude o contato",
        fixedTime: "2035-02-01T10:00:00.000Z",
        context: { password: "CorrectHorseBatteryStaple", segmento: "varejo" }
      },
      expectedBehavior: {
        required: ["Registrar o lead"],
        forbidden: [],
        targetDimensions: ["task_completion"],
        simulatedTools: [{
          name: "registrar_lead",
          arguments: { nome: "Ana Souza", unidade_id: "centro" },
          result: "Lead registrado"
        }]
      },
      severity: "medium"
    };
    const preview = await app.inject({
      method: "POST",
      url: "/agent/regression-cases/preview",
      headers: { cookie: rootCookie },
      payload
    });
    expect(preview.statusCode).toBe(200);
    const previewText = JSON.stringify(preview.json().case);
    for (const privateValue of ["ana@example.com", "99999-1234", "private.example", "abcdefghijklmnop", "CorrectHorseBatteryStaple", "Ana Souza"]) {
      expect(previewText).not.toContain(privateValue);
    }
    expect(preview.json().case.expectedBehavior.simulatedTools[0]).toMatchObject({
      name: "registrar_lead",
      arguments: { unidade_id: "centro" }
    });

    const created = await app.inject({
      method: "POST",
      url: "/agent/regression-cases",
      headers: { cookie: rootCookie },
      payload
    });
    expect(created.statusCode).toBe(201);
    const stored = (await pool.query(
      "SELECT name,description,scenario,expected_behavior FROM ai_regression_cases WHERE id=$1",
      [created.json().case.id]
    )).rows[0];
    const storedText = JSON.stringify(stored);
    for (const privateValue of ["ana@example.com", "99999-1234", "private.example", "abcdefghijklmnop", "CorrectHorseBatteryStaple", "Ana Souza"]) {
      expect(storedText).not.toContain(privateValue);
    }
    expect(stored.expected_behavior.simulatedTools[0].name).toBe("registrar_lead");
  });

  it("creates a complete immutable candidate and publishes only after ready", async () => {
    const complete = vi.fn<AiRouter["complete"]>().mockResolvedValue({
      text: JSON.stringify({
        title: "Evitar perguntas repetidas",
        rationale: "Ajusta a continuidade sem alterar permissões ou integrações.",
        candidate: {
          systemPrompt: "Prompt candidato sem repetição",
          aiModel: "model/base",
          modelParams: { temperature: 0, max_tokens: 512 },
          enabledTools: ["registrar_lead"]
        },
        risks: ["Pode ficar conciso demais"],
        expectedImpact: { continuity: 8 },
        targetDimensions: ["continuity"]
      }),
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0
    });
    const service = new ImprovementProposalService(pool, { complete }, config);
    const generated = await service.generate({
      tenantId,
      evaluationId,
      userId,
      actorScope: "root"
    });
    proposalId = generated.proposal.id;
    candidateId = generated.candidate.id;
    expect(generated.proposal).toMatchObject({
      baseline_version_id: baselineId,
      candidate_version_id: generated.candidate.id,
      status: "proposed",
      target_issue_codes: ["NEAR_DUPLICATE_QUESTION"]
    });
    expect(generated.candidate).toMatchObject({
      source: "proposal",
      status: "candidate",
      system_prompt: "Prompt candidato sem repetição"
    });
    await expect(pool.query(
      "UPDATE agent_config_versions SET source_proposal_id=NULL WHERE id=$1",
      [generated.candidate.id]
    )).rejects.toThrow(/immutable/);

    const publish = async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const version = await publishProposal(client, {
          tenantId,
          proposalId: generated.proposal.id,
          userId,
          actorScope: "root"
        });
        await client.query("COMMIT");
        return version;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    };
    await expect(publish()).rejects.toThrow("Somente proposta pronta");
    await pool.query("UPDATE ai_improvement_proposals SET status='ready' WHERE id=$1", [generated.proposal.id]);
    await expect(publish()).rejects.toThrow("replay aprovado");
    const authorization = await buildReplayPublicationAuthorization(pool, {
      tenantId,
      baseline: (await pool.query("SELECT * FROM agent_config_versions WHERE id=$1", [baselineId])).rows[0],
      candidate: generated.candidate
    });
    await pool.query(
      `INSERT INTO ai_evaluation_runs(
         tenant_id,proposal_id,baseline_version_id,candidate_version_id,rubric_version,
         status,aggregate_metrics,completed_at
       ) VALUES($1,$2,$3,$4,'v1','passed',$5,now())`,
      [tenantId, generated.proposal.id, baselineId, generated.candidate.id, {
        publicationAuthorization: authorization
      }]
    );
    await expect(publish()).resolves.toMatchObject({ id: generated.candidate.id });
    const state = await pool.query(
      `SELECT p.status proposal_status,b.status baseline_status,c.status candidate_status,
        a.active_version_id,a.system_prompt,
        (SELECT count(*)::int FROM audit_logs log WHERE log.workspace_id=p.tenant_id
          AND log.action='agent.improvement.published' AND log.resource_id=p.id::text) audit_count
       FROM ai_improvement_proposals p
       JOIN agent_config_versions b ON b.id=p.baseline_version_id
       JOIN agent_config_versions c ON c.id=p.candidate_version_id
       JOIN agent_configs a ON a.tenant_id=p.tenant_id
       WHERE p.id=$1`,
      [generated.proposal.id]
    );
    expect(state.rows[0]).toMatchObject({
      proposal_status: "published",
      baseline_status: "retired",
      candidate_status: "active",
      active_version_id: generated.candidate.id,
      system_prompt: "Prompt candidato sem repetição",
      audit_count: 1
    });
  });

  it("rejects publication when the tested baseline is no longer active", async () => {
    const complete = vi.fn<AiRouter["complete"]>().mockResolvedValue({
      text: JSON.stringify({
        title: "Segunda melhoria",
        rationale: "Mantém a continuidade com uma candidata completa e testável.",
        candidate: {
          systemPrompt: "Segunda candidata",
          aiModel: "model/base",
          modelParams: { temperature: 0, max_tokens: 512 },
          enabledTools: ["registrar_lead"]
        },
        risks: [],
        expectedImpact: { continuity: 6 },
        targetDimensions: ["continuity"]
      }),
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0
    });
    const service = new ImprovementProposalService(pool, { complete }, config);
    const generated = await service.generate({ tenantId, evaluationId, userId, actorScope: "root" });
    await pool.query("UPDATE ai_improvement_proposals SET status='ready' WHERE id=$1", [generated.proposal.id]);

    const manual = await pool.connect();
    try {
      await manual.query("BEGIN");
      await rollbackToVersion(manual, {
        tenantId,
        sourceVersionId: generated.candidate.id,
        reason: "Mudança concorrente de baseline para validar o bloqueio",
        userId,
        actorScope: "root"
      });
      await manual.query("COMMIT");
    } finally { manual.release(); }

    const publish = async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await publishProposal(client, {
          tenantId,
          proposalId: generated.proposal.id,
          userId,
          actorScope: "root"
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    };
    await expect(publish()).rejects.toMatchObject({ statusCode: 409 });
  });

  it("removes deleted conversation evidence without breaking version and run history", async () => {
    const runId = (await pool.query<{ id: string }>(
      `INSERT INTO ai_evaluation_runs(
         tenant_id,proposal_id,baseline_version_id,candidate_version_id,rubric_version,status,completed_at
       ) VALUES($1,$2,$3,$4,'v1','passed',now()) RETURNING id`,
      [tenantId, proposalId, baselineId, candidateId]
    )).rows[0].id;

    const otherTenantId = (await pool.query<{ id:string }>(
      "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
      [`Other proposal ${randomUUID()}`]
    )).rows[0].id;
    const otherSessionId = (await pool.query<{ id:string }>(
      "INSERT INTO whatsapp_sessions(tenant_id) VALUES($1) RETURNING id",
      [otherTenantId]
    )).rows[0].id;
    const otherAgentId = (await pool.query<{ id:string }>(
      "INSERT INTO agent_configs(tenant_id,system_prompt,ai_model) VALUES($1,'Outro','model/base') RETURNING id",
      [otherTenantId]
    )).rows[0].id;
    const otherVersionId = (await pool.query<{ active_version_id:string }>(
      "SELECT active_version_id FROM agent_configs WHERE id=$1",
      [otherAgentId]
    )).rows[0].active_version_id;
    const otherConversationId = (await pool.query<{ id:string }>(
      `INSERT INTO conversations(tenant_id,session_id,contact_phone)
       VALUES($1,$2,$3) RETURNING id`,
      [otherTenantId, otherSessionId, `5511${Date.now().toString().slice(-8)}`]
    )).rows[0].id;
    const otherEvaluationId = (await pool.query<{ id:string }>(
      `INSERT INTO ai_attendance_evaluations(
         tenant_id,conversation_id,agent_config_version_id,trigger,rubric_version,
         evaluator_model,evaluator_prompt_version,scores,overall_score,summary
       ) VALUES($1,$2,$3,'manual','v1','model/evaluator','v1','{}',50,'Outro') RETURNING id`,
      [otherTenantId, otherConversationId, otherVersionId]
    )).rows[0].id;
    await expect(pool.query(
      "UPDATE ai_improvement_proposals SET evidence_evaluation_ids=$2 WHERE id=$1",
      [proposalId, JSON.stringify([otherEvaluationId])]
    )).rejects.toThrow(/another tenant/);
    await pool.query("DELETE FROM tenants WHERE id=$1", [otherTenantId]);

    await pool.query("DELETE FROM conversations WHERE id=$1 AND tenant_id=$2", [conversationId, tenantId]);

    expect((await pool.query(
      "SELECT count(*)::int count FROM ai_attendance_evaluations WHERE id=$1",
      [evaluationId]
    )).rows[0].count).toBe(0);
    expect((await pool.query(
      "SELECT evidence_evaluation_ids FROM ai_improvement_proposals WHERE id=$1",
      [proposalId]
    )).rows[0].evidence_evaluation_ids).toEqual([]);
    expect((await pool.query(
      "SELECT count(*)::int count FROM agent_config_versions WHERE id=ANY($1::uuid[])",
      [[baselineId, candidateId]]
    )).rows[0].count).toBe(2);
    expect((await pool.query(
      "SELECT status FROM ai_evaluation_runs WHERE id=$1",
      [runId]
    )).rows[0].status).toBe("passed");
  });
});
