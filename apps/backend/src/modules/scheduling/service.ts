import type { PoolClient } from "pg";
import { createHash, createHmac, randomUUID } from "node:crypto";
import https, { type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { z } from "zod";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { logger } from "../../logger.js";
import { enqueueMeetingProvisioning } from "../../queue/meeting-provisioning-queue.js";
import { enqueueAppointmentStatusReaction } from "../../queue/appointment-status-reaction-queue.js";
import {
  notifyAppointmentGroup,
  refreshAppointmentGroupNotification,
  refreshAppointmentGroupNotificationsForLead,
  type AppointmentNotificationContext
} from "./notification-repository.js";
import { APPOINTMENT_STATUS_REACTIONS } from "./status-reaction.js";
import { encryptSecret } from "../ai-router/secret-box.js";
import { localDateKey, localDateTimeToUtc, localWeekday, zonedParts } from "../../timezone.js";
import {
  ensureCaseAssignment,
  listAvailableAppointmentAttendants,
  rebalanceUnscheduledAssignments,
  redistributeRemovedAssignments,
  selectAvailableAppointmentAttendant,
  transferCaseAssignment
} from "../assignments/service.js";
import { phoneE164Schema } from "../../phone.js";
import { LEAD_TECHNICAL_STATUSES, domainAllowsStageTransition, leadSituation } from "../organization/domain.js";
import {
  applyAppointmentHandoff,
  cancelAppointmentJourney,
  concludeAppointmentJourney,
  markAppointmentNoShowJourney,
  type JourneyActor
} from "../commercial-journey/service.js";
import type { CancellationInput, ConcludeAppointmentInput, NoShowInput } from "../commercial-journey/schemas.js";
import { stageRequiresCommercialPayload } from "../commercial-journey/domain.js";
import { resolveLossReason } from "../commercial-journey/loss-reasons.js";
import { createMeetRoomIdentity, insertMeetRoom, participantJoinUrl } from "../meet/service.js";
import { publicHttpsAgent, resolvePublicHttpsUrl, type LookupAll } from "../../security/outbound-url.js";
import { loadSchedulingUnit, lockAndLoadOverlappingAppointments } from "./repository.js";

export const slug = z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100);
export const uuid = z.string().uuid();
export const leadStatus = z.enum(LEAD_TECHNICAL_STATUSES);
export const appointmentStatus = z.enum(["confirmado", "reagendado", "cancelado", "concluido", "no_show"]);
export type LeadStatus = z.infer<typeof leadStatus>;
export type AppointmentStatus = z.infer<typeof appointmentStatus>;
export type FinalAppointmentStatus = Extract<AppointmentStatus, "cancelado" | "concluido" | "no_show">;

async function synchronizeLeadAppointmentNotifications(tenantId: string, leadId: string): Promise<void> {
  await refreshAppointmentGroupNotificationsForLead(tenantId, leadId).catch((error) => {
    logger.warn({ err: error, tenantId, leadId }, "Could not schedule appointment group notification refresh");
  });
}

async function synchronizeAppointmentNotification(tenantId: string, appointmentId: string): Promise<void> {
  await refreshAppointmentGroupNotification(tenantId, appointmentId).catch((error) => {
    logger.warn({ err: error, tenantId, appointmentId }, "Could not schedule appointment group notification refresh");
  });
}

export type TransferRequestFactory = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;

const defaultTransferRequest: TransferRequestFactory = (url, options, callback) => https.request(url, options, callback);

export type TransferNotificationDeps = {
  lookup?: LookupAll;
  request?: TransferRequestFactory;
  clock?: () => number;
};

export async function sendTransferNotification(urlRaw: string, payload: Record<string, unknown>, timeoutMs: number, hmacSecret?: string, deps: TransferNotificationDeps = {}): Promise<void> {
  const lookup = deps.lookup;
  const url = await resolvePublicHttpsUrl(urlRaw, lookup);
  const body = JSON.stringify(payload);
  const timestamp = Math.floor((deps.clock ?? Date.now)() / 1000).toString();
  const signature = hmacSecret ? createHmac("sha256", hmacSecret).update(`${timestamp}.${body}`).digest("hex") : undefined;
  await new Promise<void>((resolve, reject) => {
    const request = (deps.request ?? defaultTransferRequest)(url, { method: "POST", agent: publicHttpsAgent(lookup), timeout: timeoutMs, headers: { "content-type": "application/json", ...(signature ? { "x-atendon-timestamp": timestamp, "x-atendon-signature": signature } : {}) } }, (response) => {
      response.resume();
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) return reject(new Error("Webhook redirects are not allowed"));
      if (!response.statusCode || response.statusCode >= 400) return reject(new Error(`Webhook respondeu ${response.statusCode}`));
      resolve();
    });
    request.on("timeout", () => request.destroy(new Error("Webhook timeout")));
    request.on("error", reject);
    request.end(body);
  });
}
export function allowedLeadStatusTransitions(status: LeadStatus): readonly LeadStatus[] {
  return LEAD_TECHNICAL_STATUSES.filter((target) => target !== status
    && domainAllowsStageTransition(status,target) && !stageRequiresCommercialPayload(target));
}

const APPOINTMENT_FINAL_EVENTS: Record<FinalAppointmentStatus, string> = {
  cancelado: "agendamento_cancelado",
  concluido: "agendamento_concluido",
  no_show: "agendamento_no_show"
};

export function allowedAppointmentFinalTransitions(status: AppointmentStatus): readonly FinalAppointmentStatus[] {
  return status === "confirmado" || status === "reagendado" ? ["cancelado", "concluido", "no_show"] : [];
}
export const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const instant = z.string().datetime({ offset: true });

export const categoryBody = z.object({ id: slug, nome: z.string().trim().min(1).max(200), ativa: z.boolean().default(true) });
export const partnerBody = z.object({
  id: slug, nome: z.string().trim().min(1).max(200), ordem_prioridade: z.number().int().positive(),
  link_proposta: z.string().url(), ativo: z.boolean().default(true)
});
export const unitBody = z.object({
  id: slug, nome: z.string().trim().min(1).max(200), horario_abertura: time, horario_fechamento: time,
  dias_funcionamento: z.array(z.number().int().min(0).max(6)).min(1).transform((days) => [...new Set(days)].sort()),
  duracao_slot_min: z.number().int().positive().max(1440).default(60),
  capacidade_simultanea: z.number().int().positive().max(10_000).default(1)
}).refine((value) => value.horario_abertura < value.horario_fechamento, { message: "O horário de abertura deve ser anterior ao fechamento" });

export const leadBody = z.object({
  telefone: phoneE164Schema,
  nome: z.string().trim().min(1).max(200).nullable().optional(),
  categoria_interesse_id: slug.nullable().optional(), unidade_id: slug.nullable().optional(), parceiro_id: slug.nullable().optional(),
  origem: z.string().trim().min(1).max(200).nullable().optional(),
  campanha: z.string().trim().min(1).max(200).nullable().optional()
}).strict();
export const leadIdentityBody = z.object({
  telefone: phoneE164Schema.optional(),
  nome: z.string().trim().min(1).max(200).nullable().optional()
}).strict().refine(
  (value) => Object.prototype.hasOwnProperty.call(value, "telefone") || Object.prototype.hasOwnProperty.call(value, "nome"),
  "Informe nome ou telefone para atualizar"
);
export const appointmentBody = z.object({
  lead_id: uuid,
  unidade_id: slug,
  start: instant,
  idempotency_key: z.string().trim().min(1).max(200).optional()
});
export const rescheduleBody = z.object({ start: instant, unidade_id: slug.optional() });
function appointmentIntervalBody<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).superRefine((value, context) => {
    if (!("end" in value) || typeof value.end !== "string") return;
    if (new Date(value.end).getTime() <= new Date(String(value.start)).getTime()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end"],
        message: "O término deve ser posterior ao início"
      });
    }
  });
}
export const panelAppointmentBody = appointmentIntervalBody({
  lead_id: uuid,
  unidade_id: slug,
  start: instant,
  end: instant.optional(),
  assigned_member_id: uuid.nullable().optional(),
  idempotency_key: z.string().trim().min(1).max(200).optional()
});
export const panelRescheduleBody = appointmentIntervalBody({
  start: instant,
  end: instant.optional(),
  unidade_id: slug.optional()
});
export const appointmentObservationBody = z.object({
  observacao: z.string().trim().max(4_000).nullable(),
  expected_updated_at: instant
}).strict();
const localDateMinute = z.string().regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/);
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
export const leadFollowUpBody = z.object({
  responsavel_member_id: uuid.nullable().optional(),
  proxima_acao: z.string().trim().min(1).max(500).nullable().optional(),
  proxima_acao_em_local: localDateMinute.nullable().optional()
}).superRefine((value, context) => {
  const hasResponsible = hasOwn(value, "responsavel_member_id");
  const hasAction = hasOwn(value, "proxima_acao");
  const hasDate = hasOwn(value, "proxima_acao_em_local");
  if (!hasResponsible && !hasAction && !hasDate) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Informe ao menos um campo para atualizar" });
  }
  if (hasAction !== hasDate || (hasAction && ((value.proxima_acao === null) !== (value.proxima_acao_em_local === null)))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Próxima ação e data devem ser informadas ou removidas juntas", path: ["proxima_acao"] });
  }
});
export const leadNoteBody = z.object({ nota: z.string().trim().min(1).max(4_000) });
export const qualificationAnswersBody = z.object({
  tempo_mercado: z.string().trim().min(1).max(500).optional(),
  faturamento: z.string().trim().min(1).max(500).optional(),
  nicho: z.string().trim().min(1).max(500).optional(),
  ticket_medio: z.string().trim().min(1).max(500).optional(),
  causa_perda_vendas: z.string().trim().min(1).max(1_000).optional(),
  possibilidade_investimento: z.string().trim().min(1).max(500).optional(),
  cidade: z.string().trim().min(1).max(500).optional(),
  decisor_comercial: z.string().trim().min(1).max(500).optional(),
  instagram: z.string().trim().min(1).max(500).optional(),
  participacao_decisor: z.string().trim().min(1).max(500).optional(),
  momento_compra: z.string().trim().min(1).max(500).optional()
}).strict();
export const qualifyLeadBody = z.object({
  estrelas: z.number().int().min(1).max(5),
  respostas: qualificationAnswersBody,
  resumo: z.string().trim().min(1).max(2_000),
  justificativa: z.string().trim().min(1).max(4_000)
}).strict();

export const googleMeetSettingsBody = z.object({
  enabled: z.boolean(),
  closer_member_ids: z.array(uuid).max(100).transform((ids) => [...new Set(ids)])
}).superRefine((value, context) => {
  if (value.enabled && value.closer_member_ids.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["closer_member_ids"], message: "Selecione ao menos um closer" });
  }
});
export const atendonMeetSettingsBody = z.object({ enabled: z.boolean() }).strict();
export const attendantAvailabilityStatus = z.enum(["available", "unavailable"]);
export type AttendantAvailabilityStatus = z.infer<typeof attendantAvailabilityStatus>;
export const attendantPoolBody = z.object({
  member_ids: z.array(uuid).max(100).transform((ids) => [...new Set(ids)])
}).strict();
export const attendantAvailabilityBody = z.object({
  availability_status: attendantAvailabilityStatus
}).strict();
export const attendantCalendarColorBody = z.object({
  cor_agenda: z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/).transform((value) => value.toUpperCase())
}).strict();
export const attendantTimeBlockBody = appointmentIntervalBody({
  start: instant,
  end: instant,
  reason: z.string().trim().min(1).max(500)
}).refine(
  (value) => new Date(value.end).getTime() - new Date(value.start).getTime() <= 7 * 24 * 60 * 60 * 1_000,
  { message: "O bloqueio não pode durar mais de 7 dias", path: ["end"] }
);

export type FollowUpActor = {
  userId: string;
  actorScope: "root" | "workspace";
  workspaceCaseAccess?: boolean;
  ipAddress?: string;
  userAgent?: string;
};

export type UnitRow = { id: string; name: string; opening_time: string; closing_time: string; operating_days: number[]; slot_duration_min: number; simultaneous_capacity: number; timezone: string };

type AppointmentCapacityOptions = {
  allowCapacityOverride?: boolean;
};

export function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

export function formatTime(value: string): string { return value.slice(0, 5); }

export function unitMapper(row: Record<string, unknown>) {
  return {
    id: row.id, tenant: row.tenant_id, nome: row.name,
    horario_abertura: formatTime(String(row.opening_time)), horario_fechamento: formatTime(String(row.closing_time)),
    dias_funcionamento: row.operating_days, duracao_slot_min: row.slot_duration_min,
    capacidade_simultanea: row.simultaneous_capacity
  };
}

export function leadMapper(row: Record<string, unknown>) {
  const parsedStatus = leadStatus.safeParse(row.status);
  const appointmentStart = row.latest_appointment_start instanceof Date
    ? row.latest_appointment_start
    : new Date(String(row.latest_appointment_start ?? ""));
  const hasUpcomingAppointment = row.has_upcoming_appointment === true || (
    (row.latest_appointment_status === "confirmado" || row.latest_appointment_status === "reagendado")
    && Number.isFinite(appointmentStart.getTime())
    && appointmentStart.getTime() > Date.now()
  );
  const situacao = parsedStatus.success ? leadSituation({
    status: parsedStatus.data,
    hasUpcomingAppointment,
    awaitingReply: row.awaiting_reply === true || row.awaitingReply === true
  }) : null;
  return {
    id: row.id, tenant: row.tenant_id, telefone: row.phone, nome: row.name,
    avatar_url: row.avatar_url ?? null,
    // Conversa aberta com o contato (WhatsApp ou Instagram) e o @ do Instagram
    // quando a origem é IG: o painel usa o id para o botão de conversar.
    conversation_id: row.contact_conversation_id ?? null,
    instagram_username: row.contact_instagram_username ?? null,
    categoria_interesse_id: row.interest_category_id, unidade_id: row.unit_id, parceiro_id: row.partner_id,
    status: row.status, origem: row.source, campanha: row.campaign ?? null, criado_em: row.created_at, atualizado_em: row.updated_at,
    categoria_nome: row.category_name, unidade_nome: row.unit_name, parceiro_nome: row.partner_name,
    interesse: row.category_name ?? row.interest_category_id ?? null,
    situacao,
    origem_facebook: row.facebook_attribution ?? {},
    pipeline_stage_id: row.pipeline_stage_id ?? null,
    pipeline_stage: row.pipeline_stage ?? null,
    tags: row.tags ?? [],
    sdr_member_id: row.sdr_member_id ?? null,
    closer_member_id: row.closer_member_id ?? null,
    recovery_required: row.recovery_required ?? false,
    recovery_member_id: row.recovery_member_id ?? null,
    recovery_email: row.recovery_user_email ?? null,
    handoff_at: row.handoff_at ?? null,
    handoff_by_user_id: row.handoff_by_user_id ?? null,
    commercial_outcome: row.commercial_outcome ?? null,
    outcome_metadata: row.outcome_metadata ?? {},
    sale_value: row.sale_value === null || row.sale_value === undefined ? null : Number(row.sale_value),
    loss_reason: row.loss_reason ?? null,
    loss_reason_note: row.loss_reason_note ?? null,
    commercial_updated_at: row.commercial_updated_at ?? null,
    commercial_updated_by_user_id: row.commercial_updated_by_user_id ?? null,
    sdr_email: row.sdr_user_email ?? null,
    closer_email: row.closer_user_email ?? null,
    latest_appointment: row.latest_appointment_id ? {
      id: row.latest_appointment_id,
      status: row.latest_appointment_status,
      start: row.latest_appointment_start,
      end: row.latest_appointment_end,
      result_pending_at: row.latest_appointment_result_pending_at ?? null,
      result_pending: row.latest_appointment_result_pending_at != null
    } : null
  };
}

export function panelLeadMapper(row: Record<string, unknown>) {
  return {
    ...leadMapper(row),
    responsavel_member_id: row.assigned_member_id ?? null,
    responsavel_email: row.assigned_user_email ?? null,
    responsavel_disponibilidade: row.assigned_availability_status ?? null,
    proxima_acao: row.next_action ?? null,
    proxima_acao_em: row.next_action_at ?? null,
    ai_follow_up: row.ai_follow_up ?? null
  };
}

export function qualificationMapper(row: Record<string, unknown>) {
  if (row.qualification_stars === null || row.qualification_stars === undefined) return null;
  return {
    estrelas: row.qualification_stars,
    respostas: row.qualification_answers ?? {},
    resumo: row.qualification_summary ?? null,
    justificativa: row.qualification_reason ?? null,
    avaliado_em: row.qualification_evaluated_at ?? null,
    requer_decisao_humana: row.requires_human_decision ?? false,
    origem_facebook: row.facebook_attribution ?? {}
  };
}

function leadFollowUpMapper(row: Record<string, unknown>) {
  return {
    responsavel: row.assigned_member_id ? {
      member_id: row.assigned_member_id,
      user_id: row.assigned_user_id,
      email: row.assigned_user_email,
      availability_status: row.assigned_availability_status ?? null
    } : null,
    proxima_acao: row.next_action ?? null,
    proxima_acao_em: row.next_action_at ?? null,
    timezone: row.timezone
  };
}

function leadNoteMapper(row: Record<string, unknown>) {
  return {
    id: row.id,
    nota: row.content,
    autor_user_id: row.author_user_id,
    autor_email: row.author_email,
    criado_em: row.created_at
  };
}

export function appointmentMapper(row: Record<string, unknown>) {
  const meetingProvisioningStatus = typeof row.meeting_provisioning_status === "string"
    ? row.meeting_provisioning_status
    : (row.meeting_url ? "ready" : "not_required");
  const meetLink = meetingProvisioningStatus === "ready" && typeof row.meeting_url === "string"
    ? row.meeting_url
    : null;
  const start = row.start_at instanceof Date ? row.start_at : new Date(String(row.start_at));
  const end = row.end_at instanceof Date ? row.end_at : new Date(String(row.end_at));
  return {
    id: row.id, lead_id: row.lead_id, tenant: row.tenant_id,
    unit_id: row.unit_id, unit_name: row.unit_name ?? null,
    unidade_id: row.unit_id,
    start: row.start_at, end: row.end_at,
    duration_min: Number.isFinite(start.getTime()) && Number.isFinite(end.getTime())
      ? Math.round((end.getTime() - start.getTime()) / 60_000)
      : (row.slot_duration_min ?? null),
    timezone: row.timezone ?? null,
    status: row.status,
    result_pending_at: row.result_pending_at ?? null,
    commercial_outcome: row.commercial_outcome ?? null,
    sale_value: row.sale_value === null || row.sale_value === undefined ? null : Number(row.sale_value),
    loss_reason: row.loss_reason ?? null,
    loss_reason_note: row.loss_reason_note ?? null,
    outcome_next_action: row.outcome_next_action ?? null,
    outcome_next_action_at: row.outcome_next_action_at ?? null,
    outcome_metadata: row.outcome_metadata ?? {},
    finalized_by_user_id: row.finalized_by_user_id ?? null,
    finalized_at: row.finalized_at ?? null,
    cancellation_disposition: row.cancellation_disposition ?? null,
    created_by_user_id: row.created_by_user_id ?? null,
    meeting_provisioning_status: meetingProvisioningStatus,
    meeting_provider: row.meeting_provider ?? null,
    meeting_url: meetLink,
    meeting_code: row.meeting_code ?? null,
    criado_em: row.created_at, atualizado_em: row.updated_at,
    lead_nome: row.lead_name, lead_telefone: row.lead_phone, unidade_nome: row.unit_name,
    conversation_id: row.conversation_id ?? null,
    observacao: row.observation ?? null,
    responsavel: row.assigned_member_id ? {
      member_id: row.assigned_member_id,
      user_id: row.assigned_user_id ?? null,
      email: row.assigned_user_email ?? null,
      availability_status: row.assigned_availability_status ?? null,
      cor_agenda: row.assigned_calendar_color ?? null
    } : null,
    atribuido_em: row.assigned_at ?? null,
    meet_link: meetLink,
    meet: meetLink ? {
      provider: row.meeting_provider,
      url: meetLink,
      space_name: row.meeting_space_name,
      code: row.meeting_code,
      created_at: row.meeting_created_at
    } : null
  };
}

