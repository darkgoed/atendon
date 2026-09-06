import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { config } from "../src/config.js";
import type { EmailMessage, EmailProvider } from "../src/mail/email-provider.js";
import { setEmailProviderForTests } from "../src/mail/index.js";

/**
 * Cadastro de empresa nova precisa ser vendável e genérico.
 *
 * Antes desta rodada, TODA empresa nascia em LEGACY_UNLIMITED (preço 0,
 * is_internal, todas as features, todos os limites NULL) e o cadastro exigia
 * apontar OUTRA empresa como molde de capabilities — o que entregava o produto
 * de graça e vazava configuração entre clientes.
 */

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const suffix = randomUUID();
const password = "onboarding-42";
const rootEmail = `root-onboarding-${suffix}@test.local`;
const sentEmails: EmailMessage[] = [];
const fakeEmailProvider: EmailProvider = { isConfigured: true, async send(message) { sentEmails.push(message); } };

let rootCookie = "";
const createdTenants: string[] = [];

async function createWorkspace(payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/root/workspaces", headers: { cookie: rootCookie }, payload });
}

async function subscriptionOf(tenantId: string) {
  const result = await pool.query<{ status: string; trial_ends_at: string | null; plan_code: string }>(
    `SELECT s.status, s.trial_ends_at, p.code AS plan_code
       FROM tenant_subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.tenant_id = $1`,
    [tenantId]
  );
  return result.rows[0];
}

beforeAll(async () => {
  setEmailProviderForTests(fakeEmailProvider);
  const rootUser = await pool.query<{ id: string }>(
    `INSERT INTO users(email,name,password_hash,status,is_root) VALUES($1,'Root Onboarding',$2,'active',true) RETURNING id`,
    [rootEmail, await hash(password, 4)]
  );
  // O login exige um workspace ativo (app.ts: 403 "Usuário sem workspace ativo"),
  // então o ROOT precisa ser membro de algum — inclusive para criar outros.
  const homeTenant = await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id",
    [`Root Home ${suffix}`, `root-home-${suffix}`]
  );
  createdTenants.push(homeTenant.rows[0].id);
  const client = await pool.connect();
  try {
    await ensureWorkspaceDefaultRoles(client, homeTenant.rows[0].id);
  } finally {
    client.release();
  }
  await pool.query(
    `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
     SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND is_owner_role=true`,
    [homeTenant.rows[0].id, rootUser.rows[0].id]
  );
  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    // O rate limit de login é por IP; sem remoteAddress a suíte cai em 429.
    remoteAddress: "10.44.9.1",
    payload: { email: rootEmail, password }
  });
  expect(login.statusCode).toBe(200);
  const setCookie = login.headers["set-cookie"]!;
  rootCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
  expect(rootCookie).toContain("=");
});

afterAll(async () => {
  // Ordem importa: sessões/memberships e assinaturas penduram no tenant, e o
  // usuário ROOT é referenciado por created_by_user_id.
  if (createdTenants.length) await pool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [createdTenants]);
  await pool.query("UPDATE tenants SET created_by_user_id=NULL WHERE created_by_user_id=(SELECT id FROM users WHERE email=$1)", [rootEmail]);
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id=(SELECT id FROM users WHERE email=$1)", [rootEmail]);
  await pool.query("DELETE FROM users WHERE email=$1", [rootEmail]);
  setEmailProviderForTests(undefined);
  await app.close();
  await pool.end();
});

