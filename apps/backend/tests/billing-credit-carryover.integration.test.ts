import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { consumeAiInteraction, grantAiCreditPackage } from "../src/billing/ai-consumption.js";
import { getUsageDashboard } from "../src/billing/alerts.js";
import { creditPackBalance } from "../src/billing/credit-packs.js";
import { ensureOpenPeriod } from "../src/billing/usage-period.js";
import { previewRollover, truncateRolloverToPlanCap } from "../src/billing/rollover.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const tenants: string[] = [];
const plans: string[] = [];

async function tenant(label: string): Promise<string> {
  const slug = `billing-carryover-${label}-${randomUUID()}`;
  const r = await pool.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [slug, slug]);
  tenants.push(r.rows[0].id); return r.rows[0].id;
}
async function plan(opts: { interactions?: number; credits?: number; rollover?: boolean }): Promise<string> {
  const code = `BILLING_CARRYOVER_${randomUUID()}`;
  const r = await pool.query<{ id: string }>("INSERT INTO plans(code,name,billing_period_months,monthly_price_cents,ai_enabled) VALUES($1,$2,1,0,true) RETURNING id", [code, code]);
  plans.push(r.rows[0].id);
  if (opts.interactions !== undefined) await pool.query("INSERT INTO plan_limits(plan_id,limit_key,limit_value) VALUES($1,'MAX_AI_INTERACTIONS',$2)", [r.rows[0].id, opts.interactions]);
  if (opts.credits !== undefined) await pool.query("INSERT INTO plan_limits(plan_id,limit_key,limit_value) VALUES($1,'MAX_AI_CREDITS',$2)", [r.rows[0].id, opts.credits]);
  if (opts.rollover === false) await pool.query("UPDATE plans SET rollover_enabled=false WHERE id=$1", [r.rows[0].id]);
  return r.rows[0].id;
}
async function subscribe(t: string, p: string): Promise<void> {
  // start_at retroativo (1 dia): advance() recua end_at do período aberto para
  // now()-1h e o próximo período herda esse end_at como start_at. A cadeia de
  // usage_periods só é monotônica (e o unique(tenant_id,start_at) só não colide
  // no 3º ciclo) se o 1º período nascer com start_at < now()-1h.
  await pool.query("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) VALUES($1,$2,'ACTIVE',now()-interval '1 day',now()-interval '1 day'+interval '1 month')", [t, p]);
}
async function period(t: string) {
  const c = await pool.connect();
  try { await c.query("BEGIN"); await c.query("SELECT id FROM tenant_subscriptions WHERE tenant_id=$1 FOR UPDATE", [t]); const r = await ensureOpenPeriod(c, t); await c.query("COMMIT"); return r!; }
  catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}
/** Avança o ciclo: a vigência é decidida pelo BANCO (end_at > now()). */
async function advance(t: string): Promise<void> {
  await pool.query("UPDATE usage_periods SET end_at=now()-interval '1 hour' WHERE tenant_id=$1 AND status='OPEN'", [t]);
  await period(t);
}
async function scalar<T = string>(sql: string, params: unknown[] = []): Promise<T> { return (await pool.query<{ value: T }>(sql, params)).rows[0].value; }
async function openPeriodRow(t: string): Promise<Record<string, unknown>> {
  return (await pool.query("SELECT * FROM usage_periods WHERE tenant_id=$1 AND status='OPEN'", [t])).rows[0];
}
async function dashboard(t: string) {
  const c = await pool.connect();
  try { return await getUsageDashboard(c, t); } finally { c.release(); }
}

afterAll(async () => {
  if (tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenants]);
  if (plans.length) await pool.query("DELETE FROM plans WHERE id=ANY($1::uuid[])", [plans]);
  await pool.end();
});

