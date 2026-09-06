/**
 * PROBE INDEPENDENTE DO ORQUESTRADOR — não usa os testes escritos pelos agentes.
 * Reproduz B1 e B3 direto contra o banco de teste e imprime JSON com o veredito.
 *
 * Uso:
 *   cd apps/backend && unset DATABASE_URL TEST_DATABASE_URL NODE_ENV \
 *     && npx tsx ../../scripts/verify-blockers.ts
 *
 * Objetivo: se a correção dos agentes for real, B1 e B3 têm que dar PASS aqui,
 * num código que eles nunca viram e não puderam adaptar.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { db } from "../apps/backend/src/db/client.js";
import { appendFinancialLedgerEntry } from "../apps/backend/src/billing/ledger.js";
import { runBillingReconciliationBatch } from "../apps/backend/src/billing/reconciler.js";

// ATENÇÃO: runBillingReconciliationBatch usa o `db` global importado, NÃO o pool
// passado em deps. Se o probe gravar num pool próprio, o código lê no outro e nada
// é encontrado — o cenário nunca alcança a cobrança e o veredito vira falso "ok".
// Por isso o probe usa o MESMO `db` global para montar o cenário.
const pool = db as unknown as pg.Pool;
const cleanup: string[] = [];

async function mkTenant(label: string) {
  const id = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id",
    [`probe-${label}-${randomUUID()}`, `probe-${label}-${randomUUID()}`],
  )).rows[0].id;
  cleanup.push(id);
  return id;
}

/** B3 — o saldo final tem que bater com a soma dos créditos concorrentes. */
async function probeLedgerRace(n: number) {
  const tenantId = await mkTenant("ledger");
  const clients = await Promise.all(Array.from({ length: n }, () => pool.connect()));
  let inserted = 0;
  try {
    for (const c of clients) await c.query("BEGIN");
    // cada conexão committa assim que termina o próprio append (evita deadlock de construção)
    await Promise.all(clients.map(async (c, i) => {
      try {
        const row = await appendFinancialLedgerEntry(c, tenantId, {
          direction: "CREDIT", amountCents: 100, actorType: "PROBE", reason: `race-${i}`,
          sourceEventId: `evt-${randomUUID()}`, correlationId: `corr-${randomUUID()}`,
        });
        if (row) inserted++;
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        throw e;
      }
    }));
  } finally {
    clients.forEach(c => c.release());
  }
  const rows = (await pool.query<{ amount_cents: string; balance_after_cents: string; balance_before_cents: string }>(
    "SELECT amount_cents,balance_before_cents,balance_after_cents FROM financial_ledger WHERE tenant_id=$1 ORDER BY created_at, id",
    [tenantId],
  )).rows;
  const credited = rows.reduce((s, r) => s + Number(r.amount_cents), 0);
  const finalBalance = Number(rows.at(-1)?.balance_after_cents ?? 0);
  // encadeamento: before de cada linha == after da anterior
  let chained = true;
  for (let i = 1; i < rows.length; i++) {
    if (Number(rows[i].balance_before_cents) !== Number(rows[i - 1].balance_after_cents)) chained = false;
  }
  return { n, inserted, credited, finalBalance, invariantHolds: credited === finalBalance, chained };
}

