import { createHmac, randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { grantPaidCreditPackage, revokeCreditPackageGrant } from "../src/billing/credit-packs.js";
import { consumeAiInteraction, releaseAiInteractionWithoutUsage } from "../src/billing/ai-consumption.js";
import { ensureOpenPeriod } from "../src/billing/usage-period.js";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import type { BillingProvider, PaymentInput, ProviderResult, WebhookResult } from "../src/billing/providers/types.js";
import { encryptCredentials, encryptWebhookSecret } from "../src/billing/providers/credentials.js";
import { acquireSharedProviderLock, SHARED_PROVIDER_LOCK_TIMEOUT_MS } from "./helpers/shared-provider-lock.js";

/**
 * Venda real de pacotes adicionais de créditos normalizados de IA:
 * 50.000.000 créditos por R$157,00, concedidos APENAS pelo webhook PIX
 * autenticado/pago, na MESMA transação do pagamento, com estorno do
 * remanescente em refund/chargeback e múltiplas compras permitidas.
 */
const CREDITS = 50_000_000;
const PRICE_CENTS = 15_700;
const GRANT_KEY_PREFIX = "credit-pack:";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const password = "credit-packs-test";
const tenants: string[] = [];
const webhookSecret = "credit-packs-webhook-secret";

class FakeProvider implements BillingProvider {
  readonly calls: PaymentInput[] = [];
  async createPayment(input: PaymentInput): Promise<ProviderResult> {
    this.calls.push(input);
    return { externalId: `fake-${this.calls.length}`, status: "pending", payload: { fake: true, point_of_interaction: { transaction_data: { qr_code: "pix-qr", ticket_url: "https://pay.test/pix" } } } };
  }
  createCustomer(): Promise<ProviderResult> { throw new Error("unused"); }
  createSubscription(): Promise<ProviderResult> { throw new Error("unused"); }
  cancelSubscription(): Promise<ProviderResult> { throw new Error("unused"); }
  getPayment(): Promise<ProviderResult> { throw new Error("unused"); }
  handleWebhook(): Promise<WebhookResult> { throw new Error("unused"); }
}

type Fixture = { tenant: string; provider: string; subscription: string; period: string; periodUnit: string; app: ReturnType<typeof buildApp>; fake: FakeProvider; userEmail: string };

async function fixture(planCode = "BASIC"): Promise<Fixture> {
  const id = randomUUID();
  const fake = new FakeProvider();
  const app = buildApp({ billingOAuth: { chargeDeps: { db: pool, provider: fake } } });
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenant = (await client.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`CreditPack ${id}`, `credit-pack-${id}`])).rows[0].id;
    tenants.push(tenant);
    const userEmail = `user-${id}@test.local`;
    await client.query("INSERT INTO users(email,password_hash,status,is_root) VALUES($1,$2,'active',false)", [userEmail, await hash(password, 4)]);
    await ensureWorkspaceDefaultRoles(client, tenant);
    await client.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,u.id,r.id,'active',now() FROM users u, workspace_roles r WHERE u.email=$2 AND r.workspace_id=$1 AND r.name='ADMIN'", [tenant, userEmail]);
    const provider = (await client.query<{ id: string }>("INSERT INTO billing_providers(homologated,code,name,enabled,environment,status,accepted_methods,credentials_encrypted) VALUES(true,$1,'Fake',true,'production','CONNECTED',$2,'x') RETURNING id", [`fake-${id}`, ["pix"]])).rows[0].id;
    const subscription = (await client.query<{ id: string }>("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) SELECT $1,id,'ACTIVE',now(),now()+interval '1 month' FROM plans WHERE code=$2 RETURNING id", [tenant, planCode])).rows[0].id;
    const period = (await ensureOpenPeriod(client, tenant))!;
    await client.query("INSERT INTO billing_accounts(tenant_id,provider_id,email,document) VALUES($1,$2,'payer@example.com','123')", [tenant, provider]);
    await client.query("COMMIT");
    return { tenant, provider, subscription, period: period.id, periodUnit: period.usage_unit, app, fake, userEmail };
  } catch (error) { await client.query("ROLLBACK"); await app.close(); throw error; } finally { client.release(); }
}

