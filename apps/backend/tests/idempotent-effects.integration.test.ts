import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { parseIdempotencyKey, payloadFingerprint } from "../src/modules/messages/idempotency.js";
import { MessageRepository, type ToolCallJournalInput } from "../src/modules/messages/repository.js";
import { WhatsAppSendRejectedError } from "../src/modules/whatsapp/errors.js";
import { isFeatureFlagEnabled } from "../src/modules/operations/feature-flags.js";
import { MeetingContactDeliveryRepository } from "../src/modules/scheduling/meeting-contact-delivery.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const repository = new MessageRepository(pool);
let tenantA = "";
let tenantB = "";
let sessionA = "";
let sessionB = "";
let conversationA = "";
let conversationB = "";
let agentVersionA = "";
let userA = "";
let userB = "";
let phoneSequence = Number(Date.now().toString().slice(-8));
const nextPhone = () => `5511${String(++phoneSequence).slice(-8).padStart(8, "0")}`;

beforeAll(async () => {
  const tenants = await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active'),($2,'active') RETURNING id",
    [`Idempotency A ${randomUUID()}`, `Idempotency B ${randomUUID()}`]
  );
  [tenantA, tenantB] = tenants.rows.map((row) => row.id);
  const firstSession = await pool.query<{ id: string }>(
    "INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id",
    [tenantA]
  );
  const secondSession = await pool.query<{ id: string }>(
    "INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id",
    [tenantB]
  );
  sessionA = firstSession.rows[0].id;
  sessionB = secondSession.rows[0].id;
  conversationA = (await pool.query<{ id: string }>(
    "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3) RETURNING id",
    [tenantA, sessionA, "5511900010101"]
  )).rows[0].id;
  conversationB = (await pool.query<{ id: string }>(
    "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3) RETURNING id",
    [tenantB, sessionB, "5511900010102"]
  )).rows[0].id;
  const agentA = (await pool.query<{ id: string }>(
    `INSERT INTO agent_configs(tenant_id,system_prompt,ai_model)
     VALUES($1,'Atenda com segurança','model/test') RETURNING id`,
    [tenantA]
  )).rows[0];
  agentVersionA = (await pool.query<{ active_version_id: string }>(
    "SELECT active_version_id FROM agent_configs WHERE id=$1",
    [agentA.id]
  )).rows[0].active_version_id;
  const users = await pool.query<{ id: string }>(
    "INSERT INTO users(email,status,name) VALUES($1,'active','Atendente A'),($2,'active','Atendente B') RETURNING id",
    [`idempotency-a-${randomUUID()}@test.local`, `idempotency-b-${randomUUID()}@test.local`]
  );
  [userA, userB] = users.rows.map((row) => row.id);
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantA, tenantB]]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[userA, userB]]);
  await pool.end();
});

describe("manual outbound idempotency key validation", () => {
  it("requires a normalized key with a safe format", () => {
    expect(() => parseIdempotencyKey(undefined)).toThrow();
    expect(() => parseIdempotencyKey("short")).toThrow();
    expect(() => parseIdempotencyKey("invalid key with spaces")).toThrow();
    expect(parseIdempotencyKey("  request:manual-123  ")).toBe("request:manual-123");
  });
});

