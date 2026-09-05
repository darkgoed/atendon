import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { invalidateBillingSettingsCache } from "../src/billing/settings.js";
import { estimateInteractionCents, invalidateActivePricingRuleCache, priceInteraction } from "../src/billing/pricing.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const tenants: string[] = [];
async function tenant(label: string) {
  const s = `pricing-${label}-${randomUUID()}`;
  const r = await pool.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [s, s]);
  tenants.push(r.rows[0].id); return r.rows[0].id;
}
async function period(id: string) {
  const r = await pool.query<{ id: string }>("INSERT INTO usage_periods(tenant_id,sequence,start_at,end_at) VALUES($1,1,now(),now()+interval '1 month') RETURNING id", [id]);
  return r.rows[0].id;
}
async function resetRule() {
  // Os testes que trocam a regra ativa inserem versoes novas (>=2). Sem limpar,
  // o arquivo passa na primeira execucao e falha na segunda com duplicate key —
  // um teste que so passa em banco virgem nao serve para CI.
  await pool.query("DELETE FROM ai_pricing_rules WHERE version > 1");
  await pool.query("UPDATE ai_pricing_rules SET active=false");
  await pool.query("INSERT INTO ai_pricing_rules(version,strategy,markup_bps,active) VALUES(1,'COST_PLUS_MARKUP',20000,true) ON CONFLICT(version) DO UPDATE SET strategy=excluded.strategy,markup_bps=excluded.markup_bps,active=true");
  invalidateActivePricingRuleCache();
}
beforeEach(async () => { await resetRule(); invalidateBillingSettingsCache(); await pool.query("UPDATE billing_settings SET usd_brl_rate_micros=5500000,min_overage_estimate_cents=7"); invalidateBillingSettingsCache(); });
afterAll(async () => { if (tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenants]); await pool.end(); });

describe("billing pricing integration", () => {
  it("prices COST_PLUS_MARKUP with exact closed arithmetic", async () => {
    const p = await priceInteraction({ model: "x", inputTokens: 0, outputTokens: 0, cachedTokens: 0, providerCostUsd: 1 });
    expect(p.providerCostUsdMicros).toBe(1_000_000);
    expect(p.providerCostBrlCents).toBe(550);
    expect(p.billableAmountBrlCents).toBe(1650);
    expect(p.pricingSnapshot).toMatchObject({ version: 1, strategy: "COST_PLUS_MARKUP", markupBps: 20000, usdBrlRateMicros: 5500000 });
  });
  it("fails open for unknown model and no active rule", async () => {
    const unknown = await priceInteraction({ model: "missing", inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
    expect(unknown.providerCostUsdMicros).toBe(0); expect(unknown.pricingSnapshot.fallback).toBe("unknown_model");
    await pool.query("UPDATE ai_pricing_rules SET active=false"); invalidateActivePricingRuleCache();
    const noRule = await priceInteraction({ model: "known-cost", inputTokens: 0, outputTokens: 0, cachedTokens: 0, providerCostUsd: 1 });
    expect(noRule.pricingSnapshot.fallback).toBe("no_active_rule");
    expect(noRule.pricingSnapshot.version).toBe(0);
  });
  it("derives provider cost from model token prices", async () => {
    await pool.query("INSERT INTO ai_model_prices(model,input_price_per_million_micros,output_price_per_million_micros) VALUES('priced-test',1000000,2000000)");
    const p = await priceInteraction({ model: "priced-test", inputTokens: 1000, outputTokens: 2000, cachedTokens: 0 });
    expect(p.providerCostUsdMicros).toBe(5000); expect(p.providerCostBrlCents).toBe(3);
  });
  it("keeps historical pricing snapshots immutable across rule changes", async () => {
    const first = await priceInteraction({ model: "x", inputTokens: 0, outputTokens: 0, cachedTokens: 0, providerCostUsd: 1 });
    await pool.query("UPDATE ai_pricing_rules SET active=false WHERE version=1");
    await pool.query("INSERT INTO ai_pricing_rules(version,strategy,markup_bps,active) VALUES(2,'COST_PLUS_MARKUP',0,true)"); invalidateActivePricingRuleCache();
    const second = await priceInteraction({ model: "x", inputTokens: 0, outputTokens: 0, cachedTokens: 0, providerCostUsd: 1 });
    expect(second.billableAmountBrlCents).not.toBe(first.billableAmountBrlCents);
    expect(first.pricingSnapshot).toMatchObject({ version: 1, markupBps: 20000 });
    expect(second.pricingSnapshot).toMatchObject({ version: 2, markupBps: 0 });
  });
  it("estimates only the requested tenant and never returns zero", async () => {
    const a = await tenant("a"), b = await tenant("b"), pa = await period(a), pb = await period(b);
    for (let i = 0; i < 3; i++) await pool.query("INSERT INTO ai_usage_ledger(tenant_id,usage_period_id,interaction_key,purpose,consumption_type,billable_amount_brl_cents,pricing_strategy) VALUES($1,$2,$3,'x','OVERAGE',$4,'COST_PLUS_MARKUP')", [a, pa, randomUUID(), 1000]);
    expect(await estimateInteractionCents(a)).toBe(1000);
    expect(await estimateInteractionCents(b)).toBe(7);
    expect(await estimateInteractionCents(b)).not.toBe(0);
    void pb;
  });
});
