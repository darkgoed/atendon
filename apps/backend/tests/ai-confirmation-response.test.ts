import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  composeTransactionalReplyForTurn,
  MessageProcessor
} from "../src/modules/messages/process-message.js";
import type { TransactionalOutcome } from "../src/modules/messages/transactional-outcome.js";

// Regressão R1 (specs/active/comments-20260924-ai-conversas.md): com
// `scheduling_meeting_confirmation_v1` DESLIGADA por tenant, a resposta da IA
// após um agendamento concluído com sucesso deve ser apenas factual
// (dia/hora/link) — mesmo quando o prompt legado do agente manda pedir
// confirmação. Com a flag LIGADA, o comportamento atual (texto do modelo)
// permanece.

const loggerMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../src/logger.js", () => ({ logger: loggerMock, sanitizeRequestUrl: (value: unknown) => value }));

const consumeAiInteractionMock = vi.hoisted(() => vi.fn().mockResolvedValue({ allowed: true }));
const reconcileAiTurnFromUsageLogsMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../src/billing/ai-consumption.js", () => ({
  consumeAiInteraction: consumeAiInteractionMock,
  reconcileAiTurnFromUsageLogs: reconcileAiTurnFromUsageLogsMock
}));

const acquireConversationLockMock = vi.hoisted(() => vi.fn());
const isConversationLockedMock = vi.hoisted(() => vi.fn());
const releaseConversationLockMock = vi.hoisted(() => vi.fn());
const extendConversationLockMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));

vi.mock("../src/modules/messages/conversation-lock.js", () => ({
  acquireConversationLock: acquireConversationLockMock,
  isConversationLocked: isConversationLockedMock,
  releaseConversationLock: releaseConversationLockMock,
  extendConversationLock: extendConversationLockMock
}));

vi.mock("../src/modules/messages/rate-limiter.js", () => ({
  consumeRateLimitRedis: vi.fn().mockResolvedValue(true)
}));

const verificarHorariosMock = vi.hoisted(() => vi.fn());
const buscarDisponibilidadeMock = vi.hoisted(() => vi.fn());
const findLatestActiveAppointmentMock = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const markLeadDisqualifiedMock = vi.hoisted(() => vi.fn());
vi.mock("../src/modules/scheduling/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/modules/scheduling/service.js")>()),
  verificarHorarios: verificarHorariosMock,
  buscarDisponibilidade: buscarDisponibilidadeMock,
  findLatestActiveAppointment: findLatestActiveAppointmentMock,
  markLeadDisqualified: markLeadDisqualifiedMock
}));

const message = {
  externalId: "wamid-1", tenantId: "tenant-A", sessionId: "session-1",
  contactPhone: "5511999999999", text: "Olá"
};
const tinyBubbleHumanizer = {
  readDelay: { min: 0, max: 0 }, readingPause: { min: 0, max: 0 }, composing: { wpm: 1000, jitterMs: 0, minMs: 0, maxMs: 0, resendIntervalMs: 1000 },
  presence: { onlineSessionMin: { min: 1, max: 1 }, offlineGapMin: { min: 1, max: 1 }, inactivityBeforeUnavailableMin: 1, activeHours: { start: 0, end: 23 } },
  debounce: { initialWindowMs: { min: 0, max: 0 }, silenceWindowMs: { min: 0, max: 0 }, extensionMs: { min: 0, max: 0 } },
  messageSplit: { maxWordsPerBubble: 1, pauseBetweenBubblesMs: { min: 0, max: 0 } },
  timeOfDayMultiplier: { outsideActiveHours: 1 }, reaction: { probability: 0, emojis: [] },
  rateLimit: { maxMessagesPerContactPerMinute: 20 }
};
const LEGACY_AGENT_PROMPT = "Ajude o contato a agendar reuniões. Depois de agendar, peça ao contato para confirmar sua presença.";

