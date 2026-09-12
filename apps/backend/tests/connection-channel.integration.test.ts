import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { WhatsAppSessionManager } from "../src/modules/whatsapp/session-manager.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const tenants: string[] = [];
const users: string[] = [];
let start: { mockRestore(): void; mockClear(): void; mock: { calls: unknown[][] } };
let reconnect: { mockRestore(): void; mockClear(): void; mock: { calls: unknown[][] } };
let logoutInstance: { mockRestore(): void; mockClear(): void; mock: { calls: unknown[][] } };
let deleteInstance: { mockRestore(): void; mockClear(): void; mock: { calls: unknown[][] } };
let refreshAvatar: { mockRestore(): void };
let phoneSequence = 0;

function testPhone(): string {
  phoneSequence += 1;
  return `5511999${String(phoneSequence).padStart(6, "0")}`;
}

async function fixture() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenantId = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id",
      [`Channel ${randomUUID()}`, `channel-${randomUUID()}`]
    )).rows[0].id;
    tenants.push(tenantId);
    await ensureWorkspaceDefaultRoles(client, tenantId);
    const planId = (await client.query<{ id: string }>("SELECT id FROM plans WHERE code='MEDIUM'")).rows[0].id;
    await client.query(
      "INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) VALUES($1,$2,'ACTIVE',now(),now()+interval '1 month')",
      [tenantId, planId]
    );
    await client.query(
      "INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled) VALUES($1,'workspace_admin_v1',true) ON CONFLICT (tenant_id,flag_key) DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=now()",
      [tenantId]
    );
    const userId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status,session_version) VALUES($1,'active',1) RETURNING id",
      [`channel-${randomUUID()}@test.local`]
    )).rows[0].id;
    users.push(userId);
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'`,
      [tenantId, userId]
    );
    const sessionId = (await client.query<{ id: string }>(
      `INSERT INTO whatsapp_sessions(tenant_id,label,is_primary,status,channel)
       VALUES($1,'Principal',true,'connected','whatsapp') RETURNING id`, [tenantId]
    )).rows[0].id;
    const instagramSessionId = (await client.query<{ id: string }>(
      `INSERT INTO whatsapp_sessions(tenant_id,label,is_primary,status,channel)
       VALUES($1,'Instagram schema-ready',false,'connected','instagram') RETURNING id`, [tenantId]
    )).rows[0].id;
    const token = await createSessionToken({
      userId, tenantId, email: `channel-${userId}@test.local`, role: "OWNER", sessionVersion: 1
    });
    await client.query("COMMIT");
    return { tenantId, userId, sessionId, instagramSessionId, cookie: `atendon_session=${token}` };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function principal(tenantId: string, permissions: string[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const userId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status,session_version) VALUES($1,'active',1) RETURNING id",
      [`channel-principal-${randomUUID()}@test.local`]
    )).rows[0].id;
    users.push(userId);
    const roleId = (await client.query<{ id: string }>(
      "INSERT INTO workspace_roles(workspace_id,name,description,is_owner_role,is_system) VALUES($1,$2,'test principal',false,false) RETURNING id",
      [tenantId, `CHANNEL_TEST_${randomUUID()}`]
    )).rows[0].id;
    await client.query(
      "INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())",
      [tenantId, userId, roleId]
    );
    await client.query(
      "INSERT INTO workspace_role_permissions(role_id,permission_key) SELECT $1,key FROM permissions WHERE key=ANY($2::text[])",
      [roleId, permissions]
    );
    const token = await createSessionToken({
      userId, tenantId, email: `channel-principal-${userId}@test.local`, role: "CHANNEL_TEST", sessionVersion: 1
    });
    await client.query("COMMIT");
    return `atendon_session=${token}`;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  start = vi.spyOn(WhatsAppSessionManager.prototype, "start").mockResolvedValue();
  reconnect = vi.spyOn(WhatsAppSessionManager.prototype, "reconnect").mockResolvedValue();
  logoutInstance = vi.spyOn(WhatsAppSessionManager.prototype, "logoutInstance").mockResolvedValue();
  deleteInstance = vi.spyOn(WhatsAppSessionManager.prototype, "deleteInstance").mockResolvedValue();
  refreshAvatar = vi.spyOn(WhatsAppSessionManager.prototype, "refreshContactAvatar").mockResolvedValue();
  await app.ready();
});

