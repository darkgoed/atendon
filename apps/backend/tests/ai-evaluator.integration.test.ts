import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import {
  AiAttendanceEvaluator,
  findAutomaticEvaluationJobs
} from "../src/modules/agent-improvement/evaluator.js";
import type { AiRouter } from "../src/modules/ai-router/openrouter.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
let phoneSequence = Number(Date.now().toString().slice(-8));
const nextPhone = () => `5511${String(++phoneSequence).slice(-8).padStart(8, "0")}`;
let tenantId = "";
let sessionId = "";
let conversationId = "";
let versionId = "";
let agentMessageId = "";

beforeAll(async () => {
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`Evaluator ${randomUUID()}`]
  )).rows[0].id;
  sessionId = (await pool.query<{ id: string }>(
    "INSERT INTO whatsapp_sessions(tenant_id) VALUES($1) RETURNING id",
    [tenantId]
  )).rows[0].id;
  const agentId = (await pool.query<{ id: string }>(
    "INSERT INTO agent_configs(tenant_id,system_prompt,ai_model) VALUES($1,'Atenda bem','model/agent') RETURNING id",
    [tenantId]
  )).rows[0].id;
  versionId = (await pool.query<{ active_version_id: string }>(
    "SELECT active_version_id FROM agent_configs WHERE id=$1",
    [agentId]
  )).rows[0].active_version_id;
  conversationId = (await pool.query<{ id: string }>(
    `INSERT INTO conversations(tenant_id,session_id,contact_phone,status)
     VALUES($1,$2,$3,'closed') RETURNING id`,
    [tenantId, sessionId, `5511${Date.now().toString().slice(-8)}`]
  )).rows[0].id;
  await pool.query(
    "INSERT INTO messages(conversation_id,sender,content) VALUES($1,'contact','Preciso de ajuda')",
    [conversationId]
  );
  agentMessageId = (await pool.query<{ id: string }>(
    `INSERT INTO messages(conversation_id,sender,content,agent_config_version_id)
     VALUES($1,'agent','Claro, vou ajudar',$2) RETURNING id`,
    [conversationId, versionId]
  )).rows[0].id;
  const qualificationJournalId = (await pool.query<{ id: string }>(
    `INSERT INTO ai_tool_call_journal(
       tenant_id,conversation_id,inbound_external_id,ai_turn_id,call_ordinal,tool_name,arguments_hash,status,result_text
     ) VALUES($1,$2,$3,$4,0,'qualificar_lead',$5,'completed',$6) RETURNING id`,
    [
      tenantId,
      conversationId,
      `evaluator-tool-${randomUUID()}`,
      randomUUID(),
      "a".repeat(64),
      JSON.stringify({
        qualificacao_registrada: true,
        segmento: "varejo",
        lead: { nome: "Ana Souza", telefone: "+55 11 99999-1234" }
      })
    ]
  )).rows[0].id;
  await pool.query(
    `INSERT INTO agent_message_transaction_claims(
       tenant_id,conversation_id,message_id,journal_id,action,claim_type,normalized_value,value_hash
     ) VALUES($1,$2,$3,$4,'qualify_lead','transaction_status','succeeded',$5)`,
    [tenantId, conversationId, agentMessageId, qualificationJournalId, "a".repeat(64)]
  );
  await pool.query(
    "UPDATE tenant_ai_settings SET evaluator_model='model/evaluator' WHERE tenant_id=$1",
    [tenantId]
  );
});

afterAll(async () => {
  if (tenantId) await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.end();
});

function validEvaluation(evidenceMessageId = agentMessageId) {
  const score = {
    score: 90,
    rationale: "Adequado para ana@example.com no telefone +55 11 99999-1234",
    evidenceMessageIds: [evidenceMessageId]
  };
  return JSON.stringify({
    scores: {
      correctness: score,
      task_completion: score,
      continuity: score,
      communication: score,
      security_privacy: score,
      tool_usage: score,
      handoff: score
    },
    violations: [{
      code: "PII_ECHO",
      dimension: "security_privacy",
      severity: "medium",
      confidence: 1,
      evidenceMessageIds: [evidenceMessageId],
      detail: "Detalhe em https://private.example com token abcdefghijklmnop"
    }],
    overallScore: 90,
    hasCriticalFailure: false,
    summary: "Atendimento de ana@example.com concluído."
  });
}