/** B1 — assinatura CANCELED/SUSPENDED com período vencido não pode gerar fatura nem chamar provider. */
async function probeChargeAfterCancel(status: string) {
  const tenantId = await mkTenant(`cancel-${status.toLowerCase()}`);
  const planId = (await pool.query<{ id: string }>(
    `INSERT INTO plans(code,name,monthly_price_cents,currency,billing_period_months,trial_days,grace_period_days,position)
     VALUES($1,$2,49700,'BRL',1,0,7,0) RETURNING id`,
    [`probe-plan-${randomUUID()}`, "Probe Plan"],
  )).rows[0].id;
  const subscriptionId = (await pool.query<{ id: string }>(
    `INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end,billing_cycle,base_price_cents,final_price_cents,snapshot_currency)
     VALUES($1,$2,$3,now() - interval '2 months', now() - interval '1 month','MONTHLY',49700,49700,'BRL') RETURNING id`,
    [tenantId, planId, status],
  )).rows[0].id;
  // provider CONECTADO + homologado e billing_account com autoCharge: sem isso o
  // caminho de cobrança nunca é alcançado e o probe daria falso "corrigido".
  const providerId = (await pool.query<{ id: string }>(
    `INSERT INTO billing_providers(homologated,code,name,enabled,environment,status,accepted_methods,credentials_encrypted,commercial_config)
     VALUES(true,$1,'Probe',true,'production','CONNECTED',ARRAY['pix'],'x','{"autoCharge":true,"defaultMethod":"pix"}'::jsonb) RETURNING id`,
    [`probe-prov-${randomUUID()}`],
  )).rows[0].id;
  await pool.query(
    "INSERT INTO billing_accounts(tenant_id,provider_id,email,document) VALUES($1,$2,'probe@test.local','123')",
    [tenantId, providerId],
  );
  // O reconciler SELECIONA o tenant por período OPEN vencido, mas FATURA os períodos
  // CLOSED. São dois requisitos simultâneos — com apenas um deles o cenário nunca
  // alcança a cobrança (diagnosticado empiricamente).
  await pool.query(
    `INSERT INTO usage_periods(tenant_id,subscription_id,sequence,start_at,end_at,overage_amount_brl_cents,status)
     VALUES($1,$2,1,now() - interval '3 months', now() - interval '2 months',2500,'CLOSED')`,
    [tenantId, subscriptionId],
  );
  await pool.query(
    `INSERT INTO usage_periods(tenant_id,subscription_id,sequence,start_at,end_at,status)
     VALUES($1,$2, 2, now() - interval '2 months', now() - interval '1 day', 'OPEN')`,
    [tenantId, subscriptionId],
  );

  let providerCalls = 0;
  const fakeProvider = {
    createPayment: async () => { providerCalls++; return { externalId: `probe-${randomUUID()}`, status: "approved", payload: {} }; },
  };
  await runBillingReconciliationBatch(100, { db: pool, provider: fakeProvider as never });

  const invoices = Number((await pool.query<{ n: string }>(
    "SELECT count(*)::text n FROM invoices WHERE tenant_id=$1", [tenantId])).rows[0].n);
  const payments = Number((await pool.query<{ n: string }>(
    "SELECT count(*)::text n FROM payments WHERE tenant_id=$1", [tenantId])).rows[0].n);
  return { status, invoices, payments, providerCalls, chargedAfterCancellation: providerCalls > 0 || payments > 0 };
}

/** CONTROLE: assinatura ACTIVE no MESMO cenário TEM que cobrar. Sem isso o probe não prova nada. */
async function probeChargeActiveControl() {
  const r = await probeChargeAfterCancel("ACTIVE");
  return { ...r, reachesChargePath: r.providerCalls > 0 || r.invoices > 0 };
}

async function main() {
  const out: Record<string, unknown> = {};
  out.B3_ledger_race_2 = await probeLedgerRace(2);
  out.B3_ledger_race_5 = await probeLedgerRace(5);
  out.CONTROL_active = await probeChargeActiveControl();
  out.B1_canceled = await probeChargeAfterCancel("CANCELED");
  out.B1_suspended = await probeChargeAfterCancel("SUSPENDED");

  const b3 = [out.B3_ledger_race_2, out.B3_ledger_race_5] as Array<{ invariantHolds: boolean; chained: boolean }>;
  const b1 = [out.B1_canceled, out.B1_suspended] as Array<{ chargedAfterCancellation: boolean }>;
  const ctl = out.CONTROL_active as { reachesChargePath: boolean };
  out.VERDICT = {
    B3_fixed: b3.every(r => r.invariantHolds && r.chained),
    // só vale se o CONTROLE provar que o cenário realmente alcança a cobrança
    B1_fixed: ctl.reachesChargePath && b1.every(r => !r.chargedAfterCancellation),
    control_reaches_charge_path: ctl.reachesChargePath,
  };
  console.log(JSON.stringify(out, null, 2));

  for (const id of cleanup) await pool.query("DELETE FROM tenants WHERE id=$1", [id]).catch(() => {});
    const v = out.VERDICT as { B3_fixed: boolean; B1_fixed: boolean };
  process.exit(v.B3_fixed && v.B1_fixed ? 0 : 1);
}

main().catch(async (e) => {
  console.error("PROBE ERROR", e);
  for (const id of cleanup) await pool.query("DELETE FROM tenants WHERE id=$1", [id]).catch(() => {});
  process.exit(2);
});
