// SPEC v7 ONDA 2-C — B7/B8: GET /me/messaging-capabilities (flags derivadas do
// gateway, degradação segura) e POST /conversations/initiate (create-or-reuse
// por (tenant,sessão,telefone), pausa da IA, mensagem humana + gateway, 409/502
// com delete compensatório), ChannelGatewayRouter (delegação/unsupported por
// canal), EvolutionClient.sendInteractive e WhatsAppSessionManager.sendInteractive.
// app.ts é do orquestrador (fora de escopo): o app de teste registra o plugin
// de mensageria + @fastify/cookie, o mesmo conjunto que app.ts usa.
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Logger } from "pino";
import { hash } from "bcryptjs";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { z } from "zod";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { registerMessagingRoutes } from "../src/modules/messaging/routes.js";
import { ChannelGatewayRouter, ChannelOperationUnsupportedError } from "../src/modules/messages/channel-gateway.js";
import type { MessageGateway } from "../src/modules/messages/types.js";
import { config } from "../src/config.js";
import { EvolutionClient } from "../src/modules/whatsapp/evolution-client.js";
import { WhatsAppSessionManager } from "../src/modules/whatsapp/session-manager.js";
import { WhatsAppSendRejectedError } from "../src/modules/whatsapp/errors.js";

const password = "messaging-initiate-password";
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });

// Gateway fake mutável: os testes trocam a implementação (com/sem métodos
// opcionais, sucesso/rejeição) — o app fecha sobre a MESMA referência.
const gateway: Partial<MessageGateway> = {
  sendText: vi.fn(),
  sendPresence: vi.fn(),
  markMessageAsRead: vi.fn(),
  setPresence: vi.fn(),
  sessionMessagingCapabilities: vi.fn()
};

const app = Fastify({ logger: false });
// O handler TEM que ser registrado antes dos plugins: um setErrorHandler
// chamado depois de app.register não é herdado pelo contexto encapsulado das
// rotas (Fastify resolve o errorHandler no encapsulamento) — ZodError viraria
// 500 e a mensagem de erro seria o statusText do Fastify ("Conflict").
app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
  const status = error instanceof z.ZodError
    ? 400
    : typeof error.statusCode === "number" ? error.statusCode : 500;
  return reply.status(status).send({ error: error.message });
});
await app.register(cookie);
await app.register(registerMessagingRoutes, { gateway: gateway as MessageGateway });
await app.ready();

let tenantA = "";
let tenantB = "";
let tenantR = "";
let ownerA = "";
let readA = "";
let swOk = "";
let swThr = "";
let swPending = "";
let si = "";
let foreignSessionB = "";
let routerWhatsappSession = "";
let routerInstagramSession = "";
let initiatedConversationId = "";
const emails = new Map<string, string>();
const cookies = new Map<string, string>();
const testEmails: string[] = [];

let phoneSequence = Number(Date.now().toString().slice(-8));
const nextPhone = (ddd = "11") => `55${ddd}${String(++phoneSequence).slice(-8).padStart(8, "0")}`;

async function cookieFor(userId: string, tenantId: string): Promise<string> {
  const cached = cookies.get(userId);
  if (cached) return cached;
  const token = await createSessionToken({
    userId,
    tenantId,
    email: emails.get(userId)!,
    isRoot: false,
    rootWorkspaceAccess: false,
    mustChangePassword: false
  });
  const header = `atendon_session=${token}`;
  cookies.set(userId, header);
  return header;
}

async function seedLead(tenantId: string, phone: string, name = "Lead W2C"): Promise<string> {
  return (await pool.query<{ id: string }>(
    "INSERT INTO scheduling_leads(tenant_id,phone,name,source) VALUES($1,$2,$3,'teste') RETURNING id",
    [tenantId, phone, name]
  )).rows[0].id;
}

async function initiate(input: { cookie: string; leadId: string; sessionId: string; text?: string; idempotencyKey?: string }) {
  return app.inject({
    method: "POST",
    url: "/conversations/initiate",
    headers: {
      cookie: input.cookie,
      ...(input.idempotencyKey === undefined ? {} : { "idempotency-key": input.idempotencyKey })
    },
    payload: { lead_id: input.leadId, session_id: input.sessionId, text: input.text ?? "Olá! Posso ajudar?" }
  });
}

