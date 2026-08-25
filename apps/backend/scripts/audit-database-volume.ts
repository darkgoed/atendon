import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runMigrations } from "../src/db/migration-runner.js";
import { loadTestEnvironment } from "./test-environment.js";
import { resolveTestDatabaseUrl } from "./test-database.js";

const MESSAGE_ROWS_PER_TENANT = 25_000;
const MESSAGE_TIMESTAMP_TIE_GROUP = MESSAGE_ROWS_PER_TENANT;
const ALERT_ROWS_PER_TENANT = 5_000;
const APPOINTMENT_ROWS_PER_TENANT = 8_000;
const HISTORY_LIMIT = 100;
const CURSOR_PAGE_SIZE = 137;

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Rows"?: number;
  "Rows Removed by Filter"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  Plans?: PlanNode[];
}

interface ExplainDocument {
  Plan: PlanNode;
  "Planning Time": number;
  "Execution Time": number;
}

interface PlanMetrics {
  executionMs: number;
  planningMs: number;
  actualRows: number;
  sharedHitBlocks: number;
  sharedReadBlocks: number;
  indexes: string[];
  broadSeqScans: Array<{ relation: string; rowsVisited: number }>;
  broadSorts: Array<{ rows: number }>;
}

interface AuditMeasurement {
  name: string;
  expectedIndexes: string[];
  passed: boolean;
  violations: string[];
  baseline: PlanMetrics;
  indexed: PlanMetrics;
  executionSpeedup: number | null;
  bufferReduction: number | null;
}

interface SeededTenant {
  tenantId: string;
  conversationId: string;
  userId: string;
  unitId: string;
  phonePrefix: string;
}

function visitPlan(node: PlanNode, visit: (item: PlanNode) => void): void {
  visit(node);
  for (const child of node.Plans ?? []) visitPlan(child, visit);
}

function metrics(document: ExplainDocument, broadRowThreshold: number): PlanMetrics {
  const indexes = new Set<string>();
  const broadSeqScans: PlanMetrics["broadSeqScans"] = [];
  const broadSorts: PlanMetrics["broadSorts"] = [];
  visitPlan(document.Plan, (node) => {
    if (node["Index Name"]) indexes.add(node["Index Name"]);
    const rowsVisited = (node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0);
    if (
      ["Seq Scan", "Parallel Seq Scan"].includes(node["Node Type"])
      && node["Relation Name"]
      && rowsVisited > broadRowThreshold
    ) {
      broadSeqScans.push({ relation: node["Relation Name"], rowsVisited });
    }
    if (["Sort", "Incremental Sort"].includes(node["Node Type"]) && (node["Actual Rows"] ?? 0) > broadRowThreshold) {
      broadSorts.push({ rows: node["Actual Rows"] ?? 0 });
    }
  });
  return {
    executionMs: Number(document["Execution Time"].toFixed(3)),
    planningMs: Number(document["Planning Time"].toFixed(3)),
    actualRows: document.Plan["Actual Rows"] ?? 0,
    sharedHitBlocks: document.Plan["Shared Hit Blocks"] ?? 0,
    sharedReadBlocks: document.Plan["Shared Read Blocks"] ?? 0,
    indexes: [...indexes].sort(),
    broadSeqScans,
    broadSorts
  };
}

