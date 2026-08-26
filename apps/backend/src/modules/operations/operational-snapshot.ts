import type { Queue } from "bullmq";
import type pg from "pg";
import { aiFollowUpQueue } from "../../queue/ai-follow-up-queue.js";
import { handoffNotificationQueue } from "../../queue/handoff-notification-queue.js";
import { humanOutboundQueue } from "../../queue/human-message-queue.js";
import { meetingContactDeliveryQueue } from "../../queue/meeting-contact-delivery-queue.js";
import { meetingProvisioningQueue } from "../../queue/meeting-provisioning-queue.js";
import { inboundQueue } from "../../queue/message-queue.js";
import { inMemoryOperationalMetrics } from "./observability-metrics.js";

const QUEUES = [
  ["inbound", inboundQueue],
  ["human_outbound", humanOutboundQueue],
  ["handoff_notification", handoffNotificationQueue],
  ["ai_follow_up", aiFollowUpQueue],
  ["meeting_provisioning", meetingProvisioningQueue],
  ["meeting_contact_delivery", meetingContactDeliveryQueue]
] as const satisfies ReadonlyArray<readonly [string, Queue]>;

const OUTBOX_NAMES = new Set([
  "handoff_notification",
  "ai_follow_up",
  "meeting_provisioning",
  "meeting_contact_delivery"
]);
const OUTBOX_STATUSES = new Set([
  "pending",
  "scheduled",
  "processing",
  "ready",
  "sent",
  "suppressed",
  "cancelled",
  "completed",
  "failed",
  "uncertain"
]);
const APPLICATION_NAMES = new Set(["atendon-api", "atendon-worker", "atendon-migration"]);
const DATABASE_STATES = new Set(["active", "idle", "idle in transaction", "idle in transaction (aborted)"]);

async function queueSnapshot(name: string, queue: Queue) {
  try {
    const [counts, oldest, completed, failed, workers] = await Promise.all([
      queue.getJobCounts("waiting", "active", "delayed", "failed", "paused"),
      queue.getJobs(["waiting", "delayed"], 0, 99, true),
      queue.getMetrics("completed", 0, 59),
      queue.getMetrics("failed", 0, 59),
      queue.getWorkersCount()
    ]);
    const oldestTimestamp = oldest.reduce<number | null>((minimum, job) => (
      minimum === null ? job.timestamp : Math.min(minimum, job.timestamp)
    ), null);
    return {
      name,
      available: true,
      workers,
      counts,
      oldest_waiting_age_seconds: oldestTimestamp === null
        ? 0
        : Math.max(0, (Date.now() - oldestTimestamp) / 1_000),
      throughput: {
        completed_total: completed.count,
        failed_total: failed.count,
        completed_last_60_minutes: completed.data.reduce((sum, value) => sum + value, 0),
        failed_last_60_minutes: failed.data.reduce((sum, value) => sum + value, 0)
      }
    };
  } catch {
    return {
      name,
      available: false,
      workers: 0,
      counts: {},
      oldest_waiting_age_seconds: 0,
      throughput: {
        completed_total: 0,
        failed_total: 0,
        completed_last_60_minutes: 0,
        failed_last_60_minutes: 0
      }
    };
  }
}

async function outboxSnapshot(pool: pg.Pool) {
  const result = await pool.query<{
    outbox: string;
    status: string;
    total: number;
    oldest_age_seconds: number;
    completed_last_5_minutes: number;
  }>(
    `/* query:operational.outbox_snapshot */
     WITH outboxes AS (
       SELECT 'handoff_notification'::text outbox,status,created_at,
              CASE WHEN status IN ('sent','failed') THEN COALESCE(sent_at,created_at) END completed_at
       FROM handoff_notifications
       UNION ALL
       SELECT 'ai_follow_up',status,created_at,
              CASE WHEN status IN ('completed','failed','cancelled') THEN updated_at END completed_at
       FROM ai_follow_up_schedules
       UNION ALL
       SELECT 'ai_evaluation',status,created_at,completed_at
       FROM ai_evaluation_events
       UNION ALL
       SELECT 'meeting_provisioning',status,created_at,completed_at
       FROM scheduling_meeting_provisioning_outbox
       UNION ALL
       SELECT 'meeting_contact_delivery',status,created_at,completed_at
       FROM scheduling_meeting_contact_delivery_outbox
     )
     SELECT outbox,status,count(*)::int total,
            COALESCE(extract(epoch FROM now()-min(created_at)),0)::float8 oldest_age_seconds,
            count(*) FILTER (WHERE completed_at>=now()-interval '5 minutes')::int
              completed_last_5_minutes
     FROM outboxes
     GROUP BY outbox,status
     ORDER BY outbox,status`
  );
  return result.rows.filter((row) => OUTBOX_NAMES.has(row.outbox) && OUTBOX_STATUSES.has(row.status));
}

