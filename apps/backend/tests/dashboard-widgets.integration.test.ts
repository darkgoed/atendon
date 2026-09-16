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
let operatorA = "";
let ownerB = "";
let rootUser = "";
let ownerACookie = "";
let operatorACookie = "";
let ownerBCookie = "";
let rootCookie = "";

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
    tenantA = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Dashboard A ${suffix}`])).rows[0].id;
    tenantB = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Dashboard B ${suffix}`])).rows[0].id;
    await client.query(`INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled) VALUES
      ($1,'dashboard_v1',true),($1,'dashboard_widgets_v1',true),($1,'leads_v1',true),($1,'pipeline_v1',true),($1,'appointments_v1',true),($1,'workspace_admin_v1',true),
      ($2,'dashboard_v1',true),($2,'dashboard_widgets_v1',true),($2,'leads_v1',true),($2,'pipeline_v1',true),($2,'appointments_v1',true),($2,'workspace_admin_v1',true)
      ON CONFLICT (tenant_id,flag_key) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=now()`, [tenantA, tenantB]);
    await ensureWorkspaceDefaultRoles(client, tenantA);
    await ensureWorkspaceDefaultRoles(client, tenantB);
    ownerA = (await client.query<{ id: string }>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`dashboard-owner-a-${suffix}@test.local`])).rows[0].id;
    operatorA = (await client.query<{ id: string }>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`dashboard-operator-a-${suffix}@test.local`])).rows[0].id;
    ownerB = (await client.query<{ id: string }>("INSERT INTO users(email,status) VALUES($1,'active') RETURNING id", [`dashboard-owner-b-${suffix}@test.local`])).rows[0].id;
    rootUser = (await client.query<{ id: string }>("INSERT INTO users(email,status,is_root) VALUES($1,'active',true) RETURNING id", [`dashboard-root-${suffix}@test.local`])).rows[0].id;
    await member(client, tenantA, ownerA, "OWNER");
    await member(client, tenantA, operatorA, "OPERADOR");
    await member(client, tenantB, ownerB, "OWNER");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
  const cookie = async (userId: string, tenantId: string, email: string, role: string) =>
    `atendon_session=${await createSessionToken({ userId, tenantId, email, role })}`;
  ownerACookie = await cookie(ownerA, tenantA, `dashboard-owner-a-${suffix}@test.local`, "OWNER");
  operatorACookie = await cookie(operatorA, tenantA, `dashboard-operator-a-${suffix}@test.local`, "OPERADOR");
  ownerBCookie = await cookie(ownerB, tenantB, `dashboard-owner-b-${suffix}@test.local`, "OWNER");
  rootCookie = `atendon_session=${await createSessionToken({
    userId: rootUser,
    tenantId: tenantA,
    email: `dashboard-root-${suffix}@test.local`,
    role: "ROOT",
    isRoot: true,
    rootWorkspaceAccess: true
  })}`;
});

afterAll(async () => {
  await pool.query("DELETE FROM tenant_feature_flag_overrides WHERE tenant_id=ANY($1::uuid[])", [[tenantA, tenantB]]);
  await pool.query("UPDATE feature_flag_definitions SET kill_switch_enabled=false WHERE flag_key='dashboard_widgets_v1'");
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id=$1", [rootUser]);
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantA, tenantB]]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[ownerA, operatorA, ownerB, rootUser]]);
  await pool.end();
  await app.close();
});