export function workspaceLocalDateTime(day: string, hhmm: string, timezone: string): Date {
  try {
    return localDateTimeToUtc(day, hhmm, timezone);
  } catch (error) {
    if (error instanceof RangeError) throw httpError(409, error.message);
    throw error;
  }
}

export async function loadWorkspaceTimeZone(tenantId: string): Promise<string> {
  const result = await db.query<{ timezone: string }>("SELECT timezone FROM tenants WHERE id=$1", [tenantId]);
  if (!result.rows[0]) throw httpError(404, "Workspace não encontrado");
  return result.rows[0].timezone;
}

export function validateSlot(unit: UnitRow, start: Date): Date {
  if (Number.isNaN(start.getTime())) throw httpError(409, "Horário de agendamento inválido");
  const day = localDateKey(start, unit.timezone);
  if (!unit.operating_days.includes(localWeekday(start, unit.timezone))) throw httpError(409, "A unidade não funciona nesta data");
  const opening = workspaceLocalDateTime(day, formatTime(unit.opening_time), unit.timezone);
  const closing = workspaceLocalDateTime(day, formatTime(unit.closing_time), unit.timezone);
  const end = new Date(start.getTime() + unit.slot_duration_min * 60_000);
  if (start < opening || end > closing) {
    throw httpError(409, "Horário fora do funcionamento configurado para a unidade");
  }
  return end;
}

export function validateManualAppointmentInterval(unit: UnitRow, start: Date, requestedEnd?: string): Date {
  if (Number.isNaN(start.getTime())) throw httpError(409, "Horário de agendamento inválido");
  const end = requestedEnd
    ? new Date(requestedEnd)
    : new Date(start.getTime() + unit.slot_duration_min * 60_000);
  if (Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
    throw httpError(409, "O término deve ser posterior ao início");
  }
  if (end.getTime() - start.getTime() > 24 * 60 * 60_000) {
    throw httpError(409, "A duração máxima de um agendamento manual é de 24 horas");
  }
  return end;
}

export function assertFutureAppointmentStart(
  start: Date,
  now = new Date(),
  minimumLeadTimeMinutes = 0
): void {
  const earliestStart = now.getTime() + minimumLeadTimeMinutes * 60_000;
  if (start.getTime() <= earliestStart) {
    throw httpError(
      409,
      minimumLeadTimeMinutes > 0
        ? `O horário do agendamento deve ter pelo menos ${minimumLeadTimeMinutes} minutos de antecedência`
        : "O horário do agendamento deve estar no futuro"
    );
  }
}

export async function loadUnit(client: PoolClient, tenantId: string, unitId: string): Promise<UnitRow> {
  const result = await loadSchedulingUnit(client, tenantId, unitId);
  if (!result.rows[0]) throw httpError(404, "Unidade não encontrada");
  return result.rows[0];
}

