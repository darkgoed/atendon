import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { consumeAiInteraction, grantAiCreditPackage, reconcileAiInteraction, reconcileAiTurnFromUsageLogs, releaseAiInteractionWithoutUsage } from "../src/billing/ai-consumption.js";
import { ensureOpenPeriod } from "../src/billing/usage-period.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const tenants: string[] = [];
const plans: string[] = [];

async function tenant(label: string): Promise<string> {
  const slug = `billing-credits-${label}-${randomUUID()}`;
  const r = await pool.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [slug, slug]);
  tenants.push(r.rows[0].id); return r.rows[0].id;
}
async function plan(opts: { interactions?: number | null; credits?: number | null }): Promise<string> {
  const code = `BILLING_CREDITS_${randomUUID()}`;
  const r = await pool.query<{ id: string }>("INSERT INTO plans(code,name,billing_period_months,monthly_price_cents,ai_enabled) VALUES($1,$2,1,0,true) RETURNING id", [code, code]);
  plans.push(r.rows[0].id);
  if (opts.interactions !== undefined) await pool.query("INSERT INTO plan_limits(plan_id,limit_key,limit_value) VALUES($1,'MAX_AI_INTERACTIONS',$2)", [r.rows[0].id, opts.interactions]);
  if (opts.credits !== undefined) await pool.query("INSERT INTO plan_limits(plan_id,limit_key,limit_value) VALUES($1,'MAX_AI_CREDITS',$2)", [r.rows[0].id, opts.credits]);
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

afterAll(async () => {
  if (tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenants]);
  if (plans.length) await pool.query("DELETE FROM plans WHERE id=ANY($1::uuid[])", [plans]);
  await pool.query("DELETE FROM ai_model_prices WHERE model IN ('test-credit-model','test-multi-a','test-multi-b','test-spill-model','test-free-model')");
  await pool.end();
});