afterAll(async () => {
  start.mockRestore();
  reconnect.mockRestore();
  logoutInstance.mockRestore();
  deleteInstance.mockRestore();
  refreshAvatar.mockRestore();
  if (tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenants]);
  if (users.length) await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [users]);
  await app.close();
  await pool.end();
});

describe("canal das conexões e conversas", () => {
  it("exige sessão para ler conexões", async () => {
    const response = await app.inject({ url: "/connections" });
    expect(response.statusCode).toBe(401);
  });

  it("permite leitura com connection.read, mas nega POST Instagram sem connection.manage e sem efeitos", async () => {
    const context = await fixture();
    const cookie = await principal(context.tenantId, ["connection.read"]);
    const before = await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM whatsapp_sessions WHERE tenant_id=$1 AND archived_at IS NULL", [context.tenantId]
    );
    const listed = await app.inject({ url: "/connections", headers: { cookie } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().connections.map((row: { id: string }) => row.id)).toEqual(
      expect.arrayContaining([context.sessionId, context.instagramSessionId])
    );

    start.mockClear();
    const denied = await app.inject({
      method: "POST", url: "/connections", headers: { cookie },
      payload: { label: "Instagram válido", channel: "instagram" }
    });
    expect(denied.statusCode).toBe(403);
    expect(start).not.toHaveBeenCalled();
    const after = await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM whatsapp_sessions WHERE tenant_id=$1 AND archived_at IS NULL", [context.tenantId]
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
    const reread = await app.inject({ url: "/connections", headers: { cookie } });
    expect(reread.statusCode).toBe(200);
    expect(reread.json().limits.used).toBe(1);
  }, 15_000);

  it("nega leitura a principal sem connection.read", async () => {
    const context = await fixture();
    const cookie = await principal(context.tenantId, ["connection.manage"]);
    const response = await app.inject({ url: "/connections", headers: { cookie } });
    expect(response.statusCode).toBe(403);
  });

  it("expõe whatsapp para conexão legada no GET /connections", async () => {
    const context = await fixture();
    await pool.query("UPDATE whatsapp_sessions SET channel='whatsapp' WHERE id=$1", [context.sessionId]);
    const response = await app.inject({ url: "/connections", headers: { cookie: context.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      connections: [
        { id: context.sessionId, label: "Principal", channel: "whatsapp" },
        { id: context.instagramSessionId, channel: "instagram" }
      ]
    });
  });

  it("mantém endpoints legados de conexão restritos ao canal WhatsApp", async () => {
    const context = await fixture();
    const connection = await app.inject({ url: "/connection", headers: { cookie: context.cookie } });
    expect(connection.statusCode).toBe(200);
    expect(connection.json().connection.id).toBe(context.sessionId);
    await pool.query("UPDATE whatsapp_sessions SET is_primary=false WHERE id=$1", [context.sessionId]);
    await pool.query("UPDATE whatsapp_sessions SET is_primary=true WHERE id=$1", [context.instagramSessionId]);
    const instagramPrimary = await app.inject({ url: "/connection", headers: { cookie: context.cookie } });
    expect(instagramPrimary.json().connection.id).toBe(context.sessionId);
    const reconnect = await app.inject({ method: "POST", url: "/connection/reconnect", headers: { cookie: context.cookie } });
    expect(reconnect.statusCode).toBe(202);
    start.mockClear();
  });

  it("herda whatsapp e instagram pela sessão, com escopo do tenant", async () => {
    const own = await fixture();
    const foreign = await fixture();
    const ownPhone = testPhone();
    const foreignPhone = testPhone();
    await pool.query(
      `INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name)
       VALUES($1,$2,$3,'WhatsApp'),($1,$4,$5,'Instagram')`,
      [own.tenantId, own.sessionId, ownPhone, own.instagramSessionId, `${ownPhone}2`]
    );
    await pool.query(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name) VALUES($1,$2,$3,'Foreign')",
      [foreign.tenantId, foreign.sessionId, foreignPhone]
    );
    const response = await app.inject({ url: "/conversations", headers: { cookie: own.cookie } });
    expect(response.statusCode).toBe(200);
    const rows = response.json().conversations as Array<{ contact_name: string; channel: string; tenant_id?: string }>;
    expect(rows.filter((row) => row.contact_name === "WhatsApp")[0]?.channel).toBe("whatsapp");
    expect(rows.filter((row) => row.contact_name === "Instagram")[0]?.channel).toBe("instagram");
    expect(rows.some((row) => row.contact_name === "Foreign")).toBe(false);
  });

  it("recusa Instagram com 501, sem linha, limite alterado ou chamada Evolution, inclusive repetido", async () => {
    const context = await fixture();
    const before = await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM whatsapp_sessions WHERE tenant_id=$1 AND archived_at IS NULL", [context.tenantId]
    );
    const first = await app.inject({
      method: "POST", url: "/connections", headers: { cookie: context.cookie },
      payload: { label: "Meta", channel: "instagram" }
    });
    const second = await app.inject({
      method: "POST", url: "/connections", headers: { cookie: context.cookie },
      payload: { label: "Meta", channel: "instagram" }
    });
    expect(first.statusCode).toBe(501);
    expect(first.json()).toEqual({ code: "CHANNEL_NOT_AVAILABLE", message: "Canal Instagram ainda não disponível para conexão" });
    expect(second.statusCode).toBe(501);
    expect(second.json()).toEqual(first.json());
    expect(start).not.toHaveBeenCalled();
    const after = await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM whatsapp_sessions WHERE tenant_id=$1 AND archived_at IS NULL", [context.tenantId]
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
    const listed = await app.inject({ url: "/connections", headers: { cookie: context.cookie } });
    expect(listed.json().limits.used).toBe(1);
  });

  it("não reconecta sessão Instagram nem chama Evolution", async () => {
    const context = await fixture();
    reconnect.mockClear();
    const before = await pool.query(
      "SELECT channel,status,is_primary,archived_at FROM whatsapp_sessions WHERE id=$1",
      [context.instagramSessionId]
    );
    const response = await app.inject({
      method: "POST", url: `/connections/${context.instagramSessionId}/reconnect`, headers: { cookie: context.cookie }
    });
    expect(response.statusCode).toBe(404);
    expect(reconnect).not.toHaveBeenCalled();
    const after = await pool.query(
      "SELECT channel,status,is_primary,archived_at FROM whatsapp_sessions WHERE id=$1",
      [context.instagramSessionId]
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("não promove sessão Instagram nem despromove WhatsApp", async () => {
    const context = await fixture();
    reconnect.mockClear();
    logoutInstance.mockClear();
    deleteInstance.mockClear();
    const before = await pool.query(
      "SELECT id,channel,is_primary,label,status,archived_at FROM whatsapp_sessions WHERE tenant_id=$1 ORDER BY id",
      [context.tenantId]
    );
    const response = await app.inject({
      method: "PATCH", url: `/connections/${context.instagramSessionId}`,
      headers: { cookie: context.cookie }, payload: { is_primary: true }
    });
    expect(response.statusCode).toBe(404);
    expect(reconnect).not.toHaveBeenCalled();
    expect(logoutInstance).not.toHaveBeenCalled();
    expect(deleteInstance).not.toHaveBeenCalled();
    const after = await pool.query(
      "SELECT id,channel,is_primary,label,status,archived_at FROM whatsapp_sessions WHERE tenant_id=$1 ORDER BY id",
      [context.tenantId]
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("não exclui sessão Instagram nem chama Evolution", async () => {
    const context = await fixture();
    logoutInstance.mockClear();
    deleteInstance.mockClear();
    const before = await pool.query(
      "SELECT channel,status,is_primary,archived_at FROM whatsapp_sessions WHERE id=$1",
      [context.instagramSessionId]
    );
    const response = await app.inject({
      method: "DELETE", url: `/connections/${context.instagramSessionId}`, headers: { cookie: context.cookie }
    });
    expect(response.statusCode).toBe(404);
    expect(logoutInstance).not.toHaveBeenCalled();
    expect(deleteInstance).not.toHaveBeenCalled();
    const after = await pool.query(
      "SELECT channel,status,is_primary,archived_at FROM whatsapp_sessions WHERE id=$1",
      [context.instagramSessionId]
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("não conta Instagram para manter uma conexão WhatsApp ativa", async () => {
    const context = await fixture();
    logoutInstance.mockClear();
    deleteInstance.mockClear();
    const response = await app.inject({
      method: "DELETE", url: `/connections/${context.sessionId}`, headers: { cookie: context.cookie }
    });
    expect(response.statusCode).toBe(409);
    expect(logoutInstance).not.toHaveBeenCalled();
    expect(deleteInstance).not.toHaveBeenCalled();
    const remaining = await pool.query(
      "SELECT channel,status,is_primary,archived_at FROM whatsapp_sessions WHERE id=$1",
      [context.instagramSessionId]
    );
    expect(remaining.rows[0]).toMatchObject({ channel: "instagram", status: "connected", archived_at: null });
  });

  it("cria a primeira WhatsApp como primária quando só há Instagram ativa", async () => {
    const context = await fixture();
    await pool.query("UPDATE whatsapp_sessions SET is_primary=false,archived_at=now() WHERE id=$1", [context.sessionId]);
    await pool.query("UPDATE whatsapp_sessions SET is_primary=true WHERE id=$1", [context.instagramSessionId]);

    const response = await app.inject({
      method: "POST", url: "/connections", headers: { cookie: context.cookie },
      payload: { label: "Primeira WhatsApp" }
    });
    expect(response.statusCode).toBe(201);
    const created = await pool.query<{ is_primary: boolean; channel: string }>(
      "SELECT is_primary,channel FROM whatsapp_sessions WHERE tenant_id=$1 AND label='Primeira WhatsApp'",
      [context.tenantId]
    );
    expect(created.rows[0]).toEqual({ is_primary: true, channel: "whatsapp" });
  });

  it("bloqueia criação no limite pelo número real de WhatsApps, ignorando Instagram", async () => {
    const context = await fixture();
    await pool.query(
      "INSERT INTO tenant_entitlement_overrides(tenant_id,kind,entitlement_key,int_value) VALUES($1,'limit','MAX_WHATSAPP_CONNECTIONS',1)",
      [context.tenantId]
    );
    const response = await app.inject({
      method: "POST", url: "/connections", headers: { cookie: context.cookie },
      payload: { label: "Excede WhatsApp" }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("PLAN_LIMIT_REACHED");
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM whatsapp_sessions WHERE tenant_id=$1 AND channel='whatsapp' AND archived_at IS NULL",
      [context.tenantId]
    )).rows[0].count).toBe(1);
  });

  it("responde 400 para payload inválido antes de criar conexão", async () => {
    const context = await fixture();
    const response = await app.inject({
      method: "POST", url: "/connections", headers: { cookie: context.cookie },
      payload: { label: "", channel: "telegram" }
    });
    expect(response.statusCode).toBe(400);
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM whatsapp_sessions WHERE tenant_id=$1", [context.tenantId]
    )).rows[0].count).toBe(2);
  });

  it("não permite ler conexões nem conversas de outro tenant", async () => {
    const own = await fixture();
    const foreign = await fixture();
    const hiddenConnection = await app.inject({ url: "/connections", headers: { cookie: own.cookie } });
    expect(hiddenConnection.json().connections.map((row: { id: string }) => row.id)).not.toContain(foreign.sessionId);
    const hiddenConversation = await pool.query<{ id: string }>(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name) VALUES($1,$2,$3,'Somente B') RETURNING id",
      [foreign.tenantId, foreign.sessionId, testPhone()]
    );
    const conversations = await app.inject({ url: "/conversations", headers: { cookie: own.cookie } });
    expect(conversations.json().conversations.map((row: { id: string }) => row.id)).not.toContain(hiddenConversation.rows[0].id);
  });
});
