import type { Pool } from "pg";
import { db } from "../db/client.js";
import { withTransaction } from "../db/transaction.js";
import { config } from "../config.js";
import { MercadoPagoProvider } from "./providers/mercadopago.js";
import { assertAutomaticProvider, providerNotHomologated } from "./providers/homologation.js";
import type { BillingProvider, PaymentInput, ProviderResult } from "./providers/types.js";
import { CHARGEABLE_SUBSCRIPTION_STATUSES } from "./types.js";

type ProviderRow = { credentials_encrypted: string; webhook_secret_encrypted: string | null };
type InvoiceRow = { id: string; tenant_id: string; subscription_id: string | null; amount_cents: number | string; currency: string; status: string; external_id: string | null; provider_id: string | null };
type PaymentRow = { external_id: string; status: string; created_at: Date; metadata: Record<string, unknown> | null };
type ProviderConfigRow = ProviderRow & { id: string; code: string; enabled: boolean; environment: string; status: string; homologated: boolean; accepted_methods: string[] | null; commercial_config: Record<string, unknown> | null };
type PayerRow = { document?: string; email?: string };
export type ChargeResult = { invoiceId: string; externalId: string; status: string; reference: string; qr_code?: string; ticket_url?: string; payload?: Record<string, unknown> };
function safeCharge(result: { invoiceId:string; externalId:string; status:string; reference:string; payload?: Record<string, unknown> }): ChargeResult {
  const td = result.payload?.point_of_interaction && typeof result.payload.point_of_interaction === "object" ? (result.payload.point_of_interaction as Record<string, unknown>).transaction_data : undefined;
  const data = td && typeof td === "object" ? td as Record<string, unknown> : {};
  return { invoiceId: result.invoiceId, externalId: result.externalId, status: result.status, reference: result.reference, ...(typeof data.qr_code === "string" ? { qr_code: data.qr_code } : {}), ...(typeof data.ticket_url === "string" ? { ticket_url: data.ticket_url } : {}) };
}
export type ChargeDeps = { db?: Pool; provider?: BillingProvider; providerFactory?: (row: ProviderRow) => BillingProvider };
export type ChargeOptions = { allowSuspended?: boolean; expectedTenantId?: string };
const safeError = () => Object.assign(new Error("Não foi possível criar a cobrança; tente novamente"), { code: "CHARGE_PROVIDER_ERROR", statusCode: 502 });
const tx = withTransaction;
function reference(id: string) { return `invoice:${id}`; }
function providerFrom(row: ProviderRow, deps: ChargeDeps): BillingProvider { if (deps.provider) return deps.provider; return deps.providerFactory ? deps.providerFactory(row) : new MercadoPagoProvider({ credentialsEncrypted: row.credentials_encrypted, webhookSecretEncrypted: row.webhook_secret_encrypted ?? undefined, encryptionKey: config.DATA_ENCRYPTION_KEY, environment: "production" }); }

export async function createChargeForInvoice(invoiceId: string, method: string, deps: ChargeDeps = {}, options: ChargeOptions = {}): Promise<ChargeResult> {
  const key = `${invoiceId}:${method}`;
  const active = inFlight.get(key);
  if (active) return active;
  const promise = createChargeForInvoiceUncoalesced(invoiceId, method, deps, options);
  inFlight.set(key, promise);
  try { return await promise; } finally { if (inFlight.get(key) === promise) inFlight.delete(key); }
}

