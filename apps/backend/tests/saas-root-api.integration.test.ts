import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const suffix = randomUUID();
const password = "saas-security-test";
const adminEmail = `saas-admin-${suffix}@test.local`;
const rootEmail = `saas-root-${suffix}@test.local`;
let tenant = "";
let plan = "";

async function login(email: string) {
  const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(response.statusCode).toBe(200);
  const cookie = response.headers["set-cookie"]!;
  return (Array.isArray(cookie) ? cookie[0] : cookie).split(";")[0];
}

beforeAll(async () => {
  await app.ready();
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    tenant = (await c.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`SaaS security ${suffix}`, `saas-security-${suffix}`])).rows[0].id;
    await ensureWorkspaceDefaultRoles(c, tenant);
    const ph = await hash(password, 4);
    const admin = (await c.query<{ id: string }>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id", [adminEmail, ph])).rows[0].id;
    await c.query("INSERT INTO users(email,password_hash,status,is_root) VALUES($1,$2,'active',true)", [rootEmail, ph]);
    await c.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='ADMIN'", [tenant, admin]);
    plan = (await c.query<{ id: string }>("INSERT INTO plans(code,name,monthly_price_cents,status) VALUES($1,'Security plan',1000,'active') RETURNING id", [`security-${suffix}`])).rows[0].id;
    // Assinatura inicial: sem ela o tenant cai no fail-open e a troca de plano retorna 404.
    await c.query(
      `INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end)
       SELECT $1,id,'ACTIVE',now(),now()+interval '1 month' FROM plans WHERE code='BASIC'`,
      [tenant]
    );
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
});

afterAll(async () => {
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE email=ANY($1::text[]))", [[adminEmail, rootEmail]]);
  await pool.query("DELETE FROM plans WHERE id=$1", [plan]);
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenant]);
  await pool.query("DELETE FROM users WHERE email=ANY($1::text[])", [[adminEmail, rootEmail]]);
  await app.close(); await pool.end();
});

