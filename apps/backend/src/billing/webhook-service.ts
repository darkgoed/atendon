import type { PoolClient } from "pg";
import { db } from "../db/client.js";
import { getProvider } from "./providers/registry.js";
import { getBillingSettings } from "./settings.js";
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
  kind: string;
  event_occurred_at?: string | null;
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
const REJECTED = new Set(["payment.rejected", "rejected", "cancelled"]);
const REFUNDED = new Set(["refunded", "payment.refunded", "refund"]);
const CHARGED_BACK = new Set(["charged_back", "chargeback", "payment.charged_back"]);

type WebhookKind = "approved" | "rejected" | "pending" | "refunded" | "charged_back" | "ignored";

function httpError(statusCode: number, message: string, code?: string) {
  return Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) });
}
function eventOccurredAt(result: WebhookResult): Date | null {
  const payload = result.payload as { date_created?: unknown; created_at?: unknown; updated_at?: unknown; data?: { date_created?: unknown; created_at?: unknown; updated_at?: unknown } };
  const raw = result.payload && typeof result.payload === "object" ? (payload.date_created ?? payload.created_at ?? payload.updated_at ?? payload.data?.date_created ?? payload.data?.created_at ?? payload.data?.updated_at) : null;
  if (!raw) return null;
  const date = new Date(String(raw));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Classifica usando primeiro o status autenticado retornado pela API. */
function classify(result: Pick<WebhookResult, "eventType" | "payload" | "status">): WebhookKind {
  const status = String(result.status ??
    (result.payload as { data?: { status?: unknown }; status?: unknown })?.data?.status ??
    (result.payload as { status?: unknown })?.status ?? "").toLowerCase();
  const key = result.eventType.toLowerCase();
  if (["approved", "accredited"].includes(status) || APPROVED.has(key)) return "approved";
  if (["refunded", "refund"].includes(status) || REFUNDED.has(key)) return "refunded";
  if (["charged_back", "chargeback"].includes(status) || CHARGED_BACK.has(key)) return "charged_back";
  if (["pending", "in_process", "in_process_payment"].includes(status) || key.includes("pending") || key.includes("in_process")) return "pending";
  if (REJECTED.has(key) || ["rejected", "cancelled"].includes(status)) return "rejected";
  return "ignored";
}


async function loadProvider(code: string): Promise<ProviderRow> {
  const result = await db.query<ProviderRow>(
    "SELECT id,code,enabled,credentials_encrypted,webhook_secret_encrypted FROM billing_providers WHERE code=$1 AND environment='production'",
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
  const settings = await getBillingSettings();
  const configuredTolerance = Number(settings.webhook_tolerance_seconds);
  const signatureToleranceSeconds = Number.isFinite(configuredTolerance) && configuredTolerance > 0
    ? configuredTolerance
    : 300;
  const instance = getProvider(provider.code, {
    mercadopago: {
      credentialsEncrypted: provider.credentials_encrypted ?? "",
      webhookSecretEncrypted: provider.webhook_secret_encrypted ?? undefined,
      encryptionKey,
      signatureToleranceSeconds
    }
  });
  return instance.handleWebhook(rawBody, headers, "");
}

/** Marca a fatura como paga, registra o pagamento e reativa a assinatura se aplicável. */
async function applyApproved(client: PoolClient, provider: ProviderRow, result: WebhookResult): Promise<void> {
  const externalId = result.externalPaymentId ?? result.externalEventId;
  const invoiceKey = result.externalInvoiceId ?? result.externalReference;
  if (!invoiceKey) throw httpError(422, "Webhook sem vínculo inequívoco com fatura", "UNRECONCILED_WEBHOOK");
  const invoice = await client.query<InvoiceRow>(
    `SELECT id,tenant_id,subscription_id,amount_cents,currency,status,kind FROM invoices
     WHERE provider_id=$1 AND external_id=$2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [provider.id, invoiceKey]
  );
  const row = invoice.rows[0];
  if (!row) throw httpError(422, "Fatura do webhook não encontrada", "UNRECONCILED_WEBHOOK");
  if (result.amountCents !== Number(row.amount_cents) || (result.currency ?? "").toUpperCase() !== row.currency.toUpperCase()) {
    throw httpError(422, "Valor ou moeda do webhook não corresponde à fatura", "WEBHOOK_AMOUNT_MISMATCH");
  }
  // A pending webhook may arrive with the notification id while the approved
  // refetch returns the gateway payment id. Reconcile by invoice first so a
  // status transition cannot create a second payment row.
  //
  // Preferência: a linha que JÁ tem este external_id (é literalmente o mesmo
  // pagamento); só então a mais recente da fatura, que é a criada pela cobrança
  // e ainda carrega o id da notificação. Atualizar sempre "a mais recente"
  // reescreveria o external_id por cima de outra linha e colidiria na unique
  // parcial uq_payments_provider_external_id.
  const existing = await client.query<{ id: string; status: string; external_id: string }>(
    `SELECT id,status,external_id FROM payments
      WHERE provider_id=$1 AND invoice_id=$2
      ORDER BY (external_id = $3) DESC, created_at DESC
      LIMIT 1 FOR UPDATE`,
    [provider.id, row.id, externalId]
  );
  if (existing.rows[0]?.status === "paid") return;
  if (existing.rowCount) {
    await client.query("UPDATE payments SET external_id=$1,status='paid',paid_at=now(),updated_at=now() WHERE id=$2", [externalId, existing.rows[0].id]);
  } else {
    await client.query(
      `INSERT INTO payments(tenant_id,invoice_id,provider_id,external_id,amount_cents,currency,status,method,paid_at)
       VALUES($1,$2,$3,$4,$5,$6,'paid',$7,now())`,
      [row.tenant_id, row.id, provider.id, externalId, row.amount_cents, row.currency, "webhook"]
    );
  }
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
    if (row.kind !== "subscription") return;
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

async function applyPending(client: PoolClient, provider: ProviderRow, result: WebhookResult): Promise<void> {
  const externalId = result.externalPaymentId ?? result.externalEventId;
  const invoiceKey = result.externalInvoiceId ?? result.externalReference;
  if (!invoiceKey) throw httpError(422, "Webhook sem vínculo inequívoco com fatura", "UNRECONCILED_WEBHOOK");
  const invoice = await client.query<InvoiceRow>(`SELECT id,tenant_id,subscription_id,amount_cents,currency,status,kind FROM invoices WHERE provider_id=$1 AND external_id=$2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [provider.id, invoiceKey]);
  const row = invoice.rows[0];
  if (!row) throw httpError(422, "Fatura do webhook não encontrada", "UNRECONCILED_WEBHOOK");
  // Reconcilia pela FATURA, não pelo external_id: o evento de pendência chega
  // com o id da notificação e o de aprovação com o id do pagamento no gateway.
  // Casar por external_id criaria uma segunda linha para o mesmo pagamento.
  const existing = await client.query<{ id: string; status: string }>(
    "SELECT id,status FROM payments WHERE provider_id=$1 AND invoice_id=$2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    [provider.id, row.id]
  );
  const settled = ["paid", "refunded", "charged_back"];
  if (existing.rowCount && settled.includes(existing.rows[0].status)) return;
  if (existing.rowCount) {
    await client.query("UPDATE payments SET external_id=$1,status='pending',updated_at=now() WHERE id=$2", [externalId, existing.rows[0].id]);
  } else {
    await client.query(`INSERT INTO payments(tenant_id,invoice_id,provider_id,external_id,amount_cents,currency,status,method) VALUES($1,$2,$3,$4,$5,$6,'pending',$7)`, [row.tenant_id,row.id,provider.id,externalId,row.amount_cents,row.currency,"webhook"]);
  }
  await client.query("UPDATE invoices SET status='pending',updated_at=now() WHERE id=$1 AND status NOT IN ('paid','refunded','charged_back')", [row.id]);
}

async function applyReversal(client: PoolClient, provider: ProviderRow, result: WebhookResult, status: "refunded" | "charged_back"): Promise<void> {
  const externalId = result.externalPaymentId ?? result.externalEventId;
  const invoiceKey = result.externalInvoiceId ?? result.externalReference;
  if (!invoiceKey) throw httpError(422, "Webhook sem vínculo inequívoco com fatura", "UNRECONCILED_WEBHOOK");
  const invoice = await client.query<InvoiceRow>(`SELECT id,tenant_id,subscription_id,amount_cents,currency,status,kind FROM invoices WHERE provider_id=$1 AND external_id=$2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [provider.id, invoiceKey]);
  const row = invoice.rows[0];
  if (!row) throw httpError(422, "Fatura do webhook não encontrada", "UNRECONCILED_WEBHOOK");
  // Mesma regra de applyPending/applyApproved: a identidade do pagamento é a
  // FATURA. O estorno referencia o pagamento original, que pode ter sido criado
  // com outro external_id.
  const existing = await client.query<{ id: string }>(
    "SELECT id FROM payments WHERE provider_id=$1 AND invoice_id=$2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    [provider.id, row.id]
  );
  if (existing.rowCount) {
    await client.query("UPDATE payments SET external_id=$1,status=$2,paid_at=NULL,updated_at=now() WHERE id=$3", [externalId, status, existing.rows[0].id]);
  } else {
    await client.query(`INSERT INTO payments(tenant_id,invoice_id,provider_id,external_id,amount_cents,currency,status,method) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [row.tenant_id,row.id,provider.id,externalId,row.amount_cents,row.currency,status,"webhook"]);
  }
  await client.query("UPDATE invoices SET status=$2,paid_at=NULL,updated_at=now() WHERE id=$1", [row.id,status]);
  if (row.subscription_id) await client.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,from_plan_id,to_plan_id,from_status,to_status,metadata) SELECT $1,$2,$3,s.plan_id,s.plan_id,s.status,s.status,$4 FROM tenant_subscriptions s WHERE s.id=$2`, [row.tenant_id,row.subscription_id,status === "refunded" ? "PAYMENT_REFUNDED" : "PAYMENT_CHARGED_BACK", { invoiceId: row.id, reversal: true }]);
}


async function applyRejected(client: PoolClient, provider: ProviderRow, result: WebhookResult): Promise<void> {
  const externalId = result.externalPaymentId ?? result.externalEventId;
  const invoiceKey = result.externalInvoiceId ?? result.externalReference;
  if (!invoiceKey) throw httpError(422, "Webhook sem vínculo inequívoco com fatura", "UNRECONCILED_WEBHOOK");
  const invoice = await client.query<InvoiceRow>(
    `SELECT id,tenant_id,subscription_id,amount_cents,currency,status,kind FROM invoices
     WHERE provider_id=$1 AND external_id=$2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [provider.id, invoiceKey]
  );
  const row = invoice.rows[0];
  if (!row) throw httpError(422, "Fatura do webhook não encontrada", "UNRECONCILED_WEBHOOK");

  const existing = await client.query<{ status: string }>("SELECT status FROM payments WHERE provider_id=$1 AND external_id=$2 FOR UPDATE", [provider.id, externalId]);
  if (existing.rows[0]?.status === "rejected") return;
  if (existing.rowCount) {
    await client.query("UPDATE payments SET status='rejected',paid_at=NULL WHERE provider_id=$1 AND external_id=$2", [provider.id, externalId]);
    if (existing.rows[0].status === "paid") {
      await client.query("UPDATE invoices SET status='open',paid_at=NULL,updated_at=now() WHERE id=$1", [row.id]);
    }
  } else {
    await client.query(
      `INSERT INTO payments(tenant_id,invoice_id,provider_id,external_id,amount_cents,currency,status,method)
       VALUES($1,$2,$3,$4,$5,$6,'rejected',$7)`,
      [row.tenant_id, row.id, provider.id, externalId, row.amount_cents, row.currency, "webhook"]
    );
  }

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
  // The legacy public route has no environment segment: it is production-only.
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
      `INSERT INTO billing_events(provider_id,external_event_id,event_type,payload,signature_valid,tenant_id,occurred_at)
       VALUES($1,$2,$3,$4,true,$5,$6)
       ON CONFLICT (provider_id,external_event_id) DO UPDATE SET processing_error=NULL
       WHERE billing_events.processed_at IS NULL
       RETURNING id`,
      [provider.id, result.externalEventId, result.eventType, result.payload, result.tenantHint ?? null, eventOccurredAt(result)]
    );
    // Portão de idempotência: se não inseriu, este evento já foi processado.
    if (!inserted.rowCount) {
      await client.query("ROLLBACK");
      return { status: "duplicated", eventType: result.eventType };
    }
    eventId = inserted.rows[0].id;

    const kind = classify(result);
    if (kind === "approved") await applyApproved(client, provider, result);
    else if (kind === "rejected") await applyRejected(client, provider, result);
    else if (kind === "pending") await applyPending(client, provider, result);
    else if (kind === "refunded" || kind === "charged_back") await applyReversal(client, provider, result, kind);

    await client.query("UPDATE billing_events SET processed_at=now() WHERE id=$1", [eventId]);
    await client.query("UPDATE billing_providers SET last_event_at=now() WHERE id=$1", [provider.id]);
    await client.query("COMMIT");
    return { status: kind === "ignored" ? "ignored" : "processed", eventId, eventType: result.eventType };
  } catch (error) {
    await client.query("ROLLBACK");
    // O evento não fica marcado como processado: o provider pode reenviar com segurança.
    await db.query(
      `INSERT INTO billing_events(provider_id,external_event_id,event_type,payload,signature_valid,processing_error)
       VALUES($1,$2,$3,$4,true,$5)
       ON CONFLICT (provider_id,external_event_id) DO UPDATE SET processing_error=EXCLUDED.processing_error`,
      [provider.id, result.externalEventId, result.eventType, result.payload, error instanceof Error ? error.message : "erro desconhecido"]
    ).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
