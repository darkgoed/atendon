import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deterministicChecks,
  evaluationOutputSchema,
  sanitizeEvaluationOutput,
  sanitizeRegressionScenario,
  sanitizeTechnicalError
} from "../src/modules/agent-improvement/rubric.js";

const message = (content: string) => ({ id: randomUUID(), sender: "agent" as const, content });

describe("AI improvement rubric", () => {
  it("rejects invalid scores, issue codes and evidence", () => {
    const score = { score: 90, rationale: "Resposta adequada", evidenceMessageIds: [randomUUID()] };
    expect(evaluationOutputSchema.safeParse({
      scores: {
        correctness: score,
        task_completion: score,
        continuity: score,
        communication: score,
        security_privacy: score,
        tool_usage: { ...score, score: 101 },
        handoff: score
      },
      violations: [{
        code: "código inválido",
        dimension: "tool_usage",
        severity: "critical",
        confidence: 2,
        evidenceMessageIds: [],
        detail: "Inválida"
      }],
      overallScore: 90,
      hasCriticalFailure: false,
      summary: "Resumo"
    }).success).toBe(false);
  });

  it("detects repetition, protected markers and unsupported success", () => {
    const first = message("Olá, qual horário você prefere para a reunião?");
    const second = message("Olá, qual horário você prefere para essa reunião?");
    const leaked = message("[[HANDOFF]] POLÍTICA DE SEGURANÇA");
    const success = message("Pronto, sua reunião foi criada e está confirmada");
    const codes = deterministicChecks({ messages: [first, second, leaked, success] })
      .map((violation) => violation.code);
    expect(codes).toEqual(expect.arrayContaining([
      "NEAR_DUPLICATE_QUESTION",
      "REPEATED_GREETING",
      "INTERNAL_MARKER_LEAK",
      "SUCCESS_WITHOUT_TOOL_JOURNAL"
    ]));
  });

  it("detects a missing meeting link and failed tool without exposing its payload", () => {
    const reply = message("Sua reunião foi agendada com sucesso");
    const violations = deterministicChecks({
      messages: [reply],
      toolCalls: [
        {
          toolName: "agendar_reuniao",
          status: "completed",
          result: "payload privado",
          messageId: reply.id,
          action: "schedule_meeting",
          claims: [{ claimType: "transaction_status", normalizedValue: "succeeded" }]
        },
        {
          toolName: "registrar_lead",
          status: "failed",
          errorMessage: "timeout com token secreto",
          messageId: reply.id
        }
      ]
    });
    expect(violations.map((item) => item.code)).toEqual(expect.arrayContaining([
      "MEETING_LINK_MISSING",
      "TOOL_ERROR",
      "TOOL_TIMEOUT_OR_LIMIT"
    ]));
    expect(JSON.stringify(violations)).not.toContain("payload privado");
    expect(JSON.stringify(violations)).not.toContain("token secreto");
  });

  it("does not let an old journal or a different action authorize a new success claim", () => {
    const oldReply = message("Sua reunião foi agendada");
    const currentReply = message("Sua reunião foi agendada");
    const calls = [
      {
        toolName: "agendar_reuniao",
        status: "completed" as const,
        messageId: oldReply.id,
        action: "schedule_meeting",
        claims: [{ claimType: "transaction_status", normalizedValue: "succeeded" }]
      },
      {
        toolName: "cancelar_reuniao",
        status: "completed" as const,
        messageId: currentReply.id,
        action: "cancel_meeting",
        claims: [{ claimType: "transaction_status", normalizedValue: "succeeded" }]
      }
    ];

    expect(deterministicChecks({
      messages: [oldReply, currentReply],
      toolCalls: calls
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "SUCCESS_WITHOUT_TOOL_JOURNAL",
        evidenceMessageIds: [currentReply.id]
      })
    ]));
  });

  it("removes PII, private URLs and secret-bearing fields from regression scenarios", () => {
    expect(sanitizeRegressionScenario({
      history: [{ content: `Meu nome é Ana Souza, e-mail ana@example.com, telefone +55 11 99999-1234, id ${randomUUID()} e token abcdefghijklmnop` }],
      target: "Veja https://privado.example/reuniao/abc",
      nome: "Ana Souza",
      externalId: "wamid.secreto",
      apiKey: "segredo",
      authConfig: {
        password: "CorrectHorseBatteryStaple",
        credential: "opaque-credential",
        authorization: "Bearer private-value",
        privateKey: "private-key-value",
        apiKeyValue: "api-key-value",
        accessTokenExpiresAt: "2035-01-01",
        clientSecretEncrypted: "encrypted-secret",
        authorizationHeader: "Bearer header-value",
        credentialsConfig: { value: "private" },
        label: "preservado"
      }
    })).toEqual({
      history: [{ content: "Meu nome é [NOME_REMOVIDO], e-mail [EMAIL_REMOVIDO], telefone [TELEFONE_REMOVIDO], id [IDENTIFICADOR_REMOVIDO] e [SEGREDO_REMOVIDO]" }],
      target: "Veja [URL_REMOVIDA]",
      authConfig: { label: "preservado" }
    });
  });

  it("sanitizes every evaluator-authored narrative before persistence", () => {
    const evidenceId = randomUUID();
    const score = {
      score: 80,
      rationale: "Resposta para ana@example.com no telefone +55 11 99999-1234",
      evidenceMessageIds: [evidenceId]
    };
    const sanitized = sanitizeEvaluationOutput(evaluationOutputSchema.parse({
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
        evidenceMessageIds: [evidenceId],
        detail: "Detalhe em https://private.example com token abcdefghijklmnop"
      }],
      overallScore: 80,
      hasCriticalFailure: false,
      summary: "Resumo para ana@example.com"
    }));

    expect(JSON.stringify(sanitized)).not.toContain("ana@example.com");
    expect(JSON.stringify(sanitized)).not.toContain("99999-1234");
    expect(JSON.stringify(sanitized)).not.toContain("private.example");
    expect(JSON.stringify(sanitized)).not.toContain("abcdefghijklmnop");
    expect(sanitized.scores.correctness.evidenceMessageIds).toEqual([evidenceId]);
  });

  it("preserves simulated tool names while removing PII and credentials from arguments", () => {
    const externalIdKey = randomUUID();
    expect(sanitizeRegressionScenario({
      context: {
        "ana@example.com": "lead",
        "+55 11 99999-1234": "lead",
        [externalIdKey]: "lead",
        segmento: "varejo"
      },
      simulatedTools: [{
        name: "registrar_lead",
        arguments: {
          nome: "Ana Souza",
          contactName: "Ana Souza",
          password: "CorrectHorseBatteryStaple",
          unidade_id: "centro"
        },
        result: "Lead registrado"
      }]
    })).toEqual({
      context: { segmento: "varejo" },
      simulatedTools: [{
        name: "registrar_lead",
        arguments: { unidade_id: "centro" },
        result: "Lead registrado"
      }]
    });
  });

  it("redacts a UUID atomically before phone and document patterns", () => {
    const uuid = "303f10f3-dfe9-418d-88ce-43fa99991234";

    const sanitized = sanitizeRegressionScenario(`id ${uuid}`);

    expect(sanitized).toBe("id [IDENTIFICADOR_REMOVIDO]");
    expect(sanitized).not.toContain("303f10f3-dfe9-418d-88ce-43fa");
    expect(sanitized).not.toContain("[TELEFONE_REMOVIDO]");
  });

  it("sanitizes technical replay errors before persistence", () => {
    const error = "Falha para ana@example.com em https://private.example/run com bearer sk_live_REDACTED";
    const sanitized = sanitizeTechnicalError(error);
    expect(sanitized).not.toContain("ana@example.com");
    expect(sanitized).not.toContain("private.example");
    expect(sanitized).not.toContain("sk_live_");
    expect(sanitized).toContain("[SEGREDO_REMOVIDO]");
  });
});
