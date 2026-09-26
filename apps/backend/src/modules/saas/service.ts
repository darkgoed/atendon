import type { PoolClient } from "pg";
type SubscriptionRow = Record<string, unknown> & { id: string; plan_id: string; status: SubscriptionStatus };
type PlanRow = { id: string; code: string; name: string; billing_period_months: number };
type CountRow = { used: string };
import { db } from "../../db/client.js";
import { getEffectiveEntitlements } from "../../billing/entitlements.js";
import { truncateRolloverToPlanCap } from "../../billing/rollover.js";
import type { SubscriptionStatus } from "../../billing/types.js";

export const STATUSES: SubscriptionStatus[] = ["TRIALING", "ACTIVE", "PAST_DUE", "GRACE_PERIOD", "SUSPENDED", "CANCELED", "EXPIRED"];
async function audit(c: PoolClient, actor: string, tenant: string | null, action: string, type: string, id: string | null, before: unknown, after: unknown) {
  await c.query(`INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata) VALUES($1,$2,'root',$3,$4,$5,$6)`, [actor, tenant, action, type, id, { before, after }]);
}
async function mutate(tenantId: string, actorUserId: string, action: string, fn: (c: PoolClient, s: SubscriptionRow) => Promise<unknown>) {
  const c = await db.connect(); try { await c.query("BEGIN"); const q = await c.query<SubscriptionRow>("SELECT * FROM tenant_subscriptions WHERE tenant_id=$1 FOR UPDATE", [tenantId]); if (!q.rows[0]) throw Object.assign(new Error("Assinatura não encontrada"), { statusCode: 404 }); const out = await fn(c, q.rows[0]); await c.query("COMMIT"); return out; } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}
export async function changePlan(tenantId: string, planId: string, actorUserId: string) {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const tenant = await c.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [tenantId]);
    if (!tenant.rows[0]) throw Object.assign(new Error("Workspace não encontrado"), { statusCode: 404 });
    const p = await c.query<PlanRow>("SELECT id,code,name,billing_period_months FROM plans WHERE id=$1 AND status='active'", [planId]);
    if (!p.rows[0]) throw Object.assign(new Error("Plano não encontrado"), { statusCode: 404 });
    const existing = await c.query<SubscriptionRow>("SELECT * FROM tenant_subscriptions WHERE tenant_id=$1 FOR UPDATE", [tenantId]);
    const before = existing.rows[0] ?? null;
    let subscription: SubscriptionRow;
    if (before) {
      await c.query("UPDATE tenant_subscriptions SET plan_id=$1,updated_at=now() WHERE id=$2", [planId, before.id]);
      if (before.plan_id !== planId) await truncateRolloverToPlanCap(c, tenantId, planId);
      subscription = { ...before, plan_id: planId };
    } else {
      const created = await c.query<SubscriptionRow>("INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) VALUES($1,$2,'ACTIVE',now(),now() + make_interval(months => $3)) RETURNING *", [tenantId, planId, p.rows[0].billing_period_months]);
      subscription = created.rows[0];
    }
    await c.query("INSERT INTO subscription_events(tenant_id,subscription_id,event_type,from_plan_id,to_plan_id,from_status,to_status,actor_user_id,metadata) VALUES($1,$2,'PLAN_CHANGED',$3,$4,$5,$6,$7,$8)", [tenantId, subscription.id, before?.plan_id ?? null, planId, before?.status ?? null, subscription.status, actorUserId, { provisioned: !before }]);
    const out = { ...subscription, plan_code: p.rows[0].code, plan_name: p.rows[0].name };
    await audit(c, actorUserId, tenantId, "saas.subscription.change_plan", "subscription", subscription.id, before, out);
    await c.query("COMMIT");
    return out;
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}
export async function changeStatus(tenantId: string, status: SubscriptionStatus, actorUserId: string) { return mutate(tenantId, actorUserId, `saas.subscription.${status.toLowerCase()}`, async (c, s) => { const activate = status === "ACTIVE" && s.status !== "ACTIVE"; const plan = activate ? await c.query<PlanRow>("SELECT billing_period_months FROM plans WHERE id=$1", [s.plan_id]) : null; await c.query("UPDATE tenant_subscriptions SET status=$1,current_period_start=CASE WHEN $2 AND (current_period_end IS NULL OR current_period_end <= now()) THEN now() ELSE current_period_start END,current_period_end=CASE WHEN $2 AND (current_period_end IS NULL OR current_period_end <= now()) THEN now()+make_interval(months => $3) ELSE current_period_end END,grace_period_ends_at=CASE WHEN $2 THEN NULL ELSE grace_period_ends_at END,canceled_at=CASE WHEN $1='CANCELED' THEN now() ELSE canceled_at END,suspended_at=CASE WHEN $1='SUSPENDED' THEN now() ELSE suspended_at END,updated_at=now() WHERE id=$4", [status, activate, plan?.rows[0]?.billing_period_months ?? 1, s.id]); await c.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,from_plan_id,to_plan_id,from_status,to_status,actor_user_id,metadata) VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8)`, [tenantId, s.id, status, s.plan_id, s.status, status, actorUserId, { reactivated_period_renewed: activate }]); return { ...s, status }; }); }
export async function getOverLimitReport(tenantId: string) {
  const e = await getEffectiveEntitlements(tenantId);
  const [users, whatsapp, ai] = await Promise.all([
    db.query<CountRow>("SELECT count(*)::bigint AS used FROM workspace_members WHERE workspace_id=$1 AND status='active'", [tenantId]),
    db.query<CountRow>("SELECT count(*)::bigint AS used FROM whatsapp_sessions WHERE tenant_id=$1 AND channel='whatsapp' AND archived_at IS NULL", [tenantId]),
    // O consumo de IA vem do período OPEN (mesma fonte da cobrança), na unidade
    // do período: créditos normalizados nunca são convertidos de interações antigas.
    e.periodStart ? db.query<{ usage_unit: string; used: string }>("SELECT usage_unit,COALESCE(included_usage,0)+COALESCE(rollover_usage,0)+COALESCE(bonus_usage,0)+COALESCE(overage_usage,0) AS used FROM usage_periods WHERE tenant_id=$1 AND status='OPEN'", [tenantId]) : Promise.resolve({ rows: [] as { usage_unit: string; used: string }[] })
  ]);
  const aiRow = ai.rows[0];
  const usage = { MAX_USERS: Number(users.rows[0]?.used ?? 0), MAX_WHATSAPP_CONNECTIONS: Number(whatsapp.rows[0]?.used ?? 0), MAX_AI_INTERACTIONS: aiRow && aiRow.usage_unit === "INTERACTION" ? Number(aiRow.used) : 0, MAX_AI_CREDITS: aiRow && aiRow.usage_unit === "CREDIT" ? Number(aiRow.used) : 0 };
  return Object.keys(usage).filter((key) => e.limits[key] !== null && usage[key as keyof typeof usage] > Number(e.limits[key]));
}
