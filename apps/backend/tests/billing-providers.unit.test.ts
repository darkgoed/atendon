import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildPixPayload, ManualPixProvider } from "../src/billing/providers/manual-pix.js";
import { credentialsHint, encryptCredentials } from "../src/billing/providers/credentials.js";
import { getProvider } from "../src/billing/providers/registry.js";
import { NotImplementedError } from "../src/billing/providers/types.js";
import { MercadoPagoProvider } from "../src/billing/providers/mercadopago.js";

const encryptionKey = "a".repeat(32);
const credentialsEncrypted = encryptCredentials({ accessToken: "x" }, encryptionKey);

function signatureFor(manifest: string, secret: string): string {
  return createHmac("sha256", secret).update(manifest).digest("hex");
}

describe("billing providers", () => {
  it("generates valid PIX CRC", () => {
    const p = buildPixPayload({ pixKey: "pix@example.com", receiverName: "Teste", city: "Sao Paulo" }, 12345, "TX123");
    expect(p).toContain("pix@example.com");
    expect(p).toContain("123.45");
    let crc = 0xffff;
    for (const byte of Buffer.from(p.slice(0, -4), "utf8")) {
      crc ^= byte << 8;
      for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    expect(p.slice(-4)).toBe(crc.toString(16).toUpperCase().padStart(4, "0"));
  });

  it("masks credentials", () => {
    const s = "super-secret-token";
    const h = credentialsHint(s);
    expect(h).toBe("••••oken");
    expect(h).not.toContain(s);
    expect(encryptCredentials(s, encryptionKey)).not.toContain(s);
  });

  it("validates Mercado Pago signatures", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({
        id: "abc",
        status: "approved",
        transaction_amount: 42.5,
        currency_id: "BRL",
        external_reference: "tenant-from-get",
        external_invoice_id: "invoice-from-get",
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const p = new MercadoPagoProvider({ credentialsEncrypted, encryptionKey, fetchImpl });
    const raw = JSON.stringify({ data: { id: "ABC" }, type: "payment" });
    const secret = "secret";
    const headers = { "x-request-id": "req" };

    const invalid = await p.handleWebhook(raw, { ...headers, "x-signature": "ts=1,v1=bad" }, secret);
    expect(invalid.signatureValid).toBe(false);
    expect(calls).toEqual([]);

    const valid = await p.handleWebhook(raw, { ...headers, "x-signature": `ts=1,v1=${signatureFor("id:abc;request-id:req;ts:1;", secret)}` }, secret);
    expect(valid.signatureValid).toBe(true);
    expect(calls).toEqual(["https://api.mercadopago.com/v1/payments/ABC"]);
    expect(valid.amountCents).toBe(4250);
    expect(valid.currency).toBe("BRL");
    expect(valid.externalReference).toBe("tenant-from-get");
    expect(valid.externalInvoiceId).toBe("invoice-from-get");
    expect(valid.payload).toEqual({ data: { id: "ABC" }, type: "payment" });
  });

  it("minusculiza o data.id do manifesto preservando os demais caracteres", async () => {
    // A especificação do Mercado Pago manda apenas minusculizar o data.id no
    // manifesto. Remover caracteres (hífen, ponto) altera o valor assinado pelo
    // provedor e faz webhooks legítimos serem rejeitados com 401 em retry eterno.
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ id: "ABC", status: "approved" }), { status: 200 });
    };
    const p = new MercadoPagoProvider({ credentialsEncrypted, encryptionKey, fetchImpl });
    const raw = JSON.stringify({ data: { id: "Ab-C" }, type: "payment" });
    const result = await p.handleWebhook(raw, {
      "x-request-id": "req",
      "x-signature": `ts=1,v1=${signatureFor("id:ab-c;request-id:req;ts:1;", "secret")}`,
    }, "secret");
    expect(result.signatureValid).toBe(true);
    expect(calls).toEqual(["https://api.mercadopago.com/v1/payments/Ab-C"]);
  });

  it("rejeita assinatura calculada sobre um data.id com caracteres removidos", async () => {
    // Guarda de regressão: o manifesto NÃO pode voltar a apagar caracteres.
    const p = new MercadoPagoProvider({
      credentialsEncrypted,
      encryptionKey,
      fetchImpl: async () => new Response(JSON.stringify({ id: "ABC", status: "approved" }), { status: 200 })
    });
    const raw = JSON.stringify({ data: { id: "Ab-C" }, type: "payment" });
    const result = await p.handleWebhook(raw, {
      "x-request-id": "req",
      "x-signature": `ts=1,v1=${signatureFor("id:abc;request-id:req;ts:1;", "secret")}`,
    }, "secret");
    expect(result.signatureValid).toBe(false);
  });

  it("accepts a manifest without optional data.id", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ id: "unexpected" }), { status: 200 });
    };
    const p = new MercadoPagoProvider({ credentialsEncrypted, encryptionKey, fetchImpl });
    const raw = JSON.stringify({ data: {}, type: "payment" });
    const result = await p.handleWebhook(raw, {
      "x-request-id": "req",
      "x-signature": `ts=1,v1=${signatureFor("request-id:req;ts:1;", "secret")}`,
    }, "secret");
    expect(result.signatureValid).toBe(true);
    // Chave de dedupe nova (action:resource:status) — sem data.id o evento é
    // gravado como no-op (gate !authenticated), mas a chave permanece estável.
    expect(result.externalEventId).toBe("payment::unknown");
    expect(calls).toEqual([]);
  });

  it("builds manifests without request id and enforces timestamp tolerance", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ id: "abc", transaction_amount: 1 }), { status: 200 });
    };
    const p = new MercadoPagoProvider({ credentialsEncrypted, encryptionKey, fetchImpl, signatureToleranceSeconds: 30 });
    const now = Math.floor(Date.now() / 1000);
    const secondsManifest = `id:abc;ts:${now};`;
    const seconds = await p.handleWebhook(JSON.stringify({ data: { id: "ABC" } }), {
      "x-signature": `ts=${now},v1=${signatureFor(secondsManifest, "secret")}`,
    }, "secret");
    expect(seconds.signatureValid).toBe(true);
    expect(calls).toHaveLength(1);

    const milliseconds = now * 1000;
    const msManifest = `id:abc;ts:${milliseconds};`;
    const ms = await p.handleWebhook(JSON.stringify({ data: { id: "ABC" } }), {
      "x-signature": `ts=${milliseconds},v1=${signatureFor(msManifest, "secret")}`,
    }, "secret");
    expect(ms.signatureValid).toBe(true);

    const stale = now - 31;
    const staleManifest = `id:abc;ts:${stale};`;
    const staleResult = await p.handleWebhook(JSON.stringify({ data: { id: "ABC" } }), {
      "x-signature": `ts=${stale},v1=${signatureFor(staleManifest, "secret")}`,
    }, "secret");
    expect(staleResult.signatureValid).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("builds a timestamp-only manifest when both optional fields are absent", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => { calls.push(String(input)); return new Response("{}", { status: 200 }); };
    const p = new MercadoPagoProvider({ credentialsEncrypted, encryptionKey, fetchImpl });
    const result = await p.handleWebhook(JSON.stringify({ data: {} }), {
      "x-signature": `ts=1,v1=${signatureFor("ts:1;", "secret")}`,
    }, "secret");
    expect(result.signatureValid).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("resolves registered providers", () => {
    expect(getProvider("manual_pix", { manualPix: { pixKey: "x", receiverName: "A", city: "B" } })).toBeInstanceOf(ManualPixProvider);
    expect(getProvider("mercadopago", { mercadopago: { credentialsEncrypted, encryptionKey } })).toBeInstanceOf(MercadoPagoProvider);
    expect(() => getProvider("nope")).toThrow();
  });

  it("stubs throw", () => {
    expect(() => getProvider("stripe").createCustomer({ tenantId: "x" })).toThrow(NotImplementedError);
    expect(() => getProvider("pagbank").createCustomer({ tenantId: "x" })).toThrow(NotImplementedError);
  });
});