async function explain(
  client: pg.Client,
  sql: string,
  values: unknown[],
  forceSequentialBaseline: boolean
): Promise<ExplainDocument> {
  await client.query("BEGIN");
  try {
    if (forceSequentialBaseline) {
      await client.query("SET LOCAL enable_indexscan=off");
      await client.query("SET LOCAL enable_indexonlyscan=off");
      await client.query("SET LOCAL enable_bitmapscan=off");
    }
    const result = await client.query<{ "QUERY PLAN": ExplainDocument[] }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
      values
    );
    await client.query("ROLLBACK");
    return result.rows[0]["QUERY PLAN"][0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function ratio(before: number, after: number): number | null {
  if (after <= 0 || before <= 0) return null;
  return Number((before / after).toFixed(2));
}

async function measure(
  client: pg.Client,
  input: {
    name: string;
    sql: string;
    values: unknown[];
    expectedIndexes: string[];
    broadRowThreshold: number;
  }
): Promise<AuditMeasurement> {
  // Warm relation and index pages once before comparing the two planner modes.
  await explain(client, input.sql, input.values, false);
  const baselineDocument = await explain(client, input.sql, input.values, true);
  const indexedDocument = await explain(client, input.sql, input.values, false);
  const baseline = metrics(baselineDocument, input.broadRowThreshold);
  const indexed = metrics(indexedDocument, input.broadRowThreshold);
  const violations: string[] = [];
  if (!input.expectedIndexes.some((index) => indexed.indexes.includes(index))) {
    violations.push(`expected index not used; actual=${indexed.indexes.join(",") || "none"}`);
  }
  if (indexed.broadSeqScans.length) {
    violations.push("broad sequential scan remained");
  }
  if (indexed.broadSorts.length) {
    violations.push("broad sort remained");
  }
  const baselineBuffers = baseline.sharedHitBlocks + baseline.sharedReadBlocks;
  const indexedBuffers = indexed.sharedHitBlocks + indexed.sharedReadBlocks;
  return {
    name: input.name,
    expectedIndexes: input.expectedIndexes,
    passed: violations.length === 0,
    violations,
    baseline,
    indexed,
    executionSpeedup: ratio(baseline.executionMs, indexed.executionMs),
    bufferReduction: ratio(baselineBuffers, indexedBuffers)
  };
}

async function seedTenant(client: pg.Client, label: string): Promise<SeededTenant> {
  // +999 is ITU-reserved and already used by the application for non-routable
  // audit/quarantine identifiers. Keep every generated value E.164-shaped so
  // this audit continues exercising the production schema constraints.
  const phonePrefix = label === "a" ? "999100000" : "999200000";
  const tenantId = (await client.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`Volume tenant ${label}`]
  )).rows[0].id;
  const sessionId = (await client.query<{ id: string }>(
    "INSERT INTO whatsapp_sessions(tenant_id) VALUES($1) RETURNING id",
    [tenantId]
  )).rows[0].id;
  const conversationId = (await client.query<{ id: string }>(
    `INSERT INTO conversations(tenant_id,session_id,contact_phone)
     VALUES($1,$2,$3) RETURNING id`,
    [tenantId, sessionId, `${phonePrefix}0000`]
  )).rows[0].id;
  await client.query(
    `INSERT INTO messages(conversation_id,sender,content,created_at)
     SELECT $1,
            CASE WHEN n%2=0 THEN 'contact' ELSE 'agent' END,
            'synthetic-message-'||n,
            '2026-01-01T00:00:00Z'::timestamptz
              + floor((n-1)/$3::int)::int * interval '1 millisecond'
     FROM generate_series(1,$2::int) n`,
    [conversationId, MESSAGE_ROWS_PER_TENANT, MESSAGE_TIMESTAMP_TIE_GROUP]
  );

  const userId = (await client.query<{ id: string }>(
    `INSERT INTO users(email,status,password_hash)
     VALUES($1,'active','synthetic') RETURNING id`,
    [`volume-${label}@invalid.example`]
  )).rows[0].id;
  const roleId = (await client.query<{ id: string }>(
    `INSERT INTO workspace_roles(workspace_id,name,is_system)
     VALUES($1,'Volume auditor',true) RETURNING id`,
    [tenantId]
  )).rows[0].id;
  await client.query(
    `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
     VALUES($1,$2,$3,'active',now())`,
    [tenantId, userId, roleId]
  );
  await client.query(
    `INSERT INTO system_alerts(tenant_id,message,audience,created_at)
     SELECT $1,'synthetic-alert','workspace',
            '2026-02-01T00:00:00Z'::timestamptz+n*interval '1 millisecond'
     FROM generate_series(1,$2::int) n`,
    [tenantId, ALERT_ROWS_PER_TENANT]
  );

  const unitId = "volume-unit";
  await client.query(
    `INSERT INTO scheduling_categories(tenant_id,id,name)
     VALUES($1,'volume-category','Volume category')`,
    [tenantId]
  );
  await client.query(
    `INSERT INTO scheduling_units(
       tenant_id,id,name,opening_time,closing_time,operating_days,
       slot_duration_min,simultaneous_capacity
     ) VALUES($1,$2,'Volume unit','00:00','23:59',ARRAY[0,1,2,3,4,5,6]::smallint[],60,10000)`,
    [tenantId, unitId]
  );
  await client.query(
    `INSERT INTO scheduling_leads(
     tenant_id,phone,name,interest_category_id,unit_id,status,source
     )
     SELECT $1,$4||lpad(n::text,4,'0'),'Synthetic lead',
            'volume-category',$2,'agendado','audit'
     FROM generate_series(1,$3::int) n`,
    [tenantId, unitId, APPOINTMENT_ROWS_PER_TENANT, phonePrefix]
  );
  await client.query(
    `INSERT INTO scheduling_appointments(
       tenant_id,lead_id,unit_id,start_at,end_at,status
     )
     SELECT lead.tenant_id,lead.id,lead.unit_id,
            '2030-01-01T00:00:00Z'::timestamptz
              + row_number() OVER (ORDER BY lead.id) * interval '1 minute',
            '2030-01-01T01:00:00Z'::timestamptz
              + row_number() OVER (ORDER BY lead.id) * interval '1 minute',
            'confirmado'
     FROM scheduling_leads lead
     WHERE lead.tenant_id=$1 AND lead.unit_id IS NOT NULL`,
    [tenantId]
  );
  return { tenantId, conversationId, userId, unitId, phonePrefix };
}

