import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { consumeAiInteraction, reconcileAiInteraction } from "../src/billing/ai-consumption.js";
import { ensureOpenPeriod } from "../src/billing/usage-period.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const tenants: string[] = [];
const plans: string[] = [];

async function tenant(label: string): Promise<string> {
  const slug = `billing-ai-${label}-${randomUUID()}`;
  const r = await pool.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [slug, slug]);
  tenants.push(r.rows[0].id); return r.rows[0].id;
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

describe("AI consumption against real Postgres", () => {
  it("consumes rollover, then bonus, then included and debits each source", async () => {
    const t = await tenant("order"), p = await plan(3); await subscribe(t, p); const u = await period(t);
    await pool.query("UPDATE usage_periods SET sequence=2, rollover_granted=1, bonus_granted=1 WHERE id=$1", [u.id]);
    await pool.query("INSERT INTO rollover_ledger(tenant_id,usage_period_id,generated_amount,consumed_amount,rollover_rate_bps,expires_at) VALUES($1,$2,1,0,5000,now()+interval '1 day')", [t, u.id]);
    const g = await pool.query<{ id: string }>("INSERT INTO usage_grants(tenant_id,usage_period_id,kind,amount,reason) VALUES($1,$2,'BONUS',1,'test') RETURNING id", [t, u.id]);
    for (const [key, expected] of [["r", "ROLLOVER"], ["b", "BONUS"], ["i", "INCLUDED"]] as const) { const x = await consumeAiInteraction(t, "inbound_reply", key); expect(x).toMatchObject({ allowed: true, consumptionType: expected }); }
    const rows = await pool.query<{ consumption_type: string }>("SELECT consumption_type FROM ai_usage_ledger WHERE tenant_id=$1 ORDER BY created_at", [t]); expect(rows.rows.map(x => x.consumption_type)).toEqual(["ROLLOVER", "BONUS", "INCLUDED"]);
    const usage = await pool.query("SELECT rollover_usage,bonus_usage,included_usage FROM usage_periods WHERE id=$1", [u.id]); expect(usage.rows[0]).toMatchObject({ rollover_usage: "1", bonus_usage: "1", included_usage: "1" });
    expect(await scalar("SELECT consumed_amount AS value FROM rollover_ledger WHERE tenant_id=$1", [t])).toBe("1"); expect(await scalar("SELECT consumed_amount AS value FROM usage_grants WHERE id=$1", [g.rows[0].id])).toBe("1");
  });

  it("rejects exhausted included quota without credit or a new ledger row", async () => {
    const t = await tenant("quota"), p = await plan(1); await subscribe(t, p); await period(t); expect((await consumeAiInteraction(t, "inbound_reply", "one")).allowed).toBe(true); const before = await scalar<number>("SELECT count(*)::int AS value FROM ai_usage_ledger WHERE tenant_id=$1", [t]); expect(await consumeAiInteraction(t, "inbound_reply", "two")).toMatchObject({ allowed: false, reason: "QUOTA_EXCEEDED" }); expect(await scalar<number>("SELECT count(*)::int AS value FROM ai_usage_ledger WHERE tenant_id=$1", [t])).toBe(before);
  });

  it("enforces a fixed overage cap including reservations", async () => {
    // A estimativa por interação SEM histórico é `min_overage_estimate_cents`
    // (0135). O valor é GLOBAL (billing_settings; banco compartilhado — outro
    // teste o deixa em 7), então cap 1 hardcoded nega a PRIMEIRA reserva.
    // cap = valor REAL lido do banco: a primeira reserva o consome inteiro e a
    // segunda bate em CREDIT_CAP_REACHED pela RESERVA em voo — o ponto do teste.
    const t = await tenant("cap"), p = await plan(0); await subscribe(t, p); await period(t);
    const cap = Number(await scalar("SELECT min_overage_estimate_cents AS value FROM billing_settings WHERE id=true"));
    await configureCredit(t, cap);
    const first = await consumeAiInteraction(t, "inbound_reply", "one");
    expect(first).toMatchObject({ allowed: true, consumptionType: "OVERAGE" });
    const second = await consumeAiInteraction(t, "inbound_reply", "two");
    expect(second).toMatchObject({ allowed: false, reason: "CREDIT_CAP_REACHED" });
    const r = await pool.query("SELECT overage_amount_brl_cents,reserved_cents FROM usage_periods WHERE tenant_id=$1", [t]);
    expect(Number(r.rows[0].overage_amount_brl_cents) + Number(r.rows[0].reserved_cents)).toBeLessThanOrEqual(cap);
  });

  it("is idempotent, rejects disabled AI, and fails open without subscription", async () => {
    const t = await tenant("idem"), p = await plan(5); await subscribe(t, p); await period(t); const a = await consumeAiInteraction(t, "inbound_reply", "same"); const b = await consumeAiInteraction(t, "inbound_reply", "same"); expect(b.ledgerId).toBe(a.ledgerId); expect(await scalar<number>("SELECT count(*)::int AS value FROM ai_usage_ledger WHERE tenant_id=$1", [t])).toBe(1); expect(await scalar("SELECT included_usage AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe("1");
    const d = await tenant("disabled"); await subscribe(d, await plan(5, false)); expect(await consumeAiInteraction(d, "inbound_reply", "x")).toMatchObject({ allowed: false, reason: "AI_DISABLED" }); const n = await tenant("none"); await expect(consumeAiInteraction(n, "inbound_reply", "x")).resolves.toMatchObject({ allowed: true });
  });

  it("releases the exact reservation and is safe to reconcile twice", async () => {
    // Teto FIXO 5000 e custo real providerCostUsd=10 (~16500c) ACIMA do teto: a
    // asserção antiga (overage == billable do ledger) violava o hard cap §17.
    // Correto: cobrado = min(real, teto); ledger mantém o custo real inteiro;
    // saldo assinado do financial_ledger confere com o TOTAL COBRADO; repetir a
    // reconciliação é idempotente (nenhum valor/lançamento novo).
    const t = await tenant("reconcile"), p = await plan(0); await subscribe(t, p); const u = await period(t); const cap = 5000; await configureCredit(t, cap);
    const c = await consumeAiInteraction(t, "inbound_reply", "real");
    expect(c).toMatchObject({ allowed: true, consumptionType: "OVERAGE" }); expect(c.estimatedCents).toBeGreaterThan(0);
    expect(Number(await scalar("SELECT reserved_cents AS value FROM usage_periods WHERE id=$1", [u.id]))).toBe(Number(c.estimatedCents));
    expect(Number(await scalar("SELECT overage_amount_brl_cents AS value FROM usage_periods WHERE id=$1", [u.id]))).toBe(0);
    const actual = { model: null, inputTokens: 0, outputTokens: 0, cachedTokens: 0, providerCostUsd: 10 };
    await reconcileAiInteraction(t, "inbound_reply", "real", actual);
    const row = await pool.query("SELECT reserved_cents,overage_amount_brl_cents FROM usage_periods WHERE id=$1", [u.id]);
    const ledger = await pool.query("SELECT reconciled,billable_amount_brl_cents FROM ai_usage_ledger WHERE tenant_id=$1", [t]);
    const real = Number(ledger.rows[0].billable_amount_brl_cents);
    expect(ledger.rows[0].reconciled).toBe(true);
    expect(real).toBeGreaterThan(cap);
    expect(Number(row.rows[0].reserved_cents)).toBe(0);
    expect(Number(row.rows[0].overage_amount_brl_cents)).toBe(Math.min(real, cap));
    const financial = await pool.query<{ direction: string; amount_cents: string }>("SELECT direction,amount_cents FROM financial_ledger WHERE tenant_id=$1", [t]);
    const signedBalance = financial.rows.reduce((s, r) => s + (r.direction === "CREDIT" ? Number(r.amount_cents) : -Number(r.amount_cents)), 0);
    expect(signedBalance).toBe(Number(row.rows[0].overage_amount_brl_cents));
    const ledgerCount = await scalar<number>("SELECT count(*)::int AS value FROM ai_usage_ledger WHERE tenant_id=$1", [t]);
    const financialCount = financial.rows.length;
    await reconcileAiInteraction(t, "inbound_reply", "real", actual);
    const amount = row.rows[0].overage_amount_brl_cents;
    expect(Number(await scalar("SELECT overage_amount_brl_cents AS value FROM usage_periods WHERE id=$1", [u.id]))).toBe(Number(amount));
    expect(Number(await scalar("SELECT reserved_cents AS value FROM usage_periods WHERE id=$1", [u.id]))).toBe(0);
    expect(await scalar<number>("SELECT count(*)::int AS value FROM ai_usage_ledger WHERE tenant_id=$1", [t])).toBe(ledgerCount);
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM financial_ledger WHERE tenant_id=$1", [t])).rows[0].n).toBe(financialCount);
  });

  it("libera a reserva EXATA quando o custo real e MENOR que a estimativa", async () => {
    // Caso critico que os outros testes NAO cobrem: quando o custo real e MAIOR que a
    // reserva, o GREATEST(0, reserved - X) zera a reserva tanto com o valor certo quanto
    // com o errado — o bug fica mascarado. So com real < estimativa da para distinguir.
    // Se a reconciliacao subtrair o valor REAL (bug) em vez da RESERVA (correto),
    // sobra reserva presa no periodo e o spending cap (§17) vai apertando sozinho.
    const t = await tenant("reserva-menor"), p = await plan(0);
    await subscribe(t, p); const u = await period(t); await configureCredit(t, 1_000_000);

    // Infla a estimativa: estimateInteractionCents usa a media dos lancamentos do tenant.
    for (let i = 0; i < 5; i++) {
      await pool.query(
        "INSERT INTO ai_usage_ledger(tenant_id,usage_period_id,interaction_key,purpose,consumption_type,billable_amount_brl_cents,pricing_strategy,reconciled) VALUES($1,$2,$3,'inbound_reply','OVERAGE',5000,'COST_PLUS_MARKUP',true)",
        [t, u.id, randomUUID()]
      );
    }
    const consumo = await consumeAiInteraction(t, "inbound_reply", "reserva-alta");
    expect(consumo).toMatchObject({ allowed: true, consumptionType: "OVERAGE" });
    const estimativa = Number(consumo.estimatedCents);
    expect(estimativa).toBeGreaterThan(100);
    expect(Number(await scalar("SELECT reserved_cents AS value FROM usage_periods WHERE id=$1", [u.id]))).toBe(estimativa);

    // Custo real minusculo: bem MENOR que a reserva.
    await reconcileAiInteraction(t, "inbound_reply", "reserva-alta", { model: null, inputTokens: 0, outputTokens: 0, cachedTokens: 0, providerCostUsd: 0.0001 });

    const real = Number(await scalar("SELECT billable_amount_brl_cents AS value FROM ai_usage_ledger WHERE tenant_id=$1 AND interaction_key IS NOT NULL AND reconciled_at IS NOT NULL LIMIT 1", [t]));
    expect(real).toBeLessThan(estimativa);
    // A reserva tem de ser liberada POR INTEIRO. Com o bug, sobraria (estimativa - real).
    expect(Number(await scalar("SELECT reserved_cents AS value FROM usage_periods WHERE id=$1", [u.id]))).toBe(0);
  });
});
