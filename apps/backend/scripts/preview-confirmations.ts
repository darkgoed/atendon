import { readFileSync } from "node:fs";
import { buildConfirmationMessage, displayFirstName, formatMeetingTime } from "../src/modules/scheduling/meeting-confirmation.js";

// Simula o texto EXATO que cada linha pendente enviaria, usando a mesma função
// do processador. Só leitura: não toca no banco nem envia nada.
for (const line of readFileSync("/tmp/newave/preview.txt", "utf8").trim().split("\n")) {
  const [appointmentId, moment, state, name, isoStart, when] = line.split("|");
  const text = buildConfirmationMessage({
    appointmentId: appointmentId!,
    moment: moment as "duas_horas_antes" | "quinze_minutos_antes",
    name: displayFirstName(name),
    formattedTime: formatMeetingTime(new Date(isoStart!), "America/Sao_Paulo"),
    state: state as "nao_solicitada" | "solicitada" | "confirmada"
  });
  console.log(`[${when}] ${name} (${state})\n  ${text.replace(/\n/g, "\n  ")}\n`);
}
