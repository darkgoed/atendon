import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { buildApp } from "../src/app.js";
import { DASHBOARD_WIDGET_KEYS } from "../src/modules/dashboard-widgets/catalog.js";
import { config } from "../src/config.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const suffix = randomUUID();
let tenantA = "";
let tenantB = "";
let ownerA = "";
let ownerB = "";
let ownerACookie = "";
let ownerBCookie = "";

async function member(client: pg.PoolClient, tenantId: string, userId: string, role: string) {
  await client.query(
    `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
     SELECT $1,$2,id,'active',now() FROM workspace_roles
     WHERE workspace_id=$1 AND name=$3`,
    [tenantId, userId, role]
  );
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantA = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Bundle A ${suffix}`])).rows[0].id;
    tenantB = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Bundle B ${suffix}`])).rows[0].id;
    await client.query(`INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled) VALUES
      ($1,'dashboard_v1',true),($1,'dashboard_widgets_v1',true),($1,'leads_v1',true),($1,'pipeline_v1',true),($1,'appointments_v1',true),($1,'workspace_admin_v1',true),
      ($2,'dashboard_v1',true),($2,'dashboard_widgets_v1',true),($2,'leads_v1',true),($2,'pipeline_v1',true),($2,'appointments_v1',true),($2,'workspace_admin_v1',true)
      ON CONFLICT (tenant_id,flag_key) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=now()`, [tenantA, tenantB]);
    await ensureWorkspaceDefaultRoles(client, tenantA);
    await ensureWorkspaceDefaultRoles(client, tenantB);
    ownerA = (await client.query<{ id: string }>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`bundle-owner-a-${suffix}@test.local`])).rows[0].id;
    ownerB = (await client.query<{ id: string }>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`bundle-owner-b-${suffix}@test.local`])).rows[0].id;
    await member(client, tenantA, ownerA, "OWNER");
    await member(client, tenantB, ownerB, "OWNER");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
  ownerACookie = `atendon_session=${await createSessionToken({ userId: ownerA, tenantId: tenantA, email: `bundle-owner-a-${suffix}@test.local`, role: "OWNER" })}`;
  ownerBCookie = `atendon_session=${await createSessionToken({ userId: ownerB, tenantId: tenantB, email: `bundle-owner-b-${suffix}@test.local`, role: "OWNER" })}`;
});

afterAll(async () => {
  await pool.query("DELETE FROM tenant_feature_flag_overrides WHERE tenant_id=ANY($1::uuid[])", [[tenantA, tenantB]]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[ownerA, ownerB]]);
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantA, tenantB]]);
  await pool.end();
  await app.close();
});

describe("GET /dashboard?include=widgets (bundle consolidado)", () => {
  it("payload de cada widget do bundle é idêntico ao endpoint individual", async () => {
    const bundle = await app.inject({ url: "/dashboard?include=widgets&period=today", headers: { cookie: ownerACookie } });
    expect(bundle.statusCode).toBe(200);
    const widgets = bundle.json().widgets as Record<string, { key: string; data: unknown }>;
    expect(Object.keys(widgets).length).toBeGreaterThan(0);
    expect(Object.keys(widgets).every((key) => (DASHBOARD_WIDGET_KEYS as readonly string[]).includes(key))).toBe(true);

    for (const [key, widget] of Object.entries(widgets)) {
      const individual = await app.inject({ url: `/dashboard/widgets/${key}?period=today`, headers: { cookie: ownerACookie } });
      expect(individual.statusCode, `widget ${key}`).toBe(200);
      expect(individual.json(), `widget ${key}`).toEqual(widget);
    }
  });

  it("sem include=widgets o contrato original é preservado (sem chave widgets)", async () => {
    const legacy = await app.inject({ url: "/dashboard?period=today", headers: { cookie: ownerACookie } });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().widgets).toBeUndefined();
    expect(legacy.json().counts).toBeDefined();
  });

  it("bundle é isolado por tenant (widgets de B nunca aparecem para A)", async () => {
    const bundleA = await app.inject({ url: "/dashboard?include=widgets&period=today", headers: { cookie: ownerACookie } });
    const bundleB = await app.inject({ url: "/dashboard?include=widgets&period=today", headers: { cookie: ownerBCookie } });
    expect(bundleA.statusCode).toBe(200);
    expect(bundleB.statusCode).toBe(200);
    const a = bundleA.json().widgets as Record<string, { key: string; data: unknown }>;
    const b = bundleB.json().widgets as Record<string, { key: string; data: unknown }>;
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    // open_conversations conta conversas do tenant — com zero dados em ambos,
    // as respostas são iguais em forma e nunca contêm id de outro tenant.
    expect(JSON.stringify(a)).not.toContain(tenantB);
    expect(JSON.stringify(b)).not.toContain(tenantA);
  });
});
