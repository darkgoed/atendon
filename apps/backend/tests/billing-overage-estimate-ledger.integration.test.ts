import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { ensureOpenPeriod } from "../src/billing/usage-period.js";
import { consumeAiInteraction, reconcileAiInteraction, releaseAiInteractionWithoutUsage } from "../src/billing/ai-consumption.js";

// Invariant under test: the append-only financial_ledger must end a successful
// OVERAGE reconciliation with a signed AI_RESERVATION sum equal to the ACTUAL
// billed amount (usage_periods.overage_amount_brl_cents), not the reservation
// estimate. The estimate CREDIT written at consume time is provisional; the
// reconcile must true it up with a compensating CREDIT (under-estimate) or
// DEBIT (over-estimate) inside the same transaction.
//
// Assertions read the billed amount back from the database instead of
// re-deriving pricing math, so the suite stays correct even if the disposable
// database's pricing rule/rate defaults change.

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const tenants: string[] = [], plans: string[] = [];

async function setup() {
  const slug = `overage-ledger-${randomUUID()}`;
  const t = (await pool.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$1,'active') RETURNING id", [slug])).rows[0].id; tenants.push(t);
  const p = (await pool.query<{ id: string }>("INSERT INTO plans(code,name,billing_period_months,monthly_price_cents,rollover_enabled,rollover_rate_bps,rollover_max_percentage_bps,rollover_expiration_periods) VALUES($1,$1,1,0,true,5000,5000,1) RETURNING id", [slug])).rows[0].id; plans.push(p);
  await pool.query("INSERT INTO plan_limits(plan_id,limit_key,limit_value) VALUES($1,'MAX_AI_INTERACTIONS',0)", [p]);
  await pool.query("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) VALUES($1,$2,'ACTIVE',now(),now()+interval '1 month')", [t, p]);
  await pool.query("INSERT INTO tenant_usage_credit_settings(tenant_id,enabled,limit_type,monthly_spending_limit_cents) VALUES($1,true,'FIXED',100000)", [t]);
  const c = await pool.connect();
  try { await c.query("BEGIN"); const period = await ensureOpenPeriod(c, t); await c.query("COMMIT"); return { t, periodId: period!.id }; }
  finally { c.release(); }
}

// estimateInteractionCents averages the tenant's last 20 billed rows (needs >= 3):
// per-tenant history pins the estimate without touching global billing_settings.
async function seedEstimateHistory(t: string, periodId: string, cents: number) {
  for (let i = 0; i < 3; i++) {
    await pool.query(
      `INSERT INTO ai_usage_ledger(tenant_id,usage_period_id,interaction_key,purpose,consumption_type,billable_amount_brl_cents,pricing_strategy,reconciled,reconciled_at)
       VALUES($1,$2,$3,'inbound_reply','INCLUDED',$4,'COST_PLUS_MARKUP',true,now())`,
      [t, periodId, `seed-${randomUUID()}`, cents],
    );
  }
}

type LedgerRow = {
  direction: string; amount_cents: string; source_event_id: string | null; correlation_id: string | null;
  balance_before_cents: string; balance_after_cents: string; metadata: Record<string, unknown>;
};

async function ledgerRows(t: string) {
  return (await pool.query<LedgerRow>(
    "SELECT direction,amount_cents,source_event_id,correlation_id,balance_before_cents,balance_after_cents,metadata FROM financial_ledger WHERE tenant_id=$1 ORDER BY created_at,id", [t])).rows;
}

const signedSum = (rows: LedgerRow[]) => rows.reduce((sum, row) => sum + (row.direction === "CREDIT" ? Number(row.amount_cents) : -Number(row.amount_cents)), 0);

function assertBalanceChain(rows: LedgerRow[]) {
  for (const row of rows) {
    const delta = row.direction === "CREDIT" ? Number(row.amount_cents) : -Number(row.amount_cents);
    expect(Number(row.balance_after_cents)).toBe(Number(row.balance_before_cents) + delta);
  }
  for (let i = 1; i < rows.length; i++) expect(Number(rows[i].balance_before_cents)).toBe(Number(rows[i - 1].balance_after_cents));
}