describe("dashboard widget REST resources", () => {
  it("filters catalog and data endpoints with effective permissions", async () => {
    const ownerCatalog = await app.inject({ url: "/dashboard/widgets/catalog", headers: { cookie: ownerACookie } });
    expect(ownerCatalog.statusCode).toBe(200);
    expect(ownerCatalog.json().widgets).toHaveLength(DASHBOARD_WIDGET_KEYS.length);
    for (const widget of ownerCatalog.json().widgets as Array<{ key: string }>) {
      const response = await app.inject({ url: `/dashboard/widgets/${widget.key}`, headers: { cookie: ownerACookie } });
      expect(response.statusCode, `${widget.key}: ${response.body}`).toBe(200);
      if (widget.key === "pipeline") {
        expect(response.json().data.stages).toHaveLength(10);
        expect(response.json().data.stages[0]).toMatchObject({
          name: "Novo",
          color: "#64748B",
          status: "novo",
          count: 0
        });
      }
    }
    const operatorCatalog = await app.inject({ url: "/dashboard/widgets/catalog", headers: { cookie: operatorACookie } });
    expect(operatorCatalog.statusCode).toBe(200);
    expect(operatorCatalog.json().widgets.map((widget: { key: string }) => widget.key)).not.toContain("whatsapp_connection");
    expect((await app.inject({ url: "/dashboard/widgets/whatsapp_connection", headers: { cookie: operatorACookie } })).statusCode).toBe(403);
    expect((await app.inject({ url: "/dashboard/widgets/open_conversations", headers: { cookie: operatorACookie } })).statusCode).toBe(200);
  });

  it("counts and selects only active WhatsApp sessions, not a non-primary Instagram session", async () => {
    await pool.query(
      `INSERT INTO whatsapp_sessions(tenant_id,label,is_primary,status,channel,phone_number)
       VALUES
         ($1,'Instagram active',false,'connected','instagram',NULL),
         ($1,'WhatsApp active',false,'connected','whatsapp',NULL),
         ($2,'Foreign WhatsApp',false,'connected','whatsapp',NULL)`,
      [tenantA, tenantB]
    );
    await pool.query(
      `INSERT INTO whatsapp_sessions(tenant_id,label,is_primary,status,channel,archived_at)
       VALUES($1,'WhatsApp archived',false,'connected','whatsapp',now())`,
      [tenantA]
    );

    const response = await app.inject({ url: "/dashboard/widgets/whatsapp_connection", headers: { cookie: ownerACookie } });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      key: "whatsapp_connection",
      data: { status: "connected", total: 1, connected: 1 }
    });
  });

  it("persists a canonical layout per user and workspace, then restores the default", async () => {
    const saved = await app.inject({
      method: "PUT", url: "/dashboard/widgets/layout", headers: { cookie: ownerACookie },
      payload: { items: [
        { key: "recent_alerts", order: 1, visible: true, size: "medium" },
        { key: "whatsapp_connection", order: 0, visible: true, size: "small" }
      ] }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().layout.items.slice(0, 2).map((item: { key: string }) => item.key))
      .toEqual(["whatsapp_connection", "recent_alerts"]);
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM dashboard_layouts WHERE workspace_id=$1 AND user_id=$2",
      [tenantA, ownerA]
    )).rows[0].count).toBe(1);

    const otherUser = await app.inject({ url: "/dashboard/widgets/layout", headers: { cookie: ownerBCookie } });
    expect(otherUser.json().layout.source).toBe("default");
    const loaded = await app.inject({ url: "/dashboard/widgets/layout", headers: { cookie: ownerACookie } });
    expect(loaded.json().layout.source).toBe("saved");

    const reset = await app.inject({ method: "DELETE", url: "/dashboard/widgets/layout", headers: { cookie: ownerACookie } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().layout.source).toBe("default");
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM dashboard_layouts WHERE workspace_id=$1 AND user_id=$2",
      [tenantA, ownerA]
    )).rows[0].count).toBe(0);
  });

  it("allows a root workspace session to persist a personal layout without membership", async () => {
    const response = await app.inject({
      method: "PUT", url: "/dashboard/widgets/layout", headers: { cookie: rootCookie },
      payload: { items: [{ key: "recent_alerts", order: 0, visible: true, size: "medium" }] }
    });
    expect(response.statusCode).toBe(200);
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM dashboard_layouts WHERE workspace_id=$1 AND user_id=$2",
      [tenantA, rootUser]
    )).rows[0].count).toBe(1);
  });

  it("rejects unauthorized layout payloads and honors the operational flag", async () => {
    const forbidden = await app.inject({
      method: "PUT", url: "/dashboard/widgets/layout", headers: { cookie: operatorACookie },
      payload: { items: [{ key: "whatsapp_connection", order: 0, visible: true, size: "small" }] }
    });
    expect(forbidden.statusCode).toBe(403);
    const killSwitch = await app.inject({
      method: "PATCH",
      url: "/root/feature-flags/dashboard_widgets_v1/kill-switch",
      headers: { cookie: rootCookie },
      payload: { enabled: true }
    });
    expect(killSwitch.statusCode, killSwitch.body).toBe(200);
    const disabled = await app.inject({ url: "/dashboard/widgets/catalog", headers: { cookie: ownerACookie } });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json()).toMatchObject({ code: "FEATURE_FLAG_DISABLED", feature: "dashboard_widgets_v1" });
    expect((await app.inject({ url: "/dashboard/widgets/catalog", headers: { cookie: ownerBCookie } })).statusCode).toBe(409);
    expect((await app.inject({
      method: "PATCH",
      url: "/root/feature-flags/dashboard_widgets_v1/kill-switch",
      headers: { cookie: rootCookie },
      payload: { enabled: false }
    })).statusCode).toBe(200);
  });
});