function peakConcurrentAppointments(
  appointments: Array<{ start_at: Date; end_at: Date }>,
  start: Date,
  end: Date
): number {
  const events = appointments.flatMap((appointment) => {
    const occupiedStart = Math.max(new Date(appointment.start_at).getTime(), start.getTime());
    const occupiedEnd = Math.min(new Date(appointment.end_at).getTime(), end.getTime());
    return occupiedStart < occupiedEnd
      ? [{ at: occupiedStart, delta: 1 }, { at: occupiedEnd, delta: -1 }]
      : [];
  }).sort((left, right) => left.at - right.at || left.delta - right.delta);
  let current = 0;
  let peak = 0;
  for (const event of events) {
    current += event.delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

function busyAppointmentAttendants(
  appointments: Array<{ assigned_member_id: string | null; start_at: Date; end_at: Date }>,
  start: Date,
  end: Date
): number {
  return new Set(appointments.flatMap((appointment) =>
    appointment.assigned_member_id
      && new Date(appointment.start_at) < end
      && new Date(appointment.end_at) > start
      ? [appointment.assigned_member_id]
      : []
  )).size;
}

export async function assertCapacity(
  client: PoolClient,
  tenantId: string,
  unit: UnitRow,
  start: Date,
  end: Date,
  exceptId?: string,
  options: AppointmentCapacityOptions = {}
) {
  if (options.allowCapacityOverride) return;
  // Encaixes podem começar em qualquer minuto. O lock precisa cobrir a agenda
  // inteira para serializar também horários diferentes que se sobreponham.
  const result = await lockAndLoadOverlappingAppointments(client, tenantId, unit.id, start, end, exceptId);
  if (peakConcurrentAppointments(result.rows, start, end) >= unit.simultaneous_capacity) {
    throw httpError(409, "Slot sem capacidade disponível");
  }
}

export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function insertFollowUpAudit(client: PoolClient, tenantId: string, leadId: string, actor: FollowUpActor, action: string, metadata: Record<string, unknown>) {
  await client.query(
    `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
     VALUES($1,$2,$3,$4,'scheduling_lead',$5,$6,$7,$8)`,
    [actor.userId, tenantId, actor.actorScope, action, leadId, metadata, actor.ipAddress ?? null, actor.userAgent ?? null]
  );
}

async function fetchLeadFollowUpRow(client: PoolClient, tenantId: string, leadId: string) {
  const result = await client.query(
    `SELECT l.assigned_member_id,wm.user_id assigned_user_id,u.email assigned_user_email,
            pool.availability_status assigned_availability_status,
            l.next_action,l.next_action_at,t.timezone
     FROM scheduling_leads l
     JOIN tenants t ON t.id=l.tenant_id
     LEFT JOIN workspace_members wm ON wm.id=l.assigned_member_id AND wm.workspace_id=l.tenant_id
     LEFT JOIN users u ON u.id=wm.user_id
     LEFT JOIN scheduling_google_meet_closers pool
       ON pool.tenant_id=l.tenant_id AND pool.member_id=l.assigned_member_id
     WHERE l.id=$1 AND l.tenant_id=$2`,
    [leadId, tenantId]
  );
  if (!result.rows[0]) throw httpError(404, "Lead não encontrado");
  return result.rows[0] as Record<string, unknown>;
}

export async function loadLeadFollowUp(tenantId: string, leadId: string) {
  const client = await db.connect();
  try {
    const followUp = await fetchLeadFollowUpRow(client, tenantId, leadId);
    const [notes, assignees] = await Promise.all([
      client.query(
        `SELECT n.id,n.content,n.author_user_id,n.created_at,u.email author_email
         FROM scheduling_lead_notes n
         JOIN users u ON u.id=n.author_user_id
         WHERE n.tenant_id=$1 AND n.lead_id=$2
         ORDER BY n.created_at DESC`,
        [tenantId, leadId]
      ),
      client.query(
        `SELECT m.id member_id,m.user_id,u.email,r.name role_name,pool.availability_status
         FROM scheduling_google_meet_closers pool
         JOIN workspace_members m ON m.id=pool.member_id AND m.workspace_id=pool.tenant_id
         JOIN users u ON u.id=m.user_id AND u.status='active'
         JOIN workspace_roles r ON r.id=m.role_id AND r.workspace_id=m.workspace_id
         WHERE pool.tenant_id=$1 AND m.status='active'
           AND EXISTS (
             SELECT 1 FROM workspace_role_permissions permission
             WHERE permission.role_id=m.role_id AND permission.permission_key='leads.read'
           )
           AND EXISTS (
             SELECT 1 FROM workspace_role_permissions permission
             WHERE permission.role_id=m.role_id AND permission.permission_key='conversations.read'
           )
           AND EXISTS (
             SELECT 1 FROM workspace_role_permissions permission
             WHERE permission.role_id=m.role_id AND permission.permission_key='conversations.reply'
           )
         ORDER BY u.email`,
        [tenantId]
      )
    ]);
    return {
      follow_up: leadFollowUpMapper(followUp),
      notas: notes.rows.map(leadNoteMapper),
      responsaveis: assignees.rows.map((row) => ({
        member_id: row.member_id,
        user_id: row.user_id,
        email: row.email,
        funcao: row.role_name,
        availability_status: row.availability_status
      }))
    };
  } finally {
    client.release();
  }
}

export async function updateLeadFollowUp(tenantId: string, leadId: string, input: z.infer<typeof leadFollowUpBody>, actor: FollowUpActor) {
  const result = await withTransaction(async (client) => {
    const currentResult = await client.query<{
      assigned_member_id: string | null;
      next_action: string | null;
      next_action_at: Date | null;
      timezone: string;
    }>(
      `SELECT l.assigned_member_id,l.next_action,l.next_action_at,t.timezone
       FROM scheduling_leads l
       JOIN tenants t ON t.id=l.tenant_id
       WHERE l.id=$1 AND l.tenant_id=$2
       FOR UPDATE OF l`,
      [leadId, tenantId]
    );
    const current = currentResult.rows[0];
    if (!current) throw httpError(404, "Lead não encontrado");

    const assignedMemberId = hasOwn(input, "responsavel_member_id") ? input.responsavel_member_id ?? null : current.assigned_member_id;
    if (assignedMemberId) {
      const eligible = await client.query(
        `SELECT m.id FROM scheduling_google_meet_closers pool
         JOIN workspace_members m ON m.id=pool.member_id AND m.workspace_id=pool.tenant_id
         JOIN users u ON u.id=m.user_id
         WHERE m.id=$1 AND pool.tenant_id=$2 AND m.status='active' AND u.status='active'`,
        [assignedMemberId, tenantId]
      );
      if (!eligible.rows[0]) throw httpError(400, "Responsável deve ser um atendente ativo do pool");
    }

    const nextAction = hasOwn(input, "proxima_acao") ? input.proxima_acao ?? null : current.next_action;
    let nextActionAt = current.next_action_at;
    if (hasOwn(input, "proxima_acao_em_local")) {
      const localValue = input.proxima_acao_em_local;
      if (localValue === null || localValue === undefined) {
        nextActionAt = null;
      } else {
        const [day, hhmm] = localValue.split("T");
        nextActionAt = workspaceLocalDateTime(day, hhmm, current.timezone);
        if (nextActionAt.getTime() <= Date.now()) throw httpError(400, "A próxima ação deve estar no futuro");
      }
    }

    const currentAt = current.next_action_at?.toISOString() ?? null;
    const nextAt = nextActionAt?.toISOString() ?? null;
    const changed = assignedMemberId !== current.assigned_member_id || nextAction !== current.next_action || nextAt !== currentAt;
    if (!changed) return { follow_up: leadFollowUpMapper(await fetchLeadFollowUpRow(client, tenantId, leadId)), alterado: false };

    if (assignedMemberId !== current.assigned_member_id) {
      const transferred = await transferCaseAssignment(client, {
        tenantId,
        selector: { leadId },
        targetMemberId: assignedMemberId,
        actor,
        manager: actor.workspaceCaseAccess === true
      });
      if (!transferred.found) throw httpError(404, "Lead não encontrado");
    }
    await client.query(
      `UPDATE scheduling_leads
       SET next_action=$3,next_action_at=$4,updated_at=now()
       WHERE id=$1 AND tenant_id=$2`,
      [leadId, tenantId, nextAction, nextActionAt]
    );
    const details = {
      anterior: { responsavel_member_id: current.assigned_member_id, proxima_acao: current.next_action, proxima_acao_em: currentAt },
      atual: { responsavel_member_id: assignedMemberId, proxima_acao: nextAction, proxima_acao_em: nextAt },
      motivo: assignedMemberId !== current.assigned_member_id ? "atribuicao_manual" : "acompanhamento_manual",
      actor_user_id: actor.userId
    };
    await client.query(
      `INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,details)
       VALUES($1,$2,'acompanhamento_atualizado',$3)`,
      [leadId, tenantId, details]
    );
    await insertFollowUpAudit(client, tenantId, leadId, actor, "leads.follow_up.update", details);
    return { follow_up: leadFollowUpMapper(await fetchLeadFollowUpRow(client, tenantId, leadId)), alterado: true };
  });
  await synchronizeLeadAppointmentNotifications(tenantId, leadId);
  return result;
}

export async function addLeadNote(tenantId: string, leadId: string, note: string, actor: FollowUpActor) {
  return withTransaction(async (client) => {
    const lead = await client.query("SELECT id FROM scheduling_leads WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [leadId, tenantId]);
    if (!lead.rows[0]) throw httpError(404, "Lead não encontrado");
    const inserted = await client.query(
      `INSERT INTO scheduling_lead_notes(tenant_id,lead_id,author_user_id,content)
       VALUES($1,$2,$3,$4)
       RETURNING id,content,author_user_id,created_at`,
      [tenantId, leadId, actor.userId, note]
    );
    const noteId = inserted.rows[0].id as string;
    await client.query("UPDATE scheduling_leads SET updated_at=now() WHERE id=$1 AND tenant_id=$2", [leadId, tenantId]);
    await client.query(
      `INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,details)
       VALUES($1,$2,'nota_interna_adicionada',$3)`,
      [leadId, tenantId, { note_id: noteId, actor_user_id: actor.userId }]
    );
    await insertFollowUpAudit(client, tenantId, leadId, actor, "leads.follow_up.note.create", { note_id: noteId });
    const author = await client.query<{ email: string }>("SELECT email FROM users WHERE id=$1", [actor.userId]);
    return { nota: leadNoteMapper({ ...inserted.rows[0], author_email: author.rows[0]?.email }) };
  });
}

type EligibleAttendantRow = {
  member_id: string;
  user_id: string;
  email: string;
  role_name: string;
};

async function listEligibleAttendants(client: PoolClient, tenantId: string): Promise<EligibleAttendantRow[]> {
  const result = await client.query<EligibleAttendantRow>(
    `SELECT m.id member_id,m.user_id,u.email,r.name role_name
     FROM workspace_members m
     JOIN users u ON u.id=m.user_id AND u.status='active'
     JOIN workspace_roles r ON r.id=m.role_id AND r.workspace_id=m.workspace_id
     WHERE m.workspace_id=$1 AND m.status='active'
       AND EXISTS (
         SELECT 1 FROM workspace_role_permissions rp
         WHERE rp.role_id=m.role_id AND rp.permission_key='conversations.read'
       )
       AND EXISTS (
         SELECT 1 FROM workspace_role_permissions rp
         WHERE rp.role_id=m.role_id AND rp.permission_key='conversations.reply'
       )
     ORDER BY u.email`,
    [tenantId]
  );
  return result.rows;
}

export async function loadAttendantPool(tenantId: string, currentUserId?: string) {
  const result = await db.query<{
    member_id: string;
    user_id: string;
    email: string;
    role_name: string;
    selected: boolean;
    availability_status: AttendantAvailabilityStatus | null;
    availability_changed_at: Date | null;
    availability_changed_by_user_id: string | null;
    availability_changed_by_email: string | null;
    calendar_color: string | null;
    active_appointments: number;
    last_assigned_at: Date | null;
  }>(
    `SELECT m.id member_id,m.user_id,u.email,r.name role_name,
            (pool.member_id IS NOT NULL) selected,
            pool.availability_status,pool.availability_changed_at,
            pool.availability_changed_by_user_id,changed_by.email availability_changed_by_email,
            pool.calendar_color,
            count(a.id) FILTER (WHERE a.status IN ('confirmado','reagendado'))::int active_appointments,
            max(a.assigned_at) last_assigned_at
     FROM workspace_members m
     JOIN users u ON u.id=m.user_id AND u.status='active'
     JOIN workspace_roles r ON r.id=m.role_id AND r.workspace_id=m.workspace_id
     LEFT JOIN scheduling_google_meet_closers pool
       ON pool.member_id=m.id AND pool.tenant_id=m.workspace_id
     LEFT JOIN users changed_by ON changed_by.id=pool.availability_changed_by_user_id
     LEFT JOIN scheduling_appointments a
       ON a.tenant_id=m.workspace_id AND a.assigned_member_id=m.id
     WHERE m.workspace_id=$1 AND m.status='active'
       AND EXISTS (
         SELECT 1 FROM workspace_role_permissions rp
         WHERE rp.role_id=m.role_id AND rp.permission_key='conversations.read'
       )
       AND EXISTS (
         SELECT 1 FROM workspace_role_permissions rp
         WHERE rp.role_id=m.role_id AND rp.permission_key='conversations.reply'
       )
     GROUP BY m.id,m.user_id,u.email,r.name,pool.member_id,pool.availability_status,
              pool.availability_changed_at,pool.availability_changed_by_user_id,changed_by.email,
              pool.calendar_color
     ORDER BY u.email,m.id`,
    [tenantId]
  );
  return {
    attendants: result.rows.map((row) => ({
      member_id: row.member_id,
      user_id: row.user_id,
      email: row.email,
      funcao: row.role_name,
      selected: row.selected,
      availability_status: row.availability_status,
      availability_changed_at: row.availability_changed_at?.toISOString() ?? null,
      availability_changed_by_user_id: row.availability_changed_by_user_id,
      availability_changed_by_email: row.availability_changed_by_email,
      cor_agenda: row.calendar_color,
      active_appointments: row.active_appointments,
      last_assigned_at: row.last_assigned_at?.toISOString() ?? null,
      is_current: row.user_id === currentUserId
    })),
    member_ids: result.rows.filter((row) => row.selected).map((row) => row.member_id)
  };
}

async function applyAttendantPoolUpdate(
  client: PoolClient,
  tenantId: string,
  memberIds: string[],
  actor: FollowUpActor,
  source: "attendant_config" | "google_meet_compatibility"
) {
  await lockAttendantDistribution(client, tenantId);
  const eligible = await listEligibleAttendants(client, tenantId);
  const eligibleIds = new Set(eligible.map((item) => item.member_id));
  if (memberIds.some((memberId) => !eligibleIds.has(memberId))) {
    throw httpError(400, "Selecione somente membros ativos com acesso de leitura e resposta a conversas");
  }
  const current = await client.query<{ member_id: string }>(
    "SELECT member_id FROM scheduling_google_meet_closers WHERE tenant_id=$1 FOR UPDATE",
    [tenantId]
  );
  const currentIds = new Set(current.rows.map((row) => row.member_id));
  const nextIds = new Set(memberIds);
  const removed = [...currentIds].filter((memberId) => !nextIds.has(memberId));
  const added = memberIds.filter((memberId) => !currentIds.has(memberId));
  if (!removed.length && !added.length) {
    return {
      added,
      removed,
      redistributed: { leads: 0, conversations: 0, appointments: 0 }
    };
  }

  const changedAt = (await client.query<{ now: Date }>("SELECT now()")).rows[0].now;
  if (removed.length) {
    await client.query(
      "DELETE FROM scheduling_google_meet_closers WHERE tenant_id=$1 AND member_id=ANY($2::uuid[])",
      [tenantId, removed]
    );
  }
  if (added.length) {
    await client.query(
      `INSERT INTO scheduling_google_meet_closers(
         tenant_id,member_id,availability_status,availability_changed_at,availability_changed_by_user_id
       )
       SELECT $1,unnest($2::uuid[]),'available',$3,$4
       ON CONFLICT(tenant_id,member_id) DO NOTHING`,
      [tenantId, added, changedAt, actor.userId]
    );
  }

  const removedAssignments = await redistributeRemovedAssignments(client, {
    tenantId,
    removedMemberIds: removed,
    actor
  });
  const expandedAssignments = added.length
    ? await rebalanceUnscheduledAssignments(client, { tenantId, actor })
    : { leads: 0, conversations: 0, appointments: 0 };
  const redistributed = {
    leads: removedAssignments.leads + expandedAssignments.leads,
    conversations: removedAssignments.conversations + expandedAssignments.conversations,
    appointments: removedAssignments.appointments + expandedAssignments.appointments
  };
  await client.query(
    `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
     VALUES($1,$2,$3,'scheduling.attendants.pool.update','scheduling_attendant_pool',$4,$5,$6,$7)`,
    [actor.userId, tenantId, actor.actorScope, tenantId, {
      source,
      previous_member_ids: [...currentIds],
      member_ids: memberIds,
      added_member_ids: added,
      removed_member_ids: removed,
      redistributed_leads: redistributed.leads,
      redistributed_conversations: redistributed.conversations,
      redistributed_appointments: redistributed.appointments
    }, actor.ipAddress ?? null, actor.userAgent ?? null]
  );
  return { added, removed, redistributed };
}

export async function updateAttendantPool(
  tenantId: string,
  input: z.infer<typeof attendantPoolBody>,
  actor: FollowUpActor
) {
  const result = await withTransaction((client) =>
    applyAttendantPoolUpdate(client, tenantId, input.member_ids, actor, "attendant_config")
  );
  return {
    ...(await loadAttendantPool(tenantId, actor.userId)),
    redistribuidos: result.redistributed.appointments,
    redistribuidos_leads: result.redistributed.leads,
    redistribuidos_conversas: result.redistributed.conversations,
    redistribuidos_reunioes: result.redistributed.appointments
  };
}

export async function updateAttendantAvailability(
  tenantId: string,
  selector: { memberId: string } | { userId: string },
  status: AttendantAvailabilityStatus,
  actor: FollowUpActor
) {
  const result = await withTransaction(async (client) => {
    await lockAttendantDistribution(client, tenantId);
    const selected = await client.query<{
      member_id: string;
      user_id: string;
      email: string;
      availability_status: AttendantAvailabilityStatus;
    }>(
      `SELECT pool.member_id,m.user_id,u.email,pool.availability_status
       FROM scheduling_google_meet_closers pool
       JOIN workspace_members m
         ON m.id=pool.member_id AND m.workspace_id=pool.tenant_id AND m.status='active'
       JOIN users u ON u.id=m.user_id AND u.status='active'
       WHERE pool.tenant_id=$1
         AND ${"memberId" in selector ? "pool.member_id=$2" : "m.user_id=$2"}
       FOR UPDATE OF pool`,
      [tenantId, "memberId" in selector ? selector.memberId : selector.userId]
    );
    const attendant = selected.rows[0];
    if (!attendant) {
      throw httpError("userId" in selector ? 403 : 404, "Atendente ativo não encontrado no pool");
    }
    if (attendant.availability_status === status) {
      return { attendant, changedAt: null as Date | null, redistributedAppointments: 0, changed: false };
    }
    const changedAt = (await client.query<{ now: Date }>("SELECT now()")).rows[0].now;
    await client.query(
      `UPDATE scheduling_google_meet_closers
       SET availability_status=$3,availability_changed_at=$4,availability_changed_by_user_id=$5
       WHERE tenant_id=$1 AND member_id=$2`,
      [tenantId, attendant.member_id, status, changedAt, actor.userId]
    );
    // Disponibilidade é somente informativa e nunca altera o rodízio.
    const redistributedAppointments = 0;
    await client.query(
      `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
       VALUES($1,$2,$3,'scheduling.attendant.availability.update','scheduling_attendant',$4,$5,$6,$7)`,
      [actor.userId, tenantId, actor.actorScope, attendant.member_id, {
        previous_status: attendant.availability_status,
        availability_status: status,
        changed_member_id: attendant.member_id,
        redistributed_appointments: redistributedAppointments
      }, actor.ipAddress ?? null, actor.userAgent ?? null]
    );
    return { attendant, changedAt, redistributedAppointments, changed: true };
  });
  return {
    attendant: {
      member_id: result.attendant.member_id,
      user_id: result.attendant.user_id,
      email: result.attendant.email,
      availability_status: status,
      availability_changed_at: result.changedAt?.toISOString() ?? null
    },
    alterado: result.changed,
    redistribuidos: result.redistributedAppointments
  };
}

type AttendantTimeBlockRow = {
  id: string;
  member_id: string;
  start_at: Date;
  end_at: Date;
  reason: string | null;
  created_at: Date;
};

function mapAttendantTimeBlock(row: AttendantTimeBlockRow) {
  return {
    id: row.id,
    member_id: row.member_id,
    start: row.start_at.toISOString(),
    end: row.end_at.toISOString(),
    reason: row.reason,
    created_at: row.created_at.toISOString()
  };
}

export async function listOwnAttendantTimeBlocks(
  tenantId: string,
  userId: string,
  interval: { start: Date; end: Date }
) {
  const result = await db.query<AttendantTimeBlockRow>(
    `SELECT block.id,block.member_id,block.start_at,block.end_at,block.reason,block.created_at
     FROM scheduling_attendant_time_blocks block
     JOIN workspace_members member
       ON member.id=block.member_id AND member.workspace_id=block.tenant_id AND member.status='active'
     JOIN scheduling_google_meet_closers pool
       ON pool.tenant_id=block.tenant_id AND pool.member_id=block.member_id
     WHERE block.tenant_id=$1 AND member.user_id=$2
       AND block.start_at<$4 AND block.end_at>$3
     ORDER BY block.start_at,block.id`,
    [tenantId, userId, interval.start, interval.end]
  );
  return result.rows.map(mapAttendantTimeBlock);
}

export async function createOwnAttendantTimeBlock(
  tenantId: string,
  userId: string,
  input: z.infer<typeof attendantTimeBlockBody>,
  actor: FollowUpActor
) {
  return withTransaction(async (client) => {
    await lockAttendantDistribution(client, tenantId);
    const start = new Date(input.start);
    const end = new Date(input.end);
    const memberResult = await client.query<{ member_id: string }>(
      `SELECT pool.member_id
       FROM scheduling_google_meet_closers pool
       JOIN workspace_members member
         ON member.id=pool.member_id AND member.workspace_id=pool.tenant_id AND member.status='active'
       WHERE pool.tenant_id=$1 AND member.user_id=$2
       FOR UPDATE OF pool`,
      [tenantId, userId]
    );
    const memberId = memberResult.rows[0]?.member_id;
    if (!memberId) throw httpError(403, "Somente responsáveis ativos no pool podem bloquear horários");
    if (start.getTime() < Date.now()) throw httpError(400, "O início do bloqueio deve estar no futuro");
    const conflict = await client.query<{ kind: "appointment" | "block" }>(
      `SELECT 'appointment'::text kind
       FROM scheduling_appointments appointment
       WHERE appointment.tenant_id=$1 AND appointment.assigned_member_id=$2
         AND appointment.status IN ('confirmado','reagendado')
         AND appointment.start_at<$4 AND appointment.end_at>$3
       UNION ALL
       SELECT 'block'::text kind
       FROM scheduling_attendant_time_blocks block
       WHERE block.tenant_id=$1 AND block.member_id=$2
         AND block.start_at<$4 AND block.end_at>$3
       LIMIT 1`,
      [tenantId, memberId, start, end]
    );
    if (conflict.rows[0]?.kind === "appointment") {
      throw httpError(409, "Já existe uma reunião nesse horário; reagende ou reatribua antes de bloqueá-lo");
    }
    if (conflict.rows[0]) throw httpError(409, "Esse período já está bloqueado");
    const inserted = await client.query<AttendantTimeBlockRow>(
      `INSERT INTO scheduling_attendant_time_blocks(
         tenant_id,member_id,start_at,end_at,reason,created_by_user_id
       ) VALUES($1,$2,$3,$4,$5,$6)
       RETURNING id,member_id,start_at,end_at,reason,created_at`,
      [tenantId, memberId, start, end, input.reason || null, actor.userId]
    );
    await client.query(
      `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
       VALUES($1,$2,$3,'scheduling.attendant.time_block.create','scheduling_attendant_time_block',$4,$5,$6,$7)`,
      [actor.userId, tenantId, actor.actorScope, inserted.rows[0].id, {
        member_id: memberId,
        start: start.toISOString(),
        end: end.toISOString(),
        reason: input.reason || null
      }, actor.ipAddress ?? null, actor.userAgent ?? null]
    );
    return mapAttendantTimeBlock(inserted.rows[0]);
  });
}

export async function deleteOwnAttendantTimeBlock(
  tenantId: string,
  userId: string,
  blockId: string,
  actor: FollowUpActor
) {
  return withTransaction(async (client) => {
    const removed = await client.query<AttendantTimeBlockRow>(
      `DELETE FROM scheduling_attendant_time_blocks block
       USING workspace_members member
       WHERE block.id=$1 AND block.tenant_id=$2
         AND member.id=block.member_id AND member.workspace_id=block.tenant_id
         AND member.user_id=$3
       RETURNING block.id,block.member_id,block.start_at,block.end_at,block.reason,block.created_at`,
      [blockId, tenantId, userId]
    );
    const row = removed.rows[0];
    if (!row) throw httpError(404, "Bloqueio de horário não encontrado");
    await client.query(
      `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
       VALUES($1,$2,$3,'scheduling.attendant.time_block.delete','scheduling_attendant_time_block',$4,$5,$6,$7)`,
      [actor.userId, tenantId, actor.actorScope, blockId, {
        member_id: row.member_id,
        start: row.start_at.toISOString(),
        end: row.end_at.toISOString()
      }, actor.ipAddress ?? null, actor.userAgent ?? null]
    );
    return mapAttendantTimeBlock(row);
  });
}

export async function updateAttendantCalendarColor(
  tenantId: string,
  memberId: string,
  color: string,
  actor: FollowUpActor
) {
  return withTransaction(async (client) => {
    const current = await client.query<{
      member_id: string;
      user_id: string;
      email: string;
      calendar_color: string;
    }>(
      `SELECT pool.member_id,m.user_id,u.email,pool.calendar_color
       FROM scheduling_google_meet_closers pool
       JOIN workspace_members m
         ON m.id=pool.member_id AND m.workspace_id=pool.tenant_id AND m.status='active'
       JOIN users u ON u.id=m.user_id AND u.status='active'
       WHERE pool.tenant_id=$1 AND pool.member_id=$2
       FOR UPDATE OF pool`,
      [tenantId, memberId]
    );
    const attendant = current.rows[0];
    if (!attendant) throw httpError(404, "Atendente ativo não encontrado no pool");
    if (attendant.calendar_color.toUpperCase() === color) {
      return {
        attendant: {
          member_id: attendant.member_id,
          user_id: attendant.user_id,
          email: attendant.email,
          cor_agenda: color
        },
        alterado: false
      };
    }
    await client.query(
      `UPDATE scheduling_google_meet_closers
       SET calendar_color=$3
       WHERE tenant_id=$1 AND member_id=$2`,
      [tenantId, memberId, color]
    );
    await client.query(
      `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
       VALUES($1,$2,$3,'scheduling.attendant.calendar_color.update','scheduling_attendant',$4,$5,$6,$7)`,
      [actor.userId, tenantId, actor.actorScope, memberId, {
        previous_color: attendant.calendar_color,
        calendar_color: color
      }, actor.ipAddress ?? null, actor.userAgent ?? null]
    );
    return {
      attendant: {
        member_id: attendant.member_id,
        user_id: attendant.user_id,
        email: attendant.email,
        cor_agenda: color
      },
      alterado: true
    };
  });
}

export async function loadGoogleMeetSettings(tenantId: string) {
  const client = await db.connect();
  try {
    const settings = await client.query<{
      enabled: boolean;
      organizer_email: string | null;
      creation_moment: "appointment_confirmed";
      oauth_email: string | null;
      oauth_refresh_token_encrypted: string | null;
      oauth_connected_at: Date | null;
    }>(
      `SELECT enabled,organizer_email,creation_moment,oauth_email,oauth_refresh_token_encrypted,oauth_connected_at
       FROM scheduling_google_meet_settings WHERE tenant_id=$1`,
      [tenantId]
    );
    const selected = await client.query<{ member_id: string }>(
      "SELECT member_id FROM scheduling_google_meet_closers WHERE tenant_id=$1 ORDER BY member_id",
      [tenantId]
    );
    const closers = await listEligibleAttendants(client, tenantId);
    const row = settings.rows[0];
    return {
      settings: {
        enabled: row?.enabled ?? false,
        organizer_email: row?.organizer_email ?? null,
        creation_moment: row?.creation_moment ?? "appointment_confirmed",
        closer_member_ids: selected.rows.map((item) => item.member_id),
        oauth_email: row?.oauth_email ?? null,
        oauth_connected_at: row?.oauth_connected_at?.toISOString() ?? null,
        oauth_connected: Boolean(row?.oauth_email && row.oauth_refresh_token_encrypted),
        oauth_available: Boolean(
          config.GOOGLE_MEET_OAUTH_CLIENT_ID
          && config.GOOGLE_MEET_OAUTH_CLIENT_SECRET
          && config.GOOGLE_MEET_OAUTH_REDIRECT_URI
        )
      },
      closers: closers.map((item) => ({
        member_id: item.member_id,
        user_id: item.user_id,
        email: item.email,
        funcao: item.role_name
      }))
    };
  } finally {
    client.release();
  }
}

export async function loadAtendonMeetSettings(tenantId: string) {
  const result = await db.query<{ enabled: boolean }>(
    "SELECT enabled FROM scheduling_atendon_meet_settings WHERE tenant_id=$1",
    [tenantId]
  );
  return {
    settings: {
      enabled: config.MEET_ENABLED && (result.rows[0]?.enabled ?? false),
      available: config.MEET_ENABLED
    }
  };
}

export async function updateAtendonMeetSettings(
  tenantId: string,
  input: z.infer<typeof atendonMeetSettingsBody>,
  actor: FollowUpActor
) {
  if (input.enabled && !config.MEET_ENABLED) {
    throw httpError(409, "A infraestrutura do AtendON Meet ainda não está disponível");
  }
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO scheduling_atendon_meet_settings(tenant_id,enabled)
       VALUES($1,$2)
       ON CONFLICT(tenant_id) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=now()`,
      [tenantId, input.enabled]
    );
    await client.query(
      `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
       VALUES($1,$2,$3,'atendon_meet.settings.update','atendon_meet_settings',$4,$5,$6,$7)`,
      [actor.userId, tenantId, actor.actorScope, tenantId, { enabled: input.enabled }, actor.ipAddress ?? null, actor.userAgent ?? null]
    );
  });
  return loadAtendonMeetSettings(tenantId);
}

export async function updateGoogleMeetSettings(
  tenantId: string,
  input: z.infer<typeof googleMeetSettingsBody>,
  actor: FollowUpActor
) {
  await withTransaction(async (client) => {
    const currentResult = await client.query<{
      oauth_email: string | null;
      oauth_refresh_token_encrypted: string | null;
      oauth_connected_at: Date | null;
    }>(
      `SELECT oauth_email,oauth_refresh_token_encrypted,oauth_connected_at
       FROM scheduling_google_meet_settings WHERE tenant_id=$1 FOR UPDATE`,
      [tenantId]
    );
    const current = currentResult.rows[0];
    if (input.enabled && (!current?.oauth_email || !current.oauth_refresh_token_encrypted)) {
      throw httpError(409, "Conecte uma conta Google antes de ativar a automação do Meet");
    }
    await applyAttendantPoolUpdate(
      client,
      tenantId,
      input.closer_member_ids,
      actor,
      "google_meet_compatibility"
    );
    await client.query(
      `INSERT INTO scheduling_google_meet_settings(
         tenant_id,enabled,organizer_email,creation_moment,oauth_email,oauth_refresh_token_encrypted,oauth_connected_at
       )
       VALUES($1,$2,$3,'appointment_confirmed',$3,$4,$5)
       ON CONFLICT(tenant_id) DO UPDATE SET
         enabled=EXCLUDED.enabled,
         creation_moment=EXCLUDED.creation_moment,
         updated_at=now()`,
      [tenantId, input.enabled, current?.oauth_email ?? null, current?.oauth_refresh_token_encrypted ?? null, current?.oauth_connected_at ?? null]
    );
    await client.query(
      `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
       VALUES($1,$2,$3,'google_meet.settings.update','google_meet_settings',$4,$5,$6,$7)`,
      [actor.userId, tenantId, actor.actorScope, tenantId, {
        enabled: input.enabled,
        closer_member_ids: input.closer_member_ids,
        creation_moment: "appointment_confirmed",
        oauth_email: current?.oauth_email ?? null
      }, actor.ipAddress ?? null, actor.userAgent ?? null]
    );
  });
  return loadGoogleMeetSettings(tenantId);
}

export async function connectGoogleMeetOAuth(
  tenantId: string,
  input: { email: string; refreshToken: string },
  actor: FollowUpActor
) {
  const encryptedRefreshToken = encryptSecret(input.refreshToken, config.DATA_ENCRYPTION_KEY);
  let requeuedOutboxIds: string[] = [];
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO scheduling_google_meet_settings(
         tenant_id,enabled,organizer_email,creation_moment,oauth_email,oauth_refresh_token_encrypted,oauth_connected_at
       ) VALUES($1,false,$2,'appointment_confirmed',$2,$3,now())
       ON CONFLICT(tenant_id) DO UPDATE SET
         organizer_email=EXCLUDED.organizer_email,
         oauth_email=EXCLUDED.oauth_email,
         oauth_refresh_token_encrypted=EXCLUDED.oauth_refresh_token_encrypted,
         oauth_connected_at=now(),
         service_account_email=NULL,
         service_account_private_key_encrypted=NULL,
         updated_at=now()`,
      [tenantId, input.email, encryptedRefreshToken]
    );
    await client.query(
      `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
       VALUES($1,$2,$3,'google_meet.oauth.connect','google_meet_settings',$4,$5,$6,$7)`,
      [actor.userId, tenantId, actor.actorScope, tenantId, { oauth_email: input.email }, actor.ipAddress ?? null, actor.userAgent ?? null]
    );
    // Reconnecting is the "reconciliar o agendamento" step the failure alert asks for:
    // a stale/revoked refresh_token leaves outbox rows stuck in failed/uncertain forever,
    // since findDuePage() only scans pending/processing. Requeue them here so the fresh
    // token is actually used, instead of silently requiring a human to touch the DB.
    const requeued = await client.query<{ id: string }>(
      `UPDATE scheduling_meeting_provisioning_outbox
       SET status='pending',attempt_count=0,attempted_at=NULL,last_error=NULL,
           processing_started_at=NULL,completed_at=NULL,available_at=now(),updated_at=now()
       WHERE tenant_id=$1 AND status IN ('failed','uncertain')
       RETURNING id`,
      [tenantId]
    );
    requeuedOutboxIds = requeued.rows.map((row) => row.id);
    if (requeuedOutboxIds.length > 0) {
      await client.query(
        `UPDATE scheduling_appointments
         SET meeting_provisioning_status='pending',meeting_provisioning_error=NULL,updated_at=now()
         WHERE tenant_id=$1 AND meeting_provisioning_status IN ('failed','uncertain')`,
        [tenantId]
      );
    }
  });
  for (const outboxId of requeuedOutboxIds) {
    try {
      await enqueueMeetingProvisioning(outboxId);
    } catch (error) {
      logger.warn(
        { err: error, tenantId, outboxId },
        "Google Meet reconciliation requeue failed to enqueue; periodic reconciler will retry"
      );
    }
  }
  return loadGoogleMeetSettings(tenantId);
}

