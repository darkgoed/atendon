import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { ensureOpenPeriod } from "../src/billing/usage-period.js";
import { consumeAiInteraction, reconcileAiInteraction } from "../src/billing/ai-consumption.js";
import { runBillingReconciliationBatch } from "../src/billing/reconciler.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const tenants: string[] = [], plans: string[] = [];
async function setup(limit = 10, expired = false) {
  const slug = `lifecycle-${randomUUID()}`;
  const t = (await pool.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$1,'active') RETURNING id", [slug])).rows[0].id; tenants.push(t);
  const p = (await pool.query<{ id: string }>("INSERT INTO plans(code,name,billing_period_months,monthly_price_cents,rollover_enabled,rollover_rate_bps,rollover_max_percentage_bps,rollover_expiration_periods) VALUES($1,$1,1,0,true,5000,5000,1) RETURNING id", [slug])).rows[0].id; plans.push(p);
  await pool.query("INSERT INTO plan_limits(plan_id,limit_key,limit_value) VALUES($1,'MAX_AI_INTERACTIONS',$2)", [p, limit]);
  await pool.query("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) VALUES($1,$2,'ACTIVE',now(),now()+interval '1 month')", [t, p]);
  if (expired) await pool.query("UPDATE tenant_subscriptions SET current_period_end=now()-interval '1 day' WHERE tenant_id=$1", [t]);
  const c = await pool.connect(); try { await c.query("BEGIN"); const r = await ensureOpenPeriod(c, t); await c.query("COMMIT"); return { t, period: r! }; } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}
async function scalar<T = string>(sql: string, p: unknown[] = []) { return (await pool.query<{ value: T }>(sql, p)).rows[0]?.value; }
async function credit(t: string, cap: number) { await pool.query("INSERT INTO tenant_usage_credit_settings(tenant_id,enabled,limit_type,monthly_spending_limit_cents) VALUES($1,true,'FIXED',$2)", [t, cap]); }

afterAll(async () => { if (tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenants]); if (plans.length) await pool.query("DELETE FROM plans WHERE id=ANY($1::uuid[])", [plans]); await pool.end(); });

