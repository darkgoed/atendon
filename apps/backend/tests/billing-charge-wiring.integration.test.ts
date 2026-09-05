import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { ensureOpenPeriod } from "../src/billing/usage-period.js";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { runBillingReconciliationBatch } from "../src/billing/reconciler.js";
import { createChargeForInvoice } from "../src/billing/charges.js";
import type { BillingProvider, PaymentInput, ProviderResult, WebhookResult } from "../src/billing/providers/types.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const password = "charge-wiring-test";
const tenants: string[] = [];

class FakeProvider implements BillingProvider {
  readonly calls: PaymentInput[] = [];
  fail = false;
  async createPayment(input: PaymentInput): Promise<ProviderResult> {
    this.calls.push(input);
    if (this.fail) throw new Error("provider secret detail");
    return { externalId: `fake-${this.calls.length}`, status: "pending", payload: { fake: true } };
  }
  createCustomer(): Promise<ProviderResult> { throw new Error("unused"); }
  createSubscription(): Promise<ProviderResult> { throw new Error("unused"); }
  cancelSubscription(): Promise<ProviderResult> { throw new Error("unused"); }
  getPayment(): Promise<ProviderResult> { throw new Error("unused"); }
  handleWebhook(): Promise<WebhookResult> { throw new Error("unused"); }
}

type Fixture = { tenant: string; provider: string; period: string; fake: FakeProvider; app: ReturnType<typeof buildApp>; rootEmail: string; userEmail: string };

async function fixture(): Promise<Fixture> {
  const id = randomUUID();
  const fake = new FakeProvider();
  const app = buildApp({ billingOAuth: { chargeDeps: { db: pool, provider: fake } } });
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenant = (await client.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`Charge ${id}`, `charge-${id}`])).rows[0].id;
    tenants.push(tenant);
    const passwordHash = await hash(password, 4);
    const rootEmail = `root-${id}@test.local`;
    const userEmail = `user-${id}@test.local`;
    await client.query("INSERT INTO users(email,password_hash,status,is_root) VALUES($1,$2,'active',true)", [rootEmail, passwordHash]);
    const user = (await client.query<{ id: string }>("INSERT INTO users(email,password_hash,status,is_root) VALUES($1,$2,'active',false) RETURNING id", [userEmail, passwordHash])).rows[0].id;
    await ensureWorkspaceDefaultRoles(client, tenant);
    await client.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='ADMIN'", [tenant, user]);
    const provider = (await client.query<{ id: string }>("INSERT INTO billing_providers(code,name,enabled,environment,status,accepted_methods,commercial_config,credentials_encrypted) VALUES($1,'Fake',true,'production','CONNECTED',$2,'{}','x') RETURNING id", [ `fake-${id}`, ["pix"] ])).rows[0].id;
    const subscription = (await client.query<{ id: string }>("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) SELECT $1,id,'ACTIVE',now(),now()+interval '1 month' FROM plans WHERE code='BASIC' RETURNING id", [tenant])).rows[0].id;
    const period = (await ensureOpenPeriod(client, tenant))!.id;
    await client.query("UPDATE usage_periods SET subscription_id=$2,status='CLOSED',closed_at=now(),end_at=now()-interval '1 day',overage_amount_brl_cents=100 WHERE id=$1", [period, subscription]);
    await client.query("INSERT INTO usage_periods(tenant_id,subscription_id,sequence,start_at,end_at,included_limit,status) VALUES($1,$2,999,now()-interval '2 days',now()-interval '1 day',0,'OPEN')", [tenant, subscription]);
    await client.query("INSERT INTO billing_accounts(tenant_id,provider_id,email,document) VALUES($1,$2,'payer@example.com','123')", [tenant, provider]);
    await client.query("COMMIT");
    return { tenant, provider, period, fake, app, rootEmail, userEmail };
  } catch (error) { await client.query("ROLLBACK"); await app.close(); throw error; } finally { client.release(); }
}

async function clean(x: Fixture) { await x.app.close(); await pool.query("DELETE FROM tenants WHERE id=$1", [x.tenant]); }
async function configProvider(x: Fixture, value: unknown) { await pool.query("UPDATE billing_providers SET commercial_config=$1 WHERE id=$2", [value, x.provider]); }
async function invoiceFor(x: Fixture) { const r = await pool.query<{ id: string }>("SELECT id FROM invoices WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1", [x.tenant]); expect(r.rows[0]).toBeDefined(); return r.rows[0].id; }
async function login(x: Fixture, email: string) { const r = await x.app.inject({ method: "POST", url: "/auth/login", payload: { email, password } }); expect(r.statusCode).toBe(200); const cookie = r.headers["set-cookie"]; return (Array.isArray(cookie) ? cookie[0] : cookie!).split(";")[0]; }