async function validateCursorCompleteness(client: pg.Client, conversationId: string): Promise<void> {
  const seen = new Set<string>();
  let cursor: { createdAt: Date; id: string } | undefined;
  for (;;) {
    const values: unknown[] = [conversationId];
    const boundary = cursor
      ? "AND (created_at,id)<($2::timestamptz,$3::uuid)"
      : "";
    if (cursor) values.push(cursor.createdAt, cursor.id);
    values.push(CURSOR_PAGE_SIZE);
    const result = await client.query<{ id: string; created_at: Date }>(
      `SELECT id,created_at FROM messages
       WHERE conversation_id=$1 ${boundary}
       ORDER BY created_at DESC,id DESC
       LIMIT $${values.length}`,
      values
    );
    if (!result.rows.length) break;
    for (const row of result.rows) {
      if (seen.has(row.id)) throw new Error("DB-04 cursor duplicated a message");
      seen.add(row.id);
    }
    const last = result.rows.at(-1)!;
    cursor = { createdAt: last.created_at, id: last.id };
  }
  if (seen.size !== MESSAGE_ROWS_PER_TENANT) {
    throw new Error(`DB-04 cursor returned ${seen.size}/${MESSAGE_ROWS_PER_TENANT} messages`);
  }
}

async function validateActiveAppointmentConcurrency(
  controllerUrl: URL,
  client: pg.Client,
  tenant: SeededTenant
): Promise<void> {
  const leadId = (await client.query<{ id: string }>(
    `INSERT INTO scheduling_leads(
     tenant_id,phone,name,interest_category_id,unit_id,status,source
     ) VALUES($1,$3,'Synthetic concurrency',
       'volume-category',$2,'agendado','audit') RETURNING id`,
    [tenant.tenantId, tenant.unitId, `${tenant.phonePrefix}9999`]
  )).rows[0].id;
  const first = new pg.Client({ connectionString: controllerUrl.toString() });
  const second = new pg.Client({ connectionString: controllerUrl.toString() });
  await Promise.all([first.connect(), second.connect()]);
  try {
    await Promise.all([first.query("BEGIN"), second.query("BEGIN")]);
    const insertValues = [
      tenant.tenantId,
      leadId,
      tenant.unitId,
      "2035-01-01T10:00:00.000Z",
      "2035-01-01T11:00:00.000Z"
    ];
    await first.query(
      `INSERT INTO scheduling_appointments(
         tenant_id,lead_id,unit_id,start_at,end_at,status
       ) VALUES($1,$2,$3,$4,$5,'confirmado')`,
      insertValues
    );
    const competing = second.query(
      `INSERT INTO scheduling_appointments(
         tenant_id,lead_id,unit_id,start_at,end_at,status
       ) VALUES($1,$2,$3,$4,$5,'confirmado')`,
      insertValues
    ).then(
      () => undefined,
      (reason: unknown) => reason as { code?: string }
    );
    await first.query("COMMIT");
    const error = await competing;
    if (error?.code !== "23505") {
      throw new Error(`DB-02 concurrent insert expected 23505, received ${error?.code ?? "success"}`);
    }
    await second.query("ROLLBACK");
    const active = await client.query<{ count: number }>(
      `SELECT count(*)::int count FROM scheduling_appointments
       WHERE tenant_id=$1 AND lead_id=$2
         AND status IN ('confirmado','reagendado')`,
      [tenant.tenantId, leadId]
    );
    if (active.rows[0].count !== 1) throw new Error("DB-02 concurrency did not leave exactly one active appointment");
  } finally {
    await Promise.all([
      first.query("ROLLBACK").catch(() => undefined),
      second.query("ROLLBACK").catch(() => undefined)
    ]);
    await Promise.all([first.end(), second.end()]);
  }
}

