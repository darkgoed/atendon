import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashApiKey } from "../src/auth/api-key.js";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const suffix = randomUUID();
const password = "api-keys-security-password";
const ownerEmail = `api-keys-owner-${suffix}@test.local`;
const readerEmail = `api-keys-reader-${suffix}@test.local`;
const deniedEmail = `api-keys-denied-${suffix}@test.local`;

let tenantId = "";
let foreignTenantId = "";
let ownerCookie = "";
let readerCookie = "";
let deniedCookie = "";

async function login(email: string) {
  const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(response.statusCode).toBe(200);
  const cookie = response.headers["set-cookie"]!;
  return (Array.isArray(cookie) ? cookie[0] : cookie).split(";")[0];
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantId = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
      [`API keys ${suffix}`]
    )).rows[0].id;
    foreignTenantId = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
      [`API keys foreign ${suffix}`]
    )).rows[0].id;
    await ensureWorkspaceDefaultRoles(client, tenantId);
    await ensureWorkspaceDefaultRoles(client, foreignTenantId);

    const passwordHash = await hash(password, 4);
    const owner = (await client.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,status,is_root) VALUES($1,$2,'active',true) RETURNING id",
      [ownerEmail, passwordHash]
    )).rows[0];
    const reader = (await client.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",
      [readerEmail, passwordHash]
    )).rows[0];
    const denied = (await client.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",
      [deniedEmail, passwordHash]
    )).rows[0];

    const readerRole = (await client.query<{ id: string }>(
      "INSERT INTO workspace_roles(workspace_id,name,description) VALUES($1,$2,'Leitura de chaves') RETURNING id",
      [tenantId, `API KEY READER ${suffix}`]
    )).rows[0];
    await client.query("INSERT INTO workspace_role_permissions(role_id,permission_key) VALUES($1,'api_keys.read')", [readerRole.id]);
    const deniedRole = (await client.query<{ id: string }>(
      "INSERT INTO workspace_roles(workspace_id,name,description) VALUES($1,$2,'Sem acesso a chaves') RETURNING id",
      [tenantId, `API KEY DENIED ${suffix}`]
    )).rows[0];

    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'`,
      [tenantId, owner.id]
    );
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       VALUES($1,$2,$3,'active',now()),($1,$4,$5,'active',now())`,
      [tenantId, reader.id, readerRole.id, denied.id, deniedRole.id]
    );
    await client.query("INSERT INTO scheduling_categories(tenant_id,id,name) VALUES($1,'api-key-category','Categoria API key')", [tenantId]);
    await client.query("INSERT INTO scheduling_partners(tenant_id,id,name,priority_order,proposal_link) VALUES($1,'api-key-partner','Parceiro API key',1,'https://example.test')", [tenantId]);
    await client.query(
      "INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days) VALUES($1,'api-key-unit','Unidade API key','09:00','18:00',ARRAY[1,2,3,4,5]::smallint[])",
      [tenantId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  ownerCookie = await login(ownerEmail);
  const rootAccess = await app.inject({ method: "POST", url: `/root/workspaces/${tenantId}/access`, headers: { cookie: ownerCookie } });
  expect(rootAccess.statusCode).toBe(200);
  const rootAccessSetCookie = rootAccess.headers["set-cookie"]!;
  ownerCookie = (Array.isArray(rootAccessSetCookie) ? rootAccessSetCookie[0] : rootAccessSetCookie).split(";")[0];
  readerCookie = await login(readerEmail);
  deniedCookie = await login(deniedEmail);
});

afterAll(async () => {
  await pool.query(
    "DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE email=ANY($1::text[]))",
    [[ownerEmail, readerEmail, deniedEmail]]
  );
  await pool.query("DELETE FROM tenants WHERE id IN($1,$2)", [tenantId, foreignTenantId]);
  await pool.query("DELETE FROM users WHERE email=ANY($1::text[])", [[ownerEmail, readerEmail, deniedEmail]]);
  await app.close();
  await pool.end();
});

describe("tenant API key security", () => {
  it("keeps API key administration restricted to ROOT", async () => {
    expect((await app.inject({ url: "/workspaces/current/api-keys", headers: { cookie: deniedCookie } })).statusCode).toBe(403);
    expect((await app.inject({ url: "/workspaces/current/api-keys", headers: { cookie: readerCookie } })).statusCode).toBe(403);
    expect((await app.inject({
      method: "POST",
      url: "/workspaces/current/api-keys",
      headers: { cookie: readerCookie },
      payload: { name: "Sem permissão", scopes: ["scheduling.categories.read"] }
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: "POST",
      url: "/workspaces/current/api-keys",
      headers: { cookie: ownerCookie },
      payload: { name: "Scope inválido", scopes: [] }
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST",
      url: "/workspaces/current/api-keys",
      headers: { cookie: ownerCookie },
      payload: { name: "Expirada ao criar", scopes: ["scheduling.categories.read"], expiresAt: "2020-01-01T00:00:00.000Z" }
    })).statusCode).toBe(400);
  });

  it("creates scoped keys, rotates once, revokes and audits without leaking the secret", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/workspaces/current/api-keys",
      headers: { cookie: ownerCookie },
      payload: {
        name: "Integração limitada",
        scopes: ["scheduling.categories.read"],
        expiresAt: "2035-01-01T00:00:00.000Z"
      }
    });
    expect(created.statusCode).toBe(201);
    const keyId = created.json().apiKey.id as string;
    const firstSecret = created.json().secret as string;
    expect(firstSecret).toMatch(/^atd_[A-Za-z0-9_-]{40,}$/);

    expect((await app.inject({ url: "/categorias", headers: { "x-api-key": firstSecret } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/parceiros", headers: { "x-api-key": firstSecret } })).statusCode).toBe(403);

    const listed = await app.inject({ url: "/workspaces/current/api-keys", headers: { cookie: ownerCookie } });
    expect(listed.statusCode).toBe(200);
    const listedJson = JSON.stringify(listed.json());
    expect(listedJson).not.toContain(firstSecret);
    expect(listedJson).not.toContain(hashApiKey(firstSecret));
    expect(listed.json().apiKeys.find((key: { id: string }) => key.id === keyId)).toMatchObject({
      name: "Integração limitada",
      scopes: ["scheduling.categories.read"],
      status: "active"
    });

    const foreignKey = await pool.query<{ id: string }>(
      "INSERT INTO tenant_api_keys(tenant_id,name,key_hash) VALUES($1,'Foreign',$2) RETURNING id",
      [foreignTenantId, hashApiKey(`foreign-${randomUUID()}`)]
    );
    expect((await app.inject({
      method: "POST",
      url: `/workspaces/current/api-keys/${foreignKey.rows[0].id}/rotate`,
      headers: { cookie: ownerCookie },
      payload: {}
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: "DELETE",
      url: `/workspaces/current/api-keys/${foreignKey.rows[0].id}`,
      headers: { cookie: ownerCookie }
    })).statusCode).toBe(404);

    const rotated = await app.inject({
      method: "POST",
      url: `/workspaces/current/api-keys/${keyId}/rotate`,
      headers: { cookie: ownerCookie },
      payload: { scopes: ["scheduling.categories.read", "scheduling.partners.read"] }
    });
    expect(rotated.statusCode).toBe(201);
    const rotatedId = rotated.json().apiKey.id as string;
    const rotatedSecret = rotated.json().secret as string;
    expect(rotatedSecret).not.toBe(firstSecret);
    expect(rotated.json().apiKey.rotatedFromId).toBe(keyId);
    expect(rotated.json().rotation).toEqual({ previousKeyId: keyId, previousKeyRemainsActive: true });
    expect((await app.inject({ url: "/categorias", headers: { "x-api-key": firstSecret } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/parceiros", headers: { "x-api-key": rotatedSecret } })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: `/workspaces/current/api-keys/${keyId}/rotate`,
      headers: { cookie: ownerCookie },
      payload: {}
    })).statusCode).toBe(409);

    expect((await app.inject({
      method: "DELETE",
      url: `/workspaces/current/api-keys/${keyId}`,
      headers: { cookie: ownerCookie }
    })).statusCode).toBe(204);
    expect((await app.inject({ url: "/categorias", headers: { "x-api-key": firstSecret } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/categorias", headers: { "x-api-key": rotatedSecret } })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/workspaces/current/api-keys/${rotatedId}`, headers: { cookie: ownerCookie } })).statusCode).toBe(204);
    expect((await app.inject({ url: "/categorias", headers: { "x-api-key": rotatedSecret } })).statusCode).toBe(401);

    const audits = await pool.query<{ action: string; metadata: Record<string, unknown> }>(
      "SELECT action,metadata FROM audit_logs WHERE workspace_id=$1 AND action LIKE 'api_keys.%' ORDER BY created_at",
      [tenantId]
    );
    expect(audits.rows.map((row) => row.action)).toEqual(["api_keys.create", "api_keys.rotate.stage", "api_keys.revoke", "api_keys.revoke"]);
    expect(audits.rows[1].metadata).toMatchObject({ newKeyId: rotatedId, previousKeyRemainsActive: true });
    expect(JSON.stringify(audits.rows)).not.toContain(firstSecret);
    expect(JSON.stringify(audits.rows)).not.toContain(rotatedSecret);
    expect(JSON.stringify(audits.rows)).not.toContain(hashApiKey(firstSecret));
  });

  it("rejects expired and revoked keys while legacy rows retain compatible scopes", async () => {
    const expiredSecret = `expired-${randomUUID()}`;
    const expired = await pool.query<{ id: string }>(
      `INSERT INTO tenant_api_keys(tenant_id,name,key_hash,expires_at)
       VALUES($1,'Expired',$2,now() - interval '1 minute') RETURNING id`,
      [tenantId, hashApiKey(expiredSecret)]
    );
    expect((await app.inject({ url: "/categorias", headers: { "x-api-key": expiredSecret } })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST",
      url: `/workspaces/current/api-keys/${expired.rows[0].id}/rotate`,
      headers: { cookie: ownerCookie },
      payload: {}
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "DELETE",
      url: `/workspaces/current/api-keys/${expired.rows[0].id}`,
      headers: { cookie: ownerCookie }
    })).statusCode).toBe(204);

    const revokedSecret = `revoked-${randomUUID()}`;
    await pool.query(
      `INSERT INTO tenant_api_keys(tenant_id,name,key_hash,active,revoked_at)
       VALUES($1,'Revoked',$2,false,now())`,
      [tenantId, hashApiKey(revokedSecret)]
    );
    expect((await app.inject({ url: "/categorias", headers: { "x-api-key": revokedSecret } })).statusCode).toBe(401);

    const legacySecret = `legacy-${randomUUID()}`;
    const legacy = await pool.query<{ scopes: string[] }>(
      "INSERT INTO tenant_api_keys(tenant_id,name,key_hash) VALUES($1,'Legacy',$2) RETURNING scopes",
      [tenantId, hashApiKey(legacySecret)]
    );
    expect(legacy.rows[0].scopes).toEqual(expect.arrayContaining([
      "scheduling.categories.read",
      "scheduling.partners.read",
      "scheduling.leads.upsert",
      "scheduling.appointments.create"
    ]));
    expect((await app.inject({ url: "/categorias", headers: { "x-api-key": legacySecret } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/parceiros", headers: { "x-api-key": legacySecret } })).statusCode).toBe(200);
  });

  it("requires the operation-specific scope on every public scheduling route", async () => {
    const categoriesOnlySecret = `categories-only-${randomUUID()}`;
    await pool.query(
      "INSERT INTO tenant_api_keys(tenant_id,name,key_hash,scopes) VALUES($1,'Categories only',$2,$3)",
      [tenantId, hashApiKey(categoriesOnlySecret), ["scheduling.categories.read"]]
    );
    const headers = { "x-api-key": categoriesOnlySecret };
    const resourceId = randomUUID();
    expect((await app.inject({ url: "/categorias", headers })).statusCode).toBe(200);
    const denied = await Promise.all([
      app.inject({ url: "/parceiros", headers }),
      app.inject({ method: "POST", url: "/leads", headers }),
      app.inject({ method: "POST", url: `/leads/${resourceId}/proposta-parceiro`, headers }),
      app.inject({ url: "/unidades/unit/horarios?data=2030-01-07", headers }),
      app.inject({ method: "POST", url: "/agendamentos", headers }),
      app.inject({ method: "PATCH", url: `/agendamentos/${resourceId}/reagendar`, headers }),
      app.inject({ method: "DELETE", url: `/agendamentos/${resourceId}`, headers }),
      app.inject({ method: "PATCH", url: `/leads/${resourceId}/status`, headers }),
      app.inject({ method: "POST", url: `/leads/${resourceId}/transferir`, headers })
    ]);
    expect(denied.map((response) => response.statusCode)).toEqual(Array(9).fill(403));
  });

  it("does not let the upsert scope change lead status or bypass transitions", async () => {
    const upsertSecret = `upsert-only-${randomUUID()}`;
    await pool.query(
      "INSERT INTO tenant_api_keys(tenant_id,name,key_hash,scopes) VALUES($1,'Upsert only',$2,$3)",
      [tenantId, hashApiKey(upsertSecret), ["scheduling.leads.upsert"]]
    );
    const headers = { "x-api-key": upsertSecret };
    const telefone = `5511${Date.now().toString().slice(-8)}`;
    const created = await app.inject({
      method: "POST",
      url: "/leads",
      headers,
      payload: {
        telefone,
        nome: "Lead protegido por scope",
        categoria_interesse_id: "api-key-category",
        unidade_id: "api-key-unit",
        origem: "integration-test"
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().lead.status).toBe("novo");
    const leadId = created.json().lead.id as string;
    expect((await app.inject({
      method: "PATCH",
      url: `/scheduling/leads/${leadId}/status`,
      headers: { cookie: ownerCookie },
      payload: { status: "em_atendimento" }
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "PATCH",
      url: `/scheduling/leads/${leadId}/status`,
      headers: { cookie: ownerCookie },
      payload: { status: "qualificado" }
    })).statusCode).toBe(200);

    const rejectedStatus = await app.inject({
      method: "POST",
      url: "/leads",
      headers,
      payload: { telefone, nome: "Tentativa de bypass", status: "cancelado" }
    });
    expect(rejectedStatus.statusCode).toBe(400);
    const updated = await app.inject({ method: "POST", url: "/leads", headers, payload: { telefone, nome: "Atualização legítima" } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().lead).toMatchObject({ id: leadId, nome: "Atualização legítima", status: "qualificado" });
  });
});
