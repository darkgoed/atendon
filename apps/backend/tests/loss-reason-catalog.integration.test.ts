import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { listLossReasons, resolveLossReason } from "../src/modules/commercial-journey/loss-reasons.js";
import { markLeadDisqualified } from "../src/modules/scheduling/service.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
let tenantId = "";
let otherTenantId = "";
let cookie = "";
let testEmails: string[] = [];
let phoneSequence = Number(Date.now().toString().slice(-8));
const nextPhone = () => `5511${String(++phoneSequence).slice(-8).padStart(8, "0")}`;

beforeAll(async () => {
  await app.ready();
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status,slug) VALUES($1,'active',$2) RETURNING id",
    [`Loss reasons ${randomUUID()}`, `loss-reasons-${randomUUID().slice(0, 8)}`]
  )).rows[0].id;
  otherTenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status,slug) VALUES($1,'active',$2) RETURNING id",
    [`Loss reasons foreign ${randomUUID()}`, `loss-foreign-${randomUUID().slice(0, 8)}`]
  )).rows[0].id;
  const email = `loss-reason-${randomUUID()}@test.local`;
  const password = "loss-reason-password";
  testEmails = [email];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantId);
    const passwordHash = await hash(password, 4);
    const user = await client.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",
      [email, passwordHash]
    );
    await client.query(
      "INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'",
      [tenantId, user.rows[0].id]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  cookie = (Array.isArray(login.headers["set-cookie"]) ? login.headers["set-cookie"][0] : login.headers["set-cookie"]!).split(";")[0];
});

afterAll(async () => {
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id IN(SELECT id FROM users WHERE email=ANY($1::text[]))", [testEmails]);
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantId, otherTenantId]]);
  await pool.query("DELETE FROM users WHERE email=ANY($1::text[])", [testEmails]);
  await app.close();
  await pool.end();
});

async function createLead() {
  return (await pool.query<{ id: string }>(
    "INSERT INTO scheduling_leads(tenant_id,phone,name,source) VALUES($1,$2,'Lead motivo','teste') RETURNING id",
    [tenantId, nextPhone()]
  )).rows[0].id;
}

describe("catálogo de motivos de desqualificação", () => {
  it("semeia os motivos padrão para todo tenant novo", async () => {
    const reasons = await listLossReasons(tenantId);
    const keys = reasons.map((reason) => reason.key);
    expect(keys).toEqual(expect.arrayContaining([
      "preco", "sem_interesse", "sem_momento", "nao_qualificado", "concorrente", "sem_retorno", "outro"
    ]));
    expect(reasons.find((reason) => reason.key === "outro")?.requires_note).toBe(true);
    expect(reasons.find((reason) => reason.key === "sem_interesse")?.requires_note).toBe(false);
  });

  it("expõe o catálogo do tenant pela API", async () => {
    const response = await app.inject({ method: "GET", url: "/organization/loss-reasons", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ motivos: Array<{ chave: string; rotulo: string; exige_observacao: boolean }> }>();
    expect(body.motivos.find((motivo) => motivo.chave === "sem_interesse")?.rotulo).toBe("Não tem interesse");
  });

  it("continua servindo o catálogo com case_organization_v1 desligada", async () => {
    // Motivo de perda é jornada comercial: os formulários que consomem este
    // catálogo não estão atrás da flag de organização de casos. Se esta rota
    // exigisse a flag, o select ficaria vazio e ninguém desqualificaria lead.
    await pool.query(
      `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled) VALUES($1,'case_organization_v1',false)
       ON CONFLICT(tenant_id,flag_key) DO UPDATE SET enabled=false`,
      [tenantId]
    );
    try {
      const response = await app.inject({ method: "GET", url: "/organization/loss-reasons", headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ motivos: unknown[] }>().motivos.length).toBeGreaterThan(0);
    } finally {
      await pool.query(
        "DELETE FROM tenant_feature_flag_overrides WHERE tenant_id=$1 AND flag_key='case_organization_v1'",
        [tenantId]
      );
    }
  });

  it("cria um motivo específico do tenant sem vazar para outro tenant", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/organization/loss-reasons",
      headers: { cookie },
      payload: { chave: "queria_emprestimo", rotulo: "Queria somente empréstimo", posicao: 70 }
    });
    expect(created.statusCode).toBe(201);

    const mine = (await listLossReasons(tenantId)).map((reason) => reason.key);
    const foreign = (await listLossReasons(otherTenantId)).map((reason) => reason.key);
    expect(mine).toContain("queria_emprestimo");
    expect(foreign).not.toContain("queria_emprestimo");
  });

  it("recusa um motivo que não pertence ao catálogo do tenant", async () => {
    const client = await pool.connect();
    try {
      await expect(resolveLossReason(client, otherTenantId, "queria_emprestimo"))
        .rejects.toThrow(/Motivo de perda desconhecido/);
    } finally {
      client.release();
    }
  });

  it("exige observação quando o motivo pede e a normaliza", async () => {
    const client = await pool.connect();
    try {
      await expect(resolveLossReason(client, tenantId, "outro"))
        .rejects.toThrow(/observação/);
      await expect(resolveLossReason(client, tenantId, "outro", "   "))
        .rejects.toThrow(/observação/);
      const resolved = await resolveLossReason(client, tenantId, "outro", "  mudou de ramo  ");
      expect(resolved).toEqual({ key: "outro", note: "mudou de ramo" });
      const withoutNote = await resolveLossReason(client, tenantId, "sem_interesse");
      expect(withoutNote).toEqual({ key: "sem_interesse", note: null });
    } finally {
      client.release();
    }
  });

  it("grava motivo e observação ao desqualificar o lead", async () => {
    const leadId = await createLead();
    await markLeadDisqualified(tenantId, leadId, "queria_emprestimo", "só queria capital de giro");
    const row = (await pool.query<{ status: string; loss_reason: string; loss_reason_note: string; commercial_outcome: string }>(
      "SELECT status,loss_reason,loss_reason_note,commercial_outcome FROM scheduling_leads WHERE id=$1",
      [leadId]
    )).rows[0];
    expect(row.status).toBe("perdido");
    expect(row.commercial_outcome).toBe("nao_avancou");
    expect(row.loss_reason).toBe("queria_emprestimo");
    expect(row.loss_reason_note).toBe("só queria capital de giro");
  });

  it("impede no banco um motivo fora do catálogo do tenant", async () => {
    const leadId = await createLead();
    await expect(pool.query(
      "UPDATE scheduling_leads SET status='perdido',commercial_outcome='nao_avancou',loss_reason='motivo_inexistente' WHERE id=$1",
      [leadId]
    )).rejects.toThrow();
  });

  it("arquiva um motivo e passa a recusá-lo em novas desqualificações", async () => {
    const reasons = await listLossReasons(tenantId);
    const target = reasons.find((reason) => reason.key === "queria_emprestimo")!;
    const archived = await app.inject({
      method: "PATCH",
      url: `/organization/loss-reasons/${target.id}`,
      headers: { cookie },
      payload: { arquivado: true }
    });
    expect(archived.statusCode).toBe(200);

    const client = await pool.connect();
    try {
      await expect(resolveLossReason(client, tenantId, "queria_emprestimo"))
        .rejects.toThrow(/arquivado/i);
    } finally {
      client.release();
    }
    expect((await listLossReasons(tenantId)).map((reason) => reason.key)).not.toContain("queria_emprestimo");
    expect((await listLossReasons(tenantId, true)).map((reason) => reason.key)).toContain("queria_emprestimo");
  });
});
