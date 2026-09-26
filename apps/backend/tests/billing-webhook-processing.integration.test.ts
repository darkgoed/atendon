import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { encryptCredentials, encryptWebhookSecret } from "../src/billing/providers/credentials.js";
import { acquireSharedProviderLock, SHARED_PROVIDER_LOCK_TIMEOUT_MS } from "./helpers/shared-provider-lock.js";

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
const webhookSecret = "webhook-secret-production";
const sandboxWebhookSecret = "webhook-secret-sandbox";
const originalFetch = globalThis.fetch;

let providerId = "";
let sandboxProviderId = "";
let tenantId = "";
let invoiceId = "";

// Linhas reais de mercadopago podem já ter billing_events (FK
// billing_events_provider_id_fkey) — nunca DELETE: snapshot + UPDATE in-place
// com restore no afterAll; INSERT apenas quando a linha não existe.
type ProviderSnap = {
  id: string;
  existed: boolean;
  credentials_encrypted: string | null;
  webhook_secret_encrypted: string | null;
  enabled: boolean;
  homologated: boolean;
  last_event_at: string | null;
};
let sandboxSnap: ProviderSnap | undefined;
let prodSnap: ProviderSnap | undefined;
let suiteStartedAt = "";

function signWithSecret(secret: string, resourceId: string, requestId: string, ts: string) {
  const manifest = `id:${resourceId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  return createHmac("sha256", secret).update(manifest).digest("hex");
}

function sign(resourceId: string, requestId: string, ts: string) {
  return signWithSecret(webhookSecret, resourceId, requestId, ts);
}

async function deliver(resourceId: string, status: string, signature?: string, timestamp = String(Math.floor(Date.now() / 1000))) {
  const requestId = `req-${resourceId}`;
  const ts = timestamp;
  const v1 = signature ?? sign(resourceId, requestId, ts);
  return app.inject({
    method: "POST",
    url: "/webhooks/billing/mercadopago",
    headers: {
      "content-type": "application/json",
      "x-signature": `ts=${ts},v1=${v1}`,
      "x-request-id": requestId
    },
    payload: JSON.stringify({ type: "payment", data: { id: resourceId, status, amount_cents: 89700, currency_id: "BRL", external_reference: tenantId, external_invoice_id: `pay-${suffix}` }, external_reference: tenantId })
  });
}

async function subscription() {
  return (await pool.query<{ status: string; current_period_end: string }>(
    "SELECT status,current_period_end FROM tenant_subscriptions WHERE tenant_id=$1",
    [tenantId]
  )).rows[0];
}

// Serializa com as outras suítes que mexem na linha global billing_providers(mercadopago).
let releaseSharedProviderLock: (() => Promise<void>) | undefined;
beforeAll(async () => { releaseSharedProviderLock = await acquireSharedProviderLock(); }, SHARED_PROVIDER_LOCK_TIMEOUT_MS);
afterAll(async () => { await releaseSharedProviderLock?.(); });

beforeAll(async () => {
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const id = String(input).split("/").pop();
    const status = id?.startsWith("current-") ? "pending" : "approved";
    return new Response(JSON.stringify({ id, status, transaction_amount: 897, currency_id: "BRL", external_invoice_id: `pay-${suffix}` }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    suiteStartedAt = (await client.query<{ t: string }>("SELECT now() AS t")).rows[0].t;
    const fixProvider = async (environment: string, credentials: string, secret: string): Promise<ProviderSnap> => {
      const existing = (await client.query<{
        id: string; credentials_encrypted: string | null; webhook_secret_encrypted: string | null; enabled: boolean; homologated: boolean; last_event_at: string | null;
      }>(
        `SELECT id,credentials_encrypted,webhook_secret_encrypted,enabled,homologated,last_event_at
         FROM billing_providers WHERE code=$1 AND environment=$2 FOR UPDATE`,
        ["mercadopago", environment]
      )).rows[0];
      if (existing) {
        await client.query(
          `UPDATE billing_providers
           SET credentials_encrypted=$2,webhook_secret_encrypted=$3,enabled=true,homologated=true,last_event_at=NULL
           WHERE id=$1`,
          [existing.id, credentials, secret]
        );
        return { existed: true, ...existing };
      }
      return {
        existed: false,
        id: (await client.query<{ id: string }>(
          `INSERT INTO billing_providers(homologated,code,name,enabled,environment,credentials_encrypted,webhook_secret_encrypted)
           VALUES(true,'mercadopago','Mercado Pago',true,$1,$2,$3) RETURNING id`,
          [environment, credentials, secret]
        )).rows[0].id,
        credentials_encrypted: null,
        webhook_secret_encrypted: null,
        enabled: false,
        homologated: false,
        last_event_at: null
      };
    };
    sandboxSnap = await fixProvider(
      "sandbox",
      encryptCredentials({ accessToken: "token-sandbox" }, config.DATA_ENCRYPTION_KEY),
      encryptWebhookSecret(sandboxWebhookSecret, config.DATA_ENCRYPTION_KEY)
    );
    sandboxProviderId = sandboxSnap.id;
    prodSnap = await fixProvider(
      "production",
      encryptCredentials({ accessToken: "token-production" }, config.DATA_ENCRYPTION_KEY),
      encryptWebhookSecret(webhookSecret, config.DATA_ENCRYPTION_KEY)
    );
    providerId = prodSnap.id;
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
  globalThis.fetch = originalFetch;
  // Cleanup apenas do que esta suíte gerou: eventos com o suffix da run e
  // rejeições invalid:% criadas dentro da janela da suíte. NUNCA DELETE de
  // todos os eventos do provider — linhas reais/outras suítes os referenciam.
  for (const snap of [sandboxSnap, prodSnap]) {
    if (!snap) continue;
    if (snap.existed) {
      await pool.query(
        `DELETE FROM billing_events
         WHERE provider_id=$1
           AND (external_event_id LIKE $2 OR (external_event_id LIKE 'invalid:%' AND created_at >= $3::timestamptz))`,
        [snap.id, `%${suffix}%`, suiteStartedAt]
      );
    } else {
      await pool.query("DELETE FROM billing_events WHERE provider_id=$1", [snap.id]);
    }
  }
  if (tenantId) {
    await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  }
  for (const snap of [sandboxSnap, prodSnap]) {
    if (!snap) continue;
    if (snap.existed) {
      await pool.query(
        `UPDATE billing_providers
         SET credentials_encrypted=$2,webhook_secret_encrypted=$3,enabled=$4,homologated=$5,last_event_at=$6
         WHERE id=$1`,
        [snap.id, snap.credentials_encrypted, snap.webhook_secret_encrypted, snap.enabled, snap.homologated, snap.last_event_at]
      );
    } else {
      await pool.query("DELETE FROM billing_providers WHERE id=$1", [snap.id]);
    }
  }
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

  it("usa deterministicamente production: assinatura sandbox não altera finanças nem last_event_at sandbox", async () => {
    const resourceId = `sandbox-${suffix}`;
    const response = await deliver(resourceId, "approved", signWithSecret(sandboxWebhookSecret, resourceId, `req-${resourceId}`, "1700000000"));
    expect(response.statusCode).toBe(401);
    const rows = await pool.query<{ id: string; last_event_at: string | null }>(
      "SELECT id,last_event_at FROM billing_providers WHERE code=$1 ORDER BY environment",
      ["mercadopago"]
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.find((row) => row.id === sandboxProviderId)?.last_event_at).toBeNull();
    expect(rows.rows.find((row) => row.id === providerId)?.last_event_at).toBeNull();
    expect((await pool.query("SELECT 1 FROM payments WHERE invoice_id=$1", [invoiceId])).rowCount).toBe(0);
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
    const providerTimes = await pool.query<{ id: string; last_event_at: string | null }>(
      "SELECT id,last_event_at FROM billing_providers WHERE code=$1",
      ["mercadopago"]
    );
    expect(providerTimes.rows.find((row) => row.id === providerId)?.last_event_at).not.toBeNull();
    expect(providerTimes.rows.find((row) => row.id === sandboxProviderId)?.last_event_at).toBeNull();
  });

  it("rejeita webhook fora da tolerância, mas aceita timestamp atual assinado", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stale = await deliver(`stale-${suffix}`, "approved", undefined, String(now - 301));
    expect(stale.statusCode).toBe(401);

    const current = await deliver(`current-${suffix}`, "pending", undefined, String(now));
    expect(current.statusCode).not.toBe(401);
  });

  it("evento REPETIDO não duplica pagamento nem renova de novo", async () => {
    const before = await subscription();
    // O caso "processa aprovação..." acima já entregou este mesmo evento, então
    // esta é a REENTREGA — e ela precisa cair no portão de idempotência.
    const response = await deliver(`pay-${suffix}`, "approved");
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("duplicated");

    // Exatamente 1 evento, 1 pagamento e 1 fatura paga.
    const events = await pool.query(
      "SELECT 1 FROM billing_events WHERE provider_id=$1 AND external_event_id=$2",
      // Chave de dedupe nova (action:resource:status): o id da notificação não
      // é assinado pelo MP e não pode servir de identidade de idempotência.
      [providerId, `payment:pay-${suffix}:approved`]
    );
    expect(events.rowCount).toBe(1);
    const payments = await pool.query("SELECT 1 FROM payments WHERE invoice_id=$1", [invoiceId]);
    expect(payments.rowCount).toBe(1);

    // O ponto que contagem de linhas não pegaria: o período NÃO pode ter avançado.
    const after = await subscription();
    expect(after.current_period_end).toEqual(before.current_period_end);
    expect(after.status).toBe("ACTIVE");
  });

  it("rejeições repetidas de assinatura inválida produzem no máximo uma entrada por provider+janela, sem efeito financeiro", async () => {
    // Mesma janela horária UTC do serviço (invalid:YYYYMMDDHH) e sempre do
    // provider desta suíte: sem o filtro, contagens de outros providers/suítes
    // vazam para as asserções.
    const windowEventId = `invalid:${new Date().toISOString().slice(0, 13).replace(/\D/g, "")}`;
    const invalidRows = () =>
      pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM billing_events
         WHERE provider_id=$1 AND external_event_id=$2`,
        [providerId, windowEventId]
      );
    const before = await invalidRows();
    // O teste anterior já pagou esta fatura — compare com o antes, sem hardcode.
    const invoiceBefore = await pool.query<{ status: string }>("SELECT status FROM invoices WHERE id=$1", [invoiceId]);
    const paymentsBefore = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM payments WHERE invoice_id=$1", [invoiceId]);

    // Três tentativas na mesma janela: duas idênticas e uma diferente.
    const identicalSignature = "f".repeat(64);
    const attempts = [
      await deliver(`inv-att-${suffix}`, "approved", identicalSignature),
      await deliver(`inv-att-${suffix}`, "approved", identicalSignature),
      await deliver(`other-att-${suffix}`, "pending", "0".repeat(64))
    ];
    for (const response of attempts) {
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("INVALID_WEBHOOK_SIGNATURE");
    }

    // No máximo UMA nova linha de rejeição, mesmo com 3 tentativas.
    const afterRows = await invalidRows();
    expect(afterRows.rows[0].n - before.rows[0].n).toBeLessThanOrEqual(1);

    // A linha da janela registra o contador de tentativas (auditoria preservada).
    const rejection = await pool.query<{ attempts: string | null }>(
      `SELECT payload->>'attempts' AS attempts FROM billing_events
       WHERE provider_id=$1 AND external_event_id=$2`,
      [providerId, windowEventId]
    );
    expect(parseInt(rejection.rows[0].attempts ?? "0", 10)).toBeGreaterThanOrEqual(3);

    // Nenhum efeito financeiro: fatura e pagamentos iguais ao estado anterior.
    const invoiceAfter = await pool.query<{ status: string }>("SELECT status FROM invoices WHERE id=$1", [invoiceId]);
    expect(invoiceAfter.rows[0].status).toBe(invoiceBefore.rows[0].status);
    const paymentsAfter = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM payments WHERE invoice_id=$1", [invoiceId]);
    expect(paymentsAfter.rows[0].n).toBe(paymentsBefore.rows[0].n);
  });

  it("provider desconhecido responde erro tratado, sem derrubar o servidor", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/billing/provider-inexistente",
      headers: { "content-type": "application/json", "x-signature": "ts=1,v1=abc", "x-request-id": "r" },
      payload: JSON.stringify({ type: "payment", data: { id: "x" } })
    });
    // Desde a homologação de gateways, um código desconhecido é barrado na
    // borda (400 PROVIDER_NOT_HOMOLOGATED) antes de qualquer consulta ao banco:
    // a rota pública só aceita códigos homologados. O ponto do teste continua
    // valendo — erro tratado, servidor de pé.
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("PROVIDER_NOT_HOMOLOGATED");
  });
});
