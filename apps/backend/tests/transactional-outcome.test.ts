import { describe, expect, it } from "vitest";
import {
  claimsUnprovenTransactionalSuccess,
  composeTransactionalReply,
  UNPROVEN_TRANSACTIONAL_SUCCESS_ABSTENTION,
  type TransactionalOutcome
} from "../src/modules/messages/transactional-outcome.js";

const journalId = "00000000-0000-4000-8000-000000000100";
const readyMeeting = {
  journalId,
  status: "succeeded",
  action: "schedule_meeting",
  occurredAt: "2030-01-01T00:00:00.000Z",
  facts: {
    start: "2030-01-07T12:00:00.000Z",
    end: "2030-01-07T13:00:00.000Z",
    durationMinutes: 60,
    timezone: "America/Sao_Paulo",
    unitId: "reunioes",
    unitName: "Reuniões",
    appointmentStatus: "confirmado",
    meetingProvisioningStatus: "ready",
    meetingUrl: "https://meet.google.com/abc-defg-hij"
  }
} satisfies TransactionalOutcome;

describe("transactional outcome composer", () => {
  it.each([
    "Pronto, agendei sua reunião para amanhã.",
    "Sua visita está confirmada.",
    "O horário foi reservado.",
    "Reagendado para sexta-feira.",
    "Cadastrei o lead com sucesso.",
    "Consegui agendar para amanhã.",
    "Deu tudo certo com a sua reserva.",
    "Não consegui agendar, mas reservei outro horário."
  ])("detects an unproven transactional success claim: %s", (text) => {
    expect(claimsUnprovenTransactionalSuccess(text)).toBe(true);
    expect(composeTransactionalReply(text, [])).toEqual({
      text: UNPROVEN_TRANSACTIONAL_SUCCESS_ABSTENTION,
      claims: []
    });
  });

  it.each([
    "Posso agendar sua reunião para amanhã?",
    "Você quer cancelar a visita?",
    "Vou verificar se o horário está disponível.",
    "Ainda não consegui confirmar o cadastro.",
    "Não consegui agendar a reunião.",
    "A visita não foi agendada.",
    "A reunião foi confirmada?"
  ])("does not block a question or explicit abstention: %s", (text) => {
    expect(claimsUnprovenTransactionalSuccess(text)).toBe(false);
    expect(composeTransactionalReply(text, [])).toEqual({ text, claims: [] });
  });

  it.each([
    "Sua reunião já está confirmada para amanhã às 10h.",
    "A visita está agendada, posso ajudar em algo mais?",
    "O horário foi reservado, nos vemos lá."
  ])("does not block reaffirmation of a known active appointment: %s", (text) => {
    expect(claimsUnprovenTransactionalSuccess(text, true)).toBe(false);
    expect(composeTransactionalReply(text, [], true)).toEqual({ text, claims: [] });
  });

  it.each([
    "Cancelei sua reunião.",
    "Reagendei para sexta-feira."
  ])("still blocks a fresh reschedule/cancel claim even with an active appointment: %s", (text) => {
    expect(claimsUnprovenTransactionalSuccess(text, true)).toBe(true);
    expect(composeTransactionalReply(text, [], true)).toEqual({
      text: UNPROVEN_TRANSACTIONAL_SUCCESS_ABSTENTION,
      claims: []
    });
  });

  it("ignores model-invented facts and confirms exactly the ready journal outcome", () => {
    const result = composeTransactionalReply(
      "Agendado amanhã às 18h em outra unidade com https://meet.google.com/inventado",
      [readyMeeting]
    );

    expect(result.text).toBe(
      "Fechado, ficou marcado pra segunda-feira, 07/01 às 9h pelo Google Meet\n\n"
      + "Esse é o link pra entrar na chamada: https://meet.google.com/abc-defg-hij"
    );
    expect(result.text).not.toContain("18h");
    expect(result.text).not.toContain("inventado");
    expect(result.text).not.toContain("60 minutos");
    expect(result.text).not.toContain("Reuniões");
    expect(result.text).not.toContain("America/Sao_Paulo");
    expect(result.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({
        journalId,
        action: "schedule_meeting",
        claimType: "meeting_url",
        normalizedValue: "https://meet.google.com/abc-defg-hij"
      }),
      expect.objectContaining({
        claimType: "transaction_status",
        normalizedValue: "succeeded"
      })
    ]));
  });

  it.each(["pending", "uncertain"] as const)(
    "abstains while Meet provisioning is %s",
    (provisioning) => {
      const result = composeTransactionalReply("Sua reunião está confirmada!", [{
        journalId,
        status: "pending",
        action: "schedule_meeting",
        occurredAt: "2030-01-01T00:00:00.000Z",
        facts: {
          reason: provisioning === "pending" ? "provisioning_pending" : "provisioning_uncertain"
        }
      }]);

      expect(result.text).toContain("Ainda não consegui confirmar");
      expect(result.text).not.toContain("está confirmada");
      expect(result.claims).toContainEqual(expect.objectContaining({
        claimType: "transaction_status",
        normalizedValue: "pending"
      }));
    }
  );

  it("blocks divergent outcomes for the same action", () => {
    const divergent: TransactionalOutcome = {
      ...readyMeeting,
      journalId: "00000000-0000-4000-8000-000000000101",
      occurredAt: "2030-01-01T00:00:01.000Z",
      facts: {
        ...readyMeeting.facts,
        start: "2030-01-07T14:00:00.000Z",
        end: "2030-01-07T15:00:00.000Z"
      }
    };

    const result = composeTransactionalReply("Tudo certo.", [readyMeeting, divergent]);

    expect(result.text).toContain("Não consegui concluir");
    expect(result.text).not.toContain("09:00");
    expect(result.claims).toContainEqual(expect.objectContaining({
      journalId: divergent.journalId,
      claimType: "transaction_status",
      normalizedValue: "failed"
    }));
  });

  it("confirms a successful retry after an earlier failure of the same action", () => {
    const failed: TransactionalOutcome = {
      journalId: "00000000-0000-4000-8000-000000000103",
      status: "failed",
      action: "schedule_meeting",
      occurredAt: "2029-12-31T23:59:59.000Z",
      facts: { reason: "operational_error" }
    };

    const result = composeTransactionalReply("Tudo certo.", [failed, readyMeeting]);

    expect(result.text).toContain("ficou marcado");
    expect(result.text).toContain("https://meet.google.com/abc-defg-hij");
    expect(result.text).not.toContain("Não consegui concluir");
    expect(result.claims).toContainEqual(expect.objectContaining({
      journalId,
      claimType: "transaction_status",
      normalizedValue: "succeeded"
    }));
  });

  it("does not let a redundant later failure hide a persisted success", () => {
    const redundantFailure: TransactionalOutcome = {
      journalId: "00000000-0000-4000-8000-000000000104",
      status: "failed",
      action: "schedule_meeting",
      occurredAt: "2030-01-01T00:00:01.000Z",
      facts: { reason: "operational_error" }
    };

    const result = composeTransactionalReply("Não consegui agendar.", [readyMeeting, redundantFailure]);

    expect(result.text).toContain("ficou marcado");
    expect(result.text).toContain("https://meet.google.com/abc-defg-hij");
    expect(result.text).not.toContain("Não consegui concluir");
    expect(result.claims).toContainEqual(expect.objectContaining({
      journalId,
      claimType: "transaction_status",
      normalizedValue: "succeeded"
    }));
  });

  const qualification: TransactionalOutcome = {
    journalId: "00000000-0000-4000-8000-000000000102",
    status: "succeeded",
    action: "qualify_lead",
    occurredAt: "2030-01-01T00:00:00.000Z",
    facts: { qualificationRegistered: true, changed: true }
  };

  it.each([
    "Você foi aprovada com nota máxima!",
    "Sua avaliação ficou em 5 estrelas.",
    "Registrei tudo e você foi qualificado como prioridade.",
    ""
  ])("falls back to the neutral acknowledgement when the continuation is unsafe: %s", (text) => {
    const result = composeTransactionalReply(text, [qualification]);

    expect(result.text).toBe("Perfeito, registrei essas informações.");
    expect(result.claims).toContainEqual(expect.objectContaining({
      claimType: "qualification_registered",
      normalizedValue: "true"
    }));
  });

  it("keeps the model continuation after a successful qualification", () => {
    const continuation = "Essa falta de limite no cartão trava vendas que poderiam seguir por outra forma de crédito, e é aí que o financiamento da Newave pode ajudar\n\nQue tal uma reunião rápida no Google Meet hoje, tenho 14h ou 16h30, qual encaixa melhor pra você?";
    const result = composeTransactionalReply(continuation, [qualification]);

    expect(result.text).toBe(continuation);
    expect(result.claims).toContainEqual(expect.objectContaining({
      claimType: "qualification_registered",
      normalizedValue: "true"
    }));
  });

  it("blocks an unproven scheduling claim after a successful qualification", () => {
    const result = composeTransactionalReply(
      "Prontinho, sua reunião está confirmada para amanhã às 10h.",
      [qualification]
    );

    expect(result.text).toBe("Perfeito, registrei essas informações.");
  });
});
