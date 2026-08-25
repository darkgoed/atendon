import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { MessageProcessor } from "../src/modules/messages/process-message.js";
import { MessageRepository } from "../src/modules/messages/repository.js";
import type { AiRouter } from "../src/modules/ai-router/openrouter.js";
import { qualifyLeadFromConversation } from "../src/modules/scheduling/contextual-qualification.js";
import { redisConnection } from "../src/queue/connection.js";
import { closeRateLimiter, consumeRateLimitRedis } from "../src/modules/messages/rate-limiter.js";
import { createRedisRateLimitStore } from "../src/security/http-rate-limit.js";
import { inboundQueue } from "../src/queue/message-queue.js";
import { scheduleAiFollowUpsAfterAgentReply } from "../src/modules/messages/ai-follow-up.js";
import { AiTurnProgressStore } from "../src/modules/realtime/ai-turn-progress.js";
import {
  checkReadiness,
  CRITICAL_WORKER_HEARTBEAT_KEYS,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_MS
} from "../src/readiness.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
let tenantId: string;
let sessionId: string;

beforeAll(async () => {
  const tenant = await pool.query<{ id: string }>("INSERT INTO tenants (name, attendant_phone) VALUES ($1, $2) RETURNING id", [`test-${randomUUID()}`, "5511666666666"]);
  tenantId = tenant.rows[0].id;
  const session = await pool.query<{ id: string }>("INSERT INTO whatsapp_sessions (tenant_id, phone_number) VALUES ($1, $2) RETURNING id", [tenantId, "5511777777777"]);
  sessionId = session.rows[0].id;
  await pool.query(
    "INSERT INTO agent_configs (tenant_id, system_prompt, ai_model) VALUES ($1, $2, $3)",
    [tenantId, "Responda de forma objetiva", "test/model"]
  );
});

afterAll(async () => {
  const redis = await inboundQueue.client;
  await redis.del(WORKER_HEARTBEAT_KEY, ...Object.values(CRITICAL_WORKER_HEARTBEAT_KEYS));
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  await closeRateLimiter();
  await pool.end();
});

