export type TransactionalAction =
  | "schedule_meeting"
  | "schedule_visit"
  | "reschedule_meeting"
  | "reschedule_visit"
  | "cancel_meeting"
  | "cancel_visit"
  | "qualify_lead";

export type MeetingProvisioningStatus =
  | "not_required"
  | "pending"
  | "processing"
  | "ready"
  | "failed"
  | "uncertain";

export interface AppointmentOutcomeFacts {
  start: string;
  end: string;
  durationMinutes: number;
  timezone: string;
  unitId: string;
  unitName: string;
  appointmentStatus: string;
  meetingProvisioningStatus?: MeetingProvisioningStatus;
  meetingUrl?: string;
}

export interface QualificationOutcomeFacts {
  qualificationRegistered: true;
  changed: boolean;
}

export type TransactionalSuccessFacts = AppointmentOutcomeFacts | QualificationOutcomeFacts;

export type TransactionalOutcome =
  | {
      journalId: string;
      status: "succeeded";
      action: TransactionalAction;
      occurredAt: string;
      facts: TransactionalSuccessFacts;
    }
  | {
      journalId: string;
      status: "failed";
      action: TransactionalAction;
      occurredAt: string;
      facts: {
        reason: "operational_error" | "invalid_result" | "inconsistent_result" | "provisioning_failed";
      };
    }
  | {
      journalId: string;
      status: "pending";
      action: TransactionalAction;
      occurredAt: string;
      facts: {
        reason: "in_progress" | "provisioning_pending" | "provisioning_uncertain";
      };
    };

export type TransactionClaimType =
  | "transaction_status"
  | "start_at"
  | "end_at"
  | "duration_minutes"
  | "timezone"
  | "unit_id"
  | "unit_name"
  | "appointment_status"
  | "meeting_provisioning_status"
  | "meeting_url"
  | "qualification_registered";

export interface TransactionalClaim {
  journalId: string;
  action: TransactionalAction;
  claimType: TransactionClaimType;
  normalizedValue: string;
}

const ACTION_TOOL_NAMES: Record<TransactionalAction, string> = {
  schedule_meeting: "agendar_reuniao",
  schedule_visit: "agendar_visita",
  reschedule_meeting: "reagendar_reuniao",
  reschedule_visit: "reagendar_visita",
  cancel_meeting: "cancelar_reuniao",
  cancel_visit: "cancelar_visita",
  qualify_lead: "qualificar_lead"
};

export function transactionalToolName(action: TransactionalAction): string {
  return ACTION_TOOL_NAMES[action];
}