describe("carryover de créditos comprados entre ciclos (pacote + rollover)", () => {
  it("pacote 50M: saldo sobrevive à renovação, entra no dashboard e é consumido do MESMO grant no ciclo 2", async () => {
    const t = await tenant("carry"), p = await plan({ credits: 40_000, rollover: false }); await subscribe(t, p); await period(t);
    const grant = await grantAiCreditPackage({ tenantId: t, credits: 50_000_000, reason: "pacote 50M", idempotencyKey: `carry-${randomUUID()}` });
    expect(grant).not.toBeNull();
    const first = await consumeAiInteraction(t, "inbound_reply", "carry-c1");
    expect(first).toMatchObject({ allowed: true, consumptionType: "BONUS" });
    const used1 = first.estimatedCredits!;
    let dash = await dashboard(t);
    expect(dash).not.toBeNull();
    expect(dash!.usageUnit).toBe("CREDIT");
    expect(dash!.bonusGranted).toBe(50_000_000);
    expect(dash!.totalAvailable).toBe(40_000 + 50_000_000);

    await advance(t);
    const row = await openPeriodRow(t);
    expect(row.usage_unit).toBe("CREDIT");
    // Snapshot do ciclo 2 = saldo RESTANTE do grant (não zera, não duplica).
    expect(Number(row.bonus_granted)).toBe(50_000_000 - used1);
    dash = await dashboard(t);
    expect(dash!.bonusGranted).toBe(50_000_000 - used1);
    expect(dash!.totalAvailable).toBe(40_000 + (50_000_000 - used1));
    expect(dash!.totalUsed).toBeLessThanOrEqual(dash!.totalAvailable!);
    expect(dash!.usedPercentBps).toBeLessThanOrEqual(10_000);
    const balance = await creditPackBalance(t);
    expect(balance.availableCredits).toBe(50_000_000 - used1);

    // Reserva no ciclo 2 usa o MESMO grant (não recria crédito).
    const second = await consumeAiInteraction(t, "inbound_reply", "carry-c2");
    expect(second).toMatchObject({ allowed: true, consumptionType: "BONUS" });
    const grants = await pool.query("SELECT amount, consumed_amount FROM usage_grants WHERE tenant_id=$1 AND kind='CREDIT_PACKAGE'", [t]);
    expect(grants.rowCount).toBe(1);
    expect(Number(grants.rows[0].consumed_amount)).toBe(used1 + second.estimatedCredits!);

    // Terceiro ciclo: saldo segue coerente, sem dupla contagem.
    await advance(t);
    dash = await dashboard(t);
    expect(dash!.bonusGranted).toBe(50_000_000 - used1 - second.estimatedCredits!);
    expect(dash!.totalAvailable).toBe(40_000 + (50_000_000 - used1 - second.estimatedCredits!));
    expect(dash!.totalUsed).toBeLessThanOrEqual(dash!.totalAvailable!);
  });

  it("legado INTERACTION: pacote retido aparece na virada para CREDIT e libera o consumo", async () => {
    const t = await tenant("legacy"), p = await plan({ interactions: 5, rollover: false }); await subscribe(t, p); await period(t);
    await grantAiCreditPackage({ tenantId: t, credits: 50_000_000, reason: "pacote", idempotencyKey: `legacy-${randomUUID()}` });
    let dash = await dashboard(t);
    expect(dash!.usageUnit).toBe("INTERACTION");
    expect(dash!.bonusGranted).toBe(0); // retido: não infla cota de interações

    // Plano ganha MAX_AI_CREDITS → próximo período nasce CREDIT.
    await pool.query("INSERT INTO plan_limits(plan_id,limit_key,limit_value) VALUES($1,'MAX_AI_CREDITS',$2)", [p, 40_000]);
    await advance(t);
    const row = await openPeriodRow(t);
    expect(row.usage_unit).toBe("CREDIT");
    expect(Number(row.bonus_granted)).toBe(50_000_000);
    dash = await dashboard(t);
    expect(dash!.usageUnit).toBe("CREDIT");
    expect(dash!.totalAvailable).toBe(40_000 + 50_000_000);
    const r = await consumeAiInteraction(t, "inbound_reply", "legacy-c2");
    expect(r).toMatchObject({ allowed: true, consumptionType: "BONUS" });
    expect(dash!.totalUsed).toBeLessThanOrEqual(dash!.totalAvailable!);
  });

  it("rollover: saldo vivo de ciclos anteriores entra no snapshot; expirado não; sem dupla contagem", async () => {
    const t = await tenant("roll"), p = await plan({ credits: 40_000, rollover: false }); await subscribe(t, p);
    const u1 = await period(t);
    // Ledger manual: uma linha viva (100k) e uma expirada (5k). O contador do
    // ciclo 1 é alinhado na fixture (o fix under test governa os ciclos 2+).
    await pool.query("INSERT INTO rollover_ledger(tenant_id,usage_period_id,rollover_rate_bps,generated_amount,usage_unit,expires_at) VALUES($1,$2,10000,100000,'CREDIT',now()+interval '60 days')", [t, u1.id]);
    await pool.query("INSERT INTO rollover_ledger(tenant_id,usage_period_id,rollover_rate_bps,generated_amount,usage_unit,expires_at) VALUES($1,$2,10000,5000,'CREDIT',now()-interval '1 day')", [t, u1.id]);
    await pool.query("UPDATE usage_periods SET rollover_granted=100000 WHERE id=$1", [u1.id]);
    const c1 = await consumeAiInteraction(t, "inbound_reply", "roll-c1");
    expect(c1).toMatchObject({ allowed: true, consumptionType: "ROLLOVER" });
    const used1 = c1.estimatedCredits!;
    // Fonte expirada (5k < estimativa) não é escolhida nem debitada.
    expect(Number(await scalar("SELECT consumed_amount AS value FROM rollover_ledger WHERE tenant_id=$1 AND generated_amount=5000", [t]))).toBe(0);

    await advance(t);
    let row = await openPeriodRow(t);
    expect(Number(row.rollover_granted)).toBe(100_000 - used1); // expirada (5k) fora
    let dash = await dashboard(t);
    expect(dash!.totalAvailable).toBe(40_000 + (100_000 - used1));
    expect(dash!.totalUsed).toBeLessThanOrEqual(dash!.totalAvailable!);

    await advance(t);
    row = await openPeriodRow(t);
    expect(Number(row.rollover_granted)).toBe(100_000 - used1); // sem dupla contagem entre ciclos
    dash = await dashboard(t);
    expect(dash!.totalAvailable).toBe(40_000 + (100_000 - used1));
  });
});

