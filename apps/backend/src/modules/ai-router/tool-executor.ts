import { z } from "zod";
import { logger } from "../../logger.js";
import type {
  ToolCallJournalInput,
  ToolCallJournalResult
} from "../messages/repository.js";
import {
  sanitizeOperationalError,
  type AppointmentOutcomeFacts,
  type MeetingProvisioningStatus,
  type TransactionalAction,
  type TransactionalOutcome
} from "../messages/transactional-outcome.js";
import type { ToolExecutionContext } from "./openrouter.js";
import {
  isToolAllowedInCanonicalState,
  type CanonicalConversationState
} from "../messages/state-tool-gating.js";
import {
  atualizarStatusLead, buscarDisponibilidade, cancelAppointment, createAppointment, createQualifiedMeetingAppointment,
  enviarPropostaParceiro, findLatestActiveAppointment, findLeadByPhone, leadMapper, leadStatus, listCategorias,
  listParceiros, listUnidades, localHourMinute, qualifyLead, qualifyLeadBody, rescheduleAppointment,
  markLeadDisqualified, upsertLead, verificarHorarios, type SchedulingPeriod
} from "../scheduling/service.js";

export type ToolExecutor = (name: string, argumentsJson: string, context?: ToolExecutionContext) => Promise<string>;
export type ToolCallJournal = (
  input: ToolCallJournalInput,
  execute: () => Promise<string>
) => Promise<ToolCallJournalResult | string>;

export interface ToolExecutorJournalOptions {
  conversationId: string;
  inboundExternalId: string;
  aiTurnId: string;
  journal: ToolCallJournal;
  enabledToolNames?: readonly string[];
  canonicalState?: CanonicalConversationState;
  facebookAttribution?: Record<string, unknown>;
  onMeetingScheduled?: (appointment: Record<string, unknown> & { meet_link: string }) => void;
  onMeetingAvailabilityChecked?: (result: {
    agendaId: string;
    date: string;
    timezone?: string;
    slots: Array<{ start: string; end?: string }>;
    requestedTime?: string;
    available: boolean;
    durationMinutes?: number;
    /** false quando o período pedido não existe em nenhum dos dias pesquisados. */
    periodSatisfied?: boolean;
  }) => void;
  onTransactionalOutcome?: (outcome: TransactionalOutcome) => void;
  schedulingIntent?: { kind: "direct_schedule" | "availability_check"; time: string };
  schedulingPeriodPreference?: SchedulingPeriod;
  /**
   * Indica que o runtime já resolveu se o contato pediu manhã/tarde. Quando
   * true, a ausência de schedulingPeriodPreference também é autoritativa: o
   * modelo não pode inventar um período e fazer a busca pular vagas de hoje.
   */
  schedulingPeriodPreferenceResolved?: boolean;
  directSchedulingAction?: "agendar_reuniao" | "reagendar_reuniao";
  minimumLeadTimeMinutes?: number;
  searchBusinessContext?: (term: string) => Promise<string>;
  existingLead?: {
    id: string;
    name?: string;
    interestCategoryId?: string;
    unitId?: string;
    partnerId?: string;
    source: string;
    status: string;
    facebookAttribution: Record<string, unknown>;
  };
  tripzBoletoPaymentSignal?: boolean;
  capabilityEnabled?: (toolName: string) => Promise<boolean>;
}

function ok(payload: unknown): string { return JSON.stringify(payload); }
function fail(message: string): string { return JSON.stringify({ erro: message }); }

/** Só argumentos operacionais são logados; texto livre do contato nunca. */
const LOGGABLE_TOOL_ARGUMENTS = new Set([
  "agenda_id", "unidade_id", "data", "periodo", "horario_solicitado", "start", "status",
  "categoria_interesse_id", "parceiro_id", "estrelas"
]);

function toolLogArguments(args: Record<string, unknown>): Record<string, unknown> {
  const logged = Object.fromEntries(
    Object.entries(args).filter(([key, value]) =>
      LOGGABLE_TOOL_ARGUMENTS.has(key) && (typeof value === "string" || typeof value === "number"))
  );
  return { ...logged, argumentKeys: Object.keys(args).sort().join(",") || undefined };
}

function toolResultSummary(name: string, result: string): Record<string, unknown> {
  try {
    const payload = JSON.parse(result) as Record<string, unknown>;
    if (typeof payload.erro === "string") return { outcome: "tool_error", resultSummary: payload.erro.slice(0, 200) };
    if (name === "verificar_horarios_reuniao" || name === "verificar_horarios") {
      const slots = Array.isArray(payload.horarios) ? payload.horarios : [];
      return {
        outcome: slots.length ? "slots_found" : "no_slots",
        slotCount: slots.length,
        resultDate: payload.data,
        requestedDate: payload.data_solicitada,
        requestedPeriod: payload.periodo_solicitado,
        periodSatisfied: payload.periodo_atendido,
        requestedSlotAvailable: (payload.horario_solicitado as { disponivel?: boolean } | undefined)?.disponivel
      };
    }
    if (payload.agendamento && typeof payload.agendamento === "object") {
      const appointment = payload.agendamento as Record<string, unknown>;
      return { outcome: "appointment_persisted", appointmentStatus: appointment.status, appointmentStart: appointment.start };
    }
    return { outcome: "ok", resultKeys: Object.keys(payload).sort().join(",") };
  } catch {
    return { outcome: "unparseable_result" };
  }
}

