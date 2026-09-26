import { db } from "../db/client.js";
import type { PoolClient } from "pg";
import type { EffectiveEntitlements, SubscriptionStatus } from "./types.js";
import { featureNotAvailableError } from "./errors.js";

type Q = Pick<PoolClient, "query">;
type SubscriptionRow = { status: SubscriptionStatus; current_period_start: Date | null; current_period_end: Date | null; plan_id: string; plan_code: string; plan_name: string };
type CatalogRow = { feature_key: string; category: string; is_future: boolean };
type LimitCatalogRow = { limit_key: string };
type FeatureRow = { feature_key: string; enabled: boolean };
type LimitRow = { limit_key: string; limit_value: string | null };
type OverrideRow = { kind: string; entitlement_key: string; bool_value: boolean | null; int_value: string | null };
type UsageRow = { used: string };
const open = new Set<SubscriptionStatus>(["ACTIVE", "TRIALING", "PAST_DUE", "GRACE_PERIOD"]);
const query = (client?: Q) => client ?? db;

export async function getEffectiveEntitlements(tenantId: string, client?: Q): Promise<EffectiveEntitlements> {
  const c = query(client);
  const sub = await c.query<SubscriptionRow>(`SELECT s.status,s.current_period_start,s.current_period_end,p.id plan_id,p.code plan_code,p.name plan_name
    FROM tenant_subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.tenant_id=$1`, [tenantId]);
  const [catalog, limitCatalog] = await Promise.all([
    c.query<CatalogRow>(`SELECT feature_key,category,is_future FROM feature_catalog`),
    c.query<LimitCatalogRow>(`SELECT limit_key FROM limit_catalog`)
  ]);
  if (!sub.rows[0]) {
    console.warn(`[billing] tenant ${tenantId} sem assinatura; usando LEGACY_UNLIMITED`);
    const features: Record<string, boolean> = {};
    const limits: Record<string, number | null> = {};
    for (const f of catalog.rows) if (!f.is_future) features[f.feature_key] = true;
    for (const l of limitCatalog.rows) limits[l.limit_key] = null;
    return { features, limits, planCode: "LEGACY_UNLIMITED", planName: "Legacy Unlimited", status: "ACTIVE", periodStart: null, periodEnd: null };
  }
  const s = sub.rows[0];
  const [features, limits, overrides] = await Promise.all([
    c.query<FeatureRow>(`SELECT feature_key,enabled FROM plan_features WHERE plan_id=$1`, [s.plan_id]),
    c.query<LimitRow>(`SELECT limit_key,limit_value FROM plan_limits WHERE plan_id=$1`, [s.plan_id]),
    c.query<OverrideRow>(`SELECT kind,entitlement_key,bool_value,int_value FROM tenant_entitlement_overrides WHERE tenant_id=$1 AND (expires_at IS NULL OR expires_at>now())`, [tenantId])
  ]);
  const fs: Record<string, boolean> = {};
  const ls: Record<string, number | null> = {};
  for (const f of catalog.rows) if (!f.is_future) fs[f.feature_key] = false;
  for (const l of limitCatalog.rows) ls[l.limit_key] = null;
  for (const r of features.rows) {
    const meta = catalog.rows.find((x: CatalogRow) => x.feature_key === r.feature_key);
    if (meta && !meta.is_future) fs[r.feature_key] = Boolean(r.enabled) && (open.has(s.status) || meta.category === "core");
  }
  for (const r of limits.rows) ls[r.limit_key] = r.limit_value == null ? null : Number(r.limit_value);
  for (const r of overrides.rows) {
    const key = r.entitlement_key;
    const meta = catalog.rows.find((f: CatalogRow) => f.feature_key === key);
    if (r.kind === "feature" && meta && !meta.is_future) fs[key] = Boolean(r.bool_value) && (open.has(s.status) || meta.category === "core");
    if (r.kind === "limit" && key in ls) ls[key] = r.int_value == null ? null : Number(r.int_value);
  }
  return { features: fs, limits: ls, planCode: s.plan_code, planName: s.plan_name, status: s.status, periodStart: s.current_period_start, periodEnd: s.current_period_end };
}
export async function can(tenantId: string, featureKey: string) { return (await getEffectiveEntitlements(tenantId)).features[featureKey] === true; }
export async function getLimit(tenantId: string, limitKey: string) { return (await getEffectiveEntitlements(tenantId)).limits[limitKey] ?? null; }
export async function getUsage(tenantId: string, metricKey: string) {
  if (metricKey === "MAX_AI_INTERACTIONS" || metricKey === "MAX_AI_CREDITS") {
    const r = await db.query<{ used: string }>(`SELECT COALESCE(included_usage,0)+COALESCE(rollover_usage,0)+COALESCE(bonus_usage,0)+COALESCE(overage_usage,0) AS used
      FROM usage_periods WHERE tenant_id=$1 AND status='OPEN'`, [tenantId]);
    return Number(r.rows[0]?.used ?? 0);
  }
  const r = await db.query<UsageRow>(`SELECT COALESCE(used,0) used FROM usage_counters WHERE tenant_id=$1 AND metric_key=$2 AND period_start=(SELECT current_period_start FROM tenant_subscriptions WHERE tenant_id=$1)`, [tenantId, metricKey]);
  return Number(r.rows[0]?.used ?? 0);
}
export async function hasReachedLimit(tenantId: string, limitKey: string) { const [l, u] = await Promise.all([getLimit(tenantId, limitKey), getUsage(tenantId, limitKey)]); return l !== null && u >= l; }
export async function assertFeature(tenantId: string, featureKey: string) { if (await can(tenantId, featureKey)) return; const r = await db.query<{ code: string }>(`SELECT DISTINCT p.code FROM plans p JOIN plan_features f ON f.plan_id=p.id WHERE f.feature_key=$1 AND f.enabled=true`, [featureKey]); throw featureNotAvailableError(featureKey, r.rows.map(x => x.code)); }
