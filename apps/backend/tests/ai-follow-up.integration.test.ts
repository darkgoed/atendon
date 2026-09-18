import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { AiFollowUpRepository } from "../src/modules/messages/ai-follow-up.js";
import { MessageRepository } from "../src/modules/messages/repository.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const messages = new MessageRepository(pool, config);
const followUps = new AiFollowUpRepository(pool, config);
let tenantId: string;
let sessionId: string;
let conversationId: string;
const contactPhone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

beforeAll(async () => {
  const tenant = await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`Follow-up integration ${randomUUID()}`]
  );
  tenantId = tenant.rows[0].id;
  const session = await pool.query<{ id: string }>(
    "INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id",
    [tenantId]
  );
  sessionId = session.rows[0].id;
  await pool.query(
    "INSERT INTO agent_configs(tenant_id,system_prompt,ai_model,model_params) VALUES($1,$2,$3,$4)",
    [tenantId, "Atenda com objetividade.", "test/model", { temperature: 0.5, max_tokens: 300 }]
  );
  await pool.query(
    `UPDATE tenant_ai_settings SET
       ai_follow_up_enabled=true,ai_follow_up_max_count=2,ai_follow_up_interval_minutes=1,
       ai_follow_up_delays_minutes=ARRAY[1,2]::integer[]
     WHERE tenant_id=$1`,
    [tenantId]
  );
});

afterAll(async () => {
  if (tenantId) await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.end();
});

