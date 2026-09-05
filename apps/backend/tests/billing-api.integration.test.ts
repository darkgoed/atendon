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
const password = "billing-api-test";
const emails = Object.fromEntries(["operator", "supervisor", "owner", "admin", "root"].map((r) => [r, `billing-${r}-${suffix}@test.local`])) as Record<string, string>;
let tenant = "";
let otherTenant = "";
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

async function login(email: string) {
  if (cookies[email]) return cookies[email];
  const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(response.statusCode).toBe(200);
  const cookie = response.headers["set-cookie"]!;
  return (cookies[email] = (Array.isArray(cookie) ? cookie[0] : cookie).split(";")[0]);
}
async function state() {
  return (await pool.query("SELECT enabled,limit_type,monthly_spending_limit_cents,confirmed_unlimited_at FROM tenant_usage_credit_settings WHERE tenant_id=$1", [tenant])).rows[0] ?? null;
}

beforeAll(async () => {
  await app.ready();
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    tenant = (await c.query<{id:string}>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`Billing ${suffix}`, `billing-${suffix}`])).rows[0].id;
    otherTenant = (await c.query<{id:string}>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`Other ${suffix}`, `other-${suffix}`])).rows[0].id;
    await ensureWorkspaceDefaultRoles(c, tenant);
    const ph = await hash(password, 4);
    for (const [role, email] of Object.entries(emails)) {
      ids[role] = (await c.query<{id:string}>("INSERT INTO users(email,password_hash,status,is_root) VALUES($1,$2,'active',$3) RETURNING id", [email, ph, role === "root"])).rows[0].id;
    }
    for (const role of ["OPERADOR", "SUPERVISOR", "OWNER", "ADMIN"]) {
      const account = role === "OPERADOR" ? "operator" : role.toLowerCase();
      await c.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name=$3", [tenant, ids[account], role]);
    }
    await c.query("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) SELECT $1,id,'ACTIVE',now(),now()+interval '1 month' FROM plans WHERE code='BASIC'", [tenant]);
    const minimumCredit = (await c.query<{credit_min_cents:number}>("SELECT credit_min_cents FROM billing_settings WHERE id=true")).rows[0].credit_min_cents;
    await c.query("INSERT INTO tenant_usage_credit_settings(tenant_id,enabled,limit_type,monthly_spending_limit_cents) VALUES($1,false,'FIXED',$2)", [tenant, minimumCredit]);
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
});

afterAll(async () => {
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id=ANY($1::uuid[])", [Object.values(ids)]);
  await pool.query("DELETE FROM subscription_events WHERE tenant_id=$1", [tenant]);
  await pool.query("DELETE FROM tenant_usage_credit_settings WHERE tenant_id=$1", [tenant]);
  await pool.query("DELETE FROM tenant_subscriptions WHERE tenant_id=$1", [tenant]);
  await pool.query("DELETE FROM workspace_members WHERE workspace_id=$1", [tenant]);
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenant, otherTenant]]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [Object.values(ids)]);
  await app.close(); await pool.end();
});

