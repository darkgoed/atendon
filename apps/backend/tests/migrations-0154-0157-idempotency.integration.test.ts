import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { config } from "../src/config.js";
import { runMigrations } from "../src/db/migration-runner.js";
import { fileURLToPath } from "node:url";

const migrationDirectory = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
const sourceUrl = new URL(config.DATABASE_URL);
const adminUrl = new URL(sourceUrl);
adminUrl.pathname = "/postgres";
const databaseName = `atendon_0154_0157_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = new URL(sourceUrl);
databaseUrl.pathname = `/${databaseName}`;
const adminPool = new pg.Pool({ connectionString: adminUrl.toString() });
const pool = new pg.Pool({ connectionString: databaseUrl.toString() });
let databaseCreated = false;
let temporaryRoot = "";
let tenantId = "";
let userId = "";
let queueId = "";
let sessionId = "";
let conversationId = "";
let layoutUserId = "";

interface EssentialSnapshot {
  queue_columns: number;
  queue_indexes: number;
  channel_check: number;
  channel_index: number;
  pipeline_column: number;
  outcome_column: number;
  layout_constraint: number;
  queue_rows: number;
  conversation_queue: string | null;
  layout_rows: number;
}

async function snapshot(client: pg.Pool | pg.Client): Promise<EssentialSnapshot> {
  const result = await client.query<EssentialSnapshot>(`SELECT
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='conversation_queues' AND column_name IN ('tenant_id','name','color','position','is_initial','is_resolved')) queue_columns,
    (SELECT count(*)::int FROM pg_indexes WHERE indexname IN ('uq_conversation_queues_active_name','uq_conversation_queues_initial','uq_conversation_queues_resolved','idx_conversation_queues_order')) queue_indexes,
    (SELECT count(*)::int FROM pg_constraint WHERE conname='whatsapp_sessions_channel_check') channel_check,
    (SELECT count(*)::int FROM pg_indexes WHERE indexname='idx_whatsapp_sessions_tenant_channel_active') channel_index,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='tenants' AND column_name='pipeline_enforce_transitions') pipeline_column,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='scheduling_leads' AND column_name='outcome_metadata') outcome_column,
    (SELECT count(*)::int FROM pg_constraint WHERE conname='dashboard_layouts_items_length_check') layout_constraint,
    (SELECT count(*)::int FROM conversation_queues WHERE tenant_id=$1) queue_rows,
    (SELECT queue_id::text FROM conversations WHERE id=$2),
    (SELECT count(*)::int FROM dashboard_layouts WHERE workspace_id=$1) layout_rows`, [tenantId, conversationId]);
  return result.rows[0];
}

beforeAll(async () => {
  const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  const cutoff = files.indexOf("0157_connection_channel.sql");
  expect(cutoff).toBeGreaterThanOrEqual(0);
  const stagedFiles = files.slice(0, cutoff + 1);
  temporaryRoot = await mkdtemp(join(tmpdir(), "atendon-0154-0157-"));
  const stagedDirectory = join(temporaryRoot, "migrations");
  await mkdir(stagedDirectory);
  for (const file of stagedFiles) {
    await copyFile(join(migrationDirectory, file), join(stagedDirectory, file));
  }

  await adminPool.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
  databaseCreated = true;
  const migrationClient = new pg.Client({ connectionString: databaseUrl.toString() });
  await migrationClient.connect();
  const result = await runMigrations(migrationClient, stagedDirectory, () => undefined);
  await migrationClient.end();
  // Isolate the historical proof from later migrations: 0158 adds triggers,
  // indexes and foreign keys that intentionally depend on 0157's channel.
  expect(result.applied).toEqual(stagedFiles);
  expect(result.existing).toEqual([]);
  expect(result.adopted).toEqual([]);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantId = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id",
      [`Migration ${randomUUID()}`, `migration-${randomUUID()}`]
    )).rows[0].id;
    await ensureWorkspaceDefaultRoles(client, tenantId);
    userId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`migration-${randomUUID()}@test.local`]
    )).rows[0].id;
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'`, [tenantId, userId]
    );
    layoutUserId = userId;
    queueId = (await client.query<{ id: string }>(
      "SELECT id FROM conversation_queues WHERE tenant_id=$1 AND is_initial", [tenantId]
    )).rows[0].id;
    sessionId = (await client.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,label,is_primary,status) VALUES($1,'Migration session',true,'connected') RETURNING id", [tenantId]
    )).rows[0].id;
    conversationId = (await client.query<{ id: string }>(
      `INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,queue_id)
       VALUES($1,$2,'5511999000001','Migration conversation',$3) RETURNING id`, [tenantId, sessionId, queueId]
    )).rows[0].id;
    await client.query("INSERT INTO dashboard_layouts(workspace_id,user_id,items) VALUES($1,$2,$3::jsonb)", [tenantId, layoutUserId, JSON.stringify(["conversations_started"])]);
    await client.query("UPDATE tenants SET pipeline_enforce_transitions=false WHERE id=$1", [tenantId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  if (tenantId) await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  if (userId) await pool.query("DELETE FROM users WHERE id=$1", [userId]);
  await pool.end();
  if (databaseCreated) {
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
      [databaseName]
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  }
  await adminPool.end();
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

describe("0154–0157 em banco descartável", () => {
  it("marca tenants existentes como legados, deixa os novos livres e preserva a escolha ao reexecutar 0156–0157", async () => {
    const sql0156 = await readFile(`${migrationDirectory}/0156_pipeline_free_movement.sql`, "utf8");
    const sql0157 = await readFile(`${migrationDirectory}/0157_connection_channel.sql`, "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Reproduz o estado imediatamente após 0155 dentro de uma transação:
      // a migration real é executada abaixo, sem substituir o schema por um stub.
      await client.query("ALTER TABLE tenants DROP COLUMN pipeline_enforce_transitions");
      await client.query("ALTER TABLE scheduling_leads DROP COLUMN outcome_metadata");
      await client.query("ALTER TABLE whatsapp_sessions DROP COLUMN channel");
      await client.query("DROP INDEX IF EXISTS idx_whatsapp_sessions_tenant_channel_active");

      const legacy = (await client.query<{ id: string }>(
        "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Legacy antes de 0156 ${randomUUID()}`]
      )).rows[0].id;
      await client.query(sql0156);
      await client.query(sql0157);
      const legacyValue = await client.query<{ value: boolean }>(
        "SELECT pipeline_enforce_transitions value FROM tenants WHERE id=$1", [legacy]
      );
      expect(legacyValue.rows[0].value).toBe(true);

      const fresh = (await client.query<{ id: string }>(
        "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Novo depois de 0156 ${randomUUID()}`]
      )).rows[0].id;
      expect((await client.query<{ value: boolean }>(
        "SELECT pipeline_enforce_transitions value FROM tenants WHERE id=$1", [fresh]
      )).rows[0].value).toBe(false);

      await client.query(sql0156);
      await client.query(sql0157);
      expect((await client.query<{ value: boolean }>(
        "SELECT pipeline_enforce_transitions value FROM tenants WHERE id=$1", [legacy]
      )).rows[0].value).toBe(true);
      expect((await client.query<{ value: boolean }>(
        "SELECT pipeline_enforce_transitions value FROM tenants WHERE id=$1", [fresh]
      )).rows[0].value).toBe(false);

      const channel = await client.query<{ column_default: string | null; is_nullable: string }>(
        `SELECT column_default,is_nullable FROM information_schema.columns
         WHERE table_name='whatsapp_sessions' AND column_name='channel'`
      );
      expect(channel.rows[0]).toMatchObject({ column_default: "'whatsapp'::text", is_nullable: "NO" });
      await expect(client.query(
        "INSERT INTO whatsapp_sessions(tenant_id,label,status,channel) VALUES($1,'invalid-channel','connected','telegram')", [fresh]
      )).rejects.toThrow(/whatsapp_sessions_channel_check|violates check constraint/i);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("mantém o schema e os dados essenciais ao executar os quatro SQL diretamente de novo", async () => {
    const before = await snapshot(pool);
    const errors: string[] = [];
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const filename of [
        "0154_conversation_queues.sql",
        "0155_dashboard_layout_capacity.sql",
        "0156_pipeline_free_movement.sql",
        "0157_connection_channel.sql"
      ]) {
        const sql = await readFile(`${migrationDirectory}/${filename}`, "utf8");
        await client.query("SAVEPOINT rerun_migration");
        try {
          await client.query(sql);
          await client.query("RELEASE SAVEPOINT rerun_migration");
        } catch (error) {
          errors.push(`${filename}: ${error instanceof Error ? error.message : String(error)}`);
          await client.query("ROLLBACK TO SAVEPOINT rerun_migration");
          await client.query("RELEASE SAVEPOINT rerun_migration");
        }
      }
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    expect(errors, `reexecução direta falhou: ${errors.join(" | ")}`).toEqual([]);
    expect(await snapshot(pool)).toEqual(before);
  });

  it("preserva tenant ao apagar fila pela FK composta e aceita layout de 60 itens", async () => {
    await pool.query("DELETE FROM conversation_queues WHERE id=$1 AND tenant_id=$2", [queueId, tenantId]);
    const row = await pool.query<{ tenant_id: string; queue_id: string | null }>(
      "SELECT tenant_id,queue_id FROM conversations WHERE id=$1", [conversationId]
    );
    expect(row.rows[0]).toEqual({ tenant_id: tenantId, queue_id: null });
    const items = Array.from({ length: 60 }, (_, index) => `widget_${index}`);
    await pool.query("UPDATE dashboard_layouts SET items=$3::jsonb WHERE workspace_id=$1 AND user_id=$2", [tenantId, layoutUserId, JSON.stringify(items)]);
    const layout = await pool.query<{ count: number }>(
      "SELECT jsonb_array_length(items)::int count FROM dashboard_layouts WHERE workspace_id=$1 AND user_id=$2", [tenantId, layoutUserId]
    );
    expect(layout.rows[0].count).toBe(60);
  });

  it("não reseta preferência false na reexecução de 0156", async () => {
    const before = await pool.query<{ value: boolean }>(
      "SELECT pipeline_enforce_transitions value FROM tenants WHERE id=$1", [tenantId]
    );
    expect(before.rows[0].value).toBe(false);
    const sql = await readFile(`${migrationDirectory}/0156_pipeline_free_movement.sql`, "utf8");
    await pool.query(sql);
    const after = await pool.query<{ value: boolean }>(
      "SELECT pipeline_enforce_transitions value FROM tenants WHERE id=$1", [tenantId]
    );
    expect(after.rows[0].value).toBe(false);
  });
});