describe("AI follow-up persistence", () => {
  it("stores each outbound text bubble as a separate panel message", async () => {
    const bubblePhone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const inboundExternalId = `bubble-inbound-${randomUUID()}`;
    const context = await messages.recordInboundAndLoadContext({
      externalId: inboundExternalId,
      tenantId,
      sessionId,
      contactPhone: bubblePhone,
      text: "Como funciona?"
    });
    expect(context).not.toBeNull();
    const bubbleConversationId = context!.conversationId;
    const firstSentAt = new Date();
    const secondSentAt = new Date(firstSentAt.getTime() + 1);
    const firstExternalId = `agent-bubble-one-${randomUUID()}`;
    const secondExternalId = `agent-bubble-two-${randomUUID()}`;

    await messages.recordAgentReply({
      tenantId,
      sessionId,
      conversationId: bubbleConversationId,
      text: "Claro Renan\n\nFunciona assim...",
      model: "test/model",
      externalId: firstExternalId,
      inboundExternalId,
      bubbles: [
        { text: "Claro Renan", externalId: firstExternalId, createdAt: firstSentAt },
        { text: "Funciona assim...", externalId: secondExternalId, createdAt: secondSentAt }
      ]
    });

    const initialRows = await pool.query<{ content: string; external_message_id: string }>(
      `SELECT content,external_message_id FROM messages
       WHERE conversation_id=$1 AND external_message_id=ANY($2::text[])
       ORDER BY created_at,id`,
      [bubbleConversationId, [firstExternalId, secondExternalId]]
    );
    expect(initialRows.rows).toEqual([
      { content: "Claro Renan", external_message_id: firstExternalId },
      { content: "Funciona assim...", external_message_id: secondExternalId }
    ]);
    expect((await pool.query<{ content: string }>(
      `SELECT m.content FROM ai_follow_up_schedules f
       JOIN messages m ON m.id=f.last_agent_message_id WHERE f.conversation_id=$1`,
      [bubbleConversationId]
    )).rows[0]?.content).toBe("Funciona assim...");

    await pool.query(
      "UPDATE ai_follow_up_schedules SET next_run_at=now()-interval '1 second' WHERE conversation_id=$1",
      [bubbleConversationId]
    );
    const followUpClaim = await followUps.claimDue(bubbleConversationId);
    expect(followUpClaim).not.toBeNull();
    const followUpFirstId = `follow-up-bubble-one-${randomUUID()}`;
    const followUpSecondId = `follow-up-bubble-two-${randomUUID()}`;
    const followUpFirstSentAt = new Date();
    const followUpSecondSentAt = new Date(followUpFirstSentAt.getTime() + 1);
    await followUps.completeSent(followUpClaim!, {
      text: "Primeiro balão\n\nSegundo balão",
      model: "test/model",
      externalId: followUpFirstId,
      sentAt: followUpFirstSentAt,
      bubbles: [
        { text: "Primeiro balão", externalId: followUpFirstId, sentAt: followUpFirstSentAt },
        { text: "Segundo balão", externalId: followUpSecondId, sentAt: followUpSecondSentAt }
      ]
    });

    const followUpRows = await pool.query<{ content: string; external_message_id: string }>(
      `SELECT content,external_message_id FROM messages
       WHERE conversation_id=$1 AND external_message_id=ANY($2::text[])
       ORDER BY created_at,id`,
      [bubbleConversationId, [followUpFirstId, followUpSecondId]]
    );
    expect(followUpRows.rows).toEqual([
      { content: "Primeiro balão", external_message_id: followUpFirstId },
      { content: "Segundo balão", external_message_id: followUpSecondId }
    ]);
    expect((await pool.query<{ content: string }>(
      `SELECT m.content FROM ai_follow_up_schedules f
       JOIN messages m ON m.id=f.last_agent_message_id WHERE f.conversation_id=$1`,
      [bubbleConversationId]
    )).rows[0]?.content).toBe("Segundo balão");
  });

  it("schedules after an agent reply and cancels the sequence when the contact responds", async () => {
    const inboundExternalId = `inbound-${randomUUID()}`;
    const context = await messages.recordInboundAndLoadContext({
      externalId: inboundExternalId,
      tenantId,
      sessionId,
      contactPhone,
      text: "Queria saber mais sobre o plano anual"
    });
    expect(context).not.toBeNull();
    conversationId = context!.conversationId;
    await messages.recordAgentReply({
      tenantId,
      sessionId,
      conversationId,
      text: "O plano anual inclui suporte completo. Quer comparar com o mensal?",
      model: "test/model",
      externalId: `agent-${randomUUID()}`,
      inboundExternalId
    });

    const scheduled = await pool.query(
      `SELECT status,follow_up_count,next_run_at IS NOT NULL has_next
       FROM ai_follow_up_schedules WHERE conversation_id=$1`,
      [conversationId]
    );
    expect(scheduled.rows[0]).toEqual({ status: "scheduled", follow_up_count: 0, has_next: true });

    await messages.recordInboundAndLoadContext({
      externalId: `reply-${randomUUID()}`,
      tenantId,
      sessionId,
      contactPhone,
      text: "Sim, pode comparar"
    });
    const cancelled = await pool.query(
      "SELECT status,next_run_at,cancellation_reason FROM ai_follow_up_schedules WHERE conversation_id=$1",
      [conversationId]
    );
    expect(cancelled.rows[0]).toEqual({ status: "cancelled", next_run_at: null, cancellation_reason: "contact_replied" });
  });

  it("uses fresh history, spaces sends by the configured interval and completes at the maximum", async () => {
    const inboundExternalId = `second-inbound-${randomUUID()}`;
    await messages.recordInboundAndLoadContext({
      externalId: inboundExternalId,
      tenantId,
      sessionId,
      contactPhone,
      text: "O anual parece melhor"
    });
    await messages.recordAgentReply({
      tenantId,
      sessionId,
      conversationId,
      text: "Posso detalhar a forma de pagamento do anual. Você quer à vista ou parcelado?",
      model: "test/model",
      externalId: `second-agent-${randomUUID()}`,
      inboundExternalId
    });
    await pool.query("UPDATE ai_follow_up_schedules SET next_run_at=now()-interval '1 second' WHERE conversation_id=$1", [conversationId]);

    const firstClaim = await followUps.claimDue(conversationId);
    expect(firstClaim).not.toBeNull();
    expect(firstClaim!.history.at(-2)).toEqual({ role: "user", content: "O anual parece melhor" });
    expect(firstClaim!.history.at(-1)).toEqual({
      role: "assistant",
      content: "Posso detalhar a forma de pagamento do anual. Você quer à vista ou parcelado?"
    });
    const firstFollowUpExternalId = `follow-up-one-${randomUUID()}`;
    await followUps.completeSent(firstClaim!, {
      text: "Se ajudar na decisão, posso começar pelo parcelamento. Quantas vezes ficariam confortáveis pra você?",
      model: "test/model",
      externalId: firstFollowUpExternalId,
      sentAt: new Date()
    });
    expect((await pool.query(
      "SELECT agent_config_version_id FROM messages WHERE external_message_id=$1",
      [firstFollowUpExternalId]
    )).rows[0]).toEqual({ agent_config_version_id: firstClaim!.agentConfigVersionId });
    const afterFirst = await pool.query(
      `SELECT status,follow_up_count,next_run_at>now() next_is_future
       FROM ai_follow_up_schedules WHERE conversation_id=$1`,
      [conversationId]
    );
    expect(afterFirst.rows[0]).toEqual({ status: "scheduled", follow_up_count: 1, next_is_future: true });

    await pool.query("UPDATE ai_follow_up_schedules SET next_run_at=now()-interval '1 second' WHERE conversation_id=$1", [conversationId]);
    const secondClaim = await followUps.claimDue(conversationId);
    expect(secondClaim?.followUpCount).toBe(1);
    expect(secondClaim?.history.at(-1)?.content).toContain("Quantas vezes");
    await followUps.completeSent(secondClaim!, {
      text: "Também posso deixar um resumo das condições pra você olhar com calma. Quer que eu organize assim?",
      model: "test/model",
      externalId: `follow-up-two-${randomUUID()}`,
      sentAt: new Date()
    });

    const completed = await pool.query(
      "SELECT status,follow_up_count,next_run_at,cancellation_reason FROM ai_follow_up_schedules WHERE conversation_id=$1",
      [conversationId]
    );
    expect(completed.rows[0]).toEqual({
      status: "completed",
      follow_up_count: 2,
      next_run_at: null,
      cancellation_reason: "maximum_reached"
    });
  });

  it("limits follow-up history before window calculations and keeps stable chronology", async () => {
    const bulkPhone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const inboundExternalId = `bulk-follow-up-inbound-${randomUUID()}`;
    const context = await messages.recordInboundAndLoadContext({
      externalId: inboundExternalId,
      tenantId,
      sessionId,
      contactPhone: bulkPhone,
      text: "mensagem atual do contato"
    });
    expect(context).not.toBeNull();
    const prefix = `bulk-follow-up-${randomUUID()}-`;
    await pool.query(
      `INSERT INTO messages(conversation_id,sender,content,external_message_id,created_at)
       SELECT $1,CASE WHEN n%2=0 THEN 'agent' ELSE 'contact' END,
              'histórico empatado '||n,$2||n,'2025-02-01T12:00:00Z'::timestamptz
       FROM generate_series(1,104) n`,
      [context!.conversationId, prefix]
    );
    await pool.query(
      `INSERT INTO messages(conversation_id,sender,content,external_message_id,media_is_sticker,created_at)
       VALUES($1,'agent','sticker ignorado',$2,true,'2025-02-01T12:00:00Z')`,
      [context!.conversationId, `${prefix}sticker`]
    );
    await messages.recordAgentReply({
      tenantId,
      sessionId,
      conversationId: context!.conversationId,
      text: "resposta mais recente do agente",
      model: "test/model",
      externalId: `bulk-follow-up-agent-${randomUUID()}`,
      inboundExternalId
    });
    await pool.query(
      "UPDATE ai_follow_up_schedules SET next_run_at=now()-interval '1 second' WHERE conversation_id=$1",
      [context!.conversationId]
    );

    const claim = await followUps.claimDue(context!.conversationId);
    const expected = await pool.query<{ sender: string; content: string }>(
      `SELECT sender,content FROM messages
       WHERE conversation_id=$1 AND NOT(sender='agent' AND media_is_sticker)
       ORDER BY created_at DESC,id DESC LIMIT 40`,
      [context!.conversationId]
    );

    expect(claim?.history).toEqual(expected.rows.reverse().map((message) => ({
      role: message.sender === "contact" ? "user" : "assistant",
      content: message.content
    })));
    expect(claim?.history).toHaveLength(40);
    expect(claim?.history.at(-1)).toEqual({ role: "assistant", content: "resposta mais recente do agente" });
    expect(claim?.history.some(({ content }) => content === "sticker ignorado")).toBe(false);
  });

  it("also starts a sequence after the agent media fallback", async () => {
    const inboundExternalId = `media-inbound-${randomUUID()}`;
    await messages.recordInboundAndLoadContext({
      externalId: inboundExternalId,
      tenantId,
      sessionId,
      contactPhone,
      text: "",
      mediaType: "audio"
    });
    const fallbackText = "Ainda não consigo ouvir áudio por aqui. Pode me mandar os detalhes em texto?";
    await messages.recordFallback({
      tenantId,
      sessionId,
      conversationId,
      mediaType: "audio",
      text: fallbackText,
      externalId: `media-fallback-${randomUUID()}`
    });

    const scheduled = await pool.query(
      `SELECT f.status,f.follow_up_count,m.content
       FROM ai_follow_up_schedules f JOIN messages m ON m.id=f.last_agent_message_id
       WHERE f.conversation_id=$1`,
      [conversationId]
    );
    expect(scheduled.rows[0]).toEqual({ status: "scheduled", follow_up_count: 0, content: fallbackText });

    await expect(followUps.cancelForContact(tenantId, contactPhone)).resolves.toBe(1);
    const webhookCancelled = await pool.query(
      "SELECT status,cancellation_reason FROM ai_follow_up_schedules WHERE conversation_id=$1",
      [conversationId]
    );
    expect(webhookCancelled.rows[0]).toEqual({ status: "cancelled", cancellation_reason: "contact_replied" });
  });

  it("keeps the textual follow-up sequence current after the AI sends a sticker", async () => {
    const inboundExternalId = `sticker-inbound-${randomUUID()}`;
    await messages.recordInboundAndLoadContext({
      externalId: inboundExternalId,
      tenantId,
      sessionId,
      contactPhone,
      text: "Fechado, gostei da proposta"
    });
    const reply = "Ótimo! Posso separar o melhor horário para continuarmos?";
    await messages.recordAgentReply({
      tenantId,
      sessionId,
      conversationId,
      text: reply,
      model: "test/model",
      externalId: `sticker-agent-${randomUUID()}`,
      inboundExternalId
    });
    const sticker = await pool.query<{ id: string }>(
      `INSERT INTO ai_stickers(
         tenant_id,name,description,tags,mime_type,file_name,size_bytes,content_hash,media_data,source,enabled
       ) VALUES($1,'Comemoração','Comemorar confirmação','{}','image/webp','interno.webp',12,$2,$3,'panel_upload',true)
       RETURNING id`,
      [tenantId, randomUUID(), Buffer.from("RIFF0000WEBP")]
    );
    await messages.recordAiStickerSend({
      tenantId,
      conversationId,
      stickerId: sticker.rows[0].id,
      externalId: `sticker-media-${randomUUID()}`
    });
    await pool.query("UPDATE ai_follow_up_schedules SET next_run_at=now()-interval '1 second' WHERE conversation_id=$1", [conversationId]);

    const claim = await followUps.claimDue(conversationId);
    expect(claim).not.toBeNull();
    expect(claim?.history.at(-1)).toEqual({ role: "assistant", content: reply });
  });

  it("anchors the progressive 2h, 24h and 72h cadence to the original unanswered reply", async () => {
    await pool.query(
      `UPDATE tenant_ai_settings SET
         ai_follow_up_enabled=true,
         ai_follow_up_max_count=3,
         ai_follow_up_interval_minutes=120,
         ai_follow_up_delays_minutes=ARRAY[120,1440,4320]::integer[]
       WHERE tenant_id=$1`,
      [tenantId]
    );
    const inboundExternalId = `progressive-inbound-${randomUUID()}`;
    await messages.recordInboundAndLoadContext({
      externalId: inboundExternalId,
      tenantId,
      sessionId,
      contactPhone,
      text: "Qual horário você tem?"
    });
    const sentAt = new Date();
    await messages.recordAgentReply({
      tenantId,
      sessionId,
      conversationId,
      text: "Tenho 14h e 16h, qual funciona melhor?",
      model: "test/model",
      externalId: `progressive-agent-${randomUUID()}`,
      inboundExternalId,
      createdAt: sentAt
    });
    const schedule = await pool.query<{
      first_delay_minutes: number;
      sequence_started_at: Date;
    }>(
      `SELECT round(extract(epoch FROM (next_run_at-sequence_started_at))/60)::int first_delay_minutes,
              sequence_started_at
       FROM ai_follow_up_schedules WHERE conversation_id=$1`,
      [conversationId]
    );
    expect(schedule.rows[0].first_delay_minutes).toBe(120);
    expect(schedule.rows[0].sequence_started_at.toISOString()).toBe(sentAt.toISOString());
  });

  it("lead na lixeira não recebe follow-up: vencido cancela como lead_deleted e nova criação é bloqueada", async () => {
    const trashPhone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const trashInboundExternalId = `trash-inbound-${randomUUID()}`;
    const context = await messages.recordInboundAndLoadContext({
      externalId: trashInboundExternalId,
      tenantId,
      sessionId,
      contactPhone: trashPhone,
      text: "Me conta como funciona"
    });
    expect(context).not.toBeNull();
    const trashConversationId = context!.conversationId;
    await messages.recordAgentReply({
      tenantId,
      sessionId,
      conversationId: trashConversationId,
      text: "Claro, funciona assim...",
      model: "test/model",
      externalId: `agent-trash-${randomUUID()}`,
      inboundExternalId: trashInboundExternalId
    });
    expect((await pool.query<{ status: string }>(
      "SELECT status FROM ai_follow_up_schedules WHERE conversation_id=$1",
      [trashConversationId]
    )).rows[0]?.status).toBe("scheduled");

    // Lead vai para a lixeira (0171): o robô deve ignorar a conversa.
    const leadId = (await pool.query<{ lead_id: string | null }>(
      "SELECT lead_id FROM conversations WHERE id=$1",
      [trashConversationId]
    )).rows[0].lead_id;
    expect(leadId).toBeTruthy();
    await pool.query("UPDATE scheduling_leads SET deleted_at=now() WHERE id=$1", [leadId!]);

    // Vencido: claim não processa e cancela com lead_deleted.
    await pool.query(
      "UPDATE ai_follow_up_schedules SET next_run_at=now()-interval '1 second' WHERE conversation_id=$1",
      [trashConversationId]
    );
    expect(await followUps.claimDue(trashConversationId)).toBeNull();
    expect((await pool.query<{ status: string; cancellation_reason: string }>(
      "SELECT status,cancellation_reason FROM ai_follow_up_schedules WHERE conversation_id=$1",
      [trashConversationId]
    )).rows[0]).toEqual({ status: "cancelled", cancellation_reason: "lead_deleted" });

    // Nova tentativa de agendar (agente respondeu de novo): criação bloqueada
    // e o motivo lead_deleted é preservado.
    await messages.recordAgentReply({
      tenantId,
      sessionId,
      conversationId: trashConversationId,
      text: "Segunda retomada não deveria agendar",
      model: "test/model",
      externalId: `agent-trash-2-${randomUUID()}`,
      inboundExternalId: `trash-inbound-2-${randomUUID()}`
    });
    expect((await pool.query<{ status: string; cancellation_reason: string }>(
      "SELECT status,cancellation_reason FROM ai_follow_up_schedules WHERE conversation_id=$1",
      [trashConversationId]
    )).rows[0]).toEqual({ status: "cancelled", cancellation_reason: "lead_deleted" });
  });
});
