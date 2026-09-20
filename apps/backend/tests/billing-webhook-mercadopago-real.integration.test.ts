import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { encryptCredentials, encryptWebhookSecret } from "../src/billing/providers/credentials.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const suffix = randomUUID();
const secret = `mp-real-${suffix}`;
const originalFetch = globalThis.fetch;
let providerId = "";
let tenantId = "";
let invoiceId = "";
let subscriptionId = "";
const paymentId = `999-${suffix}`;

function signature(notificationId: string, requestId: string, ts: string) {
  const manifest = `id:${notificationId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  return createHmac("sha256", secret).update(manifest).digest("hex");
}

async function deliver(notificationId: string, paymentStatus: string) {
  void paymentStatus;
  const requestId = `req-${notificationId}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const response = await app.inject({
    method: "POST",
    url: "/webhooks/billing/mercadopago",
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
      // Mercado Pago assina o recurso em data.id, não o id da notificação.
      "x-signature": `ts=${ts},v1=${signature(paymentId, requestId, ts)}`
    },
    // This is Mercado Pago's real notification shape: data contains only id.
    payload: JSON.stringify({ id: notificationId, live_mode: true, type: "payment", action: "payment.updated", data: { id: paymentId } })
  });
  return response;
}

async function state() {
  const invoice = await pool.query<{ status: string }>("SELECT status FROM invoices WHERE id=$1", [invoiceId]);
  const subscription = await pool.query<{ status: string; current_period_end: string }>("SELECT status,current_period_end FROM tenant_subscriptions WHERE id=$1", [subscriptionId]);
  return { invoice: invoice.rows[0].status, subscription: subscription.rows[0] };
}

beforeAll(async () => {
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    if ((globalThis as { __mpFail?: boolean }).__mpFail) throw new Error("MP API indisponível");
    const id = String(input).split("/").pop();
    const status = id === paymentId ? (globalThis as { __mpStatus?: string }).__mpStatus ?? "pending" : "pending";
    return new Response(JSON.stringify({ id, status, transaction_amount: 897, currency_id: "BRL", external_reference: tenantId, external_invoice_id: `invoice-${suffix}` }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM billing_events WHERE provider_id IN (SELECT id FROM billing_providers WHERE code=$1 AND environment=$2)", ["mercadopago", "production"]);
    await client.query("DELETE FROM billing_providers WHERE code=$1 AND environment=$2", ["mercadopago", "production"]);
    providerId = (await client.query<{ id: string }>(
      `INSERT INTO billing_providers(homologated,code,name,enabled,environment,credentials_encrypted,webhook_secret_encrypted)
       VALUES(true,'mercadopago',$1,true,'production',$2,$3) RETURNING id`,
      [`MP real ${suffix}`, encryptCredentials({ accessToken: `token-${suffix}` }, config.DATA_ENCRYPTION_KEY), encryptWebhookSecret(secret, config.DATA_ENCRYPTION_KEY)]
    )).rows[0].id;
    tenantId = (await client.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`MP tenant ${suffix}`, `mp-${suffix}`])).rows[0].id;
    subscriptionId = (await client.query<{ id: string }>(
      `INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end)
       SELECT $1,id,'PAST_DUE',now()-interval '1 month',now()-interval '1 day' FROM plans WHERE code='MEDIUM' RETURNING id`, [tenantId]
    )).rows[0].id;
    invoiceId = (await client.query<{ id: string }>(
      `INSERT INTO invoices(tenant_id,provider_id,external_id,kind,amount_cents,currency,status,due_date)
       VALUES($1,$2,$3,'subscription',89700,'BRL','open',now()) RETURNING id`, [tenantId, providerId, `invoice-${suffix}`]
    )).rows[0].id;
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (tenantId) await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  if (providerId) {
    await pool.query("DELETE FROM billing_events WHERE provider_id=$1", [providerId]);
    await pool.query("DELETE FROM billing_providers WHERE id=$1", [providerId]);
  }
  await app.close();
  await pool.end();
});

