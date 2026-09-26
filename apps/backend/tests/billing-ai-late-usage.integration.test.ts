// Uso de IA TARDIO: a chamada termina depois que a reserva expirou (TTL) ou
// foi liberada. O provedor cobrou → a contabilização final precisa cobrar,
// de forma idempotente, sem cobrança dupla e sem saldo/teto estourado.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { ensureOpenPeriod } from "../src/billing/usage-period.js";
import { consumeAiInteraction, reconcileAiTurnFromUsageLogs, releaseAiInteractionWithoutUsage } from "../src/billing/ai-consumption.js";
import { runBillingReconciliationBatch } from "../src/billing/reconciler.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const tenants: string[] = [], plans: string[] = [];
async function setup(limit: number) {
  const slug = `late-usage-${randomUUID()}`;
  const t = (await pool.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$1,'active') RETURNING id", [slug])).rows[0].id; tenants.push(t);
  const p = (await pool.query<{ id: string }>("INSERT INTO plans(code,name,billing_period_months,monthly_price_cents) VALUES($1,$1,1,0) RETURNING id", [slug])).rows[0].id; plans.push(p);
  await pool.query("INSERT INTO plan_limits(plan_id,limit_key,limit_value) VALUES($1,'MAX_AI_INTERACTIONS',$2)", [p, limit]);
  await pool.query("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) VALUES($1,$2,'ACTIVE',now(),now()+interval '1 month')", [t, p]);
  const c = await pool.connect(); try { await c.query("BEGIN"); const r = await ensureOpenPeriod(c, t); await c.query("COMMIT"); return { t, period: r! }; } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}
const one = async <T = string>(sql: string, p: unknown[] = []) => (await pool.query<{ value: T }>(sql, p)).rows[0]?.value;
const credit = (t: string, cap: number) => pool.query("INSERT INTO tenant_usage_credit_settings(tenant_id,enabled,limit_type,monthly_spending_limit_cents) VALUES($1,true,'FIXED',$2)", [t, cap]);
const expireAll = async (t: string) => { await pool.query("UPDATE ai_usage_ledger SET created_at=now()-interval '2 days' WHERE tenant_id=$1 AND reconciled=false", [t]); await runBillingReconciliationBatch(); };
const logUsage = (t: string, turn: string) => pool.query("INSERT INTO usage_logs(tenant_id,request_id,ai_model,input_tokens,output_tokens,cost_usd) VALUES($1,$2,'test-model',1000,1000,0.02)", [t, turn]);
const ledger = (t: string) => pool.query<{ reconciled: boolean; marker: string | null; consumption_type: string; billable: string; usage_period_id: string }>(
  "SELECT reconciled, pricing_snapshot->>'reconciliation' AS marker, consumption_type, billable_amount_brl_cents::text AS billable, usage_period_id FROM ai_usage_ledger WHERE tenant_id=$1", [t]).then(r => r.rows);
const aiNet = async (t: string) => Number(await one("SELECT COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount_cents ELSE -amount_cents END),0)::text AS value FROM financial_ledger WHERE tenant_id=$1 AND actor_type='AI_RESERVATION'", [t]));

afterAll(async () => { if (tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenants]); if (plans.length) await pool.query("DELETE FROM plans WHERE id=ANY($1::uuid[])", [plans]); await pool.end(); });

