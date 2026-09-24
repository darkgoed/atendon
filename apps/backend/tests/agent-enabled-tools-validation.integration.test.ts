import { randomUUID } from "node:crypto";
import pg from "pg";
import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { AVAILABLE_TOOL_NAMES } from "../src/modules/ai-router/tools.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const tenantIds: string[] = [];
const userIds: string[] = [];
const rootPassword = "Tools#Test123";
let rootPasswordHash = "";
// Ferramentas válidas distintas: com valores diferentes dá para provar que um
// salvo não vaza para o compartilhado, para outra conexão nem para outro tenant.
const [toolA, toolB] = AVAILABLE_TOOL_NAMES;

interface Context {
  tenantId: string;
  cookie: string;
  primaryId: string;
  secondaryId: string;
  sharedPrompt: string;
}

async function fixture(sharedPrompt: string): Promise<Context> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenantId = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id",
      [`Tools ${randomUUID()}`, `tools-${randomUUID()}`]
    )).rows[0].id;
    tenantIds.push(tenantId);
    await ensureWorkspaceDefaultRoles(client, tenantId);
    // A rota /agent é coberta pela capability workspace_admin_v1; sem habilitar,
    // o gate responde antes de qualquer lógica de validação.
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

    // Configuração compartilhada (session_id NULL) já com ferramentas válidas; o
    // trigger de bootstrap da migration 0049 publica a versão 1 ativa copiando
    // enabled_tools junto.
    const configId = (await client.query<{ id: string }>(
      `INSERT INTO agent_configs(tenant_id,name,system_prompt,ai_model,model_params,enabled_tools,is_active,updated_at)
       VALUES($1,'Agente',$2,'openai/gpt-4o-mini','{}'::jsonb,$3::jsonb,true,now())
       RETURNING id`,
      [tenantId, sharedPrompt, JSON.stringify([toolA])]
    )).rows[0].id;
    const versionId = (await client.query<{ id: string }>(
      "SELECT id FROM agent_config_versions WHERE agent_config_id=$1 AND status='active'",
      [configId]
    )).rows[0].id;
    await client.query("UPDATE agent_configs SET active_version_id=$2 WHERE id=$1", [configId, versionId]);

    const email = `tools-${randomUUID()}@test.local`;
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

    // /agent exige sessão ROOT com acesso ao workspace: fluxo real de login +
    // /root/workspaces/:id/access em vez de forjar o token.
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
    return { tenantId, cookie, primaryId, secondaryId, sharedPrompt };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function saveAgent(context: Context, payload: { sessionId?: string; systemPrompt?: string; enabledTools?: string[] }) {
  return app.inject({
    method: "PUT",
    url: "/agent",
    headers: { cookie: context.cookie },
    payload: {
      systemPrompt: "PROMPT_VALIDO",
      aiModel: "openai/gpt-4o-mini",
      temperature: 0.5,
      maxTokens: 1024,
      isActive: true,
      ...payload
    }
  });
}

function getAgent(context: Context, sessionId?: string) {
  return app.inject({
    method: "GET",
    url: sessionId ? `/agent?session_id=${sessionId}` : "/agent",
    headers: { cookie: context.cookie }
  });
}

async function versionsOf(tenantId: string, sessionId: string | null) {
  return (await pool.query<{ status: string; version_number: number; enabled_tools: string[] }>(
    `SELECT v.status,v.version_number,v.enabled_tools
     FROM agent_config_versions v JOIN agent_configs a ON a.id=v.agent_config_id
     WHERE a.tenant_id=$1 AND a.session_id IS NOT DISTINCT FROM $2::uuid
     ORDER BY v.version_number`,
    [tenantId, sessionId]
  )).rows;
}

async function configRows(tenantId: string) {
  return (await pool.query<{ session_id: string | null; enabled_tools: string[] }>(
    `SELECT session_id,enabled_tools FROM agent_configs WHERE tenant_id=$1 ORDER BY session_id NULLS FIRST`,
    [tenantId]
  )).rows;
}

beforeAll(async () => {
  rootPasswordHash = await hash(rootPassword, 4);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (tenantIds.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenantIds]);
  if (userIds.length) {
    // O login ROOT gera audit_logs que referenciam o usuário; sem apagá-los
    // primeiro o DELETE viola a FK.
    await pool.query("DELETE FROM audit_logs WHERE actor_user_id=ANY($1::uuid[])", [userIds]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]);
  }
  await pool.end();
});

