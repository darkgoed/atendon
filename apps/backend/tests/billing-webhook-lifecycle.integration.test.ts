import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { processBillingWebhook } from "../src/billing/webhook-service.js";
import { encryptCredentials, encryptWebhookSecret } from "../src/billing/providers/credentials.js";
import { acquireSharedProviderLock, SHARED_PROVIDER_LOCK_TIMEOUT_MS } from "./helpers/shared-provider-lock.js";

/**
 * Efeito do webhook autenticado do Mercado Pago no CICLO DE VIDA da assinatura:
 * só uma recusa de recebível de assinatura ainda aberto gera inadimplência, e
 * quitar qualquer fatura da assinatura (uso, prorrata) tira do PAST_DUE.
 */
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const secret = "webhook-lifecycle-secret";
const runId = randomUUID().slice(0, 8);
const remote = new Map<string, { status: string; amountCents: number; ref: string }>();
const tenants: string[] = [];
const originalFetch = globalThis.fetch;
let providerId = "";
let saved: { credentials_encrypted: string | null; webhook_secret_encrypted: string | null; enabled: boolean; status: string; homologated: boolean } | null = null;

let releaseSharedProviderLock: (() => Promise<void>) | undefined;
beforeAll(async () => { releaseSharedProviderLock = await acquireSharedProviderLock(); }, SHARED_PROVIDER_LOCK_TIMEOUT_MS);
afterAll(async () => { await releaseSharedProviderLock?.(); });

beforeAll(async () => {
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const id = decodeURIComponent(String(input).split("/").pop() ?? "");
    const r = remote.get(id);
    if (!r) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ id, status: r.status, transaction_amount: r.amountCents / 100, currency_id: "BRL", external_reference: r.ref }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const credentials = encryptCredentials({ accessToken: "token-lifecycle" }, config.DATA_ENCRYPTION_KEY);
  const webhookSecret = encryptWebhookSecret(secret, config.DATA_ENCRYPTION_KEY);
  const existing = (await pool.query<{ id: string; credentials_encrypted: string | null; webhook_secret_encrypted: string | null; enabled: boolean; status: string; homologated: boolean }>(
    "SELECT id,credentials_encrypted,webhook_secret_encrypted,enabled,status,homologated FROM billing_providers WHERE code='mercadopago' AND environment='production'")).rows[0];
  if (existing) {
    saved = existing; providerId = existing.id;
    await pool.query("UPDATE billing_providers SET credentials_encrypted=$2,webhook_secret_encrypted=$3,enabled=true,homologated=true,status='CONNECTED' WHERE id=$1", [providerId, credentials, webhookSecret]);
  } else {
    providerId = (await pool.query<{ id: string }>("INSERT INTO billing_providers(homologated,code,name,enabled,environment,status,credentials_encrypted,webhook_secret_encrypted) VALUES(true,'mercadopago','Mercado Pago',true,'production','CONNECTED',$1,$2) RETURNING id", [credentials, webhookSecret])).rows[0].id;
  }
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenants]);
  if (saved) await pool.query("UPDATE billing_providers SET credentials_encrypted=$2,webhook_secret_encrypted=$3,enabled=$4,status=$5,homologated=$6 WHERE id=$1", [providerId, saved.credentials_encrypted, saved.webhook_secret_encrypted, saved.enabled, saved.status, saved.homologated]);
  await pool.end();
});