describe("uso de IA tardio (reserva expirada durante a execução)", () => {
  it("TTL liberou a franquia; uso chega depois → cobra 1 interação, uma única vez", async () => {
    const x = await setup(5); const turn = randomUUID();
    expect(await consumeAiInteraction(x.t, "inbound_reply", turn)).toMatchObject({ allowed: true, consumptionType: "INCLUDED" });
    await expireAll(x.t);
    expect(await one("SELECT included_usage AS value FROM usage_periods WHERE id=$1", [x.period.id])).toBe("0");
    await logUsage(x.t, turn);
    await reconcileAiTurnFromUsageLogs(x.t, "inbound_reply", turn);
    expect(await one("SELECT included_usage AS value FROM usage_periods WHERE id=$1", [x.period.id])).toBe("1");
    const [row] = await ledger(x.t);
    expect(row).toMatchObject({ reconciled: true, marker: null, consumption_type: "INCLUDED" });
    expect(Number(await one("SELECT provider_cost_usd_micros AS value FROM ai_usage_ledger WHERE tenant_id=$1", [x.t]))).toBeGreaterThan(0);
    // Replays (fire-and-forget do turno + lote) não cobram de novo.
    await reconcileAiTurnFromUsageLogs(x.t, "inbound_reply", turn);
    const r = await runBillingReconciliationBatch(); expect(r.errors.filter(e => e.includes(x.t))).toEqual([]);
    expect(await one("SELECT included_usage AS value FROM usage_periods WHERE id=$1", [x.period.id])).toBe("1");
    expect(await one("SELECT count(*)::int AS value FROM ai_usage_ledger WHERE tenant_id=$1", [x.t])).toBe(1);
  });

  it("lote cobra sozinho quando o reconcile do turno nunca rodou (rede de segurança)", async () => {
    const x = await setup(5); const turn = randomUUID();
    await consumeAiInteraction(x.t, "follow_up", turn);
    await expireAll(x.t);
    await logUsage(x.t, turn);
    await runBillingReconciliationBatch();
    expect(await one("SELECT included_usage AS value FROM usage_periods WHERE id=$1", [x.period.id])).toBe("1");
    expect((await ledger(x.t))[0]).toMatchObject({ reconciled: true, marker: null });
    await runBillingReconciliationBatch();
    expect(await one("SELECT included_usage AS value FROM usage_periods WHERE id=$1", [x.period.id])).toBe("1");
  });

  it("sem cota nem crédito para o uso tardio: não estoura a franquia, registra custo e não repete", async () => {
    const x = await setup(1); const turn = randomUUID();
    await consumeAiInteraction(x.t, "inbound_reply", turn);
    await expireAll(x.t);
    // Outra conversa ocupou a franquia liberada.
    expect(await consumeAiInteraction(x.t, "inbound_reply", randomUUID())).toMatchObject({ allowed: true, consumptionType: "INCLUDED" });
    await logUsage(x.t, turn);
    await reconcileAiTurnFromUsageLogs(x.t, "inbound_reply", turn);
    expect(await one("SELECT included_usage AS value FROM usage_periods WHERE id=$1", [x.period.id])).toBe("1");
    expect(await one("SELECT overage_usage AS value FROM usage_periods WHERE id=$1", [x.period.id])).toBe("0");
    expect(await one("SELECT pricing_snapshot->>'reconciliation' AS value FROM ai_usage_ledger WHERE tenant_id=$1 AND logical_turn_id=$2", [x.t, turn])).toBe("late_usage_uncharged");
    expect(Number(await one("SELECT provider_cost_usd_micros AS value FROM ai_usage_ledger WHERE tenant_id=$1 AND logical_turn_id=$2", [x.t, turn]))).toBeGreaterThan(0);
    await runBillingReconciliationBatch(); await reconcileAiTurnFromUsageLogs(x.t, "inbound_reply", turn);
    expect(await one("SELECT included_usage AS value FROM usage_periods WHERE id=$1", [x.period.id])).toBe("1");
    // Retentativa da MESMA chave não reaproveita a reserva antiga: sem cota é recusada (nada de IA grátis).
    expect(await consumeAiInteraction(x.t, "inbound_reply", turn)).toMatchObject({ allowed: false });
    expect(await one("SELECT included_usage AS value FROM usage_periods WHERE id=$1", [x.period.id])).toBe("1");
  });

  it("OVERAGE liberado e reaberto: financial_ledger fecha no valor cobrado, com chaves próprias por geração", async () => {
    const x = await setup(0); await credit(x.t, 100000); const turn = randomUUID();
    expect(await consumeAiInteraction(x.t, "inbound_reply", turn)).toMatchObject({ allowed: true, consumptionType: "OVERAGE" });
    await expireAll(x.t);
    expect(await aiNet(x.t)).toBe(0);
    await logUsage(x.t, turn);
    await reconcileAiTurnFromUsageLogs(x.t, "inbound_reply", turn);
    const charged = Number(await one("SELECT overage_amount_brl_cents AS value FROM usage_periods WHERE id=$1", [x.period.id]));
    expect(charged).toBeGreaterThan(0);
    expect(await one("SELECT reserved_cents AS value FROM usage_periods WHERE id=$1", [x.period.id])).toBe("0");
    expect(await aiNet(x.t)).toBe(charged);
    await reconcileAiTurnFromUsageLogs(x.t, "inbound_reply", turn); await runBillingReconciliationBatch();
    expect(Number(await one("SELECT overage_amount_brl_cents AS value FROM usage_periods WHERE id=$1", [x.period.id]))).toBe(charged);
    expect(await aiNet(x.t)).toBe(charged);
  });

  it("uso tardio respeita o teto fixo de crédito (sem saldo negativo nem cobrança acima do cap)", async () => {
    const x = await setup(0); await credit(x.t, 1); const turn = randomUUID();
    const c = await consumeAiInteraction(x.t, "inbound_reply", turn);
    await expireAll(x.t);
    await logUsage(x.t, turn);
    await reconcileAiTurnFromUsageLogs(x.t, "inbound_reply", turn);
    expect(Number(await one("SELECT overage_amount_brl_cents AS value FROM usage_periods WHERE id=$1", [x.period.id]))).toBeLessThanOrEqual(1);
    expect(await aiNet(x.t)).toBeGreaterThanOrEqual(0);
    expect(await aiNet(x.t)).toBeLessThanOrEqual(1);
    expect(c.allowed === false || (await ledger(x.t))[0].reconciled).toBe(true);
  });

  it("retentativa com a MESMA chave após liberação reserva de novo (não é IA grátis)", async () => {
    const x = await setup(1); const turn = randomUUID();
    await consumeAiInteraction(x.t, "follow_up", turn);
    await releaseAiInteractionWithoutUsage(x.t, "follow_up", turn);
    expect(await one("SELECT included_usage AS value FROM usage_periods WHERE id=$1", [x.period.id])).toBe("0");
    expect(await consumeAiInteraction(x.t, "follow_up", turn)).toMatchObject({ allowed: true, consumptionType: "INCLUDED" });
    expect(await one("SELECT included_usage AS value FROM usage_periods WHERE id=$1", [x.period.id])).toBe("1");
    expect((await ledger(x.t))[0]).toMatchObject({ reconciled: false });
    // Reserva viva: repetir a chave é idempotente.
    await consumeAiInteraction(x.t, "follow_up", turn);
    expect(await one("SELECT included_usage AS value FROM usage_periods WHERE id=$1", [x.period.id])).toBe("1");
    // A geração reaberta ganha TTL próprio: não expira pelo created_at antigo.
    await pool.query("UPDATE ai_usage_ledger SET created_at=now()-interval '2 days' WHERE tenant_id=$1", [x.t]);
    await runBillingReconciliationBatch();
    expect((await ledger(x.t))[0]).toMatchObject({ reconciled: false });
  });

  it("concorrência: TTL e reconcile tardio disputando o mesmo turno cobram exatamente uma vez", async () => {
    for (let i = 0; i < 6; i++) {
      const x = await setup(5); await credit(x.t, 100000); const turn = randomUUID();
      await consumeAiInteraction(x.t, "inbound_reply", turn);
      await pool.query("UPDATE ai_usage_ledger SET created_at=now()-interval '2 days' WHERE tenant_id=$1", [x.t]);
      await logUsage(x.t, turn);
      await Promise.all([runBillingReconciliationBatch(), reconcileAiTurnFromUsageLogs(x.t, "inbound_reply", turn), reconcileAiTurnFromUsageLogs(x.t, "inbound_reply", turn)]);
      await runBillingReconciliationBatch();
      expect(await one("SELECT included_usage AS value FROM usage_periods WHERE id=$1", [x.period.id])).toBe("1");
      expect((await ledger(x.t))[0]).toMatchObject({ reconciled: true, marker: null });
    }
  });
});
