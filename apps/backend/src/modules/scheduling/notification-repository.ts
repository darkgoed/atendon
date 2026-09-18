import type { Pool, PoolClient } from "pg";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { logger } from "../../logger.js";
import {
  enqueueSchedulingNotification,
  enqueueSchedulingNotificationEdit
} from "../../queue/scheduling-notification-queue.js";

export interface AppointmentNotificationContext {
  leadId: string;
  leadName: string | null;
  leadPhone: string;
  start: Date;
  end: Date;
  timezone: string;
  assignedEmail: string | null;
  meetLink: string | null;
}

export function formatAppointmentNotificationMessage(input: AppointmentNotificationContext): string {
  const zonedDate = new Intl.DateTimeFormat("pt-BR", { timeZone: input.timezone, day: "2-digit", month: "2-digit", year: "numeric" }).format(input.start);
  const zonedTime = new Intl.DateTimeFormat("pt-BR", { timeZone: input.timezone, hour: "2-digit", minute: "2-digit" }).format(input.start);
  const lines = [
    "*Novo agendamento realizado*",
    "",
    `Contato: ${input.leadName ?? "Sem nome"}`,
    `Telefone: +${input.leadPhone}`,
    `Data: ${zonedDate}`,
    `Horário: ${zonedTime}`,
    ...(input.assignedEmail ? [`Responsável: ${input.assignedEmail}`] : []),
    ...(input.meetLink ? [`Link da reunião: ${input.meetLink}`] : []),
    `Ver lead: ${config.PANEL_PUBLIC_URL}/leads/${input.leadId}`
  ];
  return lines.join("\n");
}

export async function notifyAppointmentGroup(
  tenantId: string,
  appointmentId: string,
  context: AppointmentNotificationContext
): Promise<void> {
  const settings = await db.query<{ enabled: boolean; session_id: string | null; group_jid: string | null }>(
    "SELECT enabled,session_id,group_jid FROM scheduling_notification_settings WHERE tenant_id=$1",
    [tenantId]
  );
  const row = settings.rows[0];
  if (!row?.enabled || !row.session_id || !row.group_jid) return;
  const notificationId = await new SchedulingNotificationRepository(db).create({
    tenantId,
    appointmentId,
    sessionId: row.session_id,
    groupJid: row.group_jid,
    message: formatAppointmentNotificationMessage(context)
  });
  await scheduleAppointmentGroupNotificationRefresh(db, tenantId, appointmentId);
  if (!notificationId) return;
  await enqueueSchedulingNotification(notificationId).catch((error) => {
    logger.warn({ err: error, tenantId, appointmentId }, "Scheduling group notification enqueue failed; database reconciler will retry");
  });
}

export interface PendingSchedulingNotification {
  id: string;
  sessionId: string;
  groupJid: string;
  message: string;
  revision: number;
}

export interface PendingSchedulingNotificationEdit extends PendingSchedulingNotification {
  externalMessageId: string;
  revision: number;
}

type AppointmentNotificationRefreshRow = {
  notification_id: string;
  lead_id: string;
  lead_name: string | null;
  lead_phone: string;
  start_at: Date;
  end_at: Date;
  timezone: string;
  assigned_email: string | null;
  meet_link: string | null;
};

type NotificationDatabase = Pool | PoolClient;

type ScheduledAppointmentNotificationRefresh = {
  notificationId: string;
  status: "pending" | "sent" | "failed" | null;
};

async function scheduleAppointmentGroupNotificationRefreshes(
  database: NotificationDatabase,
  tenantId: string,
  selector: "appointment.lead_id" | "notification.appointment_id",
  value: string
): Promise<ScheduledAppointmentNotificationRefresh[]> {
  const result = await database.query<AppointmentNotificationRefreshRow>(
    `SELECT notification.id notification_id,lead.id lead_id,lead.name lead_name,lead.phone lead_phone,
            appointment.start_at,appointment.end_at,tenant.timezone,
            assigned_user.email assigned_email,appointment.meeting_url meet_link
     FROM scheduling_appointment_notifications notification
     JOIN scheduling_appointments appointment
       ON appointment.id=notification.appointment_id AND appointment.tenant_id=notification.tenant_id
     JOIN scheduling_leads lead
       ON lead.id=appointment.lead_id AND lead.tenant_id=appointment.tenant_id AND lead.deleted_at IS NULL
     JOIN tenants tenant ON tenant.id=appointment.tenant_id
     LEFT JOIN workspace_members assigned_member
       ON assigned_member.id=lead.assigned_member_id AND assigned_member.workspace_id=lead.tenant_id
     LEFT JOIN users assigned_user ON assigned_user.id=assigned_member.user_id
     WHERE notification.tenant_id=$1 AND ${selector}=$2`,
    [tenantId, value]
  );
  const repository = new SchedulingNotificationRepository(database);
  const refreshes: ScheduledAppointmentNotificationRefresh[] = [];
  for (const row of result.rows) {
    const message = formatAppointmentNotificationMessage({
      leadId: row.lead_id,
      leadName: row.lead_name,
      leadPhone: row.lead_phone,
      start: row.start_at,
      end: row.end_at,
      timezone: row.timezone,
      assignedEmail: row.assigned_email,
      meetLink: row.meet_link
    });
    const scheduled = await repository.scheduleMessageEdit(row.notification_id, message);
    refreshes.push({
      notificationId: row.notification_id,
      status: scheduled?.status ?? null
    });
  }
  return refreshes;
}

