import type { Pool, PoolClient } from "pg";
import { isFeatureFlagEnabled } from "../operations/feature-flags.js";
import { RUBRIC_VERSION } from "./rubric.js";
import {
  enqueueAiEvaluationEvent,
  type AiEvaluationDirectJob
} from "../../queue/ai-evaluation-queue.js";

export interface AiEvaluationEvent extends AiEvaluationDirectJob {
  id: string;
  createdAt: Date;
}

export interface EvaluationEventPage {
  events: AiEvaluationEvent[];
  nextCursor: string | null;
  oldestAgeMs: number;
}

interface EvaluationEventRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  agent_config_version_id: string;
  trigger: AiEvaluationDirectJob["trigger"];
  created_at: Date;
}

function fromRow(row: EvaluationEventRow): AiEvaluationEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    conversationId: row.conversation_id,
    agentConfigVersionId: row.agent_config_version_id,
    trigger: row.trigger,
    createdAt: row.created_at
  };
}

export function evaluationEventErrorClass(error: unknown): "timeout" | "connection" | "unavailable" | "unknown" {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed? ?out|timeout/i.test(message)) return "timeout";
  if (/connect|socket|econn/i.test(message)) return "connection";
  if (/unavailable|closed|readonly/i.test(message)) return "unavailable";
  return "unknown";
}

async function eventFlagEnabled(client: PoolClient, tenantId: string): Promise<boolean> {
  await client.query("SAVEPOINT evaluation_event_flag");
  try {
    const enabled = await isFeatureFlagEnabled(client, tenantId, "evaluation_event_enqueue_v2");
    await client.query("RELEASE SAVEPOINT evaluation_event_flag");
    return enabled;
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT evaluation_event_flag");
    await client.query("RELEASE SAVEPOINT evaluation_event_flag");
    return false;
  }
}

export async function createEvaluationEvent(
  client: PoolClient,
  input: Omit<AiEvaluationDirectJob, "trigger"> & {
    trigger: Exclude<AiEvaluationDirectJob["trigger"], "manual">;
  }
): Promise<AiEvaluationEvent | null> {
  if (!await eventFlagEnabled(client, input.tenantId)) return null;
  const result = await client.query<EvaluationEventRow>(
    `INSERT INTO ai_evaluation_events(
       tenant_id,conversation_id,agent_config_version_id,trigger,rubric_version
     )
     SELECT c.tenant_id,c.id,v.id,$4,$5
     FROM conversations c
     JOIN tenant_ai_settings settings ON settings.tenant_id=c.tenant_id
       AND settings.ai_evaluations_enabled AND settings.evaluator_model IS NOT NULL
     JOIN agent_config_versions v ON v.id=$3 AND v.tenant_id=c.tenant_id
     WHERE c.id=$2 AND c.tenant_id=$1
     ON CONFLICT(conversation_id,agent_config_version_id,rubric_version,trigger)
     DO UPDATE SET updated_at=ai_evaluation_events.updated_at
     RETURNING id,tenant_id,conversation_id,agent_config_version_id,trigger,created_at`,
    [input.tenantId, input.conversationId, input.agentConfigVersionId, input.trigger, RUBRIC_VERSION]
  );
  return result.rows[0] ? fromRow(result.rows[0]) : null;
}