export function sanitizeOperationalError(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL_REMOVIDO]")
    .replace(/(?<!\d)(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?9?\d{4}[-\s]?\d{4}(?!\d)/g, "[TELEFONE_REMOVIDO]")
    .replace(/https?:\/\/[^\s"']+/gi, "[URL_REMOVIDA]")
    .replace(/\b(?:bearer|token|secret|api.?key|senha)\s*[:=]?\s*[A-Za-z0-9._~+/-]{8,}/gi, "[SEGREDO_REMOVIDO]")
    .slice(0, 1_000);
}

const CUSTOMER_TRANSACTION_ACTIONS = new Set<TransactionalAction>([
  "schedule_meeting",
  "schedule_visit",
  "reschedule_meeting",
  "reschedule_visit",
  "cancel_meeting",
  "cancel_visit"
]);

const UNPROVEN_SCHEDULING_SUCCESS = new RegExp([
  "\\b(?:agendad[oa]|reagendad[oa]|cancelad[oa]|reservad[oa])\\b",
  "\\b(?:agendei|reagendei|cancelei|reservei)\\b",
  "\\bconsegui\\s+(?:agendar|reagendar|cancelar|reservar)\\b",
  "\\b(?:reuni[aã]o|visita|hor[aá]rio|compromisso)\\s+(?:(?:foi|est[aá]|ficou)\\s+)?"
    + "(?:confirmad[oa]|marcad[oa]|criad[oa]|agendad[oa]|reagendad[oa]|cancelad[oa])\\b"
].join("|"), "iu");

// agendar_reuniao/agendar_visita ficam desabilitadas quando já existe um
// compromisso ativo (ver hasActiveAppointment em process-message.ts), então
// nesse estado "agendad[oa]"/confirmação de estado nunca pode ser uma
// alegação de ação nova — só reagendar/cancelar continuam sendo risco real.
const UNPROVEN_SCHEDULING_SUCCESS_WITH_ACTIVE_APPOINTMENT = new RegExp([
  "\\b(?:reagendad[oa]|cancelad[oa])\\b",
  "\\b(?:reagendei|cancelei)\\b",
  "\\bconsegui\\s+(?:reagendar|cancelar)\\b"
].join("|"), "iu");

const UNPROVEN_REGISTRATION_SUCCESS = new RegExp([
  "\\bconsegui\\s+(?:cadastrar|registrar)\\b",
  "\\b(?:deu\\s+(?:tudo\\s+)?certo|tudo\\s+(?:deu\\s+)?certo)\\b",
  "\\b(?:cadastro|qualifica(?:ç[aã]o)?)\\s+(?:(?:foi|est[aá]|ficou)\\s+)?"
    + "(?:conclu[ií]d[oa]|registrad[oa])\\b",
  "\\b(?:lead|contato|interesse|informa(?:ç[oõ]es))\\s+(?:(?:foi|est[aá]|ficou)\\s+)?registrad[oa]\\b",
  "\\b(?:cadastrei|registrei)\\s+(?:o\\s+)?(?:lead|contato|interesse|informa(?:ç[oõ]es))\\b"
].join("|"), "iu");

// Após uma qualificação bem-sucedida a continuação do modelo é enviada ao
// contato; estes termos nunca podem chegar até ele (avaliação interna do lead).
const QUALIFICATION_INTERNAL_LEAK =
  /\b(?:notas?|estrelas?|pontua[çc][ãa]o|classificad\w*|classifica[çc]\w*|qualificad\w*|qualifica[çc]\w*|desqualifica\w*|avalia[çc][ãoõ]\w*|score)\b/iu;

export const QUALIFICATION_NEUTRAL_ACK = "Perfeito, registrei essas informações.";

const EXPLICIT_TRANSACTIONAL_NEGATION = new RegExp([
  "\\bn[aã]o\\s+(?:consegui|pude)\\s+(?:agendar|reagendar|cancelar|reservar|cadastrar|registrar)\\b",
  "\\bn[aã]o\\s+(?:(?:foi|est[aá]|ficou)\\s+)?"
    + "(?:confirmad[oa]|marcad[oa]|criad[oa]|agendad[oa]|reagendad[oa]|cancelad[oa]|reservad[oa]|registrad[oa])\\b",
  "\\bsem\\s+(?:confirma(?:ç[aã]o)?|agendamento|reserva|registro)\\b",
  "\\bainda\\s+n[aã]o\\b"
].join("|"), "iu");

function hasUnprovenSuccessClause(text: string, pattern: RegExp): boolean {
  return text
    .split(/(?<=[.!?;])\s+|,\s+(?=(?:mas|por[eé]m|contudo|entretanto|ent[aã]o)\b)/iu)
    .some((clause) =>
      !clause.includes("?")
      && pattern.test(clause)
      && !EXPLICIT_TRANSACTIONAL_NEGATION.test(clause)
    );
}

export function claimsUnprovenTransactionalSuccess(
  text: string,
  hasActiveAppointment = false
): boolean {
  const schedulingPattern = hasActiveAppointment
    ? UNPROVEN_SCHEDULING_SUCCESS_WITH_ACTIVE_APPOINTMENT
    : UNPROVEN_SCHEDULING_SUCCESS;
  return hasUnprovenSuccessClause(text, schedulingPattern)
    || hasUnprovenSuccessClause(text, UNPROVEN_REGISTRATION_SUCCESS);
}

export const UNPROVEN_TRANSACTIONAL_SUCCESS_ABSTENTION =
  "Ainda não consegui confirmar essa ação. Vou verificar a conclusão antes de afirmar que deu certo.";

function appointmentFacts(outcome: TransactionalOutcome): AppointmentOutcomeFacts | undefined {
  if (outcome.status !== "succeeded" || !("start" in outcome.facts)) return undefined;
  return outcome.facts;
}

function normalizedOutcome(outcome: TransactionalOutcome): string {
  return JSON.stringify({
    status: outcome.status,
    action: outcome.action,
    facts: outcome.facts
  });
}

interface CustomerOutcomeResolution {
  outcome: TransactionalOutcome;
  inconsistentSuccesses: boolean;
}

/**
 * Uma ação persistida com sucesso continua sendo a verdade do turno mesmo se
 * uma tentativa anterior falhou (pré-requisito ainda não cumprido) ou se uma
 * repetição posterior encontrou o efeito já criado. Falhas não desfazem o
 * efeito transacional. Só dois sucessos factualmente divergentes são uma
 * inconsistência real que exige abstenção.
 */
function resolveLatestCustomerOutcome(
  outcomes: readonly TransactionalOutcome[]
): CustomerOutcomeResolution | undefined {
  const customerOutcomes = [...outcomes]
    .filter((outcome) => CUSTOMER_TRANSACTION_ACTIONS.has(outcome.action))
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  const latestAttempt = customerOutcomes.at(-1);
  if (!latestAttempt) return undefined;

  const successfulAttempts = customerOutcomes.filter((outcome) =>
    outcome.action === latestAttempt.action && outcome.status === "succeeded"
  );
  if (!successfulAttempts.length) {
    return { outcome: latestAttempt, inconsistentSuccesses: false };
  }
  return {
    outcome: successfulAttempts.at(-1)!,
    inconsistentSuccesses: new Set(successfulAttempts.map(normalizedOutcome)).size > 1
  };
}

interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
}

function localDateTimeParts(value: string, timezone: string): LocalDateTimeParts {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return {
    year: Number(part("year")),
    month: Number(part("month")),
    day: Number(part("day")),
    hour: Number(part("hour")),
    minute: Number(part("minute")),
    weekday: part("weekday")
  };
}

function formatNaturalLocalStart(value: string, timezone: string, reference: string): string {
  const start = localDateTimeParts(value, timezone);
  const current = localDateTimeParts(reference, timezone);
  const startDay = Date.UTC(start.year, start.month - 1, start.day);
  const currentDay = Date.UTC(current.year, current.month - 1, current.day);
  const dayDifference = Math.round((startDay - currentDay) / 86_400_000);
  const dayLabel = dayDifference === 0
    ? "hoje"
    : dayDifference === 1
      ? "amanhã"
      : `${start.weekday}, ${String(start.day).padStart(2, "0")}/${String(start.month).padStart(2, "0")}`;
  const timeLabel = `${start.hour}h${start.minute ? String(start.minute).padStart(2, "0") : ""}`;
  return `${dayLabel} às ${timeLabel}`;
}

function actionNoun(action: TransactionalAction): string {
  if (action.startsWith("schedule")) return action.endsWith("meeting") ? "a reunião" : "a visita";
  if (action.startsWith("reschedule")) return action.endsWith("meeting") ? "a reunião" : "a visita";
  return action.endsWith("meeting") ? "a reunião" : "a visita";
}

function abstentionText(outcome: TransactionalOutcome): string {
  const noun = actionNoun(outcome.action);
  if (outcome.status === "pending") {
    return `Ainda não consegui confirmar ${noun}. Vou verificar a conclusão antes de afirmar que deu certo.`;
  }
  return `Não consegui concluir ${noun}. Vou verificar o que aconteceu antes de confirmar qualquer alteração.`;
}

function claimsFor(outcome: TransactionalOutcome): TransactionalClaim[] {
  const claims: TransactionalClaim[] = [{
    journalId: outcome.journalId,
    action: outcome.action,
    claimType: "transaction_status",
    normalizedValue: outcome.status
  }];
  const facts = appointmentFacts(outcome);
  if (facts) {
    claims.push(
      { journalId: outcome.journalId, action: outcome.action, claimType: "start_at", normalizedValue: facts.start },
      { journalId: outcome.journalId, action: outcome.action, claimType: "end_at", normalizedValue: facts.end },
      { journalId: outcome.journalId, action: outcome.action, claimType: "duration_minutes", normalizedValue: String(facts.durationMinutes) },
      { journalId: outcome.journalId, action: outcome.action, claimType: "timezone", normalizedValue: facts.timezone },
      { journalId: outcome.journalId, action: outcome.action, claimType: "unit_id", normalizedValue: facts.unitId },
      { journalId: outcome.journalId, action: outcome.action, claimType: "unit_name", normalizedValue: facts.unitName },
      { journalId: outcome.journalId, action: outcome.action, claimType: "appointment_status", normalizedValue: facts.appointmentStatus }
    );
    if (facts.meetingProvisioningStatus) {
      claims.push({
        journalId: outcome.journalId,
        action: outcome.action,
        claimType: "meeting_provisioning_status",
        normalizedValue: facts.meetingProvisioningStatus
      });
    }
    if (facts.meetingUrl) {
      claims.push({
        journalId: outcome.journalId,
        action: outcome.action,
        claimType: "meeting_url",
        normalizedValue: facts.meetingUrl
      });
    }
  } else if (outcome.status === "succeeded" && "qualificationRegistered" in outcome.facts) {
    claims.push({
      journalId: outcome.journalId,
      action: outcome.action,
      claimType: "qualification_registered",
      normalizedValue: "true"
    });
  }
  return claims;
}

function successfulAppointmentText(outcome: Extract<TransactionalOutcome, { status: "succeeded" }>): string {
  const facts = appointmentFacts(outcome)!;
  const localStart = formatNaturalLocalStart(facts.start, facts.timezone, outcome.occurredAt);
  if (outcome.action.startsWith("cancel")) {
    return `Fechado, cancelei ${actionNoun(outcome.action)}.`;
  }
  const base = outcome.action.startsWith("reschedule")
    ? `Fechado, ajustei pra ${localStart}${outcome.action.endsWith("meeting") ? " pelo Google Meet" : ""}`
    : `Fechado, ficou marcado pra ${localStart}${outcome.action.endsWith("meeting") ? " pelo Google Meet" : ""}`;
  return facts.meetingUrl
    ? `${base}\n\nEsse é o link pra entrar na chamada: ${facts.meetingUrl}`
    : base;
}

export function transactionalReplyCorrection(
  modelText: string,
  outcomes: readonly TransactionalOutcome[]
): string | undefined {
  const resolved = resolveLatestCustomerOutcome(outcomes);
  if (!resolved || resolved.inconsistentSuccesses || resolved.outcome.status !== "succeeded") return undefined;
  const latest = resolved.outcome;
  const facts = appointmentFacts(latest);
  if (!facts) return undefined;
  const normalized = modelText.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
  const local = localDateTimeParts(facts.start, facts.timezone);
  const timePattern = new RegExp(`\\b${local.hour}(?:h(?:${String(local.minute).padStart(2, "0")})?|:${String(local.minute).padStart(2, "0")})\\b`, "u");
  const actionConfirmed = latest.action.startsWith("cancel")
    ? /\bcancel\w*/u.test(normalized)
    : latest.action.startsWith("reschedule")
      ? /\b(?:ajust\w*|reagend\w*|remarc\w*)/u.test(normalized)
      : /\b(?:agend\w*|marcad\w*|confirmad\w*|reservad\w*|ficou\s+marcad\w*)/u.test(normalized);
  const hasCorrectTime = latest.action.startsWith("cancel") || timePattern.test(normalized);
  const hasCorrectMeetingUrl = !facts.meetingUrl || modelText.includes(facts.meetingUrl);
  if (actionConfirmed && hasCorrectTime && hasCorrectMeetingUrl) return undefined;

  const exactOutcome = successfulAppointmentText(latest);
  return `A ação de agenda já foi concluída e persistida. Escreva você mesmo uma confirmação curta e natural usando exatamente estes fatos: ${exactOutcome}. Não invente outro horário ou link, não peça nova confirmação e não mencione sistema, ferramenta, erro, ajuste interno ou transferência.`;
}

export function composeActiveAppointmentConfirmation(
  appointment: { start: string; meetLink?: string },
  timezone: string,
  reference = new Date().toISOString()
): string {
  const localStart = formatNaturalLocalStart(appointment.start, timezone, reference);
  const base = `Fechado, ficou marcado pra ${localStart} pelo Google Meet`;
  return appointment.meetLink
    ? `${base}\n\nEsse é o link pra entrar na chamada: ${appointment.meetLink}`
    : base;
}

export function composeTransactionalReply(
  modelText: string,
  outcomes: readonly TransactionalOutcome[],
  hasActiveAppointment = false
): { text: string; claims: TransactionalClaim[] } {
  const byJournal = new Map<string, TransactionalOutcome>();
  for (const outcome of outcomes) byJournal.set(outcome.journalId, outcome);
  const unique = [...byJournal.values()].sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt)
  );
  const customerOutcomes = unique.filter((outcome) => CUSTOMER_TRANSACTION_ACTIONS.has(outcome.action));
  const qualification = unique.filter((outcome) => outcome.action === "qualify_lead").at(-1);
  if (!customerOutcomes.length) {
    if (!qualification) {
      return claimsUnprovenTransactionalSuccess(modelText, hasActiveAppointment)
        ? { text: UNPROVEN_TRANSACTIONAL_SUCCESS_ABSTENTION, claims: [] }
        : { text: modelText, claims: [] };
    }
    if (qualification.status !== "succeeded") {
      return {
        text: "Não consegui registrar essas informações com segurança. Vou verificar antes de confirmar.",
        claims: claimsFor(qualification)
      };
    }
    // A qualificação é interna: preserva a continuação do modelo (ponte para o
    // agendamento) e só cai no reconhecimento neutro quando o texto vaza a
    // avaliação interna ou alega um agendamento que não aconteceu.
    const continuation = modelText.trim();
    if (!continuation
      || QUALIFICATION_INTERNAL_LEAK.test(continuation)
      || hasUnprovenSuccessClause(continuation, UNPROVEN_SCHEDULING_SUCCESS)) {
      return { text: QUALIFICATION_NEUTRAL_ACK, claims: claimsFor(qualification) };
    }
    return { text: continuation, claims: claimsFor(qualification) };
  }

  const resolved = resolveLatestCustomerOutcome(customerOutcomes)!;
  const latest = resolved.outcome;
  if (resolved.inconsistentSuccesses) {
    const inconsistent: TransactionalOutcome = {
      journalId: latest.journalId,
      status: "failed",
      action: latest.action,
      occurredAt: latest.occurredAt,
      facts: { reason: "inconsistent_result" }
    };
    return { text: abstentionText(inconsistent), claims: claimsFor(inconsistent) };
  }
  if (latest.status !== "succeeded") {
    return { text: abstentionText(latest), claims: claimsFor(latest) };
  }
  return {
    text: modelText.trim() && !transactionalReplyCorrection(modelText, [latest])
      ? modelText.trim()
      : successfulAppointmentText(latest),
    claims: claimsFor(latest)
  };
}

export function customerTransactionalOutcomeExists(outcomes: readonly TransactionalOutcome[]): boolean {
  return outcomes.some((outcome) => CUSTOMER_TRANSACTION_ACTIONS.has(outcome.action));
}

export function successfulCustomerTransactionalOutcomeExists(
  outcomes: readonly TransactionalOutcome[]
): boolean {
  return outcomes.some((outcome) =>
    CUSTOMER_TRANSACTION_ACTIONS.has(outcome.action) && outcome.status === "succeeded"
  );
}
