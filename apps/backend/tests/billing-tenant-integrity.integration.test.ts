import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const tenants: string[] = [], plans: string[] = [];

async function fixture() {
  const suffix = randomUUID();
  const a = (await pool.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$1,'active') RETURNING id", [`integrity-a-${suffix}`])).rows[0].id;
  const b = (await pool.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$1,'active') RETURNING id", [`integrity-b-${suffix}`])).rows[0].id;
  tenants.push(a, b);
  const plan = (await pool.query<{ id: string }>("INSERT INTO plans(code,name,billing_period_months,monthly_price_cents) VALUES($1,$1,1,0) RETURNING id", [`INTEGRITY_${suffix}`])).rows[0].id;
  plans.push(plan);
  const subA = (await pool.query<{ id: string }>("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) VALUES($1,$2,'ACTIVE',now(),now()+interval '1 month') RETURNING id", [a, plan])).rows[0].id;
  const subB = (await pool.query<{ id: string }>("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) VALUES($1,$2,'ACTIVE',now(),now()+interval '1 month') RETURNING id", [b, plan])).rows[0].id;
  const periodA = (await pool.query<{ id: string }>("INSERT INTO usage_periods(tenant_id,subscription_id,sequence,start_at,end_at,included_limit) VALUES($1,$2,1,now(),now()+interval '1 month',100) RETURNING id", [a, subA])).rows[0].id;
  const periodB = (await pool.query<{ id: string }>("INSERT INTO usage_periods(tenant_id,subscription_id,sequence,start_at,end_at,included_limit) VALUES($1,$2,1,now()+interval '2 month',now()+interval '3 month',100) RETURNING id", [b, subB])).rows[0].id;
  return { a, b, subA, subB, periodA, periodB };
}

afterAll(async () => {
  if (tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenants]);
  if (plans.length) await pool.query("DELETE FROM plans WHERE id=ANY($1::uuid[])", [plans]);
  await pool.end();
});

describe("billing tenant integrity constraints", () => {
  it("rejects cross-tenant ledger, rollover, grant, and alert references", async () => {
    const f = await fixture();
    await expect(pool.query("INSERT INTO ai_usage_ledger(tenant_id,subscription_id,usage_period_id,interaction_key,purpose,consumption_type,pricing_strategy) VALUES($1,$2,$3,$4,'test','INCLUDED','CUSTOM')", [f.a, f.subB, f.periodB, randomUUID()])).rejects.toMatchObject({ code: "23503" });
    await expect(pool.query("INSERT INTO rollover_ledger(tenant_id,usage_period_id,source_period_id,rollover_rate_bps) VALUES($1,$2,$3,5000)", [f.a, f.periodA, f.periodB])).rejects.toMatchObject({ code: "23503" });
    await expect(pool.query("INSERT INTO usage_grants(tenant_id,usage_period_id,amount,reason) VALUES($1,$2,1,'test')", [f.a, f.periodB])).rejects.toMatchObject({ code: "23503" });
    await expect(pool.query("INSERT INTO usage_alerts(tenant_id,usage_period_id,alert_type,threshold_bps) VALUES($1,$2,'QUOTA',8000)", [f.a, f.periodB])).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects negative counters and invalid credit settings", async () => {
    const f = await fixture();
    await expect(pool.query("UPDATE usage_periods SET included_usage=-1 WHERE id=$1", [f.periodA])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("INSERT INTO rollover_ledger(tenant_id,usage_period_id,generated_amount,consumed_amount,rollover_rate_bps) VALUES($1,$2,1,2,5000)", [f.a, f.periodA])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("INSERT INTO tenant_usage_credit_settings(tenant_id,limit_type,monthly_spending_limit_cents) VALUES($1,'FIXED',0)", [f.a])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("INSERT INTO tenant_usage_credit_settings(tenant_id,limit_type) VALUES($1,'UNLIMITED')", [f.b])).rejects.toMatchObject({ code: "23514" });
  });

  it("allows valid same-tenant rows and credit settings", async () => {
    const f = await fixture();
    await pool.query("INSERT INTO ai_usage_ledger(tenant_id,subscription_id,usage_period_id,interaction_key,purpose,consumption_type,pricing_strategy,logical_turn_id) VALUES($1,$2,$3,$4,'test','INCLUDED','CUSTOM',$5)", [f.a, f.subA, f.periodA, randomUUID(), randomUUID()]);
    await pool.query("INSERT INTO rollover_ledger(tenant_id,usage_period_id,source_period_id,generated_amount,rollover_rate_bps) VALUES($1,$2,$2,1,5000)", [f.a, f.periodA]);
    await pool.query("INSERT INTO usage_grants(tenant_id,usage_period_id,amount,reason) VALUES($1,$2,1,'test')", [f.a, f.periodA]);
    await pool.query("INSERT INTO usage_alerts(tenant_id,usage_period_id,alert_type,threshold_bps) VALUES($1,$2,'QUOTA',8000)", [f.a, f.periodA]);
    await pool.query("INSERT INTO tenant_usage_credit_settings(tenant_id,limit_type,monthly_spending_limit_cents) VALUES($1,'FIXED',1000)", [f.a]);
    await pool.query("INSERT INTO tenant_usage_credit_settings(tenant_id,limit_type,confirmed_unlimited_at) VALUES($1,'UNLIMITED',now())", [f.b]);
  });
});
