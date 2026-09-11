import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import {
  DASHBOARD_PRESETS,
  DASHBOARD_PRESET_KEYS,
  DASHBOARD_WIDGET_KEYS
} from "../src/modules/dashboard-widgets/catalog.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const suffix = randomUUID();
let tenantA = ""; let tenantB = ""; let ownerA = ""; let operatorA = ""; let ownerB = "";
let ownerCookie = ""; let operatorCookie = ""; let ownerBCookie = "";

async function addMember(client: pg.PoolClient, tenant: string, user: string, role: string) {
  await client.query(
    `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
     SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name=$3`,
    [tenant, user, role]
  );
}

beforeAll(async () => {
  await app.ready();
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    tenantA = (await c.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`preset-a-${suffix}`])).rows[0].id;
    tenantB = (await c.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`preset-b-${suffix}`])).rows[0].id;
    await c.query(`INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled) VALUES
      ($1,'dashboard_v1',true),($1,'dashboard_widgets_v1',true),($1,'leads_v1',true),($1,'appointments_v1',true),($1,'pipeline_v1',true),($1,'workspace_admin_v1',true),
      ($2,'dashboard_v1',true),($2,'dashboard_widgets_v1',true),($2,'leads_v1',true),($2,'appointments_v1',true),($2,'pipeline_v1',true),($2,'workspace_admin_v1',true)
      ON CONFLICT (tenant_id,flag_key) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=now()`, [tenantA, tenantB]);
    await ensureWorkspaceDefaultRoles(c, tenantA); await ensureWorkspaceDefaultRoles(c, tenantB);
    ownerA = (await c.query<{ id: string }>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`preset-owner-a-${suffix}@test.local`])).rows[0].id;
    operatorA = (await c.query<{ id: string }>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`preset-operator-a-${suffix}@test.local`])).rows[0].id;
    ownerB = (await c.query<{ id: string }>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`preset-owner-b-${suffix}@test.local`])).rows[0].id;
    await addMember(c, tenantA, ownerA, "OWNER"); await addMember(c, tenantA, operatorA, "OPERADOR"); await addMember(c, tenantB, ownerB, "OWNER");
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  const cookie = async (userId: string, tenantId: string, email: string, role: string) =>
    `atendon_session=${await createSessionToken({ userId, tenantId, email, role })}`;
  ownerCookie = await cookie(ownerA, tenantA, `preset-owner-a-${suffix}@test.local`, "OWNER");
  operatorCookie = await cookie(operatorA, tenantA, `preset-operator-a-${suffix}@test.local`, "OPERADOR");
  ownerBCookie = await cookie(ownerB, tenantB, `preset-owner-b-${suffix}@test.local`, "OWNER");
});

afterAll(async () => {
  const tenants = [tenantA, tenantB].filter(Boolean); const users = [ownerA, operatorA, ownerB].filter(Boolean);
  if (tenants.length) await pool.query("DELETE FROM dashboard_layouts WHERE workspace_id=ANY($1::uuid[])", [tenants]);
  if (tenants.length) await pool.query("DELETE FROM tenant_feature_flag_overrides WHERE tenant_id=ANY($1::uuid[])", [tenants]);
  if (tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenants]);
  if (users.length) await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [users]);
  await pool.end(); await app.close();
});