export async function disconnectGoogleMeetOAuth(tenantId: string, actor: FollowUpActor) {
  await withTransaction(async (client) => {
    const current = await client.query<{ oauth_email: string | null }>(
      "SELECT oauth_email FROM scheduling_google_meet_settings WHERE tenant_id=$1 FOR UPDATE",
      [tenantId]
    );
    await client.query(
      `UPDATE scheduling_google_meet_settings
       SET enabled=false,organizer_email=NULL,oauth_email=NULL,oauth_refresh_token_encrypted=NULL,oauth_connected_at=NULL,updated_at=now()
       WHERE tenant_id=$1`,
      [tenantId]
    );
    await client.query(
      `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
       VALUES($1,$2,$3,'google_meet.oauth.disconnect','google_meet_settings',$4,$5,$6,$7)`,
      [actor.userId, tenantId, actor.actorScope, tenantId, { was_connected: Boolean(current.rows[0]?.oauth_email) }, actor.ipAddress ?? null, actor.userAgent ?? null]
    );
  });
  return loadGoogleMeetSettings(tenantId);
}

type AppointmentCreationOptions = {
  enqueueProvisioning?: (outboxId: string) => Promise<void>;
  now?: Date;
  manual?: boolean;
  expectedAssignedMemberId?: string;
  allowExplicitAssignee?: boolean;
  allowCapacityOverride?: boolean;
  requireAvailableAttendant?: boolean;
  minimumLeadTimeMinutes?: number;
  actor?: JourneyActor;
};

async function loadEnabledGoogleMeetAutomation(client: PoolClient, tenantId: string): Promise<boolean> {
  const settings = await client.query<{
    oauth_refresh_token_encrypted: string | null;
  }>(
    `SELECT oauth_refresh_token_encrypted
     FROM scheduling_google_meet_settings
     WHERE tenant_id=$1 AND enabled=true AND creation_moment='appointment_confirmed'`,
    [tenantId]
  );
  if (!settings.rows[0]) return false;
  const credentials = settings.rows[0];
  if (!credentials.oauth_refresh_token_encrypted) {
    throw httpError(503, "A automação do Google Meet está ativa, mas a conta Google não está conectada");
  }
  return true;
}

async function loadEnabledAtendonMeetAutomation(client: PoolClient, tenantId: string): Promise<boolean> {
  if (!config.MEET_ENABLED) return false;
  const settings = await client.query<{ enabled: boolean }>(
    "SELECT enabled FROM scheduling_atendon_meet_settings WHERE tenant_id=$1 AND enabled=true",
    [tenantId]
  );
  return settings.rows[0]?.enabled === true;
}

export type AppointmentAttendantAssignment = {
  memberId: string;
  userId: string;
  email: string;
  activeAppointments: number;
  availabilityStatus: AttendantAvailabilityStatus;
};

async function lockAttendantDistribution(client: PoolClient, tenantId: string) {
  // Keep the legacy key so deployments upgrading in place serialize old and
  // new application instances against the same assignment decision.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`closer-round-robin:${tenantId}`]);
}

export async function selectAppointmentAttendant(
  client: PoolClient,
  tenantId: string,
  options: { excludeMemberIds?: string[]; start?: Date; end?: Date; excludeAppointmentId?: string } = {}
): Promise<AppointmentAttendantAssignment | null> {
  const start = options.start ?? new Date();
  const end = options.end ?? new Date(start.getTime() + 1);
  return selectAvailableAppointmentAttendant(client, tenantId, { start, end }, options);
}

/** @deprecated Compatibility alias for the previous closer terminology. */
export const selectAppointmentCloser = selectAppointmentAttendant;

async function loadExplicitAppointmentAttendant(
  client: PoolClient,
  tenantId: string,
  memberId: string,
  interval: { start: Date; end: Date },
  excludeAppointmentId?: string
): Promise<AppointmentAttendantAssignment> {
  await lockAttendantDistribution(client, tenantId);
  const result = await client.query<{
    member_id: string;
    user_id: string;
    email: string;
    availability_status: AttendantAvailabilityStatus;
    active_appointments: number;
    overlapping_appointments: number;
  }>(
    `SELECT member.id member_id,member.user_id,"user".email,pool.availability_status,
            count(appointment.id) FILTER (
              WHERE appointment.status IN ('confirmado','reagendado') AND appointment.end_at>now()
                AND ($5::uuid IS NULL OR appointment.id<>$5)
            )::int active_appointments,
            count(appointment.id) FILTER (
              WHERE appointment.status IN ('confirmado','reagendado')
                AND appointment.start_at<$4 AND appointment.end_at>$3
                AND ($5::uuid IS NULL OR appointment.id<>$5)
            )::int overlapping_appointments
     FROM scheduling_google_meet_closers pool
     JOIN workspace_members member
       ON member.id=pool.member_id AND member.workspace_id=pool.tenant_id AND member.status='active'
     JOIN users "user" ON "user".id=member.user_id AND "user".status='active'
     LEFT JOIN scheduling_appointments appointment
       ON appointment.tenant_id=pool.tenant_id AND appointment.assigned_member_id=pool.member_id
     WHERE pool.tenant_id=$1 AND pool.member_id=$2
       AND EXISTS (SELECT 1 FROM workspace_role_permissions permission WHERE permission.role_id=member.role_id AND permission.permission_key='leads.read')
       AND EXISTS (SELECT 1 FROM workspace_role_permissions permission WHERE permission.role_id=member.role_id AND permission.permission_key='conversations.read')
       AND EXISTS (SELECT 1 FROM workspace_role_permissions permission WHERE permission.role_id=member.role_id AND permission.permission_key='conversations.reply')
     GROUP BY member.id,member.user_id,"user".email,pool.availability_status`,
    [tenantId, memberId, interval.start, interval.end, excludeAppointmentId ?? null]
  );
  const row = result.rows[0];
  if (!row) throw httpError(400, "Responsável deve ser um closer ativo do pool");
  if (row.availability_status !== "available") throw httpError(409, "Este closer está marcado como indisponível");
  if (row.overlapping_appointments > 0) throw httpError(409, "Este closer já possui uma reunião nesse horário");
  const blocked = await client.query(
    `SELECT 1 FROM scheduling_attendant_time_blocks
     WHERE tenant_id=$1 AND member_id=$2 AND start_at<$4 AND end_at>$3
     LIMIT 1`,
    [tenantId, memberId, interval.start, interval.end]
  );
  if (blocked.rows[0]) throw httpError(409, "Este closer bloqueou esse horário na agenda");
  return {
    memberId: row.member_id,
    userId: row.user_id,
    email: row.email,
    availabilityStatus: row.availability_status,
    activeAppointments: row.active_appointments
  };
}

export type AppointmentAssigneeOption = {
  member_id: string;
  user_id: string;
  name: string | null;
  email: string;
  availability_status: AttendantAvailabilityStatus;
  future_meetings: Array<{ id: string; start: string; end: string; lead_name: string | null }>;
  future_meetings_count: number;
  conflicts: Array<{ id: string; start: string; end: string; lead_name: string | null }>;
  selectable: boolean;
  suggested: boolean;
};

export async function listAppointmentAssignees(
  tenantId: string,
  interval: { start: Date; end: Date },
  excludeAppointmentId?: string
): Promise<AppointmentAssigneeOption[]> {
  const members = await db.query<{
    member_id: string;
    user_id: string;
    name: string | null;
    email: string;
    availability_status: AttendantAvailabilityStatus;
    pool_created_at: Date;
  }>(
    `SELECT member.id member_id,member.user_id,"user".name,"user".email,
            pool.availability_status,pool.created_at pool_created_at
     FROM scheduling_google_meet_closers pool
     JOIN workspace_members member
       ON member.id=pool.member_id AND member.workspace_id=pool.tenant_id AND member.status='active'
     JOIN users "user" ON "user".id=member.user_id AND "user".status='active'
     WHERE pool.tenant_id=$1
       AND EXISTS (SELECT 1 FROM workspace_role_permissions permission WHERE permission.role_id=member.role_id AND permission.permission_key='leads.read')
       AND EXISTS (SELECT 1 FROM workspace_role_permissions permission WHERE permission.role_id=member.role_id AND permission.permission_key='conversations.read')
       AND EXISTS (SELECT 1 FROM workspace_role_permissions permission WHERE permission.role_id=member.role_id AND permission.permission_key='conversations.reply')
     ORDER BY pool.created_at,member.id`,
    [tenantId]
  );
  if (!members.rows.length) return [];
  const meetings = await db.query<{
    id: string;
    assigned_member_id: string;
    start_at: Date;
    end_at: Date;
    lead_name: string | null;
  }>(
    `SELECT appointment.id,appointment.assigned_member_id,appointment.start_at,appointment.end_at,lead.name lead_name
     FROM scheduling_appointments appointment
     JOIN scheduling_leads lead ON lead.id=appointment.lead_id AND lead.tenant_id=appointment.tenant_id
     WHERE appointment.tenant_id=$1
       AND appointment.assigned_member_id=ANY($2::uuid[])
       AND appointment.status IN ('confirmado','reagendado')
       AND appointment.end_at>now()
       AND ($3::uuid IS NULL OR appointment.id<>$3)
     ORDER BY appointment.start_at,appointment.id`,
    [tenantId, members.rows.map((member) => member.member_id), excludeAppointmentId ?? null]
  );
  const blocks = await db.query<{
    id: string;
    member_id: string;
    start_at: Date;
    end_at: Date;
    reason: string | null;
  }>(
    `SELECT id,member_id,start_at,end_at,reason
     FROM scheduling_attendant_time_blocks
     WHERE tenant_id=$1 AND member_id=ANY($2::uuid[])
       AND start_at<$4 AND end_at>$3
     ORDER BY start_at,id`,
    [tenantId, members.rows.map((member) => member.member_id), interval.start, interval.end]
  );
  const cursor = await db.query<{ last_member_id: string | null }>(
    "SELECT last_member_id FROM attendant_assignment_cursors WHERE tenant_id=$1",
    [tenantId]
  );
  const base: AppointmentAssigneeOption[] = members.rows.map((member) => {
    const assigned = meetings.rows.filter((meeting) => meeting.assigned_member_id === member.member_id);
    const conflicts = assigned.filter(
      (meeting) => meeting.start_at < interval.end && meeting.end_at > interval.start
    );
    const blocked = blocks.rows.filter((block) => block.member_id === member.member_id);
    return {
      member_id: member.member_id,
      user_id: member.user_id,
      name: member.name,
      email: member.email,
      availability_status: member.availability_status,
      future_meetings: assigned.slice(0, 20).map((meeting) => ({
        id: meeting.id,
        start: meeting.start_at.toISOString(),
        end: meeting.end_at.toISOString(),
        lead_name: meeting.lead_name
      })),
      future_meetings_count: assigned.length,
      conflicts: [...conflicts.map((meeting) => ({
        id: meeting.id,
        start: meeting.start_at.toISOString(),
        end: meeting.end_at.toISOString(),
        lead_name: meeting.lead_name
      })), ...blocked.map((block) => ({
        id: block.id,
        start: block.start_at.toISOString(),
        end: block.end_at.toISOString(),
        lead_name: block.reason || "Horário bloqueado"
      }))],
      selectable: member.availability_status === "available" && conflicts.length === 0 && blocked.length === 0,
      suggested: false
    };
  });
  const selectable = base.filter((member) => member.selectable);
  if (selectable.length) {
    const minimumLoad = Math.min(...selectable.map((member) => member.future_meetings_count));
    const leastLoaded = new Set(selectable.filter((member) => member.future_meetings_count === minimumLoad).map((member) => member.member_id));
    const lastIndex = base.findIndex((member) => member.member_id === cursor.rows[0]?.last_member_id);
    const rotation = [...base.slice(lastIndex + 1), ...base.slice(0, lastIndex + 1)];
    const suggested = rotation.find((member) => member.selectable && leastLoaded.has(member.member_id));
    if (suggested) suggested.suggested = true;
  }
  return base;
}