/** Pool fake que responde apenas à consulta da feature flag. */
function featureFlagDb(flagEnabled: boolean) {
  const row = {
    flag_key: "scheduling_meeting_confirmation_v1",
    description: "test", display_name: "test", kind: "rollout",
    tenant_configurable: true, availability_mode: "all_tenants" as const,
    ui_order: null, default_enabled: false, global_enabled: null,
    kill_switch_enabled: false, tenant_override: flagEnabled,
    updated_at: "2026-01-01T00:00:00.000Z"
  };
  return {
    query: vi.fn(async (sql: string) =>
      sql.includes("capability_dependencies") ? { rows: [] } : { rows: [row] })
  };
}

/** Pool fake cuja consulta da feature flag falha (DB fora do ar). */
function brokenFeatureFlagDb() {
  return {
    query: vi.fn(async () => {
      throw new Error("connection refused");
    })
  };
}

function setup(contextOverrides: Record<string, unknown>, meetingConfirmationFlag?: boolean | "broken") {
  const repository = {
    recordInboundAndLoadContext: vi.fn().mockResolvedValue({
      conversationId: "conversation-1", messageId: "00000000-0000-4000-8000-000000000010", agentConfigVersionId: "version-1", aiActive: true, model: "model-1",
      systemPrompt: LEGACY_AGENT_PROMPT, temperature: 0.4, maxTokens: 512,
      timeZone: "America/Sao_Paulo",
      meetingAgendas: [{ id: "reunioes", name: "Reuniões", slotDurationMinutes: 60 }],
      history: [{ role: "user", content: "Olá" }], ...contextOverrides
    }),
    recordAgentReply: vi.fn().mockResolvedValue(undefined),
    recordAiUsage: vi.fn().mockResolvedValue(undefined),
    getAiUsageTotals: vi.fn().mockResolvedValue({ providerRequests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }),
    recordAudioTranscription: vi.fn().mockResolvedValue(undefined),
    findAudioTranscription: vi.fn().mockResolvedValue(undefined),
    recordMediaAnalysis: vi.fn().mockResolvedValue(undefined),
    findMediaAnalysis: vi.fn().mockResolvedValue(undefined),
    recordFallback: vi.fn().mockResolvedValue(undefined),
    pauseForHandoff: vi.fn().mockResolvedValue(undefined),
    markHandoffNotificationSent: vi.fn().mockResolvedValue(undefined),
    createSystemAlertOnce: vi.fn().mockResolvedValue(undefined),
    executeToolCallOnce: vi.fn().mockImplementation(async (_input: unknown, execute: () => Promise<unknown>) => execute()),
    executeToolCallOnceDetailed: vi.fn().mockImplementation(async (_input: unknown, execute: () => Promise<unknown>) => ({
      journalId: "00000000-0000-4000-8000-000000000001",
      status: "succeeded",
      resultText: await execute(),
      occurredAt: "2030-01-01T00:00:00.000Z"
    })),
    recordHuman: vi.fn().mockResolvedValue("recorded"),
    reactivate: vi.fn().mockResolvedValue(true),
    markInboundProcessed: vi.fn().mockResolvedValue(undefined),
    releaseInboundProcessing: vi.fn().mockResolvedValue(undefined),
    findUnreadContactMessages: vi.fn().mockResolvedValue([]),
    findPendingContactTextMessages: vi.fn().mockResolvedValue([
      { externalId: message.externalId, text: message.text }
    ]),
    markContactMessagesRead: vi.fn().mockResolvedValue(undefined),
    listAiStickerCatalog: vi.fn().mockResolvedValue([]),
    findEnabledAiSticker: vi.fn().mockResolvedValue(null),
    recordAiStickerSend: vi.fn().mockResolvedValue(undefined),
    markAiUnavailable: vi.fn().mockResolvedValue(undefined)
  };
  const repositoryWithFlagDb = meetingConfirmationFlag === undefined
    ? repository
    : { ...repository, db: meetingConfirmationFlag === "broken" ? brokenFeatureFlagDb() : featureFlagDb(meetingConfirmationFlag) };
  const gateway = {
    sendText: vi.fn().mockResolvedValue({ externalId: "sent-1" }),
    sendReaction: vi.fn().mockResolvedValue(undefined),
    sendPresence: vi.fn().mockResolvedValue(undefined),
    markMessageAsRead: vi.fn().mockResolvedValue(undefined),
    setPresence: vi.fn().mockResolvedValue(undefined),
    sendSticker: vi.fn().mockResolvedValue({ externalId: "sticker-sent-1" })
  };
  const ai = { complete: vi.fn().mockImplementation(async (input: { onUsage?: (u: unknown) => void }) => {
    await input.onUsage?.({ providerRequestId: "gen-1", model: "model-1", inputTokens: 5, outputTokens: 2, costUsd: 0.001 });
    return { text: "Oi!", inputTokens: 5, outputTokens: 2, costUsd: 0.001 };
  }) };
  const processor = new MessageProcessor(repositoryWithFlagDb as never, gateway, ai, undefined, 15);
  return { processor, repository: repositoryWithFlagDb, gateway, ai };
}

