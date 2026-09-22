import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { seedTenantCapabilities } from "./helpers/capability-seed.js";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const suffix = randomUUID();
const password = "enforcement-test-password";
const email = `enforcement-${suffix}@test.local`;
const rootEmail = `enforcement-root-${suffix}@test.local`;
let tenant = "";
let user = "";

async function subscribe(code: string) {
  await pool.query(`INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end)
    SELECT $1,id,'ACTIVE',now(),now()+interval '1 day' FROM plans WHERE code=$2`, [tenant, code]);
}
async function login(loginEmail: string) {
  const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email: loginEmail, password } });
  expect(response.statusCode).toBe(200);
  const cookie = response.headers["set-cookie"]!;
  return (Array.isArray(cookie) ? cookie[0] : cookie).split(";")[0];
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenant = (await client.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`Enforcement ${suffix}`, `enforcement-${suffix}`])).rows[0].id;
    await seedTenantCapabilities(client, [tenant]);
    await ensureWorkspaceDefaultRoles(client, tenant);
    const passwordHash = await hash(password, 4);
    user = (await client.query<{ id: string }>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id", [email, passwordHash])).rows[0].id;
    await client.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'", [tenant, user]);
    await client.query("INSERT INTO users(email,password_hash,status,is_root) VALUES($1,$2,'active',true)", [rootEmail, passwordHash]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenant]);
  await pool.query("DELETE FROM users WHERE email=ANY($1::text[])", [[email, rootEmail]]);
  await pool.end();
  await app.close();
});

describe("HTTP entitlement enforcement", () => {
  it("blocks BASIC calendar access and exposes required plans", async () => {
    await subscribe("BASIC");
    const response = await app.inject({ method: "POST", url: "/agendamentos", headers: { cookie: await login(email) }, payload: {} });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "FEATURE_NOT_AVAILABLE", feature: "CALENDAR", details: { requiredPlans: expect.arrayContaining(["MEDIUM", "PRO"]) } });
  });

  it("does not block MEDIUM before normal validation", async () => {
    await pool.query("DELETE FROM tenant_subscriptions WHERE tenant_id=$1", [tenant]); await subscribe("MEDIUM");
    const response = await app.inject({ method: "POST", url: "/agendamentos", headers: { cookie: await login(email) }, payload: {} });
    expect(response.json().code).not.toBe("FEATURE_NOT_AVAILABLE");
  });

  it("keeps core, root, and unsubscribed tenants open", async () => {
    await pool.query("DELETE FROM tenant_subscriptions WHERE tenant_id=$1", [tenant]);
    const cookie = await login(email);
    expect((await app.inject({ method: "GET", url: "/conversations", headers: { cookie } })).statusCode).not.toBe(403);
    const rootCookie = await login(rootEmail);
    expect((await app.inject({ method: "GET", url: "/root/workspaces", headers: { cookie: rootCookie } })).json().code).not.toBe("FEATURE_NOT_AVAILABLE");
    expect((await app.inject({ method: "POST", url: "/agendamentos", headers: { cookie }, payload: {} })).json().code).not.toBe("FEATURE_NOT_AVAILABLE");
  });
});
