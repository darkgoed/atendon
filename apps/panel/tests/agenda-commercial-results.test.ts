import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isAppointmentResultPending } from "../app/agenda/agenda-appointment-state";
import { APPOINTMENT_STATUS_LABELS } from "../app/agenda/agenda-utils";
import {
  buildCancellationPayload,
  buildOutcomePayload
} from "../app/agenda/appointment-action-contracts";

const agendaSource = readFileSync(new URL("../app/agenda/page.tsx", import.meta.url), "utf8");
const agendaActionsSource = readFileSync(new URL("../app/agenda/use-agenda-actions.ts", import.meta.url), "utf8");
const agendaDetailSource = readFileSync(new URL("../app/agenda/agenda-detail-dialog.tsx", import.meta.url), "utf8");
const agendaHeaderSource = readFileSync(new URL("../app/agenda/agenda-header.tsx", import.meta.url), "utf8");
const comboboxSource = readFileSync(
  new URL("../app/agenda/agenda-lead-combobox.tsx", import.meta.url),
  "utf8"
);

describe("Agenda commercial result contracts", () => {
  it("builds the closed-sale payload and rejects a missing value", () => {
    expect(buildOutcomePayload({ outcome: "fechado", saleValue: "1290.50", nextAction: "", nextActionAtLocal: "", lossReason: "" }, "UTC"))
      .toEqual({ ok: true, payload: { outcome: "fechado", sale_value: 1290.5 } });
    expect(buildOutcomePayload({ outcome: "fechado", saleValue: "", nextAction: "", nextActionAtLocal: "", lossReason: "" }, "UTC"))
      .toMatchObject({ ok: false });
  });

  it("converts a follow-up in the workspace timezone and requires a future action", () => {
    const draft = { outcome: "follow_up" as const, saleValue: "", nextAction: "Enviar proposta", nextActionAtLocal: "2030-01-07T09:15", lossReason: "" as const };
    expect(buildOutcomePayload(draft, "America/Sao_Paulo", new Date("2030-01-07T11:00:00.000Z").getTime()))
      .toEqual({ ok: true, payload: { outcome: "follow_up", next_action: "Enviar proposta", next_action_at: "2030-01-07T12:15:00.000Z" } });
    expect(buildOutcomePayload(draft, "America/Sao_Paulo", new Date("2030-01-07T13:00:00.000Z").getTime()))
      .toMatchObject({ ok: false, error: "A próxima ação precisa estar no futuro." });
  });

  it("builds loss and cancellation branches without unrelated fields", () => {
    expect(buildOutcomePayload({ outcome: "nao_avancou", saleValue: "", nextAction: "", nextActionAtLocal: "", lossReason: "preco" }, "UTC"))
      .toEqual({ ok: true, payload: { outcome: "nao_avancou", loss_reason: "preco" } });
    expect(buildCancellationPayload({ disposition: "lost", nextAction: "", nextActionAtLocal: "", lossReason: "sem_interesse" }, "UTC"))
      .toEqual({ ok: true, payload: { disposition: "lost", loss_reason: "sem_interesse" } });
    expect(buildCancellationPayload({ disposition: "recover", nextAction: "Ligar novamente", nextActionAtLocal: "2030-01-08T10:00", lossReason: "" }, "UTC", new Date("2030-01-07T10:00:00.000Z").getTime()))
      .toEqual({ ok: true, payload: { disposition: "recover", next_action: "Ligar novamente", next_action_at: "2030-01-08T10:00:00.000Z" } });
  });

  it("carries the disqualification note and enforces it when the reason requires one", () => {
    expect(buildOutcomePayload(
      { outcome: "nao_avancou", saleValue: "", nextAction: "", nextActionAtLocal: "", lossReason: "queria_emprestimo", lossReasonNote: "  só queria capital de giro  " },
      "UTC"
    )).toEqual({ ok: true, payload: { outcome: "nao_avancou", loss_reason: "queria_emprestimo", loss_reason_note: "só queria capital de giro" } });

    expect(buildOutcomePayload(
      { outcome: "nao_avancou", saleValue: "", nextAction: "", nextActionAtLocal: "", lossReason: "outro", lossReasonNote: "   " },
      "UTC",
      Date.now(),
      true
    )).toMatchObject({ ok: false, error: "Descreva o motivo no campo de observação." });

    expect(buildCancellationPayload(
      { disposition: "lost", nextAction: "", nextActionAtLocal: "", lossReason: "outro", lossReasonNote: "mudou de ramo" },
      "UTC",
      Date.now(),
      true
    )).toEqual({ ok: true, payload: { disposition: "lost", loss_reason: "outro", loss_reason_note: "mudou de ramo" } });
  });
});

describe("Agenda pending and guarded entry", () => {
  it("honors server pending state and derives pending state when an active meeting ends", () => {
    expect(isAppointmentResultPending({ status: "confirmado", end: "2030-01-07T10:00:00.000Z", result_pending: true }, 0)).toBe(true);
    expect(isAppointmentResultPending({ status: "reagendado", end: "2030-01-07T10:00:00.000Z" }, new Date("2030-01-07T10:00:00.000Z").getTime())).toBe(true);
    expect(isAppointmentResultPending({ status: "concluido", end: "2030-01-07T10:00:00.000Z" }, new Date("2030-01-08T10:00:00.000Z").getTime())).toBe(false);
    expect(APPOINTMENT_STATUS_LABELS.concluido).toBe("Compareceu");
  });

  it("uses searched lead loading and guarded commercial endpoints", () => {
    expect(comboboxSource).toContain("?busca=${encodeURIComponent(debouncedQuery)}&limit=20");
    expect(comboboxSource).toContain('role="combobox"');
    expect(comboboxSource).toContain('event.key === "ArrowDown"');
    expect(agendaSource).not.toContain('canCreate ? "/scheduling/appointment-leads"');
    expect(agendaActionsSource).toContain("`${base}/cancelar`");
    expect(agendaActionsSource).toContain("`${base}/${action === \"complete\" ? \"concluir\" : \"no-show\"}`");
    expect(agendaActionsSource).toContain("/join`");
    expect(agendaActionsSource).toContain("error.status === 409");
    expect(agendaActionsSource).toContain("setJoinBlockedIds(new Set())");
    expect(agendaDetailSource).toContain("Corrigir para não compareceu");
    expect(agendaDetailSource).toContain("Corrigir para compareceu");
    expect(agendaHeaderSource).toContain('["pending", "Resultado pendente"]');
  });
});
