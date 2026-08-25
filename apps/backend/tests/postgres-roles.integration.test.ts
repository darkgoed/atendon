import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { runMigrations } from "../src/db/migration-runner.js";
import { withTenantTransaction } from "../src/db/tenant-transaction.js";
import { AiAttendanceEvaluator } from "../src/modules/agent-improvement/evaluator.js";
import type { AiRouter } from "../src/modules/ai-router/openrouter.js";

const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const databaseName = `atendon_sec01_${suffix}`;
const ownerRole = `atendon_owner_${suffix}`;
const migrationRole = `atendon_migration_${suffix}`;
const runtimeRole = `atendon_app_${suffix}`;
const migrationPassword = `migration-${randomUUID()}`;
const runtimePassword = `runtime-${randomUUID()}`;
const source = new URL(config.DATABASE_URL);
const adminUrl = new URL(source);
adminUrl.pathname = "/postgres";
const targetAdminUrl = new URL(source);
targetAdminUrl.pathname = `/${databaseName}`;
const migrationUrl = new URL(targetAdminUrl);
migrationUrl.username = migrationRole;
migrationUrl.password = migrationPassword;
const runtimeUrl = new URL(targetAdminUrl);
runtimeUrl.username = runtimeRole;
runtimeUrl.password = runtimePassword;
const provisionScript = fileURLToPath(new URL("../../../deploy/postgres/provision-roles.sh", import.meta.url));
const migrationDirectory = fileURLToPath(new URL("../src/db/migrations", import.meta.url));

let admin!: pg.Client;
let targetAdmin!: pg.Client;
let runtimePool!: pg.Pool;
let databaseCreated = false;
let adminConnected = false;
let tenantA = "";
let tenantB = "";
let claimA = "";
let claimB = "";
let messageA = "";
let versionA = "";
let conversationA = "";
let tenantBClaimInput!: {
  tenantId: string;
  conversationId: string;
  messageId: string;
  journalId: string;
};