const meetLink = "https://meet.google.com/abc-defg-hij";
const SCHEDULE_OUTCOME = {
  journalId: "00000000-0000-4000-8000-000000000011",
  status: "succeeded" as const,
  resultText: JSON.stringify({
    agendamento: {
      id: "appointment-1", status: "confirmado",
      start: "2030-01-07T12:00:00.000Z", end: "2030-01-07T13:00:00.000Z",
      timezone: "America/Sao_Paulo", unidade_id: "reunioes", unidade_nome: "Reuniões",
      meeting_provisioning_status: "ready", meet_link: meetLink
    }
  }),
  occurredAt: "2030-01-01T00:00:00.000Z"
};
const LEGACY_MODEL_REPLY = `Sua reunião ficou confirmada para segunda-feira às 9h pelo Google Meet.\n\nEsse é o link pra entrar na chamada: ${meetLink}\n\nPode me confirmar sua presença?`;
// sanitizeOutbound (pré-existente, fora de escopo) normaliza o hífen só no
// texto do modelo; a resposta factual determinística preserva "segunda-feira".
const SANITIZED_LEGACY_MODEL_REPLY = LEGACY_MODEL_REPLY.replace("segunda-feira", "segunda feira");
const FACTUAL_REPLY = `Fechado, ficou marcado pra segunda-feira, 07/01 às 9h pelo Google Meet\n\nEsse é o link pra entrar na chamada: ${meetLink}`;

