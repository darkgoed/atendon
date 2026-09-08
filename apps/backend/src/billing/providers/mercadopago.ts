import { createHmac, timingSafeEqual } from "node:crypto";
import type { BillingProvider, CustomerInput, ProviderResult, SubscriptionInput, PaymentInput, WebhookResult } from "./types.js";
import { decryptCredentials, decryptWebhookSecret } from "./credentials.js";

export interface MercadoPagoOptions { credentialsEncrypted: string; webhookSecretEncrypted?: string; encryptionKey: string; environment?: "sandbox" | "production"; fetchImpl?: typeof fetch; signatureToleranceSeconds?: number; }

type Headers = Record<string, string | string[] | undefined>;
function header(headers: Headers, name: string): string { const key = Object.keys(headers).find((k) => k.toLowerCase() === name); const value = key ? headers[key] : undefined; return Array.isArray(value) ? value[0] ?? "" : value ?? ""; }

export class MercadoPagoProvider implements BillingProvider {
  private readonly base = "https://api.mercadopago.com";
  constructor(private readonly options: MercadoPagoOptions) {}
  private token(): string {
    const credentials = decryptCredentials<Record<string, unknown>>(this.options.credentialsEncrypted, this.options.encryptionKey);
    const token = credentials.accessToken ?? credentials.access_token;
    if (typeof token !== "string" || token.length === 0) throw new Error("Mercado Pago credentials are not configured");
    return token;
  }
  private async request(path: string, method: string, body?: unknown, idempotencyKey?: string): Promise<ProviderResult> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(this.base + path, { method, headers: { Authorization: `Bearer ${this.token()}`, "Content-Type": "application/json", ...(idempotencyKey ? { "X-Idempotency-Key": idempotencyKey } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(`Mercado Pago API error (${response.status})`);
    return { externalId: String(data.id ?? ""), status: typeof data.status === "string" ? data.status : undefined, payload: data };
  }
  createCustomer(input: CustomerInput) { return this.request("/v1/customers", "POST", { email: input.email, first_name: input.name, identification: input.document ? { number: input.document } : undefined }); }
  createSubscription(input: SubscriptionInput) { return this.request("/preapproval", "POST", { payer_email: input.metadata?.payerEmail, auto_recurring: { transaction_amount: input.amountCents / 100, currency_id: input.currency ?? "BRL", frequency: input.intervalMonths ?? 1, frequency_type: "months" }, external_reference: input.tenantId }); }
  cancelSubscription(externalId: string) { return this.request(`/preapproval/${encodeURIComponent(externalId)}`, "PUT", { status: "cancelled" }); }
  // A API /v1/payments infere a moeda da conta do vendedor e REJEITA `currency_id`
  // com 400 "The name of the following parameters is wrong : currency_id".
  // O campo só é válido em /preapproval (createSubscription), onde segue em uso.
  createPayment(input: PaymentInput) { return this.request("/v1/payments", "POST", { transaction_amount: input.amountCents / 100, description: input.description, payment_method_id: input.method, payer: input.payer, external_reference: input.externalReference }, input.idempotencyKey); }
  getPayment(externalId: string) { return this.request(`/v1/payments/${encodeURIComponent(externalId)}`, "GET"); }
  async handleWebhook(rawBody: string, headers: Headers, secret: string): Promise<WebhookResult> {
    const payload = JSON.parse(rawBody) as Record<string, unknown>;
    const signature = header(headers, "x-signature");
    const requestId = header(headers, "x-request-id");
    const parts = Object.fromEntries(signature.split(",").map((part) => { const [key, ...rest] = part.trim().split("="); return [key, rest.join("=")]; }));
    const resourceId = String((payload.data as Record<string, unknown> | undefined)?.id ?? payload.id ?? "");
    const action = typeof payload.action === "string" ? payload.action : undefined;
    // O manifesto do Mercado Pago é `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`
    // com o data.id apenas em minúsculas. REMOVER caracteres (hífen, ponto) muda o
    // valor assinado pelo provedor e faz webhooks legítimos caírem em 401 eterno.
    const manifestId = resourceId.toLowerCase();
    const ts = parts.ts ?? "";
    const tolerance = this.options.signatureToleranceSeconds;
    const timestampSeconds = /^\d+$/.test(ts)
      ? (ts.length === 13 ? Math.floor(Number(ts) / 1000) : Number(ts))
      : Number.NaN;
    const timestampOk = tolerance == null || (Number.isFinite(timestampSeconds) && Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) <= tolerance);
    const manifest = [
      manifestId ? `id:${manifestId};` : "",
      requestId ? `request-id:${requestId};` : "",
      `ts:${ts};`,
    ].join("");
    const webhookSecret = secret || (this.options.webhookSecretEncrypted ? decryptWebhookSecret(this.options.webhookSecretEncrypted, this.options.encryptionKey) : "");
    if (!webhookSecret) throw new Error("Mercado Pago webhook secret is not configured");
    const expected = createHmac("sha256", webhookSecret).update(manifest).digest("hex");
    const supplied = parts.v1 ?? "";
    const valid = timestampOk && /^[0-9a-f]{64}$/i.test(supplied) && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied.toLowerCase()));
    let source: Record<string, unknown> = {};
    if (valid && resourceId) {
      const fetched = await this.getPayment(resourceId);
      source = (fetched.payload ?? {}) as Record<string, unknown>;
    }
    const data = Object.keys(source).length ? source : ((payload.data as Record<string, unknown> | undefined) ?? payload);
    const reference = data.external_reference ?? payload.external_reference;
    const amount = data.amount_cents ?? payload.amount_cents ?? data.transaction_amount ?? data.amount ?? payload.transaction_amount;
    const amountCents = typeof amount === "number" && Number.isFinite(amount)
      ? (data.amount_cents != null || payload.amount_cents != null ? amount : Math.round(amount * 100))
      : undefined;
    const currency = data.currency_id ?? data.currency ?? payload.currency_id;
    const invoiceReference = data.invoice_id ?? data.external_invoice_id ?? payload.invoice_id ?? payload.external_invoice_id;
    return {
      externalEventId: String(payload.id ?? (action && resourceId ? `${action}:${resourceId}` : resourceId)),
      eventType: action ?? String(payload.type ?? "unknown"),
      status: typeof data.status === "string" ? data.status.toLowerCase() : undefined,
      signatureValid: valid,
      amountCents,
      currency: typeof currency === "string" ? currency : undefined,
      externalInvoiceId: invoiceReference == null ? undefined : String(invoiceReference),
      externalReference: typeof reference === "string" ? reference : undefined,
      externalPaymentId: resourceId || undefined,
      // Kept only for audit compatibility; reconciliation must not use it.
      tenantHint: typeof reference === "string" ? reference : undefined,
      payload
    };
  }
}
