import { describe, expect, it } from "vitest";
import { buildPixPayload, ManualPixProvider } from "../src/billing/providers/manual-pix.js";
import { credentialsHint, encryptCredentials } from "../src/billing/providers/credentials.js";
import { getProvider } from "../src/billing/providers/registry.js";
import { NotImplementedError } from "../src/billing/providers/types.js";
import { MercadoPagoProvider } from "../src/billing/providers/mercadopago.js";

describe("billing providers",()=>{
 it("generates valid PIX CRC",()=>{const p=buildPixPayload({pixKey:"pix@example.com",receiverName:"Teste",city:"Sao Paulo"},12345,"TX123"); expect(p).toContain("pix@example.com"); expect(p).toContain("123.45"); let crc=0xffff; for(const byte of Buffer.from(p.slice(0,-4),"utf8")){crc^=byte<<8; for(let i=0;i<8;i++) crc=(crc&0x8000)?((crc<<1)^0x1021)&0xffff:(crc<<1)&0xffff;} expect(p.slice(-4)).toBe(crc.toString(16).toUpperCase().padStart(4,"0"));});
 it("masks credentials",()=>{const s="super-secret-token"; const h=credentialsHint(s); expect(h).toBe("••••oken"); expect(h).not.toContain(s); expect(encryptCredentials(s,"a".repeat(32))).not.toContain(s);});
 it("validates Mercado Pago signatures",async()=>{const p=new MercadoPagoProvider({credentialsEncrypted:encryptCredentials({accessToken:"x"},"a".repeat(32)),encryptionKey:"a".repeat(32)}); const raw=JSON.stringify({data:{id:"abc"},type:"payment"}); expect((await p.handleWebhook(raw,{"x-signature":"ts=1,v1=bad","x-request-id":"req"},"secret")).signatureValid).toBe(false); const {createHmac}=await import("node:crypto"); const sig=createHmac("sha256","secret").update("id:abc;request-id:req;ts:1;").digest("hex"); expect((await p.handleWebhook(raw,{"x-signature":`ts=1,v1=${sig}`,"x-request-id":"req"},"secret")).signatureValid).toBe(true);});
 it("resolves registered providers",()=>{expect(getProvider("manual_pix",{manualPix:{pixKey:"x",receiverName:"A",city:"B"}})).toBeInstanceOf(ManualPixProvider); expect(getProvider("mercadopago",{mercadopago:{credentialsEncrypted:encryptCredentials({accessToken:"x"},"a".repeat(32)),encryptionKey:"a".repeat(32)}})).toBeInstanceOf(MercadoPagoProvider); expect(()=>getProvider("nope")).toThrow();});
 it("stubs throw",()=>{expect(()=>getProvider("stripe").createCustomer({tenantId:"x"})).toThrow(NotImplementedError); expect(()=>getProvider("pagbank").createCustomer({tenantId:"x"})).toThrow(NotImplementedError);});
});
