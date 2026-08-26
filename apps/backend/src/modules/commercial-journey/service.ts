import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { db } from "../../db/client.js";
import { APPOINTMENT_STATUS_REACTIONS } from "../scheduling/status-reaction.js";
import { OUTCOME_PIPELINE_STAGE, STAGES_REQUIRING_NEXT_ACTION, type CommercialOutcome } from "./domain.js";
import type {
  CancellationInput,
  CommercialTransitionPayload,
  ConcludeAppointmentInput,
  NoShowInput
} from "./schemas.js";
import type { LeadTechnicalStatus } from "../organization/domain.js";
import { captureClosedSalePostSaleClient } from "../post-sales/service.js";

export type JourneyActor = {
  userId: string | null;
  actorScope?: "root" | "workspace";
  ipAddress?: string;
  userAgent?: string;
};

type AppointmentRow = Record<string, unknown> & {
  id: string;
  tenant_id: string;
  lead_id: string;
  assigned_member_id: string | null;
  status: "confirmado" | "reagendado" | "cancelado" | "concluido" | "no_show";
  start_at: Date;
  end_at: Date;
  result_pending_at: Date | null;
};

type LeadRow = {
  id: string;
  status: LeadTechnicalStatus;
  pipeline_stage_id: string;
  assigned_member_id: string | null;
  sdr_member_id: string | null;
  closer_member_id: string | null;
};

type JourneyResult = {
  appointment: AppointmentRow;
  reactionNotificationId: string | null;
};

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message),{ statusCode });
}

async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function assertFuture(value: string, now = new Date()) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= now.getTime()) {
    throw httpError(409,"A data da próxima ação deve estar no futuro");
  }
  return parsed;
}

export async function defaultStageId(client: PoolClient, tenantId: string, status: LeadTechnicalStatus) {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM pipeline_stages
     WHERE tenant_id=$1 AND technical_status=$2 AND is_default AND archived_at IS NULL
     FOR SHARE`,
    [tenantId,status]
  );
  if (!result.rows[0]) throw httpError(409,`Etapa padrão ausente para ${status}`);
  return result.rows[0].id;
}

async function lockAppointmentAndLead(
  client: PoolClient,
  tenantId: string,
  appointmentId: string,
  expectedAssignedMemberId?: string
) {
  // All result commands use the same lock order: appointment, then lead.
  const appointment = (await client.query<AppointmentRow>(
    `SELECT appointment.*,unit.name unit_name,tenant.timezone,unit.slot_duration_min
     FROM scheduling_appointments appointment
     JOIN scheduling_units unit
       ON unit.tenant_id=appointment.tenant_id AND unit.id=appointment.unit_id
     JOIN tenants tenant ON tenant.id=appointment.tenant_id
     WHERE appointment.id=$1 AND appointment.tenant_id=$2
     FOR UPDATE OF appointment`,
    [appointmentId,tenantId]
  )).rows[0];
  if (!appointment || (expectedAssignedMemberId && appointment.assigned_member_id !== expectedAssignedMemberId)) {
    throw httpError(404,"Agendamento não encontrado");
  }
  const lead = (await client.query<LeadRow>(
    `SELECT id,status,pipeline_stage_id,assigned_member_id,sdr_member_id,closer_member_id
     FROM scheduling_leads WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
    [tenantId,appointment.lead_id]
  )).rows[0];
  if (!lead) throw httpError(404,"Lead não encontrado");
  return { appointment,lead };
}

async function insertAudit(
  client: PoolClient,
  tenantId: string,
  actor: JourneyActor,
  action: string,
  resourceId: string,
  metadata: Record<string,unknown>
) {
  await client.query(
    `INSERT INTO audit_logs(
       actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent
     ) VALUES($1,$2,$3,$4,'scheduling_appointment',$5,$6,$7,$8)`,
    [actor.userId,tenantId,actor.actorScope ?? "workspace",action,resourceId,metadata,actor.ipAddress ?? null,actor.userAgent ?? null]
  );
}