async function databaseActivity(pool: pg.Pool) {
  const result = await pool.query<{
    application_name: string;
    state: string;
    connections: number;
    oldest_transaction_age_seconds: number;
  }>(
    `/* query:operational.database_activity */
     SELECT application_name,COALESCE(state,'unknown') state,count(*)::int connections,
            COALESCE(max(extract(epoch FROM now()-xact_start))
              FILTER (WHERE xact_start IS NOT NULL),0)::float8 oldest_transaction_age_seconds
     FROM pg_stat_activity
     WHERE datname=current_database()
       AND application_name=ANY($1::text[])
     GROUP BY application_name,state
     ORDER BY application_name,state`,
    [[...APPLICATION_NAMES]]
  );
  return result.rows.filter((row) => (
    APPLICATION_NAMES.has(row.application_name)
    && (DATABASE_STATES.has(row.state) || row.state === "unknown")
  ));
}

async function databaseSizes(pool: pg.Pool) {
  const relations = [
    "messages",
    "conversations",
    "scheduling_appointments",
    "system_alerts",
    "usage_logs",
    "ai_attendance_evaluations"
  ];
  const result = await pool.query<{
    relation: string;
    table_bytes: number;
    index_bytes: number;
  }>(
    `/* query:operational.database_sizes */
     SELECT relname relation,
            pg_table_size(relid)::float8 table_bytes,
            pg_indexes_size(relid)::float8 index_bytes
     FROM pg_catalog.pg_statio_user_tables
     WHERE relname=ANY($1::text[])
     ORDER BY pg_total_relation_size(relid) DESC`,
    [relations]
  );
  return result.rows.filter((row) => relations.includes(row.relation));
}

async function statementStatistics(pool: pg.Pool) {
  try {
    const result = await pool.query<{
      query_id: string;
      calls: number;
      total_exec_ms: number;
      mean_exec_ms: number;
      max_exec_ms: number;
      rows: number;
    }>(
      `/* query:operational.pg_stat_statements */
       SELECT queryid::text query_id,calls::float8 calls,
              total_exec_time::float8 total_exec_ms,
              mean_exec_time::float8 mean_exec_ms,
              max_exec_time::float8 max_exec_ms,
              rows::float8 rows
       FROM pg_stat_statements
       WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
         AND userid=(SELECT usesysid FROM pg_user WHERE usename=current_user)
       ORDER BY total_exec_time DESC
       LIMIT 25`
    );
    return { available: true, statements: result.rows };
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code)
      : "unknown";
    return {
      available: false,
      reason: code === "42P01" || code === "55000"
        ? "extension_not_enabled"
        : "query_unavailable",
      statements: []
    };
  }
}

async function databaseHealthCounters(pool: pg.Pool) {
  const result = await pool.query<{
    deadlocks: number;
    temporary_bytes: number;
    connections: number;
  }>(
    `/* query:operational.database_health */
     SELECT deadlocks::float8 deadlocks,temp_bytes::float8 temporary_bytes,
            numbackends::int connections
     FROM pg_stat_database
     WHERE datname=current_database()`
  );
  return result.rows[0] ?? { deadlocks: 0, temporary_bytes: 0, connections: 0 };
}

export async function collectOperationalSnapshot(pool: pg.Pool) {
  const [queues, outboxes, activity, sizes, statements, health] = await Promise.all([
    Promise.all(QUEUES.map(([name, queue]) => queueSnapshot(name, queue))),
    outboxSnapshot(pool),
    databaseActivity(pool),
    databaseSizes(pool),
    statementStatistics(pool),
    databaseHealthCounters(pool)
  ]);
  return {
    process: inMemoryOperationalMetrics(pool),
    postgres: {
      activity,
      health,
      relation_sizes: sizes,
      pg_stat_statements: statements
    },
    queues,
    outboxes
  };
}
