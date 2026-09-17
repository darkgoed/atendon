import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { InstagramRepository } from "../src/modules/instagram/repository.js";
import { MessageRepository } from "../src/modules/messages/repository.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const key = "instagram-ai-test-data-key-000000000001";
let tenantId = "";
let sessionId = "";
let accountId = "";
let contactId = "";
let conversationId = "";

beforeAll(async () => {
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`Instagram AI ${randomUUID()}`]
  )).rows[0].id;
  const instagram = new InstagramRepository(pool, key);
  accountId = `account-${randomUUID()}`;
  const connection = await instagram.saveConnection({
    tenantId,
    label: "Instagram",
    accountId,
    username: "empresa",
    accessToken: "token",
    expiresAt: new Date(Date.now() + 3_600_000)
  });
  sessionId = connection.id;
  contactId = `igsid-${randomUUID()}`;
  conversationId = (await instagram.persistEvent(tenantId, sessionId, {
    kind: "message",
    eventId: `message:${randomUUID()}`,
    accountId,
    providerUserId: contactId,
    timestamp: new Date(),
    text: "Olá pelo Instagram",
    isEcho: false,
    raw: {
      sender: { id: contactId }, recipient: { id: accountId },
      timestamp: Date.now(), message: { mid: `mid-${randomUUID()}`, text: "Olá pelo Instagram" }
    }
  }, Buffer.from("{}"))).conversationId!;
  await pool.query(
    "INSERT INTO agent_configs(tenant_id,session_id,system_prompt,ai_model,enabled_tools) VALUES($1,$2,'Atenda','test/model',$3::jsonb)",
    [tenantId, sessionId, JSON.stringify(["registrar_lead", "qualificar_lead", "pesquisar_contexto"])]
  );
});

afterAll(async () => {
  if (tenantId) await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.end();
});

describe("Instagram identity in the existing AI repository", () => {
  it("records an inbound against the foundation conversation without manufacturing a phone", async () => {
    const repository = new MessageRepository(pool, config, { followUp: async () => "enqueued" });
    const message = {
      channel: "instagram" as const,
      externalId: `ig-inbound-${randomUUID()}`,
      tenantId,
      sessionId,
      contactPhone: `ig:${contactId}`,
      instagramContactId: contactId,
      instagramUsername: "cliente_teste",
      contactName: "Cliente Instagram",
      text: "Quero conhecer o serviço"
    };

    const context = await repository.recordInboundAndLoadContext(message, { claim: false });
    expect(context).toMatchObject({
      conversationId,
      channel: "instagram",
      contactIdentifier: `@cliente_teste`
    });
    expect(context?.enabledToolNames).not.toContain("registrar_lead");

    await repository.recordInboundAndLoadContext(message, { claim: false });
    const state = (await pool.query<{
      contact_phone: string | null;
      instagram_contact_id: string;
      instagram_username: string | null;
      message_count: number;
      lead_phone: string | null;
      automatic_events: number;
    }>(
      `SELECT c.contact_phone,c.instagram_contact_id,c.instagram_username,
              count(DISTINCT m.id)::int message_count,
              lead.phone lead_phone,count(DISTINCT event.id)::int automatic_events
       FROM conversations c
       JOIN scheduling_leads lead ON lead.id=c.lead_id AND lead.tenant_id=c.tenant_id
       LEFT JOIN messages m ON m.conversation_id=c.id AND m.external_message_id=$2
       LEFT JOIN scheduling_lead_events event ON event.lead_id=lead.id
       WHERE c.id=$1
       GROUP BY c.contact_phone,c.instagram_contact_id,c.instagram_username,lead.phone`,
      [conversationId, message.externalId]
    )).rows[0];
    expect(state).toEqual({
      contact_phone: null,
      instagram_contact_id: contactId,
      instagram_username: "cliente_teste",
      message_count: 1,
      lead_phone: null,
      automatic_events: 0
    });
  });

  it("records an external business echo as human once and pauses AI without a loop", async () => {
    const repository = new MessageRepository(pool, config, { followUp: async () => "enqueued" });
    const echo = {
      kind: "human" as const,
      channel: "instagram" as const,
      externalId: `echo-${randomUUID()}`,
      tenantId,
      sessionId,
      contactPhone: `ig:${contactId}`,
      instagramContactId: contactId,
      text: "Resposta enviada no app Instagram"
    };

    await expect(repository.recordHuman(echo)).resolves.toBe("recorded");
    await expect(repository.recordHuman(echo)).resolves.toBe("duplicate");
    const rows = await pool.query<{ sender: string; ai_active: boolean }>(
      `SELECT m.sender,c.ai_active FROM messages m JOIN conversations c ON c.id=m.conversation_id
       WHERE m.external_message_id=$1`,
      [echo.externalId]
    );
    expect(rows.rows).toEqual([{ sender: "human", ai_active: false }]);
  });

  // Regressão de produção: um eco humano (dono da conta respondendo pelo
  // app nativo do Instagram) pode ser o PRIMEIRO evento de um contato que
  // nunca mandou DM pelo AtendON — sem conversa pré-existente para casar.
  // Antes disto, recordInstagramHuman fazia só UPDATE, afetava 0 linhas e
  // lançava "Instagram conversation does not belong to tenant and
  // connection" em retry infinito (>10000 tentativas observadas em
  // produção). Deve criar a conversa em vez de lançar.
  it("creates the conversation on a human echo when the contact never messaged in before", async () => {
    const repository = new MessageRepository(pool, config, { followUp: async () => "enqueued" });
    const freshContactId = `igsid-${randomUUID()}`;
    const echo = {
      kind: "human" as const,
      channel: "instagram" as const,
      externalId: `echo-fresh-${randomUUID()}`,
      tenantId,
      sessionId,
      contactPhone: `ig:${freshContactId}`,
      instagramContactId: freshContactId,
      text: "Oi, respondendo direto pelo Instagram"
    };

    await expect(repository.recordHuman(echo)).resolves.toBe("recorded");
    const rows = await pool.query<{ sender: string; ai_active: boolean; instagram_contact_id: string }>(
      `SELECT m.sender,c.ai_active,c.instagram_contact_id FROM messages m
       JOIN conversations c ON c.id=m.conversation_id
       WHERE m.external_message_id=$1`,
      [echo.externalId]
    );
    expect(rows.rows).toEqual([{ sender: "human", ai_active: false, instagram_contact_id: freshContactId }]);
  });
});
