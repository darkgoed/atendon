import type { PoolClient } from "pg";
import { db } from "../db/client.js";
import { getProvider } from "./providers/registry.js";
import type { WebhookResult } from "./providers/types.js";

/**
 * Processamento idempotente de webhook de cobrança (§18).
 *
 * A garantia central é a UNIQUE(provider_id, external_event_id) de `billing_events`:
 * o INSERT ... ON CONFLICT DO NOTHING é o portão. Se ele não inseriu, o evento já
 * foi processado antes e NADA é refeito — é isso que impede pagamento duplicado,
 * assinatura renovada duas vezes ou plano alterado indevidamente por reentrega.
 *
 * Todo o efeito financeiro roda dentro da MESMA transação do INSERT do evento:
 * ou o evento e seus efeitos existem juntos, ou nada existe. Se o processamento
 * falhar, gravamos `processing_error` fora da transação e propagamos o erro, para
 * que o provider reenvie (retry seguro) sem que o evento fique marcado como pago.
 */

export type WebhookOutcome = {
  status: "processed" | "duplicated" | "invalid_signature" | "ignored";
  eventId?: string;
  eventType?: string;
};

type ProviderRow = {
  id: string;
  code: string;
  enabled: boolean;
  credentials_encrypted: string | null;
  webhook_secret_encrypted: string | null;
};

type InvoiceRow = {
  id: string;
  tenant_id: string;
  subscription_id: string | null;
  amount_cents: string;
  currency: string;
  status: string;
};

type SubscriptionRow = {
  id: string;
  status: string;
  current_period_end: string | null;
  billing_period_months: number;
  grace_period_days: number;
  plan_id: string;
};

const APPROVED = new Set(["payment.approved", "approved", "payment.updated.approved", "accredited"]);
const REJECTED = new Set(["payment.rejected", "rejected", "cancelled", "charged_back"]);

function httpError(statusCode: number, message: string, code?: string) {
  return Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) });
}

/** Classifica o evento sem depender do nome comercial de um gateway específico. */
function classify(eventType: string, payload: unknown): "approved" | "rejected" | "ignored" {
  const status = String(
    (payload as { data?: { status?: unknown }; status?: unknown })?.data?.status ??
    (payload as { status?: unknown })?.status ?? ""
  ).toLowerCase();
  const key = eventType.toLowerCase();
  if (APPROVED.has(key) || APPROVED.has(status)) return "approved";
  if (REJECTED.has(key) || REJECTED.has(status)) return "rejected";
  return "ignored";
}

function externalPaymentId(payload: unknown, fallback: string): string {
  const data = (payload as { data?: { id?: unknown } })?.data;
  return String(data?.id ?? (payload as { id?: unknown })?.id ?? fallback);
}

async function loadProvider(code: string): Promise<ProviderRow> {
  const result = await db.query<ProviderRow>(
    "SELECT id,code,enabled,credentials_encrypted,webhook_secret_encrypted FROM billing_providers WHERE code=$1",
    [code]
  );
  const provider = result.rows[0];
  if (!provider) throw httpError(404, "Provedor de cobrança não encontrado", "BILLING_PROVIDER_NOT_FOUND");
  if (!provider.enabled) throw httpError(409, "Provedor de cobrança desativado", "BILLING_PROVIDER_DISABLED");
  return provider;
}

async function parseWebhook(provider: ProviderRow, rawBody: string, headers: Record<string, string | string[] | undefined>, encryptionKey: string): Promise<WebhookResult> {
  // O provider decripta as credenciais sozinho a partir do campo cifrado; nenhum
  // segredo em claro trafega por aqui.
  const instance = getProvider(provider.code, {
    mercadopago: {
      credentialsEncrypted: provider.credentials_encrypted ?? "",
      webhookSecretEncrypted: provider.webhook_secret_encrypted ?? undefined,
      encryptionKey
    }
  });
  return instance.handleWebhook(rawBody, headers, "");
}