describe("persistent idempotency for outbound effects", () => {
  it("uses the shared active version for a fallback on a connection without an override", async () => {
    const overrideSession = (await pool.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id", [tenantA]
    )).rows[0].id;
    const override = (await pool.query<{ id: string }>(
      `INSERT INTO agent_configs(tenant_id,session_id,system_prompt,ai_model)
       VALUES($1,$2,'override','model/override') RETURNING id`, [tenantA, overrideSession]
    )).rows[0].id;
    const overrideVersion = (await pool.query<{ active_version_id: string }>(
      "SELECT active_version_id FROM agent_configs WHERE id=$1", [override]
    )).rows[0].active_version_id;

    await repository.recordFallback({
      tenantId: tenantA, sessionId: sessionA, conversationId: conversationA,
      mediaType: "image", text: "fallback", externalId: `fallback-${randomUUID()}`
    });
    const recorded = await pool.query<{ agent_config_version_id: string }>(
      "SELECT agent_config_version_id FROM messages WHERE conversation_id=$1 AND content='fallback' ORDER BY created_at DESC LIMIT 1",
      [conversationA]
    );
    expect(recorded.rows[0].agent_config_version_id).toBe(agentVersionA);
    expect(recorded.rows[0].agent_config_version_id).not.toBe(overrideVersion);
  });

  it("sends once under concurrency and replays the same external id", async () => {
    const key = `manual-${randomUUID()}`;
    const send = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { externalId: `wamid-${randomUUID()}` };
    });
    const sentByUserId = userA;
    const input = {
      tenantId: tenantA, conversationId: conversationA, sessionId: sessionA,
      contactPhone: "5511900010101", text: "Mensagem manual idempotente", idempotencyKey: key,
      sentByUserId
    };

    const first = repository.sendManualMessageOnce(input, send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const second = repository.sendManualMessageOnce({ ...input, idempotencyKey: key }, send);
    const results = await Promise.all([first, second]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(results[0].externalId).toBe(results[1].externalId);
    expect(results.map((result) => result.duplicate).sort()).toEqual([false, true]);
    const replay = await new MessageRepository(pool).sendManualMessageOnce({ ...input, idempotencyKey: key }, send);
    expect(replay).toEqual({ externalId: results[0].externalId, duplicate: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT id FROM messages WHERE conversation_id=$1 AND external_message_id=$2", [conversationA, results[0].externalId])).rowCount).toBe(1);
  });

  it("rejects key reuse with another payload but scopes the same key by tenant", async () => {
    const key = `scoped-${randomUUID()}`;
    const firstSend = vi.fn().mockResolvedValue({ externalId: `wamid-a-${randomUUID()}` });
    await repository.sendManualMessageOnce({
      tenantId: tenantA, conversationId: conversationA, sessionId: sessionA,
      contactPhone: "5511900010101", text: "Conteúdo A", idempotencyKey: key,
      sentByUserId: userA
    }, firstSend);
    await expect(repository.sendManualMessageOnce({
      tenantId: tenantA, conversationId: conversationA, sessionId: sessionA,
      contactPhone: "5511900010101", text: "Conteúdo diferente", idempotencyKey: key,
      sentByUserId: userA
    }, firstSend)).rejects.toThrow("outro conteúdo");

    const secondSend = vi.fn().mockResolvedValue({ externalId: `wamid-b-${randomUUID()}` });
    await expect(repository.sendManualMessageOnce({
      tenantId: tenantB, conversationId: conversationB, sessionId: sessionB,
      contactPhone: "5511900010102", text: "Conteúdo B", idempotencyKey: key,
      sentByUserId: userB
    }, secondSend)).resolves.toMatchObject({ duplicate: false });
    expect(secondSend).toHaveBeenCalledOnce();
  });

  it("does not retry stale or failed outbound reservations automatically", async () => {
    const staleKey = `stale-${randomUUID()}`;
    const text = "Envio de estado desconhecido";
    await pool.query(
      `INSERT INTO outbound_message_requests
         (tenant_id,conversation_id,idempotency_key,request_hash,processing_started_at)
       VALUES($1,$2,$3,$4,now()-interval '6 minutes')`,
      [tenantA, conversationA, staleKey, payloadFingerprint({ conversationId: conversationA, text })]
    );
    const send = vi.fn().mockResolvedValue({ externalId: "must-not-send" });
    await expect(repository.sendManualMessageOnce({
      tenantId: tenantA, conversationId: conversationA, sessionId: sessionA,
      contactPhone: "5511900010101", text, idempotencyKey: staleKey,
      sentByUserId: userA
    }, send)).rejects.toThrow("expirada");
    await expect(repository.sendManualMessageOnce({
      tenantId: tenantA, conversationId: conversationA, sessionId: sessionA,
      contactPhone: "5511900010101", text, idempotencyKey: staleKey,
      sentByUserId: userA
    }, send)).rejects.toThrow("Envio anterior falhou");
    expect(send).not.toHaveBeenCalled();
  });

  it("marks a send exception ambiguous and never offers it to automatic recovery", async () => {
    const key = `ambiguous-${randomUUID()}`;
    const send = vi.fn().mockRejectedValue(new Error("provider timeout"));
    await expect(repository.sendManualMessageOnce({
      tenantId: tenantA, conversationId: conversationA, sessionId: sessionA,
      contactPhone: "5511900010101", text: "Pode ter enviado", idempotencyKey: key,
      sentByUserId: userA
    }, send)).rejects.toThrow("provider timeout");
    expect((await pool.query<{ status: string }>(
      "SELECT status FROM outbound_message_requests WHERE tenant_id=$1 AND idempotency_key=$2", [tenantA, key]
    )).rows[0].status).toBe("ambiguous");
    const retry = vi.fn().mockResolvedValue({ externalId: "must-not-send" });
    await expect(repository.recoverFailedManualMessages(tenantA, retry)).resolves.toMatchObject({ sent: 0 });
    expect(retry).not.toHaveBeenCalled();
  });

  it("marks an explicitly rejected send as failed and offers it to recovery", async () => {
    const key = `rejected-${randomUUID()}`;
    const send = vi.fn().mockRejectedValue(new WhatsAppSendRejectedError("Connection Closed"));
    await expect(repository.sendManualMessageOnce({
      tenantId: tenantA, conversationId: conversationA, sessionId: sessionA,
      contactPhone: "5511900010101", text: "Pode recuperar", idempotencyKey: key,
      sentByUserId: userA
    }, send)).rejects.toThrow("Connection Closed");
    expect((await pool.query<{ status: string }>(
      "SELECT status FROM outbound_message_requests WHERE tenant_id=$1 AND idempotency_key=$2", [tenantA, key]
    )).rows[0].status).toBe("failed");
  });

  it("does not recover failed manual messages from an Instagram connection", async () => {
    const instagramContactId = `igsid-${randomUUID()}`;
    const instagramSession = (await pool.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,status,channel,is_primary,phone_number) VALUES($1,'connected','instagram',false,NULL) RETURNING id", [tenantA]
    )).rows[0].id;
    const instagramLead = (await pool.query<{ id: string }>(
      `INSERT INTO scheduling_leads(
         tenant_id,phone,name,source,instagram_contact_id,instagram_username,instagram_session_id
       ) VALUES($1,NULL,'Contato Instagram','instagram',$2,'cliente_teste',$3) RETURNING id`,
      [tenantA, instagramContactId, instagramSession]
    )).rows[0].id;
    const instagramConversation = (await pool.query<{ id: string }>(
      `INSERT INTO conversations(
         tenant_id,session_id,contact_phone,contact_name,instagram_contact_id,instagram_username,lead_id
       ) VALUES($1,$2,NULL,'Contato Instagram',$3,'cliente_teste',$4) RETURNING id`,
      [tenantA, instagramSession, instagramContactId, instagramLead]
    )).rows[0].id;
    await pool.query(
      `INSERT INTO outbound_message_requests(tenant_id,conversation_id,idempotency_key,request_hash,status,recovery_payload)
       VALUES($1,$2,$3,$4,'failed',$5::jsonb)`,
      [tenantA, instagramConversation, `instagram-${randomUUID()}`, "hash-instagram", JSON.stringify({ sendText: "não enviar", displayText: "não enviar", sentByUserId: userA })]
    );
    const retry = vi.fn().mockResolvedValue({ externalId: "must-not-send" });
    await repository.recoverFailedManualMessages(tenantA, retry);
    expect(retry).not.toHaveBeenCalledWith(expect.objectContaining({ text: "não enviar" }));
    expect((await pool.query<{ status: string }>(
      "SELECT status FROM outbound_message_requests WHERE conversation_id=$1", [instagramConversation]
    )).rows[0].status).toBe("failed");
    expect((await pool.query(
      "SELECT id FROM messages WHERE conversation_id=$1",
      [instagramConversation]
    )).rowCount).toBe(0);
    await pool.query("DELETE FROM outbound_message_requests WHERE conversation_id=$1", [instagramConversation]);
    await pool.query("DELETE FROM conversations WHERE id=$1", [instagramConversation]);
    await pool.query("DELETE FROM scheduling_leads WHERE id=$1", [instagramLead]);
    await pool.query("DELETE FROM whatsapp_sessions WHERE id=$1", [instagramSession]);
  });

  it("stops polling a fresh in-flight reservation within a bounded time", async () => {
    const key = `pending-${randomUUID()}`;
    const text = "Ainda processando";
    await pool.query(
      `INSERT INTO outbound_message_requests(tenant_id,conversation_id,idempotency_key,request_hash)
       VALUES($1,$2,$3,$4)`,
      [tenantA, conversationA, key, payloadFingerprint({ conversationId: conversationA, text })]
    );
    const startedAt = Date.now();
    await expect(repository.sendManualMessageOnce({
      tenantId: tenantA, conversationId: conversationA, sessionId: sessionA,
      contactPhone: "5511900010101", text, idempotencyKey: key,
      sentByUserId: userA
    }, vi.fn())).rejects.toThrow("ainda está em andamento");
    expect(Date.now() - startedAt).toBeLessThan(3_500);
  });
});