async function conversationCount(tenantId: string, sessionId: string, phone: string): Promise<number> {
  return (await pool.query<{ count: number }>(
    "SELECT count(*)::int count FROM conversations WHERE tenant_id=$1 AND session_id=$2 AND contact_phone=$3",
    [tenantId, sessionId, phone]
  )).rows[0].count;
}

beforeAll(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenants = await client.query<{ id: string }>(
      "INSERT INTO tenants(name,status) VALUES($1,'active'),($2,'active'),($3,'active') RETURNING id",
      [`Messaging W2C A ${randomUUID()}`, `Messaging W2C B ${randomUUID()}`, `Messaging W2C R ${randomUUID()}`]
    );
    [tenantA, tenantB, tenantR] = tenants.rows.map((row) => row.id);
    for (const tenantId of [tenantA, tenantB]) {
      await ensureWorkspaceDefaultRoles(client, tenantId);
    }
    const passwordHash = await hash(password, 4);
    const createUser = async (tenantId: string, roleName: string): Promise<string> => {
      const email = `messaging-w2c-${randomUUID()}@test.local`;
      testEmails.push(email);
      const user = (await client.query<{ id: string }>(
        "INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",
        [email, passwordHash]
      )).rows[0].id;
      emails.set(user, email);
      await client.query(
        `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
         SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name=$3`,
        [tenantId, user, roleName]
      );
      return user;
    };
    ownerA = await createUser(tenantA, "OWNER");
    readA = await createUser(tenantA, "OWNER");
    // readA fica só com conversations.read: role exclusiva de leitura.
    await client.query("DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", [tenantA, readA]);
    const readRoleId = (await client.query<{ id: string }>(
      "INSERT INTO workspace_roles(workspace_id,name,description) VALUES($1,$2,'Leitura conversas') RETURNING id",
      [tenantA, `W2C MSG READ ${randomUUID()}`]
    )).rows[0].id;
    await client.query("INSERT INTO workspace_role_permissions(role_id,permission_key) VALUES($1,'conversations.read')", [readRoleId]);
    await client.query(
      "INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())",
      [tenantA, readA, readRoleId]
    );
    await createUser(tenantB, "OWNER");

    swOk = (await client.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,channel,status) VALUES($1,'whatsapp','connected') RETURNING id", [tenantA]
    )).rows[0].id;
    swThr = (await client.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,channel,status) VALUES($1,'whatsapp','connected') RETURNING id", [tenantA]
    )).rows[0].id;
    swPending = (await client.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,channel,status) VALUES($1,'whatsapp','qr_pending') RETURNING id", [tenantA]
    )).rows[0].id;
    si = (await client.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,channel,status) VALUES($1,'instagram','connected') RETURNING id", [tenantA]
    )).rows[0].id;
    foreignSessionB = (await client.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,channel,status) VALUES($1,'whatsapp','connected') RETURNING id", [tenantB]
    )).rows[0].id;
    routerWhatsappSession = (await client.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,channel,status) VALUES($1,'whatsapp','connected') RETURNING id", [tenantR]
    )).rows[0].id;
    routerInstagramSession = (await client.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,channel,status) VALUES($1,'instagram','connected') RETURNING id", [tenantR]
    )).rows[0].id;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantA, tenantB, tenantR]]);
  await pool.query("DELETE FROM users WHERE email=ANY($1::text[])", [testEmails]);
  await app.close();
  await pool.end();
});

