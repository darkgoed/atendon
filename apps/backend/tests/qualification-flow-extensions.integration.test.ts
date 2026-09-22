import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { seedTenantCapabilities } from "./helpers/capability-seed.js";
import { DEFAULT_QUALIFICATION_FLOW, activationIssues, flowDefinitionSchema, type FlowDefinition } from "../src/modules/qualification/flow.js";
import { QualificationService } from "../src/modules/qualification/service.js";
import { MessageProcessor } from "../src/modules/messages/process-message.js";
import type { ConversationContext } from "../src/modules/messages/repository.js";

// Fakes do ponto de wire (padrão de process-message.test.ts): redis e billing
// fora do caminho; robô e IA são o que está em prova aqui.
const acquireConversationLockMock = vi.hoisted(() => vi.fn().mockResolvedValue({ key: "test-lock" }));
const isConversationLockedMock = vi.hoisted(() => vi.fn().mockResolvedValue(false));
const releaseConversationLockMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const extendConversationLockMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock("../src/modules/messages/conversation-lock.js", () => ({
  acquireConversationLock: acquireConversationLockMock,
  isConversationLocked: isConversationLockedMock,
  releaseConversationLock: releaseConversationLockMock,
  extendConversationLock: extendConversationLockMock,
  closeConversationLock: vi.fn().mockResolvedValue(undefined)
}));
vi.mock("../src/modules/messages/rate-limiter.js", () => ({
  consumeRateLimitRedis: vi.fn().mockResolvedValue(true),
  closeRateLimiter: vi.fn().mockResolvedValue(undefined)
}));
const consumeAiInteractionMock = vi.hoisted(() => vi.fn().mockResolvedValue({ allowed: true }));
vi.mock("../src/billing/ai-consumption.js", () => ({
  consumeAiInteraction: consumeAiInteractionMock,
  reconcileAiTurnFromUsageLogs: vi.fn().mockResolvedValue(undefined)
}));

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const service = new QualificationService();
let tenantId = "";
let sessionId = "";
let cookie = "";
let readCookie = "";
let testEmails: string[] = [];
let tagId = "";
let phoneSequence = Number(Date.now().toString().slice(-8));
const nextPhone = (ddd = "11") => `55${ddd}${String(++phoneSequence).slice(-8).padStart(8, "0")}`;

// Fluxo de robô que cobre message → pergunta → action(tag) → delay →
// wait_for_reply → final, com os dois destinos da espera (resposta e timeout).
const robotFlowDefinition = (tag: string) => ({
  start: "M_VAW",
  origem: "facebook",
  triggers: { ctwa: false, session_ids: [], keywords: ["robo"] },
  steps: {
    M_VAW: { kind: "message", message: "Olá! Vou te fazer uma pergunta rápida.", next: "Q_TIPO" },
    Q_TIPO: {
      kind: "options",
      field: "tipo_negocio",
      question: "Sua loja é de produtos ou serviço?",
      options: [{ value: "loja" }, { value: "servico" }],
      transitions: { loja: "A_TAGS", servico: "F_SERVICO" }
    },
    A_TAGS: { kind: "action", action_type: "tag_add", tag_ids: [tag], next: "D_DELAY" },
    D_DELAY: { kind: "delay", wait_minutes: 1, next: "W_REPLY" },
    W_REPLY: {
      kind: "wait_for_reply",
      timeout_minutes: 1,
      variable_name: "resposta_teste",
      message: "Me conta o que procura?",
      on_timeout: "T_TIMEOUT",
      next: "F_OK"
    },
    T_TIMEOUT: { kind: "message", message: "Sem problema!", next: "F_T" },
    F_T: { kind: "final", message: "Encerrado por tempo." },
    F_SERVICO: { kind: "final", message: "Serviços não participam." },
    F_OK: { kind: "final", message: "Obrigado, {{resposta_teste}}!" }
  }
}) satisfies z.input<typeof flowDefinitionSchema>;

