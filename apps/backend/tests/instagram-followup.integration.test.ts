import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { InstagramRepository } from "../src/modules/instagram/repository.js";
import { AiFollowUpRepository } from "../src/modules/messages/ai-follow-up.js";
import { MessageRepository } from "../src/modules/messages/repository.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const key = "instagram-followup-key-0000000000000001";
let tenantId = "";
let sessionId = "";
let accountId = "";
let contactId = "";
let conversationId = "";

beforeAll(async () => {
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`Instagram follow-up ${randomUUID()}`]
  )).rows[0].id;
  const instagram = new InstagramRepository(pool, key);
  accountId = `account-${randomUUID()}`;
  sessionId = (await instagram.saveConnection({
    tenantId, label: "Instagram", accountId, accessToken: "token",
    expiresAt: new Date(Date.now() + 3_600_000)
  })).id;
  contactId = `igsid-${randomUUID()}`;
  conversationId = (await instagram.persistEvent(tenantId, sessionId, {
    kind: "message", eventId: `seed:${randomUUID()}`, accountId, providerUserId: contactId,
    timestamp: new Date(), text: "Olá", isEcho: false,
    raw: { sender: { id: contactId }, recipient: { id: accountId }, timestamp: Date.now(), message: { mid: `seed-${randomUUID()}`, text: "Olá" } }
  }, Buffer.from("{}"))).conversationId!;
  await pool.query(
    "INSERT INTO agent_configs(tenant_id,session_id,system_prompt,ai_model) VALUES($1,$2,'Atenda','test/model')",
    [tenantId, sessionId]
  );
  await pool.query(
    `UPDATE tenant_ai_settings SET ai_follow_up_enabled=true,
       ai_follow_up_delays_minutes=ARRAY[1,2]::integer[],ai_follow_up_max_count=2
     WHERE tenant_id=$1`,
    [tenantId]
  );
});

afterAll(async () => {
  if (tenantId) await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.end();
});

describe("Instagram follow-up window policy", () => {
  it("schedules and claims by scoped identity, then cancels an expired or ambiguous send", async () => {
    const messages = new MessageRepository(pool, config, { followUp: async () => "enqueued" });
    const followUps = new AiFollowUpRepository(pool, config);
    const inboundExternalId = `inbound-${randomUUID()}`;
    await messages.recordInboundAndLoadContext({
      channel: "instagram", tenantId, sessionId, contactPhone: `ig:${contactId}`,
      instagramContactId: contactId, externalId: inboundExternalId, text: "Pode me lembrar?"
    }, { claim: false });
    await messages.recordAgentReply({
      tenantId, sessionId, conversationId, text: "Claro, volto a falar com você.",
      model: "test/model", externalId: `agent-${randomUUID()}`, inboundExternalId
    });
    await pool.query("UPDATE ai_follow_up_schedules SET next_run_at=now()-interval '1 second' WHERE conversation_id=$1", [conversationId]);

    const claim = await followUps.claimDue(conversationId);
    expect(claim).toMatchObject({
      channel: "instagram",
      contactPhone: `ig:${contactId}`,
      instagramContactId: contactId
    });
    await followUps.recordAmbiguousDelivery(claim!, new Error("provider timeout after write"));
    expect((await pool.query(
      "SELECT status,cancellation_reason,next_run_at FROM ai_follow_up_schedules WHERE conversation_id=$1",
      [conversationId]
    )).rows[0]).toEqual({ status: "cancelled", cancellation_reason: "delivery_ambiguous", next_run_at: null });

    const secondInbound = `inbound-${randomUUID()}`;
    await messages.recordInboundAndLoadContext({
      channel: "instagram", tenantId, sessionId, contactPhone: `ig:${contactId}`,
      instagramContactId: contactId, externalId: secondInbound, text: "Mais uma pergunta"
    }, { claim: false });
    await messages.recordAgentReply({
      tenantId, sessionId, conversationId, text: "Posso ajudar.", model: "test/model",
      externalId: `agent-${randomUUID()}`, inboundExternalId: secondInbound
    });
    await pool.query(
      "UPDATE conversations SET messaging_window_expires_at=now()-interval '1 second' WHERE id=$1",
      [conversationId]
    );
    await pool.query(
      "UPDATE ai_follow_up_schedules SET next_run_at=now()-interval '1 second' WHERE conversation_id=$1",
      [conversationId]
    );
    await expect(followUps.claimDue(conversationId)).resolves.toBeNull();
    expect((await pool.query(
      "SELECT status,cancellation_reason FROM ai_follow_up_schedules WHERE conversation_id=$1",
      [conversationId]
    )).rows[0]).toEqual({ status: "cancelled", cancellation_reason: "window_expired" });
  });

  it("does not schedule a follow-up whose due time is outside the Instagram 24h window", async () => {
    await pool.query(
      "UPDATE tenant_ai_settings SET ai_follow_up_delays_minutes=ARRAY[1500]::integer[] WHERE tenant_id=$1",
      [tenantId]
    );
    await pool.query(
      "UPDATE conversations SET messaging_window_expires_at=now()+interval '24 hours' WHERE id=$1",
      [conversationId]
    );
    const inboundExternalId = `late-inbound-${randomUUID()}`;
    const messages = new MessageRepository(pool, config, { followUp: async () => "enqueued" });
    await messages.recordInboundAndLoadContext({
      channel: "instagram", tenantId, sessionId, contactPhone: `ig:${contactId}`,
      instagramContactId: contactId, externalId: inboundExternalId, text: "Depois"
    }, { claim: false });
    await messages.recordAgentReply({
      tenantId, sessionId, conversationId, text: "Até mais.", model: "test/model",
      externalId: `late-agent-${randomUUID()}`, inboundExternalId
    });
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM ai_follow_up_schedules WHERE conversation_id=$1 AND status='scheduled'",
      [conversationId]
    )).rows[0].count).toBe(0);
  });
});
