import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { createChargeForInvoice } from "../src/billing/charges.js";
import type { BillingProvider, PaymentInput, ProviderResult, WebhookResult } from "../src/billing/providers/types.js";
import { MercadoPagoProvider } from "../src/billing/providers/mercadopago.js";
import { encryptCredentials } from "../src/billing/providers/credentials.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const ids: string[] = [];
class FakeProvider implements BillingProvider {
  calls: PaymentInput[] = []; failures = false;
  async createPayment(input: PaymentInput): Promise<ProviderResult> { this.calls.push(input); await new Promise(r => setTimeout(r, 20)); if (this.failures) throw new Error("secret provider detail"); return { externalId: "mp-123", status: "pending", payload: { ok: true } }; }
  createCustomer(): Promise<ProviderResult> { throw new Error("unused"); } createSubscription(): Promise<ProviderResult> { throw new Error("unused"); }
  cancelSubscription(): Promise<ProviderResult> { throw new Error("unused"); } getPayment(): Promise<ProviderResult> { throw new Error("unused"); }
  handleWebhook(): Promise<WebhookResult> { throw new Error("unused"); }
}
async function setup(status = "CONNECTED", enabled = true, environment = "production", accepted = ["pix"]) {
  const slug = `charge-${crypto.randomUUID()}`;
  const tenant = (await pool.query<{ id: string}>("INSERT INTO tenants(name,slug,status) VALUES($1,$1,'active') RETURNING id", [slug])).rows[0].id;
  const provider = (await pool.query<{ id: string}>("INSERT INTO billing_providers(homologated,code,name,enabled,environment,status,accepted_methods,credentials_encrypted) VALUES(true,$1,$2,$3,$4,$5,$6,'x') RETURNING id", [slug, "Fake", enabled, environment, status, accepted])).rows[0].id;
  const invoice = (await pool.query<{ id: string}>("INSERT INTO invoices(tenant_id,provider_id,kind,amount_cents,currency,status,external_id) VALUES($1,$2,'ONE_OFF',8970,'BRL','open',$3) RETURNING id", [tenant, provider, `invoice:${slug}`])).rows[0].id;
  await pool.query("INSERT INTO billing_accounts(tenant_id,provider_id,email,document) VALUES($1,$2,'payer@example.com','123')", [tenant, provider]); ids.push(tenant); return { tenant, provider, invoice };
}
const fake = () => new FakeProvider();

