import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { requirePermission, requireWorkspace, type WorkspaceSession } from "../../auth/session.js";
import type { PermissionKey } from "../../auth/rbac.js";
import {
  appointmentScopeCondition,
  conversationScopeCondition,
  hasWorkspaceCaseAccess,
  leadScopeCondition,
  resolveCaseScope,
  type CaseScope
} from "../../auth/case-scope.js";
import { db } from "../../db/client.js";
import {
  addLeadNote, allowedLeadStatusTransitions, appointmentBody, appointmentMapper, appointmentObservationBody, appointmentStatus, atendonMeetSettingsBody, attendantAvailabilityBody, attendantCalendarColorBody, attendantPoolBody, attendantTimeBlockBody, atualizarStatusLead, cancelAppointment, categoryBody, completeAppointment, connectGoogleMeetOAuth, createAppointment, createOwnAttendantTimeBlock, deleteLead, deleteOwnAttendantTimeBlock,
  date, enviarPropostaParceiro, googleMeetSettingsBody, httpError, instant, leadBody, leadFollowUpBody, leadIdentityBody, leadMapper, leadNoteBody, leadStatus, listCategorias, listParceiros,
  disconnectGoogleMeetOAuth, listOwnAttendantTimeBlocks, loadAtendonMeetSettings, loadAttendantPool, loadGoogleMeetSettings, loadLeadFollowUp, loadWorkspaceTimeZone, markAppointmentNoShow, openAppointmentConversation, panelAppointmentBody, panelLeadMapper, panelRescheduleBody, partnerBody, qualificationMapper, rescheduleAppointment, rescheduleBody, slug, transferLead, unitBody, unitMapper,
  updateAppointmentObservation, updateAtendonMeetSettings, updateAttendantAvailability, updateAttendantCalendarColor, updateAttendantPool, updateGoogleMeetSettings, updateLeadFollowUp, updateLeadIdentity, upsertLead, verificarHorarios, workspaceLocalDateTime,
  listAppointmentAssignees, reassignAppointmentAssignee, removeAppointment, joinAppointment, recurringTimeBlockBody, recurringTimeBlockPatch, listOwnRecurringAttendantTimeBlocks, createOwnRecurringAttendantTimeBlock, updateOwnRecurringAttendantTimeBlock, deleteOwnRecurringAttendantTimeBlock
} from "./service.js";
import { createGoogleMeetOAuthClient, createGoogleMeetOAuthState, verifyGoogleMeetOAuthState } from "./google-meet.js";
import { normalizeText } from "../qualification/normalizer.js";
import { EvolutionClient } from "../whatsapp/evolution-client.js";
import { qualifyLeadFromConversation } from "./contextual-qualification.js";
import { HTTP_RATE_LIMITS } from "../../security/http-rate-limit.js";
import { panelPresence } from "../realtime/presence.js";
import { cancellationSchema, concludeAppointmentSchema, noShowSchema } from "../commercial-journey/schemas.js";
import { isCapabilityEnabled } from "../operations/feature-flags.js";

const idParams = z.object({ id: z.string().uuid() });
const memberParams = z.object({ memberId: z.string().uuid() });
const unitParams = z.object({ unidade_id: slug });
const apiTenantQuery = z.object({ tenant: z.string().uuid().optional() });
const transferBody = z.object({ motivo: z.string().trim().min(1).max(2_000) });
const schedulingNotificationSettingsBody = z.object({
  enabled: z.boolean(),
  groupJid: z.string().trim().min(1).max(100).nullable(),
  groupName: z.string().trim().max(200).nullable().optional(),
  // Conexão de WhatsApp que enviará as notificações. Ausente = a primária,
  // que preserva o comportamento de quem tem um único número.
  sessionId: z.string().uuid().nullable().optional()
});
const schedulingNotificationGroupsQuery = z.object({
  session_id: z.string().uuid().nullable().optional()
});
const schedulingBoundary = z.union([date, instant]);
const appointmentAssigneeBody = z.object({ assigned_member_id: z.string().uuid().nullable() }).strict();
const attendantTimeBlockQuery = z.object({ start: instant, end: instant }).refine(
  (value) => new Date(value.end).getTime() > new Date(value.start).getTime(),
  { message: "O término deve ser posterior ao início", path: ["end"] }
);

function resolveSchedulingBoundary(value: string, timezone: string) {
  return date.safeParse(value).success ? workspaceLocalDateTime(value, "00:00", timezone).toISOString() : value;
}

function assertTenantQuery(query: unknown, tenantId: string) {
  const { tenant } = apiTenantQuery.parse(query);
  if (tenant && tenant !== tenantId) throw httpError(403, "Tenant não corresponde à API key");
}

async function panelTenant(request: FastifyRequest, permission: PermissionKey) { return (await requirePermission(request, permission)).tenantId; }

async function panelCaseScope(request: FastifyRequest, permission: PermissionKey) {
  const session = await requirePermission(request, permission);
  return { session, scope: await resolveCaseScope(db, session) };
}

async function canAccessLead(session: WorkspaceSession, scope: CaseScope, leadId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM scheduling_leads lead
     WHERE lead.tenant_id=$1 AND lead.id=$2
       AND (${leadScopeCondition(scope, "lead", "$3")})`,
    [session.tenantId, leadId, scope.memberId]
  );
  return Boolean(result.rows[0]);
}

async function canReadLead(session: WorkspaceSession, scope: CaseScope, leadId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM scheduling_leads lead WHERE lead.tenant_id=$1 AND lead.id=$2
       AND (${leadReadScopeCondition(scope,"lead","$3")})`,
    [session.tenantId,leadId,scope.memberId]
  );
  return Boolean(result.rows[0]);
}

function leadReadScopeCondition(scope: CaseScope, alias: string, memberParameter: string): string {
  if (scope.type === "workspace") return `(${memberParameter}::uuid IS NULL OR ${memberParameter}::uuid IS NOT NULL)`;
  if (!scope.memberId) return "FALSE";
  return `(${alias}.assigned_member_id=${memberParameter} OR ${alias}.sdr_member_id=${memberParameter} OR ${alias}.closer_member_id=${memberParameter} OR ${alias}.recovery_member_id=${memberParameter})`;
}

