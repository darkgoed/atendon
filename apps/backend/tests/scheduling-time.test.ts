import { describe, expect, it } from "vitest";
import { extractSchedulingTimes, hasSchedulingTime } from "../src/modules/messages/scheduling-time.js";
import { classifySpecificSchedulingIntent } from "../src/modules/messages/process-message.js";

describe("scheduling time recognition", () => {
  it("reads the spoken forms the contact actually uses", () => {
    expect(extractSchedulingTimes("Pode ser às 10")).toEqual(["10:00"]);
    expect(extractSchedulingTimes("Pode ser amanhã 16")).toEqual(["16:00"]);
    expect(extractSchedulingTimes("as 9 da manha")).toEqual(["09:00"]);
    expect(extractSchedulingTimes("3 da tarde")).toEqual(["15:00"]);
    expect(extractSchedulingTimes("8 da noite")).toEqual(["20:00"]);
    expect(extractSchedulingTimes("9 horas")).toEqual(["09:00"]);
    expect(extractSchedulingTimes("às 9 e meia")).toEqual(["09:30"]);
    expect(extractSchedulingTimes("pode ser meio-dia")).toEqual(["12:00"]);
    expect(extractSchedulingTimes("Tenho 9h, 10h ou 11h")).toEqual(["09:00", "10:00", "11:00"]);
    expect(extractSchedulingTimes("pode ser agora 12h40?")).toEqual(["12:40"]);
  });

  it("does not turn prices, quantities or durations into appointments", () => {
    for (const text of [
      "Moto elétrica na faixa de 8.500,00",
      "iPhone na faixa de 7500,00",
      "Em média 350 a 600",
      "reunião rápida de 15 minutinhos",
      "2 anos de mercado",
      "Acredito que 30 vendas",
      "as 3 lojas"
    ]) {
      expect(hasSchedulingTime(text), text).toBe(false);
    }
  });

  // Incidente 553497771091: "Pode ser às 9" não era reconhecido como horário, o
  // turno não virava intenção de agendamento e o modelo escolheu sozinho o start
  // que mandou para a agenda — a reunião saiu às 12h.
  it("classifies a bare spoken hour as a direct scheduling intent", () => {
    expect(classifySpecificSchedulingIntent("Pode ser às 9")).toEqual({ kind: "direct_schedule", time: "09:00" });
    expect(classifySpecificSchedulingIntent("Pode ser às 10")).toEqual({ kind: "direct_schedule", time: "10:00" });
    expect(classifySpecificSchedulingIntent("Pode ser amanhã 16")).toEqual({ kind: "direct_schedule", time: "16:00" });
    expect(classifySpecificSchedulingIntent("quero as 9 da manha")).toEqual({ kind: "direct_schedule", time: "09:00" });
  });
});