describe("GET /me/messaging-capabilities", () => {
  it("deriva flags por sessão do gateway e degrada sessão que lança; sessão Instagram não entra na lista", async () => {
    gateway.sessionMessagingCapabilities = vi.fn(async (sessionId: string) => {
      if (sessionId === swThr) throw new Error("provider offline");
      return { reactions: true, forward_media: false, interactive: true };
    });
    const response = await app.inject({
      url: "/me/messaging-capabilities",
      headers: { cookie: await cookieFor(ownerA, tenantA) }
    });
    expect(response.statusCode).toBe(200);
    const bySession = new Map(response.json().sessions.map((row: { session_id: string }) => [row.session_id, row]));
    expect(bySession.get(swOk)).toMatchObject({
      status: "connected",
      capabilities: { reactions: true, forward_media: false, interactive: true }
    });
    // Captura degradada: erro do provider NUNCA derruba o endpoint.
    expect(bySession.get(swThr)).toMatchObject({
      capabilities: { reactions: false, forward_media: false, interactive: false }
    });
    expect(bySession.get(swPending)).toMatchObject({ status: "qr_pending" });
    expect(bySession.get(si)).toBeUndefined(); // lista é só WhatsApp
  });

  it("sem o método opcional no gateway, todas as flags são false e a rota segue 200", async () => {
    gateway.sessionMessagingCapabilities = undefined;
    const response = await app.inject({
      url: "/me/messaging-capabilities",
      headers: { cookie: await cookieFor(ownerA, tenantA) }
    });
    expect(response.statusCode).toBe(200);
    for (const row of response.json().sessions as Array<{ session_id: string; capabilities: Record<string, boolean> }>) {
      expect(row.capabilities).toEqual({ reactions: false, forward_media: false, interactive: false });
    }
    expect((await app.inject({ url: "/me/messaging-capabilities" })).statusCode).toBe(401);
  });
});

