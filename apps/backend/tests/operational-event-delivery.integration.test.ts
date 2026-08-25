import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { runMigrations } from "../src/db/migration-runner.js";
import { MessageRepository } from "../src/modules/messages/repository.js";
import { AiFollowUpRepository } from "../src/modules/messages/ai-follow-up.js";
import {
  EvaluationEventRepository
} from "../src/modules/agent-improvement/evaluation-events.js";
import {
  reconcileAiFollowUps,
  reconcileEvaluationEvents,
  reconcileHandoffNotifications
} from "../src/modules/operations/event-reconciliation.js";
import { findAutomaticEvaluationJobs } from "../src/modules/agent-improvement/evaluator.js";

describe("operational event delivery integration", () => {
  const source = new URL(config.DATABASE_URL);
  const databaseName = `atendon_ops04_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = new URL(source);
  adminUrl.pathname = "/postgres";
  const databaseUrl = new URL(source);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = new pg.Pool({ connectionString: adminUrl.toString() });
  let pool: pg.Pool;
  let tenantId: string;
  let sessionId: string;
  let conversationId: string;
  let versionId: string;

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const migrationClient = new pg.Client({ connectionString: databaseUrl.toString() });
    await migrationClient.connect();
    try {
      await runMigrations(
        migrationClient,
        fileURLToPath(new URL("../src/db/migrations", import.meta.url)),
        () => undefined
      );
    } finally {
      await migrationClient.end();
    }
    pool = new pg.Pool({ connectionString: databaseUrl.toString() });
    tenantId = (await pool.query<{ id: string }>(
      "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
      [`OPS-04 ${randomUUID()}`]
    )).rows[0].id;
    sessionId = (await pool.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id) VALUES($1) RETURNING id",
      [tenantId]
    )).rows[0].id;
    const agentId = (await pool.query<{ id: string }>(
      `INSERT INTO agent_configs(tenant_id,system_prompt,ai_model)
       VALUES($1,'Atenda bem','model/agent') RETURNING id`,
      [tenantId]
    )).rows[0].id;
    versionId = (await pool.query<{ active_version_id: string }>(
      "SELECT active_version_id FROM agent_configs WHERE id=$1",
      [agentId]
    )).rows[0].active_version_id;
    await pool.query(
      `UPDATE tenant_ai_settings SET
         evaluator_model='model/evaluator',
         ai_evaluations_enabled=true,
         ai_follow_up_enabled=true,
         ai_follow_up_max_count=1,
         ai_follow_up_interval_minutes=1,
         ai_follow_up_delays_minutes=ARRAY[1]
       WHERE tenant_id=$1`,
      [tenantId]
    );
    await pool.query(
      `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
       VALUES($1,'evaluation_event_enqueue_v2',true)`,
      [tenantId]
    );
    conversationId = (await pool.query<{ id: string }>(
      `INSERT INTO conversations(tenant_id,session_id,contact_phone)
       VALUES($1,$2,$3) RETURNING id`,
      [tenantId, sessionId, `5511${Date.now().toString().slice(-8)}`]
    )).rows[0].id;
    await pool.query(
      `INSERT INTO messages(
         conversation_id,sender,content,agent_config_version_id,
         external_message_id,provider_message_key
       ) VALUES($1,'agent','Resposta inicial',$2,$3,$4)`,
      [conversationId, versionId, `agent-${randomUUID()}`, `${tenantId}:${sessionId}:${randomUUID()}`]
    );
  }, 120_000);

  afterAll(async () => {
    if (pool) await pool.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
  });

  it("recovers a committed evaluation event after enqueue failure without leaking the error", async () => {
    const enqueueEvaluation = vi.fn().mockRejectedValue(
      new Error("redis connect failed for user@example.com token=supersecret")
    );
    const repository = new MessageRepository(pool, config, { evaluation: enqueueEvaluation });
    await repository.recordAiEvaluationSignal({
      tenantId,
      conversationId,
      agentConfigVersionId: versionId,
      kind: "ai_error"
    });

    const committed = await pool.query<{
      id: string;
      status: string;
      last_error: string;
    }>(
      `SELECT id,status,last_error FROM ai_evaluation_events
       WHERE tenant_id=$1 AND conversation_id=$2 AND trigger='tool_error'`,
      [tenantId, conversationId]
    );
    expect(committed.rows[0]).toMatchObject({
      status: "pending",
      last_error: "enqueue_connection"
    });
    expect(JSON.stringify(committed.rows[0])).not.toContain("user@example.com");
    expect(JSON.stringify(committed.rows[0])).not.toContain("supersecret");

    const recovered = await reconcileEvaluationEvents(
      new EvaluationEventRepository(pool),
      vi.fn().mockResolvedValue("enqueued")
    );
    expect(recovered).toMatchObject({ examined: 1, enqueued: 1, errors: 0 });
  });

  it("uses event delivery for ON tenants without also selecting the legacy scan", async () => {
    const jobs = await findAutomaticEvaluationJobs(pool);
    expect(jobs.some((job) => (
      job.tenantId === tenantId
      && job.conversationId === conversationId
      && job.trigger === "tool_error"
    ))).toBe(false);
  });

  it("preserves the legacy selector when evaluation event delivery is OFF", async () => {
    await pool.query(
      `UPDATE tenant_feature_flag_overrides
       SET enabled=false
       WHERE tenant_id=$1 AND flag_key='evaluation_event_enqueue_v2'`,
      [tenantId]
    );
    const jobs = await findAutomaticEvaluationJobs(pool);
    expect(jobs.some((job) => (
      job.tenantId === tenantId
      && job.conversationId === conversationId
      && job.trigger === "tool_error"
    ))).toBe(true);
    await pool.query(
      `UPDATE tenant_feature_flag_overrides
       SET enabled=true
       WHERE tenant_id=$1 AND flag_key='evaluation_event_enqueue_v2'`,
      [tenantId]
    );
  });

  it("recovers committed follow-up and handoff rows through keyset pages", async () => {
    const inboundExternalId = `inbound-${randomUUID()}`;
    await pool.query(
      `INSERT INTO messages(
         conversation_id,sender,content,external_message_id,provider_message_key
       ) VALUES($1,'contact','Preciso de ajuda',$2,$3)`,
      [conversationId, inboundExternalId, `${tenantId}:${sessionId}:${inboundExternalId}`]
    );
    const followUpEnqueue = vi.fn().mockRejectedValue(new Error("redis unavailable"));
    const repository = new MessageRepository(pool, config, { followUp: followUpEnqueue });
    await repository.recordAgentReply({
      tenantId,
      sessionId,
      conversationId,
      text: "Posso ajudar",
      model: "model/agent",
      agentConfigVersionId: versionId,
      externalId: `reply-${randomUUID()}`,
      inboundExternalId
    });
    expect(followUpEnqueue).toHaveBeenCalledTimes(1);
    await pool.query(
      `UPDATE ai_follow_up_schedules
       SET next_run_at=now()-interval '1 minute'
       WHERE conversation_id=$1`,
      [conversationId]
    );
    const recoveredFollowUp = await reconcileAiFollowUps(
      new AiFollowUpRepository(pool, config),
      vi.fn().mockResolvedValue("enqueued")
    );
    expect(recoveredFollowUp).toMatchObject({ examined: 1, enqueued: 1 });

    await pool.query(
      "UPDATE tenants SET attendant_phone='5511999999999' WHERE id=$1",
      [tenantId]
    );
    const notification = await repository.pauseForHandoff({
      tenantId,
      conversationId,
      sessionId,
      reason: "contact_requested",
      idempotencyKey: `handoff-${randomUUID()}`,
      notificationText: "Conversa transferida"
    });
    expect(notification).not.toBeNull();
    const recoveredHandoff = await reconcileHandoffNotifications(
      repository,
      vi.fn().mockResolvedValue("enqueued")
    );
    expect(recoveredHandoff).toMatchObject({ examined: 1, enqueued: 1 });
  });
});
