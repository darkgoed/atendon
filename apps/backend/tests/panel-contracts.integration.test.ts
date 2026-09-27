// Auditoria P1 (contratos painel ↔ API): C2, C8 e C9 contra o buildApp real.
import { createHash, randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { getUsageDashboard } from "../src/billing/alerts.js";
import { config } from "../src/config.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const suffix = randomUUID();
const password = "panel-contracts-42";
const email = `panel-contracts-${suffix}@test.local`;
let tenantId = "";
let userId = "";
let planId = "";
const invitedEmail = `panel-contracts-invited-${suffix}@test.local`;

async function login() {
  const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers["set-cookie"]!;
  return (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
}

beforeAll(async () => {
  await app.ready();
  tenantId = (await pool.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$1,'active') RETURNING id", [`panel-contracts-${suffix}`])).rows[0].id;
  const client = await pool.connect();
  try { await ensureWorkspaceDefaultRoles(client, tenantId); } finally { client.release(); }
  userId = (await pool.query<{ id: string }>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id", [email, await hash(password, 4)])).rows[0].id;
  await pool.query(
    "INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'",
    [tenantId, userId]
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  if (planId) await pool.query("DELETE FROM plans WHERE id=$1", [planId]);
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE id=$1 OR email=$2)", [userId, invitedEmail]);
  await pool.query("DELETE FROM users WHERE id=$1 OR email=$2", [userId, invitedEmail]);
  await app.close();
  await pool.end();
});

describe("C8 — ZodError vira mensagem legível (400)", () => {
  it("mensagens padrão do zod saem em português com o caminho do campo, nunca o JSON cru", async () => {
    const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "nao-e-email" } });
    expect(response.statusCode).toBe(400);
    const { error } = response.json();
    expect(error).not.toMatch(/^\s*\[/);
    expect(error).not.toContain("\"code\"");
    expect(error).toBe("Campo email: e-mail inválido; Campo password: campo obrigatório");
  });

  it("mensagens próprias do schema (refine) passam intactas", async () => {
    const cookie = await login();
    const response = await app.inject({ method: "PATCH", url: "/me/profile", headers: { cookie }, payload: {} });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Informe nome, e-mail ou nova senha");
  });
});

describe("C2 — senha atual errada não é sessão expirada (nunca 401)", () => {
  it("PATCH /me/profile com senha atual errada → 400 e a sessão segue válida", async () => {
    const cookie = await login();
    const response = await app.inject({
      method: "PATCH", url: "/me/profile", headers: { cookie },
      payload: { newPassword: "outra-senha-muito-longa", currentPassword: "senha-errada" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Senha atual inválida");
    expect((await app.inject({ url: "/me", headers: { cookie } })).statusCode).toBe(200);
  });

  it("POST /me/totp/deactivate com senha atual errada → 400", async () => {
    const cookie = await login();
    const response = await app.inject({
      method: "POST", url: "/me/totp/deactivate", headers: { cookie }, payload: { current_password: "senha-errada" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Senha atual inválida");
  });
});

describe("C9 — /uso: crédito sem teto e prévia de rollover", () => {
  it("UNLIMITED devolve creditLimitCents=null e o dashboard traz rolloverPreviewInteractions", async () => {
    planId = (await pool.query<{ id: string }>(
      "INSERT INTO plans(code,name,billing_period_months,monthly_price_cents,rollover_enabled,rollover_rate_bps,rollover_max_percentage_bps) VALUES($1,$1,1,0,true,5000,5000) RETURNING id",
      [`PC_${suffix}`]
    )).rows[0].id;
    await pool.query("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) VALUES($1,$2,'ACTIVE',now()-interval '10 days',now()+interval '20 days')", [tenantId, planId]);
    await pool.query(
      "INSERT INTO usage_periods(tenant_id,subscription_id,sequence,start_at,end_at,included_limit,included_usage,status) VALUES($1,(SELECT id FROM tenant_subscriptions WHERE tenant_id=$1),1,now()-interval '10 days',now()+interval '20 days',1000,200,'OPEN')",
      [tenantId]
    );
    await pool.query(
      "INSERT INTO tenant_usage_credit_settings(tenant_id,enabled,limit_type,monthly_spending_limit_cents,confirmed_unlimited_at) VALUES($1,true,'UNLIMITED',NULL,now())",
      [tenantId]
    );
    const client = await pool.connect();
    try {
      const dashboard = await getUsageDashboard(client, tenantId);
      expect(dashboard?.creditLimitCents).toBeNull();
      // 800 não usados × 50% = 400; teto 50% de 1000 = 500 → 400.
      expect(dashboard?.rolloverPreviewInteractions).toBe(400);
    } finally {
      client.release();
    }
  });
});

describe("Convite — existingUser espelha a regra do aceite", () => {
  it("usuário 'invited' com senha gravada recebe o formulário de nova senha e o aceite funciona", async () => {
    await pool.query("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'invited')", [invitedEmail, await hash("senha-antiga-42", 4)]);
    const token = `${randomUUID()}${randomUUID()}`;
    await pool.query(
      `INSERT INTO workspace_invitations(workspace_id,email,role_id,token_hash,status,expires_at,invited_by_user_id)
       SELECT $1,$2,id,$3,'pending',now()+interval '1 day',$4 FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR'`,
      [tenantId, invitedEmail, createHash("sha256").update(token).digest("hex"), userId]
    );
    const invitation = await app.inject({ url: `/invitations/${token}` });
    expect(invitation.json().invitation.existingUser).toBe(false);
    const accepted = await app.inject({
      method: "POST", url: "/auth/accept-invitation",
      payload: { token, newPassword: "nova-senha-convite-42", passwordConfirmation: "nova-senha-convite-42" }
    });
    expect(accepted.statusCode).toBe(200);
  });
});