describe("POST /conversations/initiate", () => {
  it("abre conversa outbound: 201, pausa IA, atribui operador, liga lead pelo trigger e grava mensagem humana", async () => {
    const phone = nextPhone();
    const lead = await seedLead(tenantA, phone, "Lead Outbound W2C");
    gateway.sendText = vi.fn().mockResolvedValue({ externalId: "wa-1" });

    const response = await initiate({
      cookie: await cookieFor(ownerA, tenantA),
      leadId: lead,
      sessionId: swOk,
      text: "Olá! Tudo bem?",
      idempotencyKey: `initiate-${randomUUID()}`
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({ lead_id: lead, sent: true, externalId: "wa-1", duplicate: false });
    initiatedConversationId = body.conversation_id;

    const conversation = (await pool.query<{
      ai_active: boolean; handoff_reason: string | null; assigned_user_id: string | null;
      lead_id: string; contact_phone: string; contact_name: string | null;
    }>(
      "SELECT ai_active,handoff_reason,assigned_user_id,lead_id,contact_phone,contact_name FROM conversations WHERE id=$1 AND tenant_id=$2",
      [body.conversation_id, tenantA]
    )).rows[0];
    expect(conversation).toMatchObject({
      ai_active: false,
      handoff_reason: "manually_paused",
      assigned_user_id: ownerA,
      lead_id: lead, // trigger conversations_link_lead casa o lead pelo telefone
      contact_phone: phone,
      contact_name: "Lead Outbound W2C"
    });
    expect(gateway.sendText).toHaveBeenCalledWith(swOk, phone, "Olá! Tudo bem?");
    const message = (await pool.query<{ sender: string; content: string; sent_by_user_id: string | null }>(
      "SELECT sender,content,sent_by_user_id FROM messages WHERE conversation_id=$1 AND external_message_id='wa-1'",
      [body.conversation_id]
    )).rows[0];
    expect(message).toMatchObject({ sender: "human", content: "Olá! Tudo bem?", sent_by_user_id: ownerA });
  });

  it("reusa a conversa existente (200) em vez de duplicar", async () => {
    gateway.sendText = vi.fn().mockResolvedValue({ externalId: "wa-2" });
    const response = await initiate({
      cookie: await cookieFor(ownerA, tenantA),
      leadId: (await pool.query<{ id: string }>("SELECT id FROM conversations WHERE id=$1", [initiatedConversationId])).rows[0].id
        ? (await pool.query<{ lead_id: string }>("SELECT lead_id FROM conversations WHERE id=$1", [initiatedConversationId])).rows[0].lead_id
        : "",
      sessionId: swOk,
      text: "Segunda mensagem",
      idempotencyKey: `initiate-${randomUUID()}`
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ conversation_id: initiatedConversationId, sent: true, duplicate: false });
    const phone = (await pool.query<{ contact_phone: string }>("SELECT contact_phone FROM conversations WHERE id=$1", [initiatedConversationId])).rows[0].contact_phone;
    expect(await conversationCount(tenantA, swOk, phone)).toBe(1);
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM messages WHERE conversation_id=$1", [initiatedConversationId]
    )).rows[0].count).toBe(2);
  });

  it("WhatsAppSendRejectedError vira 409 e apaga a conversa criada (delete compensatório)", async () => {
    const phone = nextPhone();
    const lead = await seedLead(tenantA, phone);
    gateway.sendText = vi.fn().mockRejectedValue(new WhatsAppSendRejectedError("Evolution recusou o envio para o número"));
    const response = await initiate({
      cookie: await cookieFor(ownerA, tenantA),
      leadId: lead,
      sessionId: swOk,
      idempotencyKey: `initiate-${randomUUID()}`
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("recusou o envio");
    expect(await conversationCount(tenantA, swOk, phone)).toBe(0);
  });

  it("erro puro do provider vira 502 e também apaga a conversa criada", async () => {
    const phone = nextPhone();
    const lead = await seedLead(tenantA, phone);
    gateway.sendText = vi.fn().mockRejectedValue(new Error("evolution indisponível"));
    const response = await initiate({
      cookie: await cookieFor(ownerA, tenantA),
      leadId: lead,
      sessionId: swOk,
      idempotencyKey: `initiate-${randomUUID()}`
    });
    expect(response.statusCode).toBe(502);
    expect(await conversationCount(tenantA, swOk, phone)).toBe(0);
  });

  it("falha em conversa pré-existente mantém a conversa e não grava mensagem", async () => {
    const phone = nextPhone();
    await seedLead(tenantA, phone, "Pré-existente W2C");
    const existingId = (await pool.query<{ id: string }>(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3) RETURNING id",
      [tenantA, swOk, phone]
    )).rows[0].id;
    gateway.sendText = vi.fn().mockRejectedValue(new Error("timeout do provider"));
    const response = await initiate({
      cookie: await cookieFor(ownerA, tenantA),
      leadId: (await pool.query<{ lead_id: string }>("SELECT lead_id FROM conversations WHERE id=$1", [existingId])).rows[0].lead_id,
      sessionId: swOk,
      idempotencyKey: `initiate-${randomUUID()}`
    });
    expect(response.statusCode).toBe(502);
    expect(await conversationCount(tenantA, swOk, phone)).toBe(1); // conversa mantida
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM messages WHERE conversation_id=$1", [existingId]
    )).rows[0].count).toBe(0);
  });

  it("401 sem sessão, 403 sem conversations.reply, 404 lead/sessão de outro tenant, 409 sessão desconectada, 400 sem idempotency-key", async () => {
    const leadA = (await pool.query<{ id: string }>(
      "SELECT id FROM scheduling_leads WHERE tenant_id=$1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1", [tenantA]
    )).rows[0].id;
    const leadB = await seedLead(tenantB, nextPhone());

    expect((await app.inject({
      method: "POST", url: "/conversations/initiate",
      payload: { lead_id: leadA, session_id: swOk, text: "oi" }
    })).statusCode).toBe(401);

    expect((await initiate({
      cookie: await cookieFor(readA, tenantA),
      leadId: leadA,
      sessionId: swOk,
      idempotencyKey: `initiate-${randomUUID()}`
    })).statusCode).toBe(403);

    const foreignLead = await initiate({
      cookie: await cookieFor(ownerA, tenantA),
      leadId: leadB,
      sessionId: swOk,
      idempotencyKey: `initiate-${randomUUID()}`
    });
    expect(foreignLead.statusCode).toBe(404);
    expect(foreignLead.json().error).toBe("Lead não encontrado");

    const foreignSession = await initiate({
      cookie: await cookieFor(ownerA, tenantA),
      leadId: leadA,
      sessionId: foreignSessionB,
      idempotencyKey: `initiate-${randomUUID()}`
    });
    expect(foreignSession.statusCode).toBe(404);
    expect(foreignSession.json().error).toBe("Conexão WhatsApp não encontrada");

    const disconnected = await initiate({
      cookie: await cookieFor(ownerA, tenantA),
      leadId: leadA,
      sessionId: swPending,
      idempotencyKey: `initiate-${randomUUID()}`
    });
    expect(disconnected.statusCode).toBe(409);
    expect(disconnected.json().error).toBe("A conexão do WhatsApp está desconectada");

    expect((await initiate({
      cookie: await cookieFor(ownerA, tenantA),
      leadId: leadA,
      sessionId: swOk
    })).statusCode).toBe(400); // Idempotency-Key é obrigatória
  });

  it("lead na lixeira não abre conversa (404)", async () => {
    const phone = nextPhone();
    const lead = await seedLead(tenantA, phone);
    await pool.query("UPDATE scheduling_leads SET deleted_at=now() WHERE id=$1", [lead]);
    const response = await initiate({
      cookie: await cookieFor(ownerA, tenantA),
      leadId: lead,
      sessionId: swOk,
      idempotencyKey: `initiate-${randomUUID()}`
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("Lead não encontrado");
  });
});