beforeAll(async () => { await pool.query("SELECT 1"); });
afterAll(async () => { await pool.end(); });

describe("billing charge wiring", () => {
  it("default-off reconciliation does not call the provider", async () => { const x = await fixture(); try { await configProvider(x, {}); await runBillingReconciliationBatch(100, { db: pool, provider: x.fake }); expect(x.fake.calls).toHaveLength(0); } finally { await clean(x); } });
  it("missing configuration does not call the provider", async () => { const x = await fixture(); try { await configProvider(x, { defaultMethod: "pix" }); await runBillingReconciliationBatch(100, { db: pool, provider: x.fake }); expect(x.fake.calls).toHaveLength(0); } finally { await clean(x); } });
  it("auto-charge calls the injected provider once and persists its charge", async () => { const x = await fixture(); try { await configProvider(x, { autoCharge: true, defaultMethod: "pix" }); await runBillingReconciliationBatch(100, { db: pool, provider: x.fake }); const invoice = await invoiceFor(x); expect(x.fake.calls).toHaveLength(1); expect(x.fake.calls[0].invoiceId).toBe(invoice); expect((await pool.query("SELECT external_id FROM payments WHERE invoice_id=$1", [invoice])).rows[0].external_id).toBe("fake-1"); } finally { await clean(x); } });
  it("a second batch does not duplicate the persisted charge", async () => { const x = await fixture(); try { await configProvider(x, { autoCharge: true, defaultMethod: "pix" }); await runBillingReconciliationBatch(100, { db: pool, provider: x.fake }); await runBillingReconciliationBatch(100, { db: pool, provider: x.fake }); expect(x.fake.calls).toHaveLength(1); } finally { await clean(x); } });
  it("an unsupported default method does not call the provider", async () => { const x = await fixture(); try { await configProvider(x, { autoCharge: true, defaultMethod: "card" }); await runBillingReconciliationBatch(100, { db: pool, provider: x.fake }); expect(x.fake.calls).toHaveLength(0); } finally { await clean(x); } });
  it("network failure is sanitized and retryable, then a fresh retry succeeds", async () => { const x = await fixture(); try { await configProvider(x, { autoCharge: true, defaultMethod: "pix" }); x.fake.fail = true; const failed = await runBillingReconciliationBatch(100, { db: pool, provider: x.fake }); const invoice = await invoiceFor(x); expect(failed.errors).toEqual([expect.stringContaining("Não foi possível criar a cobrança; tente novamente")]); expect(failed.errors.join(" ")).not.toMatch(/secret detail/); expect((await pool.query("SELECT status,paid_at FROM invoices WHERE id=$1", [invoice])).rows[0]).toMatchObject({ status: "pending", paid_at: null }); x.fake.fail = false; await createChargeForInvoice(invoice, "pix", { db: pool, provider: x.fake }); expect(x.fake.calls).toHaveLength(2); } finally { await clean(x); } });
  it("root endpoint uses its independently injected provider", async () => { const x = await fixture(); try { const invoice = (await pool.query<{ id: string }>("INSERT INTO invoices(tenant_id,provider_id,kind,amount_cents,currency,status) VALUES($1,$2,'ONE_OFF',100,'BRL','open') RETURNING id", [x.tenant, x.provider])).rows[0].id; const response = await x.app.inject({ method: "POST", url: `/root/billing/invoices/${invoice}/charge`, headers: { cookie: await login(x, x.rootEmail) }, payload: { method: "pix" } }); expect(response.statusCode).toBe(200); expect(response.json().charge).toMatchObject({ invoiceId: invoice, externalId: "fake-1", status: "pending", reference: `invoice:${invoice}` }); expect(x.fake.calls).toHaveLength(1); } finally { await clean(x); } });
  it("non-root endpoint is forbidden without a provider call", async () => { const x = await fixture(); try { const response = await x.app.inject({ method: "POST", url: `/root/billing/invoices/${randomUUID()}/charge`, headers: { cookie: await login(x, x.userEmail) }, payload: { method: "pix" } }); expect(response.statusCode).toBe(403); expect(x.fake.calls).toHaveLength(0); } finally { await clean(x); } });
});