function provisionRoles() {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: adminUrl.hostname,
    PGPORT: adminUrl.port || "5432",
    POSTGRES_USER: decodeURIComponent(adminUrl.username),
    POSTGRES_PASSWORD: decodeURIComponent(adminUrl.password),
    POSTGRES_DB: databaseName,
    ATENDON_OWNER_DB_ROLE: ownerRole,
    ATENDON_MIGRATION_DB_USER: migrationRole,
    ATENDON_MIGRATION_DB_PASSWORD: migrationPassword,
    ATENDON_RUNTIME_DB_USER: runtimeRole,
    ATENDON_RUNTIME_DB_PASSWORD: runtimePassword
  };
  // Reproduce `docker compose exec`: the image provides POSTGRES_* but does
  // not automatically translate those variables to libpq's PG* variables.
  delete environment.PGUSER;
  delete environment.PGPASSWORD;
  execFileSync("sh", [provisionScript], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function setPilotRls(enabled: boolean): Promise<void> {
  const migration = new pg.Client({ connectionString: migrationUrl.toString() });
  await migration.connect();
  try {
    await migration.query(`SET ROLE "${ownerRole}"`);
    await migration.query(
      `ALTER TABLE agent_message_transaction_claims ${enabled ? "ENABLE" : "DISABLE"} ROW LEVEL SECURITY`
    );
    if (enabled) {
      await migration.query("ALTER TABLE agent_message_transaction_claims FORCE ROW LEVEL SECURITY");
    }
    await migration.query("RESET ROLE");
  } finally {
    await migration.end();
  }
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  adminConnected = true;
  const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [databaseName]);
  if (existing.rows[0]) throw new Error(`Disposable SEC-01 database already exists: ${databaseName}`);
  await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
  databaseCreated = true;
  provisionRoles();
  const migration = new pg.Client({ connectionString: migrationUrl.toString() });
  try {
    await migration.connect();
    await runMigrations(migration, migrationDirectory, () => undefined, { ownerRole });
    expect((await migration.query("SELECT current_user")).rows[0].current_user).toBe(migrationRole);
  } finally {
    await migration.end();
  }
  // Re-running after objects exist proves ownership repair and grants are idempotent.
  provisionRoles();
  // 0080 deliberately stages the policy disabled for compatibility with the
  // previous artifact. This mirrors the explicit post-deploy activation.
  await setPilotRls(true);

  targetAdmin = new pg.Client({ connectionString: targetAdminUrl.toString() });
  await targetAdmin.connect();
  const seedClaim = async (label: string) => {
    const tenantId = (await targetAdmin.query<{ id: string }>(
      "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
      [`SEC-02 ${label} ${suffix}`]
    )).rows[0].id;
    const sessionId = (await targetAdmin.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id) VALUES($1) RETURNING id",
      [tenantId]
    )).rows[0].id;
    const agentId = (await targetAdmin.query<{ id: string }>(
      `INSERT INTO agent_configs(tenant_id,system_prompt,ai_model)
       VALUES($1,'SEC-02','model/agent') RETURNING id`,
      [tenantId]
    )).rows[0].id;
    const versionId = (await targetAdmin.query<{ active_version_id: string }>(
      "SELECT active_version_id FROM agent_configs WHERE id=$1",
      [agentId]
    )).rows[0].active_version_id;
    await targetAdmin.query(
      `UPDATE tenant_ai_settings
       SET evaluator_model='model/evaluator',ai_evaluations_enabled=true
       WHERE tenant_id=$1`,
      [tenantId]
    );
    const conversationId = (await targetAdmin.query<{ id: string }>(
      `INSERT INTO conversations(tenant_id,session_id,contact_phone)
       VALUES($1,$2,$3) RETURNING id`,
      [tenantId, sessionId, "5511900000001"]
    )).rows[0].id;
    const messageId = (await targetAdmin.query<{ id: string }>(
      `INSERT INTO messages(conversation_id,sender,content,agent_config_version_id)
       VALUES($1,'agent',$2,$3) RETURNING id`,
      [conversationId, `SEC-02 ${label}`, versionId]
    )).rows[0].id;
    const journalId = (await targetAdmin.query<{ id: string }>(
      `INSERT INTO ai_tool_call_journal(
         tenant_id,conversation_id,inbound_external_id,ai_turn_id,call_ordinal,
         tool_name,arguments_hash,status,result_text
       ) VALUES($1,$2,$3,$4,0,'qualificar_lead',$5,'completed','{}') RETURNING id`,
      [tenantId, conversationId, `sec02-${label}-${suffix}`, randomUUID(), label.repeat(64).slice(0, 64)]
    )).rows[0].id;
    const claimId = (await targetAdmin.query<{ id: string }>(
      `INSERT INTO agent_message_transaction_claims(
         tenant_id,conversation_id,message_id,journal_id,action,
         claim_type,normalized_value,value_hash
       ) VALUES($1,$2,$3,$4,'qualify_lead','transaction_status',$5,$6)
       RETURNING id`,
      [tenantId, conversationId, messageId, journalId, label, label.repeat(64).slice(0, 64)]
    )).rows[0].id;
    return { tenantId, conversationId, messageId, journalId, claimId, versionId };
  };
  const seededA = await seedClaim("a");
  const seededB = await seedClaim("b");
  tenantA = seededA.tenantId;
  tenantB = seededB.tenantId;
  claimA = seededA.claimId;
  claimB = seededB.claimId;
  messageA = seededA.messageId;
  versionA = seededA.versionId;
  conversationA = seededA.conversationId;
  tenantBClaimInput = seededB;
  runtimePool = new pg.Pool({ connectionString: runtimeUrl.toString(), max: 1 });
  // DROP DATABASE ... WITH (FORCE) can race the final idle-client shutdown.
  // The pool is intentionally being disposed immediately after this suite.
  runtimePool.on("error", () => undefined);
}, 30_000);

afterAll(async () => {
  await runtimePool?.end().catch(() => undefined);
  await targetAdmin?.end().catch(() => undefined);
  if (adminConnected) {
    if (databaseCreated) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    }
    for (const role of [runtimeRole, migrationRole, ownerRole]) {
      await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
    }
    await admin.end().catch(() => undefined);
  }
}, 30_000);