describe("validação de enabledTools e isolamento por conexão", () => {
  it("salva ferramenta conhecida e publica versão ativa com as ferramentas salvas", async () => {
    const context = await fixture("PROMPT_COMPARTILHADO");
    const response = await saveAgent(context, { enabledTools: [toolB] });
    expect(response.statusCode).toBe(200);
    expect(response.json().agent.enabled_tools).toEqual([toolB]);

    const loaded = await getAgent(context);
    expect(loaded.statusCode).toBe(200);
    const body = loaded.json();
    expect(body.scope).toBe("shared");
    expect(body.agent.enabled_tools).toEqual([toolB]);
    expect(body.available_tools).toContain(toolB);

    const versions = await versionsOf(context.tenantId, null);
    expect(versions.map((row) => row.status)).toEqual(["retired", "active"]);
    expect(versions[1].enabled_tools).toEqual([toolB]);
  });

  it("rejeita ferramenta desconhecida com 400 e mantém config ativa intocada", async () => {
    // Baseline é o estado do fixture: compartilhado com [toolA] e versão 1 ativa.
    const context = await fixture("PROMPT_COMPARTILHADO");

    // sessionId incluído de propósito: a rejeição deve acontecer antes de
    // qualquer escrita, então nenhum override parcial pode nascer.
    const response = await saveAgent(context, {
      sessionId: context.secondaryId,
      enabledTools: [toolA, "ferramenta_fantasma"]
    });
    expect(response.statusCode).toBe(400);
    // Motivo da rejeição: sem isto um 400 de schema por outro motivo (campo
    // faltando, por exemplo) passaria como falso positivo.
    expect(response.json().error).toContain("ferramenta desconhecida");

    const loaded = await getAgent(context);
    expect(loaded.json().agent.enabled_tools).toEqual([toolA]);

    const versions = await versionsOf(context.tenantId, null);
    expect(versions.map((row) => row.status)).toEqual(["active"]);
    expect(versions[0].enabled_tools).toEqual([toolA]);

    expect(await configRows(context.tenantId)).toEqual([
      { session_id: null, enabled_tools: [toolA] }
    ]);
  });

  it("override da conexão A não altera compartilhado nem conexão B", async () => {
    const context = await fixture("PROMPT_COMPARTILHADO");

    const saveA = await saveAgent(context, {
      sessionId: context.primaryId,
      systemPrompt: "PROMPT_A",
      enabledTools: [toolB]
    });
    expect(saveA.statusCode).toBe(200);
    expect(saveA.json().agent.scope).toBe("connection");

    // Compartilhado intocado (seguiria sendo [toolA] se A tivesse vazado).
    const shared = await getAgent(context);
    expect(shared.json().scope).toBe("shared");
    expect(shared.json().agent.enabled_tools).toEqual([toolA]);

    // B sem override resolve o compartilhado, não o de A.
    const sessionB = await getAgent(context, context.secondaryId);
    expect(sessionB.json().scope).toBe("shared");
    expect(sessionB.json().agent.enabled_tools).toEqual([toolA]);
    expect(sessionB.json().agent.session_id).toBeNull();

    // Salvar B não altera A nem o compartilhado.
    const saveB = await saveAgent(context, {
      sessionId: context.secondaryId,
      systemPrompt: "PROMPT_B",
      enabledTools: [toolA, toolB]
    });
    expect(saveB.statusCode).toBe(200);

    const afterA = await getAgent(context, context.primaryId);
    expect(afterA.json().scope).toBe("connection");
    expect(afterA.json().agent.enabled_tools).toEqual([toolB]);
    const afterShared = await getAgent(context);
    expect(afterShared.json().agent.enabled_tools).toEqual([toolA]);

    // Versão ativa de A permanece com as ferramentas do salvo de A.
    const versionsA = await versionsOf(context.tenantId, context.primaryId);
    expect(versionsA.map((row) => row.status)).toEqual(["retired", "active"]);
    expect(versionsA[1].enabled_tools).toEqual([toolB]);

    const rows = await configRows(context.tenantId);
    expect(rows).toHaveLength(3);
    const toolsBySession = new Map(rows.map((row) => [row.session_id, row.enabled_tools]));
    expect(toolsBySession.get(null)).toEqual([toolA]);
    expect(toolsBySession.get(context.primaryId)).toEqual([toolB]);
    expect(toolsBySession.get(context.secondaryId)).toEqual([toolA, toolB]);
  });

  it("tenant B não pode referenciar sessão do tenant A", async () => {
    const mine = await fixture("PROMPT_DO_MEU_TENANT");
    const foreign = await fixture("PROMPT_DO_TENANT_ALHEIO");

    const response = await saveAgent(mine, { sessionId: foreign.secondaryId, enabledTools: [toolA] });
    expect(response.statusCode).toBe(404);
    const leaked = await pool.query(
      "SELECT id FROM agent_configs WHERE tenant_id=$1 AND session_id=$2",
      [mine.tenantId, foreign.secondaryId]
    );
    expect(leaked.rowCount).toBe(0);

    // GET também não vaza: sessão alheia resolve o compartilhado do próprio tenant.
    const probe = await getAgent(mine, foreign.primaryId);
    expect(probe.json().agent.session_id).toBeNull();
    expect(probe.json().agent.system_prompt).toBe("PROMPT_DO_MEU_TENANT");
  });
});
