import { randomUUID } from "node:crypto";
import pg from "pg";
import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { MessageRepository } from "../src/modules/messages/repository.js";
import { qualifyLeadFromConversation } from "../src/modules/scheduling/contextual-qualification.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const repository = new MessageRepository(pool, config);
const tenantIds: string[] = [];
const userIds: string[] = [];
const rootPassword = "Prompt#Test123";
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
      [`Prompt ${randomUUID()}`, `prompt-${randomUUID()}`]
    )).rows[0].id;
    tenantIds.push(tenantId);
    await ensureWorkspaceDefaultRoles(client, tenantId);
    // A rota /agent é coberta pela capability workspace_admin_v1; sem habilitar,
    // o gate responde 409 antes de qualquer lógica de prompt.
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

    // Configuração compartilhada (session_id NULL) com a versão ativa que o
    // runtime realmente lê.
    const configId = (await client.query<{ id: string }>(
      `INSERT INTO agent_configs(tenant_id,name,system_prompt,ai_model,model_params,enabled_tools,is_active,updated_at)
       VALUES($1,'Agente','PROMPT_COMPARTILHADO','openai/gpt-4o-mini','{}'::jsonb,'[]'::jsonb,true,now())
       RETURNING id`,
      [tenantId]
    )).rows[0].id;
    // A migration 0049 tem trigger de bootstrap que já cria a versão 1 ativa a
    // partir do INSERT acima — reaproveitamos essa versão em vez de inserir uma.
    const versionId = (await client.query<{ id: string }>(
      "SELECT id FROM agent_config_versions WHERE agent_config_id=$1 AND status='active'",
      [configId]
    )).rows[0].id;
    await client.query(
      "UPDATE agent_config_versions SET system_prompt='PROMPT_COMPARTILHADO' WHERE id=$1",
      [versionId]
    );
    await client.query("UPDATE agent_configs SET active_version_id=$2 WHERE id=$1", [configId, versionId]);

    const email = `prompt-${randomUUID()}@test.local`;
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

    // /agent exige sessão ROOT com acesso ao workspace: reproduzimos o fluxo
    // real de login + /root/workspaces/:id/access em vez de forjar o token.
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

async function promptUsedBy(context: Context, sessionId: string): Promise<string | undefined> {
  const loaded = await repository.recordInboundAndLoadContext({
    tenantId: context.tenantId,
    sessionId,
    contactPhone: `5511${Math.floor(900000000 + Math.random() * 99999999)}`,
    text: "oi",
    externalId: randomUUID()
  } as never);
  return (loaded as { systemPrompt?: string } | null)?.systemPrompt;
}

beforeAll(async () => {
  rootPasswordHash = await hash(rootPassword, 4);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (tenantIds.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenantIds]);
  if (userIds.length) {
    // O login ROOT e o PATCH de status geram audit_logs que referenciam o
    // usuário; sem apagá-los primeiro o DELETE viola a FK.
    await pool.query("DELETE FROM audit_logs WHERE actor_user_id=ANY($1::uuid[])", [userIds]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]);
  }
  await pool.end();
});

