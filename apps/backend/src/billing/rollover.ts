import type { PoolClient } from "pg";
import { getBillingSettings } from "./settings.js";

const INVALID_STATUSES = ["PAST_DUE", "SUSPENDED", "CANCELED", "EXPIRED"];

const n = (v: unknown) => Number(v ?? 0);

export async function closePeriodAndGrantRollover(client: PoolClient, tenantId: string, sourcePeriodId: string, targetPeriodId: string): Promise<{ generated: number; reason?: string }> {
  const settings = await getBillingSettings(client);
  const r = await client.query(`
    SELECT ts.status, p.rollover_enabled, p.rollover_rate_bps, p.rollover_max_percentage_bps,
           p.rollover_expiration_periods, s.included_limit, s.included_usage,
           s.usage_unit AS source_usage_unit, t.usage_unit AS target_usage_unit,
           s.status AS source_status, t.status AS target_status, s.tenant_id AS source_tenant_id,
           t.tenant_id AS target_tenant_id, s.sequence AS source_sequence, t.sequence AS target_sequence,
           s.end_at AS source_end_at, t.start_at AS target_start_at, t.end_at AS target_end_at
    FROM tenant_subscriptions ts JOIN plans p ON p.id=ts.plan_id
    JOIN usage_periods s ON s.id=$2 AND s.tenant_id=$1
    JOIN usage_periods t ON t.id=$3 AND t.tenant_id=$1
    WHERE ts.tenant_id=$1 FOR UPDATE`, [tenantId, sourcePeriodId, targetPeriodId]);
  const row = r.rows[0];
  if (!row) return { generated: 0, reason: "PERIOD_NOT_FOUND" };

  if (row.source_status !== "CLOSED" || row.target_status !== "OPEN" || row.source_tenant_id !== tenantId || row.target_tenant_id !== tenantId || Number(row.target_sequence) !== Number(row.source_sequence) + 1 || new Date(row.target_start_at).getTime() !== new Date(row.source_end_at).getTime()) return { generated: 0, reason: "INVALID_PERIOD_CHAIN" };
  if (row.source_usage_unit !== row.target_usage_unit) return { generated: 0, reason: "UNIT_MISMATCH" };
  if (Number(row.source_sequence) <= 1) return { generated: 0, reason: "FIRST_PERIOD" };
  if (INVALID_STATUSES.includes(row.status)) return { generated: 0, reason: "INVALID_SUBSCRIPTION_STATUS" };
  if (!row.rollover_enabled) return { generated: 0, reason: "ROLLOVER_DISABLED" };
  if (row.included_limit == null) return { generated: 0, reason: "UNLIMITED_PLAN" };
  const unused = Math.max(0, n(row.included_limit) - n(row.included_usage));
  const rate = row.rollover_rate_bps == null ? settings.default_rollover_rate_bps : n(row.rollover_rate_bps);
  const capRate = row.rollover_max_percentage_bps == null ? settings.default_rollover_max_percentage_bps : n(row.rollover_max_percentage_bps);
  const expiry = row.rollover_expiration_periods == null ? settings.default_rollover_expiration_periods : n(row.rollover_expiration_periods);
  const generated = Math.min(Math.floor(unused * rate / 10000), Math.floor(n(row.included_limit) * capRate / 10000));
  if (generated <= 0) return { generated: 0, reason: "NO_UNUSED_INCLUDED" };
  await client.query("SAVEPOINT rollover_insert");
  try {
    const inserted = await client.query(`INSERT INTO rollover_ledger(tenant_id,usage_period_id,source_period_id,unused_included_usage,rollover_rate_bps,generated_amount,usage_unit,expires_at) VALUES($1,$3,$2,$4,$5,$6,$8,$7::timestamptz + make_interval(months => $9)) ON CONFLICT (usage_period_id,source_period_id) DO NOTHING RETURNING id`, [tenantId, sourcePeriodId, targetPeriodId, unused, rate, generated, row.target_end_at, row.source_usage_unit, expiry]);
    if (!inserted.rowCount) { await client.query("ROLLBACK TO SAVEPOINT rollover_insert"); return { generated: 0, reason: "ALREADY_GRANTED" }; }
    await client.query("UPDATE usage_periods SET rollover_granted=rollover_granted+$2, updated_at=now() WHERE id=$1 AND tenant_id=$3", [targetPeriodId, generated, tenantId]);
    await client.query("RELEASE SAVEPOINT rollover_insert");
    return { generated };
  } catch (e) { await client.query("ROLLBACK TO SAVEPOINT rollover_insert"); throw e; }
}

export async function expireRollover(client: PoolClient, tenantId: string): Promise<number> {
  const r = await client.query(`WITH x AS (SELECT id, generated_amount-consumed_amount-expired_amount AS amount FROM rollover_ledger WHERE tenant_id=$1 AND expires_at <= now() AND generated_amount > consumed_amount+expired_amount FOR UPDATE), u AS (UPDATE rollover_ledger l SET expired_amount=l.expired_amount+x.amount FROM x WHERE l.id=x.id RETURNING x.amount) SELECT COALESCE(sum(amount),0)::bigint AS expired FROM u`, [tenantId]);
  return n(r.rows[0]?.expired);
}