export async function createLatestEvaluationEvent(
  client: PoolClient,
  input: {
    tenantId: string;
    conversationId: string;
    trigger: "closed" | "handoff";
  }
): Promise<AiEvaluationEvent | null> {
  if (!await eventFlagEnabled(client, input.tenantId)) return null;
  if (input.trigger === "closed") {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,81004))",
      [input.tenantId]
    );
  }
  const result = await client.query<EvaluationEventRow>(
    `INSERT INTO ai_evaluation_events(
       tenant_id,conversation_id,agent_config_version_id,trigger,rubric_version
     )
     SELECT c.tenant_id,c.id,latest.agent_config_version_id,$3,$4
     FROM conversations c
     JOIN tenant_ai_settings settings ON settings.tenant_id=c.tenant_id
       AND settings.ai_evaluations_enabled AND settings.evaluator_model IS NOT NULL
     JOIN LATERAL (
       SELECT m.agent_config_version_id
       FROM messages m
       WHERE m.conversation_id=c.id AND m.sender='agent'
         AND m.agent_config_version_id IS NOT NULL
       ORDER BY m.created_at DESC,m.id DESC
       LIMIT 1
     ) latest ON true
     WHERE c.id=$2 AND c.tenant_id=$1
       AND (
         $3::text<>'closed'
         OR (
           SELECT count(*)
           FROM ai_evaluation_events quota
           WHERE quota.tenant_id=c.tenant_id AND quota.trigger='closed'
             AND quota.created_at>=date_trunc('day',now())
         )<100
       )
     ON CONFLICT(conversation_id,agent_config_version_id,rubric_version,trigger)
     DO UPDATE SET updated_at=ai_evaluation_events.updated_at
     RETURNING id,tenant_id,conversation_id,agent_config_version_id,trigger,created_at`,
    [input.tenantId, input.conversationId, input.trigger, RUBRIC_VERSION]
  );
  return result.rows[0] ? fromRow(result.rows[0]) : null;
}

export class EvaluationEventRepository {
  constructor(private readonly db: Pool) {}

  async getPending(id: string): Promise<AiEvaluationEvent | null> {
    const result = await this.db.query<EvaluationEventRow>(
      `SELECT id,tenant_id,conversation_id,agent_config_version_id,trigger,created_at
       FROM ai_evaluation_events
       WHERE id=$1 AND status='pending'`,
      [id]
    );
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async markEnqueueAttempt(id: string, error?: unknown): Promise<void> {
    await this.db.query(
      `UPDATE ai_evaluation_events
       SET enqueue_attempts=enqueue_attempts+1,last_enqueued_at=now(),
           last_error=$2,updated_at=now()
       WHERE id=$1 AND status='pending'`,
      [id, error ? `enqueue_${evaluationEventErrorClass(error)}` : null]
    );
  }

  async markCompleted(id: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE ai_evaluation_events
       SET status='completed',completed_at=now(),last_error=NULL,updated_at=now()
       WHERE id=$1 AND status='pending'`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async findPendingPage(limit = 100, cursor?: string): Promise<EvaluationEventPage> {
    const result = await this.db.query<EvaluationEventRow & { oldest_age_ms: number }>(
      `SELECT id,tenant_id,conversation_id,agent_config_version_id,trigger,created_at,
              COALESCE(max(extract(epoch FROM (now()-created_at))*1000) OVER (),0)::float oldest_age_ms
       FROM ai_evaluation_events
       WHERE status='pending'
         AND ($2::uuid IS NULL OR (created_at,id) > (
           SELECT created_at,id FROM ai_evaluation_events WHERE id=$2
         ))
       ORDER BY created_at,id
       LIMIT $1`,
      [limit, cursor ?? null]
    );
    const events = result.rows.map(fromRow);
    return {
      events,
      nextCursor: events.length === limit ? events.at(-1)!.id : null,
      oldestAgeMs: result.rows[0]?.oldest_age_ms ?? 0
    };
  }
}

export async function enqueueEvaluationEventAfterCommit(
  db: Pool,
  event: AiEvaluationEvent | null,
  enqueue: typeof enqueueAiEvaluationEvent = enqueueAiEvaluationEvent
): Promise<"enqueued" | "deduplicated" | "failed" | "not_created"> {
  if (!event) return "not_created";
  const repository = new EvaluationEventRepository(db);
  try {
    const result = await enqueue(event.id);
    await repository.markEnqueueAttempt(event.id);
    return result;
  } catch (error) {
    await repository.markEnqueueAttempt(event.id, error).catch(() => undefined);
    return "failed";
  }
}
