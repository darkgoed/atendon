import type { WorkspaceSession } from "../../auth/session.js";
import { resolveCaseScope } from "../../auth/case-scope.js";
import { db } from "../../db/client.js";
import type { CommercialDashboardInput } from "../dashboard/service.js";
import { resolveReportingRange } from "../reporting.js";
import type { DashboardWidgetKey } from "./catalog.js";

type NumericMetric = { value: number; currency?: "BRL" };
type TeamMetric = { items: Array<{ member_id: string; name: string; value: number }>; currency?: "BRL" };
type NewMetric = NumericMetric | TeamMetric;

const CONVERSATION_KEYS = new Set<DashboardWidgetKey>(["conversations_started", "active_conversations"]);
const LEAD_KEYS = new Set<DashboardWidgetKey>([
  "new_leads", "pending_follow_ups", "overdue_follow_ups",
  "leads_paid_traffic", "leads_referral", "leads_organic", "leads_other_sources"
]);
const APPOINTMENT_KEYS = new Set<DashboardWidgetKey>([
  "appointments_count", "attendances", "no_shows", "reschedules", "attendance_rate"
]);
const SALES_KEYS = new Set<DashboardWidgetKey>([
  "sales_count", "sales_value", "average_ticket", "lost_sales", "conversion_rate",
  "sales_paid_traffic", "sales_referral", "sales_organic"
]);
const TEAM_KEYS = new Set<DashboardWidgetKey>([
  "sales_by_seller", "sales_value_by_seller", "conversion_by_seller"
]);