async function insertEvent(
  client: PoolClient,
  tenantId: string,
  lead: Pick<LeadRow,"id" | "status">,
  actor: JourneyActor,
  eventType: string,
  nextStatus: LeadTechnicalStatus,
  details: Record<string,unknown>
) {
  await client.query(
    `INSERT INTO scheduling_lead_events(
       lead_id,tenant_id,event_type,previous_status,new_status,details,actor_user_id
     ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [lead.id,tenantId,eventType,lead.status,nextStatus,details,actor.userId]
  );
}

async function reserveReaction(client: PoolClient, tenantId: string, appointmentId: string, status: keyof typeof APPOINTMENT_STATUS_REACTIONS) {
  const result = await client.query<{ id: string }>(
    `UPDATE scheduling_appointment_notifications
     SET reaction_emoji=$3,reaction_status='pending',reaction_attempts=0,
         reaction_last_error=NULL,reacted_at=NULL
     WHERE tenant_id=$1 AND appointment_id=$2
     RETURNING id`,
    [tenantId,appointmentId,APPOINTMENT_STATUS_REACTIONS[status]]
  );
  return result.rows[0]?.id ?? null;
}

async function pauseCommercialAutomation(client: PoolClient, tenantId: string, leadId: string) {
  await client.query(
    `UPDATE conversations conversation
     SET ai_active=false,handoff_reason='commercial_handoff',handoff_error_code=NULL
     FROM scheduling_leads lead
     WHERE lead.tenant_id=$1 AND lead.id=$2
       AND conversation.tenant_id=lead.tenant_id
       AND (conversation.lead_id=lead.id
         OR regexp_replace(conversation.contact_phone,'\\D','','g')=regexp_replace(lead.phone,'\\D','','g'))`,
    [tenantId,leadId]
  );
  await client.query(
    `UPDATE ai_follow_up_schedules schedule
     SET status='cancelled',next_run_at=NULL,processing_started_at=NULL,
         cancellation_reason='commercial_handoff',updated_at=now()
     FROM conversations conversation,scheduling_leads lead
     WHERE schedule.conversation_id=conversation.id
       AND schedule.tenant_id=conversation.tenant_id
       AND lead.tenant_id=$1 AND lead.id=$2
       AND conversation.tenant_id=lead.tenant_id
       AND (conversation.lead_id=lead.id
         OR regexp_replace(conversation.contact_phone,'\\D','','g')=regexp_replace(lead.phone,'\\D','','g'))
       AND schedule.status IN ('scheduled','processing')`,
    [tenantId,leadId]
  );
}

async function deterministicRecoveryMemberId(
  client: PoolClient,
  tenantId: string,
  candidates: Array<string | null>
) {
  const existing = candidates.find((candidate): candidate is string=>Boolean(candidate));
  if (existing) return existing;
  const fallback = await client.query<{ id: string }>(
    `SELECT member.id
     FROM workspace_members member
     LEFT JOIN scheduling_google_meet_closers pool
       ON pool.tenant_id=member.workspace_id AND pool.member_id=member.id
     WHERE member.workspace_id=$1 AND member.status='active'
     ORDER BY (pool.member_id IS NOT NULL AND pool.availability_status='available') DESC,
              member.joined_at NULLS LAST,member.created_at,member.id
     LIMIT 1`,
    [tenantId]
  );
  if (!fallback.rows[0]) throw httpError(409,"Não há responsável ativo para a recuperação");
  return fallback.rows[0].id;
}

async function deliverRecoveryContext(client: PoolClient, tenantId: string, leadId: string, memberId: string, appointmentId: string) {
  const recipient = (await client.query<{ user_id: string }>(
    "SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND id=$2 AND status='active'",
    [tenantId,memberId]
  )).rows[0];
  if (!recipient) throw httpError(409,"Responsável de recuperação indisponível");
  const conversations = await client.query<{ id: string; assigned_user_id: string | null }>(
    `SELECT conversation.id,conversation.assigned_user_id FROM conversations conversation,scheduling_leads lead
     WHERE lead.tenant_id=$1 AND lead.id=$2 AND conversation.tenant_id=lead.tenant_id
       AND conversation.status='open' AND (conversation.lead_id=lead.id
         OR regexp_replace(conversation.contact_phone,'\\D','','g')=regexp_replace(lead.phone,'\\D','','g')) FOR UPDATE OF conversation`,
    [tenantId,leadId]
  );
  await client.query(
    `UPDATE conversations conversation SET assigned_user_id=$3,claimed_at=now()
     FROM scheduling_leads lead WHERE lead.tenant_id=$1 AND lead.id=$2
       AND conversation.tenant_id=lead.tenant_id AND conversation.status='open'
       AND (conversation.lead_id=lead.id OR regexp_replace(conversation.contact_phone,'\\D','','g')=regexp_replace(lead.phone,'\\D','','g'))`,
    [tenantId,leadId,recipient.user_id]
  );
  for (const conversation of conversations.rows) await client.query("SELECT pg_notify('atendon_realtime_changes',$1)",[JSON.stringify({ v:1,type:"case.assignment.changed",tenantId,caseId:conversation.id,conversationId:conversation.id,leadId,entityId:randomUUID(),previousUserId:conversation.assigned_user_id,assignedUserId:recipient.user_id })]);
  const alert = await client.query<{ id: string }>(
    `INSERT INTO system_alerts(tenant_id,message,kind,audience,metadata)
     VALUES($1,'Recuperar reunião após no-show','meeting','selected',$2) RETURNING id`,
    [tenantId,{ event:"appointment_recovery_required",appointment_id:appointmentId,lead_id:leadId }]
  );
  await client.query("INSERT INTO system_alert_receipts(alert_id,tenant_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[alert.rows[0].id,tenantId,recipient.user_id]);
}

export async function applyAppointmentHandoff(
  client: PoolClient,
  input: {
    tenantId: string;
    appointmentId: string;
    leadId: string;
    unitId: string;
    previousStatus: LeadTechnicalStatus;
    previousOwnerMemberId: string | null;
    closerMemberId: string | null;
    start: Date;
    end: Date;
    actor: JourneyActor;
  }
) {
  const stageId = await defaultStageId(client,input.tenantId,"agendado");
  await client.query(
    `UPDATE scheduling_leads SET
       unit_id=$3,status='agendado',pipeline_stage_id=$4,
       sdr_member_id=COALESCE(sdr_member_id,$5),
       closer_member_id=$6,
       assigned_member_id=COALESCE($6,assigned_member_id),
       recovery_required=false,recovery_member_id=NULL,
       handoff_at=now(),handoff_by_user_id=$7,
       commercial_outcome=NULL,sale_value=NULL,loss_reason=NULL,
       commercial_updated_at=now(),commercial_updated_by_user_id=$7,
       next_action=NULL,next_action_at=NULL,updated_at=now()
     WHERE tenant_id=$1 AND id=$2`,
    [input.tenantId,input.leadId,input.unitId,stageId,input.previousOwnerMemberId,input.closerMemberId,input.actor.userId]
  );
  await pauseCommercialAutomation(client,input.tenantId,input.leadId);
  await client.query(
    `INSERT INTO scheduling_lead_events(
       lead_id,tenant_id,event_type,previous_status,new_status,details,actor_user_id
     ) VALUES($1,$2,'agendamento_criado',$3,'agendado',$4,$5)`,
    [input.leadId,input.tenantId,input.previousStatus,{
      appointment_id: input.appointmentId,
      previous_owner_member_id: input.previousOwnerMemberId,
      closer_member_id: input.closerMemberId,
      scheduled_by_user_id: input.actor.userId,
      received_by_member_id: input.closerMemberId,
      start: input.start.toISOString(),
      end: input.end.toISOString(),
      pipeline_stage_id: stageId
    },input.actor.userId]
  );
}

export async function applyStructuredStageEffects(
  client: PoolClient,
  input: {
    tenantId: string;
    lead: Pick<LeadRow,"id" | "status">;
    targetStatus: LeadTechnicalStatus;
    targetStageId: string;
    payload?: CommercialTransitionPayload;
    actor: JourneyActor;
  }
) {
  const { targetStatus,payload } = input;
  let outcome: CommercialOutcome | null = null;
  let saleValue: number | null = null;
  let lossReason: string | null = null;
  let nextAction: string | null = null;
  let nextActionAt: Date | null = null;
  if (targetStatus === "fechado") {
    if (!payload?.sale_value || payload.loss_reason || payload.next_action || payload.next_action_at) throw httpError(400,"Informe somente um valor de venda positivo para fechar o lead");
    outcome="fechado"; saleValue=payload.sale_value;
  } else if (targetStatus === "perdido") {
    if (!payload?.loss_reason || payload.sale_value || payload.next_action || payload.next_action_at) throw httpError(400,"Informe somente o motivo da perda");
    outcome="nao_avancou"; lossReason=payload.loss_reason;
  } else if (STAGES_REQUIRING_NEXT_ACTION.has(targetStatus)) {
    if (!payload?.next_action || !payload.next_action_at || payload.sale_value || payload.loss_reason) throw httpError(400,"Informe somente a próxima ação e sua data");
    outcome=targetStatus as CommercialOutcome;
    nextAction=payload.next_action;
    nextActionAt=assertFuture(payload.next_action_at);
  }
  const result = await client.query<LeadRow>(
    `UPDATE scheduling_leads SET
       status=$3,pipeline_stage_id=$4,
       commercial_outcome=$5,sale_value=$6,loss_reason=$7,
       next_action=$8,next_action_at=$9,
       commercial_updated_at=CASE WHEN $5::text IS NULL THEN commercial_updated_at ELSE now() END,
       commercial_updated_by_user_id=CASE WHEN $5::text IS NULL THEN commercial_updated_by_user_id ELSE $10 END,
       recovery_required=CASE WHEN $3='follow_up' THEN recovery_required ELSE false END,
       recovery_member_id=CASE WHEN $3='follow_up' THEN recovery_member_id ELSE NULL END,
       updated_at=now()
     WHERE tenant_id=$1 AND id=$2
     RETURNING id,status,pipeline_stage_id,assigned_member_id,sdr_member_id,closer_member_id`,
    [input.tenantId,input.lead.id,targetStatus,input.targetStageId,outcome,saleValue,lossReason,nextAction,nextActionAt,input.actor.userId]
  );
  if (targetStatus === "fechado") {
    await captureClosedSalePostSaleClient(
      client,
      input.tenantId,
      input.lead.id,
      input.actor.userId,
      input.actor.actorScope ?? "workspace"
    );
  }
  return result.rows[0];
}

export async function concludeAppointmentJourney(
  tenantId: string,
  appointmentId: string,
  input: ConcludeAppointmentInput,
  actor: JourneyActor,
  expectedAssignedMemberId?: string
): Promise<JourneyResult> {
  return transaction(async (client) => {
    const { appointment,lead } = await lockAppointmentAndLead(client,tenantId,appointmentId,expectedAssignedMemberId);
    if (!['confirmado','reagendado','no_show'].includes(appointment.status)) throw httpError(409,`Transição de agendamento não permitida: ${appointment.status} -> concluido`);
    const targetStatus = OUTCOME_PIPELINE_STAGE[input.outcome];
    const stageId = await defaultStageId(client,tenantId,targetStatus);
    const nextAction = "next_action" in input ? input.next_action : null;
    const nextActionAt = "next_action_at" in input ? assertFuture(input.next_action_at) : null;
    const saleValue = "sale_value" in input ? input.sale_value : null;
    const lossReason = "loss_reason" in input ? input.loss_reason : null;
    const updated = (await client.query<AppointmentRow>(
      `UPDATE scheduling_appointments SET
         status='concluido',result_pending_at=NULL,commercial_outcome=$3,
         sale_value=$4,loss_reason=$5,outcome_next_action=$6,outcome_next_action_at=$7,
         outcome_metadata=$8,cancellation_disposition=NULL,
         finalized_by_user_id=$9,finalized_at=now(),updated_at=now()
       WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [tenantId,appointmentId,input.outcome,saleValue,lossReason,nextAction,nextActionAt,input.outcome_metadata ?? {},actor.userId]
    )).rows[0];
    await client.query(
      `UPDATE scheduling_leads SET
         status=$3,pipeline_stage_id=$4,commercial_outcome=$5,sale_value=$6,loss_reason=$7,
         next_action=$8,next_action_at=$9,recovery_required=false,recovery_member_id=NULL,
         assigned_member_id=COALESCE($11::uuid,assigned_member_id),
         commercial_updated_at=now(),commercial_updated_by_user_id=$10,updated_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId,lead.id,targetStatus,stageId,input.outcome,saleValue,lossReason,nextAction,nextActionAt,actor.userId,appointment.assigned_member_id]
    );
    if (input.outcome === "fechado") {
      await captureClosedSalePostSaleClient(client,tenantId,lead.id,actor.userId,actor.actorScope ?? "workspace");
    }
    const details = { appointment_id: appointmentId,previous_appointment_status: appointment.status,outcome: input.outcome,sale_value: saleValue,loss_reason: lossReason,next_action: nextAction,next_action_at: nextActionAt };
    await insertEvent(client,tenantId,lead,actor,"resultado_comercial_registrado",targetStatus,details);
    await insertAudit(client,tenantId,actor,"scheduling.appointment.outcome.recorded",appointmentId,details);
    return { appointment: { ...appointment,...updated },reactionNotificationId: await reserveReaction(client,tenantId,appointmentId,"concluido") };
  });
}

export async function markAppointmentNoShowJourney(
  tenantId: string,
  appointmentId: string,
  input: NoShowInput,
  actor: JourneyActor,
  expectedAssignedMemberId?: string
): Promise<JourneyResult> {
  return transaction(async (client) => {
    const { appointment,lead } = await lockAppointmentAndLead(client,tenantId,appointmentId,expectedAssignedMemberId);
    if (!['confirmado','reagendado','concluido'].includes(appointment.status)) throw httpError(409,`Transição de agendamento não permitida: ${appointment.status} -> no_show`);
    const nextActionAt = input.next_action_at ? assertFuture(input.next_action_at) : new Date(Date.now()+24*60*60*1000);
    const recoveryMemberId = await deterministicRecoveryMemberId(client,tenantId,[
      lead.sdr_member_id,lead.assigned_member_id,appointment.assigned_member_id,lead.closer_member_id
    ]);
    const stageId = await defaultStageId(client,tenantId,"follow_up");
    const updated = (await client.query<AppointmentRow>(
      `UPDATE scheduling_appointments SET status='no_show',result_pending_at=NULL,
         commercial_outcome=NULL,sale_value=NULL,loss_reason=NULL,
         outcome_next_action=NULL,outcome_next_action_at=NULL,outcome_metadata='{}'::jsonb,
         cancellation_disposition=NULL,
         finalized_by_user_id=$3,finalized_at=now(),updated_at=now()
       WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [tenantId,appointmentId,actor.userId]
    )).rows[0];
    await client.query(
      `UPDATE scheduling_leads SET status='follow_up',pipeline_stage_id=$3,
         recovery_required=true,recovery_member_id=$4,assigned_member_id=$4,
         next_action='Recuperar reunião',next_action_at=$5,
         commercial_outcome=NULL,sale_value=NULL,loss_reason=NULL,commercial_updated_at=now(),
         commercial_updated_by_user_id=$6,updated_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId,lead.id,stageId,recoveryMemberId,nextActionAt,actor.userId]
    );
    await deliverRecoveryContext(client,tenantId,lead.id,recoveryMemberId,appointmentId);
    const details = { appointment_id: appointmentId,previous_appointment_status: appointment.status,recovery_member_id: recoveryMemberId,next_action_at: nextActionAt };
    await insertEvent(client,tenantId,lead,actor,"agendamento_no_show","follow_up",details);
    await insertAudit(client,tenantId,actor,"scheduling.appointment.no_show",appointmentId,details);
    return { appointment: { ...appointment,...updated },reactionNotificationId: await reserveReaction(client,tenantId,appointmentId,"no_show") };
  });
}

export async function cancelAppointmentJourney(
  tenantId: string,
  appointmentId: string,
  input: CancellationInput,
  actor: JourneyActor,
  expectedAssignedMemberId?: string
): Promise<JourneyResult> {
  return transaction(async (client) => {
    const { appointment,lead } = await lockAppointmentAndLead(client,tenantId,appointmentId,expectedAssignedMemberId);
    if (!['confirmado','reagendado'].includes(appointment.status)) throw httpError(409,`Transição de agendamento não permitida: ${appointment.status} -> cancelado`);
    const recovering = input.disposition === "recover";
    const targetStatus: LeadTechnicalStatus = recovering ? "follow_up" : "perdido";
    const stageId = await defaultStageId(client,tenantId,targetStatus);
    const nextActionAt = recovering ? assertFuture(input.next_action_at) : null;
    const lossReason = recovering ? null : input.loss_reason;
    const recoveryMemberId = recovering
      ? await deterministicRecoveryMemberId(client,tenantId,[
          lead.sdr_member_id,lead.assigned_member_id,appointment.assigned_member_id,lead.closer_member_id
        ])
      : null;
    const updated = (await client.query<AppointmentRow>(
      `UPDATE scheduling_appointments SET status='cancelado',result_pending_at=NULL,
         cancellation_disposition=$3,loss_reason=$4,outcome_next_action=$5,
         outcome_next_action_at=$6,finalized_by_user_id=$7,finalized_at=now(),updated_at=now()
       WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [tenantId,appointmentId,input.disposition,lossReason,recovering ? input.next_action : null,nextActionAt,actor.userId]
    )).rows[0];
    await client.query(
      `UPDATE scheduling_leads SET status=$3,pipeline_stage_id=$4,
         recovery_required=$5,recovery_member_id=$6,
         assigned_member_id=COALESCE($6,assigned_member_id),next_action=$7,next_action_at=$8,
         commercial_outcome=$9,loss_reason=$10,sale_value=NULL,
         commercial_updated_at=now(),commercial_updated_by_user_id=$11,updated_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId,lead.id,targetStatus,stageId,recovering,recoveryMemberId,recovering ? input.next_action : null,nextActionAt,recovering ? null : "nao_avancou",lossReason,actor.userId]
    );
    if (recoveryMemberId) await deliverRecoveryContext(client,tenantId,lead.id,recoveryMemberId,appointmentId);
    const details = { appointment_id: appointmentId,disposition: input.disposition,recovery_member_id: recoveryMemberId,next_action_at: nextActionAt,loss_reason: lossReason };
    await insertEvent(client,tenantId,lead,actor,"agendamento_cancelado",targetStatus,details);
    await insertAudit(client,tenantId,actor,"scheduling.appointment.cancelled",appointmentId,details);
    return { appointment: { ...appointment,...updated },reactionNotificationId: await reserveReaction(client,tenantId,appointmentId,"cancelado") };
  });
}

export async function markAppointmentResultPendingWithClient(
  client: PoolClient,
  tenantId: string,
  appointmentId: string,
  actor: JourneyActor = { userId: null }
) {
  const { appointment,lead } = await lockAppointmentAndLead(client,tenantId,appointmentId);
  if (!['confirmado','reagendado'].includes(appointment.status) || new Date(appointment.end_at).getTime()>Date.now()) throw httpError(409,"Somente reuniões encerradas e sem resultado podem ficar pendentes");
  if (appointment.result_pending_at) return { appointment,changed: false };
  const updated = (await client.query<AppointmentRow>(`UPDATE scheduling_appointments SET result_pending_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2 AND result_pending_at IS NULL RETURNING *`,[tenantId,appointmentId])).rows[0];
  await insertEvent(client,tenantId,lead,actor,"resultado_reuniao_pendente",lead.status,{ appointment_id: appointmentId });
  await insertAudit(client,tenantId,actor,"scheduling.appointment.result_pending",appointmentId,{ lead_id: lead.id });
  const recipient = (await client.query<{ user_id: string }>(`SELECT member.user_id FROM workspace_members member WHERE member.workspace_id=$1 AND member.id=COALESCE($2::uuid,$3::uuid) LIMIT 1`,[tenantId,appointment.assigned_member_id,lead.closer_member_id])).rows[0];
  const metadata = { event: "appointment_result_pending",appointment_id: appointmentId,lead_id: lead.id };
  if (recipient) {
    const alert = await client.query<{ id: string }>(`INSERT INTO system_alerts(tenant_id,message,kind,audience,metadata) VALUES($1,'Resultado de reunião pendente','meeting','selected',$2) RETURNING id`,[tenantId,metadata]);
    await client.query(`INSERT INTO system_alert_receipts(alert_id,tenant_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[alert.rows[0].id,tenantId,recipient.user_id]);
  } else await client.query(`INSERT INTO system_alerts(tenant_id,message,kind,audience,metadata) VALUES($1,'Resultado de reunião sem closer responsável','meeting','workspace',$2)`,[tenantId,metadata]);
  return { appointment: { ...appointment,...updated },changed: true };
}

export async function markAppointmentResultPending(tenantId: string,appointmentId: string,actor: JourneyActor = { userId: null }) {
  return transaction((client) => markAppointmentResultPendingWithClient(client,tenantId,appointmentId,actor));
}