describe("truncamento de rollover na troca de plano (isolamento de unidade)", () => {
  it("expira só a unidade do período aberto (CREDIT), na quantia exata do teto; linha INTERACTION intocada", async () => {
    const t = await tenant("trunc"), oldPlan = await plan({ credits: 40_000 });
    await subscribe(t, oldPlan);
    const p1 = await period(t);
    await pool.query("INSERT INTO rollover_ledger(tenant_id,usage_period_id,rollover_rate_bps,generated_amount,consumed_amount,expired_amount,usage_unit,expires_at) VALUES($1,$2,10000,30000,0,0,'CREDIT',now()+interval '60 days')", [t, p1.id]);
    await pool.query("INSERT INTO rollover_ledger(tenant_id,usage_period_id,rollover_rate_bps,generated_amount,consumed_amount,expired_amount,usage_unit,expires_at) VALUES($1,$2,10000,20000,0,0,'CREDIT',now()+interval '60 days')", [t, p1.id]);
    // Linha legada de INTERAÇÃO no mesmo tenant: não pode ser expirada como crédito.
    await pool.query("INSERT INTO rollover_ledger(tenant_id,usage_period_id,rollover_rate_bps,generated_amount,consumed_amount,expired_amount,usage_unit,expires_at) VALUES($1,$2,10000,90000,0,0,'INTERACTION',now()+interval '60 days')", [t, p1.id]);
    const np = await plan({ credits: 40_000 });
    await pool.query("UPDATE plans SET rollover_max_percentage_bps=5000 WHERE id=$1", [np]); // teto = 20_000 créditos
    expect((await openPeriodRow(t)).usage_unit).toBe("CREDIT");
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const r = await truncateRolloverToPlanCap(c, t, np);
      await c.query("COMMIT");
      // Saldo CREDIT 50_000, teto 20_000 → remove exatamente 30_000. Duas linhas
      // vivas provam o rateio: o delta NÃO pode ser aplicado a cada linha de novo
      // (seria 50_000 expirado) nem vazar para INTERACTION (seria +30_000 lá).
      expect(r.removed).toBe(30_000);
      expect(Number(await scalar("SELECT COALESCE(sum(generated_amount-consumed_amount-expired_amount),0) AS value FROM rollover_ledger WHERE tenant_id=$1 AND usage_unit='CREDIT'", [t]))).toBe(20_000);
      expect(Number(await scalar("SELECT COALESCE(sum(expired_amount),0) AS value FROM rollover_ledger WHERE tenant_id=$1 AND usage_unit='CREDIT'", [t]))).toBe(30_000);
      expect(Number(await scalar("SELECT COALESCE(sum(expired_amount),0) AS value FROM rollover_ledger WHERE tenant_id=$1 AND usage_unit='INTERACTION'", [t]))).toBe(0);
      expect(Number(await scalar("SELECT COALESCE(sum(generated_amount-consumed_amount-expired_amount),0) AS value FROM rollover_ledger WHERE tenant_id=$1 AND usage_unit='INTERACTION'", [t]))).toBe(90_000);
      expect(Number(await scalar("SELECT count(*) AS value FROM subscription_events WHERE tenant_id=$1 AND event_type='ROLLOVER_ADJUSTED_BY_ROOT'", [t]))).toBe(1);
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  });

  it("sem período aberto: não trunca (sem unidade âncora, remover destruiria saldo na unidade errada)", async () => {
    const t = await tenant("noopen"), p = await plan({ credits: 40_000 });
    await subscribe(t, p);
    const p1 = await period(t);
    await pool.query("INSERT INTO rollover_ledger(tenant_id,usage_period_id,rollover_rate_bps,generated_amount,consumed_amount,expired_amount,usage_unit,expires_at) VALUES($1,$2,10000,10000,0,0,'CREDIT',now()+interval '60 days')", [t, p1.id]);
    await pool.query("UPDATE usage_periods SET status='CLOSED' WHERE id=$1", [p1.id]); // nenhuma OPEN
    const np = await plan({ credits: 1_000 });
    await pool.query("UPDATE plans SET rollover_max_percentage_bps=5000 WHERE id=$1", [np]); // teto = 500
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const r = await truncateRolloverToPlanCap(c, t, np);
      await c.query("COMMIT");
      expect(r.removed).toBe(0);
      expect(Number(await scalar("SELECT COALESCE(sum(expired_amount),0) AS value FROM rollover_ledger WHERE tenant_id=$1", [t]))).toBe(0);
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  });
});