export async function reassignAppointmentAssignee(
  tenantId: string,
  appointmentId: string,
  memberId: string | null,
  actor: FollowUpActor
) {
  const result = await withTransaction(async (client) => {
    const current = await client.query<{
      id: string;
      lead_id: string;
      status: AppointmentStatus;
      start_at: Date;
      end_at: Date;
      assigned_member_id: string | null;
      previous_user_id: string | null;
      lead_name: string | null;
      lead_phone: string;
    }>(
      `SELECT appointment.id,appointment.lead_id,appointment.status,appointment.start_at,appointment.end_at,
              appointment.assigned_member_id,previous_member.user_id previous_user_id,
              lead.name lead_name,lead.phone lead_phone
       FROM scheduling_appointments appointment
       JOIN scheduling_leads lead ON lead.id=appointment.lead_id AND lead.tenant_id=appointment.tenant_id
       LEFT JOIN workspace_members previous_member
         ON previous_member.id=appointment.assigned_member_id AND previous_member.workspace_id=appointment.tenant_id
       WHERE appointment.tenant_id=$1 AND appointment.id=$2
       FOR UPDATE OF appointment`,
      [tenantId, appointmentId]
    );
    const appointment = current.rows[0];
    if (!appointment) throw httpError(404, "Agendamento não encontrado");
    if (!appointmentStatus.safeParse(appointment.status).success || !["confirmado", "reagendado"].includes(appointment.status)) {
      throw httpError(409, "Somente reuniões ativas podem ser reatribuídas");
    }
    if (appointment.assigned_member_id === memberId) return loadMappedAppointment(client, tenantId, appointmentId);

    if (memberId) {
      await loadExplicitAppointmentAttendant(
        client,
        tenantId,
        memberId,
        { start: appointment.start_at, end: appointment.end_at },
        appointmentId
      );
      const transferred = await transferCaseAssignment(client, {
        tenantId,
        selector: { leadId: appointment.lead_id },
        targetMemberId: memberId,
        actor,
        manager: true,
        preserveAutomation: true
      });
      if (!transferred.found) throw httpError(404, "Agendamento não encontrado");
    } else {
      const available = await selectAppointmentAttendant(client, tenantId, {
        start: appointment.start_at,
        end: appointment.end_at,
        excludeAppointmentId: appointmentId
      });
      if (available) throw httpError(409, "Selecione um closer disponível para esta reunião");
      await client.query(
        `UPDATE scheduling_appointments
         SET assigned_member_id=NULL,assigned_at=NULL,updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [tenantId, appointmentId]
      );
      if (appointment.previous_user_id) {
        const alert = await client.query<{ id: string }>(
          `INSERT INTO system_alerts(tenant_id,message,kind,audience,metadata)
           VALUES($1,$2,'meeting','selected',$3) RETURNING id`,
          [tenantId, `Reunião redistribuída: ${appointment.lead_name?.trim() || appointment.lead_phone}`, {
            event: "appointment_reassigned_out",
            appointment_id: appointmentId,
            lead_id: appointment.lead_id,
            responsavel_anterior_member_id: appointment.assigned_member_id,
            responsavel_novo_member_id: null
          }]
        );
        await client.query(
          `INSERT INTO system_alert_receipts(alert_id,tenant_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
          [alert.rows[0].id, tenantId, appointment.previous_user_id]
        );
      }
    }
    await client.query(
      `UPDATE scheduling_leads SET closer_member_id=$3,handoff_at=now(),handoff_by_user_id=$4,updated_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId,appointment.lead_id,memberId,actor.userId]
    );
    await client.query(
      `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
       VALUES($1,$2,$3,'scheduling.appointment.assignment.update','scheduling_appointment',$4,$5,$6,$7)`,
      [actor.userId, tenantId, actor.actorScope, appointmentId, {
        previous_member_id: appointment.assigned_member_id,
        assigned_member_id: memberId,
        automation_preserved: true
      }, actor.ipAddress ?? null, actor.userAgent ?? null]
    );
    return loadMappedAppointment(client, tenantId, appointmentId);
  });
  await synchronizeAppointmentNotification(tenantId, appointmentId);
  return result;
}

async function loadMappedAppointment(client: PoolClient, tenantId: string, appointmentId: string) {
  const result = await client.query(
    `SELECT appointment.*,unit.name unit_name,tenant.timezone,unit.slot_duration_min,
            member.user_id assigned_user_id,"user".email assigned_user_email,
            pool.availability_status assigned_availability_status,pool.calendar_color assigned_calendar_color
     FROM scheduling_appointments appointment
     JOIN scheduling_units unit ON unit.id=appointment.unit_id AND unit.tenant_id=appointment.tenant_id
     JOIN tenants tenant ON tenant.id=appointment.tenant_id
     LEFT JOIN workspace_members member ON member.id=appointment.assigned_member_id AND member.workspace_id=appointment.tenant_id
     LEFT JOIN users "user" ON "user".id=member.user_id
     LEFT JOIN scheduling_google_meet_closers pool ON pool.tenant_id=appointment.tenant_id AND pool.member_id=appointment.assigned_member_id
     WHERE appointment.tenant_id=$1 AND appointment.id=$2`,
    [tenantId, appointmentId]
  );
  return appointmentMapper(result.rows[0]);
}

export async function joinAppointment(
  tenantId: string,
  appointmentId: string,
  actor: FollowUpActor,
  expectedAssignedMemberId?: string
) {
  return withTransaction(async (client) => {
    const current = await client.query<{
      id: string;
      assigned_member_id: string | null;
      start_at: Date;
      status: AppointmentStatus;
      meeting_provider: "google_meet" | "atendon_meet" | null;
      meeting_url: string | null;
      meeting_provisioning_status: string;
    }>(
      `SELECT id,assigned_member_id,start_at,status,meeting_provider,meeting_url,meeting_provisioning_status
       FROM scheduling_appointments
       WHERE tenant_id=$1 AND id=$2
       FOR SHARE`,
      [tenantId,appointmentId]
    );
    const appointment=current.rows[0];
    if (!appointment || (expectedAssignedMemberId && appointment.assigned_member_id!==expectedAssignedMemberId)) {
      throw httpError(404,"Agendamento não encontrado");
    }
    if (!['confirmado','reagendado'].includes(appointment.status)) {
      throw httpError(409,"Somente reuniões ativas podem ser acessadas");
    }
    if (appointment.assigned_member_id) {
      const unresolved = await client.query<{ id: string }>(
        `SELECT id FROM scheduling_appointments
         WHERE tenant_id=$1 AND assigned_member_id=$2 AND id<>$3
           AND status IN ('confirmado','reagendado')
           AND commercial_outcome IS NULL
           AND end_at<=now() AND start_at+interval '1 hour'<=now() AND start_at<$4
         ORDER BY end_at,id
         LIMIT 1`,
        [tenantId,appointment.assigned_member_id,appointmentId,appointment.start_at]
      );
      if (unresolved.rows[0]) {
        throw httpError(409,"Registre o resultado da reunião anterior antes de entrar nesta sala");
      }
    }
    if (appointment.meeting_provisioning_status!=="ready" || !appointment.meeting_url) {
      throw httpError(409,"A sala desta reunião ainda não está disponível");
    }
    await client.query(
      `INSERT INTO audit_logs(
         actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent
       ) VALUES($1,$2,$3,'scheduling.appointment.join','scheduling_appointment',$4,$5,$6,$7)`,
      [actor.userId,tenantId,actor.actorScope,appointmentId,{ assigned_member_id: appointment.assigned_member_id },actor.ipAddress ?? null,actor.userAgent ?? null]
    );
    if (appointment.meeting_provider === "atendon_meet") {
      const room = await client.query<{ id: string }>(
        "SELECT id FROM meet_rooms WHERE tenant_id=$1 AND appointment_id=$2",
        [tenantId, appointmentId]
      );
      if (!room.rows[0]) throw httpError(409, "A sala desta reunião ainda não está disponível");
      return { url: new URL(`/meet/${room.rows[0].id}`, config.PANEL_PUBLIC_URL).toString() };
    }
    return { url: appointment.meeting_url };
  });
}

export function formatNewMeetingAlert(input: {
  contactName: string | null;
  contactPhone: string;
  start: Date;
  timezone: string;
  meetLink?: string | null;
}): string {
  const contact = input.contactName?.trim() || input.contactPhone;
  const dateLabel = new Intl.DateTimeFormat("pt-BR", {
    timeZone: input.timezone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(input.start);
  const timeLabel = new Intl.DateTimeFormat("pt-BR", {
    timeZone: input.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(input.start);
  const contactLabel = input.contactName?.trim() ? `${contact} · ${input.contactPhone}` : contact;
  const linkLabel = input.meetLink ? ` · ${input.meetLink}` : "";
  return `Nova reunião: ${contactLabel} · ${dateLabel} às ${timeLabel}${linkLabel}`;
}

export type TargetedMeetingAlertInput = {
  tenantId: string;
  appointmentId: string;
  leadId: string;
  contactName: string | null;
  contactPhone: string;
  unitId: string;
  unitName: string;
  start: Date;
  end: Date;
  timezone: string;
  meetLink: string | null;
};

async function insertTargetedMeetingAlert(
  client: PoolClient,
  input: TargetedMeetingAlertInput & {
    message: string;
    recipientUserIds: string[];
    event: "appointment_assigned" | "appointment_reassigned_in" | "appointment_reassigned_out";
    previousMemberId?: string | null;
    assignedMemberId?: string | null;
  }
) {
  if (!input.recipientUserIds.length) return;
  const alert = await client.query<{ id: string }>(
    `INSERT INTO system_alerts(tenant_id,message,kind,audience,metadata)
     VALUES($1,$2,'meeting','selected',$3) RETURNING id`,
    [input.tenantId, input.message, {
      event: input.event,
      appointment_id: input.appointmentId,
      lead_id: input.leadId,
      contact_name: input.contactName,
      contact_phone: input.contactPhone,
      unit_id: input.unitId,
      unit_name: input.unitName,
      starts_at: input.start.toISOString(),
      ends_at: input.end.toISOString(),
      timezone: input.timezone,
      meet_url: input.meetLink,
      previous_member_id: input.previousMemberId ?? null,
      assigned_member_id: input.assignedMemberId ?? null
    }]
  );
  await client.query(
    `INSERT INTO system_alert_receipts(alert_id,tenant_id,user_id)
     SELECT $1,$2,unnest($3::uuid[])
     ON CONFLICT(alert_id,tenant_id,user_id) DO NOTHING`,
    [alert.rows[0].id, input.tenantId, [...new Set(input.recipientUserIds)]]
  );
}

export async function insertNewMeetingAlert(
  client: PoolClient,
  input: TargetedMeetingAlertInput & { attendantUserId: string; assignedMemberId: string }
) {
  await insertTargetedMeetingAlert(client, {
    ...input,
    message: formatNewMeetingAlert(input),
    recipientUserIds: [input.attendantUserId],
    event: "appointment_assigned",
    assignedMemberId: input.assignedMemberId
  });
}

export async function insertUnassignedAppointmentAlert(
  client: PoolClient,
  input: TargetedMeetingAlertInput
) {
  await client.query(
    `INSERT INTO system_alerts(tenant_id,message,kind,audience,metadata)
     VALUES($1,$2,'meeting','workspace',$3)`,
    [input.tenantId, `Reunião criada sem responsável: ${input.contactName?.trim() || input.contactPhone}`, {
      event: "appointment_unassigned",
      appointment_id: input.appointmentId,
      lead_id: input.leadId,
      contact_name: input.contactName,
      contact_phone: input.contactPhone,
      unit_id: input.unitId,
      unit_name: input.unitName,
      starts_at: input.start.toISOString(),
      ends_at: input.end.toISOString(),
      timezone: input.timezone,
      meet_url: input.meetLink
    }]
  );
}

export async function createAppointment(
  tenantId: string,
  input: z.infer<typeof appointmentBody> | z.infer<typeof panelAppointmentBody>,
  options: AppointmentCreationOptions = {}
) {
  const operationKey = input.idempotency_key
    ? `appointment:${tenantId}:${input.idempotency_key}`
    : `appointment:${tenantId}:${randomUUID()}`;
  const reserved = await withTransaction(async (client) => {
    const lead = await client.query<{
      id: string;
      status: string;
      name: string | null;
      phone: string;
      assigned_member_id: string | null;
    }>(
      `SELECT id,status,name,phone,assigned_member_id
       FROM scheduling_leads WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
      [input.lead_id, tenantId]
    );
    if (!lead.rows[0]) throw httpError(404, "Lead não encontrado");
    if (
      options.expectedAssignedMemberId
      && lead.rows[0].assigned_member_id !== options.expectedAssignedMemberId
    ) {
      throw httpError(404, "Lead não encontrado");
    }
    if (lead.rows[0].status === "fechado" || lead.rows[0].status === "perdido") {
      throw httpError(409, "Reative o lead no pipeline antes de criar um novo agendamento");
    }
    const unit = await loadUnit(client, tenantId, input.unidade_id);
    const start = new Date(input.start);
    const end = options.manual
      ? validateManualAppointmentInterval(unit, start, "end" in input ? input.end : undefined)
      : validateSlot(unit, start);
    const requestHash = createHash("sha256").update(JSON.stringify({
      leadId: input.lead_id,
      unitId: unit.id,
      start: start.toISOString(),
      end: end.toISOString(),
      manual: options.manual === true,
      assignedMemberId: "assigned_member_id" in input ? input.assigned_member_id : undefined
    })).digest("hex");
    const replay = await client.query(
      `SELECT a.*,u.name unit_name,tenant.timezone,u.slot_duration_min,
              m.user_id assigned_user_id,usr.email assigned_user_email,
              pool.availability_status assigned_availability_status,
              pool.calendar_color assigned_calendar_color,
              outbox.id provisioning_outbox_id,
              a.creation_request_hash
       FROM scheduling_appointments a
       JOIN scheduling_units u ON u.tenant_id=a.tenant_id AND u.id=a.unit_id
       JOIN tenants tenant ON tenant.id=a.tenant_id
       LEFT JOIN workspace_members m ON m.id=a.assigned_member_id AND m.workspace_id=a.tenant_id
       LEFT JOIN users usr ON usr.id=m.user_id
       LEFT JOIN scheduling_google_meet_closers pool
         ON pool.tenant_id=a.tenant_id AND pool.member_id=a.assigned_member_id
       LEFT JOIN scheduling_meeting_provisioning_outbox outbox
         ON outbox.tenant_id=a.tenant_id AND outbox.appointment_id=a.id
       WHERE a.tenant_id=$1 AND a.creation_idempotency_key=$2`,
      [tenantId, operationKey]
    );
    if (replay.rows[0]) {
      if (replay.rows[0].creation_request_hash !== requestHash) {
        throw httpError(409, "A chave de idempotência já foi usada com outro agendamento");
      }
      return {
        appointment: appointmentMapper(replay.rows[0]),
        outboxId: replay.rows[0].provisioning_outbox_id as string | null,
        notificationContext: null as AppointmentNotificationContext | null
      };
    }
    assertFutureAppointmentStart(start, options.now, options.minimumLeadTimeMinutes);
    const active = await client.query(
      "SELECT id FROM scheduling_appointments WHERE tenant_id=$1 AND lead_id=$2 AND status IN ('confirmado','reagendado') LIMIT 1",
      [tenantId, input.lead_id]
    );
    if (active.rows[0]) throw httpError(409, "O lead já possui um agendamento ativo; reagende ou cancele o agendamento existente");
    if (!options.requireAvailableAttendant) {
      await assertCapacity(client, tenantId, unit, start, end, undefined, {
        allowCapacityOverride: options.allowCapacityOverride
      });
    }
    const hasExplicitAssignee = "assigned_member_id" in input && input.assigned_member_id !== undefined;
    if (hasExplicitAssignee && !options.allowExplicitAssignee) {
      throw httpError(403, "Somente gestores podem escolher o closer da reunião");
    }
    let selectedAttendant: AppointmentAttendantAssignment | null;
    if (hasExplicitAssignee && input.assigned_member_id) {
      selectedAttendant = await loadExplicitAppointmentAttendant(
        client,
        tenantId,
        input.assigned_member_id,
        { start, end }
      );
    } else if (options.expectedAssignedMemberId) {
      // A closer working in "mine" scope keeps ownership of the meeting they
      // create and cannot be rotated out of their own case after authorization.
      selectedAttendant = await loadExplicitAppointmentAttendant(
        client,
        tenantId,
        options.expectedAssignedMemberId,
        { start, end }
      );
    } else {
      selectedAttendant = await selectAppointmentAttendant(client, tenantId, { start, end });
      if (hasExplicitAssignee && input.assigned_member_id === null && selectedAttendant) {
        throw httpError(409, "Selecione um closer disponível para este horário");
      }
    }
    if (options.requireAvailableAttendant && !selectedAttendant) {
      throw httpError(409, "Não há closer ativo disponível para este horário");
    }
    const caseAssignment = selectedAttendant
      ? await ensureCaseAssignment(client, {
          tenantId,
          selector: { leadId: input.lead_id },
          reason: "reuniao_sem_responsavel",
          forceRotation: true,
          preferredMemberId: selectedAttendant.memberId
        })
      : null;
    const assignedAttendant: AppointmentAttendantAssignment | null = caseAssignment && selectedAttendant
      ? { ...caseAssignment, activeAppointments: selectedAttendant.activeAppointments }
      : null;
    const assignedCalendarColor = assignedAttendant
      ? (await client.query<{ calendar_color: string }>(
          `SELECT calendar_color
           FROM scheduling_google_meet_closers
           WHERE tenant_id=$1 AND member_id=$2`,
          [tenantId, assignedAttendant.memberId]
        )).rows[0]?.calendar_color ?? null
      : null;
    const atendonMeetAutomation = await loadEnabledAtendonMeetAutomation(client, tenantId);
    const googleMeetAutomation = atendonMeetAutomation
      ? false
      : await loadEnabledGoogleMeetAutomation(client, tenantId);
    const meetRoomIdentity = atendonMeetAutomation ? createMeetRoomIdentity() : null;
    const atendonMeetUrl = meetRoomIdentity ? participantJoinUrl(meetRoomIdentity.publicCode) : null;
    if (assignedAttendant) {
      const recurring = await client.query<RecurringTimeBlockRow>(`SELECT * FROM scheduling_attendant_recurring_time_blocks WHERE tenant_id=$1 AND member_id=$2 AND active=true AND starts_on <= ($3 AT TIME ZONE timezone)::date AND (ends_on IS NULL OR ends_on >= ($3 AT TIME ZONE timezone)::date)`, [tenantId, assignedAttendant.memberId, start]);
      if (recurring.rows.some(row => recurringOccurrences(row, start, end).length > 0)) throw httpError(409, "O horário está bloqueado");
    }
    const result = await client.query(
      `INSERT INTO scheduling_appointments(
         lead_id,tenant_id,unit_id,start_at,end_at,status,
         assigned_member_id,assigned_at,meeting_provisioning_status,
         creation_idempotency_key,creation_request_hash,created_by_user_id,
         meeting_provider,meeting_space_name,meeting_code,meeting_url,meeting_created_at,
         contact_confirmation_state,contact_confirmation_requested_at
       )
       VALUES($1,$2,$3,$4,$5,'confirmado',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [
        input.lead_id, tenantId, unit.id, start.toISOString(), end.toISOString(),
        assignedAttendant?.memberId ?? null,
        assignedAttendant ? new Date() : null,
        atendonMeetAutomation ? "ready" : googleMeetAutomation ? "pending" : "not_required",
        operationKey,
        requestHash,
        options.actor?.userId ?? null,
        atendonMeetAutomation ? "atendon_meet" : null,
        meetRoomIdentity?.roomName ?? null,
        meetRoomIdentity?.publicCode ?? null,
        atendonMeetUrl,
        atendonMeetAutomation ? new Date() : null,
        // Quando quem agenda é a IA (sem ator humano), ela pede a confirmação
        // no mesmo turno, conforme a seção 21 do prompt. O estado já nasce
        // `solicitada` para que a resposta do contato possa promovê-lo a
        // `confirmada`. Agendamento criado por atendente no painel não passa
        // por esse pedido, então continua `nao_solicitada`.
        options.actor?.userId ? "nao_solicitada" : "solicitada",
        options.actor?.userId ? null : new Date()
      ]
    );
    if (meetRoomIdentity) {
      await insertMeetRoom(client, tenantId, result.rows[0].id as string, meetRoomIdentity);
    }
    const outbox = googleMeetAutomation
      ? await client.query<{ id: string }>(
          `INSERT INTO scheduling_meeting_provisioning_outbox(
             tenant_id,appointment_id,operation_key
           ) VALUES($1,$2,$3)
           ON CONFLICT(tenant_id,operation_key) DO UPDATE
             SET updated_at=scheduling_meeting_provisioning_outbox.updated_at
           RETURNING id`,
          [tenantId, result.rows[0].id, operationKey]
        )
      : null;
    await applyAppointmentHandoff(client,{
      tenantId,
      appointmentId: result.rows[0].id,
      leadId: input.lead_id,
      unitId: unit.id,
      previousStatus: leadStatus.parse(lead.rows[0].status),
      previousOwnerMemberId: lead.rows[0].assigned_member_id,
      closerMemberId: assignedAttendant?.memberId ?? null,
      start,
      end,
      actor: options.actor ?? { userId: null }
    });
    const alertInput: TargetedMeetingAlertInput = {
      tenantId,
      appointmentId: result.rows[0].id,
      leadId: input.lead_id,
      contactName: lead.rows[0].name,
      contactPhone: lead.rows[0].phone,
      unitId: unit.id,
      unitName: unit.name,
      start,
      end,
      timezone: unit.timezone,
      meetLink: atendonMeetUrl
    };
    if (!googleMeetAutomation) {
      if (assignedAttendant) {
        await insertNewMeetingAlert(client, {
          ...alertInput,
          attendantUserId: assignedAttendant.userId,
          assignedMemberId: assignedAttendant.memberId
        });
      } else {
        await insertUnassignedAppointmentAlert(client, alertInput);
      }
    }
    return {
      appointment: appointmentMapper({
        ...result.rows[0],
        unit_name: unit.name,
        timezone: unit.timezone,
        slot_duration_min: unit.slot_duration_min,
        assigned_user_id: assignedAttendant?.userId ?? null,
        assigned_user_email: assignedAttendant?.email ?? null,
        assigned_availability_status: assignedAttendant?.availabilityStatus ?? null,
        assigned_calendar_color: assignedCalendarColor
      }),
      outboxId: outbox?.rows[0]?.id ?? null,
      notificationContext: {
        leadId: input.lead_id,
        leadName: lead.rows[0].name,
        leadPhone: lead.rows[0].phone,
        start,
        end,
        timezone: unit.timezone,
        assignedEmail: assignedAttendant?.email ?? null,
        meetLink: atendonMeetUrl
      } as AppointmentNotificationContext
    };
  });
  if (reserved.outboxId) {
    try {
      await (options.enqueueProvisioning ?? enqueueMeetingProvisioning)(reserved.outboxId);
    } catch (error) {
      logger.warn(
        { err: error, tenantId, outboxId: reserved.outboxId },
        "Meeting provisioning enqueue failed; database reconciler will retry"
      );
    }
  }
  if (reserved.notificationContext) {
    try {
      await notifyAppointmentGroup(tenantId, reserved.appointment.id as string, reserved.notificationContext);
    } catch (error) {
      logger.warn(
        { err: error, tenantId, appointmentId: reserved.appointment.id },
        "Scheduling group notification failed; appointment already confirmed"
      );
    }
  }
  return reserved.appointment;
}

export async function rescheduleAppointment(
  tenantId: string,
  appointmentId: string,
  input: z.infer<typeof rescheduleBody> | z.infer<typeof panelRescheduleBody>,
  options: {
    manual?: boolean;
    expectedAssignedMemberId?: string;
    allowCapacityOverride?: boolean;
    requireAvailableAttendant?: boolean;
    now?: Date;
    minimumLeadTimeMinutes?: number;
    actor?: JourneyActor;
  } = {}
) {
  const appointment = await withTransaction(async (client) => {
    const current = await client.query<{
      id: string;
      unit_id: string;
      status: string;
      lead_id: string;
      assigned_member_id: string | null;
      start_at: Date;
      end_at: Date;
    }>(
      `SELECT id,unit_id,status,lead_id,assigned_member_id,start_at,end_at
       FROM scheduling_appointments WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
      [appointmentId, tenantId]
    );
    if (!current.rows[0]) throw httpError(404, "Agendamento não encontrado");
    if (
      options.expectedAssignedMemberId
      && current.rows[0].assigned_member_id !== options.expectedAssignedMemberId
    ) {
      throw httpError(404, "Agendamento não encontrado");
    }
    if (current.rows[0].status === "cancelado") throw httpError(409, "Agendamento cancelado não pode ser reagendado");
    const unit = await loadUnit(client, tenantId, input.unidade_id ?? current.rows[0].unit_id);
    const start = new Date(input.start);
    const end = options.manual
      ? validateManualAppointmentInterval(unit, start, "end" in input ? input.end : undefined)
      : validateSlot(unit, start);
    assertFutureAppointmentStart(start, options.now, options.minimumLeadTimeMinutes);
    if (current.rows[0].assigned_member_id && !options.requireAvailableAttendant) {
      await loadExplicitAppointmentAttendant(
        client,tenantId,current.rows[0].assigned_member_id,{ start,end },appointmentId
      );
    }
    if (options.requireAvailableAttendant) {
      const selectedAttendant = current.rows[0].assigned_member_id
        ? await loadExplicitAppointmentAttendant(
            client,
            tenantId,
            current.rows[0].assigned_member_id,
            { start, end },
            appointmentId
          )
        : await selectAppointmentAttendant(client, tenantId, {
            start,
            end,
            excludeAppointmentId: appointmentId
          });
      if (!selectedAttendant) {
        throw httpError(409, "Não há closer ativo disponível para este horário");
      }
      if (!current.rows[0].assigned_member_id) {
        await ensureCaseAssignment(client, {
          tenantId,
          selector: { leadId: current.rows[0].lead_id },
          reason: "reuniao_sem_responsavel",
          forceRotation: true,
          preferredMemberId: selectedAttendant.memberId
        });
      }
    } else {
      await assertCapacity(client, tenantId, unit, start, end, appointmentId, {
        allowCapacityOverride: options.allowCapacityOverride
      });
    }
    const result = await client.query(
      `UPDATE scheduling_appointments
       SET unit_id=$3,start_at=$4,end_at=$5,status='confirmado',result_pending_at=NULL,updated_at=now()
       WHERE id=$1 AND tenant_id=$2 RETURNING *`, [appointmentId, tenantId, unit.id, start.toISOString(), end.toISOString()]
    );
    await client.query(
      `UPDATE scheduling_leads
       SET unit_id=$2,
           status='agendado',
           recovery_required=false,
           recovery_member_id=NULL,
           commercial_outcome=NULL,
           sale_value=NULL,
           loss_reason=NULL,
           commercial_updated_at=NULL,
           commercial_updated_by_user_id=NULL,
           next_action=NULL,
           next_action_at=NULL,
           updated_at=now()
       WHERE id=$1 AND tenant_id=$3`,
      [current.rows[0].lead_id, unit.id, tenantId]
    );
    await client.query(
      `INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,details,actor_user_id)
       VALUES($1,$2,'agendamento_reagendado',$3,$4)`,
      [current.rows[0].lead_id, tenantId, {
        appointment_id: appointmentId,
        previous_start: current.rows[0].start_at,
        previous_end: current.rows[0].end_at,
        start: start.toISOString(),
        end: end.toISOString()
      },options.actor?.userId ?? null]
    );
    return appointmentMapper({
      ...result.rows[0],
      unit_name: unit.name,
      timezone: unit.timezone,
      slot_duration_min: unit.slot_duration_min
    });
  });
  await synchronizeAppointmentNotification(tenantId, appointmentId);
  return appointment;
}

