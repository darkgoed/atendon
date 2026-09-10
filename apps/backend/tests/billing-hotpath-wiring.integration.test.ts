import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { consumeAiInteraction } from "../src/billing/ai-consumption.js";
import { ensureOpenPeriod } from "../src/billing/usage-period.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const tenants: string[] = [];
const plans: string[] = [];

async function tenant(label: string): Promise<string> {
  const slug = `billing-ai-${label}-${randomUUID()}`;
  const r = await pool.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [slug, slug]);
  await pool.query(
    "INSERT INTO whatsapp_sessions(tenant_id,label,is_primary) VALUES($1,'Principal',true)",
    [r.rows[0].id]
  );
  tenants.push(r.rows[0].id);
  return r.rows[0].id;
}
async function plan(limit: number | null, aiEnabled = true): Promise<string> {
  const code = `BILLING_AI_${randomUUID()}`;
  const r = await pool.query<{ id: string }>("INSERT INTO plans(code,name,billing_period_months,monthly_price_cents,ai_enabled) VALUES($1,$2,1,0,$3) RETURNING id", [code, code, aiEnabled]);
  plans.push(r.rows[0].id);
  await pool.query("INSERT INTO plan_limits(plan_id,limit_key,limit_value) VALUES($1,'MAX_AI_INTERACTIONS',$2)", [r.rows[0].id, limit]);
  return r.rows[0].id;
}
async function subscribe(t: string, p: string): Promise<void> {
  await pool.query("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) VALUES($1,$2,'ACTIVE',now(),now()+interval '1 month')", [t, p]);
}
async function period(t: string) {
  const c = await pool.connect();
  try { await c.query("BEGIN"); await c.query("SELECT id FROM tenant_subscriptions WHERE tenant_id=$1 FOR UPDATE", [t]); const r = await ensureOpenPeriod(c, t); await c.query("COMMIT"); return r!; }
  catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}
async function scalar<T = string>(sql: string, params: unknown[] = []): Promise<T> { return (await pool.query<{ value: T }>(sql, params)).rows[0].value; }
async function configureCredit(t: string, cap: number) { await pool.query("INSERT INTO tenant_usage_credit_settings(tenant_id,enabled,limit_type,monthly_spending_limit_cents) VALUES($1,true,'FIXED',$2)", [t, cap]); }

afterAll(async () => { if (tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenants]); if (plans.length) await pool.query("DELETE FROM plans WHERE id=ANY($1::uuid[])", [plans]); await pool.end(); });


import { reconcileAiTurnFromUsageLogs } from "../src/billing/ai-consumption.js";

describe("AI hotpath usage-log reconciliation", () => {
  it("sums all usage_logs rows for one logical turn and is idempotent", async () => {
    const t = await tenant("hotpath-sum"), p = await plan(0); await subscribe(t, p); await period(t); await configureCredit(t, 100000);
    const turn = randomUUID();
    const conversation = await pool.query<{ id: string }>(
      `INSERT INTO conversations(tenant_id,session_id,contact_phone,status)
       SELECT $1,id,'5511999999999','open'
       FROM whatsapp_sessions WHERE tenant_id=$1 AND is_primary AND archived_at IS NULL
       RETURNING id`,
      [t]
    );
    await consumeAiInteraction(t, "inbound_reply", turn);
    for (const row of [[10,20,1,0.10],[30,40,2,0.20],[50,60,3,0.70]] as const) await pool.query("INSERT INTO usage_logs(tenant_id,conversation_id,ai_model,input_tokens,output_tokens,cached_input_tokens,cost_usd,request_id) VALUES($1,$2,'model-a',$3,$4,$5,$6,$7)", [t,conversation.rows[0].id,...row,turn]);
    await reconcileAiTurnFromUsageLogs(t, "inbound_reply", turn);
    const ledger = await pool.query("SELECT input_tokens,output_tokens,cached_tokens,provider_cost_usd_micros FROM ai_usage_ledger WHERE tenant_id=$1", [t]);
    expect(Number(ledger.rows[0].input_tokens)).toBe(90); expect(Number(ledger.rows[0].output_tokens)).toBe(120); expect(Number(ledger.rows[0].cached_tokens)).toBe(6); expect(Number(ledger.rows[0].provider_cost_usd_micros)).toBe(1000000);
    const before = await scalar("SELECT overage_amount_brl_cents AS value FROM usage_periods WHERE tenant_id=$1", [t]); await reconcileAiTurnFromUsageLogs(t, "inbound_reply", turn); expect(await scalar("SELECT overage_amount_brl_cents AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe(before);
  });
  it("ignores non-UUID ids and missing logs without changing the ledger", async () => {
    const t = await tenant("hotpath-invalid"), p = await plan(0); await subscribe(t, p); await period(t); await configureCredit(t, 100000); const c = await consumeAiInteraction(t, "follow_up", "conversation:1");
    await expect(reconcileAiTurnFromUsageLogs(t, "follow_up", "conversation:1")).resolves.toBeUndefined(); expect(await scalar("SELECT count(*)::int AS value FROM ai_usage_ledger WHERE tenant_id=$1", [t])).toBe(1);
    const missing = randomUUID(); await reconcileAiTurnFromUsageLogs(t, "inbound_reply", missing); expect(await scalar("SELECT count(*)::int AS value FROM ai_usage_ledger WHERE tenant_id=$1", [t])).toBe(1); expect(c.allowed).toBe(true);
  });
});
