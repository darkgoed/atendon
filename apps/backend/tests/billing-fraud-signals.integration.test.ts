import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { recordDistinctPayerSignal, queryFraudSignals } from "../src/billing/fraud-signals.js";
import { grantAiUsageBonus, consumeAiInteraction } from "../src/billing/ai-consumption.js";
import { estimateInteractionCents } from "../src/billing/pricing.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const tenants: string[] = [], plans: string[] = [];
async function setup(cap: number) {
  const slug = `fraud-${randomUUID()}`;
  const t = (await pool.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [slug, slug])).rows[0].id; tenants.push(t);
  const code = `FRAUD_${randomUUID()}`;
  const p = (await pool.query<{ id: string }>("INSERT INTO plans(code,name,billing_period_months,monthly_price_cents,ai_enabled) VALUES($1,$2,1,0,true) RETURNING id", [code, code])).rows[0].id; plans.push(p);
  await pool.query("INSERT INTO plan_limits(plan_id,limit_key,limit_value) VALUES($1,'MAX_AI_INTERACTIONS',0)", [p]);
  await pool.query("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) VALUES($1,$2,'ACTIVE',now(),now()+interval '1 month')", [t,p]);
  await pool.query("INSERT INTO tenant_usage_credit_settings(tenant_id,enabled,limit_type,monthly_spending_limit_cents) VALUES($1,true,'FIXED',$2)", [t,cap]);
  return t;
}

describe("fraud and financial integration", () => {
  it("persists and queries a fraud signal and rejects duplicate bonus grants", async () => {
    const t = await setup(1000);
    const c = await pool.connect(); try { const signal = await recordDistinctPayerSignal(c, t, 6, { source: "integration" }); expect(signal.signal_type).toBe("DISTINCT_PAYER"); expect((await queryFraudSignals(c, t)).length).toBe(1); } finally { c.release(); }
    const a = await grantAiUsageBonus({ tenantId: t, amount: 3, reason: "test", idempotencyKey: "bonus-once" });
    const b = await grantAiUsageBonus({ tenantId: t, amount: 3, reason: "test", idempotencyKey: "bonus-once" });
    expect(a).not.toBeNull(); expect(b).toBeNull();
    expect((await pool.query("SELECT bonus_granted FROM usage_periods WHERE tenant_id=$1", [t])).rows[0].bonus_granted).toBe("3");
  });

  it("enforces the fixed hard cap when reservations race", async () => {
    // Deriva o cap da MESMA estimativa usada pela produção. Outras suítes
    // alteram billing_settings/pricing e os caches vivem no mesmo worker do
    // Vitest; fixar "1 centavo" fazia este teste passar isolado e admitir zero
    // chamadas na suíte completa quando a estimativa configurada era maior.
    const t = await setup(1);
    const estimate = await estimateInteractionCents(t);
    await pool.query(
      "UPDATE tenant_usage_credit_settings SET monthly_spending_limit_cents=$2 WHERE tenant_id=$1",
      [t, estimate]
    );
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => consumeAiInteraction(t, "inbound_reply", `race-${i}`)));
    expect(results.filter(r => r.allowed)).toHaveLength(1);
    const row = (await pool.query("SELECT overage_amount_brl_cents,reserved_cents FROM usage_periods WHERE tenant_id=$1", [t])).rows[0];
    expect(Number(row.overage_amount_brl_cents) + Number(row.reserved_cents)).toBeLessThanOrEqual(estimate);
  });
});

afterAll(async () => { await pool.end(); });