describe("phase 1 infrastructure", () => {
  it("recovers the newest ephemeral AI turn and cannot clear it from an older turn", async () => {
    const conversationId = randomUUID();
    const store = new AiTurnProgressStore(pool, config.REDIS_URL);
    await pool.query(
      `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
       VALUES($1,'ai_turn_visibility_v1',true)
       ON CONFLICT(tenant_id,flag_key) DO UPDATE SET enabled=true,updated_at=now()`,
      [tenantId]
    );
    try {
      const first = await store.start({
        tenantId,
        conversationId,
        turnId: randomUUID(),
        attempt: 1
      });
      expect(first).not.toBeNull();
      await first!.publish({
        phase: "preview",
        label: "Prévia · ainda não enviada",
        preview: "Resposta validada",
        previewTruncated: false
      });
      await expect(store.get(tenantId, conversationId)).resolves.toMatchObject({
        turnId: first!.turnId,
        phase: "preview",
        preview: "Resposta validada"
      });

      const second = await store.start({
        tenantId,
        conversationId,
        turnId: randomUUID(),
        attempt: 2
      });
      expect(second).not.toBeNull();
      await first!.clear();
      await expect(store.get(tenantId, conversationId)).resolves.toMatchObject({
        turnId: second!.turnId,
        attempt: 2,
        phase: "reading"
      });

      const redis = await inboundQueue.client;
      const ttl = await (redis as unknown as { pttl(key: string): Promise<number> })
        .pttl(`atendon:conversation-ai-turn:v1:${tenantId}:${conversationId}`);
      expect(ttl).toBeGreaterThan(29 * 60_000);
      expect(ttl).toBeLessThanOrEqual(30 * 60_000);

      await second!.clear();
      await expect(store.get(tenantId, conversationId)).resolves.toBeNull();
    } finally {
      await pool.query(
        "DELETE FROM tenant_feature_flag_overrides WHERE tenant_id=$1 AND flag_key='ai_turn_visibility_v1'",
        [tenantId]
      );
      await store.close();
    }
  });

  it("shares sensitive-route counters through the Redis-backed HTTP store", async () => {
    const distributed = createRedisRateLimitStore(config.REDIS_URL, () => undefined);
    const store = new distributed.Store({});
    const key = `integration-${randomUUID()}`;
    const increment = () => new Promise<{ current: number; ttl: number }>((resolve, reject) => {
      store.incr(key, (error, result) => {
        if (error) reject(error);
        else if (!result) reject(new Error("Redis rate limiter returned no result"));
        else resolve(result);
      }, 60_000, 1);
    });
    try {
      await expect(increment()).resolves.toMatchObject({ current: 1 });
      const exceeded = await increment();
      expect(exceeded.current).toBe(2);
      expect(exceeded.ttl).toBeGreaterThan(0);
    } finally {
      await distributed.close();
    }
  });

  it("reports database, Redis, queue and a recent worker heartbeat independently", async () => {
    const redis = await inboundQueue.client;
    const now = Date.now();
    await Promise.all([
      redis.set(WORKER_HEARTBEAT_KEY, String(now), { PX: WORKER_HEARTBEAT_TTL_MS }),
      ...Object.values(CRITICAL_WORKER_HEARTBEAT_KEYS)
        .map((key) => redis.set(key, String(now), { PX: WORKER_HEARTBEAT_TTL_MS }))
    ]);
    await expect(checkReadiness(now)).resolves.toEqual({
      ready: true,
      checks: {
        postgres: true,
        redis: true,
        queue: true,
        worker: true,
        worker_inbound: true,
        worker_meeting_provisioning: true,
        worker_meeting_contact_delivery: true
      }
    });

    await redis.set(WORKER_HEARTBEAT_KEY, String(now - WORKER_HEARTBEAT_TTL_MS - 1), { PX: WORKER_HEARTBEAT_TTL_MS });
    await redis.set(
      CRITICAL_WORKER_HEARTBEAT_KEYS.meeting_contact_delivery,
      String(now - WORKER_HEARTBEAT_TTL_MS - 1),
      { PX: WORKER_HEARTBEAT_TTL_MS }
    );
    const stale = await checkReadiness(now);
    expect(stale).toEqual({
      ready: false,
      checks: {
        postgres: true,
        redis: true,
        queue: true,
        worker: false,
        worker_inbound: true,
        worker_meeting_provisioning: true,
        worker_meeting_contact_delivery: false
      }
    });
  });

  it("persists inbound, AI reply and usage as one processing flow", async () => {
    const gateway = {
      sendText: vi.fn().mockResolvedValue({ externalId: `sent-${randomUUID()}` }),
      sendPresence: vi.fn().mockResolvedValue(undefined),
      markMessageAsRead: vi.fn().mockResolvedValue(undefined),
      setPresence: vi.fn().mockResolvedValue(undefined)
    };
    const ai = { complete: vi.fn().mockImplementation(async (input) => {
      await input.onUsage?.({
        providerRequestId: `gen-${randomUUID()}`,
        model: "test/model",
        inputTokens: 8,
        outputTokens: 3,
        reasoningTokens: 1,
        cachedInputTokens: 5,
        cacheWriteInputTokens: 2,
        costUsd: 0.004,
        requestId: input.trace?.requestId,
        processingAttempt: input.trace?.processingAttempt,
        providerRequestIndex: 1,
        callReason: `${input.trace?.reason}:initial`,
        durationMs: 25,
        toolsUsed: ["verificar_horarios_reuniao"],
        systemPromptCharacters: 100,
        historyMessageCount: 1,
        historyCharacters: 20,
        requestMessageCharacters: 120,
        toolSchemaCharacters: 30,
        toolResultCharacters: 40
      });
      return { text: "Resposta integrada", inputTokens: 8, outputTokens: 3, costUsd: 0.004 };
    }) };
    const processor = new MessageProcessor(new MessageRepository(pool), gateway, ai);
    await expect(processor.process({
      externalId: `received-${randomUUID()}`, tenantId, sessionId,
      contactPhone: "5511900000000", contactName: "Teste", text: "Mensagem integrada"
    })).resolves.toBe("answered");

    const rows = await pool.query<{ sender: string; content: string }>(
      `SELECT m.sender, m.content FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.tenant_id = $1 ORDER BY m.created_at`, [tenantId]
    );
    expect(rows.rows).toEqual([
      { sender: "contact", content: "Mensagem integrada" },
      { sender: "agent", content: "Resposta integrada" }
    ]);
    const usage = await pool.query(
      `SELECT message_id,request_id,processing_attempt,provider_request_index,call_reason,duration_ms,
              tools_used,input_tokens,output_tokens,reasoning_tokens,cached_input_tokens,
              cache_write_input_tokens,cost_usd,system_prompt_characters,history_message_count,
              history_characters,request_message_characters,tool_schema_characters,tool_result_characters
       FROM usage_logs WHERE tenant_id = $1`,
      [tenantId]
    );
    expect(usage.rows[0]).toMatchObject({
      message_id: expect.any(String),
      request_id: expect.any(String),
      processing_attempt: 1,
      provider_request_index: 1,
      call_reason: "inbound_reply:initial",
      duration_ms: 25,
      tools_used: ["verificar_horarios_reuniao"],
      input_tokens: 8,
      output_tokens: 3,
      reasoning_tokens: 1,
      cached_input_tokens: 5,
      cache_write_input_tokens: 2,
      cost_usd: "0.004000",
      system_prompt_characters: 100,
      history_message_count: 1,
      history_characters: 20,
      request_message_characters: 120,
      tool_schema_characters: 30,
      tool_result_characters: 40
    });
  });

  it("creates an unqualified lead as soon as a new conversation is recorded", async () => {
    const repository = new MessageRepository(pool);
    const contactPhone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const context = await repository.recordInboundAndLoadContext({
      externalId: `automatic-lead-${randomUUID()}`,
      tenantId,
      sessionId,
      contactPhone,
      contactName: "Contato ainda não qualificado",
      text: "Oi, gostaria de entender melhor"
    });

    expect(context).not.toBeNull();
    const lead = await pool.query<{
      id: string;
      name: string | null;
      source: string;
      status: string;
      qualification_stars: number | null;
      conversation_lead_id: string;
    }>(
      `SELECT lead.id,lead.name,lead.source,lead.status,lead.qualification_stars,
              conversation.lead_id conversation_lead_id
       FROM conversations conversation
       JOIN scheduling_leads lead
         ON lead.id=conversation.lead_id AND lead.tenant_id=conversation.tenant_id
       WHERE conversation.id=$1 AND conversation.tenant_id=$2 AND lead.phone=$3`,
      [context!.conversationId, tenantId, contactPhone]
    );
    expect(lead.rows).toHaveLength(1);
    expect(lead.rows[0]).toMatchObject({
      name: "Contato ainda não qualificado",
      source: "whatsapp",
      status: "novo",
      qualification_stars: null,
      conversation_lead_id: lead.rows[0].id
    });
  });

  it("qualifies a lead from the persisted conversation context", async () => {
    const repository = new MessageRepository(pool);
    const contactPhone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const first = await repository.recordInboundAndLoadContext({
      externalId: `qualification-context-1-${randomUUID()}`,
      tenantId,
      sessionId,
      contactPhone,
      contactName: "Loja Contextual",
      text: "Tenho uma loja há cinco anos e vendo pela internet"
    });
    await pool.query(
      "INSERT INTO messages(conversation_id,sender,content) VALUES($1,'human',$2)",
      [first!.conversationId, "Qual é o seu faturamento atual?"]
    );
    await repository.recordInboundAndLoadContext({
      externalId: `qualification-context-2-${randomUUID()}`,
      tenantId,
      sessionId,
      contactPhone,
      text: "Faturamos cerca de 50 mil por mês"
    }, { claim: false });
    const lead = await pool.query<{ id: string }>(
      "SELECT id FROM scheduling_leads WHERE tenant_id=$1 AND phone=$2",
      [tenantId, contactPhone]
    );
    const complete = vi.fn(async (input: Parameters<AiRouter["complete"]>[0]) => {
      expect(input.history[0].content).toContain("Tenho uma loja há cinco anos");
      expect(input.history[0].content).toContain("Faturamos cerca de 50 mil por mês");
      await input.onUsage?.({
        providerRequestId: `manual-qualification-${randomUUID()}`,
        model: "test/model",
        inputTokens: 120,
        outputTokens: 80,
        costUsd: 0.01
      });
      return {
        text: JSON.stringify({
          estrelas: 4,
          respostas: {
            tempo_mercado: "5 anos",
            faturamento: "Cerca de R$ 50 mil por mês",
            nicho: "Loja com vendas online"
          },
          resumo: "Empresa estabelecida, com operação online e faturamento informado.",
          justificativa: "Tempo de mercado e faturamento indicam maturidade comercial."
        }),
        inputTokens: 120,
        outputTokens: 80,
        costUsd: 0.01
      };
    });

    const result = await qualifyLeadFromConversation(tenantId, lead.rows[0].id, { complete });

    expect(result).toMatchObject({
      lead_id: lead.rows[0].id,
      conversa_id: first!.conversationId,
      mensagens_analisadas: 3,
      qualificacao: {
        estrelas: 4,
        resumo: "Empresa estabelecida, com operação online e faturamento informado."
      }
    });
    expect(await pool.query(
      `SELECT status,qualification_stars,qualification_answers->>'faturamento' faturamento
       FROM scheduling_leads WHERE id=$1`,
      [lead.rows[0].id]
    ).then(({ rows }) => rows[0])).toEqual({
      status: "qualificado",
      qualification_stars: 4,
      faturamento: "Cerca de R$ 50 mil por mês"
    });
    expect(await pool.query(
      "SELECT purpose FROM usage_logs WHERE conversation_id=$1 AND input_tokens=120",
      [first!.conversationId]
    ).then(({ rows }) => rows)).toEqual([{ purpose: "attendance" }]);
  });

  it("applies scheduling and research prerequisites with every conversation already registered as a lead", async () => {
    const policyTenant = await pool.query<{ id: string }>(
      "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
      [`policy-${randomUUID()}`]
    );
    const policyTenantId = policyTenant.rows[0].id;
    try {
      const policySession = await pool.query<{ id: string }>(
        "INSERT INTO whatsapp_sessions(tenant_id,phone_number) VALUES($1,$2) RETURNING id",
        [policyTenantId, `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`]
      );
      await pool.query(
        `INSERT INTO agent_configs(tenant_id,system_prompt,ai_model,enabled_tools)
         VALUES($1,'Consultoria comercial conhecida','test/model',$2::jsonb)`,
        [policyTenantId, JSON.stringify([
          "pesquisar_contexto",
          "registrar_lead",
          "qualificar_lead",
          "consultar_agendas",
          "verificar_horarios_reuniao",
          "agendar_reuniao"
        ])]
      );
      const repository = new MessageRepository(pool);
      const gateway = {
        sendText: vi.fn().mockResolvedValue({ externalId: `sent-${randomUUID()}` }),
        sendPresence: vi.fn().mockResolvedValue(undefined),
        markMessageAsRead: vi.fn().mockResolvedValue(undefined),
        setPresence: vi.fn().mockResolvedValue(undefined)
      };
      const ai = { complete: vi.fn().mockImplementation(async () => ({
        text: "Qual desses horários você prefere?",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0
      })) };
      const processor = new MessageProcessor(repository, gateway, ai);

      const ambiguousPhone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
      await pool.query(
        `INSERT INTO scheduling_leads(tenant_id,phone,name,source,status,qualification_stars)
         VALUES($1,$2,'Lead política','whatsapp','qualificado',4)`,
        [policyTenantId, ambiguousPhone]
      );
      const conversation = await pool.query<{ id: string }>(
        "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3) RETURNING id",
        [policyTenantId, policySession.rows[0].id, ambiguousPhone]
      );
      await pool.query(
        "INSERT INTO messages(conversation_id,sender,content,external_message_id) VALUES($1,'agent',$2,$3)",
        [conversation.rows[0].id, "Tenho 14h, 15h e 16h. Qual fica melhor?", `offer-${randomUUID()}`]
      );
      await expect(processor.process({
        externalId: `ambiguous-${randomUUID()}`,
        tenantId: policyTenantId,
        sessionId: policySession.rows[0].id,
        contactPhone: ambiguousPhone,
        text: "sim"
      })).resolves.toBe("answered");
      const ambiguousInput = ai.complete.mock.calls.at(-1)![0];
      expect(ambiguousInput.tools.map((item: { function: { name: string } }) => item.function.name))
        .not.toEqual(expect.arrayContaining(["verificar_horarios_reuniao", "agendar_reuniao"]));

      await expect(processor.process({
        externalId: `unknown-${randomUUID()}`,
        tenantId: policyTenantId,
        sessionId: policySession.rows[0].id,
        contactPhone: `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
        text: "Vocês trabalham com plano Mutu Magic?"
      })).resolves.toBe("answered");
      expect(ai.complete.mock.calls.at(-1)![0].toolChoice)
        .toEqual({ type: "function", function: { name: "pesquisar_contexto" } });

      const prerequisitePhone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
      await expect(processor.process({
        externalId: `prerequisite-${randomUUID()}`,
        tenantId: policyTenantId,
        sessionId: policySession.rows[0].id,
        contactPhone: prerequisitePhone,
        text: "Quero agendar uma reunião"
      })).resolves.toBe("answered");
      const registeredConversationInput = ai.complete.mock.calls.at(-1)![0];
      expect(registeredConversationInput.toolChoice)
        .toEqual({ type: "function", function: { name: "registrar_lead" } });
      expect(registeredConversationInput.tools.map((item: { function: { name: string } }) => item.function.name))
        .toContain("qualificar_lead");
      const autoLinked = await pool.query<{ lead_count: number; linked_count: number }>(
        `SELECT count(DISTINCT lead.id)::int lead_count,
                count(DISTINCT conversation.lead_id)::int linked_count
         FROM scheduling_leads lead
         JOIN conversations conversation
           ON conversation.lead_id=lead.id AND conversation.tenant_id=lead.tenant_id
         WHERE lead.tenant_id=$1 AND lead.phone=$2`,
        [policyTenantId, prerequisitePhone]
      );
      expect(autoLinked.rows[0]).toEqual({ lead_count: 1, linked_count: 1 });
    } finally {
      await pool.query("DELETE FROM tenants WHERE id=$1", [policyTenantId]);
    }
  });

  it("preserves conversation history after the agent configuration is edited", async () => {
    const repository = new MessageRepository(pool);
    const contactPhone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const first = await repository.recordInboundAndLoadContext({
      externalId: `before-config-${randomUUID()}`, tenantId, sessionId, contactPhone, text: "Quero um iPhone 12 branco"
    });
    expect(first).not.toBeNull();
    await repository.recordAgentReply({
      tenantId, sessionId, conversationId: first!.conversationId, text: "Você prefere 128 ou 256 GB?", model: "test/model",
      externalId: `reply-${randomUUID()}`, inboundExternalId: `before-config-${randomUUID()}`,
      inputTokens: 1, outputTokens: 1, costUsd: 0
    });
    await pool.query("UPDATE agent_configs SET updated_at = now() + interval '1 second' WHERE tenant_id=$1", [tenantId]);

    const context = await repository.recordInboundAndLoadContext({
      externalId: `after-config-${randomUUID()}`, tenantId, sessionId, contactPhone, text: "256 GB"
    });

    expect(context?.history).toEqual([
      { role: "user", content: "Quero um iPhone 12 branco" },
      { role: "assistant", content: "Você prefere 128 ou 256 GB?" },
      { role: "user", content: "256 GB" }
    ]);
  });

  it("loads the persisted lead qualification into the conversation context", async () => {
    const repository = new MessageRepository(pool);
    const contactPhone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const lead = await pool.query<{ id: string }>(
      `INSERT INTO scheduling_leads
         (tenant_id,phone,name,source,status,qualification_stars,qualification_answers,
          qualification_summary,qualification_reason,qualification_evaluated_at)
       VALUES($1,$2,'Lead qualificado','whatsapp','qualificado',4,
              '{"ticket_medio":"R$ 7.900 a R$ 9.900","cidade":"Porto Alegre","decisor_comercial":"sim, sou eu"}'::jsonb,
              'Oportunidade viável','Contexto suficiente',now())
       RETURNING id`,
      [tenantId, contactPhone]
    );
    const unitId = `agenda-${randomUUID()}`;
    await pool.query(
      `INSERT INTO scheduling_units
         (tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity)
       VALUES($1,$2,'Agenda de teste','09:00','18:00',ARRAY[1,2,3,4,5]::smallint[],60,1)`,
      [tenantId, unitId]
    );
    const appointment = await pool.query<{ id: string }>(
      `INSERT INTO scheduling_appointments(lead_id,tenant_id,unit_id,start_at,end_at,status)
       VALUES($1,$2,$3,'2030-01-07T13:00:00.000Z','2030-01-07T14:00:00.000Z','confirmado')
       RETURNING id`,
      [lead.rows[0].id, tenantId, unitId]
    );

    const context = await repository.recordInboundAndLoadContext({
      externalId: `qualified-${randomUUID()}`, tenantId, sessionId, contactPhone, text: "Pode confirmar às 10h"
    });

    expect(context).toMatchObject({
      leadStatus: "qualificado",
      leadQualificationStars: 4,
      registeredLead: {
        id: lead.rows[0].id,
        name: "Lead qualificado",
        source: "whatsapp",
        status: "qualificado",
        facebookAttribution: {},
        // Proves the fields the qualificar_lead tool schema now accepts
        // (ticket_medio, cidade, decisor_comercial) survive the round trip
        // schema -> executor -> persistence -> retrieval into the next turn's context.
        qualificationAnswers: {
          ticket_medio: "R$ 7.900 a R$ 9.900",
          cidade: "Porto Alegre",
          decisor_comercial: "sim, sou eu"
        }
      },
      activeAppointment: {
        id: appointment.rows[0].id,
        start: "2030-01-07T13:00:00+00:00",
        status: "confirmado",
        unitId
      }
    });
  });

  it("does not expose an appointment that has already ended as active AI context", async () => {
    const repository = new MessageRepository(pool);
    const contactPhone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const lead = await pool.query<{ id: string }>(
      "INSERT INTO scheduling_leads(tenant_id,phone,source,status) VALUES($1,$2,'whatsapp','qualificado') RETURNING id",
      [tenantId, contactPhone]
    );
    const unitId = `agenda-${randomUUID()}`;
    await pool.query(
      `INSERT INTO scheduling_units
         (tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity)
       VALUES($1,$2,'Agenda passada','09:00','18:00',ARRAY[1,2,3,4,5]::smallint[],60,1)`,
      [tenantId, unitId]
    );
    await pool.query(
      `INSERT INTO scheduling_appointments(lead_id,tenant_id,unit_id,start_at,end_at,status)
       VALUES($1,$2,$3,now()-interval '2 hours',now()-interval '1 hour','confirmado')`,
      [lead.rows[0].id, tenantId, unitId]
    );

    const context = await repository.recordInboundAndLoadContext({
      externalId: `past-appointment-${randomUUID()}`, tenantId, sessionId, contactPhone, text: "como vai?"
    });
    expect(context?.activeAppointment).toBeUndefined();
  });

  it("shares budget within one AI turn id and starts a new budget for manual recovery", async () => {
    const repository = new MessageRepository(pool);
    const conversation = await pool.query<{ id: string }>(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3) RETURNING id",
      [tenantId, sessionId, `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`]
    );
    const messageRow = await pool.query<{ id: string }>(
      "INSERT INTO messages(conversation_id,sender,content,external_message_id) VALUES($1,'contact','Oi',$2) RETURNING id",
      [conversation.rows[0].id, `budget-${randomUUID()}`]
    );
    const automaticTurnId = randomUUID();
    const manualTurnId = randomUUID();
    await repository.recordAiUsage({
      tenantId, conversationId: conversation.rows[0].id, messageId: messageRow.rows[0].id,
      requestId: automaticTurnId, providerRequestId: `gen-${randomUUID()}`, model: "test/model",
      inputTokens: 30, outputTokens: 3, costUsd: 0.001
    });
    await repository.recordAiUsage({
      tenantId, conversationId: conversation.rows[0].id, messageId: messageRow.rows[0].id,
      requestId: automaticTurnId, providerRequestId: `gen-${randomUUID()}`, model: "test/model",
      inputTokens: 40, outputTokens: 4, costUsd: 0.002
    });
    await repository.recordAiUsage({
      tenantId, conversationId: conversation.rows[0].id, messageId: messageRow.rows[0].id,
      requestId: manualTurnId, providerRequestId: `gen-${randomUUID()}`, model: "test/model",
      inputTokens: 10, outputTokens: 1, costUsd: 0.0005
    });

    await expect(repository.getAiUsageTotals({
      tenantId, conversationId: conversation.rows[0].id, messageId: messageRow.rows[0].id, requestId: automaticTurnId
    })).resolves.toEqual({ providerRequests: 2, inputTokens: 70, outputTokens: 7, costUsd: 0.003 });
    await expect(repository.getAiUsageTotals({
      tenantId, conversationId: conversation.rows[0].id, messageId: messageRow.rows[0].id, requestId: manualTurnId
    })).resolves.toEqual({ providerRequests: 1, inputTokens: 10, outputTokens: 1, costUsd: 0.0005 });
  });

  it("cancels follow-up scheduling once the conversation has an active appointment", async () => {
    await pool.query(
      `INSERT INTO tenant_ai_settings(
         tenant_id,media_fallback_audio,media_fallback_image,media_fallback_document,
         ai_follow_up_enabled,ai_follow_up_delays_minutes
       )
       VALUES($1,'audio','imagem','documento',true,ARRAY[120,1440])
       ON CONFLICT(tenant_id) DO UPDATE SET ai_follow_up_enabled=true,ai_follow_up_delays_minutes=EXCLUDED.ai_follow_up_delays_minutes`,
      [tenantId]
    );
    const contactPhone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const conversation = await pool.query<{ id: string }>(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3) RETURNING id",
      [tenantId, sessionId, contactPhone]
    );
    const firstAgent = await pool.query<{ id: string; created_at: Date }>(
      "INSERT INTO messages(conversation_id,sender,content,external_message_id) VALUES($1,'agent','Escolha um horário',$2) RETURNING id,created_at",
      [conversation.rows[0].id, `follow-before-${randomUUID()}`]
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      expect(await scheduleAiFollowUpsAfterAgentReply(client, {
        tenantId, conversationId: conversation.rows[0].id,
        agentMessageId: firstAgent.rows[0].id, sentAt: firstAgent.rows[0].created_at
      })).not.toBeNull();
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const lead = await pool.query<{ id: string }>(
      `INSERT INTO scheduling_leads(tenant_id,phone,source,status)
       VALUES($1,$2,'whatsapp','agendado')
       ON CONFLICT(tenant_id,phone) DO UPDATE SET status='agendado'
       RETURNING id`,
      [tenantId, contactPhone]
    );
    const unitId = `agenda-${randomUUID()}`;
    await pool.query(
      `INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity)
       VALUES($1,$2,'Agenda follow-up','09:00','18:00',ARRAY[1,2,3,4,5]::smallint[],60,1)`,
      [tenantId, unitId]
    );
    await pool.query(
      `INSERT INTO scheduling_appointments(lead_id,tenant_id,unit_id,start_at,end_at,status)
       VALUES($1,$2,$3,now()+interval '1 day',now()+interval '1 day 1 hour','confirmado')`,
      [lead.rows[0].id, tenantId, unitId]
    );
    const confirmedAgent = await pool.query<{ id: string; created_at: Date }>(
      "INSERT INTO messages(conversation_id,sender,content,external_message_id) VALUES($1,'agent','Agendamento confirmado',$2) RETURNING id,created_at",
      [conversation.rows[0].id, `follow-after-${randomUUID()}`]
    );
    const confirmClient = await pool.connect();
    try {
      await confirmClient.query("BEGIN");
      expect(await scheduleAiFollowUpsAfterAgentReply(confirmClient, {
        tenantId, conversationId: conversation.rows[0].id,
        agentMessageId: confirmedAgent.rows[0].id, sentAt: confirmedAgent.rows[0].created_at
      })).toBeNull();
      await confirmClient.query("COMMIT");
    } catch (error) {
      await confirmClient.query("ROLLBACK");
      throw error;
    } finally {
      confirmClient.release();
    }
    await expect(pool.query(
      "SELECT status,cancellation_reason FROM ai_follow_up_schedules WHERE conversation_id=$1",
      [conversation.rows[0].id]
    )).resolves.toMatchObject({ rows: [{ status: "cancelled", cancellation_reason: "appointment_active" }] });
  });

  it("bounds recent model history to 40 messages", async () => {
    const repository = new MessageRepository(pool);
    const contactPhone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const conversation = await pool.query<{ id: string }>(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3) RETURNING id",
      [tenantId, sessionId, contactPhone]
    );
    for (let index = 1; index <= 40; index += 1) {
      await pool.query(
        "INSERT INTO messages(conversation_id,sender,content,external_message_id) VALUES($1,$2,$3,$4)",
        [conversation.rows[0].id, index % 2 ? "contact" : "agent", `mensagem-${index}`, `history-${randomUUID()}`]
      );
    }

    const context = await repository.recordInboundAndLoadContext({
      externalId: `current-${randomUUID()}`, tenantId, sessionId, contactPhone, text: "mensagem-atual"
    });

    expect(context?.history).toHaveLength(40);
    expect(context?.history[0]).toMatchObject({ content: "mensagem-2" });
    expect(context?.history.at(-1)).toEqual({ role: "user", content: "mensagem-atual" });
  });

  it("pre-limits more than 500 persisted candidates while preserving stable ties, current message and sticker filtering", async () => {
    const repository = new MessageRepository(pool);
    const contactPhone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const conversation = await pool.query<{ id: string }>(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3) RETURNING id",
      [tenantId, sessionId, contactPhone]
    );
    const prefix = `bulk-history-${randomUUID()}-`;
    await pool.query(
      `INSERT INTO messages(conversation_id,sender,content,external_message_id,created_at)
       SELECT $1,CASE WHEN n%2=0 THEN 'agent' ELSE 'contact' END,
              'empatada-'||n,$2||n,'2025-01-01T12:00:00Z'::timestamptz
       FROM generate_series(1,604) n`,
      [conversation.rows[0].id, prefix]
    );
    await pool.query(
      `INSERT INTO messages(conversation_id,sender,content,external_message_id,media_is_sticker,created_at)
       VALUES($1,'agent','sticker-fora-do-historico',$2,true,'2025-01-01T12:00:00Z')`,
      [conversation.rows[0].id, `${prefix}sticker`]
    );

    const context = await repository.recordInboundAndLoadContext({
      externalId: `current-${randomUUID()}`, tenantId, sessionId, contactPhone, text: "mensagem-atual-empatada"
    });
    const expected = await pool.query<{ sender: string; content: string }>(
      `SELECT sender,content FROM messages
       WHERE conversation_id=$1 AND NOT(sender='agent' AND media_is_sticker)
       ORDER BY created_at DESC,id DESC LIMIT 40`,
      [conversation.rows[0].id]
    );

    expect(context?.history).toEqual(expected.rows.reverse().map((message) => ({
      role: message.sender === "contact" ? "user" : "assistant",
      content: message.content
    })));
    expect(context?.history).toHaveLength(40);
    expect(context?.history.at(-1)).toEqual({ role: "user", content: "mensagem-atual-empatada" });
    expect(context?.history.some(({ content }) => content === "sticker-fora-do-historico")).toBe(false);
  });

  it("applies the character budget after selecting recent messages", async () => {
    const repository = new MessageRepository(pool);
    const contactPhone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const conversation = await pool.query<{ id: string }>(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3) RETURNING id",
      [tenantId, sessionId, contactPhone]
    );
    await pool.query(
      `INSERT INTO messages(conversation_id,sender,content,external_message_id,created_at)
       VALUES($1,'contact',$2,$3,'2025-01-01T11:00:00Z'),
             ($1,'agent',$4,$5,'2025-01-01T12:00:00Z')`,
      [conversation.rows[0].id, "a".repeat(13_000), `budget-old-${randomUUID()}`,
        "b".repeat(13_000), `budget-new-${randomUUID()}`]
    );

    const context = await repository.recordInboundAndLoadContext({
      externalId: `budget-current-${randomUUID()}`, tenantId, sessionId, contactPhone, text: "mensagem-atual"
    });

    expect(context?.history).toHaveLength(1);
    expect(context?.history.at(-1)).toEqual({ role: "user", content: "mensagem-atual" });
  });

  it("limits contact read receipts to messages created through the current inbound", async () => {
    const repository = new MessageRepository(pool);
    const contactPhone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const conversation = await pool.query<{ id: string }>(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3) RETURNING id",
      [tenantId, sessionId, contactPhone]
    );
    const previousId = `read-previous-${randomUUID()}`;
    const currentId = `read-current-${randomUUID()}`;
    const laterId = `read-later-${randomUUID()}`;
    await pool.query(
      `INSERT INTO messages(conversation_id,sender,content,external_message_id,provider_message_key,created_at)
       VALUES
         ($1,'contact','anterior',$2,$5,now() - interval '2 seconds'),
         ($1,'contact','atual',$3,$6,now() - interval '1 second'),
         ($1,'contact','posterior',$4,$7,now())`,
      [
        conversation.rows[0].id,
        previousId,
        currentId,
        laterId,
        `${tenantId}:${sessionId}:${previousId}`,
        `${tenantId}:${sessionId}:${currentId}`,
        `${tenantId}:${sessionId}:${laterId}`
      ]
    );

    await expect(repository.findUnreadContactMessages(conversation.rows[0].id, currentId))
      .resolves.toEqual([previousId, currentId]);

    await repository.markContactMessagesRead(conversation.rows[0].id, [previousId, currentId]);
    const statuses = await pool.query<{ external_message_id: string; status: string }>(
      `SELECT external_message_id, status FROM messages
       WHERE conversation_id=$1 ORDER BY created_at`,
      [conversation.rows[0].id]
    );
    expect(statuses.rows).toEqual([
      { external_message_id: previousId, status: "read" },
      { external_message_id: currentId, status: "read" },
      { external_message_id: laterId, status: "sent" }
    ]);
  });

  it("drains pending text fragments and marks the whole AI batch as processed", async () => {
    const repository = new MessageRepository(pool);
    const contactPhone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const conversation = await pool.query<{ id: string }>(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3) RETURNING id",
      [tenantId, sessionId, contactPhone]
    );
    const currentId = `batch-current-${randomUUID()}`;
    const laterId = `batch-later-${randomUUID()}`;
    const mediaId = `batch-media-${randomUUID()}`;
    await pool.query(
      `INSERT INTO messages(conversation_id,sender,content,media_type,external_message_id,provider_message_key,created_at)
       VALUES
         ($1,'contact','me chamo',NULL,$2,$5,now() - interval '2 seconds'),
         ($1,'contact','arthur',NULL,$3,$6,now() - interval '1 second'),
         ($1,'contact','foto','image',$4,$7,now())`,
      [
        conversation.rows[0].id,
        currentId,
        laterId,
        mediaId,
        `${tenantId}:${sessionId}:${currentId}`,
        `${tenantId}:${sessionId}:${laterId}`,
        `${tenantId}:${sessionId}:${mediaId}`
      ]
    );

    await expect(repository.findPendingContactTextMessages(conversation.rows[0].id, currentId))
      .resolves.toEqual([
        { externalId: currentId, text: "me chamo" },
        { externalId: laterId, text: "arthur" }
      ]);

    await repository.recordAgentReply({
      tenantId,
      sessionId,
      conversationId: conversation.rows[0].id,
      text: "Resposta ao lote",
      model: "test/model",
      externalId: `batch-reply-${randomUUID()}`,
      inboundExternalId: currentId,
      inboundExternalIds: [currentId, laterId]
    });

    const processed = await pool.query<{ external_message_id: string; processed: boolean }>(
      `SELECT external_message_id, processed_at IS NOT NULL AS processed
       FROM messages WHERE external_message_id=ANY($1::text[]) ORDER BY created_at`,
      [[currentId, laterId, mediaId]]
    );
    expect(processed.rows).toEqual([
      { external_message_id: currentId, processed: true },
      { external_message_id: laterId, processed: true },
      { external_message_id: mediaId, processed: false }
    ]);
  });

  it("marks processed contact messages by provider key instead of bare external id", async () => {
    const repository = new MessageRepository(pool);
    const otherSession = await pool.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions (tenant_id, phone_number) VALUES ($1, $2) RETURNING id",
      [tenantId, "5511777777788"]
    );
    const sharedExternalId = `shared-${randomUUID()}`;
    const firstConversation = await pool.query<{ id: string }>(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3) RETURNING id",
      [tenantId, sessionId, `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`]
    );
    const secondConversation = await pool.query<{ id: string }>(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3) RETURNING id",
      [tenantId, otherSession.rows[0].id, `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`]
    );
    await pool.query(
      `INSERT INTO messages(conversation_id,sender,content,external_message_id,provider_message_key)
       VALUES
         ($1,'contact','sessao principal',$3,$4),
         ($2,'contact','outra sessao',$3,$5)`,
      [
        firstConversation.rows[0].id,
        secondConversation.rows[0].id,
        sharedExternalId,
        `${tenantId}:${sessionId}:${sharedExternalId}`,
        `${tenantId}:${otherSession.rows[0].id}:${sharedExternalId}`
      ]
    );

    await repository.recordAgentReply({
      tenantId,
      sessionId,
      conversationId: firstConversation.rows[0].id,
      text: "Resposta ao escopo correto",
      model: "test/model",
      externalId: `reply-${randomUUID()}`,
      inboundExternalId: sharedExternalId
    });

    const processed = await pool.query<{ provider_message_key: string; processed: boolean }>(
      `SELECT provider_message_key, processed_at IS NOT NULL AS processed
       FROM messages WHERE external_message_id=$1 AND sender='contact' ORDER BY provider_message_key`,
      [sharedExternalId]
    );
    expect(processed.rows).toHaveLength(2);
    expect(processed.rows).toEqual(expect.arrayContaining([
      { provider_message_key: `${tenantId}:${otherSession.rows[0].id}:${sharedExternalId}`, processed: false },
      { provider_message_key: `${tenantId}:${sessionId}:${sharedExternalId}`, processed: true }
    ]));
  });

  it("delivers a job through Redis/BullMQ", async () => {
    const queueName = `phase1-smoke-${randomUUID()}`;
    const queue = new Queue<{ value: number }>(queueName, { connection: redisConnection });
    const worker = new Worker<{ value: number }, number>(queueName, async (job) => job.data.value * 2, { connection: redisConnection });
    try {
      await Promise.all([queue.waitUntilReady(), worker.waitUntilReady()]);
      const jobId = `phase1-smoke-job-${randomUUID()}`;
      const completed = new Promise<number>((resolve, reject) => {
        const onCompleted = (job: { id?: string | number }, result: number) => {
          if (job.id !== jobId) return;
          cleanup();
          resolve(result);
        };
        const onFailed = (job: { id?: string | number } | undefined, error: Error) => {
          if (job?.id !== jobId) return;
          cleanup();
          reject(error);
        };
        const cleanup = () => {
          worker.off("completed", onCompleted);
          worker.off("failed", onFailed);
        };

        worker.on("completed", onCompleted);
        worker.on("failed", onFailed);
      });
      await queue.add("double", { value: 21 }, { jobId });
      await expect(completed).resolves.toBe(42);
    } finally {
      await worker.close();
      await queue.close();
    }
  });

  it("enforces the sliding-window limit atomically under concurrency", async () => {
    const key = `concurrent-${randomUUID()}`;
    const decisions = await Promise.all(Array.from({ length: 20 }, () => consumeRateLimitRedis(key, 5, 10_000)));
    expect(decisions.filter(Boolean)).toHaveLength(5);
  });

  it("rejects a session from another tenant without creating a conversation", async () => {
    const otherTenant = await pool.query<{ id: string }>("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [`other-${randomUUID()}`]);
    const otherSession = await pool.query<{ id: string }>("INSERT INTO whatsapp_sessions (tenant_id) VALUES ($1) RETURNING id", [otherTenant.rows[0].id]);
    const otherConversation = await pool.query<{ id: string }>("INSERT INTO conversations (tenant_id, session_id, contact_phone) VALUES ($1,$2,$3) RETURNING id", [otherTenant.rows[0].id, otherSession.rows[0].id, "5511877777777"]);
    const repository = new MessageRepository(pool);
    await expect(repository.recordInboundAndLoadContext({
      externalId: `cross-${randomUUID()}`, tenantId, sessionId: otherSession.rows[0].id,
      contactPhone: "5511888888888", text: "tentativa cruzada"
    })).rejects.toThrow("Session does not belong to tenant");
    const leaked = await pool.query("SELECT 1 FROM conversations WHERE tenant_id = $1 AND contact_phone = $2", [tenantId, "5511888888888"]);
    expect(leaked.rowCount).toBe(0);
    await expect(repository.recordAgentReply({ tenantId, sessionId, conversationId: otherConversation.rows[0].id, text: "não gravar", model: "test/model", externalId: `cross-reply-${randomUUID()}`, inboundExternalId: `cross-inbound-${randomUUID()}`, inputTokens: 1, outputTokens: 1, costUsd: 0.01 })).rejects.toThrow("Conversation does not belong to tenant");
    const crossUsage = await pool.query("SELECT 1 FROM usage_logs WHERE tenant_id=$1 AND conversation_id=$2", [tenantId, otherConversation.rows[0].id]);
    expect(crossUsage.rowCount).toBe(0);
    await pool.query("DELETE FROM tenants WHERE id = $1", [otherTenant.rows[0].id]);
  });

  it("persists handoff and only allows the owning tenant to reactivate", async () => {
    const gateway = {
      sendText: vi.fn().mockResolvedValue({ externalId: `notice-${randomUUID()}` }),
      sendPresence: vi.fn().mockResolvedValue(undefined),
      markMessageAsRead: vi.fn().mockResolvedValue(undefined),
      setPresence: vi.fn().mockResolvedValue(undefined)
    };
    const ai = { complete: vi.fn() };
    const repository = new MessageRepository(pool);
    const processor = new MessageProcessor(repository, gateway, ai as never);
    await expect(processor.process({
      externalId: `handoff-${randomUUID()}`, tenantId, sessionId,
      contactPhone: "5511900000001", contactName: "Contato", text: "Quero falar com um atendente"
    })).resolves.toBe("handoff");
    const conversation = await pool.query<{ id: string; ai_active: boolean; handoff_reason: string }>(
      "SELECT id, ai_active, handoff_reason FROM conversations WHERE tenant_id = $1 AND contact_phone = $2",
      [tenantId, "5511900000001"]
    );
    expect(conversation.rows[0]).toMatchObject({ ai_active: false, handoff_reason: "contact_requested" });
    expect(gateway.sendText).toHaveBeenCalledWith(sessionId, "5511666666666", expect.any(String));
    const notification = await pool.query<{ status: string; external_message_id: string | null }>(
      "SELECT status, external_message_id FROM handoff_notifications WHERE conversation_id=$1",
      [conversation.rows[0].id]
    );
    expect(notification.rows[0]).toMatchObject({ status: "sent" });
    expect(notification.rows[0].external_message_id).toMatch(/^notice-/);
    expect(await repository.reactivate(randomUUID(), conversation.rows[0].id)).toBe(false);
    expect(await repository.reactivate(tenantId, conversation.rows[0].id)).toBe(true);
  });

  it("keeps a durable pending handoff notification when queue dispatch fails", async () => {
    const gateway = {
      sendText: vi.fn().mockResolvedValue({ externalId: `notice-${randomUUID()}` }),
      sendPresence: vi.fn().mockResolvedValue(undefined),
      markMessageAsRead: vi.fn().mockResolvedValue(undefined),
      setPresence: vi.fn().mockResolvedValue(undefined)
    };
    const dispatcher = vi.fn().mockRejectedValue(new Error("redis unavailable"));
    const repository = new MessageRepository(pool);
    const processor = new MessageProcessor(repository, gateway, { complete: vi.fn() } as never, dispatcher);
    const contactPhone = "5511900000011";
    await expect(processor.process({
      externalId: `handoff-pending-${randomUUID()}`, tenantId, sessionId,
      contactPhone, contactName: "Contato pendente", text: "Preciso falar com uma pessoa"
    })).rejects.toThrow("redis unavailable");

    const result = await pool.query<{ ai_active: boolean; status: string; attempts: number }>(
      `SELECT c.ai_active, n.status, n.attempts
       FROM conversations c JOIN handoff_notifications n ON n.conversation_id=c.id
       WHERE c.tenant_id=$1 AND c.contact_phone=$2`,
      [tenantId, contactPhone]
    );
    expect(result.rows[0]).toEqual({ ai_active: false, status: "pending", attempts: 0 });
    expect(gateway.sendText).not.toHaveBeenCalled();
  });

  it("treats the conversation as inactive while the global agent switch is off", async () => {
    const repository = new MessageRepository(pool);
    const inbound = {
      externalId: `global-off-${randomUUID()}`, tenantId, sessionId,
      contactPhone: "5511900000099", text: "Esta mensagem não deve acionar a IA"
    };
    await pool.query("UPDATE agent_configs SET is_active=false WHERE tenant_id=$1", [tenantId]);
    try {
      const context = await repository.recordInboundAndLoadContext(inbound);
      expect(context?.aiActive).toBe(false);
    } finally {
      await pool.query("UPDATE agent_configs SET is_active=true WHERE tenant_id=$1", [tenantId]);
    }
  });

  it("pauses a conversation even when no external attendant number is configured", async () => {
    const isolatedTenant = await pool.query<{ id: string }>("INSERT INTO tenants(name) VALUES($1) RETURNING id", [`no-attendant-${randomUUID()}`]);
    try {
      const isolatedSession = await pool.query<{ id: string }>("INSERT INTO whatsapp_sessions(tenant_id) VALUES($1) RETURNING id", [isolatedTenant.rows[0].id]);
      const conversation = await pool.query<{ id: string }>(
        "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3) RETURNING id",
        [isolatedTenant.rows[0].id, isolatedSession.rows[0].id, "5511666666666"]
      );
      const repository = new MessageRepository(pool);
      await expect(repository.pauseForHandoff({
        tenantId: isolatedTenant.rows[0].id,
        conversationId: conversation.rows[0].id,
        sessionId: isolatedSession.rows[0].id,
        reason: "contact_requested",
        idempotencyKey: `test-${randomUUID()}`,
        notificationText: "Solicitação de atendimento"
      })).resolves.toBeNull();
      const state = await pool.query<{ ai_active: boolean; handoff_reason: string | null }>("SELECT ai_active,handoff_reason FROM conversations WHERE id=$1", [conversation.rows[0].id]);
      expect(state.rows[0]).toEqual({ ai_active: false, handoff_reason: "contact_requested" });
      const alert = await pool.query<{ message: string }>(
        "SELECT message FROM system_alerts WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1",
        [isolatedTenant.rows[0].id]
      );
      expect(alert.rows[0]?.message).toMatch(/não possui telefone de atendente válido/);
    } finally {
      await pool.query("DELETE FROM tenants WHERE id=$1", [isolatedTenant.rows[0].id]);
    }
  });

  it("retries an unprocessed inbound message after an external failure", async () => {
    const externalId = `retry-${randomUUID()}`;
    const gateway = {
      sendText: vi.fn().mockResolvedValue({ externalId: `sent-${randomUUID()}` }),
      sendPresence: vi.fn().mockResolvedValue(undefined),
      markMessageAsRead: vi.fn().mockResolvedValue(undefined),
      setPresence: vi.fn().mockResolvedValue(undefined)
    };
    const failingAi = { complete: vi.fn().mockRejectedValue(new Error("temporary provider failure")) };
    const repository = new MessageRepository(pool);
    const inbound = { externalId, tenantId, sessionId, contactPhone: "5511900000002", text: "Mensagem para retry" };
    await expect(new MessageProcessor(repository, gateway, failingAi).process(inbound)).rejects.toThrow("temporary provider failure");
    const pending = await pool.query<{ processed_at: Date | null }>("SELECT processed_at FROM messages WHERE external_message_id=$1", [externalId]);
    expect(pending.rows[0].processed_at).toBeNull();

    const successfulAi = { complete: vi.fn().mockResolvedValue({ text: "Retry concluído", inputTokens: 6, outputTokens: 2, costUsd: 0.001 }) };
    await expect(new MessageProcessor(repository, gateway, successfulAi).process(inbound)).resolves.toBe("answered");
    const processed = await pool.query<{ processed_at: Date | null }>("SELECT processed_at FROM messages WHERE external_message_id=$1", [externalId]);
    expect(processed.rows[0].processed_at).not.toBeNull();
    expect(successfulAi.complete).toHaveBeenCalledTimes(1);
  }, 10000);

  it("claims an inbound message once while concurrent duplicate jobs are running", async () => {
    const externalId = `concurrent-${randomUUID()}`;
    const gateway = {
      sendText: vi.fn().mockResolvedValue({ externalId: `sent-${randomUUID()}` }),
      sendPresence: vi.fn().mockResolvedValue(undefined),
      markMessageAsRead: vi.fn().mockResolvedValue(undefined),
      setPresence: vi.fn().mockResolvedValue(undefined)
    };
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const ai = { complete: vi.fn().mockImplementation(async () => {
      await blocked;
      return { text: "Resposta única", inputTokens: 2, outputTokens: 2, costUsd: 0 };
    }) };
    const inbound = { externalId, tenantId, sessionId, contactPhone: "5511900000004", text: "Mensagem duplicada" };
    const processor = new MessageProcessor(new MessageRepository(pool), gateway, ai);

    const first = processor.process(inbound);
    await vi.waitFor(() => expect(ai.complete).toHaveBeenCalledTimes(1));
    await expect(processor.process(inbound)).resolves.toBe("duplicate");
    finish();
    await expect(first).resolves.toBe("answered");

    expect(ai.complete).toHaveBeenCalledTimes(1);
    expect(gateway.sendText).toHaveBeenCalledTimes(1);
  }, 10000);

  it("reclassifies an API echo as agent without duplicating phone history", async () => {
    const repository = new MessageRepository(pool);
    const externalId = `echo-${randomUUID()}`;
    const contactPhone = "5511900000003";
    await repository.recordHuman({ kind: "human", externalId, tenantId, sessionId, contactPhone, text: "eco temporário" });
    const conversation = await pool.query<{ id: string }>(
      "SELECT id FROM conversations WHERE tenant_id=$1 AND contact_phone=$2", [tenantId, contactPhone]
    );
    await repository.recordAgentReply({ tenantId, sessionId, conversationId: conversation.rows[0].id,
      text: "resposta da IA", model: "test/model", externalId, inboundExternalId: `missing-${randomUUID()}`,
      inputTokens: 1, outputTokens: 1, costUsd: 0 });
    const messages = await pool.query<{ sender: string; content: string }>(
      "SELECT sender, content FROM messages WHERE provider_message_key=$1", [`${tenantId}:${sessionId}:${externalId}`]
    );
    expect(messages.rows).toEqual([{ sender: "agent", content: "resposta da IA" }]);
  });
});
