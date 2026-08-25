import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { createManualCandidate, createTemplateCandidate, diffVersions, publishCandidateVersion, publishManualVersion, rollbackToVersion } from "../src/modules/agent-improvement/versions.js";
import { buildReplayPublicationAuthorization } from "../src/modules/agent-improvement/publication-authorization.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
let tenantId = "";
let otherTenantId = "";
let userId = "";
let agentId = "";
let bootstrapVersionId = "";
let manualCandidateId = "";

beforeAll(async () => {
  const tenant = await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`Agent versions ${randomUUID()}`]
  );
  tenantId = tenant.rows[0].id;
  const other = await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`Other agent versions ${randomUUID()}`]
  );
  otherTenantId = other.rows[0].id;
  const user = await pool.query<{ id: string }>(
    "INSERT INTO users(email,status,is_root) VALUES($1,'active',true) RETURNING id",
    [`agent-versions-${randomUUID()}@example.com`]
  );
  userId = user.rows[0].id;
  const agent = await pool.query<{ id: string; active_version_id: string }>(
    `INSERT INTO agent_configs(tenant_id,system_prompt,ai_model,model_params,enabled_tools)
     VALUES($1,'Prompt inicial','model/v1','{"temperature":0.4}'::jsonb,'["registrar_lead"]'::jsonb)
     RETURNING id,active_version_id`,
    [tenantId]
  );
  agentId = agent.rows[0].id;
  bootstrapVersionId = (await pool.query<{ active_version_id: string }>(
    "SELECT active_version_id FROM agent_configs WHERE id=$1",
    [agentId]
  )).rows[0].active_version_id;
});

afterAll(async () => {
  if (tenantId) await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  if (otherTenantId) await pool.query("DELETE FROM tenants WHERE id=$1", [otherTenantId]);
  if (userId) await pool.query("DELETE FROM audit_logs WHERE actor_user_id=$1", [userId]);
  if (userId) await pool.query("DELETE FROM users WHERE id=$1", [userId]);
  await pool.end();
});