async function fixture(kind: string, status = "ACTIVE") {
  const key = randomUUID();
  const tenant = (await pool.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$1,'active') RETURNING id", [`webhook-lifecycle-${key}`])).rows[0].id;
  tenants.push(tenant);
  const sub = (await pool.query<{ id: string }>("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end,grace_period_ends_at) SELECT $1,id,$2,now(),now()+interval '1 month',CASE WHEN $2='ACTIVE' THEN NULL ELSE now()+interval '7 days' END FROM plans WHERE code='BASIC' RETURNING id", [tenant, status])).rows[0].id;
  return { tenant, sub, invoice: (k = kind) => newInvoice(tenant, k === "credit_package" ? null : sub, k) };
}
async function newInvoice(tenant: string, sub: string | null, kind: string) {
  const id = randomUUID();
  await pool.query("INSERT INTO invoices(id,tenant_id,subscription_id,provider_id,external_id,kind,amount_cents,currency,status) VALUES($1,$2,$3,$4,$5,$6,1000,'BRL','pending')", [id, tenant, sub, providerId, `invoice:${id}`, kind]);
  return id;
}
async function pendingPayment(tenant: string, invoice: string) {
  const externalId = `${runId}-${randomUUID()}`;
  await pool.query("INSERT INTO payments(tenant_id,invoice_id,provider_id,external_id,amount_cents,currency,status,method,created_at) VALUES($1,$2,$3,$4,1000,'BRL','pending','pix',now()-interval '13 hours')", [tenant, invoice, providerId, externalId]);
  return externalId;
}
async function deliver(paymentId: string, invoice: string, status: string) {
  remote.set(paymentId, { status, amountCents: 1000, ref: `invoice:${invoice}` });
  const requestId = `req-${paymentId}-${status}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const v1 = createHmac("sha256", secret).update(`id:${paymentId.toLowerCase()};request-id:${requestId};ts:${ts};`).digest("hex");
  return processBillingWebhook("mercadopago", JSON.stringify({ type: "payment", action: "payment.updated", data: { id: paymentId } }),
    { "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": requestId }, config.DATA_ENCRYPTION_KEY);
}
async function subStatus(sub: string) { return (await pool.query<{ status: string }>("SELECT status FROM tenant_subscriptions WHERE id=$1", [sub])).rows[0].status; }

describe("webhook de pagamento e ciclo de vida da assinatura", () => {
  it("C2: Pix expirado (cancelled) de pacote de créditos não coloca a assinatura em PAST_DUE", async () => {
    const x = await fixture("credit_package");
    const invoice = await x.invoice();
    const pay = await pendingPayment(x.tenant, invoice);
    expect(await deliver(pay, invoice, "cancelled")).toMatchObject({ status: "processed" });
    expect(await subStatus(x.sub)).toBe("ACTIVE");
  });

  it("C2: Pix antigo cancelado de uma fatura já paga por outro pagamento não gera inadimplência", async () => {
    const x = await fixture("subscription");
    const invoice = await x.invoice();
    const stale = await pendingPayment(x.tenant, invoice);
    const fresh = `${runId}-${randomUUID()}`;
    await pool.query("INSERT INTO payments(tenant_id,invoice_id,provider_id,external_id,amount_cents,currency,status,method) VALUES($1,$2,$3,$4,1000,'BRL','pending','pix')", [x.tenant, invoice, providerId, fresh]);
    await deliver(fresh, invoice, "approved");
    expect((await pool.query<{ status: string }>("SELECT status FROM invoices WHERE id=$1", [invoice])).rows[0].status).toBe("paid");
    await deliver(stale, invoice, "cancelled");
    expect(await subStatus(x.sub)).toBe("ACTIVE");
  });

  it("C7: pagar a fatura de uso de uma assinatura PAST_DUE reativa quando não resta dívida vencida", async () => {
    const x = await fixture("usage", "PAST_DUE");
    const invoice = await x.invoice();
    const pay = await pendingPayment(x.tenant, invoice);
    await deliver(pay, invoice, "approved");
    expect(await subStatus(x.sub)).toBe("ACTIVE");
  });

  it("C7: pagamento aprovado não reativa enquanto outra fatura da assinatura segue vencida", async () => {
    const x = await fixture("usage", "PAST_DUE");
    const invoice = await x.invoice();
    const overdue = await x.invoice("subscription");
    await pool.query("UPDATE invoices SET due_date=now()-interval '2 days' WHERE id=$1", [overdue]);
    const pay = await pendingPayment(x.tenant, invoice);
    await deliver(pay, invoice, "approved");
    expect(await subStatus(x.sub)).toBe("PAST_DUE");
  });

  it("S3: chargebacks repetidos do mesmo tenant geram sinal antifraude REPEATED_CHARGEBACK", async () => {
    const x = await fixture("subscription");
    for (let i = 0; i < 2; i++) {
      const invoice = await x.invoice();
      const pay = await pendingPayment(x.tenant, invoice);
      await deliver(pay, invoice, "approved");
      await deliver(pay, invoice, "charged_back");
    }
    expect((await pool.query("SELECT 1 FROM fraud_signals WHERE tenant_id=$1 AND signal_type='REPEATED_CHARGEBACK'", [x.tenant])).rowCount).toBeGreaterThan(0);
  });
});
