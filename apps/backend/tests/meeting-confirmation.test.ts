import { describe, expect, it } from "vitest";
import {
  buildConfirmationMessage,
  decideConfirmationMoments,
  displayFirstName,
  formatMeetingTime,
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
      .toEqual(["quinze_minutos_antes"]);
  });

  it("enfileira as duas janelas quando a reunião ainda está distante", () => {
    const planned = decideConfirmationMoments({ startAt, now: new Date("2026-08-31T09:00:00Z"), appointmentStatus: "confirmado", state: "nao_solicitada" });
    expect(planned.map((entry: { moment: string }) => entry.moment)).toEqual(["duas_horas_antes", "quinze_minutos_antes"]);
    expect(planned[0]!.availableAt.toISOString()).toBe("2026-08-31T14:00:00.000Z");
    expect(planned[1]!.availableAt.toISOString()).toBe("2026-08-31T15:45:00.000Z");
  });

  it("não enfileira nada quando a reunião é logo mais", () => {
    // O pedido de confirmação do Momento 1 é da IA, na conversa; as janelas de
    // 2h e 15min já passaram, então o runtime não tem o que disparar.
    expect(decideConfirmationMoments({ startAt, now: new Date("2026-08-31T15:50:00Z"), appointmentStatus: "confirmado", state: "nao_solicitada" }).map((entry: { moment: string }) => entry.moment))
      .toEqual([]);
  });

  it("não enfileira janela passada", () => {
    expect(decideConfirmationMoments({ startAt, now: new Date("2026-08-31T14:01:00Z"), appointmentStatus: "confirmado", state: "nao_solicitada" }).map((entry: { moment: string }) => entry.moment))
      .toEqual(["quinze_minutos_antes"]);
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

  it("o runtime nunca agenda o Momento 1", () => {
    // Quem envia o pedido de confirmação logo após agendar é a própria IA, na
    // conversa. Se o runtime também o agendasse, o lead receberia a mensagem
    // duplicada e, dias depois, com "hoje" apontando para a data errada.
    const planned = decideConfirmationMoments({
      startAt, now: new Date("2026-08-31T09:00:00Z"), appointmentStatus: "confirmado", state: "nao_solicitada"
    });
    expect(planned.map((entry: { moment: string }) => entry.moment)).not.toContain("pos_agendamento");
  });

  it("trata o contato pelo primeiro nome utilizável", () => {
    expect(displayFirstName("Rodrigo Melfi")).toBe("Rodrigo");
    // Título não é vocativo: "Consultor," ou "Dr," soa pior que sem nome.
    expect(displayFirstName("Consultor Fred")).toBe("Fred");
    expect(displayFirstName("Dr Cardoso")).toBe("Cardoso");
    expect(displayFirstName("Dra. Marina Alves")).toBe("Marina");
    // Nome só com emoji não rende saudação alguma.
    expect(displayFirstName("✌🏻")).toBe("");
    expect(displayFirstName(null)).toBe("");
  });

  it("escreve o horário como se escreve no WhatsApp", () => {
    const tz = "America/Sao_Paulo";
    expect(formatMeetingTime(new Date("2026-09-01T19:00:00Z"), tz)).toBe("16h");
    expect(formatMeetingTime(new Date("2026-09-01T20:30:00Z"), tz)).toBe("17h30");
    expect(formatMeetingTime(new Date("2026-09-02T12:00:00Z"), tz)).toBe("9h");
  });

  it("omite a saudação sem deixar vírgula solta quando não há nome", () => {
    const message = buildConfirmationMessage({
      appointmentId: "a1", moment: "duas_horas_antes", name: "", formattedTime: "11h", state: "solicitada", variant: 1
    });
    expect(message.startsWith(",")).toBe(false);
    expect(message).toBe("Passando pra confirmar nosso horário de hoje às 11h\n\nConsegue me dar um ok por aqui?");
  });

  it("separa as duas frases em parágrafos", () => {
    const message = buildConfirmationMessage({
      appointmentId: "a1", moment: "duas_horas_antes", name: "Ana", formattedTime: "16h", state: "solicitada", variant: 0
    });
    expect(message).toBe("Ana, nossa conversa está marcada pra hoje às 16h\n\nSegue tudo certo pra você?");
  });

  it("aceita variant fora da faixa sem quebrar a montagem", () => {
    const base = { appointmentId: "a", moment: "duas_horas_antes" as const, name: "João", formattedTime: "16h", state: "solicitada" as const };
    // -1 precisa cair na mesma variação que 2, e nunca produzir índice inválido.
    expect(buildConfirmationMessage({ ...base, variant: -1 })).toBe(buildConfirmationMessage({ ...base, variant: 2 }));
    expect(buildConfirmationMessage({ ...base, variant: 5 })).toBe(buildConfirmationMessage({ ...base, variant: 2 }));
    expect(buildConfirmationMessage({ ...base, variant: -4 })).toContain("João");
  });
});