describe("agent config version invariants", () => {
  it("diffs prompt, model, parameters and tools", () => {
    const baseline = {
      system_prompt: "Antes",
      ai_model: "model/old",
      model_params: { temperature: 0.4 },
      enabled_tools: ["registrar_lead"]
    };
    const target = {
      ...baseline,
      system_prompt: "Depois",
      ai_model: "model/new",
      model_params: { temperature: 0 },
      enabled_tools: ["registrar_lead", "agendar_reuniao"]
    };
    expect(diffVersions(baseline as never, target as never)).toEqual({
      systemPrompt: { before: "Antes", after: "Depois" },
      aiModel: { before: "model/old", after: "model/new" },
      modelParams: { before: { temperature: 0.4 }, after: { temperature: 0 } },
      enabledTools: { before: ["registrar_lead"], after: ["registrar_lead", "agendar_reuniao"] }
    });
  });

  it("bootstraps version 1 and keeps exactly one active snapshot", async () => {
    const versions = await pool.query(
      `SELECT version_number,source,status,system_prompt,ai_model,model_params,enabled_tools
       FROM agent_config_versions WHERE agent_config_id=$1`,
      [agentId]
    );
    expect(versions.rows).toEqual([expect.objectContaining({
      version_number: 1,
      source: "bootstrap",
      status: "active",
      system_prompt: "Prompt inicial",
      ai_model: "model/v1",
      enabled_tools: ["registrar_lead"]
    })]);
    expect(bootstrapVersionId).toEqual(expect.any(String));
  });

  it("turns a manual save into an immutable candidate without changing the active version", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const version = await publishManualVersion(client, {
        tenantId,
        systemPrompt: "Prompt manual",
        aiModel: "model/v2",
        modelParams: { temperature: 0 },
        enabledTools: ["registrar_lead"],
        isActive: true,
        userId,
        actorScope: "root"
      });
      manualCandidateId = version.id;
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const state = await pool.query(
      `SELECT a.active_version_id,a.system_prompt,a.ai_model,
        (SELECT count(*)::int FROM agent_config_versions v WHERE v.agent_config_id=a.id AND v.status='active') active_count,
        (SELECT count(*)::int FROM audit_logs l WHERE l.workspace_id=a.tenant_id AND l.resource_id=$2::text
          AND l.action='agent.version.manual_candidate_created') audit_count,
        (SELECT count(*)::int FROM ai_improvement_proposals p
          WHERE p.candidate_version_id=$2::uuid AND p.status='testing') proposal_count,
        (SELECT count(*)::int FROM ai_evaluation_runs r
          WHERE r.candidate_version_id=$2::uuid AND r.status='queued') run_count
       FROM agent_configs a WHERE a.id=$1`,
      [agentId, manualCandidateId]
    );
    expect(state.rows[0]).toMatchObject({
      active_version_id: bootstrapVersionId,
      system_prompt: "Prompt inicial",
      ai_model: "model/v1",
      active_count: 1,
      audit_count: 1,
      proposal_count: 1,
      run_count: 1
    });
    expect((await pool.query(
      "SELECT status,system_prompt,ai_model FROM agent_config_versions WHERE id=$1",
      [manualCandidateId]
    )).rows[0]).toMatchObject({
      status: "candidate",
      system_prompt: "Prompt manual",
      ai_model: "model/v2"
    });
    await expect(pool.query(
      "UPDATE agent_config_versions SET system_prompt='mutado' WHERE id=$1",
      [manualCandidateId]
    )).rejects.toThrow(/immutable/);
  });

  it("rejects cross-tenant message/version references", async () => {
    const session = await pool.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id) VALUES($1) RETURNING id",
      [otherTenantId]
    );
    const conversation = await pool.query<{ id: string }>(
      `INSERT INTO conversations(tenant_id,session_id,contact_phone)
       VALUES($1,$2,$3) RETURNING id`,
      [otherTenantId, session.rows[0].id, `5511${Date.now().toString().slice(-8)}`]
    );
    await expect(pool.query(
      `INSERT INTO messages(conversation_id,sender,content,agent_config_version_id)
       VALUES($1,'agent','não pode',$2)`,
      [conversation.rows[0].id, bootstrapVersionId]
    )).rejects.toThrow(/another tenant/);
  });

  it("rolls back by creating a new active version without mutating the source", async () => {
    const client = await pool.connect();
    let rollbackId = "";
    try {
      await client.query("BEGIN");
      const rollback = await rollbackToVersion(client, {
        tenantId,
        sourceVersionId: manualCandidateId,
        reason: "Regressão confirmada no atendimento",
        userId,
        actorScope: "root"
      });
      rollbackId = rollback.id;
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const versions = await pool.query(
      `SELECT id,version_number,source,status,system_prompt
       FROM agent_config_versions WHERE agent_config_id=$1 ORDER BY version_number`,
      [agentId]
    );
    expect(versions.rows.at(-1)).toMatchObject({
      id: rollbackId,
      version_number: 3,
      source: "rollback",
      status: "active",
      system_prompt: "Prompt manual"
    });
    expect(versions.rows[0]).toMatchObject({
      id: bootstrapVersionId,
      version_number: 1,
      source: "bootstrap",
      status: "retired",
      system_prompt: "Prompt inicial"
    });
  });

  it("creates a template candidate with active parameters and only activates it after explicit publication", async () => {
    const client = await pool.connect();
    let candidateId = "";
    let proposalId = "";
    let runId = "";
    try {
      await client.query("BEGIN");
      const created = await createTemplateCandidate(client, {
        tenantId,
        systemPrompt: "Template versionado atualizado",
        userId,
        actorScope: "root"
      });
      const candidate = created.version;
      candidateId = candidate.id;
      proposalId = created.proposalId;
      runId = created.runId!;
      expect(candidate).toMatchObject({
        status: "candidate",
        system_prompt: "Template versionado atualizado",
        ai_model: "model/v2",
        model_params: { temperature: 0 },
        enabled_tools: ["registrar_lead"]
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    expect((await pool.query("SELECT system_prompt FROM agent_configs WHERE id=$1", [agentId])).rows[0].system_prompt)
      .toBe("Prompt manual");

    const publisher = await pool.connect();
    try {
      await publisher.query("BEGIN");
      await expect(publishCandidateVersion(publisher, {
        tenantId,
        candidateVersionId: candidateId,
        userId,
        actorScope: "root"
      })).rejects.toThrow("replay aprovado");
      await publisher.query("ROLLBACK");
    } finally {
      publisher.release();
    }

    const [baseline, candidate] = await Promise.all([
      pool.query("SELECT * FROM agent_config_versions WHERE id=(SELECT active_version_id FROM agent_configs WHERE id=$1)", [agentId]),
      pool.query("SELECT * FROM agent_config_versions WHERE id=$1", [candidateId])
    ]);
    const authorization = await buildReplayPublicationAuthorization(pool, {
      tenantId,
      baseline: baseline.rows[0],
      candidate: candidate.rows[0]
    });
    await pool.query(
      `UPDATE ai_evaluation_runs SET status='passed',completed_at=now(),aggregate_metrics=$2
       WHERE id=$1`,
      [runId, { publicationAuthorization: authorization }]
    );
    await pool.query("UPDATE ai_improvement_proposals SET status='ready' WHERE id=$1", [proposalId]);
    const authorizedPublisher = await pool.connect();
    try {
      await authorizedPublisher.query("BEGIN");
      await publishCandidateVersion(authorizedPublisher, {
        tenantId,
        candidateVersionId: candidateId,
        userId,
        actorScope: "root"
      });
      await authorizedPublisher.query("COMMIT");
    } finally {
      authorizedPublisher.release();
    }

    const active = await pool.query(
      `SELECT a.active_version_id,a.system_prompt,a.ai_model,a.model_params,a.enabled_tools,v.status
       FROM agent_configs a JOIN agent_config_versions v ON v.id=a.active_version_id
       WHERE a.id=$1`,
      [agentId]
    );
    expect(active.rows[0]).toMatchObject({
      active_version_id: candidateId,
      system_prompt: "Template versionado atualizado",
      ai_model: "model/v2",
      model_params: { temperature: 0 },
      enabled_tools: ["registrar_lead"],
      status: "active"
    });
  });

  it("publishes a human prompt directly without creating an evaluator run when bypassed", async () => {
    const client = await pool.connect();
    let proposalId = "";
    let versionId = "";
    try {
      await client.query("BEGIN");
      const created = await createManualCandidate(client, {
        tenantId,
        systemPrompt: "Prompt publicado sem avaliador",
        aiModel: "model/v2",
        modelParams: { temperature: 0 },
        enabledTools: ["registrar_lead"],
        evaluationPolicy: "bypassed",
        userId,
        actorScope: "root"
      });
      proposalId = created.proposalId;
      versionId = created.version.id;
      expect(created.runId).toBeNull();
      await publishCandidateVersion(client, {
        tenantId,
        candidateVersionId: versionId,
        evaluationPolicy: "bypassed",
        userId,
        actorScope: "root"
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    expect((await pool.query(
      "SELECT count(*)::int count FROM ai_evaluation_runs WHERE proposal_id=$1",
      [proposalId]
    )).rows[0]).toEqual({ count: 0 });
    expect((await pool.query(
      "SELECT status FROM ai_improvement_proposals WHERE id=$1",
      [proposalId]
    )).rows[0]).toEqual({ status: "published" });
    expect((await pool.query(
      "SELECT active_version_id,system_prompt FROM agent_configs WHERE id=$1",
      [agentId]
    )).rows[0]).toEqual({
      active_version_id: versionId,
      system_prompt: "Prompt publicado sem avaliador"
    });
  });
});
