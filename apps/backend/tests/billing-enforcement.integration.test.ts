import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { seedTenantCapabilities } from "./helpers/capability-seed.js";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createHash } from "node:crypto";

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

  it("gates /meet/* by the MEET feature (the /me prefix used to exempt it) but keeps the public join link (seg. C3)", async () => {
    await pool.query("DELETE FROM tenant_subscriptions WHERE tenant_id=$1", [tenant]); await subscribe("MEDIUM");
    const cookie = await login(email);
    const meetConfig = config as { MEET_ENABLED: boolean };
    const meetEnabled = meetConfig.MEET_ENABLED;
    meetConfig.MEET_ENABLED = true;
    try {
      const rooms = await app.inject({ method: "POST", url: "/meet/rooms", headers: { cookie }, payload: {} });
      expect(rooms.statusCode).toBe(403);
      expect(rooms.json()).toMatchObject({ code: "FEATURE_NOT_AVAILABLE", feature: "MEET" });
      // Link público de convidado: sem sessão continua sem exigir login (404 do código inexistente).
      expect((await app.inject({ method: "GET", url: "/meet/join/codigo-inexistente-123" })).statusCode).not.toBe(401);
    } finally {
      meetConfig.MEET_ENABLED = meetEnabled;
    }
    // /me e subrotas seguem isentas.
    expect((await app.inject({ method: "GET", url: "/me", headers: { cookie } })).json().code).not.toBe("FEATURE_NOT_AVAILABLE");
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

// C10: MAX_USERS (is_enforced no catálogo) precisa ser barrado no servidor na
// criação e no aceite de convite, não só no painel.
describe("MAX_USERS enforcement", () => {
  const ownerEmail = `max-users-owner-${suffix}@test.local`;
  let limited = "", plan = "", adminRole = "";
  beforeAll(async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      limited = (await client.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$1,'active') RETURNING id", [`max-users-${suffix}`])).rows[0].id;
      await seedTenantCapabilities(client, [limited]);
      await ensureWorkspaceDefaultRoles(client, limited);
      plan = (await client.query<{ id: string }>("INSERT INTO plans(code,name,billing_period_months,monthly_price_cents) VALUES($1,$1,1,100) RETURNING id", [`MAXU-${suffix}`])).rows[0].id;
      await client.query("INSERT INTO plan_limits(plan_id,limit_key,limit_value) VALUES($1,'MAX_USERS',1)", [plan]);
      await client.query("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) VALUES($1,$2,'ACTIVE',now(),now()+interval '1 month')", [limited, plan]);
      const owner = (await client.query<{ id: string }>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id", [ownerEmail, await hash(password, 4)])).rows[0].id;
      await client.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'", [limited, owner]);
      adminRole = (await client.query<{ id: string }>("SELECT id FROM workspace_roles WHERE workspace_id=$1 AND name='ADMIN'", [limited])).rows[0].id;
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  });
  afterAll(async () => {
    await pool.query("DELETE FROM tenants WHERE id=$1", [limited]);
    await pool.query("DELETE FROM plans WHERE id=$1", [plan]);
    await pool.query("DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE email LIKE $1)", [`max-users-%${suffix}@test.local`]);
    await pool.query("DELETE FROM users WHERE email LIKE $1", [`max-users-%${suffix}@test.local`]);
  });

  it("rejects creating an invitation beyond MAX_USERS with PLAN_LIMIT_REACHED", async () => {
    const response = await app.inject({ method: "POST", url: "/workspaces/current/invitations", headers: { cookie: await login(ownerEmail) }, payload: { email: `max-users-guest-${suffix}@test.local`, roleId: adminRole } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "PLAN_LIMIT_REACHED" });
  });

  it("rejects accepting an invitation beyond MAX_USERS and creates no membership", async () => {
    const token = `max-users-token-${suffix}-${"x".repeat(16)}`;
    await pool.query("INSERT INTO workspace_invitations(workspace_id,email,role_id,token_hash,status,expires_at,invited_by_user_id) SELECT $1,$2,$3,$4,'pending',now()+interval '7 days',id FROM users WHERE email=$5",
      [limited, `max-users-late-${suffix}@test.local`, adminRole, createHash("sha256").update(token).digest("hex"), ownerEmail]);
    const response = await app.inject({ method: "POST", url: "/auth/accept-invitation", remoteAddress: "10.77.1.1", payload: { token, newPassword: "max-users-pass", passwordConfirmation: "max-users-pass" } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "PLAN_LIMIT_REACHED" });
    expect((await pool.query("SELECT count(*)::int n FROM workspace_members WHERE workspace_id=$1", [limited])).rows[0].n).toBe(1);
  });
});