async function qualificationState(phone: string) {
  return (await pool.query<{ id: string; lead_id: string; current_step: string; status: string; wait_until: Date | null; answers: Record<string, string> }>(
    `SELECT q.id,q.lead_id,q.current_step,q.status,q.wait_until,q.answers
     FROM scheduling_leads l JOIN lead_qualifications q ON q.lead_id=l.id AND q.tenant_id=l.tenant_id
     WHERE l.tenant_id=$1 AND l.phone=$2`,
    [tenantId, phone]
  )).rows[0];
}

// O snapshot do robô casa lead com conversa (conversations_link_lead cria o
// lead ao inserir a conversa) — mesma pré-condição do pipeline inbound real.
async function ensureConversation(phone: string) {
  await pool.query("INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3)", [tenantId, sessionId, phone]);
}

async function dueNow(qualificationId: string) {
  await pool.query("UPDATE lead_qualifications SET wait_until=now()-interval '1 second' WHERE id=$1", [qualificationId]);
  return service.processDueWait({ tenantId, qualificationId });
}

beforeAll(async () => {
  await app.ready();
  tenantId = (await pool.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Qualification W3A ${randomUUID()}`])).rows[0].id;
  await seedTenantCapabilities(pool, [tenantId]);
  sessionId = (await pool.query<{ id: string }>("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id", [tenantId])).rows[0].id;
  tagId = (await pool.query<{ id: string }>("INSERT INTO lead_tags(tenant_id,name,color) VALUES($1,'W3A Robô','#123456') RETURNING id", [tenantId])).rows[0].id;
  await pool.query("INSERT INTO qualification_flows(tenant_id,id,name,active,definition) VALUES($1,'robot-ext','Robô W3A',false,$2)", [tenantId, robotFlowDefinition(tagId)]);
  const email = `w3a-${randomUUID()}@test.local`;
  const readEmail = `w3a-read-${randomUUID()}@test.local`;
  testEmails = [email, readEmail];
  const password = "w3a-password";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantId);
    const passwordHash = await hash(password, 4);
    const user = (await client.query<{ id: string }>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id", [email, passwordHash])).rows[0];
    await client.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'", [tenantId, user.id]);
    const readRole = (await client.query<{ id: string }>("INSERT INTO workspace_roles(workspace_id,name,description) VALUES($1,$2,'Leitura W3A') RETURNING id", [tenantId, `W3A READ ${randomUUID()}`])).rows[0].id;
    await client.query("INSERT INTO workspace_role_permissions(role_id,permission_key) VALUES($1,'agent.read')", [readRole]);
    const readUser = (await client.query<{ id: string }>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id", [readEmail, passwordHash])).rows[0];
    await client.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())", [tenantId, readUser.id, readRole]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  cookie = (Array.isArray(login.headers["set-cookie"]) ? login.headers["set-cookie"][0] : login.headers["set-cookie"]!).split(";")[0];
  const readLogin = await app.inject({ method: "POST", url: "/auth/login", payload: { email: readEmail, password } });
  readCookie = (Array.isArray(readLogin.headers["set-cookie"]) ? readLogin.headers["set-cookie"][0] : readLogin.headers["set-cookie"]!).split(";")[0];
});

afterAll(async () => {
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE email=ANY($1::text[]))", [testEmails]);
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.query("DELETE FROM users WHERE email=ANY($1::text[])", [testEmails]);
  await app.close();
  await pool.end();
});

describe("W3A fechamento — fluxos de robô", () => {
  it("mantém o fluxo padrão retrocompatível e ativa via PUT", async () => {
    const parsed = flowDefinitionSchema.safeParse(DEFAULT_QUALIFICATION_FLOW);
    expect(parsed.success).toBe(true);
    const withTrigger = { ...(parsed.data as FlowDefinition), triggers: { ...(parsed.data as FlowDefinition).triggers, ctwa: true } };
    expect(activationIssues(withTrigger)).toEqual([]);
    const activated = await app.inject({ method: "PUT", url: "/qualification/flows/padrao-w3a", headers: { cookie }, payload: { nome: "Fluxo padrão", ativo: true, ctwa: true, revisao_base: 0 } });
    expect(activated.statusCode).toBe(201);
    expect(activated.json().flow).toMatchObject({ ativo: true, revisao: 1 }); // criação: revision nasce em 1
    // Volta a inativar: o fluxo do robô assume os testes seguintes.
    const deactivated = await app.inject({ method: "PUT", url: "/qualification/flows/padrao-w3a", headers: { cookie }, payload: { nome: "Fluxo padrão", ativo: false, revisao_base: 1 } });
    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.json().flow.ativo).toBe(false);
    expect(deactivated.json().flow.revisao).toBe(2); // trigger incrementa em qualquer UPDATE
  });

  it("rejeita ciclo sem saída na ativação", async () => {
    const loop = await app.inject({
      method: "PUT", url: "/qualification/flows/robot-loop", headers: { cookie },
      payload: {
        nome: "Loop", ativo: true, ctwa: true, revisao_base: 0,
        definition: {
          start: "A", origem: "facebook",
          triggers: { ctwa: true, session_ids: [], keywords: [] },
          steps: { A: { kind: "message", message: "x", next: "A" } }
        }
      }
    });
    expect(loop.statusCode).toBe(400);
    expect(loop.json().error).toContain("loop sem saída");
  });

  it("dispara só por match exato do gatilho (substring nunca dispara)", async () => {
    await pool.query("UPDATE qualification_flows SET active=true WHERE tenant_id=$1 AND id='robot-ext'", [tenantId]);
    const substringPhone = nextPhone();
    await ensureConversation(substringPhone);
    const substring = await service.handleInbound({ tenantId, sessionId, contactPhone: substringPhone, text: "quero robo agora por favor", externalId: `ext-${randomUUID()}` });
    expect(substring).toBeNull();
    expect(await qualificationState(substringPhone)).toBeUndefined();
    const exactPhone = nextPhone();
    await ensureConversation(exactPhone);
    const exact = await service.handleInbound({ tenantId, sessionId, contactPhone: exactPhone, text: "Robô", externalId: `ext-${randomUUID()}` });
    expect(exact).not.toBeNull();
    expect((await qualificationState(exactPhone))?.current_step).toBe("Q_TIPO");
  });

  it("executa delay + wait_for_reply + action de ponta a ponta com retomada via processDueWait", async () => {
    const phone = nextPhone();
    await ensureConversation(phone);
    const started = await service.handleInbound({ tenantId, sessionId, contactPhone: phone, text: "robo", externalId: `ext-${randomUUID()}` });
    expect(started?.reply).toBe("Olá! Vou te fazer uma pergunta rápida.");
    let state = (await qualificationState(phone))!;
    expect(state.current_step).toBe("Q_TIPO");

    // Resposta aceita → action (tag) → delay em espera
    const answered = await service.handleInbound({ tenantId, sessionId, contactPhone: phone, text: "loja", externalId: `ext-${randomUUID()}` });
    expect(answered).not.toBeNull();
    state = (await qualificationState(phone))!;
    expect(state.current_step).toBe("D_DELAY");
    expect(state.wait_until).not.toBeNull();
    expect((await pool.query("SELECT 1 FROM lead_tag_assignments WHERE tenant_id=$1 AND lead_id=$2 AND tag_id=$3", [tenantId, state.lead_id, tagId])).rowCount).toBe(1);

    // Retomada do delay (worker/reconciliador simulados)
    const resumed = await dueNow(state.id);
    expect(resumed).toMatchObject({ processed: true });
    state = (await qualificationState(phone))!;
    expect(state.current_step).toBe("W_REPLY");
    expect(state.wait_until).not.toBeNull();
    // A última mensagem 'message' é a da espera (a saudação M_VAW veio antes);
    // created_at empatado dentro da mesma transação → ordenar explícito.
    const waitMessage = (await pool.query<{ message: string }>(
      "SELECT message FROM qualification_message_outbox WHERE qualification_id=$1 AND message_kind='message' ORDER BY created_at DESC, id DESC LIMIT 1", [state.id]
    )).rows[0];
    expect(waitMessage?.message).toBe("Me conta o que procura?");

    // Resposta dentro da espera → interpolação → conclusão
    const replied = await service.handleInbound({ tenantId, sessionId, contactPhone: phone, text: "quero um patinete elétrico", externalId: `ext-${randomUUID()}` });
    expect(replied?.reply).toBe("Obrigado, quero um patinete elétrico!");
    state = (await qualificationState(phone))!;
    expect(state.status).toBe("concluido");
    expect(state.answers.resposta_teste).toBe("quero um patinete elétrico");
    const history = (await pool.query<{ history: Array<{ campo: string | null; valor: string }> }>("SELECT history FROM lead_qualifications WHERE id=$1", [state.id])).rows[0].history;
    expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ campo: "resposta_teste", valor: "quero um patinete elétrico" })]));
  });

  it("registra histórico entered/completed/waiting no flow_execution_log", async () => {
    const logs = (await pool.query<{ node_id: string; kind: string; status: string }>(
      "SELECT node_id,kind,status FROM flow_execution_log WHERE tenant_id=$1 AND flow_id='robot-ext' ORDER BY created_at,id", [tenantId]
    )).rows;
    expect(logs).toEqual(expect.arrayContaining([
      { node_id: "M_VAW", kind: "message", status: "completed" },
      { node_id: "Q_TIPO", kind: "options", status: "entered" },
      { node_id: "Q_TIPO", kind: "options", status: "completed" },
      { node_id: "A_TAGS", kind: "action", status: "completed" },
      { node_id: "D_DELAY", kind: "delay", status: "waiting" },
      { node_id: "D_DELAY", kind: "delay", status: "completed" },
      { node_id: "W_REPLY", kind: "wait_for_reply", status: "waiting" },
      { node_id: "F_OK", kind: "final", status: "completed" }
    ]));
  });

  it("retoma wait_for_reply por timeout até o final", async () => {
    const phone = nextPhone();
    await ensureConversation(phone);
    await service.handleInbound({ tenantId, sessionId, contactPhone: phone, text: "robo", externalId: `ext-${randomUUID()}` });
    let state = (await qualificationState(phone))!;
    await service.handleInbound({ tenantId, sessionId, contactPhone: phone, text: "loja", externalId: `ext-${randomUUID()}` });
    state = (await qualificationState(phone))!;
    expect((await dueNow(state.id)).processed).toBe(true); // delay → W_REPLY
    state = (await qualificationState(phone))!;
    expect((await dueNow(state.id)).processed).toBe(true); // timeout → T_TIMEOUT → F_T
    state = (await qualificationState(phone))!;
    expect(state.status).toBe("concluido");
    expect(state.current_step).toBe("F_T");
    const reply = (await pool.query<{ message: string }>(
      "SELECT message FROM qualification_message_outbox WHERE qualification_id=$1 AND message_kind='final' ORDER BY created_at DESC, id DESC LIMIT 1", [state.id]
    )).rows[0];
    // F_T encerra ("Encerrado por tempo."); a mensagem do ramo on_timeout
    // (T_TIMEOUT) também foi entregue antes.
    expect(reply?.message).toBe("Encerrado por tempo.");
    const timeoutMessage = (await pool.query<{ message: string }>(
      "SELECT message FROM qualification_message_outbox WHERE qualification_id=$1 AND message_kind='message' ORDER BY created_at DESC, id DESC LIMIT 1", [state.id]
    )).rows[0];
    expect(timeoutMessage?.message).toBe("Sem problema!");
  });

  it("lead na lixeira: espera vencida cancela a qualificação (lead_deleted) sem retomar o robô", async () => {
    const phone = nextPhone();
    await ensureConversation(phone);
    await service.handleInbound({ tenantId, sessionId, contactPhone: phone, text: "robo", externalId: `ext-${randomUUID()}` });
    let state = (await qualificationState(phone))!;
    await service.handleInbound({ tenantId, sessionId, contactPhone: phone, text: "loja", externalId: `ext-${randomUUID()}` });
    state = (await qualificationState(phone))!;
    expect(state.wait_until).not.toBeNull();

    await pool.query("UPDATE scheduling_leads SET deleted_at=now() WHERE id=$1", [state.lead_id]);
    expect(await dueNow(state.id)).toEqual({ processed: false, reason: "lead_deleted" });

    const after = (await pool.query<{ status: string; wait_until: Date | null }>(
      "SELECT status,wait_until FROM lead_qualifications WHERE id=$1", [state.id]
    )).rows[0];
    expect(after.status).toBe("concluido");
    expect(after.wait_until).toBeNull();
    const log = (await pool.query<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM flow_execution_log WHERE tenant_id=$1 AND lead_id=$2 ORDER BY created_at DESC, id DESC LIMIT 1",
      [tenantId, state.lead_id]
    )).rows[0];
    expect(log.detail).toMatchObject({ motivo: "lead_deleted" });
  });

  it("simula sem efeitos e devolve o traço determinístico", async () => {
    const logsBefore = (await pool.query<{ count: string }>("SELECT count(*) FROM flow_execution_log WHERE tenant_id=$1", [tenantId])).rows[0].count;
    const stateBefore = (await pool.query<{ count: string }>("SELECT count(*) FROM lead_qualifications WHERE tenant_id=$1", [tenantId])).rows[0].count;
    const definition = robotFlowDefinition(tagId);
    const simulate = await app.inject({ method: "POST", url: "/qualification/flows/robot-ext/simulate", headers: { cookie }, payload: { definition, text: "loja" } });
    expect(simulate.statusCode).toBe(200);
    const trace = simulate.json().trace;
    expect(trace[0]).toMatchObject({ node_id: "M_VAW", nodeId: "M_VAW", kind: "message" });
    // A entrada "loja" é consumida na pergunta e o traço para na espera proativa.
    expect(trace.at(-1)).toMatchObject({ node_id: "W_REPLY", kind: "wait_for_reply", result: expect.stringContaining("aguardando resposta") });
    // snake_case + maxSteps do chamador W3B
    const snake = await app.inject({ method: "POST", url: "/qualification/flows/robot-ext/simulate", headers: { cookie }, payload: { definition, entrada: "loja", max_steps: 1 } });
    expect(snake.statusCode).toBe(200);
    expect(snake.json().trace).toHaveLength(2);
    expect(snake.json().trace[0].node_id).toBe("M_VAW");
    expect((await pool.query<{ count: string }>("SELECT count(*) FROM flow_execution_log WHERE tenant_id=$1", [tenantId])).rows[0].count).toBe(logsBefore);
    expect((await pool.query<{ count: string }>("SELECT count(*) FROM lead_qualifications WHERE tenant_id=$1", [tenantId])).rows[0].count).toBe(stateBefore);
  });

  it("duplica fluxo com id novo, inativo e definição idêntica", async () => {
    expect((await app.inject({ method: "POST", url: "/qualification/flows/inexistente/duplicate", headers: { cookie }, payload: { name: "X" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/qualification/flows/robot-ext/duplicate", headers: { cookie: readCookie }, payload: { name: "X" } })).statusCode).toBe(403);
    const duplicated = await app.inject({ method: "POST", url: "/qualification/flows/robot-ext/duplicate", headers: { cookie }, payload: { name: "Robô W3A Cópia" } });
    expect(duplicated.statusCode).toBe(201);
    const flow = duplicated.json().flow;
    expect(flow.id).not.toBe("robot-ext");
    expect(flow).toMatchObject({ nome: "Robô W3A Cópia", ativo: false, gatilhos: { keywords: ["robo"] } });
    const source = (await pool.query<{ definition: unknown }>("SELECT definition FROM qualification_flows WHERE tenant_id=$1 AND id='robot-ext'", [tenantId])).rows[0].definition;
    expect(flow.definition).toEqual(source);
  });

  it("pagina o histórico com cursor keyset e filtro de conversa", async () => {
    expect((await app.inject({ url: "/qualification/flows/robot-ext/executions" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/qualification/flows/robot-ext/executions", headers: { cookie: readCookie } })).statusCode).toBe(200);
    const first = await app.inject({ url: "/qualification/flows/robot-ext/executions?limit=2", headers: { cookie } });
    expect(first.statusCode).toBe(200);
    const page1 = first.json();
    expect(page1.executions).toHaveLength(2);
    expect(page1.next_cursor).toBeTruthy();
    const second = await app.inject({ url: `/qualification/flows/robot-ext/executions?limit=2&cursor=${encodeURIComponent(page1.next_cursor)}`, headers: { cookie } });
    const page2 = second.json();
    const seen = new Set([...page1.executions.map((row: { id: string }) => row.id), ...page2.executions.map((row: { id: string }) => row.id)]);
    expect(seen.size).toBe(page1.executions.length + page2.executions.length);
    expect((await app.inject({ url: `/qualification/flows/robot-ext/executions?conversation_id=${randomUUID()}`, headers: { cookie } })).json().executions).toEqual([]);
    expect((await app.inject({ url: "/qualification/flows/inexistente/executions", headers: { cookie } })).statusCode).toBe(404);
  });

  it("robô responde no pipeline e a IA não é chamada", async () => {
    const gateway = {
      sendText: vi.fn().mockResolvedValue({ externalId: `robot-${randomUUID()}` }),
      sendPresence: vi.fn().mockResolvedValue(undefined),
      markMessageAsRead: vi.fn().mockResolvedValue(undefined),
      setPresence: vi.fn().mockResolvedValue(undefined)
    };
    const ai = { complete: vi.fn() };
    const repository = {
      recordInboundAndLoadContext: vi.fn().mockResolvedValue({
        conversationId: "wire-conversation", messageId: randomUUID(), agentConfigVersionId: "v1", aiActive: true,
        model: "model-1", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 512, timeZone: "America/Sao_Paulo",
        meetingAgendas: [], history: [{ role: "user", content: "robo" }], mediaFallback: { audio: "", image: "", document: "" },
        enabledToolNames: [], facebookAttribution: {}
      } satisfies ConversationContext),
      getAiUsageTotals: vi.fn().mockResolvedValue({ providerRequests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }),
      findPendingContactTextMessages: vi.fn().mockImplementation((_conversationId: string, fromExternalId: string) =>
        Promise.resolve([{ externalId: fromExternalId, text: "robo" }])),
      findUnreadContactMessages: vi.fn().mockResolvedValue([]),
      markContactMessagesRead: vi.fn().mockResolvedValue(undefined),
      markInboundProcessed: vi.fn().mockResolvedValue(undefined),
      recordAgentReply: vi.fn().mockResolvedValue(undefined),
      recordAiUsage: vi.fn().mockResolvedValue(undefined)
    };
    const processor = new MessageProcessor(
      repository as never, gateway as never, ai as never, undefined, 15, undefined, undefined,
      (input) => service.handleInbound(input)
    );
    const phone = nextPhone();
    const result = await processor.process({ externalId: `wire-${randomUUID()}`, tenantId, sessionId, contactPhone: phone, text: "robo" });
    expect(result).toBe("answered");
    expect(ai.complete).not.toHaveBeenCalled();
    expect(gateway.sendText).toHaveBeenCalledWith(sessionId, phone, "Olá! Vou te fazer uma pergunta rápida.");
    expect(repository.recordAgentReply).toHaveBeenCalledWith(expect.objectContaining({ model: "qualification-flow", text: "Olá! Vou te fazer uma pergunta rápida." }));
    expect(repository.markInboundProcessed).toHaveBeenCalled();
    const state = (await qualificationState(phone))!;
    expect(state).toBeDefined();
    const outbox = (await pool.query<{ message_kind: string; status: string; external_message_id: string | null }>(
      "SELECT message_kind,status,external_message_id FROM qualification_message_outbox WHERE qualification_id=$1", [state.id]
    )).rows;
    // Primeira mensagem do robô vai inline (marcada sent aqui); a pergunta
    // aguarda o pump da outbox. created_at empatado na mesma transação →
    // busca por kind, não por posição.
    const inline = outbox.find((row) => row.message_kind === "message");
    const question = outbox.find((row) => row.message_kind === "question");
    expect(inline).toMatchObject({ message_kind: "message", status: "sent" });
    expect(inline?.external_message_id).toMatch(/^robot-/);
    expect(question).toMatchObject({ message_kind: "question", status: "pending" });
  });

  it("sem fluxo ou sem gatilho o turno de IA segue inalterado", async () => {
    const gateway = {
      sendText: vi.fn().mockResolvedValue({ externalId: `ai-${randomUUID()}` }),
      sendPresence: vi.fn().mockResolvedValue(undefined),
      markMessageAsRead: vi.fn().mockResolvedValue(undefined),
      setPresence: vi.fn().mockResolvedValue(undefined)
    };
    const ai = { complete: vi.fn().mockResolvedValue({ text: "Posso ajudar sim!", inputTokens: 1, outputTokens: 1, costUsd: 0 }) };
    const repository = {
      recordInboundAndLoadContext: vi.fn().mockResolvedValue({
        conversationId: "wire-conversation-2", messageId: randomUUID(), agentConfigVersionId: "v1", aiActive: true,
        model: "model-1", systemPrompt: "Ajude", temperature: 0.4, maxTokens: 512, timeZone: "America/Sao_Paulo",
        meetingAgendas: [], history: [{ role: "user", content: "oi tudo bem" }], mediaFallback: { audio: "", image: "", document: "" },
        enabledToolNames: [], facebookAttribution: {}
      } satisfies ConversationContext),
      getAiUsageTotals: vi.fn().mockResolvedValue({ providerRequests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }),
      findPendingContactTextMessages: vi.fn().mockImplementation((_conversationId: string, fromExternalId: string) =>
        Promise.resolve([{ externalId: fromExternalId, text: "oi tudo bem" }])),
      findUnreadContactMessages: vi.fn().mockResolvedValue([]),
      markContactMessagesRead: vi.fn().mockResolvedValue(undefined),
      markInboundProcessed: vi.fn().mockResolvedValue(undefined),
      recordAgentReply: vi.fn().mockResolvedValue(undefined),
      recordAiUsage: vi.fn().mockResolvedValue(undefined)
    };
    const processor = new MessageProcessor(
      repository as never, gateway as never, ai as never, undefined, 15, undefined, undefined,
      (input) => service.handleInbound(input)
    );
    const phone = nextPhone();
    const result = await processor.process({ externalId: `wire-ai-${randomUUID()}`, tenantId, sessionId, contactPhone: phone, text: "oi tudo bem" });
    expect(result).toBe("answered");
    expect(ai.complete).toHaveBeenCalledTimes(1);
    expect(gateway.sendText).toHaveBeenCalledWith(sessionId, phone, "Posso ajudar sim!");
    expect(await qualificationState(phone)).toBeUndefined();
  });

  it("pausado: com humano dono silencia ({reply:null}); sem humano devolve null (turno de IA)", async () => {
    const phone = nextPhone();
    await ensureConversation(phone);
    await service.handleInbound({ tenantId, sessionId, contactPhone: phone, text: "robo", externalId: `ext-${randomUUID()}` });
    await pool.query(
      "UPDATE lead_qualifications q SET status='pausado' FROM scheduling_leads l WHERE q.lead_id=l.id AND q.tenant_id=l.tenant_id AND l.tenant_id=$1 AND l.phone=$2",
      [tenantId, phone]
    );
    // Sem humano dono da conversa: null → o turno de IA segue.
    expect(await service.handleInbound({ tenantId, sessionId, contactPhone: phone, text: "loja", externalId: `ext-${randomUUID()}` })).toBeNull();
    // Com humano dono: o fluxo fica calado ({reply:null}).
    const human = (await pool.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,status) VALUES($1,'x','active') RETURNING id",
      [`w3a-human-${randomUUID()}@test.local`]
    )).rows[0].id;
    // assigned_user_id exige membro ativo do workspace (FK/trigger).
    const humanRole = (await pool.query<{ id: string }>(
      "SELECT id FROM workspace_roles WHERE workspace_id=$1 ORDER BY name LIMIT 1",
      [tenantId]
    )).rows[0].id;
    await pool.query(
      "INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())",
      [tenantId, human, humanRole]
    );
    await pool.query("UPDATE conversations SET assigned_user_id=$3 WHERE tenant_id=$1 AND contact_phone=$2", [tenantId, phone, human]);
    expect(await service.handleInbound({ tenantId, sessionId, contactPhone: phone, text: "loja", externalId: `ext-${randomUUID()}` })).toEqual({ reply: null });
  });
});
