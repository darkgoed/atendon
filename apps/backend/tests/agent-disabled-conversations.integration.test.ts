import { randomUUID } from "node:crypto";
import pg from "pg";
import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { MessageRepository } from "../src/modules/messages/repository.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const repository = new MessageRepository(pool, config);
const tenantIds: string[] = [];
const userIds: string[] = [];
const rootPassword = "AgentOff#Test123";
let rootPasswordHash = "";

interface Context {
  tenantId: string;
  cookie: string;
  primaryId: string;
  secondaryId: string;
}

async function fixture(): Promise<Context> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenantId = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id",
      [`AgentOff ${randomUUID()}`, `agentoff-${randomUUID()}`]
    )).rows[0].id;
    tenantIds.push(tenantId);
    await ensureWorkspaceDefaultRoles(client, tenantId);
    await client.query(
      `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
       VALUES($1,'workspace_admin_v1',true)
       ON CONFLICT(tenant_id,flag_key) DO UPDATE SET enabled=EXCLUDED.enabled`,
      [tenantId]
    );

    const primaryId = (await client.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,label,is_primary,status) VALUES($1,'Comercial',true,'connected') RETURNING id",
      [tenantId]
    )).rows[0].id;
    const secondaryId = (await client.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,label,status) VALUES($1,'Suporte','connected') RETURNING id",
      [tenantId]
    )).rows[0].id;

    // A migration 0049 tem trigger de bootstrap que cria a versão ativa a
    // partir do INSERT; reaproveitamos e apontamos active_version_id.
    const configId = (await client.query<{ id: string }>(
      `INSERT INTO agent_configs(tenant_id,name,system_prompt,ai_model,model_params,enabled_tools,is_active,updated_at)
       VALUES($1,'Agente','PROMPT','openai/gpt-4o-mini','{}'::jsonb,'[]'::jsonb,true,now())
       RETURNING id`,
      [tenantId]
    )).rows[0].id;
    const versionId = (await client.query<{ id: string }>(
      "SELECT id FROM agent_config_versions WHERE agent_config_id=$1 AND status='active'",
      [configId]
    )).rows[0].id;
    await client.query("UPDATE agent_configs SET active_version_id=$2 WHERE id=$1", [configId, versionId]);

    const email = `agentoff-${randomUUID()}@test.local`;
    const userId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,status,is_root) VALUES($1,$2,'active',true) RETURNING id",
      [email, rootPasswordHash]
    )).rows[0].id;
    userIds.push(userId);
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'`,
      [tenantId, userId]
    );
    await client.query("COMMIT");

    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: rootPassword } });
    const loginSetCookie = login.headers["set-cookie"]!;
    const loginCookie = (Array.isArray(loginSetCookie) ? loginSetCookie[0] : loginSetCookie).split(";")[0];
    const access = await app.inject({
      method: "POST",
      url: `/root/workspaces/${tenantId}/access`,
      headers: { cookie: loginCookie }
    });
    const accessSetCookie = access.headers["set-cookie"]!;
    const cookie = (Array.isArray(accessSetCookie) ? accessSetCookie[0] : accessSetCookie).split(";")[0];
    return { tenantId, cookie, primaryId, secondaryId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

let phoneSeq = 0;
function nextPhone(): string {
  phoneSeq += 1;
  return `5511${String(90_000_000 + phoneSeq).padStart(8, "0")}`;
}

async function inbound(context: Context, sessionId: string, phone = nextPhone()) {
  const loaded = await repository.recordInboundAndLoadContext({
    tenantId: context.tenantId,
    sessionId,
    contactPhone: phone,
    text: "oi",
    externalId: randomUUID()
  } as never);
  return { loaded: loaded as { aiActive?: boolean; aiActiveColumn?: boolean } | null, phone };
}

async function conversationState(context: Context, phone: string) {
  const row = (await pool.query<{ ai_active: boolean; handoff_reason: string | null }>(
    "SELECT ai_active,handoff_reason FROM conversations WHERE tenant_id=$1 AND contact_phone=$2",
    [context.tenantId, phone]
  )).rows[0];
  return row ?? { ai_active: null, handoff_reason: undefined };
}

async function disableAgent(context: Context, sessionId?: string) {
  const response = await app.inject({
    method: "PATCH",
    url: "/agent/status",
    headers: { cookie: context.cookie },
    payload: { isActive: false, sessionId: sessionId ?? null }
  });
  expect(response.statusCode).toBe(200);
}

beforeAll(async () => {
  rootPasswordHash = await hash(rootPassword, 4);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (tenantIds.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenantIds]);
  if (userIds.length) {
    await pool.query("DELETE FROM audit_logs WHERE actor_user_id=ANY($1::uuid[])", [userIds]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]);
  }
  await pool.end();
});