export async function previewRollover(client: PoolClient, tenantId: string): Promise<{ currentBalance: number; projectedRollover: number }> {
  const [p, settings] = await Promise.all([
    client.query(`SELECT s.status,p.rollover_enabled,p.rollover_rate_bps,p.rollover_max_percentage_bps,u.included_limit,u.included_usage,u.usage_unit FROM tenant_subscriptions s JOIN plans p ON p.id=s.plan_id JOIN usage_periods u ON u.tenant_id=s.tenant_id AND u.status='OPEN' WHERE s.tenant_id=$1 LIMIT 1`, [tenantId]),
    getBillingSettings(client)
  ]);
  const x = p.rows[0];
  // A unidade âncora é a do período aberto: o saldo do ledger só faz sentido na
  // mesma unidade (créditos normalizados não se somam a interações legadas).
  if (!x) return { currentBalance: 0, projectedRollover: 0 };
  const b = await client.query(`SELECT COALESCE(sum(generated_amount-consumed_amount-expired_amount),0)::bigint AS balance FROM rollover_ledger WHERE tenant_id=$1 AND usage_unit=$2 AND (expires_at IS NULL OR expires_at > now())`, [tenantId, x.usage_unit]);
  const balance = n(b.rows[0]?.balance);
  if (!x.rollover_enabled || x.included_limit == null || INVALID_STATUSES.includes(x.status)) return { currentBalance: balance, projectedRollover: 0 };
  const rate = x.rollover_rate_bps == null ? settings.default_rollover_rate_bps : n(x.rollover_rate_bps);
  const cap = x.rollover_max_percentage_bps == null ? settings.default_rollover_max_percentage_bps : n(x.rollover_max_percentage_bps);
  const unused = Math.max(0, n(x.included_limit)-n(x.included_usage));
  return { currentBalance: balance, projectedRollover: Math.min(Math.floor(unused*rate/10000), Math.floor(n(x.included_limit)*cap/10000)) };
}

export async function truncateRolloverToPlanCap(client: PoolClient, tenantId: string, newPlanId: string): Promise<{ removed: number }> {
  // O teto acompanha a unidade do período aberto: períodos de crédito rolam em
  // créditos normalizados (MAX_AI_CREDITS), os legados em interações.
  const unit = await client.query<{ usage_unit: string }>(`SELECT usage_unit FROM usage_periods WHERE tenant_id=$1 AND status='OPEN' LIMIT 1`, [tenantId]);
  // Sem período aberto não há unidade âncora: não truncar (removeria na unidade errada).
  const openUnit = unit.rows[0]?.usage_unit;
  if (!openUnit) return { removed: 0 };
  const limitKey = openUnit === "CREDIT" ? "MAX_AI_CREDITS" : "MAX_AI_INTERACTIONS";
  const q = await client.query(`SELECT COALESCE(pl.limit_value,0)::bigint AS limit, p.rollover_max_percentage_bps FROM plans p LEFT JOIN plan_limits pl ON pl.plan_id=p.id AND pl.limit_key=$2 WHERE p.id=$1`, [newPlanId, limitKey]);
  const cap = q.rows[0] ? Math.floor(n(q.rows[0].limit) * n(q.rows[0].rollover_max_percentage_bps ?? 0) / 10000) : 0;
  // Rateio sequencial: cada linha leva só o excedente que sobra para ela — LEAST(delta, linha)
  // por linha expirava o delta inteiro em TODAS as linhas vivas (além do teto).
  const r = await client.query(`WITH live AS (SELECT id, GREATEST(0,generated_amount-consumed_amount-expired_amount)::bigint AS avail FROM rollover_ledger WHERE tenant_id=$1 AND usage_unit=$3 AND (expires_at IS NULL OR expires_at > now())), x AS (SELECT GREATEST(0,(SELECT COALESCE(sum(avail),0) FROM live)-$2)::bigint AS removed), w AS (SELECT id, avail, GREATEST(0,(SELECT removed FROM x)-COALESCE(sum(avail) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)) AS allot FROM live), u AS (UPDATE rollover_ledger l SET expired_amount=l.expired_amount+LEAST(w.avail,w.allot) FROM w WHERE l.id=w.id AND LEAST(w.avail,w.allot)>0 RETURNING 1) SELECT (SELECT removed FROM x) AS removed`, [tenantId, cap, openUnit]);
  const removed = n(r.rows[0]?.removed); if (removed) await client.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,metadata) SELECT $1, id,'ROLLOVER_ADJUSTED_BY_ROOT',$2 FROM tenant_subscriptions WHERE tenant_id=$1`, [tenantId, { removed, new_plan_id: newPlanId }]);
  return { removed };
}
