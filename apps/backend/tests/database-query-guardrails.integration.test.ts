import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { runMigrations } from "../src/db/migration-runner.js";

const source = new URL(config.DATABASE_URL);
const migrationDirectory = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
const guardrailDatabaseName = `atendon_guardrails_${randomUUID().replaceAll("-", "")}`;
const guardrailAdminUrl = new URL(source);
guardrailAdminUrl.pathname = "/postgres";
const guardrailDatabaseUrl = new URL(source);
guardrailDatabaseUrl.pathname = `/${guardrailDatabaseName}`;
const admin = new pg.Pool({ connectionString: guardrailAdminUrl.toString() });
let pool!: pg.Pool;
let databaseCreated = false;
let tenantId: string;
let leadId: string;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${guardrailDatabaseName}"`);
  databaseCreated = true;
  pool = new pg.Pool({ connectionString: guardrailDatabaseUrl.toString() });
  const migrationClient = await pool.connect();
  try {
    await runMigrations(migrationClient, migrationDirectory, () => undefined);
  } finally {
    migrationClient.release();
  }
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`Database guardrails ${randomUUID()}`]
  )).rows[0].id;
  await pool.query(
    "INSERT INTO scheduling_categories(tenant_id,id,name) VALUES($1,'guardrail-category','Guardrail category')",
    [tenantId]
  );
  await pool.query(
    `INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days)
     VALUES($1,'guardrail-unit','Guardrail unit','08:00','18:00',ARRAY[1,2,3,4,5]::smallint[])`,
    [tenantId]
  );
  leadId = (await pool.query<{ id: string }>(
    `INSERT INTO scheduling_leads(tenant_id,phone,interest_category_id,unit_id,source)
     VALUES($1,$2,'guardrail-category','guardrail-unit','test') RETURNING id`,
    [tenantId, `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`]
  )).rows[0].id;
}, 30_000);

afterAll(async () => {
  if (tenantId) await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  if (pool) await pool.end();
  if (databaseCreated) await admin.query(`DROP DATABASE IF EXISTS "${guardrailDatabaseName}"`);
  await admin.end();
});