async function refreshAppointmentGroupNotifications(
  tenantId: string,
  selector: "appointment.lead_id" | "notification.appointment_id",
  value: string
): Promise<void> {
  const refreshes = await scheduleAppointmentGroupNotificationRefreshes(db, tenantId, selector, value);
  const repository = new SchedulingNotificationRepository(db);
  for (const refresh of refreshes) {
    if (refresh.status === "pending" || refresh.status === "failed") continue;
    const pendingEdit = await repository.getPendingEdit(refresh.notificationId);
    if (!pendingEdit) continue;
    await enqueueSchedulingNotificationEdit(refresh.notificationId, pendingEdit.revision).catch((error) => {
      logger.warn(
        { err: error, notificationId: refresh.notificationId, revision: pendingEdit.revision },
        "Scheduling group notification edit enqueue failed; database reconciler will retry"
      );
    });
  }
}

export async function scheduleAppointmentGroupNotificationRefresh(
  database: NotificationDatabase,
  tenantId: string,
  appointmentId: string
): Promise<void> {
  await scheduleAppointmentGroupNotificationRefreshes(
    database,
    tenantId,
    "notification.appointment_id",
    appointmentId
  );
}

export async function refreshAppointmentGroupNotificationsForLead(
  tenantId: string,
  leadId: string
): Promise<void> {
  await refreshAppointmentGroupNotifications(
    tenantId,
    "appointment.lead_id",
    leadId
  );
}

export async function refreshAppointmentGroupNotificationsForConversation(
  tenantId: string,
  conversationId: string
): Promise<void> {
  const leads = await db.query<{ id: string }>(
    `SELECT lead.id
     FROM conversations conversation
     JOIN scheduling_leads lead
       ON lead.tenant_id=conversation.tenant_id
      AND lead.deleted_at IS NULL
      AND regexp_replace(lead.phone,'\\D','','g')=regexp_replace(conversation.contact_phone,'\\D','','g')
     WHERE conversation.tenant_id=$1 AND conversation.id=$2`,
    [tenantId, conversationId]
  );
  for (const lead of leads.rows) {
    await refreshAppointmentGroupNotificationsForLead(tenantId, lead.id);
  }
}

export async function refreshAppointmentGroupNotification(
  tenantId: string,
  appointmentId: string
): Promise<void> {
  await refreshAppointmentGroupNotifications(
    tenantId,
    "notification.appointment_id",
    appointmentId
  );
}

export class SchedulingNotificationRepository {
  constructor(private readonly db: NotificationDatabase) {}

