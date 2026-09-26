import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { createChargeForInvoice } from "../src/billing/charges.js";
import { saveEncryptedCredentials, setEnabled } from "../src/billing/providers/store.js";
import type { BillingProvider, PaymentInput, ProviderResult, WebhookResult } from "../src/billing/providers/types.js";
import { acquireSharedProviderLock, SHARED_PROVIDER_LOCK_TIMEOUT_MS } from "./helpers/shared-provider-lock.js";

/**
 * Efí (efipay): provisionamento inerte da migration 0193 + schema do mandato
 * Pix Automático. Prova três coisas:
 * - as linhas efipay nascem desativadas, sem credencial, aceitando só
 *   pix_automatic, e a rota pública de webhook as rejeita sem tocar o registry;
 * - o schema trava duplicidade: um mandato em curso por tenant, SKU fixo
 *   (50M/R$157), txid 26-35 alfanumérico único, uma cobrança por (mandato,
 *   vencimento) e uma fatura por cobrança;
 * - mesmo com a Efí configurada e ativada pelo ROOT, a cobrança PIX avulsa
 *   continua isolada: o fallback de charges.ts só sorteia mercadopago e uma
 *   fatura apontada para a Efí falha fechado, sem chamar provider nenhum.
 */
const CREDITS = 50_000_000;
const PRICE_CENTS = 15_700;

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const runId = randomUUID().slice(0, 8);
const ACTOR = randomUUID(); // consent_actor_user_id — único por execução
const tenants: string[] = [];
const mandateProviders: string[] = [];

class FakeProvider implements BillingProvider {
  readonly calls: PaymentInput[] = [];
  async createPayment(input: PaymentInput): Promise<ProviderResult> {
    this.calls.push(input);
    return { externalId: `efipay-prov-${runId}-${this.calls.length}`, status: "pending", payload: { fake: true } };
  }
  createCustomer(): Promise<ProviderResult> { throw new Error("unused"); }
  createSubscription(): Promise<ProviderResult> { throw new Error("unused"); }
  cancelSubscription(): Promise<ProviderResult> { throw new Error("unused"); }
  getPayment(): Promise<ProviderResult> { throw new Error("unused"); }
  handleWebhook(): Promise<WebhookResult> { throw new Error("unused"); }
}

async function tenantFixture(): Promise<{ tenant: string; provider: string }> {
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenant = (await client.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`EfipayProv ${id}`, `efipay-provision-${id}`])).rows[0].id;
    tenants.push(tenant);
    // Linha de gateway dedicada (código único por execução): o mandato só
    // precisa de um provider_id válido; os efipay globais ficam intocados aqui.
    const provider = (await client.query<{ id: string }>("INSERT INTO billing_providers(code,name,enabled,environment) VALUES($1,$1,false,'sandbox') RETURNING id", [`efipay-mandate-${id}`])).rows[0].id;
    mandateProviders.push(provider);
    await client.query("COMMIT");
    return { tenant, provider };
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