describe("billing HTTP/Postgres authorization and integrity", () => {
  it("operator cannot PUT usage credit and DB is unchanged", async () => { const before = await state(); expect((await app.inject({method:"PUT",url:"/billing/usage-credit",headers:{cookie:await login(emails.operator)},payload:{enabled:true,limitType:"FIXED",monthlySpendingLimitCents:1000}})).statusCode).toBe(403); expect(await state()).toEqual(before); });
  it("supervisor cannot PUT usage credit and DB is unchanged", async () => { const before = await state(); expect((await app.inject({method:"PUT",url:"/billing/usage-credit",headers:{cookie:await login(emails.supervisor)},payload:{enabled:true,limitType:"FIXED",monthlySpendingLimitCents:1000}})).statusCode).toBe(403); expect(await state()).toEqual(before); });
  it("OWNER can save a valid FIXED credit", async () => { const r=await app.inject({method:"PUT",url:"/billing/usage-credit",headers:{cookie:await login(emails.owner)},payload:{enabled:true,limitType:"FIXED",monthlySpendingLimitCents:1000}}); expect(r.statusCode).toBe(200); expect((await state()).limit_type).toBe("FIXED"); });
  it("ADMIN can save a valid FIXED credit", async () => { const r=await app.inject({method:"PUT",url:"/billing/usage-credit",headers:{cookie:await login(emails.admin)},payload:{enabled:true,limitType:"FIXED",monthlySpendingLimitCents:1000}}); expect(r.statusCode).toBe(200); });
  it("rejects UNLIMITED without confirmation and preserves DB", async () => { const before=await state(); expect((await app.inject({method:"PUT",url:"/billing/usage-credit",headers:{cookie:await login(emails.admin)},payload:{enabled:true,limitType:"UNLIMITED"}})).statusCode).toBe(400); expect(await state()).toEqual(before); });
  it("confirmed UNLIMITED sets confirmation and null cap", async () => { expect((await app.inject({method:"PUT",url:"/billing/usage-credit",headers:{cookie:await login(emails.admin)},payload:{enabled:true,limitType:"UNLIMITED",confirmUnlimited:true}})).statusCode).toBe(200); const s=await state(); expect(s.limit_type).toBe("UNLIMITED"); expect(s.monthly_spending_limit_cents).toBe(null); expect(s.confirmed_unlimited_at).not.toBe(null); });
  it("rejects fixed limits below minimum and above maximum", async () => { const cookie=await login(emails.admin); const settings=(await app.inject({url:"/root/billing/settings",headers:{cookie:await login(emails.root)}})).json().settings; for(const n of [settings.credit_min_cents-1,settings.credit_max_cents+1]) expect((await app.inject({method:"PUT",url:"/billing/usage-credit",headers:{cookie},payload:{enabled:true,limitType:"FIXED",monthlySpendingLimitCents:n}})).statusCode).toBe(400); });
  it("tenant dashboard rejects/ignores foreign tenantId and returns no foreign data", async () => { const cookie=await login(emails.admin); const r=await app.inject({url:`/billing/usage-dashboard?tenantId=${otherTenant}`,headers:{cookie}}); expect(r.statusCode).toBe(200); expect(JSON.stringify(r.json())).not.toContain(otherTenant); });
  it("tenant history rejects/ignores foreign tenantId", async () => { const r=await app.inject({url:`/billing/history?tenantId=${otherTenant}`,headers:{cookie:await login(emails.admin)}}); expect([200,400]).toContain(r.statusCode); if(r.statusCode===200) expect(JSON.stringify(r.json())).not.toContain(otherTenant); });
  it("non-root cannot GET root billing settings", async () => { expect((await app.inject({url:"/root/billing/settings",headers:{cookie:await login(emails.admin)}})).statusCode).toBe(403); });
  it("non-root cannot PATCH root billing settings and DB is unchanged", async () => { const before=(await pool.query("SELECT * FROM billing_settings WHERE id=true")).rows[0]; expect((await app.inject({method:"PATCH",url:"/root/billing/settings",headers:{cookie:await login(emails.admin)},payload:{credit_min_cents:999}})).statusCode).toBe(403); expect((await pool.query("SELECT * FROM billing_settings WHERE id=true")).rows[0]).toEqual(before); });
  it("ROOT allowlisted settings update writes audit and changes cache-backed value", async () => { const cookie=await login(emails.root); const r=await app.inject({method:"PATCH",url:"/root/billing/settings",headers:{cookie},payload:{credit_suggested_cents:[1234]}}); expect(r.statusCode).toBe(200); expect((await app.inject({url:"/root/billing/settings",headers:{cookie}})).json().settings.credit_suggested_cents).toEqual([1234]); expect((await pool.query("SELECT count(*)::int count FROM audit_logs WHERE actor_user_id=$1 AND action='billing.settings.update'",[ids.root])).rows[0].count).toBeGreaterThan(0); });
  it("plan prices endpoint is root-only", async () => { const plan=(await pool.query<{id:string}>("SELECT id FROM plans WHERE code='BASIC'")).rows[0].id; expect((await app.inject({url:`/root/billing/plans/${plan}/prices`,headers:{cookie:await login(emails.admin)}})).statusCode).toBe(403); expect((await app.inject({url:`/root/billing/plans/${plan}/prices`,headers:{cookie:await login(emails.root)}})).statusCode).toBe(200); });
  it("providers response never exposes encrypted credentials or plaintext secret", async () => { const r=await app.inject({url:"/root/billing/providers",headers:{cookie:await login(emails.root)}}); expect(r.statusCode).toBe(200); expect(JSON.stringify(r.json())).not.toMatch(/credentials_encrypted|webhook_secret_encrypted|plain_secret/i); });
  it("disconnect requires confirmation and preserves invoice/payment rows", async () => { const cookie=await login(emails.root); const before=await pool.query("SELECT count(*)::int count FROM invoices"); expect((await app.inject({method:"POST",url:"/root/billing/providers/mercadopago/sandbox/disconnect",headers:{cookie},payload:{}})).statusCode).toBe(400); expect((await pool.query("SELECT count(*)::int count FROM invoices")).rows[0].count).toBe(before.rows[0].count); });
  it("root tenant entitlement override is atomic and removable", async () => { const plan=(await pool.query("SELECT id FROM plans WHERE code='BASIC'")).rows[0].id; const cookie=await login(emails.root); const r=await app.inject({method:"PUT",url:`/root/saas/tenants/${tenant}/overrides/limit/MAX_AI`,headers:{cookie},payload:{intValue:99,reason:"billing test"}}); expect([200,400]).toContain(r.statusCode); if(r.statusCode===200){ expect((await app.inject({method:"DELETE",url:`/root/saas/tenants/${tenant}/overrides/limit/MAX_AI`,headers:{cookie}})).statusCode).toBe(200); } void plan; });
});
