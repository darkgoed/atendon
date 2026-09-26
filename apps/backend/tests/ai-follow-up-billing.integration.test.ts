import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { AiFollowUpRepository } from "../src/modules/messages/ai-follow-up.js";
import { consumeAiInteraction, reconcileAiInteraction, reconcileAiTurnFromUsageLogs } from "../src/billing/ai-consumption.js";
import { runBillingReconciliationBatch } from "../src/billing/reconciler.js";
import { deriveBillingTurnId } from "../src/billing/turn-id.js";
import { ensureOpenPeriod } from "../src/billing/usage-period.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const tenants: string[] = [], plans: string[] = [];
const followUps = new AiFollowUpRepository(pool);

async function setup(limit: number) {
  const slug = `followup-billing-${randomUUID()}`;
  const t = (await pool.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$1,'active') RETURNING id", [slug])).rows[0].id; tenants.push(t);
  const p = (await pool.query<{ id: string }>("INSERT INTO plans(code,name,billing_period_months,monthly_price_cents,ai_enabled) VALUES($1,$1,1,0,true) RETURNING id", [slug])).rows[0].id; plans.push(p);
  await pool.query("INSERT INTO plan_limits(plan_id,limit_key,limit_value) VALUES($1,'MAX_AI_INTERACTIONS',$2)", [p, limit]);
  await pool.query("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) VALUES($1,$2,'ACTIVE',now(),now()+interval '1 month')", [t, p]);
  await pool.query("INSERT INTO whatsapp_sessions(tenant_id,label,is_primary) VALUES($1,'Principal',true)", [t]);
  const c = await pool.connect();
  try { await c.query("BEGIN"); const period = await ensureOpenPeriod(c, t); await c.query("COMMIT"); return { t, period: period! }; }
  catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}

