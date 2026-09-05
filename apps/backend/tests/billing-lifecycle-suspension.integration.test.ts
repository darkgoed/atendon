import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { runSubscriptionLifecycleBatch } from "../src/billing/reconciler.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const tenants: string[] = [], plans: string[] = [];
async function fixture(status: string, grace: string | null) {
  const slug = `lifecycle-susp-${randomUUID()}`;
  const tenant = (await pool.query<{id:string}>("INSERT INTO tenants(name,slug,status) VALUES($1,$1,'active') RETURNING id", [slug])).rows[0].id; tenants.push(tenant);
  const plan = (await pool.query<{id:string}>("INSERT INTO plans(code,name,billing_period_months,monthly_price_cents) VALUES($1,$1,1,0) RETURNING id", [slug])).rows[0].id; plans.push(plan);
  const sub = (await pool.query<{id:string}>("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end,grace_period_ends_at) VALUES($1,$2,$3,now(),now()+interval '1 month',$4) RETURNING id", [tenant, plan, status, grace])).rows[0].id;
  return { tenant, sub };
}
async function scalar<T=unknown>(sql:string, args:unknown[]=[]) { return (await pool.query<{value:T}>(sql,args)).rows[0]?.value; }
afterAll(async()=>{ if (tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])",[tenants]); if (plans.length) await pool.query("DELETE FROM plans WHERE id=ANY($1::uuid[])",[plans]); await pool.end(); });

describe("subscription lifecycle suspension", () => {
  it("suspends expired PAST_DUE and records the reason", async () => { const x=await fixture("PAST_DUE","2000-01-01"); expect(await runSubscriptionLifecycleBatch()).toMatchObject({suspended:1,errors:[]}); expect(await scalar("SELECT status AS value FROM tenant_subscriptions WHERE id=$1",[x.sub])).toBe("SUSPENDED"); expect(await scalar("SELECT metadata->>'reason' AS value FROM subscription_events WHERE subscription_id=$1",[x.sub])).toBe("grace_period_expired"); });
  it("does not touch future grace, ACTIVE, or a non-expired GRACE_PERIOD", async () => { const future=await fixture("PAST_DUE","2099-01-01"), active=await fixture("ACTIVE",null), grace=await fixture("GRACE_PERIOD","2099-01-01"); await runSubscriptionLifecycleBatch(); expect(await scalar("SELECT count(*)::int AS value FROM tenant_subscriptions WHERE id=ANY($1::uuid[]) AND status='SUSPENDED'",[[future.sub,active.sub,grace.sub]])).toBe(0); });
  it("suspends expired GRACE_PERIOD and is idempotent", async () => { const x=await fixture("GRACE_PERIOD","2000-01-01"); const first=await runSubscriptionLifecycleBatch(); const second=await runSubscriptionLifecycleBatch(); expect(first.suspended).toBe(1); expect(second.suspended).toBe(0); expect(await scalar("SELECT count(*)::int AS value FROM subscription_events WHERE subscription_id=$1 AND event_type='LIFECYCLE_STATUS_CHANGED'",[x.sub])).toBe(1); });
});