describe("database query guardrails migration", () => {
  it("creates all planned covering and partial indexes", async () => {
    const names = [
      "idx_alert_receipts_user_alert",
      "idx_appointments_active_availability",
      "idx_appointments_one_active_per_lead",
      "idx_messages_conversation_recent"
    ];
    const result = await pool.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND indexname=ANY($1::text[]) ORDER BY indexname",
      [names]
    );
    expect(result.rows.map(({ indexname }) => indexname)).toEqual(names);
    const definitions = new Map(result.rows.map((row) => [row.indexname, row.indexdef]));
    expect(definitions.get("idx_appointments_one_active_per_lead")).toMatch(/CREATE UNIQUE INDEX.*tenant_id, lead_id.*confirmado.*reagendado/i);
    expect(definitions.get("idx_appointments_active_availability")).toMatch(/INCLUDE \(end_at\).*confirmado.*reagendado/i);
    expect(definitions.get("idx_messages_conversation_recent")).toMatch(/conversation_id, created_at DESC, id DESC/i);
    expect(definitions.get("idx_alert_receipts_user_alert")).toMatch(/tenant_id, user_id, alert_id.*INCLUDE \(read_at, notified_at, created_at\)/i);
  });

  it("physically allows exactly one active appointment per tenant and lead", async () => {
    const insert = (start: string) => pool.query(
      `INSERT INTO scheduling_appointments(tenant_id,lead_id,unit_id,start_at,end_at)
       VALUES($1,$2,'guardrail-unit',$3::timestamptz,$3::timestamptz+interval '1 hour') RETURNING id`,
      [tenantId, leadId, start]
    );
    const results = await Promise.allSettled([
      insert("2031-01-06T09:00:00Z"),
      insert("2031-01-06T11:00:00Z")
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejection = results.find(({ status }) => status === "rejected");
    expect(rejection).toMatchObject({ status: "rejected", reason: expect.objectContaining({ code: "23505" }) });
    expect((await pool.query(
      "SELECT count(*)::int count FROM scheduling_appointments WHERE tenant_id=$1 AND lead_id=$2 AND status IN('confirmado','reagendado')",
      [tenantId, leadId]
    )).rows[0].count).toBe(1);
  });

  it("rejects cross-tenant scheduling notification references", async () => {
    const otherTenantId = (await pool.query<{ id: string }>(
      "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
      [`Other notification tenant ${randomUUID()}`]
    )).rows[0].id;
    try {
      const ownSessionId = (await pool.query<{ id: string }>(
        "INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id",
        [tenantId]
      )).rows[0].id;
      const otherSessionId = (await pool.query<{ id: string }>(
        "INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id",
        [otherTenantId]
      )).rows[0].id;
      const appointmentId = (await pool.query<{ id: string }>(
        `INSERT INTO scheduling_appointments(tenant_id,lead_id,unit_id,start_at,end_at,status)
         VALUES($1,$2,'guardrail-unit','2031-02-03T09:00:00Z','2031-02-03T10:00:00Z','cancelado')
         RETURNING id`,
        [tenantId, leadId]
      )).rows[0].id;

      await expect(pool.query(
        `INSERT INTO scheduling_notification_settings(tenant_id,session_id)
         VALUES($1,$2)`,
        [tenantId, otherSessionId]
      )).rejects.toMatchObject({ code: "23503" });
      await expect(pool.query(
        `INSERT INTO scheduling_appointment_notifications(
           tenant_id,appointment_id,session_id,group_jid,message
         ) VALUES($1,$2,$3,'120363000000000000@g.us','cross-tenant session')`,
        [tenantId, appointmentId, otherSessionId]
      )).rejects.toMatchObject({ code: "23503" });
      await expect(pool.query(
        `INSERT INTO scheduling_appointment_notifications(
           tenant_id,appointment_id,session_id,group_jid,message
         ) VALUES($1,$2,$3,'120363000000000000@g.us','cross-tenant appointment')`,
        [otherTenantId, appointmentId, ownSessionId]
      )).rejects.toMatchObject({ code: "23503" });
    } finally {
      await pool.query("DELETE FROM tenants WHERE id=$1", [otherTenantId]);
    }
  });

  it("aborts with an actionable preflight diagnostic when active duplicates exist", async () => {
    const databaseName = `atendon_preflight_${randomUUID().replaceAll("-", "")}`;
    const adminUrl = new URL(source); adminUrl.pathname = "/postgres";
    const targetUrl = new URL(source); targetUrl.pathname = `/${databaseName}`;
    const preflightAdmin = new pg.Pool({ connectionString: adminUrl.toString() });
    const temporaryRoot = await mkdtemp(join(tmpdir(), "atendon-preflight-"));
    const stagedDirectory = join(temporaryRoot, "staged");
    let created = false;
    try {
      await mkdir(stagedDirectory);
      const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
      await Promise.all(files.filter((file) => file < "0072_").map((file) =>
        copyFile(join(migrationDirectory, file), join(stagedDirectory, file))));
      await preflightAdmin.query(`CREATE DATABASE "${databaseName}"`);
      created = true;
      const target = new pg.Client({ connectionString: targetUrl.toString() });
      try {
        await target.connect();
        await runMigrations(target, stagedDirectory, () => undefined);
        const duplicateTenant = (await target.query<{ id: string }>(
          "INSERT INTO tenants(name,status) VALUES('Preflight duplicate','active') RETURNING id"
        )).rows[0].id;
        await target.query(
          "INSERT INTO scheduling_categories(tenant_id,id,name) VALUES($1,'preflight-category','Preflight category')",
          [duplicateTenant]
        );
        await target.query(
          `INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days)
           VALUES($1,'preflight-unit','Preflight unit','08:00','18:00',ARRAY[1,2,3,4,5]::smallint[])`,
          [duplicateTenant]
        );
        const duplicateLead = (await target.query<{ id: string }>(
          `INSERT INTO scheduling_leads(tenant_id,phone,interest_category_id,unit_id,source)
           VALUES($1,'5511999997777','preflight-category','preflight-unit','test') RETURNING id`,
          [duplicateTenant]
        )).rows[0].id;
        await target.query(
          `INSERT INTO scheduling_appointments(tenant_id,lead_id,unit_id,start_at,end_at)
           VALUES($1,$2,'preflight-unit','2031-01-06T09:00:00Z','2031-01-06T10:00:00Z'),
                 ($1,$2,'preflight-unit','2031-01-06T11:00:00Z','2031-01-06T12:00:00Z')`,
          [duplicateTenant, duplicateLead]
        );
        await copyFile(
          join(migrationDirectory, "0072_database_query_guardrails.sql"),
          join(stagedDirectory, "0072_database_query_guardrails.sql")
        );

        await expect(runMigrations(target, stagedDirectory, () => undefined))
          .rejects.toThrow(/Cannot enforce one active appointment per lead:.*active_appointments=2/);
      } finally {
        await target.end();
      }
    } finally {
      if (created) await preflightAdmin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await preflightAdmin.end();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