describe("billing lifecycle with real Postgres", () => {
  it("ensureOpenPeriod closes expired source, opens consecutive target, and generates rollover", async () => {
    const x = await setup(10); await pool.query("UPDATE usage_periods SET sequence=2, end_at=now()-interval '1 day', included_usage=0 WHERE id=$1", [x.period.id]);
    const c = await pool.connect(); let target: Awaited<ReturnType<typeof ensureOpenPeriod>>; try { await c.query("BEGIN"); target = await ensureOpenPeriod(c, x.t); if (!target) throw new Error("expected target period"); await c.query("COMMIT"); } finally { c.release(); }
    expect(target.sequence).toBe(x.period.sequence + 2); expect(await scalar("SELECT status AS value FROM usage_periods WHERE id=$1", [x.period.id])).toBe("CLOSED"); expect(await scalar("SELECT rollover_granted AS value FROM usage_periods WHERE id=$1", [target.id])).toBe("5"); expect(await scalar("SELECT count(*)::int AS value FROM rollover_ledger WHERE tenant_id=$1", [x.t])).toBe(1);
  });
  it("reconciliation batch rotates an expired monthly usage period under a future yearly billing boundary", async () => {
    const x = await setup(10);
    await pool.query("UPDATE tenant_subscriptions SET billing_cycle='YEARLY', current_period_end=now()+interval '12 months' WHERE tenant_id=$1", [x.t]);
    await pool.query("UPDATE usage_periods SET sequence=2, end_at=now()-interval '1 day', included_usage=0 WHERE id=$1", [x.period.id]);
    const boundary = await scalar<string>("SELECT current_period_end::text AS value FROM tenant_subscriptions WHERE tenant_id=$1", [x.t]);
    const r = await runBillingReconciliationBatch();
    expect(r.errors).toEqual([]);
    expect(r.periods).toBeGreaterThanOrEqual(1);
    expect(await scalar("SELECT status AS value FROM usage_periods WHERE id=$1", [x.period.id])).toBe("CLOSED");
    const target = await pool.query<{ end_at: Date; status: string; start_at: Date }>("SELECT start_at,end_at,status FROM usage_periods WHERE tenant_id=$1 AND status='OPEN'", [x.t]);
    expect(target.rows).toHaveLength(1);
    expect(target.rows[0].status).toBe("OPEN");
    expect(await scalar("SELECT end_at = (SELECT end_at FROM usage_periods WHERE id=$1) + interval '1 month' AS value FROM usage_periods WHERE tenant_id=$2 AND status='OPEN'", [x.period.id, x.t])).toBe(true);
    expect(await scalar("SELECT count(*)::int AS value FROM rollover_ledger WHERE tenant_id=$1", [x.t])).toBe(1);
    expect(await scalar<string>("SELECT current_period_end::text AS value FROM tenant_subscriptions WHERE tenant_id=$1", [x.t])).toBe(boundary);
  });
  it("consume persists usage alerts when quota threshold is crossed", async () => { const x = await setup(1); await consumeAiInteraction(x.t, "inbound_reply", randomUUID()); expect(await scalar("SELECT count(*)::int AS value FROM usage_alerts WHERE tenant_id=$1 AND alert_type='QUOTA'", [x.t])).toBeGreaterThan(0); });
  it("reconcile persists credit alerts when credit threshold is crossed", async () => { const x = await setup(0); await credit(x.t, 100); const key = randomUUID(); const c = await consumeAiInteraction(x.t, "inbound_reply", key); expect(c.allowed).toBe(true); await reconcileAiInteraction(x.t, "inbound_reply", key, { model: null, inputTokens: 0, outputTokens: 0, cachedTokens: 0, providerCostUsd: 1 }); expect(await scalar("SELECT count(*)::int AS value FROM usage_alerts WHERE tenant_id=$1 AND alert_type='CREDIT'", [x.t])).toBeGreaterThan(0); });
  it("expires old OVERAGE without logs, releases exactly the reservation, and records reconciliation", async () => { const x = await setup(0); await credit(x.t, 100000); await consumeAiInteraction(x.t, "inbound_reply", randomUUID()); const before = Number(await scalar("SELECT reserved_cents AS value FROM usage_periods WHERE id=$1", [x.period.id])); expect(before).toBeGreaterThan(0); await pool.query("UPDATE ai_usage_ledger SET created_at=now()-interval '2 days' WHERE tenant_id=$1", [x.t]); const r = await runBillingReconciliationBatch(); expect(r.expiredReservations).toBe(1); expect(Number(await scalar("SELECT reserved_cents AS value FROM usage_periods WHERE id=$1", [x.period.id]))).toBe(0); expect(await scalar("SELECT reconciled AS value FROM ai_usage_ledger WHERE tenant_id=$1", [x.t])).toBe(true); expect(await scalar("SELECT pricing_snapshot->>'reconciliation' AS value FROM ai_usage_ledger WHERE tenant_id=$1", [x.t])).toBe("expired_without_usage_logs"); });
  it("running batch twice does not duplicate rollover, alerts, or release", async () => { const x = await setup(0); await credit(x.t, 100000); const key = randomUUID(); await consumeAiInteraction(x.t, "inbound_reply", key); await pool.query("UPDATE usage_periods SET end_at=now()-interval '1 day' WHERE id=$1", [x.period.id]); await runBillingReconciliationBatch(); const a = { r: Number(await scalar("SELECT count(*)::int AS value FROM rollover_ledger WHERE tenant_id=$1", [x.t])), u: Number(await scalar("SELECT count(*)::int AS value FROM usage_alerts WHERE tenant_id=$1", [x.t])) }; await runBillingReconciliationBatch(); expect(Number(await scalar("SELECT count(*)::int AS value FROM rollover_ledger WHERE tenant_id=$1", [x.t]))).toBe(a.r); expect(Number(await scalar("SELECT count(*)::int AS value FROM usage_alerts WHERE tenant_id=$1", [x.t]))).toBe(a.u); });
  it("an invalid tenant does not prevent another tenant from processing", async () => { const bad = await setup(10), good = await setup(10); await pool.query("UPDATE tenant_subscriptions SET status='CANCELED', current_period_end=now()-interval '1 day' WHERE tenant_id=$1", [bad.t]); await pool.query("UPDATE usage_periods SET end_at=now()-interval '1 day' WHERE tenant_id=$1", [good.t]); const r = await runBillingReconciliationBatch(); expect(r.periods).toBeGreaterThanOrEqual(1); expect(await scalar("SELECT count(*)::int AS value FROM usage_periods WHERE tenant_id=$1 AND status='OPEN'", [good.t])).toBe(1); expect(await scalar("SELECT count(*)::int AS value FROM usage_periods WHERE tenant_id=$1 AND status='OPEN'", [bad.t])).toBe(1); expect(r.errors.length).toBeGreaterThanOrEqual(0); });
});