function compactAvailabilityResult(value: Record<string, unknown>): Record<string, unknown> {
  // O modelo escolhe o horário lendo este payload. Sem a hora local ele precisa
  // converter o ISO em UTC de cabeça e já agendou o slot errado por causa disso,
  // então `hora` acompanha todo slot devolvido.
  const timezone = typeof value.timezone === "string" ? value.timezone : "America/Sao_Paulo";
  const localTime = (start: unknown): string | undefined =>
    typeof start === "string" && !Number.isNaN(new Date(start).getTime())
      ? localHourMinute(new Date(start), timezone)
      : undefined;
  const compactSlots = (slots: unknown): Array<{
    hora?: string;
    start: string;
    end?: string;
    vagas?: number;
    capacidade?: number;
  }> => Array.isArray(slots)
    ? slots.flatMap((slot) => {
        if (!slot || typeof slot !== "object" || Array.isArray(slot)) return [];
        const row = slot as Record<string, unknown>;
        if (typeof row.start !== "string") return [];
        const hora = localTime(row.start);
        return [{
          ...(hora ? { hora } : {}),
          start: row.start,
          ...(typeof row.end === "string" ? { end: row.end } : {}),
          ...(typeof row.vagas === "number" ? { vagas: row.vagas } : {}),
          ...(typeof row.capacidade === "number" ? { capacidade: row.capacidade } : {})
        }];
      }).slice(0, 3)
    : [];
  const requested = value.horario_solicitado && typeof value.horario_solicitado === "object"
    && !Array.isArray(value.horario_solicitado)
    ? value.horario_solicitado as Record<string, unknown>
    : undefined;
  const requestedTime = requested ? localTime(requested.start) : undefined;
  return {
    data: value.data,
    unidade_id: value.unidade_id,
    timezone: value.timezone,
    duration_min: value.duration_min,
    horarios: compactSlots(value.horarios),
    ...(requested ? {
      horario_solicitado: {
        ...(requestedTime ? { hora: requestedTime } : {}),
        start: requested.start,
        end: requested.end,
        ...(typeof requested.vagas === "number" ? { vagas: requested.vagas } : {}),
        ...(typeof requested.capacidade === "number" ? { capacidade: requested.capacidade } : {}),
        disponivel: requested.disponivel === true
      }
    } : {}),
    ...(value.horarios_proximos ? { horarios_proximos: compactSlots(value.horarios_proximos) } : {})
  };
}

const MEETING_CAPACITY_INSTRUCTION = "Cada item de horarios representa um horário único. O campo vagas informa quantos closers ainda estão livres nesse mesmo horário; enquanto vagas for maior que zero, o horário continua disponível mesmo que já exista outra reunião nele.";

const SCHEDULING_COMMIT_TOOLS = new Set([
  "agendar_reuniao", "reagendar_reuniao", "agendar_visita", "reagendar_visita"
]);

const TRANSACTIONAL_TOOL_ACTIONS: Record<string, TransactionalAction> = {
  agendar_reuniao: "schedule_meeting",
  agendar_visita: "schedule_visit",
  reagendar_reuniao: "reschedule_meeting",
  reagendar_visita: "reschedule_visit",
  cancelar_reuniao: "cancel_meeting",
  cancelar_visita: "cancel_visit",
  qualificar_lead: "qualify_lead"
};

function stringFact(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim();
}

function meetingProvisioningStatus(value: unknown): MeetingProvisioningStatus | undefined {
  return [
    "not_required", "pending", "processing", "ready", "failed", "uncertain"
  ].includes(String(value)) ? value as MeetingProvisioningStatus : undefined;
}

function googleMeetUrl(value: unknown): string | undefined {
  const raw = stringFact(value);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" && parsed.hostname === "meet.google.com" ? raw : undefined;
  } catch {
    return undefined;
  }
}

function appointmentFacts(value: unknown): AppointmentOutcomeFacts | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const start = stringFact(row.start);
  const end = stringFact(row.end);
  const timezone = stringFact(row.timezone);
  const unitId = stringFact(row.unidade_id);
  const unitName = stringFact(row.unidade_nome);
  const appointmentStatus = stringFact(row.status);
  if (!start || !end || !timezone || !unitId || !unitName || !appointmentStatus) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch {
    return undefined;
  }
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  const durationMinutes = (endMs - startMs) / 60_000;
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) return undefined;
  const declaredDuration = row.duration_min ?? row.duracao_slot_min;
  if (declaredDuration !== undefined && Number(declaredDuration) !== durationMinutes) return undefined;
  const meetingUrl = googleMeetUrl(row.meet_link) ?? googleMeetUrl(row.meeting_url);
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    durationMinutes,
    timezone,
    unitId,
    unitName,
    appointmentStatus,
    ...(meetingProvisioningStatus(row.meeting_provisioning_status)
      ? { meetingProvisioningStatus: meetingProvisioningStatus(row.meeting_provisioning_status) }
      : {}),
    ...(meetingUrl ? { meetingUrl } : {})
  };
}

function failedOutcome(
  journal: ToolCallJournalResult,
  action: TransactionalAction,
  reason: Extract<TransactionalOutcome, { status: "failed" }>["facts"]["reason"]
): TransactionalOutcome {
  return {
    journalId: journal.journalId,
    status: "failed",
    action,
    occurredAt: journal.occurredAt,
    facts: { reason }
  };
}