async function scalar<T = string>(sql: string, p: unknown[] = []) { return (await pool.query<{ value: T }>(sql, p)).rows[0]?.value; }

async function billedCents(ledgerId: string, periodId: string) {
  const billed = Number(await scalar("SELECT billable_amount_brl_cents AS value FROM ai_usage_ledger WHERE id=$1", [ledgerId]));
  expect(Number(await scalar("SELECT overage_amount_brl_cents AS value FROM usage_periods WHERE id=$1", [periodId]))).toBe(billed);
  return billed;
}

const actualCost = (usd: number) => ({ model: null, inputTokens: 0, outputTokens: 0, cachedTokens: 0, providerCostUsd: usd });

afterAll(async () => {
  if (tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenants]);
  if (plans.length) await pool.query("DELETE FROM plans WHERE id=ANY($1::uuid[])", [plans]);
  await pool.end();
});

describe("OVERAGE estimate vs actual ledger reconciliation", () => {
  it("trues an UNDER-estimated reservation up to the actual charge (adjusting CREDIT)", async () => {
    const x = await setup();
    await seedEstimateHistory(x.t, x.periodId, 7);
    const turn = randomUUID();
    const c = await consumeAiInteraction(x.t, "inbound_reply", turn);
    expect(c).toMatchObject({ allowed: true, consumptionType: "OVERAGE" });
    expect(c.estimatedCents).toBe(7);
    expect(signedSum(await ledgerRows(x.t))).toBe(7);

    await reconcileAiInteraction(x.t, "inbound_reply", turn, actualCost(0.03));
    const billed = await billedCents(c.ledgerId!, x.periodId);
    expect(billed).toBeGreaterThan(7); // precondition: the estimate really diverged

    const rows = await ledgerRows(x.t);
    expect(rows).toHaveLength(2);
    const [credit, adjustment] = rows;
    expect(credit).toMatchObject({ direction: "CREDIT", amount_cents: "7", correlation_id: x.periodId });
    expect(adjustment.direction).toBe("CREDIT");
    expect(Number(adjustment.amount_cents)).toBe(billed - 7);
    expect(adjustment.source_event_id).toBe(`ai-reservation-reconcile:${c.ledgerId}`);
    expect(adjustment.correlation_id).toBe(x.periodId);
    expect(adjustment.metadata.reservationId).toBe(c.ledgerId);
    expect(signedSum(rows)).toBe(billed);
    assertBalanceChain(rows);
  });

  it("trues an OVER-estimated reservation down to the actual charge (adjusting DEBIT)", async () => {
    const x = await setup();
    await seedEstimateHistory(x.t, x.periodId, 100);
    const turn = randomUUID();
    const c = await consumeAiInteraction(x.t, "inbound_reply", turn);
    expect(c).toMatchObject({ allowed: true, consumptionType: "OVERAGE" });
    expect(c.estimatedCents).toBe(100);

    await reconcileAiInteraction(x.t, "inbound_reply", turn, actualCost(0.001));
    const billed = await billedCents(c.ledgerId!, x.periodId);
    expect(billed).toBeLessThan(100); // precondition: the estimate really diverged

    const rows = await ledgerRows(x.t);
    expect(rows).toHaveLength(2);
    const [credit, adjustment] = rows;
    expect(credit).toMatchObject({ direction: "CREDIT", amount_cents: "100", correlation_id: x.periodId });
    expect(adjustment.direction).toBe("DEBIT");
    expect(Number(adjustment.amount_cents)).toBe(100 - billed);
    expect(adjustment.source_event_id).toBe(`ai-reservation-reconcile:${c.ledgerId}`);
    expect(adjustment.correlation_id).toBe(x.periodId);
    expect(signedSum(rows)).toBe(billed);
    assertBalanceChain(rows);
  });

  it("positive control: a released reservation nets the ledger to zero", async () => {
    const x = await setup();
    const turn = randomUUID();
    const c = await consumeAiInteraction(x.t, "inbound_reply", turn);
    expect(c).toMatchObject({ allowed: true, consumptionType: "OVERAGE" });
    expect(c.estimatedCents!).toBeGreaterThan(0);
    await releaseAiInteractionWithoutUsage(x.t, "inbound_reply", turn);
    const rows = await ledgerRows(x.t);
    expect(rows).toHaveLength(2);
    expect(rows[0].direction).toBe("CREDIT");
    expect(rows[1]).toMatchObject({ direction: "DEBIT", amount_cents: rows[0].amount_cents });
    expect(signedSum(rows)).toBe(0);
    assertBalanceChain(rows);
  });

  it("repeated reconcile is idempotent: exactly one true-up entry, amounts not doubled", async () => {
    const x = await setup();
    await seedEstimateHistory(x.t, x.periodId, 7);
    const turn = randomUUID();
    const c = await consumeAiInteraction(x.t, "inbound_reply", turn);
    expect(c.consumptionType).toBe("OVERAGE");
    await reconcileAiInteraction(x.t, "inbound_reply", turn, actualCost(0.03));
    const billed = await billedCents(c.ledgerId!, x.periodId);
    expect(billed).not.toBe(7);

    await reconcileAiInteraction(x.t, "inbound_reply", turn, actualCost(0.03));
    expect(Number(await scalar("SELECT overage_amount_brl_cents AS value FROM usage_periods WHERE id=$1", [x.periodId]))).toBe(billed);
    const rows = await ledgerRows(x.t);
    expect(rows).toHaveLength(2);
    expect(rows.filter(row => row.source_event_id === `ai-reservation-reconcile:${c.ledgerId}`)).toHaveLength(1);
    expect(signedSum(rows)).toBe(billed);
    assertBalanceChain(rows);
  });

  it("keeps adjustments isolated per tenant: each ledger reflects only its own actual", async () => {
    const a = await setup();
    const b = await setup();
    await seedEstimateHistory(a.t, a.periodId, 7);
    await seedEstimateHistory(b.t, b.periodId, 100);
    const turnA = randomUUID(), turnB = randomUUID();
    const ca = await consumeAiInteraction(a.t, "inbound_reply", turnA);
    const cb = await consumeAiInteraction(b.t, "inbound_reply", turnB);
    expect(ca.consumptionType).toBe("OVERAGE");
    expect(cb.consumptionType).toBe("OVERAGE");

    await reconcileAiInteraction(a.t, "inbound_reply", turnA, actualCost(0.03));
    await reconcileAiInteraction(b.t, "inbound_reply", turnB, actualCost(0.001));
    const billedA = await billedCents(ca.ledgerId!, a.periodId);
    const billedB = await billedCents(cb.ledgerId!, b.periodId);
    expect(billedA).toBeGreaterThan(7);
    expect(billedB).toBeLessThan(100);

    const rowsA = await ledgerRows(a.t);
    const rowsB = await ledgerRows(b.t);
    expect(rowsA).toHaveLength(2);
    expect(rowsB).toHaveLength(2);
    expect(signedSum(rowsA)).toBe(billedA);
    expect(signedSum(rowsB)).toBe(billedB);
    // No cross-tenant leakage: each tenant's entries reference only its own reservation.
    expect(rowsA.filter(row => row.source_event_id?.startsWith("ai-reservation-reconcile:")).map(row => row.source_event_id))
      .toEqual([`ai-reservation-reconcile:${ca.ledgerId}`]);
    expect(rowsB.filter(row => row.source_event_id?.startsWith("ai-reservation-reconcile:")).map(row => row.source_event_id))
      .toEqual([`ai-reservation-reconcile:${cb.ledgerId}`]);
    assertBalanceChain(rowsA);
    assertBalanceChain(rowsB);
  });
});