describe("PostgreSQL least-privilege roles", () => {
  it("supports the manual container invocation with POSTGRES_* bootstrap credentials", () => {
    expect(() => provisionRoles()).not.toThrow();
  });

  it("provisions an owner without login and two non-administrative login roles", async () => {
    const roles = await admin.query<{
      rolname: string;
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
       FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname`,
      [[ownerRole, migrationRole, runtimeRole]]
    );
    expect(roles.rows).toHaveLength(3);
    for (const role of roles.rows) {
      expect(role).toMatchObject({
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false
      });
      expect(role.rolcanlogin).toBe(role.rolname !== ownerRole);
      // Só o owner tem BYPASSRLS, e ele é NOLOGIN: as tabelas do piloto usam
      // FORCE ROW LEVEL SECURITY, então sem bypass o pg_dump --role=<owner>
      // falha fechado e o backup fica impossível. As roles que fazem login
      // continuam sujeitas às policies.
      expect(role.rolbypassrls).toBe(role.rolname === ownerRole);
    }
    const membership = await admin.query<{ migration_is_member: boolean; runtime_is_member: boolean }>(
      `SELECT pg_has_role($1,$2,'MEMBER') migration_is_member,
              pg_has_role($3,$2,'MEMBER') runtime_is_member`,
      [migrationRole, ownerRole, runtimeRole]
    );
    expect(membership.rows[0]).toEqual({
      migration_is_member: true,
      runtime_is_member: false
    });
  });

  it("owns schema objects only through the NOLOGIN owner", async () => {
    const ownership = await targetAdmin.query<{ non_owner_objects: number; runtime_owned_objects: number }>(
      `SELECT
         count(*) FILTER (WHERE owner.rolname<>$1)::int non_owner_objects,
         count(*) FILTER (WHERE owner.rolname=$2)::int runtime_owned_objects
       FROM pg_class object
       JOIN pg_namespace namespace ON namespace.oid=object.relnamespace
       JOIN pg_roles owner ON owner.oid=object.relowner
       WHERE namespace.nspname='public' AND object.relkind IN ('r','p','S','v','m')
         AND NOT EXISTS (
           SELECT 1 FROM pg_depend dependency
           WHERE dependency.classid='pg_class'::regclass
             AND dependency.objid=object.oid
             AND dependency.deptype='e'
         )`,
      [ownerRole, runtimeRole]
    );
    expect(ownership.rows[0]).toEqual({
      non_owner_objects: 0,
      runtime_owned_objects: 0
    });
  });

  it("allows required runtime DML and sequence use", async () => {
    const runtime = new pg.Client({ connectionString: runtimeUrl.toString() });
    try {
      await runtime.connect();
      const tenant = await runtime.query<{ id: string }>(
        "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
        [`SEC-01 runtime ${suffix}`]
      );
      await runtime.query("UPDATE tenants SET name=$2 WHERE id=$1", [tenant.rows[0].id, `SEC-01 updated ${suffix}`]);
      expect((await runtime.query("SELECT name FROM tenants WHERE id=$1", [tenant.rows[0].id])).rows[0].name)
        .toBe(`SEC-01 updated ${suffix}`);
      await runtime.query("DELETE FROM tenants WHERE id=$1", [tenant.rows[0].id]);
    } finally {
      await runtime.end();
    }
  });

  it.each([
    ["CREATE ROLE", `CREATE ROLE "forbidden_role_${suffix}"`],
    ["CREATE DATABASE", `CREATE DATABASE "forbidden_database_${suffix}"`],
    ["CREATE schema object", `CREATE TABLE public."forbidden_table_${suffix}"(id integer)`],
    ["escalate itself", `ALTER ROLE "${runtimeRole}" SUPERUSER`],
    ["assume owner", `SET ROLE "${ownerRole}"`]
  ])("blocks runtime administrative action: %s", async (_label, sql) => {
    const runtime = new pg.Client({ connectionString: runtimeUrl.toString() });
    try {
      await runtime.connect();
      await expect(runtime.query(sql)).rejects.toMatchObject({ code: "42501" });
    } finally {
      await runtime.end();
    }
  });

  it("fails closed without tenant context and rejects invalid tenant UUIDs before checkout", async () => {
    expect((await runtimePool.query("SELECT id FROM agent_message_transaction_claims")).rows).toEqual([]);
    await expect(runtimePool.query(
      `INSERT INTO agent_message_transaction_claims(
         tenant_id,conversation_id,message_id,journal_id,action,
         claim_type,normalized_value,value_hash
       ) VALUES($1,$2,$3,$4,'qualify_lead','qualification_registered','true',$5)`,
      [
        tenantBClaimInput.tenantId,
        tenantBClaimInput.conversationId,
        tenantBClaimInput.messageId,
        tenantBClaimInput.journalId,
        "c".repeat(64)
      ]
    )).rejects.toMatchObject({ code: "42501" });

    const connect = vi.fn();
    await expect(withTenantTransaction(
      { connect } as unknown as Pick<pg.Pool, "connect">,
      "not-a-uuid",
      async () => undefined
    )).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });

  it("enforces SELECT, INSERT, UPDATE and DELETE isolation even without tenant filters", async () => {
    await withTenantTransaction(runtimePool, tenantA, async (client) => {
      const visible = await client.query<{ id: string; tenant_id: string }>(
        "SELECT id,tenant_id FROM agent_message_transaction_claims ORDER BY id"
      );
      expect(visible.rows).toEqual([{ id: claimA, tenant_id: tenantA }]);

      await expect(client.query(
        `INSERT INTO agent_message_transaction_claims(
           tenant_id,conversation_id,message_id,journal_id,action,
           claim_type,normalized_value,value_hash
         ) VALUES($1,$2,$3,$4,'qualify_lead','qualification_registered','true',$5)`,
        [
          tenantBClaimInput.tenantId,
          tenantBClaimInput.conversationId,
          tenantBClaimInput.messageId,
          tenantBClaimInput.journalId,
          "d".repeat(64)
        ]
      )).rejects.toMatchObject({ code: "42501" });
    });

    await withTenantTransaction(runtimePool, tenantA, async (client) => {
      expect((await client.query(
        "UPDATE agent_message_transaction_claims SET normalized_value=normalized_value WHERE id=$1",
        [claimB]
      )).rowCount).toBe(0);
      expect((await client.query(
        "DELETE FROM agent_message_transaction_claims WHERE id=$1",
        [claimB]
      )).rowCount).toBe(0);
    });
    expect((await targetAdmin.query(
      "SELECT id FROM agent_message_transaction_claims WHERE id=$1",
      [claimB]
    )).rowCount).toBe(1);
  });

  it("does not leak SET LOCAL tenant context when a pooled connection is reused", async () => {
    await withTenantTransaction(runtimePool, tenantA, async (client) => {
      expect((await client.query(
        "SELECT tenant_id FROM agent_message_transaction_claims"
      )).rows).toEqual([{ tenant_id: tenantA }]);
    });

    expect((await runtimePool.query(
      `SELECT NULLIF(current_setting('app.tenant_id',true),'') tenant_id`
    )).rows).toEqual([{ tenant_id: null }]);
    expect((await runtimePool.query("SELECT id FROM agent_message_transaction_claims")).rows).toEqual([]);

    await withTenantTransaction(runtimePool, tenantB, async (client) => {
      expect((await client.query(
        "SELECT tenant_id FROM agent_message_transaction_claims"
      )).rows).toEqual([{ tenant_id: tenantB }]);
    });
  });

  it("lets an evaluator job acquire its own tenant-scoped claims session", async () => {
    const complete = vi.fn<AiRouter["complete"]>().mockImplementation(async (input) => {
      const payload = JSON.parse(String(input.history[0]?.content ?? "{}")) as {
        tools: Array<{ toolName: string }>;
      };
      expect(payload.tools).toHaveLength(1);
      expect(payload.tools[0]).toMatchObject({ toolName: "qualificar_lead" });
      const score = { score: 90, rationale: "ok", evidenceMessageIds: [messageA] };
      return {
        text: JSON.stringify({
          scores: {
            correctness: score,
            task_completion: score,
            continuity: score,
            communication: score,
            security_privacy: score,
            tool_usage: score,
            handoff: score
          },
          violations: [],
          overallScore: 90,
          hasCriticalFailure: false,
          summary: "ok"
        }),
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0
      };
    });
    const evaluator = new AiAttendanceEvaluator(runtimePool, { complete }, config);

    await expect(evaluator.process({
      tenantId: tenantA,
      conversationId: conversationA,
      agentConfigVersionId: versionA,
      trigger: "manual"
    })).resolves.toBe("created");
    expect(complete).toHaveBeenCalledOnce();
  });

  it("lets the migration role reversibly disable and restore the pilot policy", async () => {
    await setPilotRls(false);
    try {
      expect((await runtimePool.query(
        "SELECT id FROM agent_message_transaction_claims ORDER BY id"
      )).rows).toHaveLength(2);
    } finally {
      await setPilotRls(true);
    }

    expect((await runtimePool.query("SELECT id FROM agent_message_transaction_claims")).rows).toEqual([]);
  });
});