describe("invoice charges against Postgres", () => {
  beforeAll(async () => { await pool.query("SELECT 1"); });
  afterAll(async () => { for (const id of ids) await pool.query("DELETE FROM tenants WHERE id=$1", [id]); await pool.end(); });
  it("creates production charge with invoice reference and deterministic identity", async () => { const x=await setup(); const p=fake(); const r=await createChargeForInvoice(x.invoice,"pix",{db:pool,provider:p}); const ext=(await pool.query("SELECT external_id FROM invoices WHERE id=$1",[x.invoice])).rows[0].external_id; expect(p.calls[0]).toMatchObject({invoiceId:x.invoice,externalReference:ext,idempotencyKey:`atendon-invoice-${x.invoice}`,amountCents:8970,currency:"BRL",method:"pix",payer:{email:"payer@example.com",identification:{type:"CPF",number:"123"}}}); expect(r.externalId).toBe("mp-123"); });
  it("charges a non-BRL invoice in the invoice currency", async () => { const x=await setup(); await pool.query("UPDATE invoices SET currency='USD' WHERE id=$1", [x.invoice]); const p=fake(); await createChargeForInvoice(x.invoice,"pix",{db:pool,provider:p}); expect(p.calls[0].currency).toBe("USD"); expect((await pool.query("SELECT currency FROM payments WHERE invoice_id=$1", [x.invoice])).rows[0].currency).toBe("USD"); });
  it("never selects sandbox or disconnected providers", async () => { for (const s of [["CONNECTED",true,"sandbox"],["DISCONNECTED",true,"production"],["CONNECTED",false,"production"]] as const) { const x=await setup(s[0],s[1],s[2]); const p=fake(); await expect(createChargeForInvoice(x.invoice,"pix",{db:pool,provider:p})).rejects.toThrow(); expect(p.calls).toHaveLength(0); } });
  it("rejects unsupported method before network", async () => { const x=await setup(); const p=fake(); await expect(createChargeForInvoice(x.invoice,"card",{db:pool,provider:p})).rejects.toThrow(); expect(p.calls).toHaveLength(0); });
  it("repeated calls return the same external charge", async () => { const x=await setup(); const p=fake(); const a=await createChargeForInvoice(x.invoice,"pix",{db:pool,provider:p}); const b=await createChargeForInvoice(x.invoice,"pix",{db:pool,provider:p}); expect(p.calls).toHaveLength(1); expect(b.externalId).toBe(a.externalId); });
  it("concurrent calls invoke the provider once", async () => { const x=await setup(); const p=fake(); const [a,b]=await Promise.all([createChargeForInvoice(x.invoice,"pix",{db:pool,provider:p}),createChargeForInvoice(x.invoice,"pix",{db:pool,provider:p})]); expect(p.calls).toHaveLength(1); expect(a.externalId).toBe(b.externalId); });
  it("network failure leaves invoice retryable and hides provider error", async () => { const x=await setup(); const p=fake(); p.failures=true; await expect(createChargeForInvoice(x.invoice,"pix",{db:pool,provider:p})).rejects.toThrow("tente novamente"); const row=await pool.query("SELECT status,paid_at FROM invoices WHERE id=$1",[x.invoice]); expect(row.rows[0]).toMatchObject({status:"open",paid_at:null}); });
  it("optimistic finalization mismatch is safe", async () => { const x=await setup(); const p=fake(); const original=p.createPayment.bind(p); p.createPayment=async input=>{ const r=await original(input); await pool.query("UPDATE invoices SET external_id='changed' WHERE id=$1",[x.invoice]); return r; }; await expect(createChargeForInvoice(x.invoice,"pix",{db:pool,provider:p})).rejects.toThrow("alterada"); expect((await pool.query("SELECT count(*) FROM payments WHERE invoice_id=$1",[x.invoice])).rows[0].count).toBe("0"); });
  it("webhook reference locates the invoice", async () => { const x=await setup(); const ref=(await pool.query("SELECT external_id FROM invoices WHERE id=$1",[x.invoice])).rows[0].external_id; expect((await pool.query("SELECT id FROM invoices WHERE external_id=$1",[ref])).rows[0].id).toBe(x.invoice); });
  it("stale pending payment does not block a real retry (freshness 12h)", async () => { const x=await setup(); await pool.query("INSERT INTO payments(tenant_id,invoice_id,provider_id,external_id,amount_cents,currency,status,method,created_at) VALUES($1,$2,$3,'mp-old',$4,'BRL','pending','pix',now()-interval '13 hours')",[x.tenant,x.invoice,x.provider,8970]); const p=fake(); const r=await createChargeForInvoice(x.invoice,"pix",{db:pool,provider:p}); expect(p.calls).toHaveLength(1); expect((await pool.query("SELECT count(*)::int n FROM payments WHERE invoice_id=$1",[x.invoice])).rows[0].n).toBe(2); expect(r.externalId).toBe("mp-123"); });
  it("fresh pending payment keeps the short-circuit (no provider call)", async () => { const x=await setup(); await pool.query("INSERT INTO payments(tenant_id,invoice_id,provider_id,external_id,amount_cents,currency,status,method,created_at) VALUES($1,$2,$3,'mp-new',$4,'BRL','pending','pix',now())",[x.tenant,x.invoice,x.provider,8970]); const p=fake(); const r=await createChargeForInvoice(x.invoice,"pix",{db:pool,provider:p}); expect(p.calls).toHaveLength(0); expect(r.externalId).toBe("mp-new"); expect(r.status).toBe("pending"); });
});

describe("Mercado Pago payment identity", () => { it("sends idempotency key and invoice external reference, never tenant id", async () => { let init: RequestInit | undefined; const p=new MercadoPagoProvider({credentialsEncrypted:encryptCredentials({accessToken:"x"},"a".repeat(32)),encryptionKey:"a".repeat(32),fetchImpl:async(_u,i)=>{init=i;return new Response(JSON.stringify({id:"1",status:"pending"}),{status:201});}}); await p.createPayment({tenantId:"tenant",invoiceId:"inv",externalReference:"invoice:inv",idempotencyKey:"key",amountCents:100,currency:"BRL",method:"pix"}); expect(init).toBeDefined(); const body=JSON.parse(init!.body as string); expect((init!.headers as Record<string, string>)["X-Idempotency-Key"]).toBe("key"); expect(body.external_reference).toBe("invoice:inv"); expect(body.external_reference).not.toBe("tenant"); }); });
