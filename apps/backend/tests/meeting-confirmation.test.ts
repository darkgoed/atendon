import { describe, expect, it } from "vitest";
import {
  buildConfirmationMessage,
  decideConfirmationMoments,
  interpretConfirmationResponse,
  type ConfirmationMoment
} from "../src/modules/scheduling/meeting-confirmation.js";

const startAt = new Date("2026-08-31T16:00:00Z");
const moments: ConfirmationMoment[] = ["pos_agendamento", "duas_horas_antes", "quinze_minutos_antes"];

describe("confirmação de reunião pelo contato", () => {
  it("expõe as 15 variações e interpola nome e horário", () => {
    const messages = [
      ...[0, 1, 2].map((variant) => buildConfirmationMessage({ appointmentId: `pos-${variant}`, moment: "pos_agendamento", name: "Ana", formattedTime: "16h", state: "nao_solicitada", variant })),
      ...["duas_horas_antes", "quinze_minutos_antes"].flatMap((moment) => ["confirmada", "solicitada"].flatMap((state) => [0, 1, 2].map((variant) => buildConfirmationMessage({ appointmentId: `${moment}-${state}-${variant}`, moment: moment as ConfirmationMoment, name: "Ana", formattedTime: "16h", state: state as any, variant }))))
    ];
    expect(messages).toHaveLength(15);
    expect(messages.every((message) => message.includes("Ana") || message.includes("16h"))).toBe(true);
    expect(new Set(messages).size).toBe(15);
  });

  it("escolhe deterministicamente pelo appointment e momento", () => {
    const input = { appointmentId: "appointment-42", moment: "pos_agendamento" as const, name: "Ana", formattedTime: "16h", state: "nao_solicitada" as const };
    expect(buildConfirmationMessage(input)).toBe(buildConfirmationMessage(input));
  });

  it("separa conjuntos de confirmado e não confirmado", () => {
    const common = { appointmentId: "same", moment: "duas_horas_antes" as const, name: "Ana", formattedTime: "16h" };
    expect(buildConfirmationMessage({ ...common, state: "confirmada" })).not.toBe(buildConfirmationMessage({ ...common, state: "solicitada" }));
  });

  it("não enfileira cancelada e só usa 15 minutos quando falta menos de duas horas", () => {
    expect(decideConfirmationMoments({ startAt, now: new Date("2026-08-31T12:00:00Z"), appointmentStatus: "cancelado", state: "nao_solicitada" })).toEqual([]);
    expect(decideConfirmationMoments({ startAt, now: new Date("2026-08-31T15:00:00Z"), appointmentStatus: "confirmado", state: "nao_solicitada" }).map((entry: { moment: string }) => entry.moment))
      .toEqual(["pos_agendamento", "quinze_minutos_antes"]);
  });

  it("enfileira as três janelas quando a reunião ainda está distante", () => {
    const planned = decideConfirmationMoments({ startAt, now: new Date("2026-08-31T09:00:00Z"), appointmentStatus: "confirmado", state: "nao_solicitada" });
    expect(planned.map((entry: { moment: string }) => entry.moment)).toEqual(["pos_agendamento", "duas_horas_antes", "quinze_minutos_antes"]);
    // O pedido de confirmação sai na hora do agendamento, não no horário da reunião.
    expect(planned[0]!.availableAt.toISOString()).toBe("2026-08-31T09:00:00.000Z");
    expect(planned[1]!.availableAt.toISOString()).toBe("2026-08-31T14:00:00.000Z");
    expect(planned[2]!.availableAt.toISOString()).toBe("2026-08-31T15:45:00.000Z");
  });

  it("ainda pede confirmação ativa quando a reunião é logo mais", () => {
    expect(decideConfirmationMoments({ startAt, now: new Date("2026-08-31T15:50:00Z"), appointmentStatus: "confirmado", state: "nao_solicitada" }).map((entry: { moment: string }) => entry.moment))
      .toEqual(["pos_agendamento"]);
  });

  it("não enfileira janela passada", () => {
    expect(decideConfirmationMoments({ startAt, now: new Date("2026-08-31T14:01:00Z"), appointmentStatus: "confirmado", state: "nao_solicitada" }).map((entry: { moment: string }) => entry.moment))
      .toEqual(["pos_agendamento", "quinze_minutos_antes"]);
  });

  it("interpreta confirmação sem aceitar negação", () => {
    expect(interpretConfirmationResponse("sim", "solicitada")).toBe("confirmada");
    expect(interpretConfirmationResponse("Beleza, pode contar comigo", "solicitada")).toBe("confirmada");
    // Recusa explícita nunca confirma e nunca vira silêncio: quem recusou respondeu.
    expect(interpretConfirmationResponse("não vou conseguir", "solicitada")).toBe("solicitada");
    expect(interpretConfirmationResponse("ok, mas não vou poder participar", "solicitada")).toBe("solicitada");
    expect(interpretConfirmationResponse("preciso remarcar", "solicitada")).toBe("solicitada");
  });

  it("não trata hesitação como presença confirmada", () => {
    // Num fluxo anti no-show, quem hesita ainda precisa receber o lembrete.
    expect(interpretConfirmationResponse("acho que consigo", "solicitada")).toBe("solicitada");
    expect(interpretConfirmationResponse("talvez, vou tentar", "solicitada")).toBe("solicitada");
    expect(interpretConfirmationResponse("se der certo eu entro", "solicitada")).toBe("solicitada");
  });

  it("não recobra confirmação de quem já confirmou", () => {
    const planned = decideConfirmationMoments({
      startAt, now: new Date("2026-08-31T09:00:00Z"), appointmentStatus: "confirmado", state: "confirmada"
    });
    expect(planned.map((entry: { moment: string }) => entry.moment)).toEqual(["duas_horas_antes", "quinze_minutos_antes"]);
  });

  it("o Momento 1 nunca é agendado para o futuro", () => {
    // Quem envia o pedido de confirmação logo após agendar é a própria IA, na
    // conversa. Se o runtime também o agendasse, o lead receberia a mensagem
    // duplicada e, dias depois, com "hoje" apontando para a data errada.
    const planned = decideConfirmationMoments({
      startAt, now: new Date("2026-08-31T09:00:00Z"), appointmentStatus: "confirmado", state: "nao_solicitada"
    });
    const posAgendamento = planned.find((entry: { moment: string }) => entry.moment === "pos_agendamento");
    expect(posAgendamento?.availableAt.toISOString()).toBe("2026-08-31T09:00:00.000Z");
  });

  it("aceita variant fora da faixa sem quebrar a montagem", () => {
    const base = { appointmentId: "a", moment: "duas_horas_antes" as const, name: "João", formattedTime: "16h", state: "solicitada" as const };
    // -1 precisa cair na mesma variação que 2, e nunca produzir índice inválido.
    expect(buildConfirmationMessage({ ...base, variant: -1 })).toBe(buildConfirmationMessage({ ...base, variant: 2 }));
    expect(buildConfirmationMessage({ ...base, variant: 5 })).toBe(buildConfirmationMessage({ ...base, variant: 2 }));
    expect(buildConfirmationMessage({ ...base, variant: -4 })).toContain("João");
  });
});