describe("dashboard widget presets and layout boundaries", () => {
  it("lists exactly the three presets and exact key contracts", async () => {
    const response = await app.inject({ url: "/dashboard/widgets/presets", headers: { cookie: ownerCookie } });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as { presets: Array<{ key: string; label: string; description: string; keys: string[] }> };
    expect(body.presets).toHaveLength(3);
    expect(body.presets.map((p) => p.key)).toEqual([...DASHBOARD_PRESET_KEYS]);
    for (const preset of body.presets) expect(preset).toMatchObject(DASHBOARD_PRESETS[preset.key as keyof typeof DASHBOARD_PRESETS]);
    expect(body.presets.find((p) => p.key === "essencial")?.keys).toHaveLength(5);
    expect(body.presets.find((p) => p.key === "comercial")?.keys).toEqual([
      "conversations_started", "appointments_count", "attendances", "sales_count", "lost_sales", "conversion_rate"
    ]);
    expect(body.presets.find((p) => p.key === "gestao_completa")?.keys).toHaveLength(25);
  });

  it("saves five essential visible items, preserves per-user and tenant isolation", async () => {
    const response = await app.inject({ method: "POST", url: "/dashboard/widgets/presets/essencial", headers: { cookie: ownerCookie } });
    expect(response.statusCode, response.body).toBe(200);
    const loaded = await app.inject({ url: "/dashboard/widgets/layout", headers: { cookie: ownerCookie } });
    const items = loaded.json().layout.items as Array<{ key: string; visible: boolean; order: number }>;
    expect(items).toHaveLength(DASHBOARD_WIDGET_KEYS.length);
    expect(items.filter((item) => item.visible).map((item) => item.key)).toEqual([...DASHBOARD_PRESETS.essencial.keys]);
    expect(items.filter((item) => item.visible)).toHaveLength(5);
    expect(items.map((item) => item.order)).toEqual(items.map((_, index) => index));
    expect((await app.inject({ url: "/dashboard/widgets/layout", headers: { cookie: operatorCookie } })).json().layout.source).toBe("default");
    expect((await app.inject({ url: "/dashboard/widgets/layout", headers: { cookie: ownerBCookie } })).json().layout.source).toBe("default");
  });

  it("preserves a custom layout and rejects unknown or duplicate API keys", async () => {
    const custom = await app.inject({
      method: "PUT", url: "/dashboard/widgets/layout", headers: { cookie: ownerCookie },
      payload: { items: [{ key: "sales_count", order: 0, visible: false, size: "small" }] }
    });
    expect(custom.statusCode, custom.body).toBe(200);
    const customLoaded = await app.inject({ url: "/dashboard/widgets/layout", headers: { cookie: ownerCookie } });
    expect(customLoaded.json().layout.items.find((item: { key: string }) => item.key === "sales_count").visible).toBe(false);
    const duplicate = await app.inject({
      method: "PUT", url: "/dashboard/widgets/layout", headers: { cookie: ownerCookie },
      payload: { items: [
        { key: "sales_count", order: 0, visible: true, size: "small" },
        { key: "sales_count", order: 1, visible: false, size: "small" }
      ] }
    });
    expect(duplicate.statusCode).toBe(400);
    const unknown = await app.inject({
      method: "PUT", url: "/dashboard/widgets/layout", headers: { cookie: ownerCookie },
      payload: { items: [{ key: "not_a_widget", order: 0, visible: true, size: "small" }] }
    });
    expect(unknown.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/dashboard/widgets/presets/nope", headers: { cookie: ownerCookie } })).statusCode).toBe(400);
  });

  it("enforces permission and feature gating without changing another tenant", async () => {
    expect((await app.inject({ url: "/dashboard/widgets/presets" })).statusCode).toBe(401);
    const root = await pool.query<{ kill_switch_enabled: boolean }>("SELECT kill_switch_enabled FROM feature_flag_definitions WHERE flag_key='dashboard_widgets_v1'");
    const enabled = root.rows[0]?.kill_switch_enabled ?? false;
    await pool.query("UPDATE feature_flag_definitions SET kill_switch_enabled=true WHERE flag_key='dashboard_widgets_v1'");
    try {
      expect((await app.inject({ url: "/dashboard/widgets/presets", headers: { cookie: ownerCookie } })).statusCode).toBe(409);
      expect((await app.inject({ url: "/dashboard/widgets/presets", headers: { cookie: ownerBCookie } })).statusCode).toBe(409);
    } finally {
      await pool.query("UPDATE feature_flag_definitions SET kill_switch_enabled=$1 WHERE flag_key='dashboard_widgets_v1'", [enabled]);
    }
  });

  it("enforces SQL capacity 60 and rejects 61 without requiring nonexistent API keys", async () => {
    const sixty = Array.from({ length: 60 }, (_, order) => ({ key: "x", order, visible: false, size: "small" }));
    const sixtyOne = [...sixty, { key: "x", order: 60, visible: false, size: "small" }];
    await pool.query("DELETE FROM dashboard_layouts WHERE workspace_id=$1 AND user_id=$2", [tenantA, ownerA]);
    await pool.query("INSERT INTO dashboard_layouts(workspace_id,user_id,items) VALUES($1,$2,$3::jsonb)", [tenantA, ownerA, JSON.stringify(sixty)]);
    await expect(pool.query("UPDATE dashboard_layouts SET items=$3::jsonb WHERE workspace_id=$1 AND user_id=$2", [tenantA, ownerA, JSON.stringify(sixtyOne)])).rejects.toMatchObject({ code: "23514" });
    const api = await app.inject({ method: "PUT", url: "/dashboard/widgets/layout", headers: { cookie: ownerCookie }, payload: { items: [] } });
    expect(api.statusCode).toBe(200);
  });
});
