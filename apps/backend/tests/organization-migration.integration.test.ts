import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { runMigrations } from "../src/db/migration-runner.js";

const migrationDirectory = fileURLToPath(new URL("../src/db/migrations",import.meta.url));

async function withUpgradeDatabase(
  name: string,
  work: (client: pg.Client, upgradeDirectory: string) => Promise<void>
) {
  const source = new URL(config.DATABASE_URL);
  const adminUrl = new URL(source);
  adminUrl.pathname = "/postgres";
  const databaseName = `atendon_org_${name}_${randomUUID().replaceAll("-","")}`;
  const databaseUrl = new URL(source);
  databaseUrl.pathname = `/${databaseName}`;
  const temporaryRoot = await mkdtemp(join(tmpdir(),"atendon-org-migration-"));
  const baselineDirectory = join(temporaryRoot,"baseline");
  await mkdir(baselineDirectory);
  const files = (await readdir(migrationDirectory)).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
  for (const file of files.filter((file) => file <= "0097_phone_e164.sql")) {
    await copyFile(join(migrationDirectory,file),join(baselineDirectory,file));
  }
  const admin = new pg.Pool({ connectionString: adminUrl.toString() });
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const client = new pg.Client({ connectionString: databaseUrl.toString() });
    try {
      await client.connect();
      await runMigrations(client,baselineDirectory,() => undefined);
      await copyFile(
        join(migrationDirectory,"0098_case_organization_v1.sql"),
        join(baselineDirectory,"0098_case_organization_v1.sql")
      );
      await work(client,baselineDirectory);
    } finally {
      await client.end();
    }
  } finally {
    if (created) {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1",[databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    }
    await admin.end();
    await rm(temporaryRoot,{ recursive: true, force: true });
  }
}

describe("0098 case organization migration",() => {
  it("backfills tenant-safe conversation links and seeds every lead into the seven-stage pipeline",async () => {
    await withUpgradeDatabase("success",async (client,upgradeDirectory) => {
      const tenantA = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES('Org A','active') RETURNING id")).rows[0].id;
      const tenantB = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES('Org B','active') RETURNING id")).rows[0].id;
      const phone = "5511999112233";
      const leadA = (await client.query<{ id: string }>(
        "INSERT INTO scheduling_leads(tenant_id,phone,name,source) VALUES($1,$2,'Lead A','test') RETURNING id",
        [tenantA,phone]
      )).rows[0].id;
      const leadB = (await client.query<{ id: string }>(
        "INSERT INTO scheduling_leads(tenant_id,phone,name,source) VALUES($1,$2,'Lead B','test') RETURNING id",
        [tenantB,phone]
      )).rows[0].id;
      const conversationA = (await client.query<{ id: string }>(
        "INSERT INTO conversations(tenant_id,contact_phone,contact_name) VALUES($1,$2,'Conversa A') RETURNING id",
        [tenantA,phone]
      )).rows[0].id;
      const conversationB = (await client.query<{ id: string }>(
        "INSERT INTO conversations(tenant_id,contact_phone,contact_name) VALUES($1,$2,'Conversa B') RETURNING id",
        [tenantB,phone]
      )).rows[0].id;

      expect((await runMigrations(client,upgradeDirectory,() => undefined)).applied)
        .toEqual(["0098_case_organization_v1.sql"]);
      const links = await client.query<{ id: string; lead_id: string; pipeline_stage_id: string }>(
        `SELECT conversation.id,conversation.lead_id,lead.pipeline_stage_id
         FROM conversations conversation
         JOIN scheduling_leads lead ON lead.id=conversation.lead_id AND lead.tenant_id=conversation.tenant_id
         WHERE conversation.id=ANY($1::uuid[]) ORDER BY conversation.id`,
        [[conversationA,conversationB]]
      );
      expect(new Map(links.rows.map((row) => [row.id,row.lead_id]))).toEqual(new Map([
        [conversationA,leadA],[conversationB,leadB]
      ]));
      expect(links.rows.every((row) => Boolean(row.pipeline_stage_id))).toBe(true);

      const stages = await client.query<{ tenant_id: string; stages: number; defaults: number }>(
        `SELECT tenant_id,count(*)::int stages,count(*) FILTER (WHERE is_default)::int defaults
         FROM pipeline_stages WHERE tenant_id=ANY($1::uuid[]) GROUP BY tenant_id`,
        [[tenantA,tenantB]]
      );
      expect(stages.rows).toHaveLength(2);
      expect(stages.rows.every((row) => row.stages === 7 && row.defaults === 7)).toBe(true);

      const autoLinked = await client.query<{ lead_id: string }>(
        "INSERT INTO conversations(tenant_id,contact_phone,contact_name) VALUES($1,'5511999556677','Novo contato') RETURNING lead_id",
        [tenantA]
      );
      expect(autoLinked.rows[0].lead_id).toMatch(/^[0-9a-f-]{36}$/);
      await expect(client.query(
        "UPDATE conversations SET lead_id=$2 WHERE id=$1",
        [conversationA,leadB]
      )).rejects.toThrow(/conversations_lead_tenant_fkey/i);
    });
  });

  it.each(["missing","ambiguous"] as const)("aborts and rolls back when a conversation link is %s",async (mode) => {
    await withUpgradeDatabase(mode,async (client,upgradeDirectory) => {
      const tenantId = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",[`Org ${mode}`])).rows[0].id;
      const phone = mode === "missing" ? "5511988000001" : "5511988000002";
      if (mode === "ambiguous") {
        await client.query("ALTER TABLE scheduling_leads DROP CONSTRAINT scheduling_leads_tenant_id_phone_key");
        await client.query("DROP INDEX uq_scheduling_leads_tenant_normalized_phone");
        await client.query("DROP INDEX uq_scheduling_leads_phone_e164");
        await client.query(
          "INSERT INTO scheduling_leads(tenant_id,phone,name,source) VALUES($1,$2,'Duplicado A','test'),($1,$2,'Duplicado B','test')",
          [tenantId,phone]
        );
      }
      await client.query("INSERT INTO conversations(tenant_id,contact_phone) VALUES($1,$2)",[tenantId,phone]);
      await expect(runMigrations(client,upgradeDirectory,() => undefined))
        .rejects.toThrow(/missing or ambiguous conversation lead links/i);
      expect((await client.query<{ count: number }>(
        "SELECT count(*)::int count FROM information_schema.columns WHERE table_name='conversations' AND column_name='lead_id'"
      )).rows[0].count).toBe(0);
    });
  });
});