function transactionalOutcome(
  toolName: string,
  journal: ToolCallJournalResult
): TransactionalOutcome | undefined {
  const action = TRANSACTIONAL_TOOL_ACTIONS[toolName];
  if (!action) return undefined;
  if (journal.status === "failed") return failedOutcome(journal, action, "operational_error");
  if (journal.status === "pending") {
    return {
      journalId: journal.journalId,
      status: "pending",
      action,
      occurredAt: journal.occurredAt,
      facts: { reason: "in_progress" }
    };
  }
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(journal.resultText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return failedOutcome(journal, action, "invalid_result");
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return failedOutcome(journal, action, "invalid_result");
  }
  if (action === "qualify_lead") {
    if (payload.qualificacao_registrada !== true) {
      return failedOutcome(journal, action, "inconsistent_result");
    }
    return {
      journalId: journal.journalId,
      status: "succeeded",
      action,
      occurredAt: journal.occurredAt,
      facts: {
        qualificationRegistered: true,
        changed: payload.alterado === true
      }
    };
  }
  const facts = appointmentFacts(payload.agendamento);
  if (!facts) return failedOutcome(journal, action, "invalid_result");
  const expectedStatus = action.startsWith("cancel")
    ? "cancelado"
    // O domínio re-confirma no reagendamento (scheduling/service.ts grava
    // status='confirmado' desde 2026-08-27) — esperar 'reagendado' aqui
    // journalizava TODO reschedule da IA como inconsistent_result.
    : "confirmado";
  if (facts.appointmentStatus !== expectedStatus) {
    return failedOutcome(journal, action, "inconsistent_result");
  }
  if (action.endsWith("meeting") && !action.startsWith("cancel")) {
    if (facts.meetingProvisioningStatus === "failed") {
      return failedOutcome(journal, action, "provisioning_failed");
    }
    if (facts.meetingProvisioningStatus === "pending" || facts.meetingProvisioningStatus === "processing") {
      return {
        journalId: journal.journalId,
        status: "pending",
        action,
        occurredAt: journal.occurredAt,
        facts: { reason: "provisioning_pending" }
      };
    }
    if (facts.meetingProvisioningStatus === "ready" && !facts.meetingUrl) {
      return failedOutcome(journal, action, "inconsistent_result");
    }
    // "not_required" is a terminal success state (this meeting type needs no
    // Meet link), not an unresolved provisioning attempt. Only truly
    // undecided statuses (e.g. "uncertain") should fall back to pending.
    if (facts.meetingProvisioningStatus !== "ready" && facts.meetingProvisioningStatus !== "not_required") {
      return {
        journalId: journal.journalId,
        status: "pending",
        action,
        occurredAt: journal.occurredAt,
        facts: { reason: "provisioning_uncertain" }
      };
    }
  }
  return {
    journalId: journal.journalId,
    status: "succeeded",
    action,
    occurredAt: journal.occurredAt,
    facts
  };
}

const optionalMeetingTime = z.preprocess(
  (value) => value === null || (typeof value === "string" && !value.trim()) ? undefined : value,
  z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional()
);

