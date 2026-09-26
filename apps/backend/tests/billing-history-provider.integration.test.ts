import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { getBillingHistory } from "../src/billing/invoices.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const suffix = randomUUID();
const providerCode = `efipay-hist-${suffix}`;
let tenant = "";

beforeAll(async () => {
  tenant = (await pool.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`BHist ${suffix}`, `bhist-${suffix}`])).rows[0].id;
  // Fixture de provedor: enabled=false dispensa credenciais/homologação (o teste
  // só exercita o JOIN do histórico, nunca o gateway).
  const provider = (await pool.query<{ id: string }>("INSERT INTO billing_providers(code,name,enabled,environment) VALUES($1,$1,false,'sandbox') RETURNING id", [providerCode])).rows[0].id;
  await pool.query("INSERT INTO invoices(tenant_id,provider_id,kind,amount_cents,status) VALUES($1,$2,'subscription',1000,'pending')", [tenant, provider]);
  await pool.query("INSERT INTO invoices(tenant_id,kind,amount_cents,status) VALUES($1,'subscription',2000,'pending')", [tenant]);
});

afterAll(async () => {
  // Ordem importa: invoices referenciam o provider; tenants limpa o resto em cascata.
  await pool.query("DELETE FROM invoices WHERE tenant_id=$1", [tenant]);
  await pool.query("DELETE FROM billing_providers WHERE code=$1", [providerCode]);
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenant]);
  await pool.end();
});

describe("billing history provider_code", () => {
  it("exposes provider_code of the invoice provider (null without one) and never leaks credentials/metadata", async () => {
    const rows = await getBillingHistory(tenant, 10);
    const byAmount = Object.fromEntries(rows.map((r) => [String(r.amount_cents), r]));
    expect(byAmount["1000"].provider_code).toBe(providerCode);
    expect(byAmount["2000"].provider_code).toBe(null);
    const json = JSON.stringify(rows);
    expect(json).not.toMatch(/credentials/i);
    expect(json).not.toContain("metadata");
  });
});
