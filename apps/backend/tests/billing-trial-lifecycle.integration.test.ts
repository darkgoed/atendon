import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { runSubscriptionLifecycleBatch } from "../src/billing/reconciler.js";

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
async function value<T = string>(sql: string, params: unknown[] = []) { return (await pool.query<{ value: T }>(sql, params)).rows[0]?.value; }
afterAll(async () => { if (tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenants]); if (plans.length) await pool.query("DELETE FROM plans WHERE id=ANY($1::uuid[])", [plans]); await pool.end(); });

describe("trial subscription lifecycle with real Postgres", () => {
  it("keeps a current trial active", async () => { const x = await fixture(false); await runSubscriptionLifecycleBatch(); expect(await value("SELECT status AS value FROM tenant_subscriptions WHERE id=$1", [x.sub])).toBe("TRIALING"); });
  it("moves an expired unpaid trial to PAST_DUE with one event", async () => { const x = await fixture(true); await runSubscriptionLifecycleBatch(); expect(await value("SELECT status AS value FROM tenant_subscriptions WHERE id=$1", [x.sub])).toBe("PAST_DUE"); expect(await value("SELECT count(*)::int AS value FROM subscription_events WHERE subscription_id=$1", [x.sub])).toBe(1); await runSubscriptionLifecycleBatch(); expect(await value("SELECT count(*)::int AS value FROM subscription_events WHERE subscription_id=$1", [x.sub])).toBe(1); });
  it("promotes a paid conversion and never downgrades it", async () => { const x = await fixture(true, true); await runSubscriptionLifecycleBatch(); expect(await value("SELECT status AS value FROM tenant_subscriptions WHERE id=$1", [x.sub])).toBe("ACTIVE"); expect(await value("SELECT count(*)::int AS value FROM subscription_events WHERE subscription_id=$1", [x.sub])).toBe(1); });
  it("serializes concurrent runs without duplicate transition events", async () => { const x = await fixture(true); const [a, b] = await Promise.all([runSubscriptionLifecycleBatch(), runSubscriptionLifecycleBatch()]); expect(a.errors).toEqual([]); expect(b.errors).toEqual([]); expect(await value("SELECT status AS value FROM tenant_subscriptions WHERE id=$1", [x.sub])).toBe("PAST_DUE"); expect(await value("SELECT count(*)::int AS value FROM subscription_events WHERE subscription_id=$1", [x.sub])).toBe(1); });
});