const inFlight = new Map<string, Promise<ChargeResult>>();
async function createChargeForInvoiceUncoalesced(invoiceId: string, method: string, deps: ChargeDeps = {}, options: ChargeOptions = {}): Promise<ChargeResult> {
  const pool = deps.db ?? db;
  const prepared = await tx(pool, async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [invoiceId]);
    const inv = (await c.query<InvoiceRow>(`SELECT id,tenant_id,subscription_id,amount_cents,currency,status,external_id,provider_id FROM invoices WHERE id=$1 FOR UPDATE`, [invoiceId])).rows[0];
    if (!inv) throw Object.assign(new Error("Fatura não encontrada"), { statusCode: 404 });
    if (options.expectedTenantId && inv.tenant_id !== options.expectedTenantId) throw Object.assign(new Error("Fatura não encontrada"), { statusCode: 404 });
    if (inv.subscription_id) {
      const sub = (await c.query<{ status: string }>("SELECT status FROM tenant_subscriptions WHERE id=$1 FOR SHARE", [inv.subscription_id])).rows[0];
      const chargeable = CHARGEABLE_SUBSCRIPTION_STATUSES.includes(sub?.status as typeof CHARGEABLE_SUBSCRIPTION_STATUSES[number]) || (options.allowSuspended === true && sub?.status === "SUSPENDED");
      if (!sub || !chargeable) throw Object.assign(new Error("Assinatura não permite cobrança"), { code: "SUBSCRIPTION_NOT_CHARGEABLE", statusCode: 409 });
    }
    if (inv.external_id) {
      const payment = (await c.query<PaymentRow>(`SELECT external_id,status,metadata,created_at FROM payments WHERE invoice_id=$1 AND external_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [invoiceId])).rows[0];
      if (payment) {
        // paid/approved são terminais. Uma pendência (PIX não pago) só trava a
        // criação de um NOVO pagamento enquanto for recente — QR pendente velho
        // já expirou no provider, e bloquear para sempre faria o dunning
        // "esgotar" tentativas sem NENHUM retry real (residual do B2).
        const PENDING_FRESH_MS = 12 * 60 * 60 * 1000;
        const settledLike = ["paid", "approved"].includes(payment.status);
        const freshPending = ["pending", "in_process", "authorized"].includes(payment.status)
          && (Date.now() - new Date(payment.created_at).getTime()) < PENDING_FRESH_MS;
        if (settledLike || freshPending) return { done: true as const, result: safeCharge({ invoiceId, externalId: payment.external_id, status: payment.status, reference: inv.external_id!, payload: payment.metadata ?? undefined }) };
      }
    }
    if (!["pending", "open", "overdue"].includes(String(inv.status).toLowerCase())) throw new Error("Fatura não está aberta para cobrança");
    const amount = Number(inv.amount_cents); if (!Number.isFinite(amount) || amount <= 0) throw new Error("Valor da fatura inválido");
    // Fallback determinístico: sem ORDER BY, "LIMIT 1" escolhe uma linha
    // arbitrária entre vários gateways conectados e uma cobrança real pode ir
    // parar no provedor errado. A ordem fixa torna a escolha reproduzível.
    const p = (await c.query<ProviderConfigRow>(`SELECT id,code,enabled,environment,status,homologated,accepted_methods,commercial_config,credentials_encrypted,webhook_secret_encrypted FROM billing_providers WHERE id=COALESCE($1,(SELECT id FROM billing_providers WHERE homologated=true AND environment='production' AND status='CONNECTED' AND enabled=true AND credentials_encrypted IS NOT NULL ORDER BY connected_at NULLS LAST,code,id LIMIT 1)) FOR UPDATE`, [inv.provider_id])).rows[0];
    if (!p || p.environment !== "production" || !p.enabled || p.status !== "CONNECTED") throw new Error("Provedor de pagamento não está conectado");
    // A homologação é dado da própria linha travada: um gateway não homologado
    // nunca cobra, mesmo que alguém o tenha vinculado à fatura manualmente.
    if (p.homologated !== true) throw providerNotHomologated(p.code);
    assertAutomaticProvider(p.code);
    const accepted = Array.isArray(p.accepted_methods) ? p.accepted_methods : [];
    if (accepted.length && !accepted.includes(method)) throw new Error("Método de pagamento não aceito");
    const commercial = p.commercial_config && typeof p.commercial_config === "object" ? p.commercial_config : {};
    if (commercial.enabled === false || (Array.isArray(commercial.accepted_methods) && !commercial.accepted_methods.includes(method))) throw new Error("Método de pagamento não aceito");
    const payer = (await c.query<PayerRow>(`SELECT document,email FROM billing_accounts WHERE tenant_id=$1 AND (provider_id=$2 OR provider_id IS NULL) LIMIT 1`, [inv.tenant_id, p.id])).rows[0] ?? {};
    const ext = inv.external_id ?? reference(invoiceId);
    if (!inv.external_id) await c.query("UPDATE invoices SET external_id=$1,provider_id=$2,updated_at=now() WHERE id=$3", [ext, p.id, invoiceId]);
    const attempts = Number((await c.query<{ count: string }>("SELECT count(*) FROM payments WHERE invoice_id=$1", [invoiceId])).rows[0].count);
    return { done: false as const, invoiceId, tenantId: inv.tenant_id, amount, currency: inv.currency, ext, providerId: p.id, payer, provider: providerFrom(p, deps), attempts };
  });
  if (prepared.done) return prepared.result;
  let result: ProviderResult;
  try {
    const input: PaymentInput = { tenantId: prepared.tenantId, invoiceId, externalReference: prepared.ext, idempotencyKey: prepared.attempts === 0 ? `atendon-invoice-${invoiceId}` : `atendon-invoice-${invoiceId}-retry-${prepared.attempts}`, amountCents: prepared.amount, currency: prepared.currency, method, payer: { email: prepared.payer.email, identification: prepared.payer.document ? { type: "CPF", number: prepared.payer.document } : undefined } };
    result = await prepared.provider.createPayment(input);
  } catch { throw safeError(); }
  return tx(pool, async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [invoiceId]);
    const inv = (await c.query<Pick<InvoiceRow, "external_id" | "provider_id" | "status">>("SELECT external_id,provider_id,status FROM invoices WHERE id=$1 FOR UPDATE", [invoiceId])).rows[0];
    if (!inv || inv.external_id !== prepared.ext || inv.provider_id !== prepared.providerId) throw new Error("Fatura foi alterada durante a cobrança");
    const existing = (await c.query<PaymentRow>("SELECT external_id,status,metadata FROM payments WHERE invoice_id=$1 AND external_id=$2 LIMIT 1", [invoiceId, result.externalId])).rows[0];
    if (existing) return safeCharge({ invoiceId, externalId: existing.external_id, status: existing.status, reference: prepared.ext, payload: existing.metadata ?? undefined });
    const inserted = await c.query(`INSERT INTO payments(tenant_id,invoice_id,provider_id,external_id,amount_cents,currency,status,method,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (provider_id, external_id) WHERE external_id IS NOT NULL AND provider_id IS NOT NULL DO NOTHING`, [prepared.tenantId, invoiceId, prepared.providerId, result.externalId, prepared.amount, prepared.currency, result.status ?? "pending", method, result.payload ?? {}]);
    if (!inserted.rowCount) {
      const conflict = (await c.query<PaymentRow>("SELECT external_id,status,metadata FROM payments WHERE provider_id=$1 AND external_id=$2 LIMIT 1", [prepared.providerId, result.externalId])).rows[0];
      if (conflict) return safeCharge({ invoiceId, externalId: conflict.external_id, status: conflict.status, reference: prepared.ext, payload: conflict.metadata ?? undefined });
    }
    return safeCharge({ invoiceId, externalId: result.externalId, status: result.status ?? "pending", reference: prepared.ext, payload: result.payload });
  });
}
