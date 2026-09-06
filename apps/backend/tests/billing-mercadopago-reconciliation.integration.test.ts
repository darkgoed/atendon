import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { runMercadoPagoReconciliationBatch } from "../src/billing/mercadopago-reconciliation.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
let providerId = "";
const tenants: string[] = [];

type Remote = {
  id: string;
  status: string;
  transaction_amount: number;
  currency_id: string;
  external_reference: string;
};

async function seedPayment(overrides: { status?: string; amountCents?: number; currency?: string } = {}) {
  const suffix = randomUUID();
  const tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id",
    [`Reconciliation ${suffix}`, `reconciliation-${suffix}`]
  )).rows[0].id;
  tenants.push(tenantId);
  const reference = `invoice:${suffix}`;
  const amount = overrides.amountCents ?? 1000;
  const currency = overrides.currency ?? "BRL";
  const invoiceId = (await pool.query<{ id: string }>(
    `INSERT INTO invoices(tenant_id,provider_id,external_id,kind,amount_cents,currency,status,metadata)
     VALUES($1,$2,$3,'subscription',$4,$5,$6,$7) RETURNING id`,
    [tenantId, providerId, reference, amount, currency, overrides.status ?? "pending", { external_reference: reference }]
  )).rows[0].id;
  const externalId = `mp-${suffix}`;
  const paymentId = (await pool.query<{ id: string }>(
    `INSERT INTO payments(tenant_id,invoice_id,provider_id,external_id,amount_cents,currency,status,method,metadata)
     VALUES($1,$2,$3,$4,$5,$6,$7,'pix',$8) RETURNING id`,
    [tenantId, invoiceId, providerId, externalId, amount, currency, overrides.status ?? "pending", { external_reference: reference }]
  )).rows[0].id;
  return { tenantId, invoiceId, paymentId, externalId, reference, amount, currency };
}

beforeAll(async () => {
  // Outras suítes removem/recriam a linha production; o teste não pode depender
  // da ordem global. Upsert explícito deixa a fixture autossuficiente.
  const row = await pool.query<{ id: string }>(
    `INSERT INTO billing_providers(code,name,environment,homologated,enabled,status,credentials_encrypted)
     VALUES('mercadopago','Mercado Pago','production',true,true,'CONNECTED','test-only')
     ON CONFLICT(code,environment) DO UPDATE
       SET homologated=true,enabled=true,status='CONNECTED',credentials_encrypted='test-only'
     RETURNING id`
  );
  providerId = row.rows[0].id;
});

beforeEach(async () => {
  if (tenants.length) {
    await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[...tenants]]);
    tenants.length = 0;
  }
});

afterAll(async () => {
  if (tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenants]);
  await pool.query(
    `UPDATE billing_providers
        SET enabled=false,status='NOT_CONFIGURED',credentials_encrypted=NULL
      WHERE id=$1`,
    [providerId]
  );
  await pool.end();
});

describe("reconciliação ativa Mercado Pago", () => {
  it("não cria finding quando banco e gateway conferem", async () => {
    const local = await seedPayment();
    const getPayment = vi.fn(async (): Promise<Remote> => ({
      id: local.externalId,
      status: "pending",
      transaction_amount: 10,
      currency_id: "BRL",
      external_reference: local.reference
    }));
    const result = await runMercadoPagoReconciliationBatch(100, { getPayment });
    expect(result).toMatchObject({ scanned: 1, findings: 0, errors: [] });
    expect((await pool.query("SELECT 1 FROM mercadopago_reconciliation_findings WHERE payment_id=$1", [local.paymentId])).rowCount).toBe(0);
  });

  it("detecta status, valor, moeda e referência divergentes sem alterar dinheiro", async () => {
    const local = await seedPayment();
    const result = await runMercadoPagoReconciliationBatch(100, {
      getPayment: async (): Promise<Remote> => ({
        id: local.externalId,
        status: "approved",
        transaction_amount: 99,
        currency_id: "USD",
        external_reference: "outra-fatura"
      })
    });
    expect(result).toMatchObject({ scanned: 1, findings: 4, errors: [] });
    const findings = await pool.query<{ finding_type: string; remote_snapshot: Record<string, unknown> }>(
      "SELECT finding_type,remote_snapshot FROM mercadopago_reconciliation_findings WHERE payment_id=$1 ORDER BY finding_type",
      [local.paymentId]
    );
    expect(findings.rows.map((row) => row.finding_type).sort()).toEqual([
      "AMOUNT_MISMATCH", "CURRENCY_MISMATCH", "REFERENCE_MISMATCH", "STATUS_MISMATCH"
    ]);
    // Snapshot é allowlist: payload arbitrário, credencial e segredo nunca entram.
    expect(Object.keys(findings.rows[0].remote_snapshot).sort()).toEqual([
      "currency_id", "external_reference", "id", "status", "transaction_amount"
    ]);
    const unchanged = await pool.query("SELECT status,amount_cents,currency FROM payments WHERE id=$1", [local.paymentId]);
    expect(unchanged.rows[0]).toMatchObject({ status: "pending", amount_cents: "1000", currency: "BRL" });

    // Repetir atualiza os mesmos quatro registros; não duplica findings.
    await runMercadoPagoReconciliationBatch(100, {
      getPayment: async () => ({ id: local.externalId, status: "approved", transaction_amount: 99, currency_id: "USD", external_reference: "outra-fatura" })
    });
    expect((await pool.query("SELECT 1 FROM mercadopago_reconciliation_findings WHERE payment_id=$1", [local.paymentId])).rowCount).toBe(4);
  });

  it("registra erro sanitizado do gateway e libera a lease para retry", async () => {
    const local = await seedPayment();
    const result = await runMercadoPagoReconciliationBatch(100, {
      getPayment: async () => { throw new Error("token-super-secreto"); }
    });
    expect(result.scanned).toBe(1);
    expect(result.errors).toHaveLength(1);
    const finding = await pool.query<{ remote_snapshot: Record<string, unknown> }>(
      "SELECT remote_snapshot FROM mercadopago_reconciliation_findings WHERE payment_id=$1 AND finding_type='GATEWAY_ERROR'",
      [local.paymentId]
    );
    expect(finding.rows[0].remote_snapshot).toEqual({ error: "gateway_request_failed" });
    expect((await pool.query("SELECT reconciliation_claimed_at FROM payments WHERE id=$1", [local.paymentId])).rows[0].reconciliation_claimed_at).toBeNull();
  });

  it("duas réplicas concorrentes não consultam o mesmo pagamento duas vezes", async () => {
    const local = await seedPayment();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const getPayment = vi.fn(async () => {
      started();
      await gate;
      return { id: local.externalId, status: "pending", transaction_amount: 10, currency_id: "BRL", external_reference: local.reference };
    });

    const first = runMercadoPagoReconciliationBatch(1, { getPayment });
    await entered;
    const second = await runMercadoPagoReconciliationBatch(1, { getPayment });
    expect(second.scanned).toBe(0);
    release();
    await first;
    expect(getPayment).toHaveBeenCalledTimes(1);
  });
});
