import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import pg from "pg";
import { hash } from "bcryptjs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createSessionToken } from "../src/auth/session.js";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { config } from "../src/config.js";
import { consumeAiInteraction } from "../src/billing/ai-consumption.js";
import { NonRetryableAiError, type AiRouter } from "../src/modules/ai-router/openrouter.js";
import { encryptSecret } from "../src/modules/ai-router/secret-box.js";
import { registerCopilotSuggestionRoutes } from "../src/modules/messages/copilot-suggestion.js";

type CompleteInput = Parameters<AiRouter["complete"]>[0];

class FakeAiRouter implements AiRouter {
  calls: CompleteInput[] = [];
  responses: string[] = [];
  failing?: Error;

  async complete(input: CompleteInput) {
    this.calls.push(input);
    if (this.failing) throw this.failing;
    const text = this.responses[this.calls.length - 1] ?? "Sugestão gerada";
    await input.onUsage?.({
      // provider_request_id tem índice único GLOBAL em usage_logs: ids repetidos
      // entre instâncias/testes colidem em silêncio (DO NOTHING) e a reconciliação
      // não encontra o uso — id precisa ser único por chamada.
      providerRequestId: `copilot-fake-${randomUUID()}`,
      model: input.model,
      inputTokens: 11,
      outputTokens: 7,
      costUsd: 0.0001,
      callReason: "copilot_suggestion:initial"
    });
    const correction = input.validateFinalText?.(text);
    if (correction) return { text: "Alternativa revisada", inputTokens: 5, outputTokens: 4, costUsd: 0 };
    return { text, inputTokens: 11, outputTokens: 7, costUsd: 0.0001 };
  }
}

class DeferredAiRouter implements AiRouter {
  calls: CompleteInput[] = [];
  release?: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.release = resolve; });

  async complete(input: CompleteInput) {
    this.calls.push(input);
    await this.gate;
    return { text: "Sugestão gerada", inputTokens: 11, outputTokens: 7, costUsd: 0.0001 };
  }
}

const apps: ReturnType<typeof Fastify>[] = [];
const planIds: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function appWith(options: { ai?: AiRouter; historyMaxCharacters?: number } = {}) {
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => {
    const typed = error as Error & { statusCode?: number; code?: string };
    const status = typeof typed.statusCode === "number" ? typed.statusCode : error instanceof z.ZodError ? 400 : 500;
    return reply.status(status).send({
      error: status === 500 ? "Erro interno" : typed.message,
      ...(status < 500 && typed.code ? { code: typed.code } : {})
    });
  });
  registerCopilotSuggestionRoutes(app, options);
  await app.ready();
  return app;
}

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const tenantIds: string[] = [];
const userIds: string[] = [];
let passwordHash = "";

interface TenantFixture {
  tenantId: string;
  email: string;
  cookie: string;
  conversationId: string;
}

async function cookieFor(input: { userId: string; tenantId: string; email: string; isRoot: boolean }) {
  const token = await createSessionToken({ userId: input.userId, tenantId: input.tenantId, email: input.email, isRoot: input.isRoot });
  return `atendon_session=${token}`;
}