describe("ChannelGatewayRouter — roteamento por canal", () => {
  it("whatsapp delega ao gateway da sessão; instagram usa o runtime; capabilities derivam por canal", async () => {
    const fullWhatsapp = {
      sendText: vi.fn().mockResolvedValue({ externalId: "wa-router-1" }),
      sendPresence: vi.fn().mockResolvedValue(undefined),
      markMessageAsRead: vi.fn().mockResolvedValue(undefined),
      setPresence: vi.fn().mockResolvedValue(undefined),
      sendReaction: vi.fn().mockResolvedValue(undefined),
      sendReactionStrict: vi.fn().mockResolvedValue(undefined),
      sendMedia: vi.fn().mockResolvedValue({ externalId: "wa-media-1" }),
      downloadMedia: vi.fn().mockResolvedValue({ base64: "aGk=", mimeType: "image/png" }),
      sendInteractive: vi.fn().mockResolvedValue({ externalId: "wa-int-router" })
    };
    const instagramRuntime = {
      gateway: { sendText: vi.fn().mockResolvedValue({ outcome: "accepted" as const, externalId: "ig-router-1" }) }
    };
    const router = new ChannelGatewayRouter(pool, fullWhatsapp as never, instagramRuntime as never, config);

    expect(await router.sendText(routerWhatsappSession, "5511900000001", "oi")).toEqual({ externalId: "wa-router-1" });
    expect(fullWhatsapp.sendText).toHaveBeenCalledWith(routerWhatsappSession, "5511900000001", "oi", undefined);

    expect(await router.sendText(routerInstagramSession, "ig:usuario", "oi instagram")).toEqual({ externalId: "ig-router-1" });
    expect(instagramRuntime.gateway.sendText).toHaveBeenCalledWith({
      tenantId: tenantR,
      connectionId: routerInstagramSession,
      recipientId: "usuario",
      text: "oi instagram"
    });

    expect(await router.sendInteractive(routerWhatsappSession, "5511900000001", {
      kind: "buttons", buttons: [{ displayText: "Oi" }]
    })).toEqual({ externalId: "wa-int-router" });
    expect(fullWhatsapp.sendInteractive).toHaveBeenCalledWith(routerWhatsappSession, "5511900000001", {
      kind: "buttons", buttons: [{ displayText: "Oi" }]
    });

    expect(await router.sessionMessagingCapabilities(routerWhatsappSession))
      .toEqual({ reactions: true, forward_media: true, interactive: true });
    expect(await router.sessionMessagingCapabilities(routerInstagramSession))
      .toEqual({ reactions: false, forward_media: false, interactive: false });

    await expect(router.sendInteractive(routerInstagramSession, "ig:usuario", {
      kind: "buttons", buttons: [{ displayText: "Oi" }]
    })).rejects.toBeInstanceOf(ChannelOperationUnsupportedError);
    await expect(router.sendText(randomUUID(), "5511900000001", "oi")).rejects.toMatchObject({
      statusCode: 404,
      code: "CONNECTION_NOT_FOUND"
    });
  });

  it("gateway WhatsApp sem o método opcional → unsupported; capabilities derivadas refletem os métodos presentes", async () => {
    const bareWhatsapp = {
      sendText: vi.fn().mockResolvedValue({ externalId: "wa-bare-1" }),
      sendPresence: vi.fn().mockResolvedValue(undefined),
      markMessageAsRead: vi.fn().mockResolvedValue(undefined),
      setPresence: vi.fn().mockResolvedValue(undefined)
    };
    const router = new ChannelGatewayRouter(
      pool, bareWhatsapp as never, { gateway: { sendText: vi.fn() } } as never, config
    );
    await expect(router.sendInteractive(routerWhatsappSession, "5511900000001", {
      kind: "list", buttonText: "Escolher", sectionTitle: "Opções", rows: [{ title: "Linha 1" }]
    })).rejects.toBeInstanceOf(ChannelOperationUnsupportedError);
    await expect(router.sendReaction(routerWhatsappSession, "5511900000001", {
      remoteJid: "x@s.whatsapp.net", fromMe: false, id: "1"
    }, "👍")).rejects.toBeInstanceOf(ChannelOperationUnsupportedError);
    expect(await router.sessionMessagingCapabilities(routerWhatsappSession))
      .toEqual({ reactions: false, forward_media: false, interactive: false });
  });
});