async function clean(x: Fixture) { await x.app.close(); }
async function login(x: Fixture, email: string) {
  const r = await x.app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(r.statusCode).toBe(200);
  const cookie = r.headers["set-cookie"];
  return (Array.isArray(cookie) ? cookie[0] : cookie!).split(";")[0];
}
async function buy(x: Fixture, idempotencyKey = randomUUID()) {
  return x.app.inject({ method: "POST", url: "/billing/ai-credit-packs", headers: { cookie: await login(x, x.userEmail) }, payload: { idempotencyKey } });
}
async function chargePix(x: Fixture, invoiceId: string) {
  // Fatura nova nasce sem provider preferido e a escolha determinística do
  // charges.ts pode cair em linha legado de outra suíte. Fixa o provider do
  // webhook (mercadopago produção): é o mesmo gateway que envia o webhook, e
  // applyApproved localiza a fatura por (provider_id, external_id).
  await pool.query("UPDATE invoices SET provider_id=$2 WHERE id=$1", [invoiceId, mpProviderId]);
  const r = await x.app.inject({ method: "POST", url: `/billing/invoices/${invoiceId}/charge`, headers: { cookie: await login(x, x.userEmail) }, payload: { method: "pix" } });
  expect(r.statusCode).toBe(200);
  return r.json().charge as { invoiceId: string; id: string; status: string };
}
async function purchaseOf(x: Fixture) {
  const r = await pool.query<{ id: string; invoice_id: string; status: string; grant_id: string | null; credits: string; price_cents: string; sku: string; revoked_credits: string }>(
    "SELECT id,invoice_id,status,grant_id,credits,price_cents,sku,revoked_credits FROM ai_credit_purchases WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1", [x.tenant]);
  expect(r.rows[0]).toBeDefined();
  return r.rows[0];
}
async function grantsOf(tenantId: string) {
  return (await pool.query<{ id: string; amount: string; consumed_amount: string; usage_unit: string; idempotency_key: string; kind: string }>(
    "SELECT id,amount,consumed_amount,usage_unit,idempotency_key,kind FROM usage_grants WHERE tenant_id=$1 ORDER BY created_at", [tenantId])).rows;
}
async function periodOf(x: Fixture) {
  return (await pool.query<{ bonus_granted: string; bonus_usage: string; usage_unit: string }>("SELECT bonus_granted,bonus_usage,usage_unit FROM usage_periods WHERE id=$1", [x.period])).rows[0];
}
async function balanceOf(x: Fixture) {
  const r = await x.app.inject({ method: "GET", url: "/billing/ai-credit-packs/balance", headers: { cookie: await login(x, x.userEmail) } });
  expect(r.statusCode).toBe(200);
  return r.json().balance as { availableCredits: number; grants: Array<{ amount: number; consumedAmount: number; remaining: number; active: boolean }> };
}

// Envolve o PoolClient para interceptar APENAS o primeiro SELECT de
// usage_grants SEM FOR UPDATE (a leitura obsoleta de revokeCreditPackageGrant)
// e rodar `during` logo após a resposta — antes de a função seguir para o
// lock do período. Só o client passado à função é envolvido.
function staleGrantRead(client: PoolClient, during: () => Promise<void>): PoolClient {
  let fired = false;
  const query = (async (text: string, values?: unknown[]) => {
    const result = await client.query(text, values as string[]);
    if (!fired && text.startsWith("SELECT") && text.includes("FROM usage_grants") && !text.includes("FOR UPDATE")) {
      fired = true;
      await during();
    }
    return result;
  }) as unknown as PoolClient["query"];
  return Object.assign(Object.create(client), { query });
}

// Gateway simulado para o refetch autenticado do provider Mercado Pago.
const gateway = { status: "approved", transactionAmount: 157, currencyId: "BRL", invoiceRef: "" };
let originalFetch: typeof fetch | undefined;
let mpProviderId = "";
// billing_events UNIQUE(provider_id, external_event_id) persiste entre execuções
// (a linha mercadopago é UPDATE-in-place): ids de recurso precisam de namespace
// por execução.
const runId = randomUUID().slice(0, 8);

