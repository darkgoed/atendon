import type { WorkspaceSession } from "../../auth/session.js";
import { resolveCaseScope } from "../../auth/case-scope.js";
import { db } from "../../db/client.js";
import { resolveReportingRange, shiftDateKey, type ReportingInput } from "../reporting.js";

export type CommercialDashboardPeriod = "today" | "week" | "month" | "custom";
export type CommercialDashboardInput = ReportingInput;

export const resolvePeriod = resolveReportingRange;

export async function loadCommercialDashboard(
  session: WorkspaceSession,
  input: CommercialDashboardInput
) {
  const tenantResult = await db.query<{ timezone: string }>(
    "SELECT timezone FROM tenants WHERE id=$1",
    [session.tenantId]
  );
  const timezone = tenantResult.rows[0]?.timezone ?? "UTC";
  const range = resolvePeriod(timezone, input);
  const caseScope = await resolveCaseScope(db, session);
  const membership = await db.query<{
    member_id: string;
    email: string;
    is_closer: boolean;
    availability_status: "available" | "unavailable" | null;
  }>(
    `SELECT m.id member_id,u.email,
            EXISTS (
              SELECT 1 FROM scheduling_google_meet_closers pool
              WHERE pool.tenant_id=m.workspace_id AND pool.member_id=m.id
            ) is_closer,
            pool.availability_status
     FROM workspace_members m
     JOIN users u ON u.id=m.user_id
     LEFT JOIN scheduling_google_meet_closers pool
       ON pool.tenant_id=m.workspace_id AND pool.member_id=m.id
     WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.status='active'
     LIMIT 1`,
    [session.tenantId, session.userId]
  );
  const viewer = membership.rows[0] ?? null;
  const scopedMemberId = caseScope.type === "mine" ? caseScope.memberId : null;
  const workspaceScope = caseScope.type === "workspace";
  const params = [
    session.tenantId,
    range.start.toISOString(),
    range.end.toISOString(),
    workspaceScope,
    scopedMemberId
  ];

  const [summary, created, series, agenda, team, sdr, operations] = await Promise.all([
    db.query<{
      scheduled: number;
      completed: number;
      no_show: number;
      cancelled: number;
      upcoming: number;
      overdue: number;
      due: number;
      result_pending: number;
      rescheduled: number;
      proposals: number;
      negotiations: number;
      sales: number;
      sold_value: string | null;
      overdue_follow_ups: number;
      average_quality: string | null;
    }>(
      `SELECT
         count(*) FILTER (WHERE a.status <> 'cancelado')::int scheduled,
         count(*) FILTER (WHERE a.status='concluido')::int completed,
         count(*) FILTER (WHERE a.status='no_show')::int no_show,
         count(*) FILTER (WHERE a.status='cancelado')::int cancelled,
         count(*) FILTER (
           WHERE a.status IN ('confirmado','reagendado') AND a.start_at >= now()
         )::int upcoming,
         count(*) FILTER (
           WHERE a.status IN ('confirmado','reagendado') AND a.end_at < now()
         )::int overdue,
         count(*) FILTER (WHERE a.status <> 'cancelado' AND a.end_at < now())::int due,
         (SELECT count(*)::int FROM scheduling_appointments pending
          WHERE pending.tenant_id=$1 AND pending.status IN ('confirmado','reagendado')
            AND (pending.result_pending_at IS NOT NULL OR pending.end_at < now())
            AND ($4::boolean OR pending.assigned_member_id=$5)) result_pending,
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM scheduling_lead_events event
           WHERE event.tenant_id=a.tenant_id AND event.lead_id=a.lead_id
             AND event.event_type='agendamento_reagendado'
             AND event.details->>'appointment_id'=a.id::text
         ))::int rescheduled,
         count(*) FILTER (WHERE a.commercial_outcome='proposta_enviada')::int proposals,
         count(*) FILTER (WHERE a.commercial_outcome='em_negociacao')::int negotiations,
         count(*) FILTER (WHERE a.commercial_outcome='fechado')::int sales,
         COALESCE(sum(a.sale_value) FILTER (WHERE a.commercial_outcome='fechado'),0)::text sold_value,
         count(DISTINCT l.id) FILTER (
           WHERE l.next_action_at < now() AND l.status NOT IN ('fechado','perdido')
         )::int overdue_follow_ups,
         round(avg(l.qualification_stars)::numeric,1)::text average_quality
       FROM scheduling_appointments a
       JOIN scheduling_leads l ON l.id=a.lead_id AND l.tenant_id=a.tenant_id
       WHERE a.tenant_id=$1
         AND a.start_at >= $2::timestamptz AND a.start_at < $3::timestamptz
         AND ($4::boolean OR a.assigned_member_id=$5)`,
      params
    ),
    db.query<{ count: number }>(
      `SELECT count(*) FILTER (WHERE status <> 'cancelado')::int count
       FROM scheduling_appointments
       WHERE tenant_id=$1
         AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
         AND ($4::boolean OR assigned_member_id=$5)`,
      params
    ),
    db.query<{
      day: string;
      scheduled: number;
      completed: number;
      no_show: number;
      cancelled: number;
    }>(
      `WITH days AS (
         SELECT generate_series($2::date,$3::date - 1,interval '1 day')::date AS bucket_date
       ),
       totals AS (
         SELECT (a.start_at AT TIME ZONE $4)::date AS bucket_date,
                count(*) FILTER (WHERE a.status <> 'cancelado')::int scheduled,
                count(*) FILTER (WHERE a.status='concluido')::int completed,
                count(*) FILTER (WHERE a.status='no_show')::int no_show,
                count(*) FILTER (WHERE a.status='cancelado')::int cancelled
         FROM scheduling_appointments a
         WHERE a.tenant_id=$1
           AND a.start_at >= $5::timestamptz AND a.start_at < $6::timestamptz
           AND ($7::boolean OR a.assigned_member_id=$8)
         GROUP BY 1
       )
       SELECT days.bucket_date::text AS day,
              COALESCE(totals.scheduled,0)::int scheduled,
              COALESCE(totals.completed,0)::int completed,
              COALESCE(totals.no_show,0)::int no_show,
              COALESCE(totals.cancelled,0)::int cancelled
       FROM days
       LEFT JOIN totals USING(bucket_date)
       ORDER BY days.bucket_date`,
      [
        session.tenantId,
        range.startKey,
        range.endKey,
        timezone,
        range.start.toISOString(),
        range.end.toISOString(),
        workspaceScope,
        scopedMemberId
      ]
    ),
    db.query<{
      id: string;
      start_at: string;
      end_at: string;
      status: string;
      lead_name: string | null;
      lead_phone: string;
      unit_name: string;
      meet_url: string | null;
      assigned_user_email: string | null;
      assigned_availability_status: "available" | "unavailable" | null;
    }>(
      `SELECT a.id,a.start_at,a.end_at,a.status,l.name lead_name,l.phone lead_phone,
              unit.name unit_name,a.meeting_url meet_url,assigned_user.email assigned_user_email,
              pool.availability_status assigned_availability_status
       FROM scheduling_appointments a
       JOIN scheduling_leads l ON l.id=a.lead_id AND l.tenant_id=a.tenant_id
       JOIN scheduling_units unit ON unit.id=a.unit_id AND unit.tenant_id=a.tenant_id
       LEFT JOIN workspace_members assigned_member
         ON assigned_member.id=a.assigned_member_id AND assigned_member.workspace_id=a.tenant_id
       LEFT JOIN users assigned_user ON assigned_user.id=assigned_member.user_id
       LEFT JOIN scheduling_google_meet_closers pool
         ON pool.tenant_id=a.tenant_id AND pool.member_id=a.assigned_member_id
       WHERE a.tenant_id=$1
         AND a.start_at >= $2::timestamptz AND a.start_at < $3::timestamptz
         AND a.status <> 'cancelado'
         AND ($4::boolean OR a.assigned_member_id=$5)
       ORDER BY a.start_at
       LIMIT 30`,
      [
        session.tenantId,
        range.todayStart.toISOString(),
        range.todayEnd.toISOString(),
        workspaceScope,
        scopedMemberId
      ]
    ),
    db.query<{
      member_id: string;
      user_id: string;
      email: string;
      name: string | null;
      active: number;
      period: number;
      completed: number;
      no_show: number;
      sales: number;
      sold_value: string | null;
      last_assigned_at: string | null;
      availability_status: "available" | "unavailable";
      cursor_member_id: string | null;
    }>(
      `SELECT m.id member_id,m.user_id,u.email,u.name,pool.availability_status,
              cursor.last_member_id cursor_member_id,
              count(a.id) FILTER (WHERE a.status IN ('confirmado','reagendado'))::int active,
              count(a.id) FILTER (
                WHERE a.start_at >= $2::timestamptz AND a.start_at < $3::timestamptz
                  AND a.status <> 'cancelado'
              )::int period,
              count(a.id) FILTER (
                WHERE a.start_at >= $2::timestamptz AND a.start_at < $3::timestamptz
                  AND a.status='concluido'
              )::int completed,
              count(a.id) FILTER (
                WHERE a.start_at >= $2::timestamptz AND a.start_at < $3::timestamptz
                  AND a.status='no_show'
              )::int no_show,
              count(a.id) FILTER (
                WHERE a.start_at >= $2::timestamptz AND a.start_at < $3::timestamptz
                  AND a.commercial_outcome='fechado'
              )::int sales,
              COALESCE(sum(a.sale_value) FILTER (
                WHERE a.start_at >= $2::timestamptz AND a.start_at < $3::timestamptz
                  AND a.commercial_outcome='fechado'
              ),0)::text sold_value,
              max(a.assigned_at)::text last_assigned_at
       FROM scheduling_google_meet_closers pool
       JOIN workspace_members m
         ON m.id=pool.member_id AND m.workspace_id=pool.tenant_id AND m.status='active'
       JOIN users u ON u.id=m.user_id AND u.status='active'
       LEFT JOIN attendant_assignment_cursors cursor ON cursor.tenant_id=pool.tenant_id
       LEFT JOIN scheduling_appointments a
         ON a.tenant_id=pool.tenant_id AND a.assigned_member_id=m.id
       WHERE pool.tenant_id=$1
         AND ($4::boolean OR m.id=$5)
       GROUP BY m.id,m.user_id,u.email,u.name,pool.availability_status,cursor.last_member_id,pool.created_at
       ORDER BY pool.created_at,m.id`,
      [
        session.tenantId,
        range.start.toISOString(),
        range.end.toISOString(),
        workspaceScope,
        scopedMemberId
      ]
    ),
    db.query<{
      received: number;
      attended: number;
      qualified: number;
      scheduled: number;
      overdue_follow_ups: number;
      recovered_no_shows: number;
      average_first_response_minutes: string | null;
    }>(
      `WITH period_leads AS MATERIALIZED (
         SELECT lead.*
         FROM scheduling_leads lead
         WHERE lead.tenant_id=$1
           AND lead.created_at >= $2::timestamptz AND lead.created_at < $3::timestamptz
           AND ($4::boolean OR COALESCE(lead.sdr_member_id,lead.assigned_member_id)=$5)
       )
       SELECT count(*)::int received,
              count(*) FILTER (WHERE first_response.created_at IS NOT NULL)::int attended,
              count(*) FILTER (
                WHERE lead.qualification_stars IS NOT NULL
                  OR lead.status IN ('qualificado','agendado','em_negociacao','proposta_enviada','follow_up','fechado')
              )::int qualified,
              count(*) FILTER (WHERE scheduled.id IS NOT NULL)::int scheduled,
              count(*) FILTER (
                WHERE lead.next_action_at < now() AND lead.status NOT IN ('fechado','perdido')
              )::int overdue_follow_ups,
              count(*) FILTER (WHERE recovered.id IS NOT NULL)::int recovered_no_shows,
              round(avg(extract(epoch FROM (first_response.created_at-lead.created_at))/60)::numeric,1)::text
                average_first_response_minutes
       FROM period_leads lead
       LEFT JOIN LATERAL (
         SELECT message.created_at
         FROM conversations conversation
         JOIN messages message ON message.conversation_id=conversation.id
         WHERE conversation.tenant_id=lead.tenant_id
           AND (conversation.lead_id=lead.id OR regexp_replace(conversation.contact_phone,'\\D','','g')=regexp_replace(lead.phone,'\\D','','g'))
           AND message.sender IN ('agent','human')
           AND message.created_at>=lead.created_at
         ORDER BY message.created_at,message.id LIMIT 1
       ) first_response ON true
       LEFT JOIN LATERAL (
         SELECT appointment.id
         FROM scheduling_appointments appointment
         WHERE appointment.tenant_id=lead.tenant_id AND appointment.lead_id=lead.id
         ORDER BY appointment.created_at,appointment.id LIMIT 1
       ) scheduled ON true
       LEFT JOIN LATERAL (
         SELECT later.id
         FROM scheduling_appointments missed
         JOIN scheduling_appointments later
           ON later.tenant_id=missed.tenant_id AND later.lead_id=missed.lead_id
          AND later.created_at>missed.finalized_at
          AND later.status IN ('confirmado','reagendado','concluido')
         WHERE missed.tenant_id=lead.tenant_id AND missed.lead_id=lead.id AND missed.status='no_show'
         ORDER BY later.created_at LIMIT 1
       ) recovered ON true`,
      params
    ),
    // ponytail: subselects, não CTE — cada métrica tem escopo/janela própria e o volume é de um tenant.
    db.query<{
      inbound_messages: number;
      open_conversations: number;
      handoffs: number;
      unassigned_leads: number;
    }>(
      `SELECT
         (SELECT count(*)::int
            FROM messages message
            JOIN conversations conversation ON conversation.id=message.conversation_id
           WHERE conversation.tenant_id=$1
             AND ($4::boolean OR conversation.assigned_user_id=$5)
             AND message.sender='contact'
             AND message.created_at >= $2::timestamptz AND message.created_at < $3::timestamptz
         ) inbound_messages,
         (SELECT count(*)::int FROM conversations
           WHERE tenant_id=$1 AND ($4::boolean OR assigned_user_id=$5) AND status='open'
         ) open_conversations,
         (SELECT count(*)::int FROM scheduling_leads
           WHERE tenant_id=$1 AND ($4::boolean OR COALESCE(sdr_member_id,assigned_member_id)=$6)
             AND handoff_at >= $2::timestamptz AND handoff_at < $3::timestamptz
         ) handoffs,
         (SELECT count(*)::int FROM scheduling_leads
           WHERE tenant_id=$1 AND ($4::boolean OR COALESCE(sdr_member_id,assigned_member_id)=$6)
             AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
             AND assigned_member_id IS NULL AND sdr_member_id IS NULL AND closer_member_id IS NULL
         ) unassigned_leads`,
      [
        session.tenantId,
        range.start.toISOString(),
        range.end.toISOString(),
        workspaceScope,
        session.userId,
        scopedMemberId
      ]
    )
  ]);

  const totals = summary.rows[0] ?? {
    scheduled: 0,
    completed: 0,
    no_show: 0,
    cancelled: 0,
    upcoming: 0,
    overdue: 0,
    due: 0,
    result_pending: 0,
    rescheduled: 0,
    proposals: 0,
    negotiations: 0,
    sales: 0,
    sold_value: "0",
    overdue_follow_ups: 0,
    average_quality: null
  };
  // Reuniões futuras não entram em comparecimento/no-show: o denominador é o que já venceu.
  const rate = (part: number, total: number) => (total ? Math.round((part / total) * 1_000) / 10 : 0);
  const attendanceRate = rate(totals.completed, totals.due);
  const noShowRate = rate(totals.no_show, totals.due);
  const closingRate = rate(totals.sales, totals.completed);
  const soldValue = Number(totals.sold_value ?? 0);
  const averageTicket = totals.sales ? Math.round((soldValue / totals.sales) * 100) / 100 : 0;
  const createdAppointments = created.rows[0]?.count ?? 0;
  const sdrTotals = sdr.rows[0] ?? {
    received: 0,attended: 0,qualified: 0,scheduled: 0,overdue_follow_ups: 0,
    recovered_no_shows: 0,average_first_response_minutes: null
  };
  const qualificationRate = rate(sdrTotals.qualified, sdrTotals.received);
  const schedulingRate = rate(sdrTotals.scheduled, sdrTotals.qualified);
  const newContacts = sdrTotals.received;
  const operationTotals = operations.rows[0] ?? {
    inbound_messages: 0, open_conversations: 0, handoffs: 0, unassigned_leads: 0
  };

  const cursorIndex = team.rows.findIndex((member) => member.member_id === team.rows[0]?.cursor_member_id);
  const nextMemberId = workspaceScope && team.rows.length
    ? team.rows[(cursorIndex + 1) % team.rows.length]?.member_id
    : null;

  return {
    scope: {
      type: caseScope.type,
      member_id: scopedMemberId,
      email: viewer?.email ?? session.email,
      is_closer: Boolean(viewer?.is_closer),
      is_attendant: Boolean(viewer?.is_closer),
      availability_status: viewer?.availability_status ?? null
    },
    period: {
      key: input.period,
      start: range.startKey,
      end: shiftDateKey(range.endKey, -1),
      timezone
    },
    result: {
      new_contacts: newContacts,
      appointments: createdAppointments,
      calls: totals.completed,
      no_show: totals.no_show,
      sales: totals.sales,
      sold_value: soldValue,
      average_ticket: averageTicket,
      due_meetings: totals.due,
      upcoming: totals.upcoming,
      result_pending: totals.result_pending
    },
    funnel: {
      lead_to_appointment: rate(createdAppointments, newContacts),
      appointment_to_attendance: attendanceRate,
      call_to_sale: closingRate,
      lead_to_sale: rate(totals.sales, newContacts),
      no_show_rate: noShowRate
    },
    operations: {
      inbound_messages: operationTotals.inbound_messages,
      open_conversations: operationTotals.open_conversations,
      handoffs: operationTotals.handoffs,
      average_first_response_minutes: sdrTotals.average_first_response_minutes
        ? Number(sdrTotals.average_first_response_minutes) : null,
      overdue_follow_ups: sdrTotals.overdue_follow_ups,
      unassigned_leads: operationTotals.unassigned_leads
    },
    metrics: {
      created: createdAppointments,
      scheduled: totals.scheduled,
      completed: totals.completed,
      no_show: totals.no_show,
      cancelled: totals.cancelled,
      upcoming: totals.upcoming,
      overdue: totals.overdue,
      result_pending: totals.result_pending,
      rescheduled: totals.rescheduled,
      proposals: totals.proposals,
      negotiations: totals.negotiations,
      sales: totals.sales,
      closing_rate: closingRate,
      sold_value: soldValue,
      average_ticket: averageTicket,
      overdue_follow_ups: totals.overdue_follow_ups,
      attendance_rate: attendanceRate,
      no_show_rate: noShowRate,
      average_quality: totals.average_quality ? Number(totals.average_quality) : null
    },
    sdr_metrics: {
      received: sdrTotals.received,
      attended: sdrTotals.attended,
      qualified: sdrTotals.qualified,
      scheduled: sdrTotals.scheduled,
      qualification_rate: qualificationRate,
      scheduling_rate: schedulingRate,
      average_first_response_minutes: sdrTotals.average_first_response_minutes
        ? Number(sdrTotals.average_first_response_minutes) : null,
      overdue_follow_ups: sdrTotals.overdue_follow_ups,
      recovered_no_shows: sdrTotals.recovered_no_shows
    },
    commercial_metrics: {
      scheduled: totals.scheduled,
      completed: totals.completed,
      attended: totals.completed,
      no_show: totals.no_show,
      rescheduled: totals.rescheduled,
      cancelled: totals.cancelled,
      result_pending: totals.result_pending,
      proposals: totals.proposals,
      negotiations: totals.negotiations,
      sales: totals.sales,
      attendance_rate: attendanceRate,
      closing_rate: closingRate,
      sold_value: soldValue,
      average_ticket: averageTicket,
      overdue_follow_ups: totals.overdue_follow_ups
    },
    series: series.rows,
    today_agenda: agenda.rows,
    team: team.rows.map((member) => ({
      member_id: member.member_id,
      user_id: member.user_id,
      email: member.email,
      name: member.name,
      active: member.active,
      period: member.period,
      completed: member.completed,
      no_show: member.no_show,
      sales: member.sales,
      sold_value: Number(member.sold_value ?? 0),
      closing_rate: rate(member.sales, member.completed),
      last_assigned_at: member.last_assigned_at,
      availability_status: member.availability_status,
      is_current: member.member_id === viewer?.member_id,
      is_next: member.member_id === nextMemberId
    }))
  };
}
