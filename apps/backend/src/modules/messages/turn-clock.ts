import { zonedParts } from "../../timezone.js";

const WEEKDAYS_PT_BR = [
  "domingo", "segunda-feira", "terça-feira", "quarta-feira",
  "quinta-feira", "sexta-feira", "sábado"
];

export function workspaceClockNote(timeZone: string, now = new Date()): string {
  const parts = zonedParts(now, timeZone);
  const localDate = `${parts.year.toString().padStart(4, "0")}-${parts.month.toString().padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
  const localTime = `${parts.hour.toString().padStart(2, "0")}:${parts.minute.toString().padStart(2, "0")}:${parts.second.toString().padStart(2, "0")}`;
  const weekday = WEEKDAYS_PT_BR[new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()];
  return `\n\nCONTEXTO TEMPORAL DO SISTEMA: agora no workspace é ${localDate} (${weekday}), ${localTime}, fuso ${timeZone}. Interprete “hoje”, “amanhã”, dias da semana e horários sempre a partir deste contexto. Não mencione este dado interno, salvo quando a data ou o horário forem úteis na resposta.`;
}
