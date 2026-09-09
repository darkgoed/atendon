import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";

/**
 * Conta de cobranca do tenant e listagem de faturas do ROOT.
 *
 * billing_accounts existia desde 0132 e NUNCA teve produtor: charges.ts:47 lia
 * document/email e reconciler.ts:60 lia provider_id de uma tabela que ninguem
 * populava. A aba Cobrancas do painel tambem ficava desabilitada porque nao
 * havia endpoint de consulta de faturas.
 */
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const suffix = randomUUID();
const password = "billing-account-test";
const rootEmail = `bacc-root-${suffix}@test.local`;
const memberEmail = `bacc-member-${suffix}@test.local`;
let tenant = "";
let otherTenant = "";
let invoiceId = "";
let providerId = "";

async function login(email: string) {
  const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(response.statusCode).toBe(200);
  const cookie = response.headers["set-cookie"]!;
  return (Array.isArray(cookie) ? cookie[0] : cookie).split(";")[0];
}

let rootCookie = "";
let memberCookie = "";

beforeAll(async () => {
  await app.ready();
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    tenant = (await c.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`BAcc ${suffix}`, `bacc-${suffix}`])).rows[0].id;
    otherTenant = (await c.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`BAcc2 ${suffix}`, `bacc2-${suffix}`])).rows[0].id;
    const ph = await hash(password, 4);
    await c.query("INSERT INTO users(email,password_hash,status,is_root) VALUES($1,$2,'active',true)", [rootEmail, ph]);
    const member = (await c.query<{ id: string }>("INSERT INTO users(email,password_hash,status,is_root) VALUES($1,$2,'active',false) RETURNING id", [memberEmail, ph])).rows[0].id;
    await ensureWorkspaceDefaultRoles(c, tenant);
    const role = (await c.query<{ id: string }>("SELECT id FROM workspace_roles WHERE workspace_id=$1 ORDER BY created_at LIMIT 1", [tenant])).rows[0].id;
    await c.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status) VALUES($1,$2,$3,'active')", [tenant, member, role]);
    // Outras suítes (billing-oauth-api) apagam a linha global de
    // billing_providers no seu próprio ciclo. A migration 0140 é idempotente e
    // recria a linha, mas NÃO homologa: quem homologa mercadopago é a 0142, e
    // a coluna nasce com DEFAULT false. Reaplicar só a 0140 devolveria um
    // provedor não homologado e o PUT abaixo responderia 400 em vez de 200.
    // Por isso reproduzimos aqui as duas etapas do estado pós-migração.
    await c.query(await readFile(new URL("../src/db/migrations/0140_billing_provider_provisioning.sql", import.meta.url), "utf8"));
    await c.query("UPDATE billing_providers SET homologated=true, updated_at=now() WHERE code='mercadopago'");
    providerId = (await c.query<{ id: string }>("SELECT id FROM billing_providers WHERE code='mercadopago' AND environment='production'")).rows[0].id;
    invoiceId = (await c.query<{ id: string }>(
      `INSERT INTO invoices(tenant_id,kind,amount_cents,currency,status,due_date,period_start,period_end)
       VALUES($1,'usage',12345,'BRL','open',now()+interval '5 days',now()-interval '1 month',now()) RETURNING id`, [tenant]
    )).rows[0].id;
    await c.query("COMMIT");
  } catch (error) { await c.query("ROLLBACK"); throw error; } finally { c.release(); }
  rootCookie = await login(rootEmail);
  memberCookie = await login(memberEmail);
});

afterAll(async () => {
  if (invoiceId) await pool.query("DELETE FROM payments WHERE invoice_id=$1", [invoiceId]);
  const tenants = [tenant, otherTenant].filter(Boolean);
  if (tenants.length) {
    await pool.query("DELETE FROM billing_accounts WHERE tenant_id = ANY($1::uuid[])", [tenants]);
    await pool.query("DELETE FROM invoices WHERE tenant_id = ANY($1::uuid[])", [tenants]);
    await pool.query("DELETE FROM audit_logs WHERE workspace_id = ANY($1::uuid[])", [tenants]);
    await pool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [tenants]);
  }
  await pool.query("DELETE FROM users WHERE email = ANY($1::text[])", [[rootEmail, memberEmail]]);
  await app.close();
  await pool.end();
});

