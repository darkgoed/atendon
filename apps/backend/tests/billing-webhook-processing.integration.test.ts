import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { encryptCredentials, encryptWebhookSecret } from "../src/billing/providers/credentials.js";

/**
 * §18 — o webhook de cobrança precisa ser idempotente de verdade.
 *
 * Não basta contar linhas de `payments`: uma reentrega poderia renovar a
 * assinatura duas vezes e empurrar `current_period_end` para frente sem cobrar de
 * novo. Por isso o teste compara o período ANTES e DEPOIS da segunda entrega.
 */
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const suffix = randomUUID();
const webhookSecret = "webhook-secret-de-teste";

let providerId = "";
let tenantId = "";
let invoiceId = "";

function sign(resourceId: string, requestId: string, ts: string) {
  const manifest = `id:${resourceId};request-id:${requestId};ts:${ts};`;
  return createHmac("sha256", webhookSecret).update(manifest).digest("hex");
}

async function deliver(resourceId: string, status: string, signature?: string) {
  const requestId = `req-${resourceId}`;
  const ts = "1700000000";
  const v1 = signature ?? sign(resourceId, requestId, ts);
  return app.inject({
    method: "POST",
    url: "/webhooks/billing/mercadopago",
    headers: {
      "content-type": "application/json",
      "x-signature": `ts=${ts},v1=${v1}`,
      "x-request-id": requestId
    },
    payload: JSON.stringify({ type: "payment", data: { id: resourceId, status }, external_reference: tenantId })
  });
}

async function subscription() {
  return (await pool.query<{ status: string; current_period_end: string }>(
    "SELECT status,current_period_end FROM tenant_subscriptions WHERE tenant_id=$1",
    [tenantId]
  )).rows[0];
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    providerId = (await client.query<{ id: string }>(
      `INSERT INTO billing_providers(code,name,enabled,environment,credentials_encrypted,webhook_secret_encrypted)
       VALUES('mercadopago','Mercado Pago',true,'sandbox',$1,$2) RETURNING id`,
      [
        encryptCredentials({ accessToken: "token-de-teste" }, config.DATA_ENCRYPTION_KEY),
        encryptWebhookSecret(webhookSecret, config.DATA_ENCRYPTION_KEY)
      ]
    )).rows[0].id;
    tenantId = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id",
      [`webhook-${suffix}`, `webhook-${suffix}`]
    )).rows[0].id;
    // Assinatura inadimplente: o pagamento aprovado deve reativá-la.
    await client.query(
      `INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end)
       SELECT $1,id,'PAST_DUE',now() - interval '1 month',now() - interval '1 day' FROM plans WHERE code='MEDIUM'`,
      [tenantId]
    );
    invoiceId = (await client.query<{ id: string }>(
      `INSERT INTO invoices(tenant_id,provider_id,external_id,kind,amount_cents,currency,status,due_date)
       VALUES($1,$2,$3,'subscription',89700,'BRL','open',now()) RETURNING id`,
      [tenantId, providerId, `pay-${suffix}`]
    )).rows[0].id;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await pool.query("DELETE FROM billing_events WHERE provider_id=$1", [providerId]);
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.query("DELETE FROM billing_providers WHERE id=$1", [providerId]);
  await app.close();
  await pool.end();
});

describe("webhook de cobrança (§18)", () => {
  it("rejeita assinatura inválida sem qualquer efeito financeiro", async () => {
    const response = await deliver(`pay-${suffix}`, "approved", "f".repeat(64));
    expect(response.statusCode).toBe(401);
    const invoice = await pool.query<{ status: string }>("SELECT status FROM invoices WHERE id=$1", [invoiceId]);
    expect(invoice.rows[0].status).toBe("open");
    const payments = await pool.query("SELECT 1 FROM payments WHERE invoice_id=$1", [invoiceId]);
    expect(payments.rowCount).toBe(0);
  });

  it("processa aprovação, paga a fatura e reativa a assinatura", async () => {
    expect((await subscription()).status).toBe("PAST_DUE");
    const response = await deliver(`pay-${suffix}`, "approved");
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("processed");

    const invoice = await pool.query<{ status: string }>("SELECT status FROM invoices WHERE id=$1", [invoiceId]);
    expect(invoice.rows[0].status).toBe("paid");
    const payments = await pool.query("SELECT 1 FROM payments WHERE invoice_id=$1 AND status='paid'", [invoiceId]);
    expect(payments.rowCount).toBe(1);
    expect((await subscription()).status).toBe("ACTIVE");
  });

  it("evento REPETIDO não duplica pagamento nem renova de novo", async () => {
    const before = await subscription();
    const response = await deliver(`pay-${suffix}`, "approved");
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("duplicated");

    // Exatamente 1 evento, 1 pagamento e 1 fatura paga.
    const events = await pool.query(
      "SELECT 1 FROM billing_events WHERE provider_id=$1 AND external_event_id=$2",
      [providerId, `pay-${suffix}`]
    );
    expect(events.rowCount).toBe(1);
    const payments = await pool.query("SELECT 1 FROM payments WHERE invoice_id=$1", [invoiceId]);
    expect(payments.rowCount).toBe(1);

    // O ponto que contagem de linhas não pegaria: o período NÃO pode ter avançado.
    const after = await subscription();
    expect(after.current_period_end).toEqual(before.current_period_end);
    expect(after.status).toBe("ACTIVE");
  });

  it("provider desconhecido responde erro tratado, sem derrubar o servidor", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/billing/provider-inexistente",
      headers: { "content-type": "application/json", "x-signature": "ts=1,v1=abc", "x-request-id": "r" },
      payload: JSON.stringify({ type: "payment", data: { id: "x" } })
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("BILLING_PROVIDER_NOT_FOUND");
  });
});