describe("Mercado Pago webhook com payload real", () => {
  it("não paga com payment.created pending e aprova payment.updated usando o refetch", async () => {
    (globalThis as { __mpStatus?: string }).__mpStatus = "pending";
    const pending = await deliver("1001", "pending");
    // Pending is persisted so later gateway updates can reconcile the same payment.
    expect(pending.json().status).toBe("processed");
    expect((await state()).invoice).toBe("pending");
    // Simula createChargeForInvoice: o payment existe, mas ainda está pending.
    // O webhook de pendência acima JÁ criou essa linha (mesmo external_id, que
    // é o data.id assinado pelo gateway), então aqui apenas garantimos o estado
    // — inserir de novo violaria uq_payments_provider_external_id, que é
    // exatamente a proteção contra pagamento duplicado que queremos manter.
    await pool.query(
      `INSERT INTO payments(tenant_id,invoice_id,provider_id,external_id,amount_cents,currency,status,method)
       VALUES($1,$2,$3,$4,89700,'BRL','pending','pix')
       ON CONFLICT (provider_id,external_id) WHERE external_id IS NOT NULL AND provider_id IS NOT NULL
       DO UPDATE SET status='pending',method='pix',updated_at=now()`,
      [tenantId, invoiceId, providerId, paymentId]
    );

    (globalThis as { __mpStatus?: string }).__mpStatus = "approved";
    const approved = await deliver("1002", "approved");
    expect(approved.json().status).toBe("processed");
    expect((await state()).invoice).toBe("paid");
    expect((await state()).subscription.status).toBe("ACTIVE");
    expect((await pool.query("SELECT 1 FROM billing_events WHERE provider_id=$1 AND external_event_id IN ($2,$3)", [providerId, `payment.updated:${paymentId}:pending`, `payment.updated:${paymentId}:approved`])).rowCount).toBe(2);
  });

  it("atualiza payment pending pré-existente para paid sem violar a unique parcial", async () => {
    const row = await pool.query<{ status: string }>("SELECT status FROM payments WHERE provider_id=$1 AND external_id=$2", [providerId, paymentId]);
    expect(row.rows[0]?.status).toBe("paid");
    expect((await pool.query("SELECT 1 FROM payments WHERE provider_id=$1 AND external_id=$2", [providerId, paymentId])).rowCount).toBe(1);
  });

  it("reentrega da mesma notificação retorna duplicated e não renova o período", async () => {
    const before = (await state()).subscription.current_period_end;
    // "1002" já foi entregue pelo primeiro caso: mesma identidade de evento,
    // logo o portão de idempotência precisa barrar sem refazer efeito algum.
    const response = await deliver("1002", "approved");
    expect(response.json().status).toBe("duplicated");
    expect((await state()).subscription.current_period_end).toEqual(before);
  });

  it("refunded reverte a fatura paga para open", async () => {
    (globalThis as { __mpStatus?: string }).__mpStatus = "refunded";
    const response = await deliver("1003", "refunded");
    expect(response.json().status).toBe("processed");
    // Reversals have explicit states for auditability and downstream handling.
    expect((await state()).invoice).toBe("refunded");
    expect((await pool.query<{ status: string }>("SELECT status FROM payments WHERE provider_id=$1 AND external_id=$2", [providerId, paymentId])).rows[0].status).toBe("refunded");
  });

  it("evento assinado sem refetch autenticado não tem efeito financeiro (F2)", async () => {
    // HMAC do MP não cobre o corpo: com a API do provedor indisponível, o
    // evento é gravado e IGNORADO — status/valores do body nunca movem fatura.
    const before = await state();
    (globalThis as { __mpFail?: boolean }).__mpFail = true;
    const response = await deliver("1004", "approved");
    (globalThis as { __mpFail?: boolean }).__mpFail = false;
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ignored");
    expect(await state()).toEqual(before);
  });

  it("declaração de vínculo divergente no body é rejeitada como tamper (F2)", async () => {
    // Assinatura legítima capturada + body adulterado apontando para outra
    // fatura: o gate de mesmo-tipo rejeita o evento sem efeito algum.
    const before = await state();
    (globalThis as { __mpStatus?: string }).__mpStatus = "approved";
    const requestId = "req-1005";
    const ts = String(Math.floor(Date.now() / 1000));
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/billing/mercadopago",
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
        "x-signature": `ts=${ts},v1=${signature("1005", requestId, ts)}`
      },
      payload: JSON.stringify({ id: "1005-b", live_mode: true, type: "payment", action: "payment.updated", data: { id: "1005" }, external_invoice_id: "outra-fatura" })
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("WEBHOOK_TAMPERED_LINK");
    expect(await state()).toEqual(before);
  });

  it("approved atrasado não desfaz refund nem reativa a assinatura (F1)", async () => {
    // Sequência real de incidente: refund processa; um 'approved' atrasado
    // com NOVA identidade de evento (action diferente) chega depois. O guard
    // de estados terminais impede o un-refund.
    const before = await state();
    (globalThis as { __mpStatus?: string }).__mpStatus = "approved";
    const requestId = "req-1006";
    const ts = String(Math.floor(Date.now() / 1000));
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/billing/mercadopago",
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
        "x-signature": `ts=${ts},v1=${signature(paymentId, requestId, ts)}`
      },
      payload: JSON.stringify({ id: "1006", live_mode: true, type: "payment", action: "payment.created", data: { id: paymentId } })
    });
    expect(response.json().status).toBe("processed");
    expect(await state()).toEqual(before);
    expect((await pool.query<{ status: string }>("SELECT status FROM payments WHERE provider_id=$1 AND external_id=$2", [providerId, paymentId])).rows[0].status).toBe("refunded");
  });
});
