/**
 * Reconhecimento de horários em português falado.
 *
 * O contato raramente escreve "9h": ele escreve "pode ser às 9", "amanhã 16",
 * "9 horas" ou "3 da tarde". Enquanto o sistema só entendia o formato com `h`
 * ou `:`, nenhuma guarda de agenda enxergava o horário pedido — o turno não era
 * classificado como intenção de agendamento, o commit determinístico do slot
 * não rodava e o modelo escolhia sozinho o `start` que mandava para a agenda.
 * Foi assim que "Pode ser às 9" virou uma reunião às 12h.
 */

// Hora "nua" (sem `h`, `:` ou "horas") só é aceita dentro da faixa comercial,
// precedida por preposição ou dia. Sem isso "as 3 lojas" e "os 2 primeiros"
// entrariam como horário.
const BARE_HOUR_PREFIX = "(?:as|ao|pras?|para|hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo)";
const DAY_PERIOD_SUFFIX = String.raw`\s*(?:e\s*meia\s*)?d[ae]\s+(?:manha|tarde|noite)\b`;

const TIME_TOKEN = new RegExp(
  [
    String.raw`\b(?<noon>meio[\s-]?dia)\b`,
    String.raw`\b(?<midnight>meia[\s-]?noite)\b`,
    // 9h, 9h30, 9:30, 9 horas, 9hrs
    String.raw`\b(?<explicit>[01]?\d|2[0-3])\s*(?:h(?<hourMinute>[0-5]\d)?(?![\p{Letter}\d])|:(?<colonMinute>[0-5]\d)\b|(?:horas?|hrs?|hs)\b)`,
    // 3 da tarde, 8 da noite, 9 e meia da manhã
    String.raw`\b(?<dayPeriodHour>[01]?\d|2[0-3])(?=${DAY_PERIOD_SUFFIX})`,
    // às 9, pra 16, amanhã 16
    String.raw`(?<=\b${BARE_HOUR_PREFIX}\s{1,3})(?<bare>[6-9]|1\d|2[0-2])\b`
  ].join("|"),
  "giu"
);

const HALF_PAST = /^\s*e\s*meia\b/iu;
const AFTERNOON_OR_NIGHT = /^\s*(?:e\s*meia\s*)?d[ae]\s+(?:tarde|noite)\b/iu;
const MORNING = /^\s*(?:e\s*meia\s*)?d[ae]\s+manha\b/iu;

export function normalizeSchedulingText(text: string): string {
  return text.normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .toLocaleLowerCase("pt-BR");
}

/** Horários encontrados no texto, em `HH:MM` e na ordem em que aparecem. */
export function extractSchedulingTimes(text: string): string[] {
  const normalized = normalizeSchedulingText(text);
  const found: string[] = [];
  for (const match of normalized.matchAll(TIME_TOKEN)) {
    const groups = match.groups ?? {};
    if (groups.noon) { found.push("12:00"); continue; }
    if (groups.midnight) { found.push("00:00"); continue; }
    const hourText = groups.explicit ?? groups.dayPeriodHour ?? groups.bare;
    if (hourText === undefined) continue;
    const rest = normalized.slice(match.index + match[0].length);
    let hour = Number(hourText);
    let minute = Number(groups.hourMinute ?? groups.colonMinute ?? 0);
    if (!groups.hourMinute && !groups.colonMinute && HALF_PAST.test(rest)) minute = 30;
    // "3 da tarde" e "8 da noite" são 15h e 20h; "12 da tarde" já está em 24h.
    if (hour >= 1 && hour <= 11 && AFTERNOON_OR_NIGHT.test(rest)) hour += 12;
    else if (hour === 12 && MORNING.test(rest)) hour = 0;
    found.push(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  }
  return found.filter((value, index) => found.indexOf(value) === index);
}

export function hasSchedulingTime(text: string): boolean {
  return extractSchedulingTimes(text).length > 0;
}
