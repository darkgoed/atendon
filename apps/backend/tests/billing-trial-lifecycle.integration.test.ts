import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { runSubscriptionLifecycleBatch } from "../src/billing/reconciler.js";
import { runDunningBatch } from "../src/billing/dunning.js";
import { createInvoiceForUsagePeriod } from "../src/billing/invoices.js";
import type { BillingProvider } from "../src/billing/providers/types.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const tenants: string[] = [], plans: string[] = [];
async function fixture(expired: boolean, paid = false) {
  const slug = `trial-${randomUUID()}`;
  const tenant = (await pool.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$1,'active') RETURNING id", [slug])).rows[0].id;
  const plan = (await pool.query<{ id: string }>("INSERT INTO plans(code,name,billing_period_months,monthly_price_cents,trial_days,grace_period_days) VALUES($1,$1,1,100,14,7) RETURNING id", [slug])).rows[0].id;
  const sub = (await pool.query<{ id: string }>("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end,trial_ends_at) VALUES($1,$2,'TRIALING',now(),now()+interval '1 month',now()+($3::text || ' days')::interval) RETURNING id", [tenant, plan, expired ? "-1" : "7"])).rows[0].id;
  if (paid) {
    const invoice = (await pool.query<{ id: string }>("INSERT INTO invoices(tenant_id,subscription_id,kind,amount_cents,status) VALUES($1,$2,'subscription',100,'paid') RETURNING id", [tenant, sub])).rows[0].id;
    await pool.query("INSERT INTO payments(tenant_id,invoice_id,amount_cents,status) VALUES($1,$2,100,'paid')", [tenant, invoice]);
  }
  tenants.push(tenant); plans.push(plan); return { tenant, sub };
}
// Trial precificado (snapshot do contrato): o ciclo contratado termina depois do trial.
async function priced(finalCents: number, graceDays = 7) {
  const x = await fixture(true);
  await pool.query("UPDATE plans SET grace_period_days=$2 WHERE id=(SELECT plan_id FROM tenant_subscriptions WHERE id=$1)", [x.sub, graceDays]);
  await pool.query("UPDATE tenant_subscriptions SET billing_cycle='MONTHLY',base_price_cents=$2,final_price_cents=$2,snapshot_currency='BRL',current_period_start=now()-interval '15 days',current_period_end=now()+interval '1 month' WHERE id=$1", [x.sub, finalCents]);
  return x;
}
async function value<T = string>(sql: string, params: unknown[] = []) { return (await pool.query<{ value: T }>(sql, params)).rows[0]?.value; }
afterAll(async () => { if (tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenants]); if (plans.length) await pool.query("DELETE FROM plans WHERE id=ANY($1::uuid[])", [plans]); await pool.end(); });

