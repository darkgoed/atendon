import type { PoolClient } from "pg";
import { db } from "../db/client.js";
import { CHARGEABLE_SUBSCRIPTION_STATUSES } from "./types.js";

export function proratedAmountCents(priceCents: number, periodStart: Date, periodEnd: Date, at = new Date()) {
  const total = Math.max(1, periodEnd.getTime() - periodStart.getTime());
  const remaining = Math.max(0, Math.min(total, periodEnd.getTime() - at.getTime()));
  return Math.max(0, Math.ceil(priceCents * remaining / total));
}
export async function createProrationInvoice(client: PoolClient, tenantId: string, subscriptionId: string, amountCents: number, currency: string, metadata: Record<string, unknown>) {
  if (amountCents <= 0) return null;
  const invoice = await client.query(`INSERT INTO invoices(tenant_id,subscription_id,kind,amount_cents,currency,status,period_start,period_end,metadata) SELECT $1,$2,'proration',$3,$4,'pending',current_period_start,current_period_end,$5 FROM tenant_subscriptions WHERE id=$2 RETURNING *`, [tenantId, subscriptionId, amountCents, currency, metadata]);
  await client.query("INSERT INTO invoice_line_items(invoice_id,kind,description,quantity,unit_amount_cents,amount_cents,metadata) VALUES($1,'PLAN',$2,1,$3,$3,$4)", [invoice.rows[0].id, "Prorrata de mudança de plano", amountCents, metadata]);
  return invoice.rows[0];
}
/**
 * Aplica a troca agendada (downgrade/troca de ciclo) de UMA assinatura já travada,
 * começando o novo ciclo no fim do atual. Retorna false quando não há preço ativo.
 */
export async function applyScheduledChange(client: Pick<PoolClient, "query">, subscriptionId: string): Promise<boolean> {
  const s = (await client.query("SELECT * FROM tenant_subscriptions WHERE id=$1 AND scheduled_plan_id IS NOT NULL", [subscriptionId])).rows[0];
  if (!s) return false;
  const cycle = s.scheduled_billing_cycle ?? s.billing_cycle ?? "MONTHLY";
  const p = (await client.query("SELECT * FROM plan_prices WHERE plan_id=$1 AND billing_cycle=$2 AND active", [s.scheduled_plan_id, cycle])).rows[0];
  if (!p) return false;
  const months = cycle === "YEARLY" ? 12 : cycle === "QUARTERLY" ? 3 : 1;
  await client.query(`UPDATE tenant_subscriptions SET plan_id=$1,billing_cycle=$2,base_price_cents=$3,snapshot_discount_type=$4,snapshot_discount_value=$5,final_price_cents=$6,snapshot_currency=$7,current_period_start=current_period_end,current_period_end=current_period_end+make_interval(months => $8::int),scheduled_plan_id=NULL,scheduled_billing_cycle=NULL,scheduled_coupon_id=NULL,scheduled_at=NULL,updated_at=now() WHERE id=$9`, [s.scheduled_plan_id, cycle, p.base_price_cents, p.discount_type, p.discount_value, p.final_price_cents, p.currency, months, s.id]);
  await client.query("INSERT INTO subscription_events(tenant_id,subscription_id,event_type,from_plan_id,to_plan_id,metadata) VALUES($1,$2,'SCHEDULED_DOWNGRADE_APPLIED',$3,$4,$5)", [s.tenant_id, s.id, s.plan_id, s.scheduled_plan_id, { applied_at: new Date().toISOString() }]);
  return true;
}

/**
 * Assinaturas cobráveis têm a troca aplicada pelo faturamento na virada do ciclo
 * (depois de cobrar o ciclo que terminou pelo contrato antigo). Este job cobre só
 * as que o faturamento não vira (ex.: SUSPENDED).
 */
export async function applyScheduledDowngrades(limit = 100) {
  const c = await db.connect(); let applied = 0;
  try { await c.query("BEGIN");
    const rows = await c.query<{ id: string }>(`SELECT s.id FROM tenant_subscriptions s WHERE s.scheduled_plan_id IS NOT NULL AND s.current_period_end <= now() AND NOT (s.status = ANY($2)) ORDER BY s.current_period_end FOR UPDATE SKIP LOCKED LIMIT $1`, [limit, CHARGEABLE_SUBSCRIPTION_STATUSES]);
    for (const s of rows.rows) if (await applyScheduledChange(c, s.id)) applied++;
    await c.query("COMMIT"); return applied;
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}