describe("conta de cobrança do tenant (ROOT)", () => {
  it("começa inexistente: era exatamente o buraco que deixava o pagador sem dados", async () => {
    const r = await app.inject({ method: "GET", url: `/root/billing/tenants/${tenant}/account`, headers: { cookie: rootCookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json().account).toBeNull();
  });

  it("ROOT registra o pagador e charges.ts passa a encontrar document/email", async () => {
    const r = await app.inject({
      method: "PUT", url: `/root/billing/tenants/${tenant}/account`, headers: { cookie: rootCookie },
      payload: { providerCode: "mercadopago", environment: "production", document: "12345678909", email: "pagador@test.local" }
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().account).toMatchObject({ tenant_id: tenant, provider_id: providerId, document: "12345678909", email: "pagador@test.local" });

    // O contrato lido por charges.ts:47.
    const payer = await pool.query<{ document: string; email: string }>(
      "SELECT document,email FROM billing_accounts WHERE tenant_id=$1 AND (provider_id=$2 OR provider_id IS NULL) LIMIT 1", [tenant, providerId]);
    expect(payer.rows[0]).toMatchObject({ document: "12345678909", email: "pagador@test.local" });
  });

  it("é upsert: reenviar atualiza sem violar a UNIQUE(tenant_id)", async () => {
    const r = await app.inject({
      method: "PUT", url: `/root/billing/tenants/${tenant}/account`, headers: { cookie: rootCookie },
      payload: { providerCode: "mercadopago", document: "98765432100", email: "novo@test.local" }
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().account.document).toBe("98765432100");
    const count = await pool.query("SELECT 1 FROM billing_accounts WHERE tenant_id=$1", [tenant]);
    expect(count.rowCount).toBe(1);
  });

  it("recusa provedor inexistente em vez de gravar vínculo inválido", async () => {
    const r = await app.inject({
      method: "PUT", url: `/root/billing/tenants/${tenant}/account`, headers: { cookie: rootCookie },
      payload: { providerCode: "gateway-que-nao-existe" }
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe("BILLING_PROVIDER_NOT_FOUND");
  });

  it("valida e-mail malformado", async () => {
    const r = await app.inject({
      method: "PUT", url: `/root/billing/tenants/${tenant}/account`, headers: { cookie: rootCookie },
      payload: { providerCode: "mercadopago", email: "nao-e-email" }
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("usuário comum não acessa nem altera a conta de cobrança", async () => {
    const read = await app.inject({ method: "GET", url: `/root/billing/tenants/${tenant}/account`, headers: { cookie: memberCookie } });
    expect(read.statusCode).toBeGreaterThanOrEqual(401);
    const write = await app.inject({
      method: "PUT", url: `/root/billing/tenants/${tenant}/account`, headers: { cookie: memberCookie },
      payload: { providerCode: "mercadopago", document: "00000000000" }
    });
    expect(write.statusCode).toBeGreaterThanOrEqual(401);
  });
});

describe("listagem de faturas do ROOT (aba Cobranças)", () => {
  it("lista a fatura com o nome do tenant e os pagamentos agregados", async () => {
    await pool.query(
      `INSERT INTO payments(tenant_id,invoice_id,provider_id,external_id,amount_cents,currency,status,method,paid_at)
       VALUES($1,$2,$3,$4,12345,'BRL','paid','pix',now())`, [tenant, invoiceId, providerId, `pay-${suffix}`]);
    const r = await app.inject({ method: "GET", url: `/root/billing/invoices?tenantId=${tenant}`, headers: { cookie: rootCookie } });
    expect(r.statusCode).toBe(200);
    const invoice = r.json().invoices.find((i: { id: string }) => i.id === invoiceId);
    expect(invoice).toBeTruthy();
    expect(invoice.tenant_name).toContain("BAcc");
    expect(Number(invoice.amount_cents)).toBe(12345);
    expect(invoice.payments).toHaveLength(1);
    expect(invoice.payments[0].status).toBe("paid");
  });

  it("filtra por status e respeita o limite", async () => {
    const paid = await app.inject({ method: "GET", url: `/root/billing/invoices?tenantId=${tenant}&status=open`, headers: { cookie: rootCookie } });
    expect(paid.statusCode).toBe(200);
    expect(paid.json().invoices.every((i: { status: string }) => i.status === "open")).toBe(true);
    const none = await app.inject({ method: "GET", url: `/root/billing/invoices?tenantId=${tenant}&status=inexistente`, headers: { cookie: rootCookie } });
    expect(none.json().invoices).toHaveLength(0);
    const limited = await app.inject({ method: "GET", url: "/root/billing/invoices?limit=1", headers: { cookie: rootCookie } });
    expect(limited.json().invoices.length).toBeLessThanOrEqual(1);
  });

  it("usuário comum não lista faturas do SaaS", async () => {
    const r = await app.inject({ method: "GET", url: "/root/billing/invoices", headers: { cookie: memberCookie } });
    expect(r.statusCode).toBeGreaterThanOrEqual(401);
  });
});