describe("previewRollover (isolamento de unidade)", () => {
  it("saldo ancorado no período aberto: CREDIT entra, rollover legado de INTERACTION fica fora", async () => {
    const t = await tenant("preview"), p = await plan({ credits: 40_000 });
    await subscribe(t, p);
    const p1 = await period(t);
    await pool.query("INSERT INTO rollover_ledger(tenant_id,usage_period_id,rollover_rate_bps,generated_amount,consumed_amount,expired_amount,usage_unit,expires_at) VALUES($1,$2,10000,30000,0,0,'CREDIT',now()+interval '60 days')", [t, p1.id]);
    // Linha histórica de INTERAÇÃO no mesmo tenant: não pode virar "saldo" de crédito.
    await pool.query("INSERT INTO rollover_ledger(tenant_id,usage_period_id,rollover_rate_bps,generated_amount,consumed_amount,expired_amount,usage_unit,expires_at) VALUES($1,$2,10000,90000,0,0,'INTERACTION',now()+interval '60 days')", [t, p1.id]);
    expect((await openPeriodRow(t)).usage_unit).toBe("CREDIT");
    const c = await pool.connect();
    try {
      const r = await previewRollover(c, t);
      // 120_000 seria a soma mista (bug): 30_000 créditos + 90_000 interações.
      expect(r.currentBalance).toBe(30_000);
    } finally { c.release(); }
  });

  it("sem período aberto: saldo 0 (sem unidade âncora, a soma mista não tem significado)", async () => {
    const t = await tenant("preview-noopen"), p = await plan({ credits: 40_000 });
    await subscribe(t, p);
    const p1 = await period(t);
    await pool.query("INSERT INTO rollover_ledger(tenant_id,usage_period_id,rollover_rate_bps,generated_amount,consumed_amount,expired_amount,usage_unit,expires_at) VALUES($1,$2,10000,30000,0,0,'CREDIT',now()+interval '60 days')", [t, p1.id]);
    await pool.query("UPDATE usage_periods SET status='CLOSED' WHERE id=$1", [p1.id]); // nenhuma OPEN
    const c = await pool.connect();
    try {
      expect((await previewRollover(c, t)).currentBalance).toBe(0);
    } finally { c.release(); }
  });
});