async function deliver(x: Fixture, invoiceId: string, rawResourceId: string, action: string) {
  const resourceId = `${runId}-${rawResourceId}`;
  const requestId = `req-${resourceId}-${action}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const manifest = `id:${resourceId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  const v1 = createHmac("sha256", webhookSecret).update(manifest).digest("hex");
  return x.app.inject({
    method: "POST",
    url: "/webhooks/billing/mercadopago",
    headers: { "content-type": "application/json", "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": requestId },
    payload: JSON.stringify({ type: "payment", action, data: { id: resourceId }, external_reference: `invoice:${invoiceId}` })
  });
}

let savedMercadoPago: { inserted: boolean; credentials: string | null; secret: string | null; status: string; enabled: boolean; homologated: boolean | null } | null = null;

// Serializa com as outras suítes que mexem na linha global billing_providers(mercadopago).
let releaseSharedProviderLock: (() => Promise<void>) | undefined;
beforeAll(async () => { releaseSharedProviderLock = await acquireSharedProviderLock(); }, SHARED_PROVIDER_LOCK_TIMEOUT_MS);
afterAll(async () => { await releaseSharedProviderLock?.(); });

beforeAll(async () => {
  await pool.query("SELECT 1");
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const url = String(input);
    const match = url.match(/\/v1\/payments\/([^/?]+)/);
    if (!match) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({
      id: match[1], status: gateway.status, transaction_amount: gateway.transactionAmount, currency_id: gateway.currencyId,
      external_reference: gateway.invoiceRef, external_invoice_id: gateway.invoiceRef
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Órfãos de execuções anteriores (tenants referenciam a linha mercadopago
    // via invoices.provider_id — RESTRICT): limpa antes de tocar o provider.
    await client.query("DELETE FROM tenants WHERE slug LIKE 'credit-pack-%'");
    const existing = await client.query<{ id: string; credentials_encrypted: string | null; webhook_secret_encrypted: string | null; status: string; enabled: boolean; homologated: boolean | null }>(
      "SELECT id,credentials_encrypted,webhook_secret_encrypted,status,enabled,homologated FROM billing_providers WHERE code='mercadopago' AND environment='production'");
    if (existing.rows[0]) {
      const row = existing.rows[0];
      savedMercadoPago = { inserted: false, credentials: row.credentials_encrypted, secret: row.webhook_secret_encrypted, status: row.status, enabled: row.enabled, homologated: row.homologated };
      mpProviderId = row.id;
      await client.query("UPDATE billing_providers SET status='CONNECTED',enabled=true,homologated=true,credentials_encrypted=$2,webhook_secret_encrypted=$3 WHERE id=$1",
        [row.id, encryptCredentials({ accessToken: "token-packs" }, config.DATA_ENCRYPTION_KEY), encryptWebhookSecret(webhookSecret, config.DATA_ENCRYPTION_KEY)]);
    } else {
      savedMercadoPago = { inserted: true, credentials: null, secret: null, status: "DISCONNECTED", enabled: true, homologated: null };
      mpProviderId = (await client.query<{ id: string }>(
        `INSERT INTO billing_providers(homologated,code,name,enabled,environment,status,credentials_encrypted,webhook_secret_encrypted)
         VALUES(true,'mercadopago','Mercado Pago',true,'production','CONNECTED',$1,$2) RETURNING id`,
        [encryptCredentials({ accessToken: "token-packs" }, config.DATA_ENCRYPTION_KEY), encryptWebhookSecret(webhookSecret, config.DATA_ENCRYPTION_KEY)])).rows[0].id;
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
});

afterAll(async () => {
  globalThis.fetch = originalFetch as typeof fetch;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const id of tenants) await client.query("DELETE FROM tenants WHERE id=$1", [id]);
    await client.query("DELETE FROM tenants WHERE slug LIKE 'credit-pack-%'");
    // billing_events.tenant_id é ON DELETE SET NULL: os eventos desta suíte
    // continuam presos ao provider e bloqueariam o DELETE abaixo (FK), fazendo
    // o ROLLBACK deixar faturas pagas no mercadopago global para outras suítes.
    await client.query("DELETE FROM billing_events WHERE provider_id=$1 AND external_event_id LIKE $2", [mpProviderId, `%${runId}-%`]);
    if (savedMercadoPago?.inserted) {
      await client.query("DELETE FROM billing_providers WHERE id=$1", [mpProviderId]);
    } else if (savedMercadoPago) {
      await client.query("UPDATE billing_providers SET credentials_encrypted=$2,webhook_secret_encrypted=$3,status=$4,enabled=$5,homologated=$6 WHERE id=$1",
        [mpProviderId, savedMercadoPago.credentials, savedMercadoPago.secret, savedMercadoPago.status, savedMercadoPago.enabled, savedMercadoPago.homologated]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  await pool.end();
});

describe("AI credit pack purchases", () => {
  it("POST cria compra idempotente com fatura credit_package, linha ADDON e sem concessão", async () => {
    const x = await fixture();
    try {
      const key = randomUUID();
      const first = await buy(x, key);
      expect(first.statusCode).toBe(200);
      const second = await buy(x, key);
      expect(second.statusCode).toBe(200);
      expect(second.json().purchase.id).toBe(first.json().purchase.id);
      const purchase = first.json().purchase;
      expect(purchase).toMatchObject({ sku: "AI_CREDITS_50M", credits: CREDITS, priceCents: PRICE_CENTS, currency: "BRL", status: "PENDING_PAYMENT" });
      const invoice = (await pool.query<{ kind: string; subscription_id: string | null; amount_cents: string; status: string; currency: string }>(
        "SELECT kind,subscription_id,amount_cents,status,currency FROM invoices WHERE id=$1", [purchase.invoiceId])).rows[0];
      expect(invoice).toMatchObject({ kind: "credit_package", subscription_id: null, amount_cents: String(PRICE_CENTS), status: "pending", currency: "BRL" });
      const lines = (await pool.query<{ kind: string; amount_cents: string; quantity: string }>(
        "SELECT kind,amount_cents,quantity FROM invoice_line_items WHERE invoice_id=$1", [purchase.invoiceId])).rows;
      expect(lines).toEqual([{ kind: "ADDON", amount_cents: String(PRICE_CENTS), quantity: "1" }]);
      expect(await grantsOf(x.tenant)).toEqual([]);
      expect((await periodOf(x)).bonus_granted).toBe("0");
    } finally { await clean(x); }
  });

  it("rejeita price/credits e idempotencyKey inválida no corpo", async () => {
    const x = await fixture();
    try {
      const cookie = await login(x, x.userEmail);
      const tampered = await x.app.inject({ method: "POST", url: "/billing/ai-credit-packs", headers: { cookie }, payload: { idempotencyKey: randomUUID(), priceCents: 1, credits: 1 } });
      expect(tampered.statusCode).toBe(400);
      const missing = await x.app.inject({ method: "POST", url: "/billing/ai-credit-packs", headers: { cookie }, payload: {} });
      expect(missing.statusCode).toBe(400);
      const bad = await x.app.inject({ method: "POST", url: "/billing/ai-credit-packs", headers: { cookie }, payload: { idempotencyKey: "not-a-uuid" } });
      expect(bad.statusCode).toBe(400);
      expect(await pool.query("SELECT count(*)::int n FROM ai_credit_purchases WHERE tenant_id=$1", [x.tenant])).toMatchObject({ rows: [{ n: 0 }] });
    } finally { await clean(x); }
  });

  it("GET expõe SKU fixo, compras paginadas e isolamento por empresa", async () => {
    const a = await fixture();
    const b = await fixture();
    try {
      for (let i = 0; i < 3; i++) expect((await buy(a)).statusCode).toBe(200);
      const cookieA = await login(a, a.userEmail);
      const page1 = await a.app.inject({ method: "GET", url: "/billing/ai-credit-packs?page=1&limit=2", headers: { cookie: cookieA } });
      expect(page1.statusCode).toBe(200);
      const body1 = page1.json();
      expect(body1.sku).toEqual({ sku: "AI_CREDITS_50M", credits: CREDITS, priceCents: PRICE_CENTS, currency: "BRL" });
      expect(body1.purchases).toHaveLength(2);
      const page2 = await a.app.inject({ method: "GET", url: "/billing/ai-credit-packs?page=2&limit=2", headers: { cookie: cookieA } });
      expect(page2.json().purchases).toHaveLength(1);
      const cookieB = await login(b, b.userEmail);
      const fromB = await b.app.inject({ method: "GET", url: "/billing/ai-credit-packs", headers: { cookie: cookieB } });
      expect(fromB.json().purchases).toEqual([]);
      const balanceB = await b.app.inject({ method: "GET", url: "/billing/ai-credit-packs/balance", headers: { cookie: cookieB } });
      expect(balanceB.json().balance.availableCredits).toBe(0);
    } finally { await clean(a); await clean(b); }
  });

  it("fatura pendente não concede crédito: saldo zero antes do pagamento", async () => {
    const x = await fixture();
    try {
      await buy(x);
      const purchase = await purchaseOf(x);
      expect(purchase.status).toBe("PENDING_PAYMENT");
      expect(purchase.grant_id).toBeNull();
      expect(await balanceOf(x)).toMatchObject({ availableCredits: 0 });
    } finally { await clean(x); }
  });

  it("PIX pago via webhook concede 50M créditos na mesma transação do pagamento", async () => {
    const x = await fixture();
    try {
      const purchase = (await buy(x)).json().purchase;
      const charge = await chargePix(x, purchase.invoiceId);
      expect(charge.status).toBe("pending");
      gateway.invoiceRef = `invoice:${purchase.invoiceId}`;
      gateway.status = "approved";
      gateway.transactionAmount = 157;
      const hook = await deliver(x, purchase.invoiceId, "pay-ok-1", "payment");
      expect(hook.statusCode).toBe(200);
      expect(hook.json().status).toBe("processed");
      const after = await purchaseOf(x);
      expect(after.status).toBe("GRANTED");
      expect(after.grant_id).not.toBeNull();
      const grants = await grantsOf(x.tenant);
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({ kind: "CREDIT_PACKAGE", amount: String(CREDITS), consumed_amount: "0", usage_unit: "CREDIT", idempotency_key: `${GRANT_KEY_PREFIX}${purchase.invoiceId}` });
      expect((await periodOf(x)).bonus_granted).toBe(String(CREDITS));
      const invoice = (await pool.query<{ status: string; paid_at: Date | null }>("SELECT status,paid_at FROM invoices WHERE id=$1", [purchase.invoiceId])).rows[0];
      expect(invoice.status).toBe("paid");
      const payment = (await pool.query<{ status: string }>("SELECT status FROM payments WHERE invoice_id=$1", [purchase.invoiceId])).rows[0];
      expect(payment.status).toBe("paid");
      expect(await balanceOf(x)).toMatchObject({ availableCredits: CREDITS });
    } finally { await clean(x); }
  });

  it("webhook aprovado duplicado (mesmo evento e evento tardio) não re-concede", async () => {
    const x = await fixture();
    try {
      const purchase = (await buy(x)).json().purchase;
      await chargePix(x, purchase.invoiceId);
      gateway.invoiceRef = `invoice:${purchase.invoiceId}`;
      expect((await deliver(x, purchase.invoiceId, "pay-dup", "payment")).json().status).toBe("processed");
      const duplicate = await deliver(x, purchase.invoiceId, "pay-dup", "payment");
      expect(duplicate.json().status).toBe("duplicated");
      const late = await deliver(x, purchase.invoiceId, "pay-dup", "payment.updated.approved");
      expect(late.statusCode).toBe(200);
      expect(await grantsOf(x.tenant)).toHaveLength(1);
      expect((await periodOf(x)).bonus_granted).toBe(String(CREDITS));
    } finally { await clean(x); }
  });

  it("mismatch de valor/moeda mantém fatura pendente e sem concessão", async () => {
    const x = await fixture();
    try {
      const purchase = (await buy(x)).json().purchase;
      await chargePix(x, purchase.invoiceId);
      gateway.invoiceRef = `invoice:${purchase.invoiceId}`;
      gateway.transactionAmount = 100;
      const hook = await deliver(x, purchase.invoiceId, "pay-mismatch", "payment");
      expect(hook.statusCode).toBe(422);
      gateway.transactionAmount = 157;
      expect((await purchaseOf(x)).status).toBe("PENDING_PAYMENT");
      expect(await grantsOf(x.tenant)).toEqual([]);
      expect((await pool.query<{ status: string }>("SELECT status FROM invoices WHERE id=$1", [purchase.invoiceId])).rows[0].status).toBe("pending");
    } finally { await clean(x); }
  });

  it("refund após uso parcial revoga APENAS o remanescente", async () => {
    const x = await fixture();
    try {
      const purchase = (await buy(x)).json().purchase;
      await chargePix(x, purchase.invoiceId);
      gateway.invoiceRef = `invoice:${purchase.invoiceId}`;
      gateway.status = "approved";
      expect((await deliver(x, purchase.invoiceId, "pay-refund", "payment")).json().status).toBe("processed");
      const grant = (await grantsOf(x.tenant))[0];
      const used = 20_000_000;
      await pool.query("UPDATE usage_grants SET consumed_amount=$2 WHERE id=$1", [grant.id, used]);
      await pool.query("UPDATE usage_periods SET bonus_usage=bonus_usage+$2 WHERE id=$1", [x.period, used]);
      gateway.status = "refunded";
      expect((await deliver(x, purchase.invoiceId, "pay-refund", "payment.updated")).json().status).toBe("processed");
      const after = (await grantsOf(x.tenant))[0];
      expect(after.consumed_amount).toBe(String(CREDITS));
      expect(after.amount).toBe(String(CREDITS));
      const purchaseAfter = await purchaseOf(x);
      expect(purchaseAfter.status).toBe("REVERSED");
      expect(purchaseAfter.revoked_credits).toBe(String(CREDITS - used));
      // bonus_granted 50M − 30M revogado = 20M = o que foi de fato consumido.
      expect((await periodOf(x)).bonus_granted).toBe(String(used));
      expect((await pool.query<{ status: string }>("SELECT status FROM invoices WHERE id=$1", [purchase.invoiceId])).rows[0].status).toBe("refunded");
      expect(await balanceOf(x)).toMatchObject({ availableCredits: 0 });
    } finally { await clean(x); }
  });

  it("corrida entre reserva e estorno: consumo concorrente após leitura obsoleta revoga só o remanescente", async () => {
    const x = await fixture();
    const client = await pool.connect();
    try {
      const purchase = (await buy(x)).json().purchase;
      await chargePix(x, purchase.invoiceId);
      gateway.invoiceRef = `invoice:${purchase.invoiceId}`;
      gateway.status = "approved";
      gateway.transactionAmount = 157;
      expect((await deliver(x, purchase.invoiceId, "pay-race-revoke", "payment")).json().status).toBe("processed");
      const grant = (await grantsOf(x.tenant))[0];
      const used = 20_000_000;
      // Simula a reserva de IA concorrente: de OUTRO client (commit imediato,
      // sem sleep) consome 20M da grant entre a leitura obsoleta e o re-lock.
      const race = async () => {
        const other = await pool.connect();
        try {
          await other.query("UPDATE usage_grants SET consumed_amount=consumed_amount+$2 WHERE id=$1", [grant.id, used]);
          await other.query("UPDATE usage_periods SET bonus_usage=bonus_usage+$2 WHERE id=$1", [x.period, used]);
        } finally { other.release(); }
      };
      await client.query("BEGIN");
      const revoked = await revokeCreditPackageGrant(staleGrantRead(client, race), x.tenant, purchase.invoiceId);
      await client.query("COMMIT");
      expect(revoked).toBe(CREDITS - used);
      expect((await grantsOf(x.tenant))[0].consumed_amount).toBe(String(CREDITS));
      const purchaseAfter = await purchaseOf(x);
      expect(purchaseAfter.status).toBe("REVERSED");
      expect(purchaseAfter.revoked_credits).toBe(String(CREDITS - used));
      // bonus_granted 50M − 30M revogado = 20M = o que foi de fato consumido.
      expect((await periodOf(x)).bonus_granted).toBe(String(used));
      expect(await balanceOf(x)).toMatchObject({ availableCredits: 0 });
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); await clean(x); }
  });

  it("release de reserva pendente após estorno não ressuscita saldo nem re-revoca no retry", async () => {
    const x = await fixture();
    try {
      const purchase = (await buy(x)).json().purchase;
      await chargePix(x, purchase.invoiceId);
      gateway.invoiceRef = `invoice:${purchase.invoiceId}`;
      gateway.status = "approved";
      gateway.transactionAmount = 157;
      expect((await deliver(x, purchase.invoiceId, "pay-revive", "payment")).json().status).toBe("processed");
      const grant = (await grantsOf(x.tenant))[0];
      const grantRow = async () => (await pool.query<{ consumed_amount: string; amount: string; expires_at: Date | null }>(
        "SELECT consumed_amount,amount,expires_at FROM usage_grants WHERE id=$1", [grant.id])).rows[0];

      // Reserva REAL contra o pacote (caminho de produção): BONUS debita a grant.
      const turnId = randomUUID();
      const reserve = await consumeAiInteraction(x.tenant, "inbound_reply", turnId);
      expect(reserve).toMatchObject({ allowed: true, consumptionType: "BONUS" });
      const reservedCredits = reserve.estimatedCredits!;
      expect(reservedCredits).toBeGreaterThan(0);
      expect((await grantRow()).consumed_amount).toBe(String(reservedCredits));

      // Estorno com a reserva AINDA em voo: tomba a grant (expires_at) e revoga
      // o remanescente — consumed chega ao amount.
      gateway.status = "refunded";
      expect((await deliver(x, purchase.invoiceId, "pay-revive", "payment.updated")).json().status).toBe("processed");
      expect(await purchaseOf(x)).toMatchObject({ status: "REVERSED", revoked_credits: String(CREDITS - reservedCredits) });
      expect((await grantRow())).toMatchObject({ consumed_amount: String(CREDITS) });
      expect((await grantRow()).expires_at).not.toBeNull();

      // Release da reserva pendente (turno nunca chegou ao provedor): ABAIXA o
      // consumed de volta — exatamente o cenário que ressuscitava saldo gastável.
      await releaseAiInteractionWithoutUsage(x.tenant, "inbound_reply", turnId);
      const afterRelease = await grantRow();
      expect(afterRelease.consumed_amount).toBe(String(CREDITS - reservedCredits));
      expect(afterRelease.expires_at).not.toBeNull();

      // Saldo: grant tombada fica inativa — nada gastável; status visível.
      const balance = await balanceOf(x);
      expect(balance.availableCredits).toBe(0);
      expect(balance.grants[0]).toMatchObject({ active: false, purchaseStatus: "REVERSED", remaining: reservedCredits });

      // Retry de estorno (webhook repetido): revoga ZERO, sem segundo débito.
      const retry = await pool.connect();
      try {
        await retry.query("BEGIN");
        expect(await revokeCreditPackageGrant(retry, x.tenant, purchase.invoiceId)).toBe(0);
        await retry.query("COMMIT");
      } catch (error) { await retry.query("ROLLBACK").catch(() => {}); throw error; } finally { retry.release(); }
      expect(await purchaseOf(x)).toMatchObject({ status: "REVERSED", revoked_credits: String(CREDITS - reservedCredits) });
      expect((await grantRow()).consumed_amount).toBe(String(CREDITS - reservedCredits));

      // Nova reserva NÃO volta ao pacote estornado (seletor exige expiração
      // futura): cai na franquia incluída, sem tocar a grant e sem contadores
      // negativos.
      const second = await consumeAiInteraction(x.tenant, "inbound_reply", randomUUID());
      expect(second).toMatchObject({ allowed: true, consumptionType: "INCLUDED" });
      const afterSecond = await grantRow();
      expect(afterSecond.consumed_amount).toBe(String(CREDITS - reservedCredits));
      expect(Number(afterSecond.consumed_amount)).toBeGreaterThanOrEqual(0);
      expect(Number(afterSecond.consumed_amount)).toBeLessThanOrEqual(Number(afterSecond.amount));
      expect(Number((await periodOf(x)).bonus_granted)).toBeGreaterThanOrEqual(0);
    } finally { await clean(x); }
  });

  it("approved atrasado após refund não re-concede nem reabre fatura", async () => {
    const x = await fixture();
    try {
      const purchase = (await buy(x)).json().purchase;
      await chargePix(x, purchase.invoiceId);
      gateway.invoiceRef = `invoice:${purchase.invoiceId}`;
      gateway.status = "approved";
      gateway.transactionAmount = 157;
      expect((await deliver(x, purchase.invoiceId, "pay-late", "payment")).json().status).toBe("processed");
      gateway.status = "refunded";
      expect((await deliver(x, purchase.invoiceId, "pay-late", "payment.updated")).json().status).toBe("processed");
      gateway.status = "approved";
      const lateApproved = await deliver(x, purchase.invoiceId, "pay-late", "payment.approved");
      expect(lateApproved.statusCode).toBe(200);
      expect(await grantsOf(x.tenant)).toHaveLength(1);
      expect((await grantsOf(x.tenant))[0].consumed_amount).toBe(String(CREDITS));
      expect((await purchaseOf(x)).status).toBe("REVERSED");
      expect((await pool.query<{ status: string }>("SELECT status FROM invoices WHERE id=$1", [purchase.invoiceId])).rows[0].status).toBe("refunded");
      expect(await balanceOf(x)).toMatchObject({ availableCredits: 0 });
    } finally { await clean(x); }
  });

  it("dois approved concorrentes com event ids distintos concedem exatamente uma vez", async () => {
    const x = await fixture();
    try {
      const purchase = (await buy(x)).json().purchase;
      await chargePix(x, purchase.invoiceId);
      gateway.invoiceRef = `invoice:${purchase.invoiceId}`;
      const [a, b] = await Promise.all([
        deliver(x, purchase.invoiceId, "pay-race", "payment"),
        deliver(x, purchase.invoiceId, "pay-race", "payment.updated.approved")
      ]);
      for (const r of [a, b]) expect(r.statusCode).toBe(200);
      expect(await grantsOf(x.tenant)).toHaveLength(1);
      expect((await periodOf(x)).bonus_granted).toBe(String(CREDITS));
      expect(await balanceOf(x)).toMatchObject({ availableCredits: CREDITS });
    } finally { await clean(x); }
  });

  it("período em INTERACTION retém o pacote sem inflar bonus_granted", async () => {
    const x = await fixture("LEGACY_UNLIMITED");
    try {
      expect(x.periodUnit).toBe("INTERACTION");
      const purchase = (await buy(x)).json().purchase;
      await chargePix(x, purchase.invoiceId);
      gateway.invoiceRef = `invoice:${purchase.invoiceId}`;
      expect((await deliver(x, purchase.invoiceId, "pay-legacy", "payment")).json().status).toBe("processed");
      const grants = await grantsOf(x.tenant);
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({ amount: String(CREDITS), usage_unit: "CREDIT" });
      expect((await periodOf(x)).bonus_granted).toBe("0");
    } finally { await clean(x); }
  });

  it("replay direto do grant é idempotente: sem bonus duplicado e sem ressuscitar compra REVERSED", async () => {
    const x = await fixture();
    const client = await pool.connect();
    try {
      const purchase = (await buy(x)).json().purchase;
      expect(x.periodUnit).toBe("CREDIT");
      // 1ª concessão (transação própria, como o webhook): INSERT retorna linha → bump único.
      await client.query("BEGIN");
      const first = await grantPaidCreditPackage(client, { tenantId: x.tenant, invoiceId: purchase.invoiceId, credits: CREDITS });
      await client.query("COMMIT");
      expect((await periodOf(x)).bonus_granted).toBe(String(CREDITS));

      // Replay em transação SEPARADA, mesma fatura: ON CONFLICT não retorna
      // linha → bonus_granted NÃO soma de novo.
      await client.query("BEGIN");
      const second = await grantPaidCreditPackage(client, { tenantId: x.tenant, invoiceId: purchase.invoiceId, credits: CREDITS });
      await client.query("COMMIT");
      expect(second.grantId).toBe(first.grantId);
      expect(await grantsOf(x.tenant)).toHaveLength(1);
      expect((await periodOf(x)).bonus_granted).toBe(String(CREDITS));
      expect(await purchaseOf(x)).toMatchObject({ status: "GRANTED" });

      // Estorno total (refunded): revoga tudo, bonus volta a zero.
      await client.query("BEGIN");
      expect(await revokeCreditPackageGrant(client, x.tenant, purchase.invoiceId)).toBe(CREDITS);
      await client.query("COMMIT");
      expect(await purchaseOf(x)).toMatchObject({ status: "REVERSED" });
      expect((await periodOf(x)).bonus_granted).toBe("0");

      // Replay pós-estorno: compra permanece REVERSED (o UPDATE não pode
      // ressuscitar status) e bonus_granted não é inflado pela grant tombada.
      await client.query("BEGIN");
      await grantPaidCreditPackage(client, { tenantId: x.tenant, invoiceId: purchase.invoiceId, credits: CREDITS });
      await client.query("COMMIT");
      expect(await purchaseOf(x)).toMatchObject({ status: "REVERSED" });
      expect(await grantsOf(x.tenant)).toHaveLength(1);
      expect((await periodOf(x)).bonus_granted).toBe("0");
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); await clean(x); }
  });
});
