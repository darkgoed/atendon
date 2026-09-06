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
const password = "billing-admin-test";
const rootEmail = `billing-root-${suffix}@test.local`;
const userEmail = `billing-user-${suffix}@test.local`;
let tenantA = "", tenantB = "", rootId = "", userId = "";

async function login(email: string) {
  const r = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(r.statusCode).toBe(200);
  const c = r.headers["set-cookie"]!;
  return (Array.isArray(c) ? c[0] : c).split(";")[0];
}
async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, values: unknown[] = []) { return (await pool.query<T>(sql, values)).rows; }

beforeAll(async () => {
  await app.ready();
  const ph = await hash(password, 4);
  tenantA = (await q<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`Billing A ${suffix}`, `billing-a-${suffix}`]))[0].id;
  tenantB = (await q<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`Billing B ${suffix}`, `billing-b-${suffix}`]))[0].id;
  const roleClient = await pool.connect();
  try { await ensureWorkspaceDefaultRoles(roleClient, tenantA); } finally { roleClient.release(); }
  rootId = (await q<{ id: string }>("INSERT INTO users(email,password_hash,status,is_root) VALUES($1,$2,'active',true) RETURNING id", [rootEmail, ph]))[0].id;
  userId = (await q<{ id: string }>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id", [userEmail, ph]))[0].id;
  await q("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='ADMIN'", [tenantA, userId]);
  const invoiceA = (await q<{ id: string }>("INSERT INTO invoices(tenant_id,kind,amount_cents,currency,status,due_date) VALUES($1,'SUBSCRIPTION',100,'BRL','open',now()) RETURNING id", [tenantA]))[0].id;
  const invoiceB = (await q<{ id: string }>("INSERT INTO invoices(tenant_id,kind,amount_cents,currency,status,due_date) VALUES($1,'SUBSCRIPTION',200,'BRL','open',now()) RETURNING id", [tenantB]))[0].id;
  await q("INSERT INTO billing_dunning_attempts(tenant_id,invoice_id,attempt_number,status) VALUES($1,$2,1,'FAILED'),($3,$4,1,'FAILED')", [tenantA, invoiceA, tenantB, invoiceB]);
  await q("INSERT INTO financial_ledger(tenant_id,direction,amount_cents,balance_before_cents,balance_after_cents,actor_type,reason) VALUES($1,'DEBIT',100,0,100,'SYSTEM','test'),($2,'DEBIT',200,0,200,'SYSTEM','test')", [tenantA, tenantB]);
  await q("INSERT INTO fraud_signals(tenant_id,signal_type,severity,window_started_at) VALUES($1,'PAYMENT_VELOCITY','HIGH',now()),($2,'PAYMENT_VELOCITY','LOW',now())", [tenantA, tenantB]);
});
afterAll(async () => { await q("DELETE FROM audit_logs WHERE actor_user_id IN ($1,$2)", [rootId, userId]); await q("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantA, tenantB]]); await q("DELETE FROM users WHERE id=ANY($1::uuid[])", [[rootId, userId]]); await app.close(); await pool.end(); });

describe("ROOT billing administrative operations", () => {
  it("denies non-ROOT and requires explicit tenant for ledger/fraud", async () => { const u = await login(userEmail); expect((await app.inject({ url: "/root/billing/dunning", headers: { cookie: u } })).statusCode).toBe(403); const r = await login(rootEmail); expect((await app.inject({ url: "/root/billing/ledger", headers: { cookie: r } })).statusCode).toBe(400); expect((await app.inject({ url: "/root/billing/fraud-signals", headers: { cookie: r } })).statusCode).toBe(400); });
  it("filters every tenant surface and caps pagination at 100", async () => { const c = await login(rootEmail); const a = await app.inject({ url: `/root/billing/dunning?tenantId=${tenantA}&limit=100`, headers: { cookie: c } }); expect(a.statusCode).toBe(200); expect(a.json().attempts).toHaveLength(1); expect(a.json().attempts[0].tenant_id).toBe(tenantA); const l = await app.inject({ url: `/root/billing/ledger?tenantId=${tenantA}&limit=100`, headers: { cookie: c } }); expect(l.json().entries).toHaveLength(1); expect(l.json().entries[0].tenant_id).toBe(tenantA); const f = await app.inject({ url: `/root/billing/fraud-signals?tenantId=${tenantA}&limit=100`, headers: { cookie: c } }); expect(f.json().signals).toHaveLength(1); expect(f.json().signals[0].tenant_id).toBe(tenantA); expect((await app.inject({ url: `/root/billing/ledger?tenantId=${tenantA}&limit=101`, headers: { cookie: c } })).statusCode).toBe(400); });
  it("creates, lists, toggles coupon and audits both mutations", async () => { const c = await login(rootEmail); const created = await app.inject({ method: "POST", url: "/root/billing/coupons", headers: { cookie: c }, payload: { code: `save-${suffix}`, discountType: "PERCENT", discountValue: 10 } }); expect(created.statusCode).toBe(200); const id = created.json().coupon.id; expect((await app.inject({ url: "/root/billing/coupons?limit=100", headers: { cookie: c } })).json().coupons.some((x: { id: string }) => x.id === id)).toBe(true); expect((await app.inject({ method: "PATCH", url: `/root/billing/coupons/${id}`, headers: { cookie: c }, payload: { active: false } })).json().coupon.active).toBe(false); const logs = await q<{ action: string }>("SELECT action FROM audit_logs WHERE actor_user_id=$1 AND resource_id=$2 ORDER BY created_at", [rootId, id]); expect(logs.map(x => x.action)).toEqual(["billing.coupon.create", "billing.coupon.toggle"]); });
});