async function conversation(t: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO conversations(tenant_id,session_id,contact_phone,status)
     SELECT $1,id,'5511999999999','open'
     FROM whatsapp_sessions WHERE tenant_id=$1 AND is_primary AND archived_at IS NULL
     RETURNING id`, [t])).rows[0].id;
}

async function scalar<T = string>(sql: string, p: unknown[] = []) { return (await pool.query<{ value: T }>(sql, p)).rows[0]?.value; }

afterAll(async () => {
  if (tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenants]);
  if (plans.length) await pool.query("DELETE FROM plans WHERE id=ANY($1::uuid[])", [plans]);
  await pool.end();
});

describe("AI follow-up billing: usage_logs.request_id", () => {
  it("records follow-up usage with request_id=billingTurnId so the TTL batch reconciles instead of refunding a charged turn", async () => {
    const x = await setup(1);
    const conversationId = await conversation(x.t);
    // Exact key derivation from AiFollowUpProcessor: `${conversationId}:${sequenceVersion}`.
    const billingTurnId = deriveBillingTurnId(x.t, "follow_up", `${conversationId}:2`);
    const reservation = await consumeAiInteraction(x.t, "follow_up", billingTurnId, { conversationId });
    expect(reservation).toMatchObject({ allowed: true, consumptionType: "INCLUDED" });

    // The onUsage wiring in AiFollowUpProcessor: usage is recorded with the
    // billing turn id so reconciliation can find the charged provider usage.
    const providerRequestId = `test-${randomUUID()}`;
    await followUps.recordAiUsage({
      tenantId: x.t, conversationId, requestId: billingTurnId, providerRequestId,
      model: "test/model", inputTokens: 100, outputTokens: 50, costUsd: 0.01
    });

    expect(await scalar("SELECT request_id::text AS value FROM usage_logs WHERE tenant_id=$1", [x.t])).toBe(billingTurnId);
    expect(await scalar("SELECT provider_request_id AS value FROM usage_logs WHERE tenant_id=$1", [x.t])).toBe(providerRequestId);

    // A no-send/cancelled follow-up (or any missed immediate reconcile) relies
    // solely on the TTL batch: charged usage must reconcile the reservation,
    // never release/refund it while provider cost is real.
    await pool.query("UPDATE ai_usage_ledger SET created_at=now()-interval '2 days' WHERE tenant_id=$1", [x.t]);
    await runBillingReconciliationBatch();
    expect(await scalar("SELECT reconciled AS value FROM ai_usage_ledger WHERE tenant_id=$1", [x.t])).toBe(true);
    expect(await scalar("SELECT pricing_snapshot->>'reconciliation' AS value FROM ai_usage_ledger WHERE tenant_id=$1", [x.t])).toBe(null);
    expect(await scalar("SELECT included_usage AS value FROM usage_periods WHERE id=$1", [x.period.id])).toBe("1");
    expect(await consumeAiInteraction(x.t, "follow_up", randomUUID(), { conversationId })).toMatchObject({ allowed: false, reason: "QUOTA_EXCEEDED" });
  });

  it("reconcileAiTurnFromUsageLogs prices the charged follow-up turn from usage_logs", async () => {
    const x = await setup(1);
    const conversationId = await conversation(x.t);
    const billingTurnId = deriveBillingTurnId(x.t, "follow_up", `${conversationId}:2`);
    await consumeAiInteraction(x.t, "follow_up", billingTurnId, { conversationId });
    await followUps.recordAiUsage({
      tenantId: x.t, conversationId, requestId: billingTurnId, providerRequestId: `test-${randomUUID()}`,
      model: "test/model", inputTokens: 100, outputTokens: 50, costUsd: 0.01
    });
    await reconcileAiTurnFromUsageLogs(x.t, "follow_up", billingTurnId);
    const ledger = await pool.query<{ reconciled: boolean; input_tokens: string; output_tokens: string; provider_cost_usd_micros: string }>(
      "SELECT reconciled,input_tokens,output_tokens,provider_cost_usd_micros FROM ai_usage_ledger WHERE tenant_id=$1", [x.t]);
    expect(ledger.rows[0]).toMatchObject({ reconciled: true, input_tokens: "100", output_tokens: "50", provider_cost_usd_micros: "10000" });
  });

  it("persists cached input tokens on follow-up usage so fallback model pricing discounts them", async () => {
    const x = await setup(3);
    const conversationId = await conversation(x.t);
    const billingTurnId = deriveBillingTurnId(x.t, "follow_up", `${conversationId}:2`);
    expect(await consumeAiInteraction(x.t, "follow_up", billingTurnId, { conversationId })).toMatchObject({ allowed: true });

    // Fallback model pricing (provider cost absent) needs the cached split:
    // cached tokens price below the fresh-input rate, like real provider caches.
    await pool.query(
      `INSERT INTO ai_model_prices(model, input_price_per_million_micros, output_price_per_million_micros, cached_input_price_per_million_micros, effective_from)
       VALUES('test/cached-model', 1500000, 6000000, 150000, now() - interval '1 hour')`
    );

    await followUps.recordAiUsage({
      tenantId: x.t, conversationId, requestId: billingTurnId, providerRequestId: `test-${randomUUID()}`,
      model: "test/cached-model",
      inputTokens: 100, outputTokens: 50, cachedInputTokens: 60, cacheWriteInputTokens: 10,
      costUsd: 0
    });

    // The cached split must survive persistence: reconcileAiTurnFromUsageLogs
    // SUMs exactly these columns to price the turn.
    expect(await scalar("SELECT cached_input_tokens AS value FROM usage_logs WHERE tenant_id=$1", [x.t])).toBe(60);
    expect(await scalar("SELECT cache_write_input_tokens AS value FROM usage_logs WHERE tenant_id=$1", [x.t])).toBe(10);
    expect(await scalar("SELECT input_tokens AS value FROM usage_logs WHERE tenant_id=$1", [x.t])).toBe(100);

    await reconcileAiTurnFromUsageLogs(x.t, "follow_up", billingTurnId);
    expect(await scalar("SELECT cached_tokens AS value FROM ai_usage_ledger WHERE tenant_id=$1", [x.t])).toBe("60");
    // A reported provider cost (even 0) is a real cost: provider micros win over
    // model pricing and stay 0 — the discount path is the cost-ABSENT one below.
    expect(await scalar("SELECT provider_cost_usd_micros AS value FROM ai_usage_ledger WHERE tenant_id=$1", [x.t])).toBe("0");

    // When provider cost is ABSENT, fallback pricing discounts the cached tokens
    // the reconcile now sees: 40 fresh + 60 cached + 50 output at the prices
    // above = 369 micros, not 450 (cached tokens billed at the fresh-input rate).
    // reconcileAiTurnFromUsageLogs always materializes Number(cost_usd), so the
    // cost-absent case is exercised at the reconcileAiInteraction seam it feeds.
    const secondTurnId = deriveBillingTurnId(x.t, "follow_up", `${conversationId}:3`);
    expect(await consumeAiInteraction(x.t, "follow_up", secondTurnId, { conversationId })).toMatchObject({ allowed: true });
    await reconcileAiInteraction(x.t, "follow_up", secondTurnId, { model: "test/cached-model", inputTokens: 100, outputTokens: 50, cachedTokens: 60 });
    expect(await scalar("SELECT provider_cost_usd_micros AS value FROM ai_usage_ledger WHERE tenant_id=$1 AND logical_turn_id=$2::uuid", [x.t, secondTurnId])).toBe("369");
  });

  it("records provider cost provenance on follow-up usage: costReported=false persists, omitted defaults to reported", async () => {
    const x = await setup(2);
    const conversationId = await conversation(x.t);
    const reportedFalse = `test-${randomUUID()}`;
    const omitted = `test-${randomUUID()}`;
    await followUps.recordAiUsage({
      tenantId: x.t, conversationId, providerRequestId: reportedFalse,
      model: "test/model", inputTokens: 10, outputTokens: 5, costUsd: 0, costReported: false
    });
    await followUps.recordAiUsage({
      tenantId: x.t, conversationId, providerRequestId: omitted,
      model: "test/model", inputTokens: 10, outputTokens: 5, costUsd: 0
    });
    const reported = async (id: string) => (await pool.query<{ cost_reported: boolean }>(
      "SELECT cost_reported FROM usage_logs WHERE tenant_id=$1 AND provider_request_id=$2", [x.t, id]
    )).rows[0];
    // A provider-reported zero is a real zero; an omitted cost keeps the legacy reported=true default
    expect(await reported(reportedFalse)).toEqual({ cost_reported: false });
    expect(await reported(omitted)).toEqual({ cost_reported: true });
  });
});