async function createWorkspace(withAgent: boolean, withKey = false, billing?: { limit: number | null }): Promise<TenantFixture> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenantId = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id",
      [`Copilot ${randomUUID()}`, `copilot-${randomUUID()}`]
    )).rows[0].id;
    tenantIds.push(tenantId);
    await ensureWorkspaceDefaultRoles(client, tenantId);

    const sessionId = (await client.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,label,status) VALUES($1,'Comercial','connected') RETURNING id",
      [tenantId]
    )).rows[0].id;

    if (withAgent) {
      const configId = (await client.query<{ id: string }>(
        `INSERT INTO agent_configs(tenant_id,name,system_prompt,ai_model,model_params,enabled_tools,is_active,updated_at)
         VALUES($1,'Agente','PROMPT AGENTE','openai/gpt-4o-mini','{"temperature":0.4}'::jsonb,'[]'::jsonb,true,now())
         RETURNING id`,
        [tenantId]
      )).rows[0].id;
      const versionId = (await client.query<{ id: string }>(
        "SELECT id FROM agent_config_versions WHERE agent_config_id=$1 AND status='active'",
        [configId]
      )).rows[0].id;
      await client.query("UPDATE agent_configs SET active_version_id=$2 WHERE id=$1", [configId, versionId]);
    }

    if (withKey) {
      await client.query(
        `INSERT INTO tenant_ai_settings(tenant_id,openrouter_api_key_encrypted,media_fallback_audio,media_fallback_image,media_fallback_document)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(tenant_id) DO UPDATE SET
           openrouter_api_key_encrypted=EXCLUDED.openrouter_api_key_encrypted`,
        [tenantId, encryptSecret("«redacted:sk-…»", config.DATA_ENCRYPTION_KEY),
          "Recebi seu áudio, mas ainda não consigo ouvi-lo. Pode escrever em texto?",
          "Recebi sua imagem, mas ainda não consigo analisá-la. Pode descrever em texto?",
          "Recebi seu documento, mas ainda não consigo analisá-lo. Pode descrever o que precisa?"]
      );
    }

    if (billing) {
      const planId = (await client.query<{ id: string }>(
        "INSERT INTO plans(code,name,billing_period_months,monthly_price_cents) VALUES($1,$2,1,0) RETURNING id",
        [`COPILOT_BILLING_${randomUUID()}`, `Copilot Billing ${randomUUID()}`]
      )).rows[0].id;
      planIds.push(planId);
      await client.query(
        "INSERT INTO plan_limits(plan_id,limit_key,limit_value) VALUES($1,'MAX_AI_INTERACTIONS',$2)",
        [planId, billing.limit]
      );
      await client.query(
        "INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) VALUES($1,$2,'ACTIVE',now(),now()+interval '1 month')",
        [tenantId, planId]
      );
    }

    const email = `copilot-${randomUUID()}@test.local`;
    const userId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,status,is_root) VALUES($1,$2,'active',true) RETURNING id",
      [email, passwordHash]
    )).rows[0].id;
    userIds.push(userId);
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'`,
      [tenantId, userId]
    );

    const conversationId = (await client.query<{ id: string }>(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name) VALUES($1,$2,$3,'Contato') RETURNING id",
      [tenantId, sessionId, nextPhone()]
    )).rows[0].id;

    await client.query("COMMIT");
    const cookie = await cookieFor({ userId, tenantId, email, isRoot: true });
    return { tenantId, email, cookie, conversationId };
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

async function restrictedMemberCookie(tenantId: string): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const email = `copilot-restricted-${randomUUID()}@test.local`;
    const userId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,status,is_root) VALUES($1,$2,'active',false) RETURNING id",
      [email, passwordHash]
    )).rows[0].id;
    userIds.push(userId);
    const roleId = (await client.query<{ id: string }>(
      `INSERT INTO workspace_roles(workspace_id,name,description,is_owner_role,is_system)
       VALUES($1,'SEM_COPILOTO','Função sem permissões de conversa',false,false) RETURNING id`,
      [tenantId]
    )).rows[0].id;
    await client.query(
      "INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())",
      [tenantId, userId, roleId]
    );
    await client.query("COMMIT");
    return await cookieFor({ userId, tenantId, email, isRoot: false });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function addMessages(
  tenantId: string,
  conversationId: string,
  items: Array<{ sender: "contact" | "agent"; content: string }>
) {
  const base = Date.now() - 3_600_000;
  for (const [index, item] of items.entries()) {
    phoneSeq += 1;
    await pool.query(
      `INSERT INTO messages(conversation_id,tenant_id,sender,content,created_at)
       VALUES($1,$2,$3,$4,to_timestamp($5/1000.0) + make_interval(secs => $6))`,
      [conversationId, tenantId, item.sender, item.content, base / 1000, index]
    );
  }
}

async function messageCount(conversationId: string): Promise<number> {
  const result = await pool.query<{ total: string }>(
    "SELECT count(*)::text AS total FROM messages WHERE conversation_id=$1",
    [conversationId]
  );
  return Number(result.rows[0].total);
}

let tenantA: TenantFixture;
let tenantB: TenantFixture;
let agentlessTenant: TenantFixture;
let keylessTenant: TenantFixture;

