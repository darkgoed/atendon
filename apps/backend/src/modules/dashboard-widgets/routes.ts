import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { hasWorkspaceCaseAccess, resolveCaseScope } from "../../auth/case-scope.js";
import { requirePermission, type WorkspaceSession } from "../../auth/session.js";
import { db } from "../../db/client.js";
import { loadCommercialDashboard, type CommercialDashboardInput } from "../dashboard/service.js";
import { isCapabilityEnabled, isFeatureFlagEnabled, type CapabilityKey } from "../operations/feature-flags.js";
import {
  availableDashboardWidgets,
  dashboardLayoutFromPreset,
  DASHBOARD_PRESETS,
  DASHBOARD_PRESET_KEYS,
  DASHBOARD_WIDGET_KEYS,
  DASHBOARD_WIDGET_SIZES,
  defaultDashboardLayout,
  sanitizeDashboardLayout,
  validateDashboardLayout,
  type DashboardLayoutItem,
  type DashboardWidgetKey
} from "./catalog.js";
import { loadNewWidgetMetric } from "./metrics.js";

const widgetKeySchema = z.enum(DASHBOARD_WIDGET_KEYS);
const layoutItemSchema = z.object({
  key: widgetKeySchema,
  order: z.number().int().min(0).max(60),
  visible: z.boolean(),
  size: z.enum(DASHBOARD_WIDGET_SIZES)
}).strict();
const layoutBodySchema = z.object({ items: z.array(layoutItemSchema).max(DASHBOARD_WIDGET_KEYS.length) }).strict();
const widgetParamsSchema = z.object({ key: widgetKeySchema });
const presetParamsSchema = z.object({ key: z.enum(DASHBOARD_PRESET_KEYS) });
const dashboardQuerySchema = z.object({
  period: z.enum(["today", "week", "month", "custom"]).catch("today"),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

async function featureEnabled(session: WorkspaceSession, reply: FastifyReply) {
  if (await isFeatureFlagEnabled(db, session.tenantId, "dashboard_widgets_v1")) return true;
  await reply.status(409).send({
    error: "Dashboard personalizável temporariamente indisponível",
    code: "FEATURE_FLAG_DISABLED",
    feature: "dashboard_widgets_v1",
    fallback: "/dashboard"
  });
  return false;
}

const WIDGET_CAPABILITIES: Partial<Record<DashboardWidgetKey, CapabilityKey>> = {
  commercial_metrics: "appointments_v1",
  conversion_funnel: "appointments_v1",
  team_load: "appointments_v1",
  today_agenda: "appointments_v1",
  pipeline: "pipeline_v1",
  whatsapp_connection: "workspace_admin_v1",
  new_leads: "leads_v1",
  pending_follow_ups: "leads_v1",
  overdue_follow_ups: "leads_v1",
  leads_paid_traffic: "leads_v1",
  leads_referral: "leads_v1",
  leads_organic: "leads_v1",
  leads_other_sources: "leads_v1",
  appointments_count: "appointments_v1",
  attendances: "appointments_v1",
  no_shows: "appointments_v1",
  reschedules: "appointments_v1",
  attendance_rate: "appointments_v1",
  sales_count: "leads_v1",
  sales_value: "leads_v1",
  average_ticket: "leads_v1",
  lost_sales: "leads_v1",
  conversion_rate: "leads_v1",
  sales_paid_traffic: "leads_v1",
  sales_referral: "leads_v1",
  sales_organic: "leads_v1",
  sales_by_seller: "appointments_v1",
  sales_value_by_seller: "appointments_v1",
  conversion_by_seller: "appointments_v1"
};

async function widgetCatalog(session: WorkspaceSession) {
  const available = availableDashboardWidgets(session.permissions);
  const required = [...new Set(available.flatMap((widget) => {
    const capability = WIDGET_CAPABILITIES[widget.key];
    return capability ? [capability] : [];
  }))];
  const enabled = new Map<CapabilityKey, boolean>();
  await Promise.all(required.map(async (key) => {
    enabled.set(key, await isCapabilityEnabled(db, session.tenantId, key));
  }));
  return available.filter((widget) => {
    const capability = WIDGET_CAPABILITIES[widget.key];
    return !capability || enabled.get(capability) === true;
  });
}

async function saveLayout(session: WorkspaceSession, items: readonly DashboardLayoutItem[]) {
  await db.query(
    `INSERT INTO dashboard_layouts(workspace_id,user_id,items)
     VALUES($1,$2,$3::jsonb)
     ON CONFLICT(workspace_id,user_id) DO UPDATE SET
       items=EXCLUDED.items,updated_at=now()`,
    [session.tenantId, session.userId, JSON.stringify(items)]
  );
}

async function loadLayout(session: WorkspaceSession) {
  const catalog = await widgetCatalog(session);
  const result = await db.query<{ items: unknown }>(
    "SELECT items FROM dashboard_layouts WHERE workspace_id=$1 AND user_id=$2",
    [session.tenantId, session.userId]
  );
  if (!result.rows[0]) return { items: defaultDashboardLayout(catalog), source: "default" as const };
  const parsed = z.array(layoutItemSchema).safeParse(result.rows[0].items);
  const items = parsed.success
    ? sanitizeDashboardLayout(parsed.data, catalog)
    : defaultDashboardLayout(catalog);
  if (!parsed.success || JSON.stringify(items) !== JSON.stringify(result.rows[0].items)) {
    await saveLayout(session, items);
  }
  return { items, source: "saved" as const };
}

async function ensureWidgetAccess(session: WorkspaceSession, key: DashboardWidgetKey) {
  const capability = WIDGET_CAPABILITIES[key];
  if (capability && !await isCapabilityEnabled(db, session.tenantId, capability)) {
    throw Object.assign(new Error("Funcionalidade indisponível para esta empresa"), {
      statusCode: 409,
      code: "FEATURE_FLAG_DISABLED",
      feature: capability
    });
  }
  const widget = (await widgetCatalog(session)).find((candidate) => candidate.key === key);
  if (!widget) throw Object.assign(new Error("Widget não permitido"), { statusCode: 403 });
  return widget;
}

async function loadWidgetData(
  session: WorkspaceSession,
  key: DashboardWidgetKey,
  input: CommercialDashboardInput
): Promise<unknown> {
  const metric = await loadNewWidgetMetric(session, key, input);
  if (metric !== undefined) return metric;
  const scope = await resolveCaseScope(db, session);
  const workspaceScope = scope.type === "workspace";
  const caseParams = [session.tenantId, workspaceScope, session.userId];
  if (key === "whatsapp_connection") {
    return (await db.query(
      `SELECT status,last_connected_at,
              count(*) OVER ()::int total,
              count(*) FILTER (WHERE status='connected') OVER ()::int connected
       FROM whatsapp_sessions
       WHERE tenant_id=$1 AND channel='whatsapp' AND archived_at IS NULL
       ORDER BY is_primary DESC, created_at DESC LIMIT 1`,
      [session.tenantId]
    )).rows[0] ?? { status: "disconnected", last_connected_at: null, total: 0, connected: 0 };
  }
  if (key === "open_conversations") {
    return (await db.query(
      `SELECT count(*) FILTER (WHERE status='open')::int open,
              count(*) FILTER (WHERE status='open' AND ai_active=true)::int ai_open,
              count(*) FILTER (WHERE status='closed' AND resolved_at >= date_trunc('day',now()))::int resolved_today
       FROM conversations
       WHERE tenant_id=$1 AND ($2::boolean OR assigned_user_id=$3)`,
      caseParams
    )).rows[0];
  }
  if (key === "handoffs") {
    const [summary, items] = await Promise.all([
      db.query(
        `SELECT count(*)::int total,
                count(*) FILTER (WHERE assigned_user_id IS NULL)::int unassigned,
                count(*) FILTER (WHERE last_message_at < now() - interval '15 minutes')::int over_sla,
                COALESCE(floor(extract(epoch FROM (now()-min(last_message_at)))/60),0)::int oldest_minutes
         FROM conversations
         WHERE tenant_id=$1 AND ($2::boolean OR assigned_user_id=$3)
           AND status='open' AND ai_active=false AND handoff_reason IS DISTINCT FROM 'manually_paused'`,
        caseParams
      ),
      db.query(
        `SELECT id,contact_name,contact_phone,
                floor(extract(epoch FROM (now()-last_message_at))/60)::int waiting_minutes
         FROM conversations
         WHERE tenant_id=$1 AND ($2::boolean OR assigned_user_id=$3)
           AND status='open' AND ai_active=false AND handoff_reason IS DISTINCT FROM 'manually_paused'
         ORDER BY last_message_at LIMIT 5`,
        caseParams
      )
    ]);
    return { ...summary.rows[0], items: items.rows };
  }
  if (key === "messages_today") {
    return (await db.query(
      `SELECT count(*)::int today
       FROM messages message JOIN conversations conversation ON conversation.id=message.conversation_id
       WHERE conversation.tenant_id=$1 AND ($2::boolean OR conversation.assigned_user_id=$3)
         AND message.created_at >= date_trunc('day',now())`,
      caseParams
    )).rows[0];
  }
  if (key === "pipeline") {
    return {
      stages: (await db.query(
        `SELECT stage.id,stage.name,stage.color,stage.position,stage.capacity_target,
                stage.technical_status AS status,count(lead.id)::int count
         FROM pipeline_stages stage
         LEFT JOIN scheduling_leads lead
           ON lead.tenant_id=stage.tenant_id
          AND lead.pipeline_stage_id=stage.id
          AND ($2::boolean OR lead.assigned_member_id=$3)
         WHERE stage.tenant_id=$1 AND stage.archived_at IS NULL
         GROUP BY stage.id,stage.name,stage.color,stage.position,
                  stage.capacity_target,stage.technical_status
         ORDER BY stage.position,stage.id`,
        [session.tenantId, workspaceScope, scope.type === "mine" ? scope.memberId : null]
      )).rows
    };
  }
  if (key === "recent_alerts") {
    const appointmentsEnabled = await isCapabilityEnabled(db, session.tenantId, "appointments_v1");
    const rootMembership = session.isRoot
      ? await db.query(
          `SELECT 1 FROM workspace_members
           WHERE workspace_id=$1 AND user_id=$2 AND status='active'`,
          [session.tenantId, session.userId]
        )
      : null;
    const canReadWorkspaceAlerts = hasWorkspaceCaseAccess(session)
      && !(session.isRoot && !rootMembership?.rows[0]);
    return {
      items: (await db.query(
        `SELECT alert.id,alert.kind,alert.message,alert.created_at
         FROM system_alerts alert
         LEFT JOIN system_alert_receipts receipt
           ON receipt.alert_id=alert.id AND receipt.tenant_id=alert.tenant_id AND receipt.user_id=$2
         WHERE alert.tenant_id=$1
           AND (receipt.user_id IS NOT NULL OR ($3::boolean AND alert.audience='workspace'))
           AND ($4::boolean OR alert.kind <> 'meeting')
         ORDER BY alert.created_at DESC LIMIT 5`,
        [session.tenantId, session.userId, canReadWorkspaceAlerts, appointmentsEnabled]
      )).rows
    };
  }
  const commercial = await loadCommercialDashboard(session, input);
  if (key === "today_agenda") return { items: commercial.today_agenda, period: commercial.period };
  if (key === "team_load") return { members: commercial.team, scope: commercial.scope, period: commercial.period };
  if (key === "conversion_funnel") {
    return { funnel: commercial.funnel, result: commercial.result, period: commercial.period };
  }
  if (key === "operations_summary") {
    return { operations: commercial.operations, period: commercial.period };
  }
  return {
    result: commercial.result,
    funnel: commercial.funnel,
    metrics: commercial.metrics,
    sdr_metrics: commercial.sdr_metrics,
    commercial_metrics: commercial.commercial_metrics,
    series: commercial.series,
    period: commercial.period
  };
}

export async function registerDashboardWidgetRoutes(app: FastifyInstance) {
  app.get("/dashboard/widgets/catalog", async (request, reply) => {
    const session = await requirePermission(request, "dashboard.read");
    if (!await featureEnabled(session, reply)) return;
    const catalog = await widgetCatalog(session);
    return {
      widgets: catalog.map(({ key, label, description, group, sizes, defaultSize, selectable }) => ({
        key,label,description,group,sizes,default_size: defaultSize,selectable: selectable !== false
      })),
      default_layout: defaultDashboardLayout(catalog)
    };
  });

  app.get("/dashboard/widgets/layout", async (request, reply) => {
    const session = await requirePermission(request, "dashboard.read");
    if (!await featureEnabled(session, reply)) return;
    return { layout: await loadLayout(session) };
  });

  app.put("/dashboard/widgets/layout", async (request, reply) => {
    const session = await requirePermission(request, "dashboard.read");
    if (!await featureEnabled(session, reply)) return;
    const body = layoutBodySchema.parse(request.body);
    const items = validateDashboardLayout(body.items, await widgetCatalog(session));
    await saveLayout(session, items);
    return { layout: { items, source: "saved" as const } };
  });

  app.delete("/dashboard/widgets/layout", async (request, reply) => {
    const session = await requirePermission(request, "dashboard.read");
    if (!await featureEnabled(session, reply)) return;
    await db.query(
      "DELETE FROM dashboard_layouts WHERE workspace_id=$1 AND user_id=$2",
      [session.tenantId, session.userId]
    );
    return { layout: { items: defaultDashboardLayout(await widgetCatalog(session)), source: "default" as const } };
  });

  app.get("/dashboard/widgets/presets", async (request, reply) => {
    const session = await requirePermission(request, "dashboard.read");
    if (!await featureEnabled(session, reply)) return;
    const allowed = new Set((await widgetCatalog(session)).map((widget) => widget.key));
    return {
      presets: DASHBOARD_PRESET_KEYS.map((key) => ({
        key,
        label: DASHBOARD_PRESETS[key].label,
        description: DASHBOARD_PRESETS[key].description,
        keys: DASHBOARD_PRESETS[key].keys.filter((widgetKey) => allowed.has(widgetKey))
      }))
    };
  });

  app.post("/dashboard/widgets/presets/:key", async (request, reply) => {
    const session = await requirePermission(request, "dashboard.read");
    if (!await featureEnabled(session, reply)) return;
    const { key } = presetParamsSchema.parse(request.params);
    const items = dashboardLayoutFromPreset(key, await widgetCatalog(session));
    await saveLayout(session, items);
    return { items };
  });

  app.get("/dashboard/widgets/:key", async (request, reply) => {
    const session = await requirePermission(request, "dashboard.read");
    if (!await featureEnabled(session, reply)) return;
    const { key } = widgetParamsSchema.parse(request.params);
    await ensureWidgetAccess(session, key);
    const query = dashboardQuerySchema.parse(request.query);
    return { key, data: await loadWidgetData(session, key, query) };
  });
}