/** Marca a fatura como paga, registra o pagamento e reativa a assinatura se aplicável. */
async function applyApproved(client: PoolClient, provider: ProviderRow, result: WebhookResult): Promise<void> {
  const externalId = externalPaymentId(result.payload, result.externalEventId);
  const invoice = await client.query<InvoiceRow>(
    `SELECT id,tenant_id,subscription_id,amount_cents,currency,status FROM invoices
     WHERE provider_id=$1 AND (external_id=$2 OR ($3::uuid IS NOT NULL AND tenant_id=$3::uuid AND status<>'paid'))
     ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [provider.id, externalId, result.tenantHint ?? null]
  );
  const row = invoice.rows[0];
  if (!row) return; // Pagamento sem fatura correspondente: já registrado em billing_events.

  await client.query(
    `INSERT INTO payments(tenant_id,invoice_id,provider_id,external_id,amount_cents,currency,status,method,paid_at)
     VALUES($1,$2,$3,$4,$5,$6,'paid',$7,now())`,
    [row.tenant_id, row.id, provider.id, externalId, row.amount_cents, row.currency, "webhook"]
  );
  await client.query("UPDATE invoices SET status='paid',paid_at=now(),updated_at=now() WHERE id=$1", [row.id]);

  const subscription = await client.query<SubscriptionRow>(
    `SELECT s.id,s.status,s.current_period_end,s.plan_id,p.billing_period_months,p.grace_period_days
     FROM tenant_subscriptions s JOIN plans p ON p.id=s.plan_id
     WHERE s.tenant_id=$1 FOR UPDATE`,
    [row.tenant_id]
  );
  const sub = subscription.rows[0];
  if (!sub) return;

  // Pagamento em dia só reativa quem estava inadimplente; não mexe em quem já está ACTIVE.
  if (sub.status === "PAST_DUE" || sub.status === "GRACE_PERIOD" || sub.status === "SUSPENDED") {
    await client.query(
      `UPDATE tenant_subscriptions
       SET status='ACTIVE', grace_period_ends_at=NULL,
           current_period_start=now(),
           current_period_end=now() + ($2 || ' months')::interval,
           updated_at=now()
       WHERE id=$1`,
      [sub.id, String(sub.billing_period_months ?? 1)]
    );
    await client.query(
      `INSERT INTO subscription_events(tenant_id,subscription_id,event_type,from_plan_id,to_plan_id,from_status,to_status,metadata)
       VALUES($1,$2,'PAYMENT_APPROVED',$3,$3,$4,'ACTIVE',$5)`,
      [row.tenant_id, sub.id, sub.plan_id, sub.status, { invoiceId: row.id }]
    );
  }
}

/** Falha de pagamento não corta acesso na hora: entra em PAST_DUE com carência (§11). */
async function applyRejected(client: PoolClient, provider: ProviderRow, result: WebhookResult): Promise<void> {
  const externalId = externalPaymentId(result.payload, result.externalEventId);
  const invoice = await client.query<InvoiceRow>(
    `SELECT id,tenant_id,subscription_id,amount_cents,currency,status FROM invoices
     WHERE provider_id=$1 AND (external_id=$2 OR ($3::uuid IS NOT NULL AND tenant_id=$3::uuid AND status<>'paid'))
     ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [provider.id, externalId, result.tenantHint ?? null]
  );
  const row = invoice.rows[0];
  if (!row) return;

  // Registra a tentativa recusada, mas NUNCA marca a fatura como paga.
  await client.query(
    `INSERT INTO payments(tenant_id,invoice_id,provider_id,external_id,amount_cents,currency,status,method)
     VALUES($1,$2,$3,$4,$5,$6,'rejected',$7)`,
    [row.tenant_id, row.id, provider.id, externalId, row.amount_cents, row.currency, "webhook"]
  );

  const subscription = await client.query<SubscriptionRow>(
    `SELECT s.id,s.status,s.current_period_end,s.plan_id,p.billing_period_months,p.grace_period_days
     FROM tenant_subscriptions s JOIN plans p ON p.id=s.plan_id
     WHERE s.tenant_id=$1 FOR UPDATE`,
    [row.tenant_id]
  );
  const sub = subscription.rows[0];
  if (!sub || sub.status !== "ACTIVE") return;

  await client.query(
    `UPDATE tenant_subscriptions
     SET status='PAST_DUE', grace_period_ends_at=now() + ($2 || ' days')::interval, updated_at=now()
     WHERE id=$1`,
    [sub.id, String(sub.grace_period_days ?? 7)]
  );
  await client.query(
    `INSERT INTO subscription_events(tenant_id,subscription_id,event_type,from_plan_id,to_plan_id,from_status,to_status,metadata)
     VALUES($1,$2,'PAYMENT_REJECTED',$3,$3,'ACTIVE','PAST_DUE',$4)`,
    [row.tenant_id, sub.id, sub.plan_id, { invoiceId: row.id }]
  );
}

export async function processBillingWebhook(
  providerCode: string,
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  encryptionKey: string
): Promise<WebhookOutcome> {
  const provider = await loadProvider(providerCode);
  const result = await parseWebhook(provider, rawBody, headers, encryptionKey);

  // Assinatura inválida: registra a tentativa para auditoria, sem QUALQUER efeito financeiro.
  if (!result.signatureValid) {
    await db.query(
      `INSERT INTO billing_events(provider_id,external_event_id,event_type,payload,signature_valid)
       VALUES($1,$2,$3,$4,false) ON CONFLICT (provider_id,external_event_id) DO NOTHING`,
      [provider.id, `invalid:${result.externalEventId}:${Date.now()}`, result.eventType, result.payload]
    );
    throw httpError(401, "Assinatura de webhook inválida", "INVALID_WEBHOOK_SIGNATURE");
  }

  const client = await db.connect();
  let eventId: string | undefined;
  try {
    await client.query("BEGIN");
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO billing_events(provider_id,external_event_id,event_type,payload,signature_valid,tenant_id)
       VALUES($1,$2,$3,$4,true,$5)
       ON CONFLICT (provider_id,external_event_id) DO NOTHING
       RETURNING id`,
      [provider.id, result.externalEventId, result.eventType, result.payload, result.tenantHint ?? null]
    );
    // Portão de idempotência: se não inseriu, este evento já foi processado.
    if (!inserted.rowCount) {
      await client.query("ROLLBACK");
      return { status: "duplicated", eventType: result.eventType };
    }
    eventId = inserted.rows[0].id;

    const kind = classify(result.eventType, result.payload);
    if (kind === "approved") await applyApproved(client, provider, result);
    else if (kind === "rejected") await applyRejected(client, provider, result);

    await client.query("UPDATE billing_events SET processed_at=now() WHERE id=$1", [eventId]);
    await client.query("UPDATE billing_providers SET last_event_at=now() WHERE id=$1", [provider.id]);
    await client.query("COMMIT");
    return { status: kind === "ignored" ? "ignored" : "processed", eventId, eventType: result.eventType };
  } catch (error) {
    await client.query("ROLLBACK");
    // O evento não fica marcado como processado: o provider pode reenviar com segurança.
    await db.query(
      "UPDATE billing_events SET processing_error=$2 WHERE provider_id=$1 AND external_event_id=$3",
      [provider.id, error instanceof Error ? error.message : "erro desconhecido", result.externalEventId]
    ).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