describe("SaaS root authorization", () => {
  it("rejects non-root mutations before any database write", async () => {
    const cookie = await login(adminEmail);
    const before = await pool.query("SELECT monthly_price_cents,status FROM plans WHERE id=$1", [plan]);
    expect((await app.inject({ method: "PATCH", url: `/root/saas/plans/${plan}`, headers: { cookie }, payload: { monthlyPriceCents: 99999 } })).statusCode).toBe(403);
    expect((await pool.query("SELECT monthly_price_cents FROM plans WHERE id=$1", [plan])).rows[0].monthly_price_cents).toBe(before.rows[0].monthly_price_cents);
    expect((await app.inject({ method: "POST", url: `/root/saas/plans/${plan}/archive`, headers: { cookie } })).statusCode).toBe(403);
    expect((await pool.query("SELECT status FROM plans WHERE id=$1", [plan])).rows[0].status).toBe("active");
  });

  it("rejects non-root on at least four additional root APIs", async () => {
    const cookie = await login(adminEmail);
    const requests = [
      app.inject({ url: "/root/saas/plans", headers: { cookie } }),
      app.inject({ method: "POST", url: "/root/saas/plans", headers: { cookie }, payload: { code: "x", name: "x", monthlyPriceCents: 1 } }),
      app.inject({ method: "POST", url: `/root/saas/tenants/${tenant}/subscription`, headers: { cookie }, payload: { planId: plan } }),
      app.inject({ method: "PUT", url: `/root/saas/tenants/${tenant}/overrides/feature/foo`, headers: { cookie }, payload: { boolValue: true } })
    ];
    expect((await Promise.all(requests)).map((r) => r.statusCode)).toEqual([403, 403, 403, 403]);
  });

  it("allows root to create, edit, and archive a plan", async () => {
    const cookie = await login(rootEmail);
    const created = await app.inject({ method: "POST", url: "/root/saas/plans", headers: { cookie }, payload: { code: `root-${suffix}`, name: "Root plan", monthlyPriceCents: 10 } });
    expect(created.statusCode).toBe(201);
    const id = created.json().plan.id;
    expect((await app.inject({ method: "PATCH", url: `/root/saas/plans/${id}`, headers: { cookie }, payload: { monthlyPriceCents: 20 } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/root/saas/plans/${id}/archive`, headers: { cookie } })).statusCode).toBe(200);
    await pool.query("DELETE FROM plans WHERE id=$1", [id]);
  });

  it("rolls back price/features/limits and audit when a catalog key is invalid", async () => {
    const cookie = await login(rootEmail);
    const feature = (await pool.query<{ feature_key: string }>("SELECT feature_key FROM feature_catalog LIMIT 1")).rows[0].feature_key;
    const limit = (await pool.query<{ limit_key: string }>("SELECT limit_key FROM limit_catalog LIMIT 1")).rows[0].limit_key;
    const before = await pool.query("SELECT monthly_price_cents FROM plans WHERE id=$1", [plan]);
    const response = await app.inject({ method: "PATCH", url: `/root/saas/plans/${plan}`, headers: { cookie }, payload: { monthlyPriceCents: 99999, features: { [feature]: true, "invalid-feature": true }, limits: { [limit]: 99 } } });
    expect(response.statusCode).toBe(400);
    expect((await pool.query("SELECT monthly_price_cents FROM plans WHERE id=$1", [plan])).rows[0].monthly_price_cents).toBe(before.rows[0].monthly_price_cents);
    expect((await pool.query("SELECT count(*)::int AS count FROM plan_features WHERE plan_id=$1 AND feature_key=$2", [plan, feature])).rows[0].count).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS count FROM plan_limits WHERE plan_id=$1 AND limit_key=$2", [plan, limit])).rows[0].count).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS count FROM audit_logs WHERE actor_user_id=(SELECT id FROM users WHERE email=$1) AND action='saas.plan.update' AND resource_id=$2", [rootEmail, plan])).rows[0].count).toBe(0);
  });

  it("commits plan fields/features/limits and audit together", async () => {
    const cookie = await login(rootEmail);
    const feature = (await pool.query<{ feature_key: string }>("SELECT feature_key FROM feature_catalog LIMIT 1")).rows[0].feature_key;
    const limit = (await pool.query<{ limit_key: string }>("SELECT limit_key FROM limit_catalog LIMIT 1")).rows[0].limit_key;
    const response = await app.inject({ method: "PATCH", url: `/root/saas/plans/${plan}`, headers: { cookie }, payload: { monthlyPriceCents: 2222, features: { [feature]: true }, limits: { [limit]: 99 } } });
    expect(response.statusCode).toBe(200);
    expect((await pool.query("SELECT monthly_price_cents FROM plans WHERE id=$1", [plan] )).rows[0].monthly_price_cents).toBe("2222");
    expect((await pool.query("SELECT enabled FROM plan_features WHERE plan_id=$1 AND feature_key=$2", [plan, feature])).rows[0].enabled).toBe(true);
    expect((await pool.query("SELECT limit_value FROM plan_limits WHERE plan_id=$1 AND limit_key=$2", [plan, limit] )).rows[0].limit_value).toBe("99");
    expect((await pool.query("SELECT count(*)::int AS count FROM audit_logs WHERE actor_user_id=(SELECT id FROM users WHERE email=$1) AND action='saas.plan.update' AND resource_id=$2", [rootEmail, plan])).rows[0].count).toBe(1);
  });

  it("isolates /billing/my-plan by tenant and records plan changes", async () => {
    // Isolamento: cada sessão só enxerga o próprio tenant (§41).
    const adminCookie = await login(adminEmail);
    const mine = await app.inject({ url: "/billing/my-plan", headers: { cookie: adminCookie } });
    expect(mine.statusCode).toBe(200);
    const body = mine.json();
    expect(body.tenantId).toBe(tenant);
    expect(body.plan).toBeTruthy();
    // Nenhuma credencial de gateway pode vazar nesta rota.
    expect(JSON.stringify(body)).not.toMatch(/credential|secret|access_token/i);

    // Troca de plano pelo ROOT deve deixar trilha em subscription_events (§27).
    const rootCookie = await login(rootEmail);
    const medium = (await pool.query<{ id: string }>("SELECT id FROM plans WHERE code='MEDIUM'")).rows[0].id;
    const changed = await app.inject({
      method: "POST",
      url: `/root/saas/tenants/${tenant}/subscription`,
      headers: { cookie: rootCookie },
      payload: { planId: medium }
    });
    expect(changed.statusCode).toBe(200);
    const events = await pool.query(
      "SELECT 1 FROM subscription_events WHERE tenant_id=$1 AND event_type='PLAN_CHANGED'",
      [tenant]
    );
    expect(events.rowCount).toBeGreaterThanOrEqual(1);
  });
});
