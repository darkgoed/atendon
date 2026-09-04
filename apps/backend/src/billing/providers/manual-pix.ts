import type { BillingProvider, CustomerInput, ProviderResult, SubscriptionInput, PaymentInput, WebhookResult } from "./types.js";
import { NotImplementedError } from "./types.js";
export const PAYMENT_STATUSES = ["pending", "paid", "rejected", "expired"] as const;
export interface ManualPixConfig { pixKey: string; receiverName: string; city: string; }
function field(id: string, value: string): string { return `${id}${value.length.toString().padStart(2, "0")}${value}`; }
export function crc16Ccitt(value: string): string { let crc = 0xffff; for (const byte of Buffer.from(value, "utf8")) { crc ^= byte << 8; for (let i=0;i<8;i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; } return crc.toString(16).toUpperCase().padStart(4, "0"); }
export function buildPixPayload(config: ManualPixConfig, amountCents: number, txid: string): string { const merchant = field("00", "br.gov.bcb.pix") + field("01", config.pixKey); const body = field("00", "01") + field("26", merchant) + field("52", "0000") + field("53", "986") + field("54", (amountCents / 100).toFixed(2)) + field("58", "BR") + field("59", config.receiverName.slice(0,25)) + field("60", config.city.slice(0,15)) + field("62", field("05", txid.slice(0,25))); return body + "6304" + crc16Ccitt(body + "6304"); }
export class ManualPixProvider implements BillingProvider {
 constructor(private readonly config: ManualPixConfig) {}
 async createCustomer(input: CustomerInput): Promise<ProviderResult> { return { externalId: input.tenantId, status: "active" }; }
 async createSubscription(input: SubscriptionInput): Promise<ProviderResult> { return { externalId: `manual-${input.tenantId}`, status: "pending" }; }
 async cancelSubscription(externalId: string): Promise<ProviderResult> { return { externalId, status: "canceled" }; }
 async createPayment(input: PaymentInput): Promise<ProviderResult> { const txid = `ATENDON${Date.now().toString(36).toUpperCase()}`.slice(0,25); return { externalId: txid, status: "pending", payload: { pixCopyPaste: buildPixPayload(this.config,input.amountCents,txid), status: "pending", confirmed_by_user_id: null } }; }
 async getPayment(externalId: string): Promise<ProviderResult> { return { externalId, status: "pending" }; }
 // PIX manual é confirmado pelo ROOT (§16); não há callback de gateway.
 async handleWebhook(): Promise<WebhookResult> { throw new NotImplementedError("Manual PIX does not support webhooks"); }
}