describe("post-schedule confirmation request vs tenant flag (R1)", () => {
  beforeEach(() => {
    consumeAiInteractionMock.mockReset();
    consumeAiInteractionMock.mockResolvedValue({ allowed: true });
    acquireConversationLockMock.mockReset();
    acquireConversationLockMock.mockResolvedValue({ redisKey: "conv-lock:test", token: "token" });
    isConversationLockedMock.mockReset();
    isConversationLockedMock.mockResolvedValue(false);
    releaseConversationLockMock.mockReset();
    releaseConversationLockMock.mockResolvedValue(undefined);
    markLeadDisqualifiedMock.mockReset();
    markLeadDisqualifiedMock.mockResolvedValue({ status: "perdido" });
  });

  it("tenant A (flag OFF): sends only the factual day/time/link reply despite legacy prompt asking confirmation", async () => {
    const { processor, repository, gateway, ai } = setup({
      enabledToolNames: ["agendar_reuniao"],
      leadStatus: "qualificado",
      leadQualificationStars: 4,
      humanizer: tinyBubbleHumanizer
    }, false);
    repository.executeToolCallOnceDetailed.mockResolvedValueOnce(SCHEDULE_OUTCOME);
    ai.complete.mockImplementationOnce(async (input: { executeTool?: (name: string, args: string, meta: unknown) => Promise<void> }) => {
      await input.executeTool?.(
        "agendar_reuniao",
        JSON.stringify({ agenda_id: "reunioes", start: "2030-01-07T12:00:00.000Z" }),
        { providerCallId: "tool-1", ordinal: 0 }
      );
      return { text: LEGACY_MODEL_REPLY, inputTokens: 5, outputTokens: 2, costUsd: 0.001 };
    });

    await expect(processor.process(message)).resolves.toBe("answered");

    expect(gateway.sendText).toHaveBeenCalledWith("session-1", "5511999999999", FACTUAL_REPLY);
    expect(gateway.sendText).toHaveBeenCalledTimes(1);
    expect(String(gateway.sendText.mock.calls[0][2])).not.toMatch(/confirmar/iu);
    expect(repository.recordAgentReply).toHaveBeenCalledWith(expect.objectContaining({
      text: FACTUAL_REPLY,
      transactionClaims: expect.arrayContaining([
        expect.objectContaining({ journalId: SCHEDULE_OUTCOME.journalId, claimType: "meeting_url", normalizedValue: meetLink })
      ])
    }));
  });

  it("tenant B (flag ON): keeps the existing model reply including the confirmation request", async () => {
    const { processor, repository, gateway, ai } = setup({
      enabledToolNames: ["agendar_reuniao"],
      leadStatus: "qualificado",
      leadQualificationStars: 4,
      humanizer: tinyBubbleHumanizer
    }, true);
    repository.executeToolCallOnceDetailed.mockResolvedValueOnce(SCHEDULE_OUTCOME);
    ai.complete.mockImplementationOnce(async (input: { executeTool?: (name: string, args: string, meta: unknown) => Promise<void> }) => {
      await input.executeTool?.(
        "agendar_reuniao",
        JSON.stringify({ agenda_id: "reunioes", start: "2030-01-07T12:00:00.000Z" }),
        { providerCallId: "tool-2", ordinal: 0 }
      );
      return { text: LEGACY_MODEL_REPLY, inputTokens: 5, outputTokens: 2, costUsd: 0.001 };
    });

    await expect(processor.process(message)).resolves.toBe("answered");

    expect(gateway.sendText).toHaveBeenCalledWith("session-1", "5511999999999", SANITIZED_LEGACY_MODEL_REPLY);
    expect(repository.recordAgentReply).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Pode me confirmar sua presença?")
    }));
  });

  it("flag lookup failure fails closed: sends only the factual reply instead of an opted-out confirmation request", async () => {
    const { processor, repository, gateway, ai } = setup({
      enabledToolNames: ["agendar_reuniao"],
      leadStatus: "qualificado",
      leadQualificationStars: 4,
      humanizer: tinyBubbleHumanizer
    }, "broken");
    repository.executeToolCallOnceDetailed.mockResolvedValueOnce(SCHEDULE_OUTCOME);
    ai.complete.mockImplementationOnce(async (input: { executeTool?: (name: string, args: string, meta: unknown) => Promise<void> }) => {
      await input.executeTool?.(
        "agendar_reuniao",
        JSON.stringify({ agenda_id: "reunioes", start: "2030-01-07T12:00:00.000Z" }),
        { providerCallId: "tool-3", ordinal: 0 }
      );
      return { text: LEGACY_MODEL_REPLY, inputTokens: 5, outputTokens: 2, costUsd: 0.001 };
    });

    await expect(processor.process(message)).resolves.toBe("answered");

    // Migration 0127: nenhuma mensagem automática de confirmação sai para lead
    // real antes de alguém ligar a flag conscientemente — falha de leitura da
    // flag não pode reativar o pedido legado (fail-open).
    expect(gateway.sendText).toHaveBeenCalledWith("session-1", "5511999999999", FACTUAL_REPLY);
    expect(String(gateway.sendText.mock.calls[0][2])).not.toMatch(/confirmar/iu);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-A", err: expect.anything() }),
      expect.any(String)
    );
  });

  it("legacy double without flag db: successful schedule keeps the legacy confirmation request", async () => {
    const { processor, repository, gateway, ai } = setup({
      enabledToolNames: ["agendar_reuniao"],
      leadStatus: "qualificado",
      leadQualificationStars: 4,
      humanizer: tinyBubbleHumanizer
    });
    repository.executeToolCallOnceDetailed.mockResolvedValueOnce(SCHEDULE_OUTCOME);
    ai.complete.mockImplementationOnce(async (input: { executeTool?: (name: string, args: string, meta: unknown) => Promise<void> }) => {
      await input.executeTool?.(
        "agendar_reuniao",
        JSON.stringify({ agenda_id: "reunioes", start: "2030-01-07T12:00:00.000Z" }),
        { providerCallId: "tool-4", ordinal: 0 }
      );
      return { text: LEGACY_MODEL_REPLY, inputTokens: 5, outputTokens: 2, costUsd: 0.001 };
    });

    await expect(processor.process(message)).resolves.toBe("answered");

    // Legado (antes da migration 0127): sem `.db` não há leitura de flag
    // possível e o pedido de confirmação permanece ATIVO — texto do modelo
    // preservado. Os claims continuam ancorados no outcome persistido (fatos
    // factuais), nunca no texto do modelo.
    expect(gateway.sendText).toHaveBeenCalledWith("session-1", "5511999999999", SANITIZED_LEGACY_MODEL_REPLY);
    expect(repository.recordAgentReply).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Pode me confirmar sua presença?"),
      transactionClaims: expect.arrayContaining([
        expect.objectContaining({
          journalId: SCHEDULE_OUTCOME.journalId,
          claimType: "transaction_status",
          normalizedValue: "succeeded"
        })
      ])
    }));
  });
});

