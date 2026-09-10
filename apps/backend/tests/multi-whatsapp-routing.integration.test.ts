import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { MessageRepository } from "../src/modules/messages/repository.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
let tenantId: string;
let firstSessionId: string;
let secondSessionId: string;

beforeAll(async () => {
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`Multi routing ${randomUUID()}`]
  )).rows[0].id;
  const sessions = await pool.query<{ id: string }>(
    `INSERT INTO whatsapp_sessions(tenant_id,label,is_primary)
     VALUES($1,'Comercial',true),($1,'Suporte',false)
     RETURNING id`,
    [tenantId]
  );
  [firstSessionId, secondSessionId] = sessions.rows.map((row) => row.id);
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.end();
});

describe("roteamento de conversas por conexão", () => {
  it("isola mensagens do mesmo contato em conversas de conexões diferentes", async () => {
    const phone = `551197${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
    const repository = new MessageRepository(pool);

    await repository.recordInboundAndLoadContext({
      externalId: `multi-a-${randomUUID()}`,
      tenantId,
      sessionId: firstSessionId,
      contactPhone: phone,
      text: "Mensagem para o Comercial"
    });
    await repository.recordInboundAndLoadContext({
      externalId: `multi-b-${randomUUID()}`,
      tenantId,
      sessionId: secondSessionId,
      contactPhone: phone,
      text: "Mensagem para o Suporte"
    });

    const conversations = await pool.query<{
      session_id: string;
      contents: string[];
    }>(
      `SELECT conversation.session_id,
              array_agg(message.content ORDER BY message.created_at, message.id) contents
       FROM conversations conversation
       JOIN messages message ON message.conversation_id=conversation.id
       WHERE conversation.tenant_id=$1 AND conversation.contact_phone=$2
       GROUP BY conversation.id,conversation.session_id
       ORDER BY conversation.session_id`,
      [tenantId, phone]
    );

    expect(conversations.rows).toHaveLength(2);
    expect(new Map(conversations.rows.map((row) => [row.session_id, row.contents]))).toEqual(new Map([
      [firstSessionId, ["Mensagem para o Comercial"]],
      [secondSessionId, ["Mensagem para o Suporte"]]
    ]));
  });
});