function logicalEvaluatorPayloadBytes(input: Parameters<AiRouter["complete"]>[0]): number {
  return Buffer.byteLength(JSON.stringify({
    model: input.model,
    temperature: input.temperature,
    max_tokens: input.maxTokens,
    ...(input.responseFormat ? { response_format: input.responseFormat } : {}),
    messages: [
      { role: "system", content: input.systemPrompt },
      ...input.history
    ],
    ...(input.provider ? { provider: { order: [input.provider] } } : {})
  }), "utf8");
}

describe("AI attendance evaluator", () => {
  it("uses validation feedback to correct invalid UUIDs and missing fields on the single retry", async () => {
    const invalidResponse = JSON.stringify({
      scores: {
        correctness: {
          score: 90,
          rationale: "Adequado",
          evidenceMessageIds: ["not-a-uuid"]
        }
      },
      violations: [{
        code: "PII_ECHO",
        evidenceMessageIds: ["not-a-uuid"]
      }]
    });
    const complete = vi.fn<AiRouter["complete"]>()
      .mockResolvedValueOnce({ text: invalidResponse, inputTokens: 1, outputTokens: 1, costUsd: 0 })
      .mockImplementationOnce(async (input) => {
        const evaluatorInput = String(input.history[0]?.content ?? "");
        expect(evaluatorInput).not.toContain("Ana Souza");
        expect(evaluatorInput).not.toContain("99999-1234");
        expect(evaluatorInput).toContain("varejo");
        expect(evaluatorInput).toContain("retryFeedback");
        expect(evaluatorInput).toContain("previousInvalidResponse");
        expect(evaluatorInput).toContain("scores.task_completion");
        expect(evaluatorInput).toContain("not-a-uuid");
        expect(evaluatorInput).toContain(agentMessageId);
        await input.onUsage?.({
          providerRequestId: `evaluation-${randomUUID()}`,
          model: "model/evaluator",
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0.01
        });
        return { text: validEvaluation(), inputTokens: 10, outputTokens: 5, costUsd: 0.01 };
      });
    const evaluator = new AiAttendanceEvaluator(pool, { complete }, config);
    const job = {
      tenantId,
      conversationId,
      agentConfigVersionId: versionId,
      trigger: "manual" as const
    };
    await expect(evaluator.process(job)).resolves.toBe("created");
    await expect(evaluator.process(job)).resolves.toBe("duplicate");
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0][0].responseFormat).toMatchObject({
      type: "json_schema",
      json_schema: { name: "attendance_evaluation", strict: true }
    });
    const evaluation = await pool.query(
      `SELECT evaluator_model,evaluator_prompt_version,overall_score,status,scores,violations,summary
       FROM ai_attendance_evaluations WHERE tenant_id=$1 AND conversation_id=$2`,
      [tenantId, conversationId]
    );
    expect(evaluation.rows).toEqual([expect.objectContaining({
      evaluator_model: "model/evaluator",
      evaluator_prompt_version: "v2",
      overall_score: 90,
      status: "automatic"
    })]);
    const persistedNarratives = JSON.stringify({
      scores: evaluation.rows[0].scores,
      violations: evaluation.rows[0].violations,
      summary: evaluation.rows[0].summary
    });
    expect(persistedNarratives).not.toContain("ana@example.com");
    expect(persistedNarratives).not.toContain("99999-1234");
    expect(persistedNarratives).not.toContain("private.example");
    expect(persistedNarratives).not.toContain("abcdefghijklmnop");
    expect((await pool.query(
      "SELECT purpose FROM usage_logs WHERE tenant_id=$1 AND purpose='evaluation'",
      [tenantId]
    )).rows).toEqual([{ purpose: "evaluation" }]);
  });

  it("sanitizes raw message PII, limits the SQL window and enforces global character and byte budgets before the provider", async () => {
    const maxEvaluatorBytes = 12_000;
    const limitedConversationId = (await pool.query<{ id: string }>(
      `INSERT INTO conversations(tenant_id,session_id,contact_phone,status)
       VALUES($1,$2,$3,'closed') RETURNING id`,
      [tenantId, sessionId, nextPhone()]
    )).rows[0].id;
    for (let index = 0; index < 7; index += 1) {
      await pool.query(
        "INSERT INTO messages(conversation_id,sender,content) VALUES($1,'contact',$2)",
        [limitedConversationId, `Mensagem antiga ${index} ${"x".repeat(120)}`]
      );
    }
    await pool.query(
      "INSERT INTO messages(conversation_id,sender,content) VALUES($1,'contact',$2)",
      [limitedConversationId,
        "Meu nome é Ana Souza, e-mail ana@example.com, telefone +55 11 99999-1234. Entre em https://meet.google.com/abc-defg-hij"]
    );
    const localAgentMessageId = (await pool.query<{ id: string }>(
      `INSERT INTO messages(conversation_id,sender,content,agent_config_version_id)
       VALUES($1,'agent','Vou avaliar sem reproduzir dados privados.',$2) RETURNING id`,
      [limitedConversationId, versionId]
    )).rows[0].id;
    const limitedJournalId = (await pool.query<{ id: string }>(
      `INSERT INTO ai_tool_call_journal(
         tenant_id,conversation_id,inbound_external_id,ai_turn_id,call_ordinal,tool_name,arguments_hash,status,result_text
       ) VALUES($1,$2,$3,$4,0,'agendar_reuniao',$5,'completed',$6) RETURNING id`,
      [
        tenantId,
        limitedConversationId,
        `limited-tool-${randomUUID()}`,
        randomUUID(),
        "b".repeat(64),
        JSON.stringify({
          agendamento: {
            id: randomUUID(),
            lead_id: randomUUID(),
            start: "2035-02-01T10:00:00.000Z",
            end: "2035-02-01T11:00:00.000Z",
            status: "confirmado",
            meet_link: "https://meet.google.com/private-room",
            lead_nome: "Ana Souza",
            lead_telefone: "+55 11 99999-1234",
            access_token: "secret-value"
          }
        })
      ]
    )).rows[0].id;
    await pool.query(
      `INSERT INTO agent_message_transaction_claims(
         tenant_id,conversation_id,message_id,journal_id,action,claim_type,normalized_value,value_hash
       ) VALUES($1,$2,$3,$4,'schedule_meeting','transaction_status','succeeded',$5)`,
      [tenantId, limitedConversationId, localAgentMessageId, limitedJournalId, "b".repeat(64)]
    );

    const complete = vi.fn<AiRouter["complete"]>().mockImplementation(async (input) => {
      const serialized = String(input.history[0]?.content ?? "");
      const payload = JSON.parse(serialized) as {
        conversation: Array<{ sender: string; content: string }>;
        tools: Array<{ result: string }>;
      };
      expect(payload.conversation).toHaveLength(2);
      expect(payload.conversation.at(-2)?.content).toMatch(/^<untrusted_contact_content>/);
      expect(payload.conversation.at(-2)?.content).toMatch(/<\/untrusted_contact_content>$/);
      expect(payload.conversation.reduce((total, item) => total + item.content.length, 0)).toBeLessThanOrEqual(500);
      expect(logicalEvaluatorPayloadBytes(input)).toBeLessThanOrEqual(maxEvaluatorBytes);
      for (const privateValue of [
        "Ana Souza", "ana@example.com", "99999-1234", "meet.google.com",
        "private-room", "lead_nome", "lead_telefone", "access_token", "secret-value"
      ]) {
        expect(serialized).not.toContain(privateValue);
      }
      expect(serialized).toContain("[NOME_REMOVIDO]");
      expect(serialized).toContain("[EMAIL_REMOVIDO]");
      expect(serialized).toContain("[TELEFONE_REMOVIDO]");
      expect(serialized).toContain("host_sha256=");
      expect(serialized).toContain("url_sha256=");
      expect(JSON.parse(payload.tools[0].result)).toEqual({
        agendamento: {
          start: "2035-02-01T10:00:00.000Z",
          end: "2035-02-01T11:00:00.000Z",
          status: "confirmado",
          meet_link: expect.stringMatching(/^\[URL_PRESENT host_sha256=/)
        }
      });
      return { text: validEvaluation(localAgentMessageId), inputTokens: 1, outputTokens: 1, costUsd: 0 };
    });
    const evaluator = new AiAttendanceEvaluator(pool, { complete }, config, {
      maxMessages: 2,
      maxCharacters: 500,
      maxBytes: maxEvaluatorBytes
    });

    await expect(evaluator.process({
      tenantId,
      conversationId: limitedConversationId,
      agentConfigVersionId: versionId,
      trigger: "manual"
    })).resolves.toBe("created");
    expect(complete).toHaveBeenCalledOnce();
  });

  it("reserves a second full-payload call at the byte ceiling with adversarial Unicode", async () => {
    const maxEvaluatorBytes = 12_000;
    const unicodeConversationId = (await pool.query<{ id: string }>(
      `INSERT INTO conversations(tenant_id,session_id,contact_phone,status)
       VALUES($1,$2,$3,'closed') RETURNING id`,
      [tenantId, sessionId, nextPhone()]
    )).rows[0].id;
    await pool.query(
      "INSERT INTO messages(conversation_id,sender,content) VALUES($1,'contact',$2)",
      [
        unicodeConversationId,
        `Ana Souza ana@example.com +55 11 99999-1234 https://meet.google.com/private ${"🔥漢字".repeat(4_000)}`
      ]
    );
    const unicodeAgentMessageId = (await pool.query<{ id: string }>(
      `INSERT INTO messages(conversation_id,sender,content,agent_config_version_id)
       VALUES($1,'agent',$2,$3) RETURNING id`,
      [unicodeConversationId, `Resposta segura ${"🧪界".repeat(4_000)}`, versionId]
    )).rows[0].id;

    const invalidUnicodeResponse = `{"summary":"${"🔥漢字".repeat(4_000)}`;
    const complete = vi.fn<AiRouter["complete"]>()
      .mockResolvedValueOnce({
        text: invalidUnicodeResponse,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0
      })
      .mockImplementationOnce(async (input) => {
        const serialized = String(input.history[0]?.content ?? "");
        const retryPayload = JSON.parse(serialized) as {
          retryFeedback: {
            instruction: string;
            validationErrors: string[];
            previousInvalidResponse: string;
          };
        };
        expect(retryPayload.retryFeedback.instruction).toContain("Corrija a resposta anterior");
        expect(retryPayload.retryFeedback.validationErrors).toBeInstanceOf(Array);
        expect(serialized).not.toContain("Ana Souza");
        expect(serialized).not.toContain("ana@example.com");
        expect(serialized).not.toContain("99999-1234");
        expect(serialized).not.toContain("meet.google.com");
        return {
          text: validEvaluation(unicodeAgentMessageId),
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0
        };
      });
    const evaluator = new AiAttendanceEvaluator(pool, { complete }, config, {
      maxMessages: 2,
      maxCharacters: 50_000,
      maxBytes: maxEvaluatorBytes
    });

    await expect(evaluator.process({
      tenantId,
      conversationId: unicodeConversationId,
      agentConfigVersionId: versionId,
      trigger: "manual"
    })).resolves.toBe("created");
    expect(complete).toHaveBeenCalledTimes(2);
    const requestSizes = complete.mock.calls.map(([input]) => logicalEvaluatorPayloadBytes(input));
    expect(requestSizes[0]).toBeGreaterThan(maxEvaluatorBytes - 256);
    for (const requestSize of requestSizes) {
      expect(requestSize).toBeLessThanOrEqual(maxEvaluatorBytes);
    }
  });

  it("does not run automatic evaluations while the feature is disabled", async () => {
    const complete = vi.fn<AiRouter["complete"]>();
    const evaluator = new AiAttendanceEvaluator(pool, { complete }, config);
    await expect(evaluator.process({
      tenantId,
      conversationId,
      agentConfigVersionId: versionId,
      trigger: "closed"
    })).resolves.toBe("ineligible");
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects evaluator evidence that is not part of the conversation", async () => {
    await pool.query(
      "UPDATE tenant_ai_settings SET ai_evaluations_enabled=true WHERE tenant_id=$1",
      [tenantId]
    );
    const complete = vi.fn<AiRouter["complete"]>()
      .mockResolvedValue({
        text: validEvaluation(randomUUID()),
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0
      });
    const evaluator = new AiAttendanceEvaluator(pool, { complete }, config);
    await expect(evaluator.process({
      tenantId,
      conversationId,
      agentConfigVersionId: versionId,
      trigger: "closed"
    })).rejects.toThrow("JSON inválido");
    expect(complete).toHaveBeenCalledTimes(2);
    expect((await pool.query(
      "SELECT count(*)::int count FROM ai_attendance_evaluations WHERE tenant_id=$1 AND trigger='closed'",
      [tenantId]
    )).rows[0].count).toBe(0);
  });

  it("fails after two schema-invalid responses without persisting an evaluation", async () => {
    const complete = vi.fn<AiRouter["complete"]>().mockResolvedValue({
      text: JSON.stringify({ violations: [] }),
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0
    });
    const evaluator = new AiAttendanceEvaluator(pool, { complete }, config);
    await expect(evaluator.process({
      tenantId,
      conversationId,
      agentConfigVersionId: versionId,
      trigger: "closed"
    })).rejects.toThrow("JSON inválido");
    expect(complete).toHaveBeenCalledTimes(2);
    expect((await pool.query(
      "SELECT count(*)::int count FROM ai_attendance_evaluations WHERE tenant_id=$1 AND trigger='closed'",
      [tenantId]
    )).rows[0].count).toBe(0);
  });

  it("selects and evaluates an AI provider failure even when no reply was produced", async () => {
    const failedConversationId = (await pool.query<{ id: string }>(
      `INSERT INTO conversations(tenant_id,session_id,contact_phone)
       VALUES($1,$2,$3) RETURNING id`,
      [tenantId, sessionId, nextPhone()]
    )).rows[0].id;
    const failedMessageId = (await pool.query<{ id: string }>(
      `INSERT INTO messages(conversation_id,sender,content)
       VALUES($1,'contact','Ainda preciso de ajuda') RETURNING id`,
      [failedConversationId]
    )).rows[0].id;
    await pool.query(
      `INSERT INTO ai_evaluation_signals(
         tenant_id,conversation_id,agent_config_version_id,kind
       ) VALUES($1,$2,$3,'ai_error')`,
      [tenantId, failedConversationId, versionId]
    );

    const job = (await findAutomaticEvaluationJobs(pool)).find((item) =>
      item.tenantId === tenantId && item.conversationId === failedConversationId
    );
    expect(job).toMatchObject({ trigger: "tool_error", agentConfigVersionId: versionId });

    const complete = vi.fn<AiRouter["complete"]>().mockResolvedValue({
      text: validEvaluation(failedMessageId),
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0
    });
    const evaluator = new AiAttendanceEvaluator(pool, { complete }, config);
    await expect(evaluator.process(job!)).resolves.toBe("created");
  });

  it("caps the normal closed-conversation batch at the remaining daily tenant quota", async () => {
    const quotaPrefix = "5511970000";
    await pool.query(
      `WITH conversations_inserted AS (
         INSERT INTO conversations(tenant_id,session_id,contact_phone,status)
         SELECT $1,$2,$3 || lpad(number::text,3,'0'),'closed'
         FROM generate_series(1,99) number
         RETURNING id
       )
       INSERT INTO ai_attendance_evaluations(
         tenant_id,conversation_id,agent_config_version_id,trigger,rubric_version,
         evaluator_model,evaluator_prompt_version,scores,violations,overall_score,summary
       )
       SELECT $1,id,$4,'closed','v1','model/evaluator','v1','{}','[]',80,'quota'
       FROM conversations_inserted`,
      [tenantId, sessionId, quotaPrefix, versionId]
    );
    const extraConversationId = (await pool.query<{ id: string }>(
      `INSERT INTO conversations(tenant_id,session_id,contact_phone,status)
       VALUES($1,$2,$3,'closed') RETURNING id`,
      [tenantId, sessionId, `${quotaPrefix}100`]
    )).rows[0].id;
    await pool.query(
      `INSERT INTO messages(conversation_id,sender,content,agent_config_version_id)
       VALUES($1,'agent','Resposta normal',$2)`,
      [extraConversationId, versionId]
    );

    const jobs = (await findAutomaticEvaluationJobs(pool))
      .filter((job) => job.tenantId === tenantId && job.trigger === "closed");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].conversationId).toBe(extraConversationId);
  });
});