describe("EvolutionClient.sendInteractive (C1-h)", () => {
  const clientConfig = {
    EVOLUTION_API_URL: "http://evolution.test",
    EVOLUTION_API_KEY: "api-key-with-enough-characters",
    EVOLUTION_WEBHOOK_URL: "https://backend.example",
    EVOLUTION_WEBHOOK_SECRET: "webhook-secret-with-enough-characters",
    EVOLUTION_TIMEOUT_MS: 15_000
  };

  it("buttons: POST /message/sendButtons mapeando reply e cta_url", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ key: { id: "evo-btn-1" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EvolutionClient(clientConfig);
    const result = await client.sendInteractive("inst", "5511999999999", {
      kind: "buttons",
      text: "Escolha uma opção:",
      buttons: [{ displayText: "Sim" }, { displayText: "Site", url: "https://exemplo.com" }]
    });
    expect(result).toEqual({ externalId: "evo-btn-1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("http://evolution.test/message/sendButtons/inst");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      number: "5511999999999",
      titleMessage: "Escolha uma opção:",
      buttons: [
        { buttonType: "reply", displayText: "Sim" },
        { buttonType: "url", displayText: "Site", url: "https://exemplo.com" }
      ]
    });
  });

  it("list: POST /message/sendList com buttonText/description/sections", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ key: { id: "evo-list-1" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EvolutionClient(clientConfig);
    const result = await client.sendInteractive("inst", "5511999999999@s.whatsapp.net", {
      kind: "list",
      text: "Menu",
      buttonText: "Escolher",
      sectionTitle: "Opções",
      rows: [{ title: "Linha 1", description: "Detalhe" }]
    });
    expect(result).toEqual({ externalId: "evo-list-1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("http://evolution.test/message/sendList/inst");
    expect(JSON.parse(String(init.body))).toEqual({
      number: "5511999999999",
      titleMessage: "Menu",
      buttonText: "Escolher",
      description: "Opções",
      sections: [{ title: "Opções", rows: [{ rowTitle: "Linha 1", rowDescription: "Detalhe" }] }]
    });
  });

  it("falha quando a Evolution não devolve id de mensagem", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    const client = new EvolutionClient(clientConfig);
    await expect(client.sendInteractive("inst", "5511999999999", {
      kind: "buttons", buttons: [{ displayText: "Oi" }]
    })).rejects.toThrow("did not return a message id");
  });
});

describe("WhatsAppSessionManager.sendInteractive (C1-h)", () => {
  it("delega ao EvolutionClient da instância com o payload estruturado; telefone em quarentena nunca chega ao provider", async () => {
    const spy = vi.spyOn(EvolutionClient.prototype, "sendInteractive").mockResolvedValue({ externalId: "evo-int-9" });
    const query = vi.fn().mockResolvedValue({ rows: [{ instance_name: "tenant-instance" }] });
    const manager = new WhatsAppSessionManager(
      { query } as unknown as Pool,
      { ...config, WHATSAPP_ENABLED: true },
      { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger
    );
    const payload = { kind: "buttons" as const, text: "A", buttons: [{ displayText: "B" }] };
    await expect(manager.sendInteractive("session-1", "5511999999999", payload))
      .resolves.toEqual({ externalId: "evo-int-9" });
    expect(spy).toHaveBeenCalledWith("tenant-instance", "5511999999999", payload);
    await expect(manager.sendInteractive("session-1", "999000000001@s.whatsapp.net", payload))
      .rejects.toThrow(/quarantined/i);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