async function insertMandate(tenant: string, provider: string, status = "CREATING"): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO ai_credit_pix_mandates(tenant_id,provider_id,status,first_due_on,consent_actor_user_id,credits,price_cents)
     VALUES($1,$2,$3,DATE '2026-10-01',$4,$5,$6) RETURNING id`,
    [tenant, provider, status, ACTOR, CREDITS, PRICE_CENTS]
  );
  return r.rows[0].id;
}

async function insertCharge(mandateId: string, txid: string, dueOn = "2026-10-01"): Promise<string> {
  const r = await pool.query<{ id: string }>(
    "INSERT INTO ai_credit_pix_charges(mandate_id,due_on,txid,status) VALUES($1,$2::date,$3,'PENDING') RETURNING id",
    [mandateId, dueOn, txid]
  );
  return r.rows[0].id;
}

const txid = (len: number) => "a".repeat(len);

// Serializa com as outras suítes que mexem na linha global billing_providers(mercadopago).
let releaseSharedProviderLock: (() => Promise<void>) | undefined;
beforeAll(async () => { releaseSharedProviderLock = await acquireSharedProviderLock(); }, SHARED_PROVIDER_LOCK_TIMEOUT_MS);
afterAll(async () => { await releaseSharedProviderLock?.(); });

beforeAll(async () => {
  await pool.query("SELECT 1");
  await pool.query("INSERT INTO users(id,email,status) VALUES($1,$2,'active') ON CONFLICT (id) DO NOTHING", [ACTOR, `${ACTOR}@efipay-provisioning.test`]);
});

afterAll(async () => {
  // Tenants primeiro: cascata leva mandatos/cobranças e libera as linhas de
  // gateway dedicadas; o ator só sai depois de perder as referências.
  await pool.query("DELETE FROM tenants WHERE slug LIKE 'efipay-provision-%'");
  await pool.query("DELETE FROM billing_providers WHERE code LIKE 'efipay-mandate-%'");
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id=$1", [ACTOR]);
  await pool.query("DELETE FROM users WHERE id=$1", [ACTOR]);
  await pool.end();
});

describe("provisionamento Efí (0193)", () => {
  it("nasce desativado, sem credencial, homologado e só com pix_automatic", async () => {
    const rows = await pool.query<{ environment: string; enabled: boolean; status: string; homologated: boolean; credentials_encrypted: string | null; accepted_methods: string[] }>(
      "SELECT environment,enabled,status,homologated,credentials_encrypted,accepted_methods FROM billing_providers WHERE code='efipay' ORDER BY environment"
    );
    expect(rows.rows).toEqual([
      { environment: "production", enabled: false, status: "NOT_CONFIGURED", homologated: true, credentials_encrypted: null, accepted_methods: ["pix_automatic"] },
      { environment: "sandbox", enabled: false, status: "NOT_CONFIGURED", homologated: true, credentials_encrypted: null, accepted_methods: ["pix_automatic"] }
    ]);
  });

  it("webhook público rejeita efipay desativado e continua barrando código desconhecido", async () => {
    const app = buildApp();
    try {
      await app.ready();
      const efipay = await app.inject({ method: "POST", url: "/webhooks/billing/efipay", headers: { "content-type": "application/json" }, payload: "{}" });
      // A linha existe (0193) e está desativada: falha ANTES do registry — sem
      // handler Efí, nenhum payload chega a processar pagamento.
      expect(efipay.statusCode).toBe(409);
      expect(efipay.json()).toMatchObject({ code: "BILLING_PROVIDER_DISABLED" });
      const unknown = await app.inject({ method: "POST", url: "/webhooks/billing/foobar", headers: { "content-type": "application/json" }, payload: "{}" });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json()).toMatchObject({ code: "PROVIDER_NOT_HOMOLOGATED" });
    } finally { await app.close(); }
  });
});

describe("schema do mandato Pix Automático", () => {
  it("aceita mandato com o SKU fixo e rejeita credits/price/status inválidos", async () => {
    const f = await tenantFixture();
    const id = await insertMandate(f.tenant, f.provider, "APPROVED");
    const row = (await pool.query<{ credits: string; price_cents: string; location_id: string | null; external_id_rec: string | null }>(
      "SELECT credits,price_cents,location_id,external_id_rec FROM ai_credit_pix_mandates WHERE id=$1", [id]
    )).rows[0];
    expect(row).toEqual({ credits: String(CREDITS), price_cents: String(PRICE_CENTS), location_id: null, external_id_rec: null });
    await expect(pool.query(
      "INSERT INTO ai_credit_pix_mandates(tenant_id,provider_id,first_due_on,consent_actor_user_id,credits,price_cents) VALUES($1,$2,DATE '2026-10-01',$3,1,15700)",
      [f.tenant, f.provider, ACTOR]
    )).rejects.toMatchObject({ code: "23514", constraint: "ai_credit_pix_mandates_credits_check" });
    await expect(pool.query(
      "INSERT INTO ai_credit_pix_mandates(tenant_id,provider_id,first_due_on,consent_actor_user_id,credits,price_cents) VALUES($1,$2,DATE '2026-10-01',$3,50000000,100)",
      [f.tenant, f.provider, ACTOR]
    )).rejects.toMatchObject({ code: "23514", constraint: "ai_credit_pix_mandates_price_cents_check" });
    await expect(pool.query(
      "INSERT INTO ai_credit_pix_mandates(tenant_id,provider_id,status,first_due_on,consent_actor_user_id,credits,price_cents) VALUES($1,$2,'FOO',DATE '2026-10-01',$3,50000000,15700)",
      [f.tenant, f.provider, ACTOR]
    )).rejects.toMatchObject({ code: "23514", constraint: "ai_credit_pix_mandates_status_check" });
  });

  it("permite um único mandato em curso por tenant; terminal libera novo", async () => {
    const f = await tenantFixture();
    const first = await insertMandate(f.tenant, f.provider, "APPROVED");
    await expect(insertMandate(f.tenant, f.provider, "PENDING")).rejects.toMatchObject({ code: "23505", constraint: "uq_ai_credit_pix_mandates_active_tenant" });
    await pool.query("UPDATE ai_credit_pix_mandates SET status='CANCELLED',cancelled_at=now() WHERE id=$1", [first]);
    const second = await insertMandate(f.tenant, f.provider, "PENDING");
    expect(second).not.toBe(first);
  });

  it("external_id_rec é globalmente único entre tenants", async () => {
    const a = await tenantFixture();
    const b = await tenantFixture();
    const first = await insertMandate(a.tenant, a.provider, "APPROVED");
    await pool.query("UPDATE ai_credit_pix_mandates SET external_id_rec=$2 WHERE id=$1", [first, `rec-${runId}`]);
    const second = await insertMandate(b.tenant, b.provider, "PENDING");
    await expect(pool.query("UPDATE ai_credit_pix_mandates SET external_id_rec=$2 WHERE id=$1", [second, `rec-${runId}`]))
      .rejects.toMatchObject({ code: "23505", constraint: "ai_credit_pix_mandates_external_id_rec_key" });
  });

  it("cobrança: uma por (mandato,vencimento), txid 26-35 alfanumérico único e uma fatura por cobrança", async () => {
    const f = await tenantFixture();
    const other = await tenantFixture();
    const mandate = await insertMandate(f.tenant, f.provider, "APPROVED");
    const otherMandate = await insertMandate(other.tenant, other.provider, "APPROVED");

    // txid fora da faixa ou com hífen (UUID) é rejeitado no banco.
    await expect(insertCharge(mandate, txid(25))).rejects.toMatchObject({ code: "23514", constraint: "ai_credit_pix_charges_txid_check" });
    await expect(insertCharge(mandate, txid(36))).rejects.toMatchObject({ code: "23514", constraint: "ai_credit_pix_charges_txid_check" });
    await expect(insertCharge(mandate, randomUUID())).rejects.toMatchObject({ code: "23514", constraint: "ai_credit_pix_charges_txid_check" });

    const charge = await insertCharge(mandate, txid(26));
    // Uma cobrança por (mandato, vencimento).
    await expect(insertCharge(mandate, txid(27))).rejects.toMatchObject({ code: "23505", constraint: "ai_credit_pix_charges_mandate_id_due_on_key" });
    // Vencimento diferente avança; mesmo txid em outro mandato não.
    await insertCharge(mandate, txid(27), "2026-11-01");
    await expect(insertCharge(otherMandate, txid(26))).rejects.toMatchObject({ code: "23505", constraint: "ai_credit_pix_charges_txid_key" });
    // Uma fatura por cobrança.
    const invoice = (await pool.query<{ id: string }>("INSERT INTO invoices(tenant_id,kind,amount_cents,currency,status) VALUES($1,'ONE_OFF',15700,'BRL','open') RETURNING id", [f.tenant])).rows[0].id;
    await pool.query("UPDATE ai_credit_pix_charges SET invoice_id=$2 WHERE id=$1", [charge, invoice]);
    const secondCharge = (await pool.query<{ id: string }>("SELECT id FROM ai_credit_pix_charges WHERE mandate_id=$1 AND due_on=DATE '2026-11-01'", [mandate])).rows[0].id;
    await expect(pool.query("UPDATE ai_credit_pix_charges SET invoice_id=$2 WHERE id=$1", [secondCharge, invoice]))
      .rejects.toMatchObject({ code: "23505", constraint: "ai_credit_pix_charges_invoice_id_key" });
  });
});

type ProviderSnapshot = { inserted: boolean; id: string; status: string; enabled: boolean; credentials_encrypted: string | null; credentials_hint: string | null; webhook_secret_encrypted: string | null; connected_at: Date | null; homologated: boolean };
const snapshots: Record<string, ProviderSnapshot | null> = { efipay: null, mercadopago: null };

async function snapshot(code: string): Promise<ProviderSnapshot | null> {
  const r = await pool.query<Omit<ProviderSnapshot, "inserted">>(
    `SELECT id,status,enabled,credentials_encrypted,credentials_hint,webhook_secret_encrypted,connected_at,homologated FROM billing_providers WHERE code=$1 AND environment='production'`,
    [code]
  );
  return r.rows[0] ? { inserted: false, ...r.rows[0] } : null;
}

async function restore(code: string, snap: ProviderSnapshot | null): Promise<void> {
  if (!snap) return;
  if (snap.inserted) {
    await pool.query("DELETE FROM billing_providers WHERE id=$1", [snap.id]);
    return;
  }
  await pool.query(
    `UPDATE billing_providers SET status=$2,enabled=$3,credentials_encrypted=$4,credentials_hint=$5,webhook_secret_encrypted=$6,connected_at=$7,homologated=$8 WHERE id=$1`,
    [snap.id, snap.status, snap.enabled, snap.credentials_encrypted, snap.credentials_hint, snap.webhook_secret_encrypted, snap.connected_at, snap.homologated]
  );
}

describe("isolamento da Efí no PIX avulso", () => {
  let efipayId = "";
  let mpId = "";

  beforeAll(async () => {
    snapshots.efipay = await snapshot("efipay");
    snapshots.mercadopago = await snapshot("mercadopago");
    if (!snapshots.mercadopago) {
      const r = await pool.query<{ id: string }>(
        "INSERT INTO billing_providers(homologated,code,name,enabled,environment,status,accepted_methods,credentials_encrypted) VALUES(true,'mercadopago','Mercado Pago',true,'production','CONNECTED',ARRAY['pix'],'x') RETURNING id"
      );
      snapshots.mercadopago = { inserted: true, id: r.rows[0].id, status: "CONNECTED", enabled: true, credentials_encrypted: "x", credentials_hint: null, webhook_secret_encrypted: null, connected_at: null, homologated: true };
    }
    mpId = snapshots.mercadopago.id;
    // ROOT pode configurar credenciais e ativar a Efí (a homologação libera).
    await saveEncryptedCredentials("efipay", "production", { clientId: "efi-client", clientSecret: "efi-secret" }, ACTOR);
    await setEnabled("efipay", "production", true, ACTOR);
    efipayId = (await pool.query<{ id: string }>("SELECT id FROM billing_providers WHERE code='efipay' AND environment='production'")).rows[0].id;
    // Efí conectada há mais tempo: no fallback genérico ela sairia ANTES do
    // Mercado Pago (ORDER BY connected_at) — o filtro por código é o que salva.
    await pool.query("UPDATE billing_providers SET connected_at=now()-interval '1 year' WHERE id=$1", [efipayId]);
    await pool.query("UPDATE billing_providers SET status='CONNECTED',enabled=true,credentials_encrypted=COALESCE(credentials_encrypted,'x'),connected_at=now() WHERE id=$1", [mpId]);
  });

  afterAll(async () => {
    await restore("efipay", snapshots.efipay);
    await restore("mercadopago", snapshots.mercadopago);
  });

  it("fallback sorteia Mercado Pago e ignora a Efí ativada", async () => {
    const f = await tenantFixture();
    const fake = new FakeProvider();
    const invoice = (await pool.query<{ id: string }>("INSERT INTO invoices(tenant_id,kind,amount_cents,currency,status) VALUES($1,'ONE_OFF',100,'BRL','open') RETURNING id", [f.tenant])).rows[0].id;
    const r = await createChargeForInvoice(invoice, "pix", { db: pool, provider: fake });
    expect(fake.calls).toHaveLength(1);
    const inv = (await pool.query<{ provider_id: string; external_id: string }>("SELECT provider_id,external_id FROM invoices WHERE id=$1", [invoice])).rows[0];
    expect(inv.provider_id).toBe(mpId);
    expect(inv.external_id).toBe(r.reference);
    const payment = (await pool.query<{ provider_id: string }>("SELECT provider_id FROM payments WHERE invoice_id=$1", [invoice])).rows[0];
    expect(payment.provider_id).toBe(mpId);
  });

  it("fatura apontada para a Efí falha fechado, sem chamar provider", async () => {
    const f = await tenantFixture();
    const fake = new FakeProvider();
    const invoice = (await pool.query<{ id: string }>(
      "INSERT INTO invoices(tenant_id,provider_id,kind,amount_cents,currency,status) VALUES($1,$2,'ONE_OFF',100,'BRL','open') RETURNING id",
      [f.tenant, efipayId]
    )).rows[0].id;
    // 'pix_automatic' passa pelos métodos aceitos da Efí — a única barreira
    // restante é o portão de código em charges.ts. 'pix' (avulso) já morre em
    // accepted_methods.
    await expect(createChargeForInvoice(invoice, "pix_automatic", { db: pool, provider: fake }))
      .rejects.toMatchObject({ code: "PROVIDER_NOT_SUPPORTED", statusCode: 400 });
    await expect(createChargeForInvoice(invoice, "pix", { db: pool, provider: fake })).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
    const inv = (await pool.query<{ external_id: string | null }>("SELECT external_id FROM invoices WHERE id=$1", [invoice])).rows[0];
    expect(inv.external_id).toBeNull();
    expect((await pool.query("SELECT count(*)::int n FROM payments WHERE invoice_id=$1", [invoice])).rows[0].n).toBe(0);
  });
});