describe("prompt de IA por conexão", () => {
  it("usa o prompt compartilhado nas duas conexões enquanto não há override", async () => {
    const context = await fixture();
    expect(await promptUsedBy(context, context.primaryId)).toBe("PROMPT_COMPARTILHADO");
    expect(await promptUsedBy(context, context.secondaryId)).toBe("PROMPT_COMPARTILHADO");
  });

  it("aplica o prompt exclusivo só na conexão escolhida", async () => {
    const context = await fixture();
    const response = await app.inject({
      method: "PUT",
      url: "/agent",
      headers: { cookie: context.cookie },
      payload: {
        systemPrompt: "PROMPT_DO_SUPORTE",
        aiModel: "openai/gpt-4o-mini",
        temperature: 0.5,
        maxTokens: 1024,
        isActive: true,
        enabledTools: ["registrar_lead"],
        sessionId: context.secondaryId
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().agent.scope).toBe("connection");

    expect(await promptUsedBy(context, context.secondaryId)).toBe("PROMPT_DO_SUPORTE");
    expect(await promptUsedBy(context, context.primaryId)).toBe("PROMPT_COMPARTILHADO");
  });

  it("publica versão ativa ao salvar, de modo que a IA passe a usar o texto novo", async () => {
    // Regressão do bloqueador: PUT /agent atualizava só a coluna legada
    // agent_configs.system_prompt, enquanto o runtime lê a versão ativa em
    // agent_config_versions — editar o prompt no painel não mudava a resposta.
    const context = await fixture();
    const response = await app.inject({
      method: "PUT",
      url: "/agent",
      headers: { cookie: context.cookie },
      payload: {
        systemPrompt: "PROMPT_NOVO_COMPARTILHADO",
        aiModel: "openai/gpt-4o-mini",
        temperature: 0.5,
        maxTokens: 1024,
        isActive: true,
        enabledTools: ["registrar_lead"]
      }
    });
    expect(response.statusCode).toBe(200);

    const versions = await pool.query<{ status: string; version_number: number; system_prompt: string }>(
      `SELECT v.status,v.version_number,v.system_prompt
       FROM agent_config_versions v JOIN agent_configs a ON a.id=v.agent_config_id
       WHERE a.tenant_id=$1 AND a.session_id IS NULL ORDER BY v.version_number`,
      [context.tenantId]
    );
    expect(versions.rows.map((row) => row.status)).toEqual(["retired", "active"]);
    expect(versions.rows[1].system_prompt).toBe("PROMPT_NOVO_COMPARTILHADO");
    expect(await promptUsedBy(context, context.primaryId)).toBe("PROMPT_NOVO_COMPARTILHADO");
  });

  it("remove o override e devolve a conexão ao prompt compartilhado", async () => {
    const context = await fixture();
    await app.inject({
      method: "PUT",
      url: "/agent",
      headers: { cookie: context.cookie },
      payload: {
        systemPrompt: "PROMPT_TEMPORARIO",
        aiModel: "openai/gpt-4o-mini",
        temperature: 0.5,
        maxTokens: 1024,
        isActive: true,
        enabledTools: ["registrar_lead"],
        sessionId: context.secondaryId
      }
    });
    expect(await promptUsedBy(context, context.secondaryId)).toBe("PROMPT_TEMPORARIO");

    const removed = await app.inject({
      method: "DELETE",
      url: `/agent/override/${context.secondaryId}`,
      headers: { cookie: context.cookie }
    });
    expect(removed.statusCode).toBe(200);
    expect(await promptUsedBy(context, context.secondaryId)).toBe("PROMPT_COMPARTILHADO");
  });

  it("mantém o prompt da conexão mesmo quando o compartilhado é salvo depois", async () => {
    // Sem `ORDER BY (session_id IS NOT NULL) DESC` a resolução cai no
    // updated_at: salvar o prompt compartilhado depois do override faria a
    // conexão voltar silenciosamente ao prompt comum.
    const context = await fixture();
    await app.inject({
      method: "PUT",
      url: "/agent",
      headers: { cookie: context.cookie },
      payload: {
        systemPrompt: "PROMPT_DO_SUPORTE",
        aiModel: "openai/gpt-4o-mini",
        temperature: 0.5,
        maxTokens: 1024,
        isActive: true,
        enabledTools: ["registrar_lead"],
        sessionId: context.secondaryId
      }
    });
    // Compartilhado atualizado DEPOIS do override, ficando mais recente.
    await app.inject({
      method: "PUT",
      url: "/agent",
      headers: { cookie: context.cookie },
      payload: {
        systemPrompt: "PROMPT_COMPARTILHADO_NOVO",
        aiModel: "openai/gpt-4o-mini",
        temperature: 0.5,
        maxTokens: 1024,
        isActive: true,
        enabledTools: ["registrar_lead"]
      }
    });

    expect(await promptUsedBy(context, context.secondaryId)).toBe("PROMPT_DO_SUPORTE");
    expect(await promptUsedBy(context, context.primaryId)).toBe("PROMPT_COMPARTILHADO_NOVO");
  });

  it("na qualificação usa o override da sessão B mais recente e mantém fallback compartilhado sem herdar A", async () => {
    const context = await fixture();
    const save = async (sessionId: string | undefined, systemPrompt: string, aiModel: string) => {
      const response = await app.inject({
        method: "PUT", url: "/agent", headers: { cookie: context.cookie },
        payload: { systemPrompt, aiModel, temperature: 0.5, maxTokens: 1024, isActive: true, enabledTools: ["registrar_lead"], sessionId }
      });
      expect(response.statusCode).toBe(200);
    };
    await save(context.primaryId, "PROMPT_A", "model/A");
    await save(context.secondaryId, "PROMPT_B", "model/B");

    const phone = `5511${Math.floor(900000000 + Math.random() * 99999999)}`;
    const inbound = await repository.recordInboundAndLoadContext({
      tenantId: context.tenantId, sessionId: context.secondaryId, contactPhone: phone,
      text: "Quero avaliar a empresa", externalId: randomUUID()
    } as never, { claim: false });
    const lead = await pool.query<{ id: string }>("SELECT id FROM scheduling_leads WHERE tenant_id=$1 AND phone=$2", [context.tenantId, phone]);
    const complete = vi.fn(async (input: { model: string }) => {
      expect(input.model).toBe("model/B");
      return { text: JSON.stringify({ estrelas: 3, respostas: {}, resumo: "Avaliação", justificativa: "Contexto" }), inputTokens: 1, outputTokens: 1, costUsd: 0 };
    });

    await expect(qualifyLeadFromConversation(context.tenantId, lead.rows[0].id, { complete } as never)).resolves.toMatchObject({ conversa_id: inbound!.conversationId });
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it("recusa override para conexão de outro tenant", async () => {
    const mine = await fixture();
    const foreign = await fixture();
    const response = await app.inject({
      method: "PUT",
      url: "/agent",
      headers: { cookie: mine.cookie },
      payload: {
        systemPrompt: "INVASOR",
        aiModel: "openai/gpt-4o-mini",
        temperature: 0.5,
        maxTokens: 1024,
        isActive: true,
        enabledTools: ["registrar_lead"],
        sessionId: foreign.secondaryId
      }
    });
    expect(response.statusCode).toBe(404);
    const leaked = await pool.query(
      "SELECT id FROM agent_configs WHERE tenant_id=$1 AND session_id=$2",
      [mine.tenantId, foreign.secondaryId]
    );
    expect(leaked.rowCount).toBe(0);
  });
});