  async create(input: {
    tenantId: string;
    appointmentId: string;
    sessionId: string;
    groupJid: string;
    message: string;
  }): Promise<string | null> {
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO scheduling_appointment_notifications(
         tenant_id,appointment_id,session_id,group_jid,message,reaction_emoji,reaction_status
       )
       SELECT $1,$2,$3,$4,$5,
              CASE appointment.status
                WHEN 'concluido' THEN '✅'
                WHEN 'cancelado' THEN '❌'
                WHEN 'no_show' THEN '⚠️'
              END,
              CASE WHEN appointment.status IN ('concluido','cancelado','no_show') THEN 'pending' END
       FROM scheduling_appointments appointment
       WHERE appointment.id=$2 AND appointment.tenant_id=$1
       ON CONFLICT(tenant_id,appointment_id) DO NOTHING
       RETURNING id`,
      [input.tenantId, input.appointmentId, input.sessionId, input.groupJid, input.message]
    );
    return result.rows[0]?.id ?? null;
  }

  async getPending(id: string): Promise<PendingSchedulingNotification | null> {
    const result = await this.db.query<{
      id: string;
      session_id: string;
      group_jid: string;
      message: string;
      message_revision: number;
    }>(
      `SELECT id,session_id,group_jid,message,message_revision
       FROM scheduling_appointment_notifications WHERE id=$1 AND status='pending'`,
      [id]
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      sessionId: row.session_id,
      groupJid: row.group_jid,
      message: row.message,
      revision: row.message_revision
    } : null;
  }

  async findPendingPage(
    limit = 100,
    afterId?: string
  ): Promise<{ ids: string[]; nextCursor: string | null }> {
    const result = await this.db.query<{ id: string }>(
      `SELECT id
       FROM scheduling_appointment_notifications
       WHERE status='pending'
         AND created_at <= now()-interval '30 seconds'
         AND ($2::uuid IS NULL OR id > $2)
       ORDER BY id
       LIMIT $1`,
      [limit, afterId ?? null]
    );
    const ids = result.rows.map((row) => row.id);
    return { ids, nextCursor: ids.length === limit ? ids.at(-1)! : null };
  }

  async markSent(id: string, externalMessageId: string, sentRevision = 0): Promise<number | null> {
    const result = await this.db.query<{ edit_revision: number | null }>(
      `UPDATE scheduling_appointment_notifications
       SET status='sent',sent_at=now(),external_message_id=$2,last_error=NULL,
           edited_revision=GREATEST(edited_revision,LEAST(message_revision,$3)),
           edit_status=CASE WHEN message_revision>$3 THEN 'pending' ELSE 'sent' END,
           edit_attempts=CASE WHEN message_revision>$3 THEN 0 ELSE edit_attempts END,
           edit_last_error=CASE WHEN message_revision>$3 THEN NULL ELSE edit_last_error END
       WHERE id=$1 AND status='pending'
       RETURNING CASE WHEN message_revision>$3 THEN message_revision END edit_revision`,
      [id, externalMessageId, sentRevision]
    );
    return result.rows[0]?.edit_revision ?? null;
  }

  async scheduleMessageEdit(
    id: string,
    message: string
  ): Promise<{ revision: number; status: "pending" | "sent" | "failed" } | null> {
    const result = await this.db.query<{
      message_revision: number;
      status: "pending" | "sent" | "failed";
    }>(
      `UPDATE scheduling_appointment_notifications
       SET message=$2,
           message_revision=message_revision+1,
           edit_status=CASE WHEN status='sent' THEN 'pending' ELSE edit_status END,
           edit_attempts=CASE WHEN status='sent' THEN 0 ELSE edit_attempts END,
           edit_last_error=CASE WHEN status='sent' THEN NULL ELSE edit_last_error END
       WHERE id=$1 AND message IS DISTINCT FROM $2
       RETURNING message_revision,status`,
      [id, message]
    );
    const row = result.rows[0];
    return row ? { revision: row.message_revision, status: row.status } : null;
  }

  async getPendingEdit(id: string): Promise<PendingSchedulingNotificationEdit | null> {
    const result = await this.db.query<{
      id: string;
      session_id: string;
      group_jid: string;
      message: string;
      external_message_id: string;
      message_revision: number;
    }>(
      `SELECT id,session_id,group_jid,message,external_message_id,message_revision
       FROM scheduling_appointment_notifications
       WHERE id=$1 AND status='sent' AND external_message_id IS NOT NULL
         AND edit_status='pending' AND edited_revision < message_revision`,
      [id]
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      sessionId: row.session_id,
      groupJid: row.group_jid,
      message: row.message,
      externalMessageId: row.external_message_id,
      revision: row.message_revision
    } : null;
  }

  async findPendingEditPage(
    limit = 100,
    afterId?: string
  ): Promise<{ edits: Array<{ id: string; revision: number }>; nextCursor: string | null }> {
    const result = await this.db.query<{ id: string; message_revision: number }>(
      `SELECT id,message_revision
       FROM scheduling_appointment_notifications
       WHERE status='sent' AND external_message_id IS NOT NULL
         AND edit_status='pending' AND edited_revision < message_revision
         AND ($2::uuid IS NULL OR id > $2)
       ORDER BY id
       LIMIT $1`,
      [limit, afterId ?? null]
    );
    const edits = result.rows.map((row) => ({ id: row.id, revision: row.message_revision }));
    return { edits, nextCursor: edits.length === limit ? edits.at(-1)!.id : null };
  }

  async markEdited(id: string, revision: number): Promise<void> {
    await this.db.query(
      `UPDATE scheduling_appointment_notifications
       SET edited_revision=$2,edit_status='sent',edited_at=now(),edit_last_error=NULL
       WHERE id=$1 AND edit_status='pending' AND message_revision=$2`,
      [id, revision]
    );
  }

  async recordEditFailure(id: string, revision: number, error: unknown, terminal = false): Promise<void> {
    await this.db.query(
      `UPDATE scheduling_appointment_notifications
       SET edit_attempts=edit_attempts + CASE WHEN $4 THEN 0 ELSE 1 END,
           edit_last_error=$3,
           edit_status=CASE WHEN $4 THEN 'failed' ELSE 'pending' END
       WHERE id=$1 AND edit_status='pending' AND message_revision=$2`,
      [id, revision, error instanceof Error ? error.message : String(error), terminal]
    );
  }

  async recordFailure(id: string, error: unknown, terminal = false): Promise<void> {
    await this.db.query(
      `UPDATE scheduling_appointment_notifications
       SET attempts=attempts + CASE WHEN $3 THEN 0 ELSE 1 END, last_error=$2,
           status=CASE WHEN $3 THEN 'failed' ELSE status END,
           reaction_status=CASE
             WHEN $3 AND reaction_status='pending' THEN 'failed'
             ELSE reaction_status
           END,
           reaction_last_error=CASE
             WHEN $3 AND reaction_status='pending' THEN $2
             ELSE reaction_last_error
           END
       WHERE id=$1 AND status='pending'`,
      [id, error instanceof Error ? error.message : String(error), terminal]
    );
  }
}
