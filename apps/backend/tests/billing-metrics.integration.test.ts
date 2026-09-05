import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { getRootBillingMetrics } from "../src/billing/metrics.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const tenants: string[] = [], plans: string[] = [];
const periods: string[] = [];

async function fixture() {
  const ids = await Promise.all(["tenant-a", "tenant-b"].map(async (label) => {
    const slug = `metrics-${label}-${randomUUID()}`;
    const t = (await pool.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [slug, slug])).rows[0].id;
    tenants.push(t);
    const planId = (await pool.query<{ id: string }>("INSERT INTO plans(code,name,billing_period_months,monthly_price_cents,rollover_enabled,rollover_rate_bps,rollover_max_percentage_bps) VALUES($1,$1,1,0,true,5000,5000) RETURNING id", [`${slug}-plan`])).rows[0].id;
    plans.push(planId);
    await pool.query("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) VALUES($1,$2,'ACTIVE',$3,$4)", [t, planId, "2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z"]);
    return { t, p: planId };
  }));
  for (const [index, { t }] of ids.entries()) {
    for (const [month, values] of [["2026-01-01", [100, 40, 10, 3, 2]], ["2026-02-01", [200, 80, 20, 4, 1]]] as const) {
      const [includedLimit, includedUsage, bonusGranted, bonusUsage, overageUsage] = values;
      const period = (await pool.query<{ id: string }>("INSERT INTO usage_periods(tenant_id,subscription_id,sequence,start_at,end_at,included_limit,included_usage,bonus_granted,bonus_usage,overage_usage,status) VALUES($1,(SELECT id FROM tenant_subscriptions WHERE tenant_id=$1),$2,$3,$3::timestamptz+interval '1 month',$4,$5,$6,$7,$8,'CLOSED') RETURNING id", [t, index + 1, month, includedLimit, includedUsage, bonusGranted, bonusUsage, overageUsage])).rows[0].id;
      periods.push(period);
      await pool.query("INSERT INTO rollover_ledger(tenant_id,usage_period_id,source_period_id,generated_amount,consumed_amount,expired_amount,rollover_rate_bps) VALUES($1,$2,NULL,7,2,1,5000)", [t, period]);
      await pool.query("INSERT INTO rollover_ledger(tenant_id,usage_period_id,source_period_id,generated_amount,consumed_amount,expired_amount,rollover_rate_bps) VALUES($1,$2,$2,5,1,1,5000)", [t, period]);
      await pool.query("INSERT INTO ai_usage_ledger(tenant_id,usage_period_id,interaction_key,purpose,consumption_type,billable_amount_brl_cents,provider_cost_usd_micros,provider_cost_brl_cents,pricing_strategy,reconciled) VALUES($1,$2,$3,'test','OVERAGE',30,11,6,'CUSTOM',true),($1,$2,$4,'test','OVERAGE',20,13,7,'CUSTOM',true),($1,$2,$5,'test','INCLUDED',0,100,50,'CUSTOM',false)", [t, period, randomUUID(), randomUUID(), randomUUID()]);
    }
  }
  return ids;
}

afterAll(async () => { if (tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenants]); if (plans.length) await pool.query("DELETE FROM plans WHERE id=ANY($1::uuid[])", [plans]); await pool.end(); });

describe("root billing metrics", () => {
  it("aggregates two tenants/plans/months without fanout and applies every filter", async () => {
    const [{ t: tenantA, p: planA }, { t: tenantB, p: planB }] = await fixture();
    const rows = await getRootBillingMetrics({ tenantId: tenantA });
    const otherRows = await getRootBillingMetrics({ tenantId: tenantB });
    expect(rows).toHaveLength(2);
    expect(otherRows).toHaveLength(2);
    expect(rows.find((r) => r.month === "2026-01")).toMatchObject({ tenantId: tenantA, planId: planA, includedGranted: 100, includedUsed: 40, rolloverGenerated: 12, rolloverUsed: 3, rolloverExpired: 2, bonusGranted: 10, bonusUsed: 3, overageInteractions: 2, overageRevenueCents: 50, providerCostUsdMicros: 24, providerCostBrlCents: 13 });
    expect(rows.find((r) => r.month === "2026-02")).toMatchObject({ includedGranted: 200, overageRevenueCents: 50, providerCostUsdMicros: 24 });
    expect(await getRootBillingMetrics({ tenantId: tenantB, planId: planB, start: "2026-02-01", end: "2026-03-01" })).toEqual([expect.objectContaining({ tenantId: tenantB, planId: planB, month: "2026-02" })]);
    expect(await getRootBillingMetrics({ tenantId: tenantA, planId: planB })).toEqual([]);
  });

  it("uses one SQL aggregation query and no JavaScript aggregation", async () => {
    const source = await readFile(new URL("../src/billing/metrics.ts", import.meta.url), "utf8");
    expect((source.match(/db\.query/g) ?? [])).toHaveLength(1);
    expect(source).toContain("GROUP BY b.tenant_id, b.plan_id, b.month");
    expect(source).toContain("reconciled");
    expect(source).not.toMatch(/\.reduce\s*\(/);
  });

  it("is deterministic across repeated reads", async () => {
    const first = await getRootBillingMetrics();
    const second = await getRootBillingMetrics();
    expect(second).toEqual(first);
  });
});
