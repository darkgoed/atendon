export type BillingValue = string | number | boolean | null;
export type BillingPayload = Record<string, unknown>;
export interface CustomerInput { tenantId: string; email?: string; name?: string; document?: string; }
export interface SubscriptionInput { tenantId: string; customerId?: string; amountCents: number; currency?: string; intervalMonths?: number; metadata?: BillingPayload; }
export interface PaymentInput { tenantId: string; amountCents: number; currency?: string; method: string; description?: string; payer?: BillingPayload; metadata?: BillingPayload; }
export interface ProviderResult { externalId: string; status?: string; payload?: BillingPayload; }
export interface WebhookResult { externalEventId: string; eventType: string; signatureValid: boolean; tenantHint?: string; payload: unknown; }
export interface BillingProvider {
  createCustomer(input: CustomerInput): Promise<ProviderResult>;
  createSubscription(input: SubscriptionInput): Promise<ProviderResult>;
  cancelSubscription(externalId: string): Promise<ProviderResult>;
  createPayment(input: PaymentInput): Promise<ProviderResult>;
  getPayment(externalId: string): Promise<ProviderResult>;
  handleWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>, secret: string): Promise<WebhookResult>;
}
export class NotImplementedError extends Error { constructor(message = "Operation not implemented by this provider") { super(message); this.name = "NotImplementedError"; } }
