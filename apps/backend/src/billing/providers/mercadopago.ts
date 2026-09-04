import { createHmac, timingSafeEqual } from "node:crypto";
import type { BillingProvider, CustomerInput, ProviderResult, SubscriptionInput, PaymentInput, WebhookResult } from "./types.js";
import { decryptCredentials, decryptWebhookSecret } from "./credentials.js";

export interface MercadoPagoOptions { credentialsEncrypted: string; webhookSecretEncrypted?: string; encryptionKey: string; environment?: "sandbox" | "production"; }

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
  private async request(path: string, method: string, body?: unknown): Promise<ProviderResult> {
    const response = await fetch(this.base + path, { method, headers: { Authorization: `Bearer ${this.token()}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(`Mercado Pago API error (${response.status})`);
    return { externalId: String(data.id ?? ""), status: typeof data.status === "string" ? data.status : undefined, payload: data };
  }
  createCustomer(input: CustomerInput) { return this.request("/v1/customers", "POST", { email: input.email, first_name: input.name, identification: input.document ? { number: input.document } : undefined }); }
  createSubscription(input: SubscriptionInput) { return this.request("/preapproval", "POST", { payer_email: input.metadata?.payerEmail, auto_recurring: { transaction_amount: input.amountCents / 100, currency_id: input.currency ?? "BRL", frequency: input.intervalMonths ?? 1, frequency_type: "months" }, external_reference: input.tenantId }); }
  cancelSubscription(externalId: string) { return this.request(`/preapproval/${encodeURIComponent(externalId)}`, "PUT", { status: "cancelled" }); }
  createPayment(input: PaymentInput) { return this.request("/v1/payments", "POST", { transaction_amount: input.amountCents / 100, description: input.description, payment_method_id: input.method, payer: input.payer, external_reference: input.tenantId }); }
  getPayment(externalId: string) { return this.request(`/v1/payments/${encodeURIComponent(externalId)}`, "GET"); }
  async handleWebhook(rawBody: string, headers: Headers, secret: string): Promise<WebhookResult> {
    const payload = JSON.parse(rawBody) as Record<string, unknown>;
    const signature = header(headers, "x-signature");
    const requestId = header(headers, "x-request-id");
    const parts = Object.fromEntries(signature.split(",").map((part) => { const [key, ...rest] = part.trim().split("="); return [key, rest.join("=")]; }));
    const resourceId = String((payload.data as Record<string, unknown> | undefined)?.id ?? payload.id ?? "");
    const ts = parts.ts ?? "";
    const manifest = `id:${resourceId};request-id:${requestId};ts:${ts};`;
    const webhookSecret = secret || (this.options.webhookSecretEncrypted ? decryptWebhookSecret(this.options.webhookSecretEncrypted, this.options.encryptionKey) : "");
    if (!webhookSecret) throw new Error("Mercado Pago webhook secret is not configured");
    const expected = createHmac("sha256", webhookSecret).update(manifest).digest("hex");
    const supplied = parts.v1 ?? "";
    const valid = /^[0-9a-f]{64}$/i.test(supplied) && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied.toLowerCase()));
    const metadata = payload.external_reference ?? (payload.data as Record<string, unknown> | undefined)?.external_reference;
    return { externalEventId: resourceId, eventType: String(payload.type ?? payload.action ?? "unknown"), signatureValid: valid, tenantHint: typeof metadata === "string" ? metadata : undefined, payload };
  }
}