describe("cadastro genérico de empresa", () => {
  it("cria a empresa SEM exigir um workspace-modelo", async () => {
    const response = await createWorkspace({
      name: `Empresa Sem Molde ${suffix}`,
      ownerEmail: `sem-molde-${suffix}@test.local`
    });
    expect(response.statusCode).toBe(201);
    const tenantId = response.json().workspace.id as string;
    createdTenants.push(tenantId);
    expect(tenantId).toBeTruthy();
  });

  it("NÃO coloca a empresa nova no plano interno ilimitado", async () => {
    const response = await createWorkspace({
      name: `Empresa Plano Padrao ${suffix}`,
      ownerEmail: `plano-padrao-${suffix}@test.local`
    });
    expect(response.statusCode).toBe(201);
    const tenantId = response.json().workspace.id as string;
    createdTenants.push(tenantId);

    const subscription = await subscriptionOf(tenantId);
    // O ponto do teste: um plano gratuito, interno e sem limites nunca pode ser
    // o padrão silencioso de quem se cadastra.
    expect(subscription.plan_code).not.toBe("LEGACY_UNLIMITED");

    const plan = await pool.query<{ is_internal: boolean; monthly_price_cents: string }>(
      "SELECT is_internal, monthly_price_cents FROM plans WHERE code=$1",
      [subscription.plan_code]
    );
    expect(plan.rows[0].is_internal).toBe(false);
    expect(Number(plan.rows[0].monthly_price_cents)).toBeGreaterThan(0);
  });

  it("resolve o plano padrão por dado, sem código hardcoded na aplicação", async () => {
    const configured = await pool.query<{ code: string }>("SELECT code FROM plans WHERE is_default=true");
    expect(configured.rowCount).toBe(1);
    const response = await createWorkspace({
      name: `Empresa Default Data Driven ${suffix}`,
      ownerEmail: `default-dado-${suffix}@test.local`
    });
    expect(response.statusCode).toBe(201);
    const tenantId = response.json().workspace.id as string;
    createdTenants.push(tenantId);
    expect((await subscriptionOf(tenantId)).plan_code).toBe(configured.rows[0].code);
  });

  it("respeita o plano informado por planCode", async () => {
    const response = await createWorkspace({
      name: `Empresa Pro ${suffix}`,
      ownerEmail: `pro-${suffix}@test.local`,
      planCode: "PRO"
    });
    expect(response.statusCode).toBe(201);
    const tenantId = response.json().workspace.id as string;
    createdTenants.push(tenantId);
    expect((await subscriptionOf(tenantId)).plan_code).toBe("PRO");
  });

  it("inicia o trial quando o plano tem trial_days, e não inicia quando não tem", async () => {
    const trialCode = `TRIAL_${suffix.slice(0, 8).toUpperCase()}`;
    await pool.query(
      `INSERT INTO plans(code,name,monthly_price_cents,billing_period_months,trial_days,status)
       VALUES($1,$1,19700,1,14,'active')`,
      [trialCode]
    );
    const trialTenants: string[] = [];
    try {
      const response = await createWorkspace({
        name: `Empresa Trial ${suffix}`,
        ownerEmail: `trial-${suffix}@test.local`,
        planCode: trialCode
      });
      expect(response.statusCode).toBe(201);
      const tenantId = response.json().workspace.id as string;
      trialTenants.push(tenantId);

      const subscription = await subscriptionOf(tenantId);
      expect(subscription.plan_code).toBe(trialCode);
      expect(subscription.trial_ends_at).not.toBeNull();
      // 14 dias de trial: a data de término tem de estar no futuro.
      expect(new Date(subscription.trial_ends_at as string).getTime()).toBeGreaterThan(Date.now());

      // Plano sem trial_days não pode ganhar trial_ends_at.
      const noTrial = await createWorkspace({
        name: `Empresa Sem Trial ${suffix}`,
        ownerEmail: `sem-trial-${suffix}@test.local`,
        planCode: "BASIC"
      });
      const noTrialTenant = noTrial.json().workspace.id as string;
      createdTenants.push(noTrialTenant);
      const basic = await subscriptionOf(noTrialTenant);
      expect(basic.trial_ends_at).toBeNull();
      expect(basic.status).toBe("ACTIVE");
    } finally {
      // O tenant referencia o plano; remova a assinatura antes do plano para
      // não violar tenant_subscriptions_plan_id_fkey.
      await pool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [trialTenants]);
      await pool.query("DELETE FROM plans WHERE code=$1", [trialCode]);
    }
  });

  it("recusa plano inexistente ou arquivado em vez de cair num padrão silencioso", async () => {
    const response = await createWorkspace({
      name: `Empresa Plano Invalido ${suffix}`,
      ownerEmail: `invalido-${suffix}@test.local`,
      planCode: "PLANO_QUE_NAO_EXISTE"
    });
    expect(response.statusCode).toBe(404);
  });
});
