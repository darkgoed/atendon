import type { PoolClient } from "pg";
import { planLimitReachedError } from "./errors.js";


type SubscriptionIdRow = { plan_id: string };
type BoolRow = { is_enforced: boolean };
type IntRow = { int_value: string | null };
type UsedRow = { used: string };
type Row = { id: string; plan_id: string; plan_name: string; limit_value: number | null; is_enforced: boolean };
export async function assertLimitWithinTransaction(client: PoolClient, tenantId: string, limitKey: string, delta = 1): Promise<void> {
  const sub = await client.query<SubscriptionIdRow>("SELECT id,plan_id FROM tenant_subscriptions WHERE tenant_id=$1 FOR UPDATE", [tenantId]);
  if (!sub.rows[0]) return;
  const r = await client.query<Row>(`SELECT p.name plan_name, l.limit_value, c.is_enforced FROM plans p LEFT JOIN plan_limits l ON l.plan_id=p.id AND l.limit_key=$2 JOIN limit_catalog c ON c.limit_key=$2 WHERE p.id=$1`, [sub.rows[0].plan_id, limitKey]);
  const catalog = await client.query<BoolRow>("SELECT is_enforced FROM limit_catalog WHERE limit_key=$1", [limitKey]);
  if (!catalog.rows[0]?.is_enforced) return;
  const override = await client.query<IntRow>("SELECT int_value FROM tenant_entitlement_overrides WHERE tenant_id=$1 AND kind='limit' AND entitlement_key=$2 AND (expires_at IS NULL OR expires_at>now())", [tenantId, limitKey]);
  const max = override.rows[0]?.int_value != null ? Number(override.rows[0].int_value) : r.rows[0]?.limit_value == null ? null : Number(r.rows[0].limit_value);
  if (max === null) return;
  let usage = 0;
  if (limitKey === "MAX_USERS") { const x = await client.query<UsedRow>("SELECT count(*)::int used FROM workspace_members WHERE workspace_id=$1 AND status='active'", [tenantId]); usage = Number(x.rows[0].used); }
  else if (limitKey === "MAX_WHATSAPP_CONNECTIONS") { const x = await client.query<UsedRow>("SELECT count(*)::int used FROM whatsapp_sessions WHERE tenant_id=$1 AND channel='whatsapp' AND archived_at IS NULL", [tenantId]); usage = Number(x.rows[0].used); }
  else if (limitKey === "MAX_AI_INTERACTIONS") { const x = await client.query<UsedRow>("SELECT COALESCE(included_usage,0)+COALESCE(rollover_usage,0)+COALESCE(bonus_usage,0)+COALESCE(overage_usage,0) used FROM usage_periods WHERE tenant_id=$1 AND status='OPEN'", [tenantId]); usage = Number(x.rows[0]?.used ?? 0); }
  if (usage + delta > max) throw planLimitReachedError(limitKey, usage, max, r.rows[0]?.plan_name ?? "");
}