describe("persistent tool-call journal", () => {
  const journalInput = (suffix: string): ToolCallJournalInput => ({
    tenantId: tenantA,
    conversationId: conversationA,
    inboundExternalId: `inbound-${suffix}-${randomUUID()}`,
    aiTurnId: randomUUID(),
    callOrdinal: 0,
    providerCallId: `provider-${randomUUID()}`,
    toolName: "registrar_lead",
    argumentsJson: JSON.stringify({ nome: "Arthur Müller", status: "em_atendimento" })
  });

  it("executes a concurrent tool call once and preserves its previous result", async () => {
    const input = journalInput("concurrent");
    const effect = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return JSON.stringify({ lead: { id: randomUUID(), status: "em_atendimento" } });
    });
    const first = repository.executeToolCallOnce(input, effect);
    await vi.waitFor(() => expect(effect).toHaveBeenCalledTimes(1));
    const second = repository.executeToolCallOnce({ ...input, providerCallId: `retry-${randomUUID()}` }, effect);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(effect).toHaveBeenCalledTimes(1);
    expect(secondResult).toBe(firstResult);
    expect(await new MessageRepository(pool).executeToolCallOnce(input, effect)).toBe(firstResult);
    expect(effect).toHaveBeenCalledTimes(1);

    const otherTenantEffect = vi.fn().mockResolvedValue(JSON.stringify({ lead: { id: randomUUID() } }));
    await expect(repository.executeToolCallOnce({
      ...input,
      tenantId: tenantB,
      conversationId: conversationB
    }, otherTenantEffect)).resolves.toContain("lead");
    expect(otherTenantEffect).toHaveBeenCalledOnce();
  });

  it("rejects a changed operation at the same stable ordinal", async () => {
    const input = journalInput("collision");
    await repository.executeToolCallOnce(input, async () => JSON.stringify({ ok: true }));
    await expect(repository.executeToolCallOnce({ ...input, argumentsJson: JSON.stringify({ nome: "Outro lead" }) }, async () => "never"))
      .rejects.toThrow("outra operação");
  });

  it("allows a manual AI turn to use a new operation for the same inbound ordinal", async () => {
    const input = journalInput("manual-turn");
    const firstEffect = vi.fn().mockResolvedValue(JSON.stringify({ ok: "first" }));
    const secondEffect = vi.fn().mockResolvedValue(JSON.stringify({ ok: "manual" }));

    await repository.executeToolCallOnce(input, firstEffect);
    await expect(repository.executeToolCallOnce({
      ...input,
      aiTurnId: randomUUID(),
      toolName: "qualificar_lead",
      argumentsJson: JSON.stringify({ estrelas: 5 })
    }, secondEffect)).resolves.toContain("manual");

    expect(firstEffect).toHaveBeenCalledOnce();
    expect(secondEffect).toHaveBeenCalledOnce();
  });

  it("marks an abandoned tool reservation failed without executing it again", async () => {
    const input = journalInput("stale");
    const hash = payloadFingerprint({ tool: input.toolName, arguments: JSON.parse(input.argumentsJson) });
    await pool.query(
      `INSERT INTO ai_tool_call_journal
         (tenant_id,conversation_id,inbound_external_id,ai_turn_id,call_ordinal,provider_call_id,tool_name,arguments_hash,processing_started_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()-interval '6 minutes')`,
      [input.tenantId, input.conversationId, input.inboundExternalId, input.aiTurnId, input.callOrdinal,
        input.providerCallId, input.toolName, hash]
    );
    const effect = vi.fn().mockResolvedValue("never");
    await expect(repository.executeToolCallOnce(input, effect)).rejects.toThrow("expirada");
    await expect(repository.executeToolCallOnce(input, effect)).rejects.toThrow("requer reconciliação");
    expect(effect).not.toHaveBeenCalled();
  });

  it.each([
    ["error envelope", async () => JSON.stringify({ erro: "timeout para ana@example.com" })],
    ["thrown error", async () => {
      throw new Error("timeout com token secret=abcdefghijklmnop");
    }]
  ])("persists %s as failed instead of completed", async (_label, effect) => {
    const input = journalInput(`failed-${randomUUID()}`);
    await expect(repository.executeToolCallOnce(input, effect)).rejects.toThrow();
    const row = (await pool.query<{
      status: string;
      error_message: string;
    }>(
      `SELECT status,error_message FROM ai_tool_call_journal
       WHERE tenant_id=$1 AND inbound_external_id=$2 AND call_ordinal=$3`,
      [input.tenantId, input.inboundExternalId, input.callOrdinal]
    )).rows[0];
    expect(row.status).toBe("failed");
    expect(row.error_message).not.toContain("ana@example.com");
    expect(row.error_message).not.toContain("abcdefghijklmnop");
  });

  it("persists reply claims atomically and idempotently against the same journal", async () => {
    const input: ToolCallJournalInput = {
      ...journalInput(`claim-${randomUUID()}`),
      toolName: "agendar_reuniao",
      argumentsJson: JSON.stringify({ agenda_id: "reunioes", start: "2030-01-07T12:00:00.000Z" })
    };
    const journal = await repository.executeToolCallOnceDetailed(input, async () => JSON.stringify({
      agendamento: { status: "confirmado" }
    }));
    expect(journal.status).toBe("succeeded");
    const externalId = `reply-${randomUUID()}`;
    const reply = {
      tenantId: tenantA,
      sessionId: sessionA,
      conversationId: conversationA,
      agentConfigVersionId: agentVersionA,
      text: "A reunião foi agendada.",
      model: "model/test",
      externalId,
      inboundExternalId: input.inboundExternalId,
      transactionClaims: [{
        journalId: journal.journalId,
        action: "schedule_meeting" as const,
        claimType: "transaction_status" as const,
        normalizedValue: "succeeded"
      }]
    };

    await repository.recordAgentReply(reply);
    await repository.recordAgentReply(reply);

    expect((await pool.query(
      "SELECT id FROM messages WHERE provider_message_key=$1",
      [`${tenantA}:${sessionA}:${externalId}`]
    )).rowCount).toBe(1);
    expect((await pool.query(
      `SELECT claim.id
       FROM agent_message_transaction_claims claim
       JOIN ai_tool_call_journal journal
         ON journal.id=claim.journal_id
        AND journal.tenant_id=claim.tenant_id
        AND journal.conversation_id=claim.conversation_id
       WHERE claim.tenant_id=$1 AND claim.conversation_id=$2`,
      [tenantA, conversationA]
    )).rowCount).toBe(1);
  });

  it("keeps claim evidence immutable on divergent repository replay and direct UPDATE", async () => {
    const input: ToolCallJournalInput = {
      ...journalInput(`immutable-claim-${randomUUID()}`),
      toolName: "agendar_reuniao",
      argumentsJson: JSON.stringify({ agenda_id: "reunioes", start: "2030-01-07T12:00:00.000Z" })
    };
    const journal = await repository.executeToolCallOnceDetailed(input, async () => JSON.stringify({
      agendamento: { status: "confirmado" }
    }));
    const externalId = `immutable-reply-${randomUUID()}`;
    const reply = {
      tenantId: tenantA,
      sessionId: sessionA,
      conversationId: conversationA,
      agentConfigVersionId: agentVersionA,
      text: "A reunião foi agendada.",
      model: "model/test",
      externalId,
      inboundExternalId: input.inboundExternalId,
      transactionClaims: [{
        journalId: journal.journalId,
        action: "schedule_meeting" as const,
        claimType: "transaction_status" as const,
        normalizedValue: "succeeded"
      }]
    };

    await repository.recordAgentReply(reply);
    await expect(repository.recordAgentReply({
      ...reply,
      transactionClaims: [{
        ...reply.transactionClaims[0],
        normalizedValue: "pending"
      }]
    })).rejects.toThrow("conflicts with immutable evidence");

    const persisted = (await pool.query<{
      id: string;
      normalized_value: string;
      value_hash: string;
    }>(
      `SELECT id,normalized_value,value_hash
       FROM agent_message_transaction_claims
       WHERE tenant_id=$1 AND conversation_id=$2 AND journal_id=$3`,
      [tenantA, conversationA, journal.journalId]
    )).rows[0];
    expect(persisted.normalized_value).toBe("succeeded");

    await expect(pool.query(
      `UPDATE agent_message_transaction_claims
       SET normalized_value='pending',value_hash=repeat('0',64)
       WHERE id=$1`,
      [persisted.id]
    )).rejects.toThrow("immutable");
    expect((await pool.query<{
      normalized_value: string;
      value_hash: string;
    }>(
      `SELECT normalized_value,value_hash
       FROM agent_message_transaction_claims WHERE id=$1`,
      [persisted.id]
    )).rows[0]).toEqual({
      normalized_value: "succeeded",
      value_hash: persisted.value_hash
    });
  });

  it("rolls back the reply when a claim action does not match its journal", async () => {
    const input: ToolCallJournalInput = {
      ...journalInput(`mismatch-${randomUUID()}`),
      toolName: "agendar_reuniao",
      argumentsJson: JSON.stringify({ agenda_id: "reunioes", start: "2030-01-07T12:00:00.000Z" })
    };
    const journal = await repository.executeToolCallOnceDetailed(input, async () => JSON.stringify({
      agendamento: { status: "confirmado" }
    }));
    const externalId = `mismatched-reply-${randomUUID()}`;

    await expect(repository.recordAgentReply({
      tenantId: tenantA,
      sessionId: sessionA,
      conversationId: conversationA,
      agentConfigVersionId: agentVersionA,
      text: "A reunião foi cancelada.",
      model: "model/test",
      externalId,
      inboundExternalId: input.inboundExternalId,
      transactionClaims: [{
        journalId: journal.journalId,
        action: "cancel_meeting",
        claimType: "transaction_status",
        normalizedValue: "succeeded"
      }]
    })).rejects.toThrow("does not belong");

    expect((await pool.query(
      "SELECT id FROM messages WHERE provider_message_key=$1",
      [`${tenantA}:${sessionA}:${externalId}`]
    )).rowCount).toBe(0);
  });

  it("journals a late-ready Meet link and suppresses fallback only after the normal reply is durable", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const categoryId = `category-${suffix}`;
    const unitId = `unit-${suffix}`;
    await pool.query(
      `INSERT INTO scheduling_categories(tenant_id,id,name)
       VALUES($1,$2,'Categoria de teste')`,
      [tenantA, categoryId]
    );
    await pool.query(
      `INSERT INTO scheduling_units(
         tenant_id,id,name,opening_time,closing_time,operating_days
       ) VALUES($1,$2,'Reuniões','08:00','18:00',ARRAY[1,2,3,4,5]::smallint[])`,
      [tenantA, unitId]
    );
    const leadId = (await pool.query<{ id: string }>(
      `INSERT INTO scheduling_leads(
         tenant_id,phone,name,interest_category_id,unit_id,status,source
       ) VALUES($1,$2,'Lead wait',$3,$4,'agendado','whatsapp') RETURNING id`,
      [tenantA, nextPhone(), categoryId, unitId]
    )).rows[0].id;
    const appointmentId = (await pool.query<{ id: string }>(
      `INSERT INTO scheduling_appointments(
         tenant_id,lead_id,unit_id,start_at,end_at,status,meeting_provisioning_status
       ) VALUES($1,$2,$3,'2030-01-07T12:00:00.000Z','2030-01-07T13:00:00.000Z',
         'confirmado','pending') RETURNING id`,
      [tenantA, leadId, unitId]
    )).rows[0].id;
    const readyUrl = "https://meet.google.com/ready-after-commit";
    const delayedDeliveryId = (await pool.query<{ id: string }>(
      `INSERT INTO scheduling_meeting_contact_delivery_outbox(
         tenant_id,appointment_id,conversation_id,session_id,contact_phone,
         meet_url,message_text,available_at
       ) VALUES($1,$2,$3,$4,'5511900010101',$5,'Link pronto',
                now()+interval '5 seconds')
       RETURNING id`,
      [tenantA, appointmentId, conversationA, sessionA, readyUrl]
    )).rows[0].id;
    const readyUpdate = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        pool.query(
          `UPDATE scheduling_appointments
           SET meeting_provisioning_status='ready',
               meeting_provider='google_meet',
               meeting_space_name='spaces/ready-after-commit',
               meeting_code='ready-after-commit',
               meeting_url=$3,
               meeting_created_at=now()
           WHERE id=$1 AND tenant_id=$2`,
          [appointmentId, tenantA, readyUrl]
        ).then(() => resolve(), reject);
      }, 50);
    });
    const input: ToolCallJournalInput = {
      ...journalInput(`wait-ready-${suffix}`),
      toolName: "agendar_reuniao",
      argumentsJson: JSON.stringify({ agenda_id: unitId, start: "2030-01-07T12:00:00.000Z" })
    };

    const journal = await repository.executeToolCallOnceDetailed(input, async () => JSON.stringify({
      agendamento: {
        id: appointmentId,
        status: "confirmado",
        meeting_provisioning_status: "pending"
      }
    }));
    await readyUpdate;

    expect(journal.status).toBe("succeeded");
    expect(JSON.parse(journal.status === "succeeded" ? journal.resultText : "{}")).toMatchObject({
      agendamento: {
        id: appointmentId,
        unidade_id: unitId,
        unidade_nome: "Reuniões",
        start: "2030-01-07T12:00:00.000Z",
        end: "2030-01-07T13:00:00.000Z",
        status: "confirmado",
        meeting_provisioning_status: "ready",
        meet_link: readyUrl
      }
    });
    expect((await pool.query<{ status: string }>(
      "SELECT status FROM scheduling_meeting_contact_delivery_outbox WHERE id=$1",
      [delayedDeliveryId]
    )).rows[0].status).toBe("pending");

    await repository.recordAgentReply({
      tenantId: tenantA,
      sessionId: sessionA,
      conversationId: conversationA,
      agentConfigVersionId: agentVersionA,
      text: `A reunião foi agendada. Link da reunião: ${readyUrl}`,
      model: "model/test",
      externalId: `wait-ready-reply-${suffix}`,
      inboundExternalId: input.inboundExternalId,
      transactionClaims: [{
        journalId: journal.journalId,
        action: "schedule_meeting",
        claimType: "meeting_url",
        normalizedValue: readyUrl
      }]
    });

    expect((await pool.query<{ status: string }>(
      "SELECT status FROM scheduling_meeting_contact_delivery_outbox WHERE id=$1",
      [delayedDeliveryId]
    )).rows[0].status).toBe("suppressed");
  });

  it("does not let the Meet fallback race an active normal reply", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const unitId = `unit-delivery-race-${suffix}`;
    await pool.query(
      `INSERT INTO scheduling_units(
         tenant_id,id,name,opening_time,closing_time,operating_days
       ) VALUES($1,$2,'Reuniões fallback','08:00','18:00',ARRAY[1,2,3,4,5]::smallint[])`,
      [tenantA, unitId]
    );
    const leadId = (await pool.query<{ lead_id: string }>(
      "SELECT lead_id FROM conversations WHERE id=$1 AND tenant_id=$2",
      [conversationA, tenantA]
    )).rows[0].lead_id;
    const appointmentId = (await pool.query<{ id: string }>(
      `INSERT INTO scheduling_appointments(
         tenant_id,lead_id,unit_id,start_at,end_at,status,meeting_provisioning_status,
         meeting_provider,meeting_space_name,meeting_code,meeting_url,meeting_created_at
       ) VALUES($1,$2,$3,'2030-01-09T12:00:00.000Z','2030-01-09T13:00:00.000Z',
         'confirmado','ready','google_meet','spaces/delivery-race','delivery-race',
         'https://meet.google.com/delivery-race',now())
       RETURNING id`,
      [tenantA, leadId, unitId]
    )).rows[0].id;
    const outboxId = (await pool.query<{ id: string }>(
      `INSERT INTO scheduling_meeting_contact_delivery_outbox(
         tenant_id,appointment_id,conversation_id,session_id,contact_phone,
         meet_url,message_text,available_at
       ) VALUES($1,$2,$3,$4,'5511900010101',
         'https://meet.google.com/delivery-race','Link pronto',now()-interval '1 second')
       RETURNING id`,
      [tenantA, appointmentId, conversationA, sessionA]
    )).rows[0].id;
    await pool.query(
      "UPDATE messages SET processed_at=now() WHERE conversation_id=$1 AND sender='contact' AND processed_at IS NULL",
      [conversationA]
    );
    const providerKey = `${tenantA}:${sessionA}:delivery-race-${suffix}`;
    const inboundId = (await pool.query<{ id: string }>(
      `INSERT INTO messages(
         conversation_id,sender,content,external_message_id,provider_message_key,processing_started_at
       ) VALUES($1,'contact','Pode ser','delivery-race-' || $2,$3,now()) RETURNING id`,
      [conversationA, suffix, providerKey]
    )).rows[0].id;

    const deliveryRepository = new MeetingContactDeliveryRepository(pool);
    await expect(deliveryRepository.claim(outboxId)).resolves.toBeNull();
    expect((await pool.query<{ status: string }>(
      "SELECT status FROM scheduling_meeting_contact_delivery_outbox WHERE id=$1",
      [outboxId]
    )).rows[0].status).toBe("pending");

    await pool.query("UPDATE messages SET processed_at=now() WHERE id=$1", [inboundId]);
    await expect(deliveryRepository.claim(outboxId)).resolves.toMatchObject({
      id: outboxId,
      appointmentId,
      conversationId: conversationA
    });
  });

  it("suppresses an already persisted Meet outbox with the flag off but never after an ambiguous attempt", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const categoryId = `category-off-${suffix}`;
    const unitId = `unit-off-${suffix}`;
    await pool.query(
      `INSERT INTO scheduling_categories(tenant_id,id,name)
       VALUES($1,$2,'Categoria flag off')`,
      [tenantA, categoryId]
    );
    await pool.query(
      `INSERT INTO scheduling_units(
         tenant_id,id,name,opening_time,closing_time,operating_days
       ) VALUES($1,$2,'Reuniões flag off','08:00','18:00',ARRAY[1,2,3,4,5]::smallint[])`,
      [tenantA, unitId]
    );
    // Flag desligada por tenant reproduz também o efeito do kill switch global:
    // o outbox já persistido continua precisando ser suprimido.
    await pool.query(
      `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
       VALUES($1,'scheduling_meet_outbox_v2',false)
       ON CONFLICT (tenant_id,flag_key) DO UPDATE SET enabled=false`,
      [tenantA]
    );
    expect(await isFeatureFlagEnabled(pool, tenantA, "scheduling_meet_outbox_v2")).toBe(false);

    const createOutbox = async (label: string, attempted: boolean) => {
      const leadId = (await pool.query<{ id: string }>(
        `INSERT INTO scheduling_leads(
           tenant_id,phone,name,interest_category_id,unit_id,status,source
         ) VALUES($1,$2,'Lead flag off',$3,$4,'agendado','whatsapp') RETURNING id`,
        [tenantA, nextPhone(), categoryId, unitId]
      )).rows[0].id;
      const appointmentId = (await pool.query<{ id: string }>(
        `INSERT INTO scheduling_appointments(
           tenant_id,lead_id,unit_id,start_at,end_at,status,meeting_provisioning_status
         ) VALUES($1,$2,$3,'2030-01-08T12:00:00.000Z','2030-01-08T13:00:00.000Z',
           'confirmado','ready') RETURNING id`,
        [tenantA, leadId, unitId]
      )).rows[0].id;
      const meetUrl = `https://meet.google.com/${label}-${suffix}`;
      const id = (await pool.query<{ id: string }>(
        `INSERT INTO scheduling_meeting_contact_delivery_outbox(
           tenant_id,appointment_id,conversation_id,session_id,contact_phone,
           meet_url,message_text,status,attempt_count,attempted_at
         ) VALUES($1,$2,$3,$4,'5511900010101',$5,'Link pronto','processing',
                  $6,CASE WHEN $7::boolean THEN now() ELSE NULL END)
         RETURNING id`,
        [tenantA, appointmentId, conversationA, sessionA, meetUrl, attempted ? 1 : 0, attempted]
      )).rows[0].id;
      return { id, meetUrl };
    };

    const pendingDelivery = await createOutbox("flagoff", false);
    const ambiguousDelivery = await createOutbox("ambiguo", true);

    await repository.recordAgentReply({
      tenantId: tenantA,
      sessionId: sessionA,
      conversationId: conversationA,
      agentConfigVersionId: agentVersionA,
      text: `Links: ${pendingDelivery.meetUrl} e ${ambiguousDelivery.meetUrl}`,
      model: "model/test",
      externalId: `flag-off-reply-${suffix}`,
      inboundExternalId: `flag-off-inbound-${suffix}`
    });

    const statuses = await pool.query<{ id: string; status: string }>(
      "SELECT id,status FROM scheduling_meeting_contact_delivery_outbox WHERE id=ANY($1::uuid[])",
      [[pendingDelivery.id, ambiguousDelivery.id]]
    );
    expect(Object.fromEntries(statuses.rows.map((row) => [row.id, row.status]))).toEqual({
      [pendingDelivery.id]: "suppressed",
      [ambiguousDelivery.id]: "processing"
    });
  });
});