export async function updateAppointmentObservation(
  tenantId: string,
  appointmentId: string,
  observation: string | null,
  expectedUpdatedAt: string,
  actor: FollowUpActor,
  expectedAssignedMemberId?: string
) {
  return withTransaction(async (client) => {
    const current = await client.query<Record<string, unknown> & {
      lead_id: string;
      observation: string | null;
    }>(
      `SELECT appointment.*,unit.name unit_name,tenant.timezone,unit.slot_duration_min,
              member.user_id assigned_user_id,assigned_user.email assigned_user_email,
              pool.availability_status assigned_availability_status,
              pool.calendar_color assigned_calendar_color
       FROM scheduling_appointments appointment
       JOIN scheduling_units unit
         ON unit.tenant_id=appointment.tenant_id AND unit.id=appointment.unit_id
       JOIN tenants tenant ON tenant.id=appointment.tenant_id
       LEFT JOIN workspace_members member
         ON member.id=appointment.assigned_member_id AND member.workspace_id=appointment.tenant_id
       LEFT JOIN users assigned_user ON assigned_user.id=member.user_id
       LEFT JOIN scheduling_google_meet_closers pool
         ON pool.tenant_id=appointment.tenant_id AND pool.member_id=appointment.assigned_member_id
       WHERE appointment.id=$1 AND appointment.tenant_id=$2
       FOR UPDATE OF appointment`,
      [appointmentId, tenantId]
    );
    const appointment = current.rows[0];
    if (!appointment) throw httpError(404, "Agendamento não encontrado");
    if (
      expectedAssignedMemberId
      && appointment.assigned_member_id !== expectedAssignedMemberId
    ) {
      throw httpError(404, "Agendamento não encontrado");
    }
    if (
      !(appointment.updated_at instanceof Date)
      || appointment.updated_at.getTime() !== new Date(expectedUpdatedAt).getTime()
    ) {
      throw httpError(409, "A observação foi alterada por outra pessoa; atualize a agenda e tente novamente");
    }
    if (appointment.observation === observation) {
      return { agendamento: appointmentMapper(appointment), alterado: false };
    }
    const updated = await client.query(
      `UPDATE scheduling_appointments
       SET observation=$3,updated_at=now()
       WHERE id=$1 AND tenant_id=$2
       RETURNING observation,updated_at`,
      [appointmentId, tenantId, observation]
    );
    await client.query(
      `INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,details)
       VALUES($1,$2,'observacao_agendamento_atualizada',$3)`,
      [appointment.lead_id, tenantId, {
        appointment_id: appointmentId,
        preenchida: observation !== null,
        actor_user_id: actor.userId
      }]
    );
    await client.query(
      `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
       VALUES($1,$2,$3,'scheduling.appointment.observation.update','scheduling_appointment',$4,$5,$6,$7)`,
      [actor.userId, tenantId, actor.actorScope, appointmentId, {
        lead_id: appointment.lead_id,
        previous_filled: appointment.observation !== null,
        filled: observation !== null
      }, actor.ipAddress ?? null, actor.userAgent ?? null]
    );
    return {
      agendamento: appointmentMapper({ ...appointment, ...updated.rows[0] }),
      alterado: true
    };
  });
}

export async function openAppointmentConversation(
  tenantId: string,
  appointmentId: string,
  actor: FollowUpActor,
  expectedAssignedMemberId?: string
) {
  return withTransaction(async (client) => {
    const appointment = await client.query<{
      id: string;
      lead_id: string;
      assigned_member_id: string | null;
      phone: string;
      name: string | null;
    }>(
      `SELECT appointment.id,appointment.lead_id,appointment.assigned_member_id,
              lead.phone,lead.name
       FROM scheduling_appointments appointment
       JOIN scheduling_leads lead
         ON lead.id=appointment.lead_id AND lead.tenant_id=appointment.tenant_id
       WHERE appointment.id=$1 AND appointment.tenant_id=$2
       FOR UPDATE OF appointment,lead`,
      [appointmentId, tenantId]
    );
    const row = appointment.rows[0];
    if (!row) throw httpError(404, "Agendamento não encontrado");
    if (expectedAssignedMemberId && row.assigned_member_id !== expectedAssignedMemberId) {
      throw httpError(404, "Agendamento não encontrado");
    }
    const session = await client.query<{ id: string }>(
      `SELECT id FROM whatsapp_sessions
       WHERE tenant_id=$1 AND channel='whatsapp' AND status='connected' AND archived_at IS NULL
       ORDER BY is_primary DESC,last_connected_at DESC NULLS LAST,created_at DESC
       LIMIT 1`,
      [tenantId]
    );
    if (!session.rows[0]) {
      throw httpError(409, "Conecte uma sessão do WhatsApp antes de iniciar a conversa");
    }
    // A conversa reaproveitada tem de ser a DESTA conexão: com múltiplos
    // números, buscar só por telefone traria a conversa do número errado.
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM conversations
       WHERE tenant_id=$1
         AND session_id=$3
         AND regexp_replace(contact_phone,'\\D','','g')=regexp_replace($2,'\\D','','g')
       ORDER BY created_at,id
       LIMIT 1
       FOR UPDATE`,
      [tenantId, row.phone, session.rows[0].id]
    );
    const conversation = existing.rows[0]
      ? await client.query<{ id: string }>(
          `UPDATE conversations
           SET session_id=$3,contact_name=COALESCE(contact_name,$4),
               status='open',resolved_at=NULL,ai_active=false,handoff_reason='manually_paused',handoff_error_code=NULL
           WHERE id=$1 AND tenant_id=$2
           RETURNING id`,
          [existing.rows[0].id, tenantId, session.rows[0].id, row.name]
        )
      : await client.query<{ id: string }>(
          `INSERT INTO conversations(
             tenant_id,session_id,contact_phone,contact_name,ai_active,handoff_reason,status
           ) VALUES($1,$2,$3,$4,false,'manually_paused','open')
           RETURNING id`,
          [tenantId, session.rows[0].id, row.phone, row.name]
        );
    const conversationId = conversation.rows[0].id;
    await ensureCaseAssignment(client, {
      tenantId,
      selector: { leadId: row.lead_id },
      reason: "retorno_conversa_encerrada"
    });
    await client.query(
      `INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,details)
       VALUES($1,$2,'conversa_iniciada_pela_agenda',$3)`,
      [row.lead_id, tenantId, { appointment_id: appointmentId, conversation_id: conversationId }]
    );
    await client.query(
      `INSERT INTO audit_logs(
         actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent
       ) VALUES($1,$2,$3,'scheduling.appointment.conversation.open','scheduling_appointment',$4,$5,$6,$7)`,
      [actor.userId, tenantId, actor.actorScope, appointmentId, {
        lead_id: row.lead_id,
        conversation_id: conversationId,
        created: !existing.rows[0]
      }, actor.ipAddress ?? null, actor.userAgent ?? null]
    );
    return { id: conversationId, created: !existing.rows[0] };
  });
}

export async function transitionAppointment(
  tenantId: string,
  appointmentId: string,
  status: FinalAppointmentStatus,
  expectedAssignedMemberId?: string
) {
  const reserved = await withTransaction(async (client) => {
    const current = await client.query<Record<string, unknown> & { lead_id: string; status: AppointmentStatus }>(
      `SELECT appointment.*,unit.name unit_name,tenant.timezone,unit.slot_duration_min
       FROM scheduling_appointments appointment
       JOIN scheduling_units unit
         ON unit.tenant_id=appointment.tenant_id AND unit.id=appointment.unit_id
       JOIN tenants tenant ON tenant.id=appointment.tenant_id
       WHERE appointment.id=$1 AND appointment.tenant_id=$2
       FOR UPDATE OF appointment`,
      [appointmentId, tenantId]
    );
    if (!current.rows[0]) throw httpError(404, "Agendamento não encontrado");
    if (
      expectedAssignedMemberId
      && current.rows[0].assigned_member_id !== expectedAssignedMemberId
    ) {
      throw httpError(404, "Agendamento não encontrado");
    }
    const previousStatus = current.rows[0].status;
    if (!allowedAppointmentFinalTransitions(previousStatus).includes(status)) {
      throw httpError(409, `Transição de agendamento não permitida: ${previousStatus} -> ${status}`);
    }
    const result = await client.query(
      "UPDATE scheduling_appointments SET status=$3,updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *",
      [appointmentId, tenantId, status]
    );
    await client.query(
      `INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,details)
       VALUES($1,$2,$3,$4)`,
      [current.rows[0].lead_id, tenantId, APPOINTMENT_FINAL_EVENTS[status], { appointment_id: appointmentId, previous_status: previousStatus, new_status: status }]
    );
    const reaction = await client.query<{ id: string }>(
      `UPDATE scheduling_appointment_notifications
       SET reaction_emoji=$3,reaction_status='pending',reaction_attempts=0,
           reaction_last_error=NULL,reacted_at=NULL
       WHERE tenant_id=$1 AND appointment_id=$2
       RETURNING id`,
      [tenantId, appointmentId, APPOINTMENT_STATUS_REACTIONS[status]]
    );
    return {
      appointment: appointmentMapper({ ...current.rows[0], ...result.rows[0] }),
      reactionNotificationId: reaction.rows[0]?.id ?? null
    };
  });
  if (reserved.reactionNotificationId) {
    await enqueueAppointmentStatusReaction(reserved.reactionNotificationId).catch((error) => {
      logger.warn(
        { err: error, tenantId, appointmentId, notificationId: reserved.reactionNotificationId },
        "Appointment status reaction enqueue failed; database reconciler will retry"
      );
    });
  }
  return reserved.appointment;
}

async function finishJourneyOperation(
  tenantId: string,
  appointmentId: string,
  operation: Promise<{ appointment: Record<string,unknown>; reactionNotificationId: string | null }>
) {
  const result = await operation;
  if (result.reactionNotificationId) {
    await enqueueAppointmentStatusReaction(result.reactionNotificationId).catch((error) => {
      logger.warn(
        { err: error,tenantId,appointmentId,notificationId: result.reactionNotificationId },
        "Appointment status reaction enqueue failed; database reconciler will retry"
      );
    });
  }
  return appointmentMapper(result.appointment);
}

export async function cancelAppointment(
  tenantId: string,
  appointmentId: string,
  input: CancellationInput = {
    disposition: "recover",
    next_action: "Retomar agendamento cancelado",
    next_action_at: new Date(Date.now()+24*60*60*1000).toISOString()
  },
  actor: JourneyActor = { userId: null },
  expectedAssignedMemberId?: string
) {
  return finishJourneyOperation(tenantId,appointmentId,cancelAppointmentJourney(tenantId,appointmentId,input,actor,expectedAssignedMemberId));
}

export async function completeAppointment(
  tenantId: string,
  appointmentId: string,
  input: ConcludeAppointmentInput,
  actor: JourneyActor,
  expectedAssignedMemberId?: string
) {
  return finishJourneyOperation(tenantId,appointmentId,concludeAppointmentJourney(tenantId,appointmentId,input,actor,expectedAssignedMemberId));
}

export async function markAppointmentNoShow(
  tenantId: string,
  appointmentId: string,
  input: NoShowInput = {},
  actor: JourneyActor = { userId: null },
  expectedAssignedMemberId?: string
) {
  return finishJourneyOperation(tenantId,appointmentId,markAppointmentNoShowJourney(tenantId,appointmentId,input,actor,expectedAssignedMemberId));
}

export async function transferLead(tenantId: string, leadId: string, reason: string, expectedAssignedMemberId?: string) {
  const result = await withTransaction(async (client) => {
    const lead = await client.query<{ id: string; phone: string; name: string | null; unit_id: string | null; status: string; assigned_member_id: string | null }>(
      "SELECT id,phone,name,unit_id,status,assigned_member_id FROM scheduling_leads WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [leadId, tenantId]
    );
    if (!lead.rows[0]) throw httpError(404, "Lead não encontrado");
    if (expectedAssignedMemberId && lead.rows[0].assigned_member_id !== expectedAssignedMemberId) throw httpError(404, "Lead não encontrado");
    await client.query("UPDATE scheduling_leads SET status='aguardando_resposta',updated_at=now() WHERE id=$1 AND tenant_id=$2 AND ($3::uuid IS NULL OR assigned_member_id=$3)", [leadId, tenantId, expectedAssignedMemberId ?? null]);
    await client.query(
      `UPDATE conversations SET ai_active=false,handoff_reason='commercial_handoff',handoff_error_code=NULL
       WHERE tenant_id=$1 AND (lead_id=$2 OR regexp_replace(contact_phone,'\\D','','g')=regexp_replace($3,'\\D','','g'))`,
      [tenantId,leadId,lead.rows[0].phone]
    );
    await client.query(
      `UPDATE ai_follow_up_schedules schedule
       SET status='cancelled',next_run_at=NULL,processing_started_at=NULL,
           cancellation_reason='commercial_handoff',updated_at=now()
       FROM conversations conversation
       WHERE schedule.conversation_id=conversation.id
         AND schedule.tenant_id=conversation.tenant_id
         AND conversation.tenant_id=$1
         AND (conversation.lead_id=$2 OR regexp_replace(conversation.contact_phone,'\\D','','g')=regexp_replace($3,'\\D','','g'))
         AND schedule.status IN ('scheduled','processing')`,
      [tenantId,leadId,lead.rows[0].phone]
    );
    await client.query(
      `INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,previous_status,new_status,details)
       VALUES($1,$2,'transferencia',$3,'aguardando_resposta',$4)`, [leadId, tenantId, lead.rows[0].status, { motivo: reason }]
    );
    const notification = await client.query<{ id: string }>(
      `INSERT INTO scheduling_transfer_notifications(lead_id,tenant_id,unit_id,reason,channel)
       VALUES($1,$2,$3,$4,$5) RETURNING id`, [leadId, tenantId, lead.rows[0].unit_id, reason, config.TRANSFER_NOTIFICATION_CHANNEL]
    );
    const tenant = await client.query<{ attendant_phone: string | null }>("SELECT attendant_phone FROM tenants WHERE id=$1", [tenantId]);
    return { lead: lead.rows[0], notificationId: notification.rows[0].id, recipient: tenant.rows[0]?.attendant_phone ?? null };
  });

  if (config.TRANSFER_NOTIFICATION_WEBHOOK_URL) {
    try {
      await sendTransferNotification(config.TRANSFER_NOTIFICATION_WEBHOOK_URL, { tenant: tenantId, lead_id: leadId, unidade_id: result.lead.unit_id, telefone: result.lead.phone, nome: result.lead.name, motivo: reason, destinatario: result.recipient }, config.TRANSFER_NOTIFICATION_TIMEOUT_MS, config.TRANSFER_NOTIFICATION_WEBHOOK_HMAC_SECRET);
      await db.query("UPDATE scheduling_transfer_notifications SET status='sent',sent_at=now() WHERE id=$1", [result.notificationId]);
    } catch (error) {
      await db.query("UPDATE scheduling_transfer_notifications SET status='failed',error=$2 WHERE id=$1", [result.notificationId, error instanceof Error ? error.message : String(error)]);
    }
  }
  return { id: leadId, status: "aguardando_resposta", notificacao_id: result.notificationId };
}

export async function removeAppointment(tenantId: string, appointmentId: string) {
  await withTransaction(async (client) => {
    const appointment = await client.query(
      "SELECT id FROM scheduling_appointments WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
      [appointmentId, tenantId]
    );
    if (!appointment.rows[0]) throw httpError(404, "Agendamento não encontrado");
    await client.query(
      "DELETE FROM scheduling_appointments WHERE id=$1 AND tenant_id=$2",
      [appointmentId, tenantId]
    );
  });
  return { id: appointmentId };
}

export async function deleteLead(tenantId: string, leadId: string, actor: FollowUpActor) {
  await withTransaction(async (client) => {
    const lead = await client.query("SELECT id FROM scheduling_leads WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [leadId, tenantId]);
    if (!lead.rows[0]) throw httpError(404, "Lead não encontrado");
    await insertFollowUpAudit(client, tenantId, leadId, actor, "scheduling_lead.delete", {});
    await client.query(
      `UPDATE usage_logs SET conversation_id=NULL
       WHERE tenant_id=$1 AND conversation_id IN (SELECT id FROM conversations WHERE tenant_id=$1 AND lead_id=$2)`,
      [tenantId, leadId]
    );
    await client.query("DELETE FROM scheduling_appointments WHERE tenant_id=$1 AND lead_id=$2", [tenantId, leadId]);
    await client.query("DELETE FROM conversations WHERE tenant_id=$1 AND lead_id=$2", [tenantId, leadId]);
    await client.query("DELETE FROM scheduling_leads WHERE tenant_id=$1 AND id=$2", [tenantId, leadId]);
  });
  return { id: leadId };
}

export async function updateLeadIdentity(
  tenantId: string,
  leadId: string,
  input: z.infer<typeof leadIdentityBody>
) {
  try {
    const updated = await withTransaction(async (client) => {
      const observed = await client.query<{ phone: string }>(
        "SELECT phone FROM scheduling_leads WHERE tenant_id=$1 AND id=$2",
        [tenantId, leadId]
      );
      if (!observed.rows[0]) throw httpError(404, "Lead não encontrado");

      const previousPhone = observed.rows[0].phone;
      const previousPhoneKey = previousPhone.replace(/\D/g, "");
      // Conversation lookup and Evolution inbound messages use the canonical
      // digits-only address. Persisting a formatted value here would make the
      // next webhook create a second conversation instead of matching this one.
      const nextPhoneKey = input.telefone ?? previousPhoneKey;
      const nextPhone = input.telefone === undefined ? previousPhone : nextPhoneKey;

      for (const phoneKey of [...new Set([previousPhoneKey, nextPhoneKey])].sort()) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`lead:${tenantId}:${phoneKey}`]);
      }

      const current = await client.query<{ phone: string; name: string | null }>(
        "SELECT phone,name FROM scheduling_leads WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [tenantId, leadId]
      );
      if (!current.rows[0]) throw httpError(404, "Lead não encontrado");
      if (current.rows[0].phone !== previousPhone) {
        throw httpError(409, "O telefone do lead foi alterado por outra operação; atualize a página e tente novamente");
      }
      const nextName = Object.prototype.hasOwnProperty.call(input, "nome") ? input.nome ?? null : current.rows[0].name;

      const duplicateLead = await client.query<{ id: string }>(
        `SELECT id FROM scheduling_leads
         WHERE tenant_id=$1 AND id<>$2
           AND regexp_replace(phone,'\\D','','g')=$3
         LIMIT 1`,
        [tenantId, leadId, nextPhoneKey]
      );
      if (duplicateLead.rows[0]) throw httpError(409, "Já existe outro lead com este telefone");

      const linkedConversation = await client.query<{ id: string; contact_jid: string | null }>(
        `SELECT id,contact_jid FROM conversations
         WHERE tenant_id=$1
           AND regexp_replace(contact_phone,'\\D','','g')=$2
         ORDER BY last_message_at DESC,id
         LIMIT 1
         FOR UPDATE`,
        [tenantId, previousPhoneKey]
      );
      if (linkedConversation.rows[0] && nextPhoneKey !== previousPhoneKey) {
        const duplicateConversation = await client.query<{ id: string }>(
          `SELECT id FROM conversations
           WHERE tenant_id=$1 AND id<>$2
             AND regexp_replace(contact_phone,'\\D','','g')=$3
           LIMIT 1`,
          [tenantId, linkedConversation.rows[0].id, nextPhoneKey]
        );
        if (duplicateConversation.rows[0]) throw httpError(409, "Já existe outro contato com este telefone");
      }

      const updated = await client.query(
        `UPDATE scheduling_leads
         SET phone=$3,name=$4,updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING *`,
        [tenantId, leadId, nextPhone, nextName]
      );

      if (linkedConversation.rows[0]) {
        const currentJid = linkedConversation.rows[0].contact_jid;
        const nextJid = currentJid && currentJid.endsWith("@s.whatsapp.net")
          && currentJid.split("@", 1)[0]?.split(":", 1)[0] === previousPhoneKey
          ? `${nextPhoneKey}@s.whatsapp.net`
          : currentJid;
        await client.query(
          `UPDATE conversations
           SET contact_phone=$3,contact_name=$4,contact_jid=$5
           WHERE tenant_id=$1 AND id=$2`,
          [tenantId, linkedConversation.rows[0].id, nextPhone, nextName, nextJid]
        );
      }

      await client.query(
        `UPDATE scheduling_meeting_contact_delivery_outbox outbox
         SET contact_phone=$3,
             contact_jid=CASE
               WHEN outbox.contact_jid LIKE '%@s.whatsapp.net' THEN $4
               ELSE outbox.contact_jid
             END,
             updated_at=now()
         FROM scheduling_appointments appointment
         WHERE appointment.id=outbox.appointment_id
           AND appointment.tenant_id=$1 AND appointment.lead_id=$2
           AND outbox.status='pending'`,
        [tenantId, leadId, nextPhone, `${nextPhoneKey}@s.whatsapp.net`]
      );
      await client.query(
        `INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,details)
         VALUES($1,$2,'identidade_atualizada',$3)`,
        [leadId, tenantId, {
          nome_anterior: current.rows[0].name,
          nome_novo: nextName,
          telefone_anterior: previousPhone,
          telefone_novo: nextPhone
        }]
      );
      return updated.rows[0];
    });
    await synchronizeLeadAppointmentNotifications(tenantId, leadId);
    return updated;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      throw httpError(409, "Já existe outro lead ou contato com este telefone");
    }
    throw error;
  }
}

export async function upsertLead(
  tenantId: string,
  body: z.infer<typeof leadBody>,
  options: {
    facebookAttribution?: Record<string, unknown>;
    preferredAssignedMemberId?: string;
    actor?: FollowUpActor;
    expectedExistingLeadId?: string | null;
    expectedAssignedMemberId?: string;
  } = {}
) {
  return withTransaction(async (client) => {
    const normalizedPhone = body.telefone;
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [`lead:${tenantId}:${normalizedPhone}`]
    );
    const previous = await client.query<{
      id: string;
      status: string;
      interest_category_id: string | null;
      unit_id: string | null;
      source: string;
      assigned_member_id: string | null;
    }>(
      `SELECT id,status,interest_category_id,unit_id,source,assigned_member_id
       FROM scheduling_leads
       WHERE tenant_id=$1
         AND regexp_replace(phone,'\\D','','g')=regexp_replace($2,'\\D','','g')
       ORDER BY created_at,id
       LIMIT 1
       FOR UPDATE`,
      [tenantId, body.telefone]
    );
    if (
      Object.prototype.hasOwnProperty.call(options, "expectedExistingLeadId")
      && (previous.rows[0]?.id ?? null) !== options.expectedExistingLeadId
    ) {
      throw httpError(409, "O lead foi criado ou alterado por outra operação; atualize a lista e tente novamente");
    }
    if (
      previous.rows[0]
      && options.expectedAssignedMemberId
      && previous.rows[0].assigned_member_id !== options.expectedAssignedMemberId
    ) {
      throw httpError(404, "Lead não encontrado");
    }
    if (!previous.rows[0] && !body.origem) {
      throw httpError(400, "origem é obrigatória ao criar um lead");
    }
    const categoryId = body.categoria_interesse_id ?? previous.rows[0]?.interest_category_id;
    const unitId = body.unidade_id ?? previous.rows[0]?.unit_id;
    const source = body.origem ?? previous.rows[0]?.source;
    const facebookAttribution = options.facebookAttribution ?? {};
    const row = previous.rows[0]
      ? await client.query(
          `UPDATE scheduling_leads
           SET name=CASE WHEN $8 THEN $3 ELSE name END,
               interest_category_id=CASE WHEN $9 THEN $4 ELSE interest_category_id END,
               unit_id=CASE WHEN $10 THEN $5 ELSE unit_id END,
               partner_id=CASE WHEN $11 THEN $6 ELSE partner_id END,
               source=CASE WHEN $12 THEN $7 ELSE source END,
               facebook_attribution=CASE WHEN $13::jsonb <> '{}'::jsonb THEN $13::jsonb ELSE facebook_attribution END,
               campaign=CASE WHEN $14 THEN $15 ELSE campaign END,
               updated_at=now()
           WHERE tenant_id=$1 AND id=$2
           RETURNING *`,
          [
            tenantId, previous.rows[0].id, body.nome, categoryId, unitId, body.parceiro_id, source,
            "nome" in body, "categoria_interesse_id" in body, "unidade_id" in body,
            "parceiro_id" in body, "origem" in body, facebookAttribution,
            "campanha" in body, body.campanha
          ]
        )
      : await client.query(
          `INSERT INTO scheduling_leads(
             tenant_id,phone,name,interest_category_id,unit_id,partner_id,source,campaign,facebook_attribution
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
           RETURNING *`,
          [tenantId, body.telefone, body.nome, categoryId, unitId, body.parceiro_id, source, body.campanha, facebookAttribution]
        );
    const assignment = await ensureCaseAssignment(client, {
      tenantId,
      selector: { leadId: row.rows[0].id as string },
      reason: "lead_criado",
      preferredMemberId: options.preferredAssignedMemberId
    });
    if (
      !previous.rows[0]
      && options.preferredAssignedMemberId
      && assignment?.memberId !== options.preferredAssignedMemberId
    ) {
      if (!options.actor) throw new Error("Actor obrigatório para atribuição manual do lead");
      await transferCaseAssignment(client, {
        tenantId,
        selector: { leadId: row.rows[0].id as string },
        targetMemberId: options.preferredAssignedMemberId,
        actor: options.actor,
        manager: true
      });
    }
    const assignedRow = await client.query(
      "SELECT * FROM scheduling_leads WHERE tenant_id=$1 AND id=$2",
      [tenantId, row.rows[0].id]
    );
    if (Object.prototype.hasOwnProperty.call(body, "nome")) {
      await client.query(
        `UPDATE conversations
         SET contact_name=$3
         WHERE tenant_id=$1
           AND regexp_replace(contact_phone,'\\D','','g')=regexp_replace($2,'\\D','','g')`,
        [tenantId, body.telefone, body.nome ?? null]
      );
    }
    await client.query(
      `INSERT INTO scheduling_lead_events(
         lead_id,tenant_id,event_type,previous_status,new_status,details,actor_user_id
       ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [row.rows[0].id, tenantId, previous.rows[0] ? "lead_atualizado" : "lead_criado", previous.rows[0]?.status ?? null, row.rows[0].status, {},options.actor?.userId ?? null]
    );
    return { row: assignedRow.rows[0], created: !previous.rows[0] };
  });
}