function parseArgs(argumentsJson: string): Record<string, unknown> {
  if (!argumentsJson) return {};
  try {
    const parsed = JSON.parse(argumentsJson);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function normalizedLeadValue(value: unknown): unknown {
  return typeof value === "string"
    ? value.trim().toLocaleLowerCase("pt-BR")
    : value;
}

function stableJson(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function leadRegistrationChanges(
  args: Record<string, unknown>,
  current: NonNullable<ToolExecutorJournalOptions["existingLead"]>,
  facebookAttribution: Record<string, unknown>
): boolean {
  const fields = [
    ["nome", "name"],
    ["categoria_interesse_id", "interestCategoryId"],
    ["unidade_id", "unitId"],
    ["parceiro_id", "partnerId"],
    ["status", "status"]
  ] as const;
  if (fields.some(([argument, stored]) =>
    args[argument] !== undefined
    && normalizedLeadValue(args[argument]) !== normalizedLeadValue(current[stored]))) {
    return true;
  }
  const requestedSource = args.origem ?? (Object.keys(facebookAttribution).length ? "facebook" : "whatsapp");
  if (args.origem !== undefined && normalizedLeadValue(requestedSource) !== normalizedLeadValue(current.source)) {
    return true;
  }
  return Object.keys(facebookAttribution).length > 0
    && stableJson(facebookAttribution) !== stableJson(current.facebookAttribution);
}

function existingLeadResult(lead: NonNullable<ToolExecutorJournalOptions["existingLead"]>): string {
  return ok({
    lead: {
      id: lead.id,
      nome: lead.name ?? null,
      categoria_interesse_id: lead.interestCategoryId ?? null,
      unidade_id: lead.unitId ?? null,
      parceiro_id: lead.partnerId ?? null,
      status: lead.status,
      origem: lead.source,
      origem_facebook: lead.facebookAttribution
    },
    alterado: false,
    deduplicado: true
  });
}

function discardBlankQualificationAnswers(args: Record<string, unknown>): Record<string, unknown> {
  if (!args.respostas || typeof args.respostas !== "object" || Array.isArray(args.respostas)) return args;
  return {
    ...args,
    respostas: Object.fromEntries(
      Object.entries(args.respostas).filter(([, value]) => typeof value !== "string" || value.trim().length > 0)
    )
  };
}

export type ModelSearchResult = "encontrado" | "não encontrado";

const NEGATIVE_MODEL_SEARCH_PATTERNS = [
  /^\s*nao\b/,
  /\bnao\s+(?:foi\s+)?encontrad[oa]\b/,
  /\bnao\s+(?:encontrei|localizei|achei)\b/,
  /\bsem\s+(?:resultado|resultados|registro|registros|evidencia|evidencias|confirmacao|fontes?)\b/,
  /\bnenhum(?:a)?\s+(?:resultado|registro|evidencia|confirmacao|fonte|informacao)\b/,
  /\bnao\s+(?:ha|existem?)\s+(?:resultado|resultados|registro|registros|evidencia|evidencias|confirmacao|fontes?|informacao|informacoes)\b/,
  /\bnao\s+(?:consegui|foi\s+possivel|e\s+possivel)\s+confirmar\b/,
  /\bmodelo\s+(?:inexistente|desconhecido|nao\s+confirmado)\b/,
  /\binexistente\b/,
  /^\s*no\b/,
  /\bnot\s+found\b/,
  /\bno\s+(?:results|records|evidence|confirmation)\b/,
  /\bunknown\b/
];

const POSITIVE_MODEL_SEARCH_PATTERNS = [
  /\bencontrad[oa]\b/,
  /\bexiste\b/,
  /\bconfirmad[oa]\b/,
  /\blancad[oa]\b/,
  /\banunciad[oa]\b/,
  /\bdisponivel\b/
];

export function normalizeModelSearchResult(text: string): ModelSearchResult {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
  if (NEGATIVE_MODEL_SEARCH_PATTERNS.some((pattern) => pattern.test(normalized))) return "não encontrado";
  if (POSITIVE_MODEL_SEARCH_PATTERNS.some((pattern) => pattern.test(normalized))) return "encontrado";
  return "não encontrado";
}

async function requireLead(tenantId: string, phone: string) {
  const lead = await findLeadByPhone(tenantId, phone);
  if (!lead) throw new Error("Nenhum lead registrado para este contato ainda; chame registrar_lead primeiro.");
  return lead;
}

async function requireActiveAppointment(tenantId: string, leadId: string) {
  const appointment = await findLatestActiveAppointment(tenantId, leadId);
  if (!appointment) throw new Error("Não há agendamento ativo para este lead.");
  return appointment;
}

export type ModelSearch = (modelo: string) => Promise<string>;

const optionalToolString = (max: number) => z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(1).max(max).optional()
);

async function discardUnknownLeadReferences<T extends {
  categoria_interesse_id?: string;
  unidade_id?: string;
  parceiro_id?: string;
}>(tenantId: string, input: T): Promise<T> {
  const sanitized = { ...input };
  const ignoredReferenceFields: string[] = [];
  const [categorias, unidades, parceiros] = await Promise.all([
    input.categoria_interesse_id ? listCategorias(tenantId) : Promise.resolve([]),
    input.unidade_id ? listUnidades(tenantId) : Promise.resolve([]),
    input.parceiro_id ? listParceiros(tenantId) : Promise.resolve([])
  ]);

  if (input.categoria_interesse_id && !categorias.some((item) => item.id === input.categoria_interesse_id)) {
    delete sanitized.categoria_interesse_id;
    ignoredReferenceFields.push("categoria_interesse_id");
  }
  if (input.unidade_id && !unidades.some((item) => item.id === input.unidade_id)) {
    delete sanitized.unidade_id;
    ignoredReferenceFields.push("unidade_id");
  }
  if (input.parceiro_id && !parceiros.some((item) => item.id === input.parceiro_id)) {
    delete sanitized.parceiro_id;
    ignoredReferenceFields.push("parceiro_id");
  }
  if (ignoredReferenceFields.length) {
    logger.warn({ tenantId, ignoredReferenceFields }, "Ignoring unknown optional lead references from AI tool call");
  }
  return sanitized;
}

export function createSchedulingToolExecutor(
  tenantId: string,
  phone: string,
  pesquisarModelo?: ModelSearch,
  journalOptions?: ToolExecutorJournalOptions
): ToolExecutor {
  let currentLead = journalOptions?.existingLead;
  let currentLeadResult = currentLead ? existingLeadResult(currentLead) : undefined;
  let verifiedRequestedMeetingStart: string | undefined;
  let completedDirectSchedulingResult: string | undefined;
  // Slots que a agenda devolveu neste turno. O modelo lê o payload e reescreve o
  // ISO na chamada de agendamento, e já errou o fuso ao fazer isso; se ele citar
  // um instante que a agenda nunca ofereceu, a reserva não sai.
  const offeredMeetingStarts = new Set<string>();
  const executeSchedulingTool: ToolExecutor = async (name, argumentsJson, context) => {
    // Handoff is a platform-owned state transition. Explicit requests are
    // handled before the model is called, so even stale configurations or a
    // forged provider tool call cannot transfer a conversation from here.
    if (name === "transferir_atendente") {
      return fail("Transferência humana só pode ser acionada pelo pedido explícito do contato.");
    }
    if (name === journalOptions?.directSchedulingAction && completedDirectSchedulingResult) {
      return completedDirectSchedulingResult;
    }
    let args = parseArgs(argumentsJson);
    if (journalOptions?.enabledToolNames && !journalOptions.enabledToolNames.includes(name)) {
      return fail(`Ferramenta não habilitada para este agente: ${name}`);
    }
    // Capabilities can be revoked after the provider context was assembled.
    // Re-evaluate immediately before any tool-side read or mutation.
    if (journalOptions?.capabilityEnabled && !await journalOptions.capabilityEnabled(name)) {
      return fail(`Funcionalidade indisponível para esta empresa: ${name}`);
    }
    if (journalOptions?.canonicalState
      && !isToolAllowedInCanonicalState(journalOptions.canonicalState, name)) {
      return fail(`Ferramenta incompatível com o estado ${journalOptions.canonicalState}: ${name}`);
    }
    if (name === "registrar_lead" && currentLead
      && !leadRegistrationChanges(args, currentLead, journalOptions?.facebookAttribution ?? {})) {
      logger.debug({ tenantId, tool: name }, "Skipping duplicate AI lead registration");
      return currentLeadResult ?? existingLeadResult(currentLead);
    }
    if (SCHEDULING_COMMIT_TOOLS.has(name)) {
      if (journalOptions?.schedulingIntent?.kind === "direct_schedule") {
        if (!verifiedRequestedMeetingStart) {
          return fail(`Confirme primeiro na agenda o horário solicitado de ${journalOptions.schedulingIntent.time}.`);
        }
        // Never trust the model to copy the selected slot back correctly. The
        // transactional tool receives the exact start returned by availability.
        args = { ...args, start: verifiedRequestedMeetingStart };
        argumentsJson = JSON.stringify(args);
      } else if (offeredMeetingStarts.size && typeof args.start === "string"
        && !offeredMeetingStarts.has(new Date(args.start).toISOString())) {
        return fail("Esse horário não está entre os que a agenda devolveu neste turno. Use exatamente o campo start de um dos horários retornados por verificar_horarios_reuniao, sem converter fuso.");
      }
    }
    const execute = async () => {
      const startedAt = Date.now();
      try {
        const result = await executeTool(name, args, tenantId, phone, pesquisarModelo, journalOptions);
        logger.info({
          event: "ai_tool_call",
          tenantId,
          conversationId: journalOptions?.conversationId,
          aiTurnId: journalOptions?.aiTurnId,
          tool: name,
          ordinal: context?.ordinal,
          canonicalState: journalOptions?.canonicalState,
          arguments: toolLogArguments(args),
          durationMs: Date.now() - startedAt,
          ...toolResultSummary(name, result)
        }, "AI tool call completed");
        return result;
      } catch (error) {
        logger.warn({
          event: "ai_tool_call",
          tenantId,
          conversationId: journalOptions?.conversationId,
          aiTurnId: journalOptions?.aiTurnId,
          tool: name,
          ordinal: context?.ordinal,
          arguments: toolLogArguments(args),
          durationMs: Date.now() - startedAt,
          errorType: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof z.ZodError ? "invalid_arguments" : sanitizeOperationalError(error)
        }, "AI tool call failed");
        throw error;
      }
    };
    let result: string;
    if (!journalOptions || !context) {
      try {
        result = await execute();
      } catch (error) {
        const message = error instanceof z.ZodError
          ? `Argumentos inválidos: ${error.issues.map((issue) =>
            `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`
          ).join("; ")}`
          : sanitizeOperationalError(error);
        logger.debug({ tenantId, tool: name, errorType: error instanceof Error ? error.name : "UnknownError" }, "AI tool call failed");
        result = fail(message);
      }
    } else {
      try {
        const journal = await journalOptions.journal({
          tenantId,
          conversationId: journalOptions.conversationId,
          inboundExternalId: journalOptions.inboundExternalId,
          aiTurnId: journalOptions.aiTurnId,
          callOrdinal: context.ordinal,
          providerCallId: context.providerCallId,
          toolName: name,
          argumentsJson
        }, execute);
        if (typeof journal === "string") {
          result = journal;
        } else {
          const outcome = transactionalOutcome(name, journal);
          if (outcome) journalOptions.onTransactionalOutcome?.(outcome);
          result = journal.status === "succeeded"
            ? journal.resultText
            : journal.status === "failed" && journal.resultText
              ? journal.resultText
              : fail(journal.errorMessage);
        }
      } catch (error) {
        const message = sanitizeOperationalError(error);
        logger.debug({ tenantId, tool: name, errorType: error instanceof Error ? error.name : "UnknownError" }, "AI tool journal failed");
        if (TRANSACTIONAL_TOOL_ACTIONS[name]) throw error;
        result = fail(message);
      }
    }
    if (name === "registrar_lead") {
      try {
        const payload = JSON.parse(result) as {
          lead?: {
            id?: unknown;
            nome?: unknown;
            categoria_interesse_id?: unknown;
            unidade_id?: unknown;
            parceiro_id?: unknown;
            status?: unknown;
            origem?: unknown;
            origem_facebook?: unknown;
          };
        };
        if (payload.lead && typeof payload.lead.id === "string") {
          currentLead = {
            id: payload.lead.id,
            name: typeof payload.lead.nome === "string" ? payload.lead.nome : undefined,
            interestCategoryId: typeof payload.lead.categoria_interesse_id === "string" ? payload.lead.categoria_interesse_id : undefined,
            unitId: typeof payload.lead.unidade_id === "string" ? payload.lead.unidade_id : undefined,
            partnerId: typeof payload.lead.parceiro_id === "string" ? payload.lead.parceiro_id : undefined,
            source: typeof payload.lead.origem === "string" ? payload.lead.origem : "whatsapp",
            status: typeof payload.lead.status === "string" ? payload.lead.status : "em_atendimento",
            facebookAttribution: payload.lead.origem_facebook && typeof payload.lead.origem_facebook === "object"
              ? payload.lead.origem_facebook as Record<string, unknown>
              : {}
          };
          currentLeadResult = result;
        }
      } catch {
        // A failed or malformed result is not cached, so a later corrected
        // registration attempt can still execute normally.
      }
    }
    if (journalOptions?.onMeetingScheduled && (name === "agendar_reuniao" || name === "agendar_visita")) {
      try {
        const payload = JSON.parse(result) as { agendamento?: Record<string, unknown> };
        const meetLink = payload.agendamento?.meet_link;
        if (typeof meetLink === "string" && meetLink) {
          journalOptions.onMeetingScheduled({ ...payload.agendamento, meet_link: meetLink });
        }
      } catch {
        // Tool failures already have a JSON payload; malformed cached results are
        // handled by the model and must not hide a successful current response.
      }
    }
    if (name === "verificar_horarios_reuniao") {
      try {
        const payload = JSON.parse(result) as {
          agenda_id?: unknown;
          data?: unknown;
          timezone?: unknown;
          periodo_atendido?: unknown;
          periodo_solicitado?: unknown;
          horario_solicitado?: { start?: unknown; disponivel?: boolean };
          horarios?: Array<{ start?: unknown; end?: unknown }>;
          horarios_proximos?: Array<{ start?: unknown; end?: unknown }>;
          duration_min?: unknown;
        };
        journalOptions?.onMeetingAvailabilityChecked?.({
          agendaId: typeof payload.agenda_id === "string" ? payload.agenda_id : String(args.agenda_id ?? ""),
          date: typeof payload.data === "string" ? payload.data : String(args.data ?? ""),
          ...(typeof payload.timezone === "string" ? { timezone: payload.timezone } : {}),
          slots: [...(payload.horarios ?? []), ...(payload.horarios_proximos ?? [])].flatMap((slot) =>
            typeof slot.start === "string"
              ? [{ start: slot.start, ...(typeof slot.end === "string" ? { end: slot.end } : {}) }]
              : []
          ),
          requestedTime: journalOptions?.schedulingIntent?.time
            ?? (typeof args.horario_solicitado === "string" ? args.horario_solicitado : undefined),
          available: payload.horario_solicitado?.disponivel === true
            || (!payload.horario_solicitado && Boolean(payload.horarios?.length)),
          ...(payload.periodo_solicitado ? { periodSatisfied: payload.periodo_atendido === true } : {}),
          ...(Number.isInteger(Number(payload.duration_min)) && Number(payload.duration_min) > 0
            ? { durationMinutes: Number(payload.duration_min) }
            : {})
        });
        for (const slot of [
          ...(payload.horarios ?? []),
          ...(payload.horarios_proximos ?? []),
          ...(payload.horario_solicitado?.disponivel === true ? [payload.horario_solicitado] : [])
        ]) {
          if (typeof slot.start === "string" && !Number.isNaN(new Date(slot.start).getTime())) {
            offeredMeetingStarts.add(new Date(slot.start).toISOString());
          }
        }
        if (journalOptions?.schedulingIntent?.kind === "direct_schedule"
          && payload.horario_solicitado?.disponivel === true
          && typeof payload.horario_solicitado.start === "string") {
          verifiedRequestedMeetingStart = payload.horario_solicitado.start;
        }
      } catch {
        // O modelo recebe o erro serializado; o validador apenas deixa de
        // inferir disponibilidade quando o resultado não pode ser lido.
      }
    }
    if (name === "verificar_horarios_reuniao"
      && context
      && verifiedRequestedMeetingStart
      && journalOptions?.schedulingIntent?.kind === "direct_schedule"
      && journalOptions.directSchedulingAction
      && journalOptions.enabledToolNames?.includes(journalOptions.directSchedulingAction)) {
      const action = journalOptions.directSchedulingAction;
      const actionResult = await executeSchedulingTool(action, JSON.stringify({
        agenda_id: String(args.agenda_id ?? ""),
        start: verifiedRequestedMeetingStart
      }), {
        providerCallId: `${context.providerCallId}:commit-${action}`,
        ordinal: 1_000_000 + context.ordinal
      });
      try {
        const actionPayload = JSON.parse(actionResult) as { erro?: unknown; agendamento?: unknown };
        if (!actionPayload.erro && actionPayload.agendamento) {
          completedDirectSchedulingResult = actionResult;
        }
      } catch {
        // The normal tool failure path remains visible to the model. Only a
        // structurally valid persisted appointment is cached as completed.
      }
      return actionResult;
    }
    return result;
  };
  return executeSchedulingTool;
}

function appointmentToolResult(appointment: Record<string, unknown>): string {
  const meetLink = appointment.meet_link;
  return ok({
    agendamento: appointment,
    ...(typeof meetLink === "string" && meetLink ? {
      instrucao: `Confirme de forma curta e natural somente o dia e o horário reservados e envie exatamente este link do Google Meet: ${meetLink}. Não informe duração, horário final, unidade, agenda ou fuso horário.`
    } : {})
  });
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  tenantId: string,
  phone: string,
  pesquisarModelo?: ModelSearch,
  options?: Pick<ToolExecutorJournalOptions, "canonicalState" | "facebookAttribution" | "searchBusinessContext" | "schedulingIntent" | "schedulingPeriodPreference" | "schedulingPeriodPreferenceResolved" | "minimumLeadTimeMinutes" | "existingLead" | "tripzBoletoPaymentSignal">
): Promise<string> {
      switch (name) {
        case "pesquisar_contexto": {
          const input = z.object({ termo: z.string().trim().min(2).max(200) }).parse(args);
          if (!options?.searchBusinessContext) return fail("Pesquisa contextual indisponível no momento; confirme apenas o termo duvidoso com o contato.");
          const contexto = (await options.searchBusinessContext(input.termo)).trim().slice(0, 1_500);
          return ok({
            contexto,
            instrucao: "Resultado interno para desambiguar o termo. Não atribua ao contato fatos encontrados na web, não transforme a pesquisa em discurso comercial e não mencione a pesquisa. Se a identidade continuar incerta, confirme somente a grafia ou o nome com o contato."
          });
        }
        case "pesquisar_modelo": {
          const input = z.object({ modelo: z.string().trim().min(1).max(200) }).parse(args);
          if (!pesquisarModelo) return fail("Pesquisa indisponível no momento; não valide nem elogie o modelo. Diga que esse modelo o time da loja confirma com o estoque e siga o fluxo.");
          const resultado = normalizeModelSearchResult(await pesquisarModelo(input.modelo));
          return ok({
            resultado,
            instrucao: resultado === "não encontrado"
              ? "Dado interno, nunca repasse ao cliente: a busca não confirmou esse modelo. Não diga que ele existe, não corrija o cliente dizendo que não existe e não elogie com frases como top, boa escolha ou muito procurado. Diga apenas que esse modelo você não conhece e que o time da loja confirma no estoque; depois siga o fluxo do atendimento."
              : "Dado interno, nunca repasse ao cliente: não mencione ano, lançamento, fabricante, especificações nem que o modelo existe ou foi verificado. Não elogie nem valide o modelo; diga só que o estoque da loja confirma disponibilidade e siga o fluxo do atendimento."
          });
        }

        case "consultar_categorias":
          return ok({ categorias: await listCategorias(tenantId) });

        case "consultar_parceiros": {
          const parceiros = await listParceiros(tenantId);
          if (parceiros.length === 0) {
            return ok({ parceiros, instrucao: "Nenhum parceiro cadastrado no sistema. Nunca prometa enviar um link que você não tem. Se o seu guia de atendimento trouxer o link da proposta, envie esse link diretamente; senão, continue a conversa sem inventar envio, sem transferir e avance pelo próximo ponto que possa ser resolvido com segurança." });
          }
          return ok({ parceiros });
        }

        case "consultar_unidades":
          return ok({ unidades: await listUnidades(tenantId) });

        case "registrar_lead": {
          const input = z.object({
            nome: optionalToolString(200),
            categoria_interesse_id: optionalToolString(100),
            unidade_id: optionalToolString(100),
            parceiro_id: optionalToolString(100),
            origem: optionalToolString(200),
            status: leadStatus.optional()
          }).parse(args);
          const safeInput = await discardUnknownLeadReferences(tenantId, input);
          const hasFacebookAttribution = Boolean(options?.facebookAttribution && Object.keys(options.facebookAttribution).length);
          const result = await upsertLead(
            tenantId,
            { telefone: phone, ...safeInput, origem: safeInput.origem ?? (hasFacebookAttribution ? "facebook" : "whatsapp") },
            { facebookAttribution: options?.facebookAttribution }
          );
          if (options?.tripzBoletoPaymentSignal) {
            const disqualified = await markLeadDisqualified(tenantId, result.row.id as string);
            return ok({ lead: leadMapper(disqualified) });
          }
          return ok({ lead: leadMapper(result.row) });
        }

        case "qualificar_lead": {
          // Models commonly represent unanswered optional fields as "" even
          // though the schema asks them to omit those fields. Treat blanks as
          // absent so a harmless formatting choice does not waste a tool round.
          const input = qualifyLeadBody.parse(discardBlankQualificationAnswers(args));
          const lead = await requireLead(tenantId, phone);
          const qualificationAlreadyCompleted = (
            lead.qualification_stars !== null && lead.qualification_stars !== undefined
          ) || ["qualificado", "agendado"].includes(String(lead.status));
          if (options?.canonicalState && qualificationAlreadyCompleted) {
            return fail("A qualificação deste lead já foi concluída e não pode ser repetida.");
          }
          const result = await qualifyLead(tenantId, lead.id, input);
          return ok({
            qualificacao_registrada: true,
            alterado: result.alterado,
            pode_agendar_reuniao: true,
            requer_decisao_humana: result.requer_decisao_humana,
            instrucao: "A oportunidade deve seguir para agendamento independentemente da nota. Não revele a avaliação; consulte a agenda e ofereça horários naturalmente."
          });
        }

        case "verificar_horarios": {
          const input = z.object({ unidade_id: z.string(), data: z.string() }).parse(args);
          const availability = await verificarHorarios(tenantId, input.unidade_id, input.data, {
            excludeStartedSlots: true,
            minimumLeadTimeMinutes: options?.minimumLeadTimeMinutes
          });
          return ok(compactAvailabilityResult(availability));
        }

        case "agendar_visita": {
          const input = z.object({ unidade_id: z.string(), start: z.string() }).parse(args);
          const lead = await requireLead(tenantId, phone);
          if (options?.canonicalState && await findLatestActiveAppointment(tenantId, lead.id)) {
            return fail("Já existe um compromisso ativo para este lead; não crie outro.");
          }
          return appointmentToolResult(await createAppointment(
            tenantId,
            { lead_id: lead.id, unidade_id: input.unidade_id, start: input.start },
            { minimumLeadTimeMinutes: options?.minimumLeadTimeMinutes }
          ));
        }

        case "reagendar_visita": {
          const input = z.object({ unidade_id: z.string().optional(), start: z.string() }).parse(args);
          const lead = await requireLead(tenantId, phone);
          const appointment = await requireActiveAppointment(tenantId, lead.id);
          return ok({
            agendamento: await rescheduleAppointment(tenantId, appointment.id, input, {
              minimumLeadTimeMinutes: options?.minimumLeadTimeMinutes
            })
          });
        }

        case "cancelar_visita": {
          const lead = await requireLead(tenantId, phone);
          const appointment = await requireActiveAppointment(tenantId, lead.id);
          return ok({ agendamento: await cancelAppointment(tenantId, appointment.id) });
        }

        case "consultar_agendas": {
          const agendas = await listUnidades(tenantId);
          return ok({ agendas: agendas.map((agenda) => ({
            id: agenda.id,
            nome: agenda.nome,
            horario_abertura: agenda.horario_abertura,
            horario_fechamento: agenda.horario_fechamento,
            dias_funcionamento: agenda.dias_funcionamento,
            duracao_slot_min: agenda.duracao_slot_min
          })) });
        }

        case "verificar_horarios_reuniao": {
          const input = z.object({
            agenda_id: z.string(),
            data: z.string(),
            periodo: z.enum(["manha", "tarde"]).optional(),
            horario_solicitado: optionalMeetingTime
          }).parse(args);
          const availabilityLead = options?.existingLead;
          const activeAppointment = availabilityLead?.id
            ? await findLatestActiveAppointment(tenantId, availabilityLead.id)
            : null;
          const assignedMemberId = typeof activeAppointment?.assigned_member_id === "string"
            ? activeAppointment.assigned_member_id
            : undefined;
          const requestedTime = options?.schedulingIntent?.time ?? input.horario_solicitado;
          if (requestedTime) {
            const availability = await verificarHorarios(tenantId, input.agenda_id, input.data, {
              excludeStartedSlots: true,
              requestedTime,
              minimumLeadTimeMinutes: options?.minimumLeadTimeMinutes,
              assignedMemberId,
              capacitySource: "available_attendants",
              // Sem isto o próprio compromisso do lead ocupa o slot e a agenda
              // responde "indisponível" para o horário que ele acabou de marcar.
              ...(availabilityLead?.id ? { excludeLeadId: availabilityLead.id } : {})
            });
            return ok({
              ...compactAvailabilityResult(availability),
              agenda_id: input.agenda_id,
              instrucao_capacidade: MEETING_CAPACITY_INSTRUCTION,
              instrucao: availability.horario_solicitado?.disponivel
                ? "Horário livre. Ao falar com o contato use o campo hora; ao chamar a ferramenta de agendamento copie o campo start exatamente como veio, sem converter fuso."
                : "Horário ocupado. Ofereça apenas os horarios_proximos, citando o campo hora de cada um, e ao agendar copie o campo start correspondente sem converter fuso."
            });
          }
          // No atendimento da IA, somente a preferência comprovada pela
          // conversa pode restringir a grade. No incidente de 11/08 o contato
          // não escolheu período, mas o modelo enviou `manha`; a busca então
          // ignorou seis vagas livres hoje e retornou amanhã. Chamadores
          // legados que ainda não resolvem a preferência preservam o contrato
          // anterior e podem enviar `periodo` diretamente.
          const periodo = options?.schedulingPeriodPreferenceResolved
            ? options.schedulingPeriodPreference
            : options?.schedulingPeriodPreference ?? input.periodo;
          const search = await buscarDisponibilidade(tenantId, input.agenda_id, input.data, {
            ...(periodo ? { periodo } : {}),
            minimumLeadTimeMinutes: options?.minimumLeadTimeMinutes,
            assignedMemberId
          });
          return ok({
            ...search,
            instrucao_capacidade: MEETING_CAPACITY_INSTRUCTION,
            ...(search.horarios.length === 0
              ? { instrucao: "Não há nenhum horário livre nos próximos dias. Não invente opções: diga isso com naturalidade e ofereça retornar quando abrir vaga." }
              : !search.periodo_atendido && periodo
                ? { instrucao: `Não há vaga no período pedido nos próximos dias. Ofereça exatamente os horarios retornados, deixando claro que são de outro período, e não prometa consultar de novo.` }
                : search.data !== search.data_solicitada
                  ? { instrucao: "Ofereça exatamente os horarios retornados informando o dia correspondente a data. Não use a data solicitada." }
                  : {})
          });
        }

        case "agendar_reuniao": {
          if (options?.schedulingIntent?.kind === "availability_check") {
            return fail("O contato apenas consultou disponibilidade; peça uma única confirmação antes de agendar.");
          }
          const input = z.object({ agenda_id: z.string(), start: z.string() }).parse(args);
          const lead = await requireLead(tenantId, phone);
          if (options?.canonicalState && await findLatestActiveAppointment(tenantId, lead.id)) {
            return fail("Já existe um compromisso ativo para este lead; não crie outro.");
          }
          return appointmentToolResult(await createQualifiedMeetingAppointment(tenantId, {
            lead_id: lead.id,
            unidade_id: input.agenda_id,
            start: input.start
          }, { minimumLeadTimeMinutes: options?.minimumLeadTimeMinutes }));
        }

        case "reagendar_reuniao": {
          const input = z.object({ agenda_id: z.string().optional(), start: z.string() }).parse(args);
          const lead = await requireLead(tenantId, phone);
          const appointment = await requireActiveAppointment(tenantId, lead.id);
          return ok({ agendamento: await rescheduleAppointment(tenantId, appointment.id, {
            unidade_id: input.agenda_id,
            start: input.start
          }, {
            minimumLeadTimeMinutes: options?.minimumLeadTimeMinutes,
            requireAvailableAttendant: true
          }) });
        }

        case "cancelar_reuniao": {
          const lead = await requireLead(tenantId, phone);
          const appointment = await requireActiveAppointment(tenantId, lead.id);
          return ok({ agendamento: await cancelAppointment(tenantId, appointment.id) });
        }

        case "enviar_proposta_parceiro": {
          const input = z.object({ parceiro_id: z.string() }).parse(args);
          const lead = await requireLead(tenantId, phone);
          return ok(await enviarPropostaParceiro(tenantId, lead.id, input.parceiro_id));
        }

        case "atualizar_status_lead": {
          const input = z.object({ status: leadStatus }).parse(args);
          const lead = await requireLead(tenantId, phone);
          if (options?.tripzBoletoPaymentSignal) {
            return ok({ lead: leadMapper(await markLeadDisqualified(tenantId, lead.id)) });
          }
          return ok({ lead: leadMapper(await atualizarStatusLead(tenantId, lead.id, input.status)) });
        }

        default:
          return fail(`Ferramenta desconhecida: ${name}`);
      }
}