describe("composeTransactionalReplyForTurn (pure seam)", () => {
  const succeededSchedule: TransactionalOutcome = {
    journalId: "j-1", status: "succeeded", action: "schedule_meeting",
    occurredAt: "2030-01-01T00:00:00.000Z",
    facts: {
      start: "2030-01-07T12:00:00.000Z", end: "2030-01-07T13:00:00.000Z",
      durationMinutes: 60, timezone: "America/Sao_Paulo",
      unitId: "reunioes", unitName: "Reuniões", appointmentStatus: "confirmado",
      meetingUrl: meetLink
    }
  };
  const succeededCancel: TransactionalOutcome = {
    journalId: "j-2", status: "succeeded", action: "cancel_meeting",
    occurredAt: "2030-01-01T00:00:00.000Z",
    facts: {
      start: "2030-01-07T12:00:00.000Z", end: "2030-01-07T13:00:00.000Z",
      durationMinutes: 60, timezone: "America/Sao_Paulo",
      unitId: "reunioes", unitName: "Reuniões", appointmentStatus: "cancelado"
    }
  };

  it("OFF replaces a factually consistent reply that asks the contact to confirm", () => {
    const composed = composeTransactionalReplyForTurn(LEGACY_MODEL_REPLY, [succeededSchedule], false);
    expect(composed.text).toBe(FACTUAL_REPLY);
    expect(composed.text).not.toMatch(/confirmar/iu);
    expect(composed.claims).toContainEqual(expect.objectContaining({ claimType: "meeting_url", normalizedValue: meetLink }));
  });

  it("ON preserves the model reply", () => {
    expect(composeTransactionalReplyForTurn(LEGACY_MODEL_REPLY, [succeededSchedule], true).text).toBe(LEGACY_MODEL_REPLY);
  });

  it("OFF does not rewrite non-scheduling transactions or plain conversational replies", () => {
    const conversational = "Fechado, ficou marcado pra segunda-feira, 07/01 às 9h pelo Google Meet";
    expect(composeTransactionalReplyForTurn(conversational, [], false).text).toBe(conversational);
    const cancelReply = "Fechado, cancelei a reunião de segunda.";
    expect(composeTransactionalReplyForTurn(cancelReply, [succeededCancel], false).text).toBe(cancelReply);
  });

  it("OFF keeps the model reply when a later cancel follows the succeeded schedule (multi-outcome)", () => {
    // Turno real: o modelo cancelou a reunião antiga e marcou a nova. O texto
    // descreve os DOIS fatos; a substituição determinística de cancelamento
    // ("Fechado, cancelei a reunião.") apagaria o agendamento novo — fato
    // verdadeiro — e deixaria o contato sem o horário.
    const laterCancel: TransactionalOutcome = { ...succeededCancel, occurredAt: "2030-01-02T00:00:00.000Z" };
    const dualReply = `Cancelei a reunião antiga e deixei a nova marcada pra segunda-feira, 07/01 às 9h pelo Google Meet.\n\nEsse é o link pra entrar na chamada: ${meetLink}`;
    expect(composeTransactionalReplyForTurn(dualReply, [succeededSchedule, laterCancel], false).text).toBe(dualReply);
  });
});