describe("trial subscription lifecycle with real Postgres", () => {
  it("keeps a current trial active", async () => { const x = await fixture(false); await runSubscriptionLifecycleBatch(); expect(await value("SELECT status AS value FROM tenant_subscriptions WHERE id=$1", [x.sub])).toBe("TRIALING"); });
  it("moves an expired unpaid trial to PAST_DUE with one event", async () => { const x = await fixture(true); await runSubscriptionLifecycleBatch(); expect(await value("SELECT status AS value FROM tenant_subscriptions WHERE id=$1", [x.sub])).toBe("PAST_DUE"); expect(await value("SELECT count(*)::int AS value FROM subscription_events WHERE subscription_id=$1", [x.sub])).toBe(1); await runSubscriptionLifecycleBatch(); expect(await value("SELECT count(*)::int AS value FROM subscription_events WHERE subscription_id=$1", [x.sub])).toBe(1); });
  it("promotes a paid conversion and never downgrades it", async () => { const x = await fixture(true, true); await runSubscriptionLifecycleBatch(); expect(await value("SELECT status AS value FROM tenant_subscriptions WHERE id=$1", [x.sub])).toBe("ACTIVE"); expect(await value("SELECT count(*)::int AS value FROM subscription_events WHERE subscription_id=$1", [x.sub])).toBe(1); });
  it("serializes concurrent runs without duplicate transition events", async () => { const x = await fixture(true); const [a, b] = await Promise.all([runSubscriptionLifecycleBatch(), runSubscriptionLifecycleBatch()]); expect(a.errors).toEqual([]); expect(b.errors).toEqual([]); expect(await value("SELECT status AS value FROM tenant_subscriptions WHERE id=$1", [x.sub])).toBe("PAST_DUE"); expect(await value("SELECT count(*)::int AS value FROM subscription_events WHERE subscription_id=$1", [x.sub])).toBe(1); });
  it("C8: an expired unpaid priced trial becomes PAST_DUE WITH a payable first-cycle invoice", async () => {
    const x = await priced(1000);
    await runSubscriptionLifecycleBatch(100000);
    expect(await value("SELECT status AS value FROM tenant_subscriptions WHERE id=$1", [x.sub])).toBe("PAST_DUE");
    const invoice = (await pool.query<{ amount_cents: string; status: string; due_date: Date | null; kind: string }>("SELECT amount_cents,status,due_date,kind FROM invoices WHERE subscription_id=$1", [x.sub])).rows;
    expect(invoice).toHaveLength(1);
    expect(invoice[0]).toMatchObject({ amount_cents: "1000", status: "pending", kind: "subscription" });
    expect(invoice[0].due_date).not.toBeNull();
    await runSubscriptionLifecycleBatch(100000);
    expect(await value("SELECT count(*)::int AS value FROM invoices WHERE subscription_id=$1", [x.sub])).toBe(1);
  });
  it("C8: a trial that ends SUSPENDED can still pay the first invoice and is reactivated", async () => {
    const x = await priced(1000, 0);
    await runSubscriptionLifecycleBatch(100000);
    await runSubscriptionLifecycleBatch(100000);
    expect(await value("SELECT status AS value FROM tenant_subscriptions WHERE id=$1", [x.sub])).toBe("SUSPENDED");
    const invoiceId = await value("SELECT id AS value FROM invoices WHERE subscription_id=$1 AND status='pending'", [x.sub]);
    expect(invoiceId).toBeDefined();
    await pool.query("UPDATE invoices SET status='paid',paid_at=now() WHERE id=$1", [invoiceId]);
    // Provider falso: o lote de dunning pode tentar cobrar faturas vencidas de outras suítes.
    const provider = { createPayment: async () => ({ externalId: randomUUID(), status: "pending", payload: {} }) } as unknown as BillingProvider;
    await runDunningBatch(100000, { db: pool, provider });
    expect(await value("SELECT status AS value FROM tenant_subscriptions WHERE id=$1", [x.sub])).toBe("ACTIVE");
  });
  it("C8: the prepaid first cycle is not charged again when its usage period closes", async () => {
    const x = await priced(1000);
    await runSubscriptionLifecycleBatch(100000);
    await pool.query("UPDATE invoices SET status='paid',paid_at=now() WHERE subscription_id=$1", [x.sub]);
    const period = (await pool.query<{ id: string }>("INSERT INTO usage_periods(tenant_id,subscription_id,sequence,start_at,end_at,included_limit,status) SELECT tenant_id,id,1,now()-interval '1 month',current_period_end,0,'CLOSED' FROM tenant_subscriptions WHERE id=$1 RETURNING id", [x.sub])).rows[0].id;
    expect(await createInvoiceForUsagePeriod(pool, x.tenant, period)).toBeNull();
    expect(await value("SELECT current_period_end > now() + interval '1 month' AS value FROM tenant_subscriptions WHERE id=$1", [x.sub])).toBe(true);
  });
  it("C8: an expired trial on a FREE contract (final price 0) converts to ACTIVE instead of delinquency", async () => {
    const x = await priced(0);
    await runSubscriptionLifecycleBatch(100000);
    expect(await value("SELECT status AS value FROM tenant_subscriptions WHERE id=$1", [x.sub])).toBe("ACTIVE");
  });
});