export async function qualifyLead(tenantId: string, leadId: string, input: z.infer<typeof qualifyLeadBody>) {
  return withTransaction(async (client) => {
    const current = await client.query<{ status: LeadStatus }>(
      "SELECT status FROM scheduling_leads WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
      [leadId, tenantId]
    );
    if (!current.rows[0]) throw httpError(404, "Lead não encontrado");
    // A qualificação enriquece o contexto comercial, mas não elimina nem
    // pausa oportunidades. Todo perfil qualificado segue apto ao agendamento.
    const nextStatus: LeadStatus = "qualificado";
    const requiresHumanDecision = false;
    const updated = await client.query(
      `UPDATE scheduling_leads
       SET qualification_stars=$3,
           qualification_answers=$4::jsonb,
           qualification_summary=$5,
           qualification_reason=$6,
           qualification_evaluated_at=now(),
           requires_human_decision=$7,
           status=$8,
           updated_at=now()
       WHERE id=$1 AND tenant_id=$2
         AND (qualification_stars IS DISTINCT FROM $3
           OR qualification_answers IS DISTINCT FROM $4::jsonb
           OR qualification_summary IS DISTINCT FROM $5
           OR qualification_reason IS DISTINCT FROM $6
           OR requires_human_decision IS DISTINCT FROM $7
           OR status IS DISTINCT FROM $8)
       RETURNING *`,
      [leadId, tenantId, input.estrelas, input.respostas, input.resumo, input.justificativa, requiresHumanDecision, nextStatus]
    );
    if (!updated.rows[0]) {
      const unchanged = await client.query("SELECT * FROM scheduling_leads WHERE id=$1 AND tenant_id=$2", [leadId, tenantId]);
      return { lead: leadMapper(unchanged.rows[0]), alterado: false, requer_decisao_humana: requiresHumanDecision };
    }
    await client.query(
      `INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,previous_status,new_status,details)
       VALUES($1,$2,'qualificacao_avaliada',$3,$4,$5)`,
      [leadId, tenantId, current.rows[0].status, nextStatus, {
        estrelas: input.estrelas,
        respostas: input.respostas,
        resumo: input.resumo,
        justificativa: input.justificativa,
        requer_decisao_humana: requiresHumanDecision
      }]
    );
    return { lead: leadMapper(updated.rows[0]), alterado: true, requer_decisao_humana: requiresHumanDecision };
  });
}

export async function createQualifiedMeetingAppointment(
  tenantId: string,
  input: z.infer<typeof appointmentBody>,
  options: Pick<AppointmentCreationOptions, "now" | "minimumLeadTimeMinutes"> = {}
) {
  const qualification = await db.query<{ qualification_stars: number | null }>(
    "SELECT qualification_stars FROM scheduling_leads WHERE id=$1 AND tenant_id=$2",
    [input.lead_id, tenantId]
  );
  if (!qualification.rows[0]) throw httpError(404, "Lead não encontrado");
  if (qualification.rows[0].qualification_stars === null) {
    throw httpError(409, "Registre a qualificação do lead antes de agendar a reunião");
  }
  return createAppointment(tenantId, input, { ...options, requireAvailableAttendant: true });
}

export async function findLeadByPhone(tenantId: string, phone: string) {
  const result = await db.query("SELECT * FROM scheduling_leads WHERE tenant_id=$1 AND phone=$2", [tenantId, phone]);
  return result.rows[0] ?? null;
}

export async function findLatestActiveAppointment(tenantId: string, leadId: string) {
  const result = await db.query(
    `SELECT * FROM scheduling_appointments WHERE tenant_id=$1 AND lead_id=$2 AND status IN ('confirmado','reagendado')
     ORDER BY start_at DESC LIMIT 1`, [tenantId, leadId]
  );
  return result.rows[0] ?? null;
}

export async function listCategorias(tenantId: string) {
  const result = await db.query("SELECT id,tenant_id,name,active FROM scheduling_categories WHERE tenant_id=$1 AND active ORDER BY name", [tenantId]);
  return result.rows.map((row) => ({ id: row.id, tenant: row.tenant_id, nome: row.name, ativa: row.active }));
}

export async function listParceiros(tenantId: string) {
  const result = await db.query("SELECT id,tenant_id,name,priority_order,proposal_link,active FROM scheduling_partners WHERE tenant_id=$1 AND active ORDER BY priority_order,name", [tenantId]);
  return result.rows.map((row) => ({ id: row.id, tenant: row.tenant_id, nome: row.name, ordem_prioridade: row.priority_order, link_proposta: row.proposal_link, ativo: row.active }));
}

export async function listUnidades(tenantId: string) {
  const result = await db.query("SELECT * FROM scheduling_units WHERE tenant_id=$1 ORDER BY name", [tenantId]);
  return result.rows.map(unitMapper);
}