function finite(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function memberName(member: { name: string | null; email: string }): string {
  return member.name?.trim() || member.email.split("@")[0] || member.email;
}

async function reportingContext(session: WorkspaceSession, input: CommercialDashboardInput) {
  const [tenant, scope] = await Promise.all([
    db.query<{ timezone: string }>("SELECT timezone FROM tenants WHERE id=$1", [session.tenantId]),
    resolveCaseScope(db, session)
  ]);
  const range = resolveReportingRange(tenant.rows[0]?.timezone ?? "UTC", input);
  return { range, scope, workspaceScope: scope.type === "workspace" };
}

async function loadConversationMetric(
  session: WorkspaceSession,
  key: DashboardWidgetKey,
  input: CommercialDashboardInput
): Promise<NumericMetric> {
  const { range, scope, workspaceScope } = await reportingContext(session, input);
  const row = (await db.query<{ started: number; active: number }>(
    `SELECT
       count(*) FILTER (WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz)::int started,
       count(*) FILTER (WHERE status='open')::int active
     FROM conversations
     WHERE tenant_id=$1 AND ($4::boolean OR assigned_user_id=$5)`,
    [session.tenantId, range.start.toISOString(), range.end.toISOString(), workspaceScope, scope.userId]
  )).rows[0];
  return { value: key === "conversations_started" ? finite(row?.started) : finite(row?.active) };
}

async function loadLeadMetric(
  session: WorkspaceSession,
  key: DashboardWidgetKey,
  input: CommercialDashboardInput
): Promise<NumericMetric> {
  const { range, scope, workspaceScope } = await reportingContext(session, input);
  const row = (await db.query<Record<string, number>>(
    `WITH scoped AS (
       SELECT lead.*,
              CASE
                -- Origem é exclusiva: atribuição paga vence indicação e orgânico.
                WHEN lower(coalesce(lead.source,''))='facebook'
                  OR coalesce(lead.facebook_attribution,'{}'::jsonb) <> '{}'::jsonb THEN 'paid'
                WHEN lead.source ILIKE 'indica%' THEN 'referral'
                WHEN lower(coalesce(lead.source,'')) IN ('whatsapp','organico') THEN 'organic'
                ELSE 'other'
              END source_group
       FROM scheduling_leads lead
       WHERE lead.tenant_id=$1 AND lead.deleted_at IS NULL AND ($4::boolean OR lead.assigned_member_id=$5)
     )
     SELECT
       count(*) FILTER (WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz)::int new_leads,
       count(*) FILTER (WHERE next_action_at >= now())::int pending_follow_ups,
       count(*) FILTER (WHERE next_action_at < now())::int overdue_follow_ups,
       count(*) FILTER (WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz AND source_group='paid')::int leads_paid_traffic,
       count(*) FILTER (WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz AND source_group='referral')::int leads_referral,
       count(*) FILTER (WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz AND source_group='organic')::int leads_organic,
       count(*) FILTER (WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz AND source_group='other')::int leads_other_sources
     FROM scoped`,
    [session.tenantId, range.start.toISOString(), range.end.toISOString(), workspaceScope, scope.memberId]
  )).rows[0];
  return { value: finite(row?.[key]) };
}

async function loadAppointmentMetric(
  session: WorkspaceSession,
  key: DashboardWidgetKey,
  input: CommercialDashboardInput
): Promise<NumericMetric> {
  const { range, scope, workspaceScope } = await reportingContext(session, input);
  const row = (await db.query<{ scheduled: number; completed: number; no_show: number; rescheduled: number; due: number }>(
    `SELECT
       count(*) FILTER (WHERE a.status <> 'cancelado')::int scheduled,
       count(*) FILTER (WHERE a.status='concluido')::int completed,
       count(*) FILTER (WHERE a.status='no_show')::int no_show,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM scheduling_lead_events event
         WHERE event.tenant_id=a.tenant_id AND event.lead_id=a.lead_id
           AND event.event_type='agendamento_reagendado'
           AND event.details->>'appointment_id'=a.id::text
       ))::int rescheduled,
       count(*) FILTER (WHERE a.status <> 'cancelado' AND a.end_at < now())::int due
     FROM scheduling_appointments a
     WHERE a.tenant_id=$1 AND a.start_at >= $2::timestamptz AND a.start_at < $3::timestamptz
       AND ($4::boolean OR a.assigned_member_id=$5)`,
    [session.tenantId, range.start.toISOString(), range.end.toISOString(), workspaceScope, scope.memberId]
  )).rows[0] ?? { scheduled: 0, completed: 0, no_show: 0, rescheduled: 0, due: 0 };
  const scheduled = finite(row.scheduled);
  const completed = finite(row.completed);
  const values: Partial<Record<DashboardWidgetKey, number>> = {
    appointments_count: scheduled,
    attendances: completed,
    no_shows: finite(row.no_show),
    reschedules: finite(row.rescheduled),
    attendance_rate: row.due ? Math.round((completed / row.due) * 1_000) / 10 : 0
  };
  return { value: finite(values[key]) };
}

async function loadSalesMetric(
  session: WorkspaceSession,
  key: DashboardWidgetKey,
  input: CommercialDashboardInput
): Promise<NumericMetric> {
  const { range, scope, workspaceScope } = await reportingContext(session, input);
  const row = (await db.query<Record<string, number | string>>(
    `WITH scoped_sales AS (
       SELECT lead.status,lead.commercial_outcome,lead.sale_value,
              CASE
                WHEN lower(coalesce(lead.source,''))='facebook'
                  OR coalesce(lead.facebook_attribution,'{}'::jsonb) <> '{}'::jsonb THEN 'paid'
                WHEN lead.source ILIKE 'indica%' THEN 'referral'
                WHEN lower(coalesce(lead.source,'')) IN ('whatsapp','organico') THEN 'organic'
                ELSE 'other'
              END source_group
       FROM scheduling_leads lead
       WHERE lead.tenant_id=$1 AND lead.deleted_at IS NULL
         AND lead.commercial_updated_at >= $2::timestamptz
         AND lead.commercial_updated_at < $3::timestamptz
         AND ($4::boolean OR lead.assigned_member_id=$6)
     ), totals AS (
       SELECT count(*) FILTER (WHERE commercial_outcome='fechado')::int sales_count,
              count(*) FILTER (WHERE status='perdido')::int lost_sales,
              COALESCE(round(sum(sale_value) FILTER (WHERE commercial_outcome='fechado') * 100),0)::text sales_value,
              COALESCE(round(
                (sum(sale_value) FILTER (WHERE commercial_outcome='fechado')
                  / NULLIF(count(*) FILTER (WHERE commercial_outcome='fechado'),0)) * 100
              ),0)::text average_ticket,
              count(*) FILTER (WHERE commercial_outcome='fechado' AND source_group='paid')::int sales_paid_traffic,
              count(*) FILTER (WHERE commercial_outcome='fechado' AND source_group='referral')::int sales_referral,
              count(*) FILTER (WHERE commercial_outcome='fechado' AND source_group='organic')::int sales_organic
       FROM scoped_sales
     ), conversations_started AS (
       SELECT count(*)::int value
       FROM conversations conversation
       WHERE conversation.tenant_id=$1
         AND conversation.created_at >= $2::timestamptz
         AND conversation.created_at < $3::timestamptz
         AND ($4::boolean OR conversation.assigned_user_id=$5)
     )
     SELECT totals.*,
            COALESCE(round(100.0 * totals.sales_count / NULLIF(conversations_started.value,0),1),0)::text conversion_rate
     FROM totals CROSS JOIN conversations_started`,
    [
      session.tenantId, range.start.toISOString(), range.end.toISOString(), workspaceScope,
      scope.userId, scope.memberId
    ]
  )).rows[0];
  const monetary = key === "sales_value" || key === "average_ticket";
  return { value: finite(row?.[key]), ...(monetary ? { currency: "BRL" as const } : {}) };
}

async function loadSalesValueBySeller(
  session: WorkspaceSession,
  input: CommercialDashboardInput
): Promise<TeamMetric> {
  const { range, scope, workspaceScope } = await reportingContext(session, input);
  const rows = (await db.query<{ member_id: string; email: string; name: string | null; value: string }>(
    `SELECT member.id member_id,"user".email,"user".name,
            COALESCE(round(sum(appointment.sale_value) FILTER (
              WHERE appointment.start_at >= $2::timestamptz AND appointment.start_at < $3::timestamptz
                AND appointment.commercial_outcome='fechado'
            ) * 100),0)::text value
     FROM scheduling_google_meet_closers closer
     JOIN workspace_members member
       ON member.id=closer.member_id AND member.workspace_id=closer.tenant_id AND member.status='active'
     JOIN users "user" ON "user".id=member.user_id AND "user".status='active'
     LEFT JOIN scheduling_appointments appointment
       ON appointment.tenant_id=closer.tenant_id AND appointment.assigned_member_id=member.id
     WHERE closer.tenant_id=$1 AND ($4::boolean OR member.id=$5)
     GROUP BY member.id,"user".email,"user".name,closer.created_at
     ORDER BY closer.created_at,member.id`,
    [session.tenantId, range.start.toISOString(), range.end.toISOString(), workspaceScope, scope.memberId]
  )).rows;
  return {
    items: rows.map((row) => ({ member_id: row.member_id, name: memberName(row), value: finite(row.value) })),
    currency: "BRL"
  };
}

async function loadTeamMetric(
  session: WorkspaceSession,
  key: DashboardWidgetKey,
  input: CommercialDashboardInput
): Promise<TeamMetric> {
  if (key === "sales_value_by_seller") return loadSalesValueBySeller(session, input);
  const { range, scope, workspaceScope } = await reportingContext(session, input);
  const rows = (await db.query<{ member_id: string; email: string; name: string | null; completed: number; sales: number }>(
    `SELECT member.id member_id,"user".email,"user".name,
            count(appointment.id) FILTER (WHERE appointment.start_at >= $2::timestamptz AND appointment.start_at < $3::timestamptz AND appointment.status='concluido')::int completed,
            count(appointment.id) FILTER (WHERE appointment.start_at >= $2::timestamptz AND appointment.start_at < $3::timestamptz AND appointment.commercial_outcome='fechado')::int sales
     FROM scheduling_google_meet_closers closer
     JOIN workspace_members member ON member.id=closer.member_id AND member.workspace_id=closer.tenant_id AND member.status='active'
     JOIN users "user" ON "user".id=member.user_id AND "user".status='active'
     LEFT JOIN scheduling_appointments appointment ON appointment.tenant_id=closer.tenant_id AND appointment.assigned_member_id=member.id
     WHERE closer.tenant_id=$1 AND ($4::boolean OR member.id=$5)
     GROUP BY member.id,"user".email,"user".name,closer.created_at
     ORDER BY closer.created_at,member.id`,
    [session.tenantId, range.start.toISOString(), range.end.toISOString(), workspaceScope, scope.memberId]
  )).rows;
  return {
    items: rows.map((member) => ({
      member_id: member.member_id,
      name: memberName(member),
      value: key === "sales_by_seller" ? finite(member.sales) : member.completed ? Math.round((member.sales / member.completed) * 1_000) / 10 : 0
    }))
  };
}

/**
 * Contagens de conversas/leads usam created_at; agendamentos usam start_at e
 * vendas usam commercial_updated_at. active e follow-ups pending/overdue são
 * snapshots atuais, portanto não são cortados pelo período selecionado.
 */
export async function loadNewWidgetMetric(
  session: WorkspaceSession,
  key: DashboardWidgetKey,
  input: CommercialDashboardInput
): Promise<NewMetric | undefined> {
  if (CONVERSATION_KEYS.has(key)) return loadConversationMetric(session, key, input);
  if (LEAD_KEYS.has(key)) return loadLeadMetric(session, key, input);
  if (APPOINTMENT_KEYS.has(key)) return loadAppointmentMetric(session, key, input);
  if (SALES_KEYS.has(key)) return loadSalesMetric(session, key, input);
  if (TEAM_KEYS.has(key)) return loadTeamMetric(session, key, input);
  return undefined;
}