beforeAll(async () => {
  passwordHash = await hash("Copilot#Test123", 4);
  tenantA = await createWorkspace(true, true);
  tenantB = await createWorkspace(true, true);
  agentlessTenant = await createWorkspace(false, false);
  keylessTenant = await createWorkspace(true, false);
  await addMessages(tenantA.tenantId, tenantA.conversationId, [
    { sender: "contact", content: "Oi, qual o valor do plano?" },
    { sender: "agent", content: "O plano custa R$ 99 por mês." }
  ]);
});

afterAll(async () => {
  if (tenantIds.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenantIds]);
  if (planIds.length) await pool.query("DELETE FROM plans WHERE id=ANY($1::uuid[])", [planIds]);
  if (userIds.length) {
    await pool.query("DELETE FROM audit_logs WHERE actor_user_id=ANY($1::uuid[])", [userIds]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]);
  }
  await pool.end();
});

describe("POST /conversations/:id/copilot-suggestion", () => {
  it("recusa conversa de outro tenant sem chamar a IA", async () => {
    const app = await appWith({ ai: new FakeAiRouter() });
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${tenantA.conversationId}/copilot-suggestion`,
      headers: { cookie: tenantB.cookie }
    });
    expect(response.statusCode).toBe(404);
  });

  it("exige permissão conversations.reply sem chamar a IA", async () => {
    const app = await appWith({ ai: new FakeAiRouter() });
    const cookie = await restrictedMemberCookie(tenantA.tenantId);
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${tenantA.conversationId}/copilot-suggestion`,
      headers: { cookie }
    });
    expect(response.statusCode).toBe(403);
  });

  it("gera sugestão sem enviar, sem executar ferramentas e registrando uso", async () => {
    const fake = new FakeAiRouter();
    const app = await appWith({ ai: fake });
    const before = await messageCount(tenantA.conversationId);
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${tenantA.conversationId}/copilot-suggestion`,
      headers: { cookie: tenantA.cookie }
    });
    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      suggestion: "Sugestão gerada",
      context_complete: true,
      messages_used: 2,
      messages_total: 2
    });
    expect(await messageCount(tenantA.conversationId)).toBe(before);
    const call = fake.calls[0];
    expect(call.systemPrompt).toBe("PROMPT AGENTE");
    expect(call.model).toBe("openai/gpt-4o-mini");
    expect(call.temperature).toBe(0.4);
    expect(call.tools).toEqual([]);
    expect(call.executeTool).toBeUndefined();
    expect(call.history).toEqual([
      { role: "user", content: "Oi, qual o valor do plano?" },
      { role: "assistant", content: "O plano custa R$ 99 por mês." }
    ]);
    const usage = await pool.query(
      `SELECT input_tokens FROM usage_logs
       WHERE conversation_id=$1 AND call_reason LIKE 'copilot_suggestion%'`,
      [tenantA.conversationId]
    );
    expect(usage.rows.length).toBeGreaterThanOrEqual(1);
    expect(Number(usage.rows[0].input_tokens)).toBe(11);
  });

  it("sinaliza histórico incompleto quando o orçamento de caracteres não cabe", async () => {
    const fake = new FakeAiRouter();
    const app = await appWith({ ai: fake, historyMaxCharacters: 150 });
    const conversation = (await pool.query<{ id: string }>(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,(SELECT session_id FROM conversations WHERE id=$2),$3) RETURNING id",
      [tenantA.tenantId, tenantA.conversationId, nextPhone()]
    )).rows[0].id;
    await addMessages(tenantA.tenantId, conversation, Array.from({ length: 6 }, (_, index) => ({
      sender: index % 2 === 0 ? "contact" as const : "agent" as const,
      content: `m${index + 1}`.padEnd(60, ".")
    })));
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${conversation}/copilot-suggestion`,
      headers: { cookie: tenantA.cookie }
    });
    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.context_complete).toBe(false);
    expect(body.messages_total).toBe(6);
    expect(body.messages_used).toBeLessThan(6);
    expect(fake.calls[0].history).toHaveLength(body.messages_used);
    expect(fake.calls[0].history.at(-1)?.content.startsWith("m6")).toBe(true);
    expect(fake.calls[0].history.some((message) => message.content.startsWith("m1"))).toBe(false);
  });

  it("regeneração recebe a sugestão anterior e não repete a resposta literal", async () => {
    const fake = new FakeAiRouter();
    const app = await appWith({ ai: fake });
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${tenantA.conversationId}/copilot-suggestion`,
      headers: { cookie: tenantA.cookie },
      payload: { previous_suggestion: "Sugestão gerada" }
    });
    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.suggestion).toBe("Alternativa revisada");
    expect(body.suggestion.trim()).not.toBe("Sugestão gerada");
    expect(fake.calls[0].systemContext).toContain("Sugestão gerada");
  });

  it("sem agente configurado responde erro acionável sem chamar a IA", async () => {
    const fake = new FakeAiRouter();
    const app = await appWith({ ai: fake });
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${agentlessTenant.conversationId}/copilot-suggestion`,
      headers: { cookie: agentlessTenant.cookie }
    });
    expect(response.statusCode).toBe(409);
    expect(typeof response.json().error).toBe("string");
    expect(fake.calls.length).toBe(0);
  });

  it("sem chave do provedor responde erro acionável sem chamar a IA", async () => {
    const fake = new FakeAiRouter();
    const app = await appWith({ ai: fake });
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${keylessTenant.conversationId}/copilot-suggestion`,
      headers: { cookie: keylessTenant.cookie }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("chave");
    expect(fake.calls.length).toBe(0);
  });

  it("bloqueia geração concorrente para a mesma conversa", async () => {
    const deferred = new DeferredAiRouter();
    const app = await appWith({ ai: deferred });
    const first = app.inject({
      method: "POST",
      url: `/conversations/${tenantA.conversationId}/copilot-suggestion`,
      headers: { cookie: tenantA.cookie }
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = await app.inject({
      method: "POST",
      url: `/conversations/${tenantA.conversationId}/copilot-suggestion`,
      headers: { cookie: tenantA.cookie }
    });
    expect(second.statusCode).toBe(409);
    deferred.release!();
    expect((await first).statusCode).toBe(200);
  });

  it("sinaliza histórico incompleto quando a última mensagem sozinha excede o orçamento", async () => {
    const fake = new FakeAiRouter();
    const app = await appWith({ ai: fake, historyMaxCharacters: 150 });
    const conversation = (await pool.query<{ id: string }>(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,(SELECT session_id FROM conversations WHERE id=$2),$3) RETURNING id",
      [tenantA.tenantId, tenantA.conversationId, nextPhone()]
    )).rows[0].id;
    const huge = "x".repeat(5_000);
    await addMessages(tenantA.tenantId, conversation, [{ sender: "contact", content: huge }]);
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${conversation}/copilot-suggestion`,
      headers: { cookie: tenantA.cookie }
    });
    const body = response.json();
    expect(response.statusCode).toBe(200);
    // SPEC R3: histórico acima do limite do modelo é sinalizado explicitamente,
    // nunca enviado integral de forma silenciosa.
    expect(body.context_complete).toBe(false);
    expect(fake.calls.length).toBe(1);
    const latest = fake.calls[0].history.at(-1)!;
    expect(latest.content.length).toBeLessThanOrEqual(150);
    expect(latest.content.endsWith(huge.slice(-150))).toBe(true);
  });

  it("recusa geração por quota do plano sem chamar a IA", async () => {
    const quotaTenant = await createWorkspace(true, true, { limit: 0 });
    const fake = new FakeAiRouter();
    const app = await appWith({ ai: fake });
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${quotaTenant.conversationId}/copilot-suggestion`,
      headers: { cookie: quotaTenant.cookie }
    });
    expect(response.statusCode).toBe(402);
    expect(response.json().code).toBe("ai_quota_exceeded");
    expect(fake.calls.length).toBe(0);
  });

  it("reserva e reconcilia interação cobrável do copiloto para assinatura ativa", async () => {
    const billedTenant = await createWorkspace(true, true, { limit: null });
    await addMessages(billedTenant.tenantId, billedTenant.conversationId, [
      { sender: "contact", content: "Preciso de ajuda com meu pedido." }
    ]);
    const fake = new FakeAiRouter();
    const app = await appWith({ ai: fake });
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${billedTenant.conversationId}/copilot-suggestion`,
      headers: { cookie: billedTenant.cookie }
    });
    expect(response.statusCode).toBe(200);
    // A reserva precisa existir ANTES da chamada ao provedor (gate de custo).
    const ledger = await pool.query<{ purpose: string; consumption_type: string; input_tokens: string; output_tokens: string; reconciled: boolean }>(
      "SELECT purpose,consumption_type,input_tokens,output_tokens,reconciled FROM ai_usage_ledger WHERE tenant_id=$1",
      [billedTenant.tenantId]
    );
    expect(ledger.rows.length).toBe(1);
    expect(ledger.rows[0]).toMatchObject({
      purpose: "copilot_suggestion",
      consumption_type: "INCLUDED"
    });
    // Reconciliação é fire-and-forget após o sucesso: aguardar o resultado.
    const deadline = Date.now() + 3_000;
    let reconciledRow: { input_tokens: string; output_tokens: string; reconciled: boolean } | undefined;
    while (Date.now() < deadline) {
      const check = await pool.query<{ input_tokens: string; output_tokens: string; reconciled: boolean }>(
        "SELECT input_tokens,output_tokens,reconciled FROM ai_usage_ledger WHERE tenant_id=$1 AND reconciled=true",
        [billedTenant.tenantId]
      );
      if (check.rows[0]) { reconciledRow = check.rows[0]; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(reconciledRow).toBeDefined();
    expect(Number(reconciledRow!.input_tokens)).toBe(11);
    expect(Number(reconciledRow!.output_tokens)).toBe(7);
  });

  it("falha do provedor libera a reserva de interação para não bloquear a quota", async () => {
    const billedTenant = await createWorkspace(true, true, { limit: 1 });
    const failing = new FakeAiRouter();
    failing.failing = new NonRetryableAiError("provider_request_rejected", "OpenRouter failed (400)");
    const app = await appWith({ ai: failing });
    const failed = await app.inject({
      method: "POST",
      url: `/conversations/${billedTenant.conversationId}/copilot-suggestion`,
      headers: { cookie: billedTenant.cookie }
    });
    expect(failed.statusCode).toBe(502);
    // Nenhum usage_logs foi gravado neste caminho: a reserva tem de voltar
    // (liberação é fire-and-forget, logo aguardar o efeito), senão a quota —
    // e o spending cap — fica bloqueada para sempre.
    const deadline = Date.now() + 3_000;
    let released = false;
    while (Date.now() < deadline) {
      const check = await pool.query<{ unreconciled: string; included_usage: string }>(
        `SELECT (SELECT count(*)::text FROM ai_usage_ledger l WHERE l.tenant_id=$1 AND l.reconciled=false) AS unreconciled,
                (SELECT included_usage::text FROM usage_periods WHERE tenant_id=$1) AS included_usage`,
        [billedTenant.tenantId]
      );
      if (check.rows[0].unreconciled === "0" && check.rows[0].included_usage === "0") { released = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(released).toBe(true);
    // Com a reserva liberada, uma nova interação é aprovada de novo.
    const again = await consumeAiInteraction(billedTenant.tenantId, "copilot_suggestion", randomUUID());
    expect(again).toMatchObject({ allowed: true, consumptionType: "INCLUDED" });
  });

  it("mapeia falha e rate limit do provedor", async () => {
    const rateLimited = new FakeAiRouter();
    rateLimited.failing = new Error("OpenRouter failed (429)");
    const rateLimitApp = await appWith({ ai: rateLimited });
    const rateLimitResponse = await rateLimitApp.inject({
      method: "POST",
      url: `/conversations/${tenantA.conversationId}/copilot-suggestion`,
      headers: { cookie: tenantA.cookie }
    });
    expect(rateLimitResponse.statusCode).toBe(503);

    const rejected = new FakeAiRouter();
    rejected.failing = new NonRetryableAiError("provider_request_rejected", "OpenRouter failed (400)");
    const rejectedApp = await appWith({ ai: rejected });
    const rejectedResponse = await rejectedApp.inject({
      method: "POST",
      url: `/conversations/${tenantA.conversationId}/copilot-suggestion`,
      headers: { cookie: tenantA.cookie }
    });
    expect(rejectedResponse.statusCode).toBe(502);
  });
});