async function canAccessAppointment(session: WorkspaceSession, scope: CaseScope, appointmentId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM scheduling_appointments appointment
     WHERE appointment.tenant_id=$1 AND appointment.id=$2
       AND (${appointmentScopeCondition(scope, "appointment", "$3")})`,
    [session.tenantId, appointmentId, scope.memberId]
  );
  return Boolean(result.rows[0]);
}

function sessionHasPermission(session: WorkspaceSession, permission: PermissionKey) {
  return Boolean(session.isRoot && session.rootWorkspaceAccess) || session.permissions.includes(permission);
}

function followUpActor(request: FastifyRequest, session: WorkspaceSession) {
  return {
    userId: session.userId,
    actorScope: session.actorScope,
    workspaceCaseAccess: hasWorkspaceCaseAccess(session),
    ipAddress: request.ip,
    userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined
  };
}

export async function registerSchedulingRoutes(app: FastifyInstance) {
  app.post("/leads", { config: { rateLimit: HTTP_RATE_LIMITS.publicApiWrite } }, async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "leads.create");
    if (scope.type === "mine" && !scope.memberId) throw httpError(403, "Membro ativo obrigatório para criar um lead");
    const body = leadBody.parse(request.body);
    const existing = await db.query<{ id: string }>(`SELECT id FROM scheduling_leads WHERE tenant_id=$1 AND regexp_replace(phone,'\\D','','g')=regexp_replace($2,'\\D','','g') ORDER BY created_at,id LIMIT 1`, [session.tenantId, body.telefone]);
    if (existing.rows[0] && !await canAccessLead(session, scope, existing.rows[0].id)) return reply.status(404).send({ error: "Lead não encontrado" });
    const result = await upsertLead(session.tenantId, body, { preferredAssignedMemberId: scope.type === "mine" ? scope.memberId ?? undefined : undefined, actor: followUpActor(request, session), expectedExistingLeadId: existing.rows[0]?.id ?? null, expectedAssignedMemberId: scope.type === "mine" ? scope.memberId ?? undefined : undefined });
    return reply.status(result.created ? 201 : 200).send({ lead: leadMapper(result.row) });
  });

  app.get("/categorias", { config: { rateLimit: HTTP_RATE_LIMITS.publicApiRead } }, async (request) => {
    const { session } = await panelCaseScope(request, "categories.read"); assertTenantQuery(request.query, session.tenantId);
    return { categorias: await listCategorias(session.tenantId) };
  });

  app.get("/parceiros", { config: { rateLimit: HTTP_RATE_LIMITS.publicApiRead } }, async (request) => {
    const { session } = await panelCaseScope(request, "partners.read"); assertTenantQuery(request.query, session.tenantId);
    return { parceiros: await listParceiros(session.tenantId) };
  });

  app.post("/leads/:id/proposta-parceiro", { config: { rateLimit: HTTP_RATE_LIMITS.publicApiWrite } }, async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "leads.send_partner_proposal"); const { id } = idParams.parse(request.params);
    if (!await canAccessLead(session, scope, id)) return reply.status(404).send({ error: "Lead não encontrado" });
    const body = z.object({ parceiro_id: slug }).parse(request.body);
    return reply.send(await enviarPropostaParceiro(session.tenantId, id, body.parceiro_id, scope.type === "mine" ? scope.memberId ?? undefined : undefined));
  });

  app.get("/unidades/:unidade_id/horarios", { config: { rateLimit: HTTP_RATE_LIMITS.publicApiRead } }, async (request) => {
    const { session } = await panelCaseScope(request, "availability.read"); const { unidade_id } = unitParams.parse(request.params);
    const query = apiTenantQuery.extend({ data: date }).parse(request.query); assertTenantQuery(query, session.tenantId);
    return verificarHorarios(session.tenantId, unidade_id, query.data);
  });

  app.post("/agendamentos", { config: { rateLimit: HTTP_RATE_LIMITS.publicApiWrite } }, async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "appointments.create");
    const body = appointmentBody.parse(request.body);
    const hasExplicitAssignee = Object.prototype.hasOwnProperty.call(body, "assigned_member_id");
    if (hasExplicitAssignee && !hasWorkspaceCaseAccess(session)) {
      throw httpError(403, "Somente gestores podem escolher o closer da reunião");
    }
    if (!await canAccessLead(session, scope, body.lead_id)) return reply.status(404).send({ error: "Lead não encontrado" });
    const agendamento = await createAppointment(session.tenantId, body, {
      manual: true,
      allowCapacityOverride: true,
      requireAvailableAttendant: true,
      expectedAssignedMemberId: scope.type === "mine" ? scope.memberId ?? undefined : undefined,
      allowExplicitAssignee: hasWorkspaceCaseAccess(session),
      actor: followUpActor(request, session)
    });
    return reply.status(201).send({ agendamento });
  });
  app.patch("/agendamentos/:id/reagendar", { config: { rateLimit: HTTP_RATE_LIMITS.publicApiWrite } }, async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "appointments.reschedule"); const { id } = idParams.parse(request.params);
    if (!await canAccessAppointment(session, scope, id)) return reply.status(404).send({ error: "Agendamento não encontrado" });
    return { agendamento: await rescheduleAppointment(session.tenantId, id, rescheduleBody.parse(request.body), {
      manual: true,
      allowCapacityOverride: true,
      expectedAssignedMemberId: scope.type === "mine" ? scope.memberId ?? undefined : undefined,
      actor: followUpActor(request, session)
    }) };
  });
  app.delete("/agendamentos/:id", { config: { rateLimit: HTTP_RATE_LIMITS.publicApiWrite } }, async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "appointments.cancel"); const { id } = idParams.parse(request.params);
    if (!await canAccessAppointment(session, scope, id)) return reply.status(404).send({ error: "Agendamento não encontrado" });
    return { agendamento: await cancelAppointment(session.tenantId, id, undefined, followUpActor(request, session), scope.type === "mine" ? scope.memberId ?? undefined : undefined) };
  });
  app.patch("/leads/:id/status", { config: { rateLimit: HTTP_RATE_LIMITS.publicApiWrite } }, async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "leads.update_status"); const { id } = idParams.parse(request.params);
    if (!await canAccessLead(session, scope, id)) return reply.status(404).send({ error: "Lead não encontrado" });
    const body = z.object({ status: leadStatus }).parse(request.body);
    return { lead: leadMapper(await atualizarStatusLead(session.tenantId, id, body.status, undefined, scope.type === "mine" ? scope.memberId ?? undefined : undefined)) };
  });
  app.post("/leads/:id/transferir", { config: { rateLimit: HTTP_RATE_LIMITS.publicApiWrite } }, async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "leads.transfer"); const { id } = idParams.parse(request.params);
    if (!await canAccessLead(session, scope, id)) return reply.status(404).send({ error: "Lead não encontrado" });
    return { lead: await transferLead(session.tenantId, id, transferBody.parse(request.body).motivo, scope.type === "mine" ? scope.memberId ?? undefined : undefined) };
  });

  app.get("/scheduling/leads", async (request) => {
    const { session, scope } = await panelCaseScope(request, "leads.read");
    const tenantId = session.tenantId;
    const canReadFollowUp = sessionHasPermission(session, "leads.follow_up.read");
    const query = z.object({
      status: leadStatus.optional(), unidade_id: slug.optional(), categoria_id: slug.optional(), parceiro_id: slug.optional(), busca: z.string().trim().max(200).optional(),
      estrelas: z.coerce.number().int().min(1).max(5).optional(),
      pipeline_stage_id: z.string().uuid().optional(),
      sdr_member_id: z.string().uuid().optional(),
      closer_member_id: z.string().uuid().optional(),
      origem: z.string().trim().max(200).optional(),
      campanha: z.string().trim().max(200).optional(),
      period_start: date.optional(),
      period_end: date.optional(),
      appointment_status: appointmentStatus.optional(),
      commercial_outcome: z.enum(["fechado","proposta_enviada","em_negociacao","follow_up","nao_avancou"]).optional(),
      action_bucket: z.enum(["result_pending","recovery","overdue_follow_up","today"]).optional(),
      fila_humana: z.enum(["true"]).optional(),
      faturamento: z.string().trim().min(1).max(200).optional(), resultado: z.string().trim().min(1).max(200).optional(),
      investimento: z.string().trim().min(1).max(200).optional(), formulario: z.string().trim().min(1).max(200).optional()
    }).parse(request.query);
    const appointmentsEnabled = await isCapabilityEnabled(db, tenantId, "appointments_v1");
    if (!appointmentsEnabled && (query.appointment_status || query.action_bucket === "result_pending"
      || query.action_bucket === "recovery" || query.action_bucket === "today")) {
      throw Object.assign(new Error("Funcionalidade indisponível para esta empresa"), {
        statusCode: 409,
        code: "FEATURE_FLAG_DISABLED",
        feature: "appointments_v1"
      });
    }
    const params: unknown[] = [tenantId, scope.memberId];
    const conditions = [
      "l.tenant_id=$1",
      `(${leadReadScopeCondition(scope, "l", "$2")})`
    ];
    for (const [field, value, column] of [
      ["status",query.status,"l.status"],["unidade",query.unidade_id,"l.unit_id"],["categoria",query.categoria_id,"l.interest_category_id"],["parceiro",query.parceiro_id,"l.partner_id"],
      ["estrelas",query.estrelas,"l.qualification_stars"],["pipeline_stage",query.pipeline_stage_id,"l.pipeline_stage_id"],
      ["sdr",query.sdr_member_id,"l.sdr_member_id"],["closer",query.closer_member_id,"l.closer_member_id"],
      ["origem",query.origem,"l.source"],["campanha",query.campanha,"l.campaign"],
      ["appointment_status",query.appointment_status,"latest_appointment.status"],
      ["commercial_outcome",query.commercial_outcome,"l.commercial_outcome"],
      ["faturamento",query.faturamento,"q.faturamento"],["resultado",query.resultado,"q.resultado_final"],
      ["investimento",query.investimento && (normalizeText(query.investimento) === "nao" ? "NÃO" : "SIM"),"q.investimento"],["formulario",query.formulario,"q.status"]
    ] as const) {
      void field; if (value) { params.push(value); conditions.push(`${column}=$${params.length}`); }
    }
    if (query.fila_humana) conditions.push("l.requires_human_decision=true");
    if (query.action_bucket==="result_pending") conditions.push("latest_appointment.result_pending_at IS NOT NULL");
    if (query.action_bucket==="recovery") conditions.push("l.recovery_required=true");
    if (query.action_bucket==="overdue_follow_up") conditions.push("l.next_action_at<now()");
    if (query.action_bucket==="today") conditions.push("(latest_appointment.start_at AT TIME ZONE tenant.timezone)::date=(now() AT TIME ZONE tenant.timezone)::date");
    if (query.period_start) { params.push(query.period_start); conditions.push(`l.created_at >= ($${params.length}::date::timestamp AT TIME ZONE tenant.timezone)`); }
    if (query.period_end) { params.push(query.period_end); conditions.push(`l.created_at < (($${params.length}::date + 1)::timestamp AT TIME ZONE tenant.timezone)`); }
    if (query.busca) { params.push(`%${query.busca}%`); conditions.push(`(l.phone ILIKE $${params.length} OR l.name ILIKE $${params.length})`); }
    const result = await db.query(
      `SELECT l.*,c.name category_name,u.name unit_name,p.name partner_name,
              avatar.contact_avatar_url avatar_url,
              assigned_user.email assigned_user_email,pool.availability_status assigned_availability_status,
              sdr_user.email sdr_user_email,closer_user.email closer_user_email,
              recovery_user.email recovery_user_email,
              latest_appointment.id latest_appointment_id,
              latest_appointment.status latest_appointment_status,
              latest_appointment.start_at latest_appointment_start,
              latest_appointment.end_at latest_appointment_end,
              latest_appointment.result_pending_at latest_appointment_result_pending_at,
              ai_follow_up.progress ai_follow_up,
              jsonb_build_object(
                'id',stage.id,'name',stage.name,'color',stage.color,'position',stage.position,
                'capacity_target',stage.capacity_target,'technical_status',stage.technical_status,
                'is_default',stage.is_default
              ) pipeline_stage,
              COALESCE(tags.items,'[]'::jsonb) tags
       FROM scheduling_leads l
       JOIN tenants tenant ON tenant.id=l.tenant_id
       LEFT JOIN scheduling_categories c ON c.tenant_id=l.tenant_id AND c.id=l.interest_category_id
       LEFT JOIN scheduling_units u ON u.tenant_id=l.tenant_id AND u.id=l.unit_id
       LEFT JOIN scheduling_partners p ON p.tenant_id=l.tenant_id AND p.id=l.partner_id
       LEFT JOIN workspace_members assigned_member ON assigned_member.id=l.assigned_member_id AND assigned_member.workspace_id=l.tenant_id
       LEFT JOIN users assigned_user ON assigned_user.id=assigned_member.user_id
       LEFT JOIN scheduling_google_meet_closers pool
         ON pool.tenant_id=l.tenant_id AND pool.member_id=l.assigned_member_id
       LEFT JOIN workspace_members sdr_member ON sdr_member.id=l.sdr_member_id AND sdr_member.workspace_id=l.tenant_id
       LEFT JOIN users sdr_user ON sdr_user.id=sdr_member.user_id
       LEFT JOIN workspace_members closer_member ON closer_member.id=l.closer_member_id AND closer_member.workspace_id=l.tenant_id
       LEFT JOIN users closer_user ON closer_user.id=closer_member.user_id
       LEFT JOIN workspace_members recovery_member ON recovery_member.id=l.recovery_member_id AND recovery_member.workspace_id=l.tenant_id
       LEFT JOIN users recovery_user ON recovery_user.id=recovery_member.user_id
       JOIN pipeline_stages stage ON stage.tenant_id=l.tenant_id AND stage.id=l.pipeline_stage_id
       LEFT JOIN LATERAL (
         SELECT appointment.id,appointment.status,appointment.start_at,appointment.end_at,appointment.result_pending_at
         FROM scheduling_appointments appointment
         WHERE appointment.tenant_id=l.tenant_id AND appointment.lead_id=l.id
         ORDER BY appointment.start_at DESC,appointment.id DESC
         LIMIT 1
       ) latest_appointment ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_build_object(
           'count',schedule.follow_up_count,
           'status',schedule.status,
           'next_run_at',schedule.next_run_at,
           'cancellation_reason',schedule.cancellation_reason
         ) progress
         FROM conversations conversation
         JOIN ai_follow_up_schedules schedule
           ON schedule.tenant_id=conversation.tenant_id
          AND schedule.conversation_id=conversation.id
         WHERE conversation.tenant_id=l.tenant_id
           AND regexp_replace(conversation.contact_phone,'\\D','','g')=regexp_replace(l.phone,'\\D','','g')
         ORDER BY conversation.last_message_at DESC,conversation.id DESC
         LIMIT 1
       ) ai_follow_up ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'id',tag.id,'name',tag.name,'color',tag.color,'archived',tag.archived_at IS NOT NULL
         ) ORDER BY lower(tag.name),tag.id) items
         FROM lead_tag_assignments assignment
         JOIN lead_tags tag ON tag.tenant_id=assignment.tenant_id AND tag.id=assignment.tag_id
         WHERE assignment.tenant_id=l.tenant_id AND assignment.lead_id=l.id
       ) tags ON true
       LEFT JOIN LATERAL (
         SELECT conversation.contact_avatar_url
         FROM conversations conversation
         WHERE conversation.tenant_id=l.tenant_id
           AND regexp_replace(conversation.contact_phone,'\\D','','g')=regexp_replace(l.phone,'\\D','','g')
         ORDER BY conversation.contact_avatar_updated_at DESC NULLS LAST
         LIMIT 1
       ) avatar ON true
       LEFT JOIN lead_qualifications q ON q.tenant_id=l.tenant_id AND q.lead_id=l.id
       WHERE ${conditions.join(" AND ")} ORDER BY l.updated_at DESC LIMIT 500`, params
    );
    const baseMapper = canReadFollowUp ? panelLeadMapper : leadMapper;
    return {
      leads: result.rows.map((row) => {
        const mapped = { ...baseMapper(row), qualificacao: qualificationMapper(row) };
        if (!appointmentsEnabled) delete (mapped as { latest_appointment?: unknown }).latest_appointment;
        return mapped;
      }),
      ...(canReadFollowUp ? { timezone: await loadWorkspaceTimeZone(tenantId) } : {})
    };
  });
  app.post("/scheduling/leads", async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "leads.create");
    if (scope.type === "mine" && !scope.memberId) {
      throw httpError(403, "Membro ativo obrigatório para criar um lead");
    }
    const body = leadBody.parse(request.body);
    const existing = await db.query<{ id: string }>(
      `SELECT id
       FROM scheduling_leads
       WHERE tenant_id=$1
         AND regexp_replace(phone,'\\D','','g')=regexp_replace($2,'\\D','','g')
       ORDER BY created_at,id
       LIMIT 1`,
      [session.tenantId, body.telefone]
    );
    if (existing.rows[0] && !await canAccessLead(session, scope, existing.rows[0].id)) {
      return reply.status(404).send({ error: "Lead não encontrado" });
    }
    const result = await upsertLead(session.tenantId, body, {
      preferredAssignedMemberId: scope.type === "mine" ? scope.memberId ?? undefined : undefined,
      actor: followUpActor(request, session),
      expectedExistingLeadId: existing.rows[0]?.id ?? null,
      expectedAssignedMemberId: scope.type === "mine" ? scope.memberId ?? undefined : undefined
    });
    return reply.status(result.created ? 201 : 200).send({ lead: leadMapper(result.row) });
  });
  app.get("/scheduling/leads/:id", async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "leads.read");
    const tenantId = session.tenantId; const { id } = idParams.parse(request.params);
    const canReadFollowUp = sessionHasPermission(session, "leads.follow_up.read");
    const lead = await db.query(
      `SELECT l.*,c.name category_name,u.name unit_name,p.name partner_name,
              avatar.contact_avatar_url avatar_url,
              assigned_user.email assigned_user_email,pool.availability_status assigned_availability_status,
              sdr_user.email sdr_user_email,closer_user.email closer_user_email,
              recovery_user.email recovery_user_email,
              jsonb_build_object(
                'id',stage.id,'name',stage.name,'color',stage.color,'position',stage.position,
                'capacity_target',stage.capacity_target,'technical_status',stage.technical_status,
                'is_default',stage.is_default
              ) pipeline_stage,
              COALESCE(tags.items,'[]'::jsonb) tags
       FROM scheduling_leads l
       LEFT JOIN scheduling_categories c ON c.tenant_id=l.tenant_id AND c.id=l.interest_category_id
       LEFT JOIN scheduling_units u ON u.tenant_id=l.tenant_id AND u.id=l.unit_id
       LEFT JOIN scheduling_partners p ON p.tenant_id=l.tenant_id AND p.id=l.partner_id
       LEFT JOIN workspace_members assigned_member ON assigned_member.id=l.assigned_member_id AND assigned_member.workspace_id=l.tenant_id
       LEFT JOIN users assigned_user ON assigned_user.id=assigned_member.user_id
       LEFT JOIN scheduling_google_meet_closers pool
         ON pool.tenant_id=l.tenant_id AND pool.member_id=l.assigned_member_id
       LEFT JOIN workspace_members sdr_member ON sdr_member.id=l.sdr_member_id AND sdr_member.workspace_id=l.tenant_id
       LEFT JOIN users sdr_user ON sdr_user.id=sdr_member.user_id
       LEFT JOIN workspace_members closer_member ON closer_member.id=l.closer_member_id AND closer_member.workspace_id=l.tenant_id
       LEFT JOIN users closer_user ON closer_user.id=closer_member.user_id
       LEFT JOIN workspace_members recovery_member ON recovery_member.id=l.recovery_member_id AND recovery_member.workspace_id=l.tenant_id
       LEFT JOIN users recovery_user ON recovery_user.id=recovery_member.user_id
       JOIN pipeline_stages stage ON stage.tenant_id=l.tenant_id AND stage.id=l.pipeline_stage_id
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'id',tag.id,'name',tag.name,'color',tag.color,'archived',tag.archived_at IS NOT NULL
         ) ORDER BY lower(tag.name),tag.id) items
         FROM lead_tag_assignments assignment
         JOIN lead_tags tag ON tag.tenant_id=assignment.tenant_id AND tag.id=assignment.tag_id
         WHERE assignment.tenant_id=l.tenant_id AND assignment.lead_id=l.id
       ) tags ON true
       LEFT JOIN LATERAL (
         SELECT conversation.contact_avatar_url
         FROM conversations conversation
         WHERE conversation.tenant_id=l.tenant_id
           AND regexp_replace(conversation.contact_phone,'\\D','','g')=regexp_replace(l.phone,'\\D','','g')
         ORDER BY conversation.contact_avatar_updated_at DESC NULLS LAST
         LIMIT 1
       ) avatar ON true
       WHERE l.id=$1 AND l.tenant_id=$2
         AND (${leadReadScopeCondition(scope, "l", "$3")})`, [id, tenantId, scope.memberId]
    );
    if (!lead.rows[0]) return reply.status(404).send({ error: "Lead não encontrado" });
    const appointmentsEnabled = await isCapabilityEnabled(db, tenantId, "appointments_v1");
    const [events, appointments] = await Promise.all([
      db.query(
        `SELECT id,event_type,previous_status,new_status,details,actor_user_id,created_at
         FROM scheduling_lead_events
         WHERE lead_id=$1 AND tenant_id=$2
           AND ($3::boolean OR event_type NOT IN ('acompanhamento_atualizado','nota_interna_adicionada'))
           AND ($4::boolean OR event_type NOT LIKE 'agendamento_%')
         ORDER BY created_at`,
        [id, tenantId, canReadFollowUp, appointmentsEnabled]
      ),
      appointmentsEnabled ? db.query(
        `SELECT a.*,assigned_member.user_id assigned_user_id,assigned_user.email assigned_user_email,
                pool.availability_status assigned_availability_status,
                pool.calendar_color assigned_calendar_color
         FROM scheduling_appointments a
         LEFT JOIN workspace_members assigned_member
           ON assigned_member.id=a.assigned_member_id AND assigned_member.workspace_id=a.tenant_id
         LEFT JOIN users assigned_user ON assigned_user.id=assigned_member.user_id
         LEFT JOIN scheduling_google_meet_closers pool
           ON pool.tenant_id=a.tenant_id AND pool.member_id=a.assigned_member_id
         WHERE a.lead_id=$1 AND a.tenant_id=$2
         ORDER BY a.start_at DESC`,
        [id, tenantId]
      ) : Promise.resolve({ rows: [] })
    ]);
    const mappedLead = (canReadFollowUp ? panelLeadMapper : leadMapper)(lead.rows[0]);
    if (!appointmentsEnabled) delete (mappedLead as { latest_appointment?: unknown }).latest_appointment;
    return {
      lead: mappedLead,
      qualificacao: qualificationMapper(lead.rows[0]),
      eventos: events.rows,
      ...(appointmentsEnabled ? { agendamentos: appointments.rows.map(appointmentMapper) } : {}),
      status_permitidos: scope.type === "workspace" || lead.rows[0].assigned_member_id === scope.memberId
        ? allowedLeadStatusTransitions(leadStatus.parse(mappedLead.status)) : [],
      timezone: await loadWorkspaceTimeZone(tenantId)
    };
  });
  app.get("/scheduling/leads/:id/follow-up", async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "leads.follow_up.read");
    const { id } = idParams.parse(request.params);
    if (!await canReadLead(session, scope, id)) return reply.status(404).send({ error: "Lead não encontrado" });
    return loadLeadFollowUp(session.tenantId, id);
  });
  app.patch("/scheduling/leads/:id/follow-up", async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "leads.follow_up.manage");
    const { id } = idParams.parse(request.params);
    if (!await canAccessLead(session, scope, id)) return reply.status(404).send({ error: "Lead não encontrado" });
    return updateLeadFollowUp(session.tenantId, id, leadFollowUpBody.parse(request.body), followUpActor(request, session));
  });
  app.post("/scheduling/leads/:id/notes", async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "leads.follow_up.manage");
    const { id } = idParams.parse(request.params);
    if (!await canAccessLead(session, scope, id)) return reply.status(404).send({ error: "Lead não encontrado" });
    const body = leadNoteBody.parse(request.body);
    return reply.status(201).send(await addLeadNote(session.tenantId, id, body.nota, followUpActor(request, session)));
  });
  app.patch("/scheduling/leads/:id/status", async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "leads.update_status");
    const tenantId = session.tenantId; const { id } = idParams.parse(request.params);
    if (!await canAccessLead(session, scope, id)) return reply.status(404).send({ error: "Lead não encontrado" });
    const body = z.object({ status: leadStatus }).parse(request.body);
    const lead = leadMapper(await atualizarStatusLead(
      tenantId,
      id,
      body.status,
      followUpActor(request, session),
      scope.type === "mine" ? scope.memberId ?? undefined : undefined
    ));
    return { lead, status_permitidos: allowedLeadStatusTransitions(leadStatus.parse(lead.status)) };
  });
  app.patch("/scheduling/leads/:id/identity", async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "leads.update_status");
    const { id } = idParams.parse(request.params);
    if (!await canAccessLead(session, scope, id)) return reply.status(404).send({ error: "Lead não encontrado" });
    return { lead: leadMapper(await updateLeadIdentity(session.tenantId, id, leadIdentityBody.parse(request.body))) };
  });
  app.post("/scheduling/leads/:id/qualify-context", async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "leads.update_status");
    const tenantId = session.tenantId;
    const { id } = idParams.parse(request.params);
    if (!await canAccessLead(session, scope, id)) return reply.status(404).send({ error: "Lead não encontrado" });
    return qualifyLeadFromConversation(tenantId, id);
  });
  app.post("/scheduling/leads/:id/transferir", async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "leads.transfer");
    const tenantId = session.tenantId; const { id } = idParams.parse(request.params);
    if (!await canAccessLead(session, scope, id)) return reply.status(404).send({ error: "Lead não encontrado" });
    return { lead: await transferLead(tenantId, id, transferBody.parse(request.body).motivo, scope.type === "mine" ? scope.memberId ?? undefined : undefined) };
  });
  app.delete("/scheduling/leads/:id", async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "leads.delete");
    const tenantId = session.tenantId; const { id } = idParams.parse(request.params);
    if (!await canAccessLead(session, scope, id)) return reply.status(404).send({ error: "Lead não encontrado" });
    return await deleteLead(tenantId, id, followUpActor(request, session));
  });
  app.get("/scheduling/appointments", async (request) => {
    const { session, scope } = await panelCaseScope(request, "appointments.read");
    const tenantId = session.tenantId;
    const query = z.object({ unidade_id: slug, inicio: schedulingBoundary, fim: schedulingBoundary }).parse(request.query);
    const timezone = await loadWorkspaceTimeZone(tenantId);
    const inicio = resolveSchedulingBoundary(query.inicio, timezone);
    const fim = resolveSchedulingBoundary(query.fim, timezone);
    const rangeMs = new Date(fim).getTime() - new Date(inicio).getTime();
    if (rangeMs <= 0) throw httpError(400, "fim deve ser posterior a inicio");
    if (rangeMs > 32 * 24 * 60 * 60 * 1_000) {
      throw httpError(400, "O período da agenda não pode exceder 32 dias");
    }
    const result = await db.query(
      `SELECT a.*,l.name lead_name,l.phone lead_phone,u.name unit_name,
              assigned_member.user_id assigned_user_id,assigned_user.email assigned_user_email,
              pool.availability_status assigned_availability_status,
              pool.calendar_color assigned_calendar_color,
              conv.id conversation_id
       FROM scheduling_appointments a
       JOIN scheduling_leads l ON l.id=a.lead_id AND l.tenant_id=a.tenant_id
       JOIN scheduling_units u ON u.id=a.unit_id AND u.tenant_id=a.tenant_id
       LEFT JOIN workspace_members assigned_member
         ON assigned_member.id=a.assigned_member_id AND assigned_member.workspace_id=a.tenant_id
       LEFT JOIN users assigned_user ON assigned_user.id=assigned_member.user_id
       LEFT JOIN scheduling_google_meet_closers pool
         ON pool.tenant_id=a.tenant_id AND pool.member_id=a.assigned_member_id
       LEFT JOIN LATERAL (
         SELECT conversation.id
         FROM conversations conversation
         WHERE conversation.tenant_id=a.tenant_id
           AND regexp_replace(conversation.contact_phone,'\\D','','g')=regexp_replace(l.phone,'\\D','','g')
         ORDER BY conversation.last_message_at DESC,conversation.id
         LIMIT 1
       ) conv ON true
       WHERE a.tenant_id=$1 AND a.unit_id=$2
         AND a.start_at < $4 AND a.end_at > $3
         AND (${appointmentScopeCondition(scope, "a", "$5")})
       ORDER BY a.start_at`,
      [tenantId, query.unidade_id, inicio, fim, scope.memberId]
    );
    return { agendamentos: result.rows.map(appointmentMapper), timezone };
  });
  app.get("/scheduling/appointment-leads", async (request) => {
    const { session, scope } = await panelCaseScope(request, "appointments.create");
    const tenantId = session.tenantId;
    const query = z.object({
      busca: z.string().trim().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(20)
    }).parse(request.query);
    const normalizedSearch = query.busca?.replace(/\D/g,"") ?? "";
    const result = await db.query(
      `SELECT l.* FROM scheduling_leads l
       WHERE l.tenant_id=$1 AND l.status NOT IN ('fechado','perdido')
         AND (${leadScopeCondition(scope, "l", "$2")})
         AND ($3::text IS NULL OR l.name ILIKE '%' || $3 || '%'
           OR l.phone ILIKE '%' || $3 || '%'
           OR ($4::text<>'' AND regexp_replace(l.phone,'\\D','','g') LIKE '%' || $4 || '%'))
       ORDER BY l.updated_at DESC,l.id LIMIT $5`,
      [tenantId,scope.memberId,query.busca ?? null,normalizedSearch,query.limit]
    );
    return { leads: result.rows.map(leadMapper) };
  });
  app.get("/scheduling/conversations/:id/appointment-context", async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "appointments.create");
    const tenantId = session.tenantId;
    const { id } = idParams.parse(request.params);
    const result = await db.query<{
      conversation_id: string;
      contact_name: string | null;
      contact_phone: string;
      lead_id: string | null;
      lead_name: string | null;
      lead_phone: string | null;
      lead_status: string | null;
      lead_unit_id: string | null;
      appointment_id: string | null;
      appointment_unit_id: string | null;
      appointment_start: Date | null;
      appointment_end: Date | null;
      appointment_status: string | null;
      appointment_assigned_member_id: string | null;
      appointment_assigned_user_id: string | null;
      appointment_assigned_name: string | null;
      appointment_assigned_email: string | null;
    }>(
      `SELECT c.id conversation_id,c.contact_name,c.contact_phone,
              lead.id lead_id,lead.name lead_name,lead.phone lead_phone,
              lead.status lead_status,lead.unit_id lead_unit_id,
              active.id appointment_id,active.unit_id appointment_unit_id,
              active.start_at appointment_start,active.end_at appointment_end,
              active.status appointment_status,
              active.assigned_member_id appointment_assigned_member_id,
              assigned_member.user_id appointment_assigned_user_id,
              assigned_user.name appointment_assigned_name,
              assigned_user.email appointment_assigned_email
       FROM conversations c
       LEFT JOIN LATERAL (
         SELECT l.id,l.name,l.phone,l.status,l.unit_id
         FROM scheduling_leads l
         WHERE l.tenant_id=c.tenant_id
           AND regexp_replace(l.phone,'\\D','','g')=regexp_replace(c.contact_phone,'\\D','','g')
         ORDER BY l.updated_at DESC,l.id
         LIMIT 1
       ) lead ON true
       LEFT JOIN LATERAL (
         SELECT a.id,a.unit_id,a.start_at,a.end_at,a.status,a.assigned_member_id
         FROM scheduling_appointments a
         WHERE a.tenant_id=c.tenant_id AND a.lead_id=lead.id
           AND a.status IN ('confirmado','reagendado')
         ORDER BY a.start_at
         LIMIT 1
       ) active ON true
       LEFT JOIN workspace_members assigned_member
         ON assigned_member.id=active.assigned_member_id AND assigned_member.workspace_id=c.tenant_id
       LEFT JOIN users assigned_user ON assigned_user.id=assigned_member.user_id
       WHERE c.id=$1 AND c.tenant_id=$2
         AND (${conversationScopeCondition(scope, "c", "$3")})`,
      [id, tenantId, scope.userId]
    );
    const row = result.rows[0];
    if (!row) return reply.status(404).send({ error: "Conversa não encontrada" });
    return {
      contact: {
        id: row.conversation_id,
        nome: row.contact_name,
        telefone: row.contact_phone
      },
      lead: row.lead_id ? {
        id: row.lead_id,
        nome: row.lead_name,
        telefone: row.lead_phone,
        status: row.lead_status,
        unidade_id: row.lead_unit_id
      } : null,
      agendamento_ativo: row.appointment_id ? {
        id: row.appointment_id,
        unidade_id: row.appointment_unit_id,
        start: row.appointment_start,
        end: row.appointment_end,
        status: row.appointment_status,
        assigned_member_id: row.appointment_assigned_member_id,
        assigned_user_id: row.appointment_assigned_user_id,
        assigned_name: row.appointment_assigned_name,
        assigned_email: row.appointment_assigned_email
      } : null,
      can_select_assignee: hasWorkspaceCaseAccess(session),
      timezone: await loadWorkspaceTimeZone(tenantId)
    };
  });
  app.get("/scheduling/appointment-assignees", async (request) => {
    const session = await requirePermission(request, "appointments.create");
    const query = z.object({
      start: instant,
      end: instant,
      exclude_appointment_id: z.string().uuid().optional()
    }).parse(request.query);
    const start = new Date(query.start);
    const end = new Date(query.end);
    if (end <= start) throw httpError(400, "end deve ser posterior a start");
    const assignees = await listAppointmentAssignees(
      session.tenantId,
      { start, end },
      query.exclude_appointment_id
    );
    const online = await panelPresence.onlineUsers(session.tenantId, assignees.map((assignee) => assignee.user_id));
    return {
      assignees: assignees.map((assignee) => ({ ...assignee, online: online.has(assignee.user_id) })),
      can_select_assignee: hasWorkspaceCaseAccess(session),
      suggested_member_id: assignees.find((assignee) => assignee.suggested)?.member_id ?? null
    };
  });
  app.post("/scheduling/appointments", async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "appointments.create");
    const body = panelAppointmentBody.parse(request.body);
    const hasExplicitAssignee = Object.prototype.hasOwnProperty.call(body, "assigned_member_id");
    if (hasExplicitAssignee && !hasWorkspaceCaseAccess(session)) {
      throw httpError(403, "Somente gestores podem escolher o closer da reunião");
    }
    if (!await canAccessLead(session, scope, body.lead_id)) {
      return reply.status(404).send({ error: "Lead não encontrado" });
    }
    const agendamento = await createAppointment(session.tenantId, body, {
      manual: true,
      allowCapacityOverride: true,
      requireAvailableAttendant: true,
      expectedAssignedMemberId: scope.type === "mine" ? scope.memberId ?? undefined : undefined,
      allowExplicitAssignee: hasWorkspaceCaseAccess(session),
      actor: followUpActor(request,session)
    });
    return reply.status(201).send({ agendamento });
  });
  app.patch("/scheduling/appointments/:id/assignee", async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "appointments.reschedule");
    if (!hasWorkspaceCaseAccess(session)) throw httpError(403, "Somente gestores podem reatribuir reuniões");
    const { id } = idParams.parse(request.params);
    if (!await canAccessAppointment(session, scope, id)) return reply.status(404).send({ error: "Agendamento não encontrado" });
    const body = appointmentAssigneeBody.parse(request.body);
    return {
      agendamento: await reassignAppointmentAssignee(
        session.tenantId,
        id,
        body.assigned_member_id,
        followUpActor(request, session)
      )
    };
  });
  app.get("/scheduling/config/notifications", async (request) => {
    const tenantId = await panelTenant(request, "scheduling_notifications.read");
    const result = await db.query<{ enabled: boolean; session_id: string | null; group_jid: string | null; group_name: string | null }>(
      "SELECT enabled,session_id,group_jid,group_name FROM scheduling_notification_settings WHERE tenant_id=$1",
      [tenantId]
    );
    return { notifications: result.rows[0] ?? { enabled: false, session_id: null, group_jid: null, group_name: null } };
  });
  app.get("/scheduling/config/notification-groups", async (request, reply) => {
    const tenantId = await panelTenant(request, "scheduling_notifications.read");
    const query = schedulingNotificationGroupsQuery.parse(request.query ?? {});
    // Com múltiplos números, a escolha passa a ser explícita: a conexão pedida
    // (validada como do próprio tenant) ou a primária.
    const session = await db.query<{ instance_name: string | null }>(
      `SELECT instance_name FROM whatsapp_sessions
       WHERE tenant_id=$1 AND archived_at IS NULL AND ($2::uuid IS NULL OR id=$2)
       ORDER BY is_primary DESC, created_at DESC LIMIT 1`,
      [tenantId, query.session_id ?? null]
    );
    const instanceName = session.rows[0]?.instance_name;
    if (!instanceName) return reply.status(404).send({ error: "Nenhuma conexão de WhatsApp encontrada" });
    const groups = await new EvolutionClient(config).fetchGroups(instanceName);
    return { groups };
  });
  app.put("/scheduling/config/notifications", async (request) => {
    const tenantId = await panelTenant(request, "scheduling_notifications.manage");
    const body = schedulingNotificationSettingsBody.parse(request.body);
    const session = await db.query<{ id: string }>(
      `SELECT id FROM whatsapp_sessions
       WHERE tenant_id=$1 AND archived_at IS NULL AND ($2::uuid IS NULL OR id=$2)
       ORDER BY is_primary DESC, created_at DESC LIMIT 1`,
      [tenantId, body.sessionId ?? null]
    );
    const sessionId = session.rows[0]?.id ?? null;
    if (body.enabled && (!sessionId || !body.groupJid)) {
      throw httpError(400, "Conecte o WhatsApp e selecione um grupo para ativar as notificações");
    }
    await db.query(
      `INSERT INTO scheduling_notification_settings(tenant_id,enabled,session_id,group_jid,group_name)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(tenant_id) DO UPDATE SET enabled=$2,session_id=$3,group_jid=$4,group_name=$5,updated_at=now()`,
      [tenantId, body.enabled, sessionId, body.groupJid, body.groupName ?? null]
    );
    return { notifications: { enabled: body.enabled, session_id: sessionId, group_jid: body.groupJid, group_name: body.groupName ?? null } };
  });
  app.get("/scheduling/availability", async (request) => {
    const session = await requirePermission(request, "availability.read");
    const query = z.object({
      unidade_id: slug,
      data: date,
      assigned_member_id: z.string().uuid().optional()
    }).parse(request.query);
    if (query.assigned_member_id && !hasWorkspaceCaseAccess(session)) {
      throw httpError(403, "Somente gestores podem consultar a agenda de outro closer");
    }
    return verificarHorarios(session.tenantId, query.unidade_id, query.data, {
      includeFullSlots: true,
      assignedMemberId: query.assigned_member_id
    });
  });
  app.patch("/scheduling/appointments/:id/reagendar", async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "appointments.reschedule");
    const { id } = idParams.parse(request.params);
    if (!await canAccessAppointment(session, scope, id)) return reply.status(404).send({ error: "Agendamento não encontrado" });
    return {
      agendamento: await rescheduleAppointment(
        session.tenantId,
        id,
        panelRescheduleBody.parse(request.body),
        {
          manual: true,
          allowCapacityOverride: true,
          expectedAssignedMemberId: scope.type === "mine" ? scope.memberId ?? undefined : undefined,
          actor: followUpActor(request,session)
        }
      )
    };
  });
  app.patch("/scheduling/appointments/:id/observation", async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "appointments.notes.manage");
    const { id } = idParams.parse(request.params);
    if (!await canAccessAppointment(session, scope, id)) {
      return reply.status(404).send({ error: "Agendamento não encontrado" });
    }
    const body = appointmentObservationBody.parse(request.body);
    return updateAppointmentObservation(
      session.tenantId,
      id,
      body.observacao || null,
      body.expected_updated_at,
      followUpActor(request, session),
      scope.type === "mine" ? scope.memberId ?? undefined : undefined
    );
  });
  app.post("/scheduling/appointments/:id/conversation", async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "conversations.reply");
    const { id } = idParams.parse(request.params);
    if (!await canAccessAppointment(session, scope, id)) {
      return reply.status(404).send({ error: "Agendamento não encontrado" });
    }
    const conversation = await openAppointmentConversation(
      session.tenantId,
      id,
      followUpActor(request, session),
      scope.type === "mine" ? scope.memberId ?? undefined : undefined
    );
    return reply.status(conversation.created ? 201 : 200).send({ conversation });
  });
  app.post("/scheduling/appointments/:id/join", async (request, reply) => {
    const { session,scope } = await panelCaseScope(request,"appointments.read");
    const { id } = idParams.parse(request.params);
    if (!await canAccessAppointment(session,scope,id)) return reply.status(404).send({ error: "Agendamento não encontrado" });
    return joinAppointment(
      session.tenantId,
      id,
      followUpActor(request,session),
      scope.type==="mine" ? scope.memberId ?? undefined : undefined
    );
  });
  app.delete("/scheduling/appointments/:id", async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "appointments.cancel");
    const { id } = idParams.parse(request.params);
    if (!await canAccessAppointment(session, scope, id)) return reply.status(404).send({ error: "Agendamento não encontrado" });
    return {
      agendamento: await cancelAppointment(
        session.tenantId,
        id,
        undefined,
        followUpActor(request,session),
        scope.type === "mine" ? scope.memberId ?? undefined : undefined
      )
    };
  });
  app.patch("/scheduling/appointments/:id/cancelar", async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "appointments.cancel");
    const { id } = idParams.parse(request.params);
    if (!await canAccessAppointment(session, scope, id)) return reply.status(404).send({ error: "Agendamento não encontrado" });
    return {
      agendamento: await cancelAppointment(
        session.tenantId,
        id,
        cancellationSchema.parse(request.body),
        followUpActor(request,session),
        scope.type === "mine" ? scope.memberId ?? undefined : undefined
      )
    };
  });
  app.delete("/scheduling/appointments/:id/remove", async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "leads.delete");
    const { id } = idParams.parse(request.params);
    if (!await canAccessAppointment(session, scope, id)) return reply.status(404).send({ error: "Agendamento não encontrado" });
    return await removeAppointment(session.tenantId, id);
  });
  app.patch("/scheduling/appointments/:id/concluir", async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "appointments.complete");
    const { id } = idParams.parse(request.params);
    if (!await canAccessAppointment(session, scope, id)) return reply.status(404).send({ error: "Agendamento não encontrado" });
    return {
      agendamento: await completeAppointment(
        session.tenantId,
        id,
        concludeAppointmentSchema.parse(request.body),
        followUpActor(request,session),
        scope.type === "mine" ? scope.memberId ?? undefined : undefined
      )
    };
  });
  app.patch("/scheduling/appointments/:id/no-show", async (request, reply) => {
    const { session, scope } = await panelCaseScope(request, "appointments.no_show");
    const { id } = idParams.parse(request.params);
    if (!await canAccessAppointment(session, scope, id)) return reply.status(404).send({ error: "Agendamento não encontrado" });
    return {
      agendamento: await markAppointmentNoShow(
        session.tenantId,
        id,
        noShowSchema.parse(request.body ?? {}),
        followUpActor(request,session),
        scope.type === "mine" ? scope.memberId ?? undefined : undefined
      )
    };
  });

  app.get("/scheduling/config/attendants", async (request) => {
    const session = await requirePermission(request, "units.read");
    const pool = await loadAttendantPool(session.tenantId, session.userId);
    if (hasWorkspaceCaseAccess(session)) return pool;
    const attendants = pool.attendants
      .filter((attendant) => attendant.is_current)
      .map((attendant) => ({
        member_id: attendant.member_id,
        user_id: attendant.user_id,
        email: attendant.email,
        funcao: attendant.funcao,
        selected: attendant.selected,
        availability_status: attendant.availability_status,
        cor_agenda: attendant.cor_agenda,
        availability_changed_at: attendant.availability_changed_at,
        is_current: true
      }));
    return {
      attendants,
      member_ids: attendants.filter((attendant) => attendant.selected)
        .map((attendant) => attendant.member_id)
    };
  });
  app.put("/scheduling/config/attendants", async (request) => {
    const session = await requirePermission(request, "units.manage");
    if (!hasWorkspaceCaseAccess(session)) throw httpError(403, "Somente gestores podem alterar a equipe de atendimento");
    return updateAttendantPool(
      session.tenantId,
      attendantPoolBody.parse(request.body),
      followUpActor(request, session)
    );
  });
  app.patch("/scheduling/attendants/me/availability", async (request) => {
    const session = await requireWorkspace(request);
    const body = attendantAvailabilityBody.parse(request.body);
    return updateAttendantAvailability(
      session.tenantId,
      { userId: session.userId },
      body.availability_status,
      followUpActor(request, session)
    );
  });
  app.get("/scheduling/attendants/me/time-blocks", async (request) => {
    const session = await requireWorkspace(request);
    const query = attendantTimeBlockQuery.parse(request.query);
    return {
      blocks: await listOwnAttendantTimeBlocks(session.tenantId, session.userId, {
        start: new Date(query.start),
        end: new Date(query.end)
      })
    };
  });
  app.post("/scheduling/attendants/me/time-blocks", async (request, reply) => {
    const session = await requireWorkspace(request);
    const block = await createOwnAttendantTimeBlock(
      session.tenantId,
      session.userId,
      attendantTimeBlockBody.parse(request.body),
      followUpActor(request, session)
    );
    return reply.status(201).send({ block });
  });
  app.delete("/scheduling/attendants/me/time-blocks/:id", async (request) => {
    const session = await requireWorkspace(request);
    const { id } = idParams.parse(request.params);
    return {
      block: await deleteOwnAttendantTimeBlock(
        session.tenantId,
        session.userId,
        id,
        followUpActor(request, session)
      )
    };
  });
  app.get("/scheduling/attendants/me/recurring-time-blocks", async (request) => { const session=await requireWorkspace(request); const q=attendantTimeBlockQuery.parse(request.query); return { blocks: await listOwnRecurringAttendantTimeBlocks(session.tenantId,session.userId,{start:new Date(q.start),end:new Date(q.end)}) }; });
  app.post("/scheduling/attendants/me/recurring-time-blocks", async (request,reply) => { const session=await requireWorkspace(request); const block=await createOwnRecurringAttendantTimeBlock(session.tenantId,session.userId,recurringTimeBlockBody.parse(request.body),followUpActor(request,session)); return reply.status(201).send({block}); });
  app.patch("/scheduling/attendants/me/recurring-time-blocks/:id", async (request) => { const session=await requireWorkspace(request); const {id}=idParams.parse(request.params); return {block:await updateOwnRecurringAttendantTimeBlock(session.tenantId,session.userId,id,recurringTimeBlockPatch.parse(request.body))}; });
  app.delete("/scheduling/attendants/me/recurring-time-blocks/:id", async (request) => { const session=await requireWorkspace(request); const {id}=idParams.parse(request.params); return {block:await deleteOwnRecurringAttendantTimeBlock(session.tenantId,session.userId,id)}; });
  app.patch("/scheduling/attendants/:memberId/availability", async (request) => {
    const session = await requirePermission(request, "units.manage");
    if (!hasWorkspaceCaseAccess(session)) throw httpError(403, "Somente gestores podem alterar outro atendente");
    const { memberId } = memberParams.parse(request.params);
    const body = attendantAvailabilityBody.parse(request.body);
    return updateAttendantAvailability(
      session.tenantId,
      { memberId },
      body.availability_status,
      followUpActor(request, session)
    );
  });
  app.patch("/scheduling/attendants/:memberId/calendar-color", async (request) => {
    const session = await requirePermission(request, "units.manage");
    if (!hasWorkspaceCaseAccess(session)) throw httpError(403, "Somente gestores podem alterar a cor da agenda");
    const { memberId } = memberParams.parse(request.params);
    const body = attendantCalendarColorBody.parse(request.body);
    return updateAttendantCalendarColor(
      session.tenantId,
      memberId,
      body.cor_agenda,
      followUpActor(request, session)
    );
  });

  app.get("/scheduling/config/atendon-meet", async (request) => {
    const session = await requirePermission(request, "units.read");
    return loadAtendonMeetSettings(session.tenantId);
  });
  app.put("/scheduling/config/atendon-meet", async (request) => {
    const session = await requirePermission(request, "units.manage");
    return updateAtendonMeetSettings(
      session.tenantId,
      atendonMeetSettingsBody.parse(request.body),
      followUpActor(request, session)
    );
  });
  app.get("/scheduling/config/google-meet", async (request) => {
    const session = await requirePermission(request, "units.read");
    return loadGoogleMeetSettings(session.tenantId);
  });
  app.put("/scheduling/config/google-meet", async (request) => {
    const session = await requirePermission(request, "units.manage");
    return updateGoogleMeetSettings(
      session.tenantId,
      googleMeetSettingsBody.parse(request.body),
      followUpActor(request, session)
    );
  });
  app.get("/scheduling/config/google-meet/oauth/start", async (request) => {
    const session = await requirePermission(request, "units.manage");
    const oauth = createGoogleMeetOAuthClient();
    const state = await createGoogleMeetOAuthState({ tenantId: session.tenantId, userId: session.userId }, config.JWT_SECRET);
    return { authorization_url: oauth.authorizationUrl(state) };
  });
  app.get("/scheduling/config/google-meet/oauth/callback", async (request, reply) => {
    const session = await requirePermission(request, "units.manage");
    const query = z.object({
      code: z.string().min(1).optional(),
      state: z.string().min(1),
      error: z.string().optional()
    }).parse(request.query);
    const returnUrl = new URL("/configuracoes", config.PANEL_PUBLIC_URL);
    returnUrl.searchParams.set("resource", "google-meet");
    if (query.error || !query.code) {
      returnUrl.searchParams.set("meet_oauth", "denied");
      return reply.redirect(returnUrl.toString());
    }
    try {
      const state = await verifyGoogleMeetOAuthState(query.state, config.JWT_SECRET);
      if (state.tenantId !== session.tenantId || state.userId !== session.userId) {
        throw httpError(403, "A conexão Google pertence a outra sessão");
      }
      const identity = await createGoogleMeetOAuthClient().exchangeCode(query.code);
      await connectGoogleMeetOAuth(session.tenantId, identity, followUpActor(request, session));
      returnUrl.searchParams.set("meet_oauth", "connected");
    } catch (error) {
      request.log.warn({ err: error }, "Google Meet OAuth callback failed");
      returnUrl.searchParams.set("meet_oauth", "error");
    }
    return reply.redirect(returnUrl.toString());
  });
  app.delete("/scheduling/config/google-meet/oauth", async (request) => {
    const session = await requirePermission(request, "units.manage");
    return disconnectGoogleMeetOAuth(session.tenantId, followUpActor(request, session));
  });

  registerConfigCrud(app, "categorias", categoryBody, {
    table: "scheduling_categories", readPermission: "categories.read", managePermission: "categories.manage", columns: ["name","active"], bodyValues: (body) => [body.nome,body.ativa], mapper: (row) => ({ id: row.id, tenant: row.tenant_id, nome: row.name, ativa: row.active })
  });
  registerConfigCrud(app, "parceiros", partnerBody, {
    table: "scheduling_partners", readPermission: "partners.read", managePermission: "partners.manage", columns: ["name","priority_order","proposal_link","active"], bodyValues: (body) => [body.nome,body.ordem_prioridade,body.link_proposta,body.ativo],
    mapper: (row) => ({ id: row.id, tenant: row.tenant_id, nome: row.name, ordem_prioridade: row.priority_order, link_proposta: row.proposal_link, ativo: row.active }), order: "priority_order,name"
  });
  registerConfigCrud(app, "unidades", unitBody, {
    table: "scheduling_units", readPermission: "units.read", managePermission: "units.manage", columns: ["name","opening_time","closing_time","operating_days","slot_duration_min","simultaneous_capacity"],
    bodyValues: (body) => [body.nome,body.horario_abertura,body.horario_fechamento,body.dias_funcionamento,body.duracao_slot_min,body.capacidade_simultanea], mapper: unitMapper
  });
}

type CrudOptions<Body extends { id: string }> = {
  table: string;
  readPermission: PermissionKey;
  managePermission: PermissionKey;
  columns: string[];
  bodyValues: (body: Body) => unknown[];
  mapper: (row: Record<string, unknown>) => unknown;
  order?: string;
};

function registerConfigCrud<Body extends { id: string }>(
  app: FastifyInstance,
  resource: string,
  schema: z.ZodType<Body>,
  options: CrudOptions<Body>
) {
  const base = `/scheduling/config/${resource}`;
  app.get(base, async (request) => {
    const tenantId = await panelTenant(request, options.readPermission);
    const result = await db.query(`SELECT * FROM ${options.table} WHERE tenant_id=$1 ORDER BY ${options.order ?? "name"}`, [tenantId]);
    return { [resource]: result.rows.map(options.mapper) };
  });
  app.post(base, async (request, reply) => {
    const tenantId = await panelTenant(request, options.managePermission); const body = schema.parse(request.body);
    const columns = ["tenant_id","id",...options.columns]; const values = [tenantId,body.id,...options.bodyValues(body)];
    const placeholders = values.map((_, index) => `$${index + 1}`).join(",");
    const result = await db.query(`INSERT INTO ${options.table}(${columns.join(",")}) VALUES(${placeholders}) RETURNING *`, values);
    return reply.status(201).send({ [resource.slice(0,-1)]: options.mapper(result.rows[0]) });
  });
  app.put(`${base}/:configId`, async (request, reply) => {
    const tenantId = await panelTenant(request, options.managePermission); const { configId } = z.object({ configId: slug }).parse(request.params); const body = schema.parse(request.body);
    if (body.id !== configId) throw httpError(400, "O id do cadastro não pode ser alterado");
    const values = options.bodyValues(body); const assignments = options.columns.map((column,index) => `${column}=$${index + 3}`).join(",");
    const result = await db.query(`UPDATE ${options.table} SET ${assignments},updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`, [tenantId,configId,...values]);
    if (!result.rows[0]) return reply.status(404).send({ error: "Cadastro não encontrado" });
    return { [resource.slice(0,-1)]: options.mapper(result.rows[0]) };
  });
  app.delete(`${base}/:configId`, async (request, reply) => {
    const tenantId = await panelTenant(request, options.managePermission); const { configId } = z.object({ configId: slug }).parse(request.params);
    try {
      const result = await db.query(`DELETE FROM ${options.table} WHERE tenant_id=$1 AND id=$2 RETURNING id`, [tenantId,configId]);
      if (!result.rows[0]) return reply.status(404).send({ error: "Cadastro não encontrado" });
      return reply.status(204).send();
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && error.code === "23503") throw httpError(409, "Cadastro possui histórico e não pode ser excluído; desative-o quando disponível");
      throw error;
    }
  });
}