describe("agente desativado não recebe contatos nem conversas", () => {
  it("nasce com IA quando o agente está ativo", async () => {
    const context = await fixture();
    const { phone } = await inbound(context, context.primaryId);
    const state = await conversationState(context, phone);
    expect(state.ai_active).toBe(true);
    expect(state.handoff_reason).toBeNull();
  });

  it("contato novo nasce fora do bucket da IA quando o agente foi desativado", async () => {
    const context = await fixture();
    await disableAgent(context);
    const { loaded, phone } = await inbound(context, context.primaryId);
    expect(loaded?.aiActive).toBe(false);
    const state = await conversationState(context, phone);
    expect(state.ai_active).toBe(false);
    expect(state.handoff_reason).toBe("agent_disabled");
  });

  it("PATCH /agent/status converte conversas abertas existentes e preserva pausas manuais", async () => {
    const context = await fixture();
    const active = await inbound(context, context.primaryId);
    expect(active.loaded?.aiActiveColumn).toBe(true);
    const pausedPhone = nextPhone();
    await inbound(context, context.primaryId, pausedPhone);
    await pool.query(
      `UPDATE conversations SET ai_active=false,handoff_reason='manually_paused'
       WHERE tenant_id=$1 AND contact_phone=$2`,
      [context.tenantId, pausedPhone]
    );

    await disableAgent(context);

    expect((await conversationState(context, active.phone)).ai_active).toBe(false);
    expect((await conversationState(context, active.phone)).handoff_reason).toBe("agent_disabled");
    expect((await conversationState(context, pausedPhone)).handoff_reason).toBe("manually_paused");
  });

  it("config ativa da conexão mantém a IA naquela conexão ao desativar a compartilhada", async () => {
    const context = await fixture();
    const overridePhone = nextPhone();
    await inbound(context, context.secondaryId, overridePhone);

    const client = await pool.connect();
    try {
      const overrideId = (await client.query<{ id: string }>(
        `INSERT INTO agent_configs(tenant_id,session_id,name,system_prompt,ai_model,model_params,enabled_tools,is_active,updated_at)
         VALUES($1,$2,'Exclusivo','PROMPT_EXCLUSIVO','openai/gpt-4o-mini','{}'::jsonb,'[]'::jsonb,true,now())
         RETURNING id`,
        [context.tenantId, context.secondaryId]
      )).rows[0].id;
      const overrideVersion = (await client.query<{ id: string }>(
        "SELECT id FROM agent_config_versions WHERE agent_config_id=$1 AND status='active'",
        [overrideId]
      )).rows[0].id;
      await client.query("UPDATE agent_configs SET active_version_id=$2 WHERE id=$1", [overrideId, overrideVersion]);
    } finally {
      client.release();
    }

    await disableAgent(context);

    expect((await conversationState(context, overridePhone)).ai_active).toBe(true);
    const born = await inbound(context, context.secondaryId);
    expect((await conversationState(context, born.phone)).ai_active).toBe(true);
    const shared = await inbound(context, context.primaryId);
    expect((await conversationState(context, shared.phone)).ai_active).toBe(false);
  });
});