loadTestEnvironment();
const controllerUrl = new URL(resolveTestDatabaseUrl(process.env));
controllerUrl.pathname = "/postgres";
controllerUrl.search = "";
const databaseName = `atendon_volume_audit_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = new URL(controllerUrl);
databaseUrl.pathname = `/${databaseName}`;
const controller = new pg.Client({ connectionString: controllerUrl.toString() });
let databaseCreated = false;

try {
  await controller.connect();
  await controller.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
  databaseCreated = true;
  const client = new pg.Client({ connectionString: databaseUrl.toString() });
  await client.connect();
  try {
    const migrationDirectory = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
    await runMigrations(client, migrationDirectory, () => undefined);
    const tenantA = await seedTenant(client, "a");
    const tenantB = await seedTenant(client, "b");
    await client.query(
      "ANALYZE messages,system_alerts,system_alert_receipts,scheduling_appointments,scheduling_leads"
    );

    const isolation = await client.query<{
      tenant_a_messages: number;
      tenant_b_messages: number;
      cross_tenant_receipts: number;
      tenant_a_appointments: number;
      tenant_b_appointments: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id=m.conversation_id
          WHERE c.tenant_id=$1) tenant_a_messages,
         (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id=m.conversation_id
          WHERE c.tenant_id=$2) tenant_b_messages,
         (SELECT count(*)::int FROM system_alert_receipts
          WHERE tenant_id=$1 AND user_id=$3) cross_tenant_receipts,
         (SELECT count(*)::int FROM scheduling_appointments
          WHERE tenant_id=$1 AND unit_id=$4) tenant_a_appointments,
         (SELECT count(*)::int FROM scheduling_appointments
          WHERE tenant_id=$2 AND unit_id=$4) tenant_b_appointments`,
      [tenantA.tenantId, tenantB.tenantId, tenantB.userId, tenantB.unitId]
    );
    if (
      isolation.rows[0].tenant_a_messages !== MESSAGE_ROWS_PER_TENANT
      || isolation.rows[0].tenant_b_messages !== MESSAGE_ROWS_PER_TENANT
      || isolation.rows[0].cross_tenant_receipts !== 0
      || isolation.rows[0].tenant_a_appointments !== APPOINTMENT_ROWS_PER_TENANT
      || isolation.rows[0].tenant_b_appointments !== APPOINTMENT_ROWS_PER_TENANT
    ) {
      throw new Error("Multi-tenant seed isolation failed");
    }

    await validateCursorCompleteness(client, tenantA.conversationId);
    await validateActiveAppointmentConcurrency(databaseUrl, client, tenantA);

    const cursorBoundary = (await client.query<{ created_at: Date; id: string }>(
      `SELECT created_at,id FROM messages
       WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC OFFSET 500 LIMIT 1`,
      [tenantA.conversationId]
    )).rows[0];
    const alertBoundary = (await client.query<{ alert_id: string }>(
      `SELECT alert_id FROM system_alert_receipts
       WHERE tenant_id=$1 AND user_id=$2 ORDER BY alert_id OFFSET 500 LIMIT 1`,
      [tenantA.tenantId, tenantA.userId]
    )).rows[0];
    const leadBoundary = (await client.query<{ lead_id: string }>(
      `SELECT lead_id FROM scheduling_appointments
       WHERE tenant_id=$1 ORDER BY start_at DESC LIMIT 1`,
      [tenantA.tenantId]
    )).rows[0];

    const measurements: AuditMeasurement[] = [];
    measurements.push(await measure(client, {
      name: "DB-01 recent history before window functions",
      sql: `WITH persisted_recent_history AS MATERIALIZED (
              SELECT id,sender,content,created_at
              FROM messages
              WHERE conversation_id=$1
                AND NOT (sender='agent' AND media_is_sticker)
              ORDER BY created_at DESC,id DESC
              LIMIT $2
            ), history_candidates AS (
              SELECT id,sender,content,created_at
              FROM persisted_recent_history
              UNION ALL
              SELECT $3::uuid,'contact','synthetic-current-message',
                     '2030-01-01T00:00:00Z'::timestamptz
            ), recent_history AS MATERIALIZED (
              SELECT id,sender,content,created_at
              FROM history_candidates
              ORDER BY created_at DESC,id DESC
              LIMIT $2
            ), ranked AS (
              SELECT *,row_number() OVER (ORDER BY created_at DESC,id DESC) position,
                     sum(char_length(content)) OVER (ORDER BY created_at DESC,id DESC) characters
              FROM recent_history
            )
            SELECT id FROM ranked WHERE characters<=24000 OR position=1`,
      values: [tenantA.conversationId, HISTORY_LIMIT, randomUUID()],
      expectedIndexes: ["idx_messages_conversation_recent"],
      broadRowThreshold: HISTORY_LIMIT + 1
    }));
    measurements.push(await measure(client, {
      name: "DB-04 initial message cursor",
      sql: `SELECT id,created_at FROM messages
            WHERE conversation_id=$1
            ORDER BY created_at DESC,id DESC LIMIT 101`,
      values: [tenantA.conversationId],
      expectedIndexes: ["idx_messages_conversation_recent"],
      broadRowThreshold: 101
    }));
    measurements.push(await measure(client, {
      name: "DB-04 backward message cursor",
      sql: `SELECT id,created_at FROM messages
            WHERE conversation_id=$1
              AND (created_at,id)<($2::timestamptz,$3::uuid)
            ORDER BY created_at DESC,id DESC LIMIT 101`,
      values: [tenantA.conversationId, cursorBoundary.created_at, cursorBoundary.id],
      expectedIndexes: ["idx_messages_conversation_recent"],
      broadRowThreshold: 101
    }));
    measurements.push(await measure(client, {
      name: "DB-02 active appointment per lead",
      sql: `SELECT id FROM scheduling_appointments
            WHERE tenant_id=$1 AND lead_id=$2
              AND status IN ('confirmado','reagendado') LIMIT 1`,
      values: [tenantA.tenantId, leadBoundary.lead_id],
      expectedIndexes: ["idx_appointments_one_active_per_lead"],
      broadRowThreshold: 2
    }));
    measurements.push(await measure(client, {
      name: "DB-02 active capacity range",
      sql: `SELECT start_at,end_at FROM scheduling_appointments
            WHERE tenant_id=$1 AND unit_id=$2
              AND status IN ('confirmado','reagendado')
              AND start_at<$4 AND end_at>$3`,
      values: [
        tenantA.tenantId,
        tenantA.unitId,
        "2030-01-03T00:00:00.000Z",
        "2030-01-03T06:00:00.000Z"
      ],
      expectedIndexes: ["idx_appointments_active_availability"],
      broadRowThreshold: 600
    }));
    measurements.push(await measure(client, {
      name: "DB-03 alert receipts by user and alert",
      sql: `SELECT alert_id,read_at,notified_at,created_at
            FROM system_alert_receipts
            WHERE tenant_id=$1 AND user_id=$2 AND alert_id>=$3
            ORDER BY alert_id LIMIT 100`,
      values: [tenantA.tenantId, tenantA.userId, alertBoundary.alert_id],
      expectedIndexes: ["idx_alert_receipts_user_alert"],
      broadRowThreshold: 100
    }));
    measurements.push(await measure(client, {
      name: "DB-03 current alert listing",
      sql: `SELECT a.id,a.created_at,r.notified_at,r.read_at
            FROM system_alerts a
            LEFT JOIN system_alert_receipts r
              ON r.alert_id=a.id AND r.tenant_id=a.tenant_id AND r.user_id=$2
            WHERE a.tenant_id=$1 AND r.user_id IS NOT NULL
            ORDER BY a.created_at DESC,a.id DESC
            LIMIT 50`,
      values: [tenantA.tenantId, tenantA.userId],
      expectedIndexes: [
        "system_alerts_tenant_created_idx",
        "idx_alert_receipts_user_alert"
      ],
      broadRowThreshold: 100
    }));

    const failedMeasurements = measurements.filter((measurement) => !measurement.passed);
    const report = {
      schemaVersion: 1,
      status: failedMeasurements.length ? "failed" : "passed",
      database: "disposable-uuid-redacted",
      dataset: {
        tenants: 2,
        messages: MESSAGE_ROWS_PER_TENANT * 2,
        tiedTimestampGroupSize: MESSAGE_TIMESTAMP_TIE_GROUP,
        alerts: ALERT_ROWS_PER_TENANT * 2,
        receipts: ALERT_ROWS_PER_TENANT * 2,
        appointments: APPOINTMENT_ROWS_PER_TENANT * 2 + 1
      },
      baseline: "same warmed database with indexscan/indexonlyscan/bitmapscan disabled locally",
      tenantIsolation: "passed",
      cursorCompleteness: "passed",
      activeAppointmentConcurrency: "exactly-one; competing insert rejected with 23505",
      measurements
    };
    console.log("DB_VOLUME_AUDIT_JSON_START");
    console.log(JSON.stringify(report, null, 2));
    console.log("DB_VOLUME_AUDIT_JSON_END");
    if (failedMeasurements.length) {
      throw new Error(`Database volume audit failed: ${failedMeasurements.map((item) => item.name).join(", ")}`);
    }
  } finally {
    await client.end();
  }
} finally {
  if (databaseCreated) {
    // PostgreSQL 16 FORCE closes any remaining audit sessions. Cleanup errors
    // are intentionally not swallowed: a leaked disposable database fails the
    // audit instead of becoming invisible operational debt.
    await controller.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  }
  await controller.end().catch(() => undefined);
}