describe("créditos normalizados de IA (tokens equivalentes por custo)", () => {
  it("migração: BASIC com IA habilitada e MAX_AI_CREDITS semeado por plano", async () => {
    expect(await scalar<boolean>("SELECT ai_enabled AS value FROM plans WHERE code='BASIC'")).toBe(true);
    expect(Number(await scalar("SELECT limit_value AS value FROM plan_limits pl JOIN plans p ON p.id=pl.plan_id WHERE p.code='BASIC' AND pl.limit_key='MAX_AI_CREDITS'"))).toBe(1_000_000);
    expect(Number(await scalar("SELECT limit_value AS value FROM plan_limits pl JOIN plans p ON p.id=pl.plan_id WHERE p.code='MEDIUM' AND pl.limit_key='MAX_AI_CREDITS'"))).toBeGreaterThan(1_000_000);
  });

  it("período novo nasce CREDIT quando o plano define MAX_AI_CREDITS; legado fica INTERACTION", async () => {
    const t = await tenant("unit"), p = await plan({ credits: 40_000 }); await subscribe(t, p);
    const u = await period(t);
    expect(u.usage_unit).toBe("CREDIT");
    expect(Number(u.included_limit)).toBe(40_000);
    const legacy = await tenant("legacy"), lp = await plan({ interactions: 2 }); await subscribe(legacy, lp);
    const lu = await period(legacy);
    expect(lu.usage_unit).toBe("INTERACTION");
  });

  it("reserva créditos estimados, é idempotente e aplica teto duro com reserva em voo", async () => {
    const t = await tenant("ceiling"), p = await plan({ credits: 40_000 }); await subscribe(t, p); await period(t);
    const first = await consumeAiInteraction(t, "inbound_reply", "c1");
    expect(first).toMatchObject({ allowed: true, consumptionType: "INCLUDED" });
    expect(first.estimatedCredits).toBeGreaterThan(0);
    expect(Number(await scalar("SELECT included_usage AS value FROM usage_periods WHERE tenant_id=$1", [t]))).toBe(first.estimatedCredits);
    expect(Number(await scalar("SELECT reserved_credits AS value FROM usage_periods WHERE tenant_id=$1", [t]))).toBe(first.estimatedCredits);
    const again = await consumeAiInteraction(t, "inbound_reply", "c1");
    expect(again.ledgerId).toBe(first.ledgerId);
    const second = await consumeAiInteraction(t, "inbound_reply", "c2");
    expect(second).toMatchObject({ allowed: false, reason: "QUOTA_EXCEEDED" });
  });

  it("reconcilia pelo custo real via usage_logs e corrige contadores", async () => {
    const t = await tenant("reconcile"), p = await plan({ credits: 100_000 }); await subscribe(t, p); await period(t);
    const turnId = randomUUID();
    const reservation = await consumeAiInteraction(t, "inbound_reply", turnId, {});
    expect(reservation.allowed).toBe(true);
    // Custo real informado pelo provedor no usage_log: $0.0018 = 1800 micros
    // (custo informado vence a precificação por tabela — contrato §usage_logs).
    await pool.query("INSERT INTO usage_logs(tenant_id,ai_model,input_tokens,output_tokens,reasoning_tokens,cached_input_tokens,cost_usd,request_id) VALUES($1,'test-credit-model',1000,500,100,200,0.0018,$2)", [t, turnId]);
    await reconcileAiTurnFromUsageLogs(t, "inbound_reply", turnId);
    const ledger = await pool.query("SELECT normalized_credits,input_tokens,output_tokens,cached_tokens,model,reconciled FROM ai_usage_ledger WHERE tenant_id=$1", [t]);
    expect(ledger.rows[0]).toMatchObject({ normalized_credits: "3000", input_tokens: "1000", output_tokens: "500", cached_tokens: "200", model: "test-credit-model", reconciled: true });
    const u = await pool.query("SELECT included_usage,reserved_credits,provider_cost_usd_micros FROM usage_periods WHERE tenant_id=$1", [t]);
    expect(u.rows[0]).toMatchObject({ included_usage: "3000", reserved_credits: "0" });
    expect(Number(u.rows[0].provider_cost_usd_micros)).toBe(1800);
    // Reconciliação repetida não duplica.
    await reconcileAiTurnFromUsageLogs(t, "inbound_reply", turnId);
    expect(await scalar("SELECT included_usage AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe("3000");
  });

  it("custo ausente: tokens x precificação configurada (input/output/cache) vira créditos", async () => {
    const t = await tenant("tokenprice"), p = await plan({ credits: 100_000 }); await subscribe(t, p); await period(t);
    await pool.query("INSERT INTO ai_model_prices(model,input_price_per_million_micros,output_price_per_million_micros,cached_input_price_per_million_micros) VALUES('test-credit-model',600000,2400000,150000)");
    const turnId = randomUUID();
    await consumeAiInteraction(t, "inbound_reply", turnId);
    // Sem providerCostUsd: 800 fresh×600k + 200 cache×150k + 500 out×2.4M = 1710 micros
    // → créditos = ceil(1710×1e6/600000) = 2850 (reasoning vem dentro do output).
    await reconcileAiInteraction(t, "inbound_reply", turnId, { model: "test-credit-model", inputTokens: 1000, outputTokens: 500, cachedTokens: 200 });
    const ledger = await pool.query("SELECT normalized_credits,provider_cost_usd_micros,billable_amount_brl_cents FROM ai_usage_ledger WHERE tenant_id=$1", [t]);
    expect(ledger.rows[0]).toMatchObject({ normalized_credits: "2850", provider_cost_usd_micros: "1710" });
    expect(Number(ledger.rows[0].billable_amount_brl_cents)).toBeGreaterThan(0);
    expect(await scalar("SELECT included_usage AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe("2850");
  });

  it("mesmo modelo, providers distintos: créditos vêm do preço do provider REAL gravado em usage_logs", async () => {
    const t = await tenant("byprovider"), p = await plan({ credits: 10_000_000 }); await subscribe(t, p); await period(t);
    const model = `prov-model-${randomUUID()}`;
    await pool.query(
      `INSERT INTO ai_model_prices(model,provider,input_price_per_million_micros,output_price_per_million_micros)
       VALUES($1,NULL,600000,0),($1,'cheapco',60000,0),($1,'premiumco',6000000,0)`, [model]);
    try {
      const credits: Record<string, number> = {};
      for (const provider of ["cheapco", "premiumco", null]) {
        const turnId = randomUUID();
        await consumeAiInteraction(t, "inbound_reply", turnId);
        // Custo NÃO reportado (cost_reported=false) → tabela por (provider, model).
        await pool.query(
          "INSERT INTO usage_logs(tenant_id,ai_model,provider,input_tokens,output_tokens,cost_usd,cost_reported,request_id) VALUES($1,$2,$3,10000,0,0,false,$4)",
          [t, model, provider, turnId]);
        await reconcileAiTurnFromUsageLogs(t, "inbound_reply", turnId);
        credits[provider ?? "legacy"] = Number(await scalar("SELECT normalized_credits AS value FROM ai_usage_ledger WHERE tenant_id=$1 AND logical_turn_id=$2::uuid", [t, turnId]));
      }
      // 10k tokens: cheapco $0.06/M=600 micros→1000 cr; premiumco $6/M→100000 cr; legado (sem provider) → genérico $0.60/M → 10000 cr.
      expect(credits).toEqual({ cheapco: 1000, premiumco: 100_000, legacy: 10_000 });
    } finally {
      await pool.query("DELETE FROM ai_model_prices WHERE model=$1", [model]);
    }
  });

  it("modelo sem preço e sem custo informado não tem bypass grátis (fallback referência)", async () => {
    const t = await tenant("nobypass"), p = await plan({ credits: 100_000 }); await subscribe(t, p); await period(t);
    const turnId = randomUUID();
    await consumeAiInteraction(t, "inbound_reply", turnId);
    // Sem preço na tabela e sem custo: 3000 tokens ao preço de referência
    // ($0.60/M = 1800 micros) → 3000 créditos, nunca 0.
    await reconcileAiInteraction(t, "inbound_reply", turnId, { model: "unknown-credit-model", inputTokens: 2000, outputTokens: 1000, cachedTokens: 0 });
    const ledger = await pool.query("SELECT normalized_credits,billable_amount_brl_cents,pricing_snapshot FROM ai_usage_ledger WHERE tenant_id=$1", [t]);
    expect(Number(ledger.rows[0].normalized_credits)).toBe(3000);
    expect(Number(ledger.rows[0].billable_amount_brl_cents)).toBeGreaterThan(0);
    expect((ledger.rows[0].pricing_snapshot as Record<string, unknown>).fallback).toBe("unknown_model_reference_price");
  });

  it("libera reserva sem usage_logs e recusa liberação quando o provedor cobrou", async () => {
    const t = await tenant("release"), p = await plan({ credits: 100_000 }); await subscribe(t, p); await period(t);
    const turnId = randomUUID();
    await consumeAiInteraction(t, "inbound_reply", turnId);
    // Sem usage_logs: devolve contadores integralmente.
    await releaseAiInteractionWithoutUsage(t, "inbound_reply", turnId);
    expect(await scalar("SELECT included_usage AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe("0");
    expect(await scalar("SELECT reserved_credits AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe("0");
    // Com usage_logs (provedor cobrou): liberação é recusada; reconciliação assume.
    const turn2 = randomUUID();
    await consumeAiInteraction(t, "inbound_reply", turn2);
    await pool.query("INSERT INTO usage_logs(tenant_id,ai_model,input_tokens,output_tokens,cost_usd,request_id) VALUES($1,'test-credit-model',1000,100,0.00084,$2)", [t, turn2]);
    await releaseAiInteractionWithoutUsage(t, "inbound_reply", turn2);
    expect(await scalar("SELECT reconciled::int::text AS value FROM ai_usage_ledger WHERE tenant_id=$1 AND logical_turn_id=$2", [t, turn2])).toBe("0");
    await reconcileAiTurnFromUsageLogs(t, "inbound_reply", turn2);
    // in=1000@0.6 + out=100@2.4 → 840 micros → 1400 créditos.
    expect(await scalar("SELECT included_usage AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe("1400");
  });

  it("período legado preserva a unidade interação (+1 por reserva)", async () => {
    const t = await tenant("legacy-unit"), p = await plan({ interactions: 2 }); await subscribe(t, p); await period(t);
    const c = await consumeAiInteraction(t, "inbound_reply", "l1");
    expect(c).toMatchObject({ allowed: true, consumptionType: "INCLUDED" });
    expect(c.estimatedCredits).toBeUndefined();
    expect(await scalar("SELECT included_usage AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe("1");
  });

  it("pacote de créditos: grant CREDIT_PACKAGE entra antes do incluído e é idempotente", async () => {
    const t = await tenant("package"), p = await plan({ credits: 40_000 }); await subscribe(t, p); await period(t);
    const key = `pkg-${randomUUID()}`;
    const grant = await grantAiCreditPackage({ tenantId: t, credits: 50_000_000, reason: "pacote 50M", idempotencyKey: key });
    expect(grant).not.toBeNull();
    expect(await grantAiCreditPackage({ tenantId: t, credits: 50_000_000, reason: "pacote 50M", idempotencyKey: key })).toBeNull();
    expect(Number(await scalar("SELECT bonus_granted AS value FROM usage_periods WHERE tenant_id=$1", [t]))).toBe(50_000_000);
    const c = await consumeAiInteraction(t, "inbound_reply", "p1");
    expect(c).toMatchObject({ allowed: true, consumptionType: "BONUS" });
    expect(Number(await scalar("SELECT consumed_amount AS value FROM usage_grants WHERE tenant_id=$1 AND kind='CREDIT_PACKAGE'", [t]))).toBe(c.estimatedCredits);
    // Período legado de interação: pacote fica retido, sem inflar bonus_granted.
    const legacy = await tenant("package-legacy"), lp = await plan({ interactions: 5 }); await subscribe(legacy, lp); await period(legacy);
    await grantAiCreditPackage({ tenantId: legacy, credits: 50_000_000, reason: "pacote", idempotencyKey: `pkg-${randomUUID()}` });
    expect(await scalar("SELECT bonus_granted AS value FROM usage_periods WHERE tenant_id=$1", [legacy])).toBe("0");
  });

  it("teto: limit=1 recusa a reserva (25k > 1) sem ledger nem contadores", async () => {
    const t = await tenant("hard-cap-1"), p = await plan({ credits: 1 }); await subscribe(t, p); await period(t);
    const r = await consumeAiInteraction(t, "inbound_reply", "cap1");
    expect(r).toMatchObject({ allowed: false, reason: "QUOTA_EXCEEDED" });
    expect(await scalar("SELECT count(*)::int AS value FROM ai_usage_ledger WHERE tenant_id=$1", [t])).toBe(0);
    expect(await scalar("SELECT included_usage + reserved_credits AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe("0");
  });

  it("teto: limit=100k aceita reservas até esgotar exato e recusa a excedente", async () => {
    const t = await tenant("hard-cap-100k"), p = await plan({ credits: 100_000 }); await subscribe(t, p); await period(t);
    const first = await consumeAiInteraction(t, "inbound_reply", "cap100k-1");
    expect(first).toMatchObject({ allowed: true, consumptionType: "INCLUDED" });
    const e = first.estimatedCredits!;
    expect(e).toBeGreaterThan(0);
    const fits = Math.floor(100_000 / e);
    for (let i = 2; i <= fits; i++) expect(await consumeAiInteraction(t, "inbound_reply", `cap100k-${i}`)).toMatchObject({ allowed: true, consumptionType: "INCLUDED" });
    expect(await consumeAiInteraction(t, "inbound_reply", `cap100k-${fits + 1}`)).toMatchObject({ allowed: false, reason: "QUOTA_EXCEEDED" });
    const u = await pool.query("SELECT included_usage,reserved_credits FROM usage_periods WHERE tenant_id=$1", [t]);
    expect(Number(u.rows[0].included_usage)).toBe(fits * e);
    expect(Number(u.rows[0].included_usage)).toBeLessThanOrEqual(100_000);
    expect(Number(u.rows[0].reserved_credits)).toBe(fits * e);
  });

  it("fonte com saldo < estimativa não é escolhida nem debitada (rollover e grant)", async () => {
    // Rollover com available=1 em modo crédito: não vira ROLLOVER nem debita 25k;
    // sobra room no incluído → INCLUDED.
    const t = await tenant("src-thin"), p = await plan({ credits: 40_000 }); await subscribe(t, p); const u = await period(t);
    await pool.query("INSERT INTO rollover_ledger(tenant_id,usage_period_id,rollover_rate_bps,generated_amount,usage_unit,expires_at) VALUES($1,$2,10000,1,'CREDIT',now()+interval '30 days')", [t, u.id]);
    const r = await consumeAiInteraction(t, "inbound_reply", "thin-r");
    expect(r).toMatchObject({ allowed: true, consumptionType: "INCLUDED" });
    expect(Number(await scalar("SELECT consumed_amount AS value FROM rollover_ledger WHERE tenant_id=$1", [t]))).toBe(0);
    // Grant BONUS com available=1 e incluído de 1 crédito: recusa sem debitar a fonte.
    const t2 = await tenant("grant-thin"), p2 = await plan({ credits: 1 }); await subscribe(t2, p2); const u2 = await period(t2);
    await pool.query("INSERT INTO usage_grants(tenant_id,usage_period_id,kind,amount,reason,usage_unit) VALUES($1,$2,'BONUS',1,'grant fino','CREDIT')", [t2, u2.id]);
    const refused = await consumeAiInteraction(t2, "inbound_reply", "thin-g1");
    expect(refused).toMatchObject({ allowed: false, reason: "QUOTA_EXCEEDED" });
    expect(refused.consumptionType).toBeUndefined();
    expect(Number(await scalar("SELECT consumed_amount AS value FROM usage_grants WHERE tenant_id=$1 AND kind='BONUS'", [t2]))).toBe(0);
    expect(await scalar("SELECT included_usage + reserved_credits AS value FROM usage_periods WHERE tenant_id=$1", [t2])).toBe("0");
  });

  it("turno com 2 modelos e custo omitido pela API: cada chamada pelo preço do SEU modelo, reasoning incluso no output", async () => {
    const t = await tenant("multi"), p = await plan({ credits: 100_000 }); await subscribe(t, p); await period(t);
    await pool.query("INSERT INTO ai_model_prices(model,input_price_per_million_micros,output_price_per_million_micros,cached_input_price_per_million_micros) VALUES('test-multi-a',600000,1200000,300000),('test-multi-b',1200000,2400000,600000)");
    const turnId = randomUUID();
    await consumeAiInteraction(t, "inbound_reply", turnId);
    // Chamada A: in 1000 (200 cache read + 100 cache write → 700 fresh), out 500
    //   (reasoning 100 já incluso no output) → 700×0.6 + 200×0.3 + 100×0.6 + 500×1.2
    //   = 1140 micros → 1900 créditos.
    // Chamada B: in 2000 fresh, out 1000 → 2000×1.2 + 1000×2.4 = 4800 micros → 8000 créditos.
    // cost_usd=0 com cost_reported=false (API omitiu o custo) NÃO é dado real:
    // precificação por tabela, nunca grátis.
    await pool.query(
      `INSERT INTO usage_logs(tenant_id,ai_model,input_tokens,output_tokens,reasoning_tokens,cached_input_tokens,cache_write_input_tokens,cost_usd,cost_reported,request_id) VALUES
         ($1,'test-multi-a',1000,500,100,200,100,0,FALSE,$2),
         ($1,'test-multi-b',2000,1000,0,0,0,0,FALSE,$2)`, [t, turnId],
    );
    await reconcileAiTurnFromUsageLogs(t, "inbound_reply", turnId);
    const ledger = await pool.query("SELECT normalized_credits,provider_cost_usd_micros,provider_cost_brl_cents,billable_amount_brl_cents,model,pricing_snapshot,reconciled FROM ai_usage_ledger WHERE tenant_id=$1", [t]);
    // Custo agregado do turno = soma de TODAS as chamadas precificadas,
    // inclusive as estimadas pela tabela: 1140 + 4800 = 5940 (zero aqui
    // desacoplaria ledger/usage_periods dos 9900 créditos debitados).
    expect(ledger.rows[0]).toMatchObject({ normalized_credits: "9900", provider_cost_usd_micros: "5940", model: "test-multi-b", reconciled: true });
    const models = (ledger.rows[0].pricing_snapshot as { models?: Array<Record<string, unknown>> }).models;
    expect(models?.map((m) => m.model)).toEqual(["test-multi-a", "test-multi-b"]);
    const a = models?.find((m) => m.model === "test-multi-a");
    expect(Number(a?.normalizedCredits)).toBe(1900); // reasoning NÃO somado separado: 1900, não 2020
    expect(Number(a?.providerCostUsdMicros)).toBe(1140);
    const b = models?.find((m) => m.model === "test-multi-b");
    expect(Number(b?.normalizedCredits)).toBe(8000);
    expect(Number(b?.providerCostUsdMicros)).toBe(4800);
    // BRL do turno = soma exata do BRL por modelo (mesma taxa, por chamada).
    expect(Number(ledger.rows[0].provider_cost_brl_cents)).toBe(models!.reduce((s, m) => s + Number(m.providerCostBrlCents), 0));
    expect(Number(ledger.rows[0].provider_cost_brl_cents)).toBeGreaterThan(0);
    expect(Number(ledger.rows[0].billable_amount_brl_cents)).toBeGreaterThan(0);
    expect(await scalar("SELECT provider_cost_usd_micros AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe("5940");
    expect(await scalar("SELECT included_usage AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe("9900");
    expect(await scalar("SELECT reserved_credits AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe("0");
  });

  it("turno misto (custo reportado + omitido): custo agregado soma as duas chamadas", async () => {
    const t = await tenant("mixed"), p = await plan({ credits: 100_000 }); await subscribe(t, p); await period(t);
    const turnId = randomUUID();
    await consumeAiInteraction(t, "inbound_reply", turnId);
    // A: custo REPORTADO (0.001 → 1000 micros) vence a tabela.
    // B: custo omitido (cost_reported=false) → estimado pela tabela do test-multi-b (4800 micros).
    await pool.query(
      `INSERT INTO usage_logs(tenant_id,ai_model,input_tokens,output_tokens,reasoning_tokens,cached_input_tokens,cache_write_input_tokens,cost_usd,cost_reported,request_id) VALUES
         ($1,'test-multi-a',1000,500,0,0,0,0.001,TRUE,$2),
         ($1,'test-multi-b',2000,1000,0,0,0,0,FALSE,$2)`, [t, turnId],
    );
    await reconcileAiTurnFromUsageLogs(t, "inbound_reply", turnId);
    const ledger = await pool.query("SELECT normalized_credits,provider_cost_usd_micros,model,pricing_snapshot,reconciled FROM ai_usage_ledger WHERE tenant_id=$1", [t]);
    // Créditos: A = ceil(1000×1e6/600000) = 1667; B = 8000 → 9667.
    expect(ledger.rows[0]).toMatchObject({ normalized_credits: "9667", provider_cost_usd_micros: "5800", model: "test-multi-b", reconciled: true });
    const models = (ledger.rows[0].pricing_snapshot as { models?: Array<Record<string, unknown>> }).models;
    const a = models?.find((m) => m.model === "test-multi-a");
    const b = models?.find((m) => m.model === "test-multi-b");
    expect(Number(a?.providerCostUsdMicros)).toBe(1000);
    expect(Number(b?.providerCostUsdMicros)).toBe(4800);
    expect(await scalar("SELECT provider_cost_usd_micros AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe("5800");
    expect(await scalar("SELECT included_usage AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe("9667");
  });

  it("modelo gratuito explícito (0/0 na tabela) com custo omitido segue grátis", async () => {
    const t = await tenant("free"), p = await plan({ credits: 40_000 }); await subscribe(t, p); await period(t);
    await pool.query("INSERT INTO ai_model_prices(model,input_price_per_million_micros,output_price_per_million_micros,cached_input_price_per_million_micros) VALUES('test-free-model',0,0,0)");
    const turnId = randomUUID();
    await consumeAiInteraction(t, "inbound_reply", turnId);
    // Custo omitido (cost_reported=false): 0/0 na tabela segue grátis.
    await pool.query("INSERT INTO usage_logs(tenant_id,ai_model,input_tokens,output_tokens,cached_input_tokens,cache_write_input_tokens,cost_usd,cost_reported,request_id) VALUES($1,'test-free-model',1000,500,200,100,0,FALSE,$2)", [t, turnId]);
    await reconcileAiTurnFromUsageLogs(t, "inbound_reply", turnId);
    const ledger = await pool.query("SELECT normalized_credits,billable_amount_brl_cents,provider_cost_usd_micros,reconciled FROM ai_usage_ledger WHERE tenant_id=$1", [t]);
    expect(ledger.rows[0]).toMatchObject({ normalized_credits: "0", provider_cost_usd_micros: "0", reconciled: true });
    expect(Number(ledger.rows[0].billable_amount_brl_cents)).toBe(0);
    expect(await scalar("SELECT included_usage AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe("0");
    expect(await scalar("SELECT reserved_credits AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe("0");
  });

  it("FASE B: custo estimado por CHAMADA persiste em usage_logs.priced_cost_usd_micros na transação do ledger; chamada reportada permanece raw", async () => {
    const t = await tenant("per-call"), p = await plan({ credits: 100_000 }); await subscribe(t, p); await period(t);
    await pool.query("DELETE FROM ai_model_prices WHERE model='test-multi-a'");
    await pool.query("INSERT INTO ai_model_prices(model,input_price_per_million_micros,output_price_per_million_micros,cached_input_price_per_million_micros) VALUES('test-multi-a',600000,1200000,300000)");
    const turnId = randomUUID();
    await consumeAiInteraction(t, "inbound_reply", turnId);
    // Mesmo modelo, 2 chamadas no MESMO turno: A com custo REPORTADO
    // ($0.001 = 1000 micros), B com custo omitido (cost_reported=false) →
    // estimado pela tabela (2000×0.6 + 1000×1.2 = 2400 micros).
    await pool.query(
      `INSERT INTO usage_logs(tenant_id,ai_model,input_tokens,output_tokens,cached_input_tokens,cost_usd,cost_reported,request_id) VALUES
         ($1,'test-multi-a',1000,500,0,0.001,TRUE,$2),
         ($1,'test-multi-a',2000,1000,0,0,FALSE,$2)`, [t, turnId],
    );
    await reconcileAiTurnFromUsageLogs(t, "inbound_reply", turnId);
    // Ledger soma as duas chamadas: 1000 + 2400 = 3400 micros; créditos
    // ceil(1000/0.6) + ceil(2400/0.6) = 1667 + 4000 = 5667.
    expect(await scalar("SELECT provider_cost_usd_micros AS value FROM ai_usage_ledger WHERE tenant_id=$1", [t])).toBe("3400");
    expect(await scalar("SELECT normalized_credits AS value FROM ai_usage_ledger WHERE tenant_id=$1", [t])).toBe("5667");
    expect(await scalar("SELECT included_usage AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe("5667");
    // Por chamada: só a omitida ganha priced_cost_usd_micros; a reportada
    // mantém cost_usd raw e priced_cost NULL (estimativa nunca sobrepõe real).
    const logs = await pool.query<{ input_tokens: string; cost_usd: string; priced_cost_usd_micros: string | null }>(
      "SELECT input_tokens,cost_usd,priced_cost_usd_micros FROM usage_logs WHERE tenant_id=$1 AND request_id=$2 ORDER BY input_tokens", [t, turnId]);
    expect(logs.rows).toHaveLength(2);
    expect(Number(logs.rows[0].input_tokens)).toBe(1000);
    expect(Number(logs.rows[0].cost_usd)).toBe(0.001);
    expect(logs.rows[0].priced_cost_usd_micros).toBeNull();
    expect(Number(logs.rows[1].input_tokens)).toBe(2000);
    expect(Number(logs.rows[1].cost_usd)).toBe(0);
    expect(logs.rows[1].priced_cost_usd_micros).toBe("2400");
    // Idempotente: reconciliação repetida não reescreve nem duplica.
    await reconcileAiTurnFromUsageLogs(t, "inbound_reply", turnId);
    expect(await scalar("SELECT provider_cost_usd_micros AS value FROM ai_usage_ledger WHERE tenant_id=$1", [t])).toBe("3400");
    expect(await scalar("SELECT included_usage AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe("5667");
    expect(await scalar("SELECT priced_cost_usd_micros AS value FROM usage_logs WHERE tenant_id=$1 AND input_tokens=2000 AND request_id=$2", [t, turnId])).toBe("2400");
  });

  it("provenance real (usage_logs→reconciliação): custo omitido precifica pela tabela; zero REPORTADO (default true) permanece zero", async () => {
    const t = await tenant("provenance"), p = await plan({ credits: 100_000 }); await subscribe(t, p); await period(t);
    await pool.query("INSERT INTO ai_model_prices(model,input_price_per_million_micros,output_price_per_million_micros) VALUES('test-spill-model',600000,600000)");
    const omitted = randomUUID(), reportedZero = randomUUID();
    await consumeAiInteraction(t, "inbound_reply", omitted);
    await consumeAiInteraction(t, "inbound_reply", reportedZero);
    // Seam real do onUsage: a API omitiu o custo → cost_usd 0 + cost_reported=false.
    await pool.query("INSERT INTO usage_logs(tenant_id,ai_model,input_tokens,output_tokens,cost_usd,cost_reported,request_id) VALUES($1,'test-spill-model',1000,500,0,FALSE,$2)", [t, omitted]);
    // Zero REPORTADO: linha gravada SEM cost_reported → DEFAULT TRUE (custo real zero).
    await pool.query("INSERT INTO usage_logs(tenant_id,ai_model,input_tokens,output_tokens,cost_usd,request_id) VALUES($1,'test-spill-model',1000,500,0,$2)", [t, reportedZero]);
    await reconcileAiTurnFromUsageLogs(t, "inbound_reply", omitted);
    await reconcileAiTurnFromUsageLogs(t, "inbound_reply", reportedZero);
    // Omitido: tabela 1000×0.6 + 500×0.6 = 900 micros → 1500 créditos (nunca grátis).
    expect(await scalar("SELECT normalized_credits AS value FROM ai_usage_ledger WHERE tenant_id=$1 AND logical_turn_id=$2", [t, omitted])).toBe("1500");
    expect(await scalar("SELECT provider_cost_usd_micros AS value FROM ai_usage_ledger WHERE tenant_id=$1 AND logical_turn_id=$2", [t, omitted])).toBe("900");
    // Zero reportado é custo REAL zero: 0 créditos, sem cobrança inventada.
    const zero = await pool.query<{ normalized_credits: string; provider_cost_usd_micros: string; reconciled: boolean }>(
      "SELECT normalized_credits,provider_cost_usd_micros,reconciled FROM ai_usage_ledger WHERE tenant_id=$1 AND logical_turn_id=$2", [t, reportedZero]);
    expect(zero.rows[0]).toMatchObject({ normalized_credits: "0", provider_cost_usd_micros: "0", reconciled: true });
    // Duas reservas de 25000; reais 1500 e 0 → franquia devolve o resto e fica 1500.
    expect(await scalar("SELECT included_usage AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe("1500");
    expect(await scalar("SELECT reserved_credits AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe("0");
    expect(await scalar("SELECT provider_cost_usd_micros AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe("900");
  });

  it("spill com grant esgotado: excedente vai à franquia incluída e o grant nunca fica negativo", async () => {
    const t = await tenant("spill"), p = await plan({ credits: 100_000 }); await subscribe(t, p); await period(t);
    await pool.query("INSERT INTO ai_model_prices(model,input_price_per_million_micros,output_price_per_million_micros) VALUES('test-spill-model',600000,600000)");
    const turn1 = randomUUID(), turn2 = randomUUID();
    const first = await consumeAiInteraction(t, "inbound_reply", turn1);
    const e = first.estimatedCredits!;
    // Turno 1 (INCLUDED): real == estimativa → contadores ficam em e.
    await pool.query("INSERT INTO usage_logs(tenant_id,ai_model,input_tokens,output_tokens,cost_usd,cost_reported,request_id) VALUES($1,'test-spill-model',$2,0,0,FALSE,$3)", [t, e, turn1]);
    await reconcileAiTurnFromUsageLogs(t, "inbound_reply", turn1);
    expect(await scalar("SELECT included_usage AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe(String(e));
    // Turno 2 (ROLLOVER): grant cobre exatamente a estimativa da reserva.
    await pool.query("INSERT INTO rollover_ledger(tenant_id,usage_period_id,rollover_rate_bps,generated_amount,usage_unit,expires_at) VALUES($1,(SELECT id FROM usage_periods WHERE tenant_id=$1),10000,$2,'CREDIT',now()+interval '30 days')", [t, e]);
    // O CHECK ck_usage_periods_rollover_usage_bound exige rollover_usage <= rollover_granted:
    // produção sobe rollover_granted ao gerar o rollover; o teste espelha isso.
    await pool.query("UPDATE usage_periods SET rollover_granted=rollover_granted+$2 WHERE tenant_id=$1", [t, e]);
    const reservation = await consumeAiInteraction(t, "inbound_reply", turn2);
    expect(reservation).toMatchObject({ allowed: true, consumptionType: "ROLLOVER" });
    // Real = estimativa + 5000; grant já esgotado → spill de 5000 vai à franquia.
    await pool.query("INSERT INTO usage_logs(tenant_id,ai_model,input_tokens,output_tokens,cost_usd,cost_reported,request_id) VALUES($1,'test-spill-model',$2,0,0,FALSE,$3)", [t, e + 5000, turn2]);
    await reconcileAiTurnFromUsageLogs(t, "inbound_reply", turn2);
    expect(await scalar("SELECT consumed_amount AS value FROM rollover_ledger WHERE tenant_id=$1", [t])).toBe(String(e)); // nunca ultrapassa o saldo
    expect(await scalar("SELECT rollover_usage AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe(String(e));
    expect(await scalar("SELECT included_usage AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe(String(e + 5000));
    expect(await scalar("SELECT reserved_credits AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe("0");
    expect(await scalar("SELECT normalized_credits AS value FROM ai_usage_ledger WHERE tenant_id=$1 AND logical_turn_id=$2", [t, turn2])).toBe(String(e + 5000));
  });

  it("spill com grant E franquia esgotados: vira overage sujeito ao teto, com lastro no financial_ledger", async () => {
    const t = await tenant("spill-overage"), p = await plan({ credits: 100_000 }); await subscribe(t, p); await period(t);
    await pool.query("INSERT INTO ai_model_prices(model,input_price_per_million_micros,output_price_per_million_micros) VALUES('test-spill-model',600000,600000)");
    const turn1 = randomUUID(), turn2 = randomUUID();
    const first = await consumeAiInteraction(t, "inbound_reply", turn1);
    const e = first.estimatedCredits!;
    // Franquia agora exatamente cheia (incluído == limite) e teto de crédito alto.
    await pool.query("UPDATE usage_periods SET included_limit=$2 WHERE tenant_id=$1", [t, e]);
    await pool.query("INSERT INTO tenant_usage_credit_settings(tenant_id,enabled,limit_type,monthly_spending_limit_cents) VALUES($1,true,'FIXED',$2)", [t, 1_000_000_000]);
    await pool.query("INSERT INTO usage_logs(tenant_id,ai_model,input_tokens,output_tokens,cost_usd,cost_reported,request_id) VALUES($1,'test-spill-model',$2,0,0,FALSE,$3)", [t, e, turn1]);
    await reconcileAiTurnFromUsageLogs(t, "inbound_reply", turn1);
    await pool.query("INSERT INTO rollover_ledger(tenant_id,usage_period_id,rollover_rate_bps,generated_amount,usage_unit,expires_at) VALUES($1,(SELECT id FROM usage_periods WHERE tenant_id=$1),10000,$2,'CREDIT',now()+interval '30 days')", [t, e]);
    // O CHECK ck_usage_periods_rollover_usage_bound exige rollover_usage <= rollover_granted:
    // produção sobe rollover_granted ao gerar o rollover; o teste espelha isso.
    await pool.query("UPDATE usage_periods SET rollover_granted=rollover_granted+$2 WHERE tenant_id=$1", [t, e]);
    const reservation = await consumeAiInteraction(t, "inbound_reply", turn2);
    expect(reservation).toMatchObject({ allowed: true, consumptionType: "ROLLOVER" });
    await pool.query("INSERT INTO usage_logs(tenant_id,ai_model,input_tokens,output_tokens,cost_usd,cost_reported,request_id) VALUES($1,'test-spill-model',$2,0,0,FALSE,$3)", [t, e + 5000, turn2]);
    await reconcileAiTurnFromUsageLogs(t, "inbound_reply", turn2);
    const ledger = await pool.query("SELECT normalized_credits,billable_amount_brl_cents,id FROM ai_usage_ledger WHERE tenant_id=$1 AND logical_turn_id=$2", [t, turn2]);
    const billable = Number(ledger.rows[0].billable_amount_brl_cents);
    const total = e + 5000;
    const expectedCents = Math.ceil((5000 * billable) / total);
    expect(Number(await scalar("SELECT overage_usage AS value FROM usage_periods WHERE tenant_id=$1", [t]))).toBe(5000);
    expect(Number(await scalar("SELECT overage_amount_brl_cents AS value FROM usage_periods WHERE tenant_id=$1", [t]))).toBe(expectedCents);
    expect(Number(await scalar("SELECT included_usage AS value FROM usage_periods WHERE tenant_id=$1", [t]))).toBe(e);
    expect(await scalar("SELECT reserved_credits AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe("0");
    expect(await scalar("SELECT consumed_amount AS value FROM rollover_ledger WHERE tenant_id=$1", [t])).toBe(String(e));
    const fin = await pool.query("SELECT direction,amount_cents,source_event_id FROM financial_ledger WHERE tenant_id=$1", [t]);
    expect(fin.rows).toHaveLength(1);
    expect(fin.rows[0].direction).toBe("CREDIT");
    expect(Number(fin.rows[0].amount_cents)).toBe(expectedCents);
    expect(fin.rows[0].source_event_id).toBe(`ai-reservation-reconcile:${ledger.rows[0].id}`);
  });

  it("reconciliação ROLLOVER delta positivo: contador do período acompanha consumed_amount da fonte; spill parcial vai ao incluído", async () => {
    // A reserva creditou o ESTIMATE em rollover_usage E em consumed_amount; a
    // reconciliação corrigia só a fonte (grantDelta) — o contador do período
    // ficava preso no estimate e painel/alerts contavam errado. Aqui a fonte
    // cobre só parte do delta (2000 de 5000): fonte clampada, spill → incluído.
    const t = await tenant("roll-up"), p = await plan({ credits: 100_000 }); await subscribe(t, p); await period(t);
    await pool.query("INSERT INTO ai_model_prices(model,input_price_per_million_micros,output_price_per_million_micros) VALUES('test-spill-model',600000,600000)");
    const turn1 = randomUUID(), turn2 = randomUUID();
    const first = await consumeAiInteraction(t, "inbound_reply", turn1);
    const e = first.estimatedCredits!;
    // Turno 1 fica RESERVADO (não reconciliado): serve só para fixar e; nada
    // dos assertions abaixo depende de arredondamento de precificação.
    await pool.query("INSERT INTO rollover_ledger(tenant_id,usage_period_id,rollover_rate_bps,generated_amount,usage_unit,expires_at) VALUES($1,(SELECT id FROM usage_periods WHERE tenant_id=$1),10000,$2,'CREDIT',now()+interval '30 days')", [t, e + 2000]);
    // CHECK ck_usage_periods_rollover_usage_bound exige rollover_usage <= rollover_granted.
    await pool.query("UPDATE usage_periods SET rollover_granted=rollover_granted+$2 WHERE tenant_id=$1", [t, e + 2000]);
    const reservation = await consumeAiInteraction(t, "inbound_reply", turn2);
    expect(reservation).toMatchObject({ allowed: true, consumptionType: "ROLLOVER" });
    expect(reservation.estimatedCredits).toBe(e);
    // Costura in-memory (custo AUSENTE → tabela): independe da provenance de
    // usage_logs.cost_usd (0 = ambíguo até a migração cost_reported) —
    // 1 token = 1 crédito na tabela 600000/600000.
    await reconcileAiInteraction(t, "inbound_reply", turn2, { model: "test-spill-model", inputTokens: e + 5000, outputTokens: 0, cachedTokens: 0 });
    const real = Number(await scalar("SELECT normalized_credits AS value FROM ai_usage_ledger WHERE tenant_id=$1 AND logical_turn_id=$2", [t, turn2]));
    expect(real).toBeGreaterThan(e);
    // Fonte e contador EM PÉ DE IGUALDADE (antes do fix: contador = e, fonte = e+2000).
    expect(Number(await scalar("SELECT rollover_usage AS value FROM usage_periods WHERE tenant_id=$1", [t]))).toBe(e + 2000);
    expect(Number(await scalar("SELECT consumed_amount AS value FROM rollover_ledger WHERE tenant_id=$1", [t]))).toBe(e + 2000);
    // Spill preservado: o remanescente do delta real foi para a franquia incluída.
    expect(Number(await scalar("SELECT included_usage AS value FROM usage_periods WHERE tenant_id=$1", [t]))).toBe(e + (real - (e + 2000)));
    expect(Number(await scalar("SELECT overage_usage AS value FROM usage_periods WHERE tenant_id=$1", [t]))).toBe(0);
    // Fonte nunca negativa/acima do gerado; first segue reservado.
    expect(Number(await scalar("SELECT consumed_amount AS value FROM rollover_ledger WHERE tenant_id=$1", [t]))).toBeLessThanOrEqual(e + 2000);
    expect(Number(await scalar("SELECT reserved_credits AS value FROM usage_periods WHERE tenant_id=$1", [t]))).toBe(e);
  });

  it("reconciliação ROLLOVER delta negativo: contador e fonte liberam juntos e nunca ficam negativos", async () => {
    const t = await tenant("roll-down"), p = await plan({ credits: 100_000 }); await subscribe(t, p); await period(t);
    await pool.query("INSERT INTO ai_model_prices(model,input_price_per_million_micros,output_price_per_million_micros) VALUES('test-spill-model',600000,600000)");
    const turn1 = randomUUID(), turn2 = randomUUID();
    const e = (await consumeAiInteraction(t, "inbound_reply", turn1)).estimatedCredits!;
    await pool.query("INSERT INTO rollover_ledger(tenant_id,usage_period_id,rollover_rate_bps,generated_amount,usage_unit,expires_at) VALUES($1,(SELECT id FROM usage_periods WHERE tenant_id=$1),10000,$2,'CREDIT',now()+interval '30 days')", [t, e + 5000]);
    await pool.query("UPDATE usage_periods SET rollover_granted=rollover_granted+$2 WHERE tenant_id=$1", [t, e + 5000]);
    const reservation = await consumeAiInteraction(t, "inbound_reply", turn2);
    expect(reservation).toMatchObject({ allowed: true, consumptionType: "ROLLOVER" });
    // Real BEM abaixo da reserva: grantDelta negativo devolve fonte E contador.
    await reconcileAiInteraction(t, "inbound_reply", turn2, { model: "test-spill-model", inputTokens: e - 3000, outputTokens: 0, cachedTokens: 0 });
    const usage = await pool.query<{ rollover_usage: string }>("SELECT rollover_usage FROM usage_periods WHERE tenant_id=$1", [t]);
    const consumed = Number(await scalar("SELECT consumed_amount AS value FROM rollover_ledger WHERE tenant_id=$1", [t]));
    // IGUALDADE contador↔fonte é o invariant: ambos recebem o MESMO grantDelta.
    expect(Number(usage.rows[0].rollover_usage)).toBe(consumed);
    expect(consumed).toBeGreaterThanOrEqual(0);
    expect(Number(usage.rows[0].rollover_usage)).toBeGreaterThanOrEqual(0);
    expect(Number(await scalar("SELECT reserved_credits AS value FROM usage_periods WHERE tenant_id=$1", [t]))).toBe(e);
  });

  it("reconciliação BONUS: bonus_usage soma os consumed_amount dos grants (delta + e −)", async () => {
    const t = await tenant("bonus-sync"), p = await plan({ credits: 100_000 }); await subscribe(t, p); await period(t);
    await pool.query("INSERT INTO ai_model_prices(model,input_price_per_million_micros,output_price_per_million_micros) VALUES('test-spill-model',600000,600000)");
    const turn1 = randomUUID(), turn2 = randomUUID(), turn3 = randomUUID();
    const e = (await consumeAiInteraction(t, "inbound_reply", turn1)).estimatedCredits!;
    // Grant 1 cobre estimate+2000 (delta positivo parcial); grant 2 recebe o turno negativo.
    await pool.query("INSERT INTO usage_grants(tenant_id,usage_period_id,kind,amount,usage_unit,reason) VALUES($1,$2,'BONUS',$3,'CREDIT','g1'),($1,$2,'BONUS',$4,'CREDIT','g2')", [t, (await scalar<string>("SELECT id AS value FROM usage_periods WHERE tenant_id=$1", [t])), e + 2000, e + 5000]);
    await pool.query("UPDATE usage_periods SET bonus_granted=bonus_granted+$2 WHERE tenant_id=$1", [t, 2 * e + 7000]);
    const up = await consumeAiInteraction(t, "inbound_reply", turn2);
    expect(up).toMatchObject({ allowed: true, consumptionType: "BONUS" });
    // Costura in-memory (custo ausente → tabela): independe da provenance de cost_usd.
    await reconcileAiInteraction(t, "inbound_reply", turn2, { model: "test-spill-model", inputTokens: e + 5000, outputTokens: 0, cachedTokens: 0 });
    expect(Number(await scalar("SELECT bonus_usage AS value FROM usage_periods WHERE tenant_id=$1", [t]))).toBe(e + 2000);
    expect(Number(await scalar("SELECT consumed_amount AS value FROM usage_grants WHERE tenant_id=$1 AND reason='g1'", [t]))).toBe(e + 2000);
    // Grant 1 esgotado → turno 3 cai no grant 2; real abaixo da reserva libera os dois lados.
    const down = await consumeAiInteraction(t, "inbound_reply", turn3);
    expect(down).toMatchObject({ allowed: true, consumptionType: "BONUS" });
    await reconcileAiInteraction(t, "inbound_reply", turn3, { model: "test-spill-model", inputTokens: e - 3000, outputTokens: 0, cachedTokens: 0 });
    const usage = Number(await scalar("SELECT bonus_usage AS value FROM usage_periods WHERE tenant_id=$1", [t]));
    const consumed = Number(await scalar("SELECT COALESCE(SUM(consumed_amount),0) AS value FROM usage_grants WHERE tenant_id=$1 AND kind='BONUS'", [t]));
    expect(usage).toBe(consumed); // contador == soma das fontes, exato
    expect(usage).toBeGreaterThanOrEqual(0);
    expect(Number(await scalar("SELECT consumed_amount AS value FROM usage_grants WHERE tenant_id=$1 AND reason='g2'", [t]))).toBeGreaterThanOrEqual(0);
    expect(Number(await scalar("SELECT overage_usage AS value FROM usage_periods WHERE tenant_id=$1", [t]))).toBe(0);
  });

  it("reserva subestimada: delta positivo não ultrapassa included_limit e, sem settings, o excedente não vira overage", async () => {
    const t = await tenant("clamp"), p = await plan({ credits: 25_000 }); await subscribe(t, p); await period(t);
    await pool.query("INSERT INTO ai_model_prices(model,input_price_per_million_micros,output_price_per_million_micros) VALUES('test-spill-model',600000,600000)");
    const turnId = randomUUID();
    const reservation = await consumeAiInteraction(t, "inbound_reply", turnId);
    expect(reservation).toMatchObject({ allowed: true, consumptionType: "INCLUDED" });
    const e = reservation.estimatedCredits!;
    expect(e).toBeGreaterThan(0);
    // Cenário do bug: limite == estimativa da reserva (franquia exatamente
    // cheia) e consumo real = estimativa + 5000 — sem o clamp, included_usage
    // viraria e+5000, acima do limite.
    await pool.query("UPDATE usage_periods SET included_limit=$2 WHERE tenant_id=$1", [t, e]);
    await pool.query("INSERT INTO usage_logs(tenant_id,ai_model,input_tokens,output_tokens,cost_usd,cost_reported,request_id) VALUES($1,'test-spill-model',$2,0,0,FALSE,$3)", [t, e + 5000, turnId]);
    await reconcileAiTurnFromUsageLogs(t, "inbound_reply", turnId);
    const u = await pool.query("SELECT included_usage,included_limit,overage_usage,overage_amount_brl_cents,reserved_credits FROM usage_periods WHERE tenant_id=$1", [t]);
    expect(Number(u.rows[0].included_usage)).toBe(e);
    expect(Number(u.rows[0].included_usage)).toBeLessThanOrEqual(Number(u.rows[0].included_limit));
    // Sem tenant_usage_credit_settings (overage desativado): excedente não cobrado.
    expect(Number(u.rows[0].overage_usage)).toBe(0);
    expect(Number(u.rows[0].overage_amount_brl_cents)).toBe(0);
    expect(Number(u.rows[0].reserved_credits)).toBe(0);
    // Custo real (e+5000 créditos) preservado no ai_usage_ledger para auditoria.
    expect(await scalar("SELECT normalized_credits AS value FROM ai_usage_ledger WHERE tenant_id=$1 AND logical_turn_id=$2", [t, turnId])).toBe(String(e + 5000));
    expect(Number(await scalar("SELECT count(*)::int AS value FROM financial_ledger WHERE tenant_id=$1", [t]))).toBe(0);
  });

  it("teto FIXED com reserva == teto: reconciliação nunca cobra acima do cap; excedente fica uncharged e a reserva zera", async () => {
    // Cenário do bug: reserva de 1 centavo sob teto de 1 centavo; o custo real
    // reconciliado é ~60x maior. Sem clamp, overage_amount e o saldo do
    // financial_ledger iam a ~60 (acima do teto). O ledger de uso preserva o
    // custo real para auditoria; overage_usage reflete só a parcela cobrada.
    const t = await tenant("cap-fixed"), p = await plan({ credits: 1 }); await subscribe(t, p); await period(t);
    // Estimativa pinada em 1 centavo: média das últimas 3 linhas do tenant (estimateInteractionCents).
    for (let i = 0; i < 3; i++) await pool.query(
      "INSERT INTO ai_usage_ledger(tenant_id,usage_period_id,interaction_key,purpose,consumption_type,billable_amount_brl_cents,pricing_strategy,reconciled) VALUES($1,(SELECT id FROM usage_periods WHERE tenant_id=$1),$2,'inbound_reply','INCLUDED',1,'COST_PLUS_MARKUP',true)",
      [t, `seed-cap-${i}-${randomUUID()}`],
    );
    await pool.query("INSERT INTO tenant_usage_credit_settings(tenant_id,enabled,limit_type,monthly_spending_limit_cents) VALUES($1,true,'FIXED',1)", [t]);
    const turnId = randomUUID();
    const reservation = await consumeAiInteraction(t, "inbound_reply", turnId);
    expect(reservation).toMatchObject({ allowed: true, consumptionType: "OVERAGE" });
    expect(reservation.estimatedCents).toBe(1);
    expect(await scalar("SELECT reserved_cents AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe("1");
    await reconcileAiInteraction(t, "inbound_reply", turnId, { model: null, inputTokens: 0, outputTokens: 0, cachedTokens: 0, providerCostUsd: 1 });
    const u = await pool.query("SELECT overage_usage,overage_amount_brl_cents,reserved_cents,reserved_credits FROM usage_periods WHERE tenant_id=$1", [t]);
    expect(Number(u.rows[0].overage_amount_brl_cents)).toBeLessThanOrEqual(1);
    expect(Number(u.rows[0].overage_amount_brl_cents)).toBe(1);
    expect(Number(u.rows[0].reserved_cents)).toBe(0);
    expect(Number(u.rows[0].reserved_credits)).toBe(0);
    // Lastro: soma assinada do financial_ledger == chargeable (1), não o custo real.
    const fin = await pool.query("SELECT direction,amount_cents FROM financial_ledger WHERE tenant_id=$1 ORDER BY created_at,id", [t]);
    const sum = fin.rows.reduce((s, row) => s + (row.direction === "CREDIT" ? Number(row.amount_cents) : -Number(row.amount_cents)), 0);
    expect(sum).toBe(Number(u.rows[0].overage_amount_brl_cents));
    // Custo real preservado no ai_usage_ledger; overage_usage = créditos da parcela cobrada.
    const ledger = await pool.query("SELECT billable_amount_brl_cents,normalized_credits FROM ai_usage_ledger WHERE tenant_id=$1 AND logical_turn_id=$2", [t, turnId]);
    const billed = Number(ledger.rows[0].billable_amount_brl_cents);
    expect(billed).toBeGreaterThan(1);
    expect(Number(u.rows[0].overage_usage)).toBe(Math.floor((1 * Number(ledger.rows[0].normalized_credits)) / billed));
    // Segunda reconciliação: nenhum lançamento novo, contadores estáveis.
    await reconcileAiInteraction(t, "inbound_reply", turnId, { model: null, inputTokens: 0, outputTokens: 0, cachedTokens: 0, providerCostUsd: 1 });
    expect(Number(await scalar("SELECT count(*)::int AS value FROM financial_ledger WHERE tenant_id=$1", [t]))).toBe(fin.rows.length);
    expect(await scalar("SELECT overage_amount_brl_cents AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe(String(Number(u.rows[0].overage_amount_brl_cents)));
  });

  it("UNLIMITED confirmado: reconciliação cobra o valor integral (overage_amount == custo real)", async () => {
    const t = await tenant("cap-unlimited"), p = await plan({ credits: 1 }); await subscribe(t, p); await period(t);
    await pool.query("INSERT INTO tenant_usage_credit_settings(tenant_id,enabled,limit_type,confirmed_unlimited_at) VALUES($1,true,'UNLIMITED',now())", [t]);
    const turnId = randomUUID();
    const reservation = await consumeAiInteraction(t, "inbound_reply", turnId);
    expect(reservation).toMatchObject({ allowed: true, consumptionType: "OVERAGE" });
    await reconcileAiInteraction(t, "inbound_reply", turnId, { model: null, inputTokens: 0, outputTokens: 0, cachedTokens: 0, providerCostUsd: 1 });
    const ledger = await pool.query("SELECT billable_amount_brl_cents,normalized_credits FROM ai_usage_ledger WHERE tenant_id=$1 AND logical_turn_id=$2", [t, turnId]);
    const billed = Number(ledger.rows[0].billable_amount_brl_cents);
    expect(billed).toBeGreaterThan(0);
    expect(await scalar("SELECT overage_amount_brl_cents AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe(String(billed));
    expect(await scalar("SELECT overage_usage AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe(String(Number(ledger.rows[0].normalized_credits)));
    expect(await scalar("SELECT reserved_cents + reserved_credits AS value FROM usage_periods WHERE tenant_id=$1", [t])).toBe("0");
    const fin = await pool.query("SELECT direction,amount_cents FROM financial_ledger WHERE tenant_id=$1", [t]);
    const sum = fin.rows.reduce((s, row) => s + (row.direction === "CREDIT" ? Number(row.amount_cents) : -Number(row.amount_cents)), 0);
    expect(sum).toBe(billed);
  });
});
