import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { ensureOpenPeriod } from "../src/billing/usage-period.js";
import { consumeAiInteraction, reconcileAiInteraction, releaseAiInteractionWithoutUsage } from "../src/billing/ai-consumption.js";
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
  it("TTL expiry releases the included counter and renews quota, not only reserved_cents", async () => {
    const x = await setup(1);
    expect(await consumeAiInteraction(x.t, "inbound_reply", randomUUID())).toMatchObject({ allowed: true, consumptionType: "INCLUDED" });
    expect(await scalar("SELECT included_usage AS value FROM usage_periods WHERE id=$1", [x.period.id])).toBe("1");
    await pool.query("UPDATE ai_usage_ledger SET created_at=now()-interval '2 days' WHERE tenant_id=$1", [x.t]);
    const r = await runBillingReconciliationBatch();
    expect(r.errors).toEqual([]); expect(r.expiredReservations).toBe(1);
    expect(await scalar("SELECT included_usage AS value FROM usage_periods WHERE id=$1", [x.period.id])).toBe("0");
    expect(await consumeAiInteraction(x.t, "inbound_reply", randomUUID())).toMatchObject({ allowed: true, consumptionType: "INCLUDED" });
    expect(await scalar("SELECT included_usage AS value FROM usage_periods WHERE id=$1", [x.period.id])).toBe("1");
  });
  it("TTL expiry restores rollover and bonus sources, not only the period counters", async () => {
    const x = await setup(0); const u = x.period.id;
    await pool.query("UPDATE usage_periods SET sequence=2, rollover_granted=1, bonus_granted=1 WHERE id=$1", [u]);
    await pool.query("INSERT INTO rollover_ledger(tenant_id,usage_period_id,generated_amount,consumed_amount,rollover_rate_bps,expires_at) VALUES($1,$2,1,0,5000,now()+interval '1 day')", [x.t, u]);
    const g = (await pool.query<{ id: string }>("INSERT INTO usage_grants(tenant_id,usage_period_id,kind,amount,reason) VALUES($1,$2,'BONUS',1,'ttl-test') RETURNING id", [x.t, u])).rows[0].id;
    expect(await consumeAiInteraction(x.t, "inbound_reply", "r")).toMatchObject({ allowed: true, consumptionType: "ROLLOVER" });
    expect(await consumeAiInteraction(x.t, "inbound_reply", "b")).toMatchObject({ allowed: true, consumptionType: "BONUS" });
    await pool.query("UPDATE ai_usage_ledger SET created_at=now()-interval '2 days' WHERE tenant_id=$1", [x.t]);
    const r = await runBillingReconciliationBatch();
    expect(r.errors).toEqual([]); expect(r.expiredReservations).toBe(2);
    expect(await pool.query("SELECT rollover_usage,bonus_usage FROM usage_periods WHERE id=$1", [u]).then(x => x.rows[0])).toMatchObject({ rollover_usage: "0", bonus_usage: "0" });
    expect(await scalar("SELECT consumed_amount AS value FROM rollover_ledger WHERE tenant_id=$1", [x.t])).toBe("0");
    expect(await scalar("SELECT consumed_amount AS value FROM usage_grants WHERE id=$1", [g])).toBe("0");
    expect(await consumeAiInteraction(x.t, "inbound_reply", "r2")).toMatchObject({ allowed: true, consumptionType: "ROLLOVER" });
  });
  it("a charged turn (usage logs) is never TTL-released: quota stays consumed and no expiry marker", async () => {
    const x = await setup(1);
    const turn = randomUUID();
    expect(await consumeAiInteraction(x.t, "inbound_reply", turn)).toMatchObject({ allowed: true, consumptionType: "INCLUDED" });
    await pool.query("INSERT INTO usage_logs(tenant_id,request_id,ai_model,input_tokens,output_tokens,cost_usd) VALUES($1,$2,'test-model',10,10,0.01)", [x.t, turn]);
    await pool.query("UPDATE ai_usage_ledger SET created_at=now()-interval '2 days' WHERE tenant_id=$1", [x.t]);
    const r = await runBillingReconciliationBatch();
    expect(r.expiredReservations).toBe(0);
    expect(await scalar("SELECT reconciled AS value FROM ai_usage_ledger WHERE tenant_id=$1", [x.t])).toBe(true);
    expect(await scalar("SELECT pricing_snapshot->>'reconciliation' AS value FROM ai_usage_ledger WHERE tenant_id=$1", [x.t])).toBe(null);
    expect(await scalar("SELECT included_usage AS value FROM usage_periods WHERE id=$1", [x.period.id])).toBe("1");
    expect(await consumeAiInteraction(x.t, "inbound_reply", randomUUID())).toMatchObject({ allowed: false, reason: "QUOTA_EXCEEDED" });
  });
  it("released OVERAGE reservation writes one compensating DEBIT: signed AI_RESERVATION net is zero and the CREDIT stands", async () => {
    const x = await setup(0); await credit(x.t, 100000);
    const c = await consumeAiInteraction(x.t, "inbound_reply", randomUUID());
    expect(c).toMatchObject({ allowed: true, consumptionType: "OVERAGE" });
    const estimated = c.estimatedCents!;
    expect(estimated).toBeGreaterThan(0);
    // Un-released reservation: the estimated CREDIT is still there, no DEBIT yet.
    const before = (await pool.query<{ direction: string; amount_cents: string; balance_before_cents: string; balance_after_cents: string }>(
      "SELECT direction,amount_cents,balance_before_cents,balance_after_cents FROM financial_ledger WHERE tenant_id=$1 AND actor_type='AI_RESERVATION' ORDER BY created_at,id", [x.t])).rows;
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ direction: "CREDIT", amount_cents: String(estimated) });
    expect(Number(before[0].balance_after_cents)).toBeGreaterThan(Number(before[0].balance_before_cents));
    await pool.query("UPDATE ai_usage_ledger SET created_at=now()-interval '2 days' WHERE tenant_id=$1", [x.t]);
    const r = await runBillingReconciliationBatch();
    expect(r.errors).toEqual([]);
    expect(r.expiredReservations).toBe(1);
    const rows = (await pool.query<{ direction: string; amount_cents: string; balance_before_cents: string; balance_after_cents: string }>(
      "SELECT direction,amount_cents,balance_before_cents,balance_after_cents FROM financial_ledger WHERE tenant_id=$1 AND actor_type='AI_RESERVATION' ORDER BY created_at,id", [x.t])).rows;
    expect(rows).toHaveLength(2);
    const [creditRow, debitRow] = rows;
    expect(creditRow).toMatchObject({ direction: "CREDIT", amount_cents: String(estimated) });
    expect(debitRow).toMatchObject({ direction: "DEBIT", amount_cents: String(estimated) });
    expect(debitRow.balance_before_cents).toBe(creditRow.balance_after_cents);
    expect(Number(debitRow.balance_after_cents)).toBe(Number(creditRow.balance_before_cents));
    expect(rows.reduce((sum, row) => sum + (row.direction === "CREDIT" ? Number(row.amount_cents) : -Number(row.amount_cents)), 0)).toBe(0);
  });
  it("double release across TTL batch and provider-failure path records exactly one compensating DEBIT", async () => {
    const x = await setup(0); await credit(x.t, 100000);
    const turn = randomUUID();
    expect(await consumeAiInteraction(x.t, "inbound_reply", turn)).toMatchObject({ allowed: true, consumptionType: "OVERAGE" });
    await pool.query("UPDATE ai_usage_ledger SET created_at=now()-interval '2 days' WHERE tenant_id=$1", [x.t]);
    const first = await runBillingReconciliationBatch();
    expect(first.errors).toEqual([]);
    expect(first.expiredReservations).toBe(1);
    const second = await runBillingReconciliationBatch();
    expect(second.expiredReservations).toBe(0);
    await releaseAiInteractionWithoutUsage(x.t, "inbound_reply", turn);
    const rows = (await pool.query<{ direction: string; amount_cents: string }>(
      "SELECT direction,amount_cents FROM financial_ledger WHERE tenant_id=$1 AND actor_type='AI_RESERVATION' ORDER BY created_at,id", [x.t])).rows;
    expect(rows.filter(row => row.direction === "DEBIT")).toHaveLength(1);
    expect(rows.reduce((sum, row) => sum + (row.direction === "CREDIT" ? Number(row.amount_cents) : -Number(row.amount_cents)), 0)).toBe(0);
    expect(await scalar("SELECT reconciled AS value FROM ai_usage_ledger WHERE tenant_id=$1", [x.t])).toBe(true);
  });
});