export async function enviarPropostaParceiro(tenantId: string, leadId: string, parceiroId: string, expectedAssignedMemberId?: string) {
  const linkProposta = await withTransaction(async (client) => {
    const partner = await client.query<{ proposal_link: string }>("SELECT proposal_link FROM scheduling_partners WHERE tenant_id=$1 AND id=$2 AND active", [tenantId, parceiroId]);
    if (!partner.rows[0]) throw httpError(404, "Parceiro ativo não encontrado");
    const lead = await client.query<{ status: string; assigned_member_id: string | null }>("SELECT status,assigned_member_id FROM scheduling_leads WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [leadId, tenantId]);
    if (!lead.rows[0]) throw httpError(404, "Lead não encontrado");
    if (expectedAssignedMemberId && lead.rows[0].assigned_member_id !== expectedAssignedMemberId) throw httpError(404, "Lead não encontrado");
    const stage = await client.query<{ id: string }>(
      "SELECT id FROM pipeline_stages WHERE tenant_id=$1 AND technical_status='proposta_enviada' AND is_default AND archived_at IS NULL",
      [tenantId]
    );
    if (!stage.rows[0]) throw httpError(409,"Etapa padrão de proposta enviada não configurada");
    const nextActionAt = new Date(Date.now()+24*60*60*1000);
    await client.query(
      `UPDATE scheduling_leads SET partner_id=$3,status='proposta_enviada',pipeline_stage_id=$4,
         commercial_outcome='proposta_enviada',next_action='Acompanhar proposta',next_action_at=$5,
         commercial_updated_at=now(),updated_at=now()
       WHERE id=$1 AND tenant_id=$2`,
      [leadId,tenantId,parceiroId,stage.rows[0].id,nextActionAt]
    );
    await client.query(
      `INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,previous_status,new_status,details)
       VALUES($1,$2,'proposta_parceiro',$3,'proposta_enviada',$4)`, [leadId, tenantId, lead.rows[0].status, { parceiro_id: parceiroId,next_action_at: nextActionAt }]
    );
    return partner.rows[0].proposal_link;
  });
  return { lead_id: leadId, parceiro_id: parceiroId, link_proposta: linkProposta, status: "proposta_enviada" };
}

export async function verificarHorarios(
  tenantId: string,
  unidadeId: string,
  data: string,
  options?: {
    includeFullSlots?: boolean;
    excludeStartedSlots?: boolean;
    now?: Date;
    requestedTime?: string;
    assignedMemberId?: string;
    minimumLeadTimeMinutes?: number;
    excludeLeadId?: string;
    capacitySource?: "unit" | "available_attendants";
  }
) {
  const client = await db.connect();
  try {
    const unit = await loadUnit(client, tenantId, unidadeId);
    const opening = workspaceLocalDateTime(data, formatTime(unit.opening_time), unit.timezone);
    const closing = workspaceLocalDateTime(data, formatTime(unit.closing_time), unit.timezone);
    const now = options?.now ?? new Date();
    const earliestStart = now.getTime() + (options?.minimumLeadTimeMinutes ?? 0) * 60_000;
    if (!unit.operating_days.includes(localWeekday(opening, unit.timezone))) {
      return {
        data,
        unidade_id: unidadeId,
        timezone: unit.timezone,
        duration_min: unit.slot_duration_min,
        horarios: []
      };
    }
    const availableAttendantIds = options?.capacitySource === "available_attendants"
      ? (await listAvailableAppointmentAttendants(client, tenantId)).map((attendant) => attendant.memberId)
      : null;
    const capacityAttendantIds = availableAttendantIds === null
      ? null
      : options?.assignedMemberId
        ? availableAttendantIds.filter((memberId) => memberId === options.assignedMemberId)
        : availableAttendantIds;
    const occupancy = await client.query<{
      assigned_member_id: string | null;
      start_at: Date;
      end_at: Date;
    }>(
      `SELECT assigned_member_id,start_at,end_at FROM scheduling_appointments
       WHERE tenant_id=$1
         AND (
           ($7::uuid[] IS NOT NULL AND assigned_member_id=ANY($7::uuid[]))
           OR ($7::uuid[] IS NULL AND (($5::uuid IS NULL AND unit_id=$2) OR assigned_member_id=$5))
         )
         AND status IN ('confirmado','reagendado') AND start_at < $4 AND end_at > $3
         AND ($6::uuid IS NULL OR lead_id IS DISTINCT FROM $6)`,
      [
        tenantId,
        unidadeId,
        opening.toISOString(),
        closing.toISOString(),
        options?.assignedMemberId ?? null,
        options?.excludeLeadId ?? null,
        capacityAttendantIds
      ]
    );
    const blockMemberIds = capacityAttendantIds
      ?? (options?.assignedMemberId ? [options.assignedMemberId] : []);
    if (blockMemberIds.length) {
      const blocks = await client.query<{
        assigned_member_id: string;
        start_at: Date;
        end_at: Date;
      }>(
        `SELECT member_id assigned_member_id,start_at,end_at
         FROM scheduling_attendant_time_blocks
         WHERE tenant_id=$1 AND member_id=ANY($2::uuid[])
           AND start_at<$4 AND end_at>$3`,
        [tenantId, blockMemberIds, opening, closing]
      );
      occupancy.rows.push(...blocks.rows);
      const recurring = await client.query<RecurringTimeBlockRow>(`SELECT * FROM scheduling_attendant_recurring_time_blocks WHERE tenant_id=$1 AND member_id=ANY($2::uuid[]) AND active=true`, [tenantId, blockMemberIds]);
      for (const row of recurring.rows) for (const occurrence of recurringOccurrences(row, opening, closing)) occupancy.rows.push({ assigned_member_id: row.member_id, start_at: new Date(String(occurrence.start)), end_at: new Date(String(occurrence.end)) });
    }
    const effectiveCapacity = capacityAttendantIds !== null
      ? capacityAttendantIds.length
      : options?.assignedMemberId ? 1 : unit.simultaneous_capacity;
    const requestedStart = options?.requestedTime
      ? workspaceLocalDateTime(data, time.parse(options.requestedTime), unit.timezone)
      : undefined;
    const slotAt = (start: Date) => {
      const end = new Date(start.getTime() + unit.slot_duration_min * 60_000);
      const insideOperation = start >= opening && end <= closing;
      const future = !options?.excludeStartedSlots || start.getTime() > earliestStart;
      const occupied = insideOperation
        ? capacityAttendantIds !== null
          ? busyAppointmentAttendants(occupancy.rows, start, end)
          : peakConcurrentAppointments(occupancy.rows, start, end)
        : effectiveCapacity;
      const occupiedAtStart = insideOperation
        ? capacityAttendantIds !== null
          ? busyAppointmentAttendants(occupancy.rows, start, new Date(start.getTime() + 1))
          : occupancy.rows.filter((appointment) => {
              const appointmentStart = new Date(appointment.start_at).getTime();
              const appointmentEnd = new Date(appointment.end_at).getTime();
              return appointmentStart <= start.getTime() && appointmentEnd > start.getTime();
            }).length
        : effectiveCapacity;
      return {
        start: start.toISOString(),
        end: end.toISOString(),
        vagas: Math.max(0, effectiveCapacity - occupied),
        capacidade: effectiveCapacity,
        ocupados_no_inicio: occupiedAtStart,
        available: insideOperation && future && occupied < effectiveCapacity
      };
    };
    if (requestedStart) {
      const requested = slotAt(requestedStart);
      const candidateTimes = new Set<number>();
      const durationMs = unit.slot_duration_min * 60_000;
      for (let start = opening; start.getTime() + durationMs <= closing.getTime(); start = new Date(start.getTime() + durationMs)) {
        candidateTimes.add(start.getTime());
      }
      for (let start = requestedStart.getTime() - durationMs; start >= opening.getTime(); start -= durationMs) {
        candidateTimes.add(start);
      }
      for (let start = requestedStart.getTime() + durationMs; start + durationMs <= closing.getTime(); start += durationMs) {
        candidateTimes.add(start);
      }
      const nearest = [...candidateTimes]
        .filter((candidate) => candidate !== requestedStart.getTime())
        .map((candidate) => slotAt(new Date(candidate)))
        .filter((candidate) => candidate.available)
        .sort((left, right) =>
          Math.abs(new Date(left.start).getTime() - requestedStart.getTime())
          - Math.abs(new Date(right.start).getTime() - requestedStart.getTime())
          || left.start.localeCompare(right.start)
        )
        .slice(0, 3)
        .map((candidate) => ({
          start: candidate.start,
          end: candidate.end,
          vagas: candidate.vagas,
          capacidade: candidate.capacidade
        }));
      const requestedSlot = {
        start: requested.start,
        end: requested.end,
        vagas: requested.vagas,
        capacidade: requested.capacidade
      };
      return {
        data,
        unidade_id: unidadeId,
        timezone: unit.timezone,
        duration_min: unit.slot_duration_min,
        horarios: requested.available ? [requestedSlot] : [],
        horario_solicitado: { ...requestedSlot, disponivel: requested.available },
        horarios_proximos: nearest
      };
    }
    const candidateStarts = new Set<number>();
    const durationMs = unit.slot_duration_min * 60_000;
    for (let start = opening; start.getTime() + durationMs <= closing.getTime(); start = new Date(start.getTime() + durationMs)) {
      candidateStarts.add(start.getTime());
    }
    // O painel precisa mostrar o início real de encaixes fora da grade regular.
    // Sem isso, uma reunião às 11h em uma unidade cuja grade começa às 08h30
    // aparece apenas como conflito nos horários vizinhos.
    if (options?.includeFullSlots) {
      for (const appointment of occupancy.rows) {
        const appointmentStart = new Date(appointment.start_at).getTime();
        if (appointmentStart >= opening.getTime() && appointmentStart + durationMs <= closing.getTime()) {
          candidateStarts.add(appointmentStart);
        }
      }
    }
    const slots = [];
    for (const startTime of [...candidateStarts].sort((left, right) => left - right)) {
      const start = new Date(startTime);
      if (options?.excludeStartedSlots && start.getTime() <= earliestStart) continue;
      const slot = slotAt(start);
      if (!slot.available && !options?.includeFullSlots) continue;
      if (slot.vagas >= 0) {
        slots.push({
          start: slot.start,
          end: slot.end,
          vagas: slot.vagas,
          capacidade: slot.capacidade,
          ...(options?.includeFullSlots ? { ocupados_no_inicio: slot.ocupados_no_inicio } : {})
        });
      }
    }
    return {
      data,
      unidade_id: unidadeId,
      timezone: unit.timezone,
      duration_min: unit.slot_duration_min,
      horarios: slots
    };
  } finally { client.release(); }
}

export type RecurringTimeBlockInput = {
  start_local_time: string; end_local_time: string; weekdays: number[]; starts_on: string; ends_on?: string | null; timezone: string; reason: string; active?: boolean;
};
export const recurringTimeBlockBody = z.object({
  start_local_time: time, end_local_time: time, weekdays: z.array(z.number().int().min(1).max(7)).min(1),
  starts_on: date, ends_on: date.nullable().optional(), timezone: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(1).max(500), active: z.boolean().optional()
}).strict().superRefine((v, c) => {
  if (v.end_local_time <= v.start_local_time) c.addIssue({ code: z.ZodIssueCode.custom, path: ["end_local_time"], message: "O término deve ser posterior ao início" });
  if (new Set(v.weekdays).size !== v.weekdays.length) c.addIssue({ code: z.ZodIssueCode.custom, path: ["weekdays"], message: "Dias duplicados" });
  if (v.ends_on && v.ends_on < v.starts_on) c.addIssue({ code: z.ZodIssueCode.custom, path: ["ends_on"], message: "Data final inválida" });
});
export const recurringTimeBlockPatch = z.object({ start_local_time: time.optional(), end_local_time: time.optional(), weekdays: z.array(z.number().int().min(1).max(7)).min(1).optional(), starts_on: date.optional(), ends_on: date.nullable().optional(), timezone: z.string().trim().min(1).max(100).optional(), reason: z.string().trim().min(1).max(500).optional(), active: z.boolean().optional() }).strict().superRefine((v,c) => { if (v.start_local_time && v.end_local_time && v.end_local_time <= v.start_local_time) c.addIssue({code:z.ZodIssueCode.custom,path:["end_local_time"],message:"O término deve ser posterior ao início"}); if (v.weekdays && new Set(v.weekdays).size !== v.weekdays.length) c.addIssue({code:z.ZodIssueCode.custom,path:["weekdays"],message:"Dias duplicados"}); if (v.ends_on && v.starts_on && v.ends_on < v.starts_on) c.addIssue({code:z.ZodIssueCode.custom,path:["ends_on"],message:"Data final inválida"}); });
type RecurringTimeBlockRow = RecurringTimeBlockInput & { id: string; tenant_id: string; member_id: string; active: boolean; created_at: Date; updated_at: Date };
function mapRecurring(row: RecurringTimeBlockRow) { return { id: row.id, member_id: row.member_id, start_local_time: row.start_local_time, end_local_time: row.end_local_time, weekdays: row.weekdays, starts_on: row.starts_on, ends_on: row.ends_on, timezone: row.timezone, reason: row.reason, active: row.active, created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString() }; }
export function recurringOccurrences(row: RecurringTimeBlockRow, start: Date, end: Date) {
  const out: Array<Record<string, unknown>> = [];
  for (let cursor = new Date(start); cursor < end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const key = localDateKey(cursor, row.timezone); const weekday = ((localWeekday(cursor, row.timezone) + 6) % 7) + 1;
    if (!row.active || key < row.starts_on || (row.ends_on && key > row.ends_on) || !row.weekdays.includes(weekday)) continue;
    const s = localDateTimeToUtc(key, row.start_local_time, row.timezone); const e = localDateTimeToUtc(key, row.end_local_time, row.timezone);
    if (s < end && e > start) out.push({ ...mapRecurring(row), start: s.toISOString(), end: e.toISOString(), origin: "recorrente", rule_id: row.id });
  } return out;
}
export async function listOwnRecurringAttendantTimeBlocks(tenantId: string, userId: string, interval: { start: Date; end: Date }) {
  const r = await db.query<RecurringTimeBlockRow>(`SELECT block.* FROM scheduling_attendant_recurring_time_blocks block JOIN workspace_members m ON m.id=block.member_id AND m.workspace_id=block.tenant_id AND m.user_id=$2 WHERE block.tenant_id=$1 AND block.starts_on <= ($4 AT TIME ZONE block.timezone)::date AND (block.ends_on IS NULL OR block.ends_on >= ($3 AT TIME ZONE block.timezone)::date) ORDER BY block.starts_on,block.id`, [tenantId,userId,interval.start,interval.end]);
  return r.rows.flatMap(row => recurringOccurrences(row, interval.start, interval.end));
}
export async function createOwnRecurringAttendantTimeBlock(tenantId: string, userId: string, input: z.infer<typeof recurringTimeBlockBody>, actor: FollowUpActor) {
  const r = await db.query<RecurringTimeBlockRow>(`INSERT INTO scheduling_attendant_recurring_time_blocks(tenant_id,member_id,start_local_time,end_local_time,weekdays,starts_on,ends_on,timezone,reason,active,created_by_user_id) SELECT $1,m.id,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,true),$11 FROM workspace_members m WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.status='active' RETURNING *`, [tenantId,userId,input.start_local_time,input.end_local_time,input.weekdays,input.starts_on,input.ends_on??null,input.timezone,input.reason,input.active??true,actor.userId]);
  if (!r.rows[0]) throw httpError(403, "Atendente ativo não encontrado"); return mapRecurring(r.rows[0]);
}
export async function updateOwnRecurringAttendantTimeBlock(tenantId: string,userId: string,id:string,input:z.infer<typeof recurringTimeBlockPatch>) { const keys=Object.keys(input); if(!keys.length) throw httpError(400,"Nenhum campo"); const vals=keys.map(k=>input[k as keyof typeof input]); const sets=keys.map((k,i)=>`${k}=$${i+3}`).join(","); const r=await db.query<RecurringTimeBlockRow>(`UPDATE scheduling_attendant_recurring_time_blocks b SET ${sets},updated_at=now() FROM workspace_members m WHERE b.id=$1 AND b.tenant_id=$2 AND m.id=b.member_id AND m.workspace_id=b.tenant_id AND m.user_id=$${keys.length+3} RETURNING b.*`,[id,tenantId,...vals,userId]); if(!r.rows[0]) throw httpError(404,"Bloqueio recorrente não encontrado"); return mapRecurring(r.rows[0]); }
export async function deleteOwnRecurringAttendantTimeBlock(tenantId:string,userId:string,id:string){const r=await db.query<RecurringTimeBlockRow>(`DELETE FROM scheduling_attendant_recurring_time_blocks b USING workspace_members m WHERE b.id=$1 AND b.tenant_id=$2 AND m.id=b.member_id AND m.workspace_id=b.tenant_id AND m.user_id=$3 RETURNING b.*`,[id,tenantId,userId]);if(!r.rows[0])throw httpError(404,"Bloqueio recorrente não encontrado");return mapRecurring(r.rows[0]);}

export type SchedulingPeriod = "manha" | "tarde";

export interface AvailabilitySearch {
  agenda_id: string;
  timezone: string;
  duration_min: number;
  data: string;
  data_solicitada: string;
  periodo_solicitado?: SchedulingPeriod;
  periodo_atendido: boolean;
  horarios: Array<{
    hora: string;
    start: string;
    end: string;
    /** Quantidade de closers que ainda podem receber uma reunião neste horário. */
    vagas: number;
    /** Quantidade total de closers disponíveis considerada para este horário. */
    capacidade: number;
  }>;
}

export function localHourMinute(value: Date, timezone: string): string {
  const parts = zonedParts(value, timezone);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

// Precisa coincidir com a faixa aceita pela política de saída em
// schedulingPeriodOfferCorrection: um slot das 18h30 é noite, não tarde, e
// oferecê-lo como "tarde" seria recusado na validação da resposta.
function matchesPeriod(start: Date, timezone: string, periodo: SchedulingPeriod): boolean {
  const hour = zonedParts(start, timezone).hour;
  return periodo === "manha" ? hour < 12 : hour >= 12 && hour < 18;
}

function nextDateKey(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Fonte única de verdade da oferta de horários: o modelo nunca calcula data,
 * fuso, período nem "próximo dia com vaga". Quando a data pedida não tem vaga
 * no período desejado, a busca avança pelos dias seguintes; se nenhum dia do
 * intervalo tiver o período, devolve a primeira disponibilidade real existente
 * marcada com periodo_atendido=false, para que o atendimento nunca fique sem
 * opção concreta a oferecer.
 */
export async function buscarDisponibilidade(
  tenantId: string,
  unidadeId: string,
  dataSolicitada: string,
  options: {
    periodo?: SchedulingPeriod;
    now?: Date;
    minimumLeadTimeMinutes?: number;
    searchDays?: number;
    maxSlots?: number;
    assignedMemberId?: string;
  } = {}
): Promise<AvailabilitySearch> {
  const searchDays = Math.max(1, options.searchDays ?? 7);
  const maxSlots = Math.max(1, options.maxSlots ?? 3);
  let fallback: AvailabilitySearch | undefined;
  let lastEmpty: AvailabilitySearch | undefined;

  for (let offset = 0; offset < searchDays; offset += 1) {
    const data = nextDateKey(dataSolicitada, offset);
    const availability = await verificarHorarios(tenantId, unidadeId, data, {
      excludeStartedSlots: true,
      now: options.now,
      minimumLeadTimeMinutes: options.minimumLeadTimeMinutes,
      assignedMemberId: options.assignedMemberId,
      capacitySource: "available_attendants"
    });
    const timezone = availability.timezone;
    const all = availability.horarios.map((slot) => ({
      hora: localHourMinute(new Date(slot.start), timezone),
      start: slot.start,
      end: slot.end,
      vagas: slot.vagas,
      capacidade: slot.capacidade
    }));
    const base = {
      agenda_id: unidadeId,
      timezone,
      duration_min: availability.duration_min,
      data,
      data_solicitada: dataSolicitada,
      ...(options.periodo ? { periodo_solicitado: options.periodo } : {})
    };
    if (!all.length) {
      lastEmpty ??= { ...base, periodo_atendido: false, horarios: [] };
      continue;
    }
    const inPeriod = options.periodo
      ? all.filter((slot) => matchesPeriod(new Date(slot.start), timezone, options.periodo!))
      : all;
    if (inPeriod.length) {
      return { ...base, periodo_atendido: true, horarios: inPeriod.slice(0, maxSlots) };
    }
    fallback ??= { ...base, periodo_atendido: false, horarios: all.slice(0, maxSlots) };
  }
  if (fallback ?? lastEmpty) return (fallback ?? lastEmpty)!;
  throw httpError(500, "Não foi possível consultar a disponibilidade da agenda");
}

export async function atualizarStatusLead(
  tenantId: string,
  leadId: string,
  status: LeadStatus,
  actor?: JourneyActor,
  expectedAssignedMemberId?: string
) {
  return withTransaction(async (client) => {
    const lead = await client.query<Record<string, unknown> & { status: LeadStatus }>(
      "SELECT * FROM scheduling_leads WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
      [leadId, tenantId]
    );
    if (!lead.rows[0]) throw httpError(404, "Lead não encontrado");
    if (expectedAssignedMemberId && lead.rows[0].assigned_member_id !== expectedAssignedMemberId) throw httpError(404, "Lead não encontrado");
    const currentStatus = lead.rows[0].status;
    if (currentStatus === status) return lead.rows[0];
    if (stageRequiresCommercialPayload(status)) {
      throw httpError(400,"Esta etapa exige os dados comerciais do fluxo estruturado");
    }
    if (!allowedLeadStatusTransitions(currentStatus).includes(status)) {
      throw httpError(409, `Transição de status não permitida: ${currentStatus} -> ${status}`);
    }
    const row = await client.query("UPDATE scheduling_leads SET status=$3,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND ($4::uuid IS NULL OR assigned_member_id=$4) RETURNING *", [leadId, tenantId, status, expectedAssignedMemberId ?? null]);
    await client.query(
      `INSERT INTO scheduling_lead_events(
         lead_id,tenant_id,event_type,previous_status,new_status,actor_user_id
       ) VALUES($1,$2,'status_atualizado',$3,$4,$5)`,
      [leadId, tenantId, currentStatus, status, actor?.userId ?? null]
    );
    return row.rows[0];
  });
}

/**
 * Records a disqualifying lead signal with the commercial fields required by
 * the canonical journey schema. This is intentionally separate from the
 * generic status tool: status=perdido must carry an explicit loss reason.
 */
export async function markLeadDisqualified(
  tenantId: string,
  leadId: string,
  reason = "nao_qualificado",
  note?: string | null
) {
  return withTransaction(async (client) => {
    const current = await client.query<Record<string, unknown> & {
      id: string;
      status: LeadStatus;
      commercial_outcome: string | null;
      loss_reason: string | null;
      loss_reason_note: string | null;
    }>(
      "SELECT * FROM scheduling_leads WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
      [leadId, tenantId]
    );
    if (!current.rows[0]) throw httpError(404, "Lead não encontrado");
    const resolved = await resolveLossReason(client, tenantId, reason, note);
    if (current.rows[0].status === "perdido"
      && current.rows[0].commercial_outcome === "nao_avancou"
      && current.rows[0].loss_reason === resolved.key
      && current.rows[0].loss_reason_note === resolved.note) return current.rows[0];
    const updated = await client.query(
      "UPDATE scheduling_leads " +
      "SET status='perdido',commercial_outcome='nao_avancou',sale_value=NULL,loss_reason=$3," +
      "loss_reason_note=$4," +
      "recovery_required=false,recovery_member_id=NULL,next_action=NULL,next_action_at=NULL," +
      "commercial_updated_at=now(),updated_at=now() " +
      "WHERE id=$1 AND tenant_id=$2 RETURNING *",
      [leadId, tenantId, resolved.key, resolved.note]
    );
    await client.query(
      "INSERT INTO scheduling_lead_events(" +
      "lead_id,tenant_id,event_type,previous_status,new_status,details) " +
      "VALUES($1,$2,'lead_desqualificado',$3,'perdido',$4)",
      [leadId, tenantId, current.rows[0].status, { reason: "tripz_boleto_payment", loss_reason: resolved.key, loss_reason_note: resolved.note }]
    );
    return updated.rows[0];
  });
}
