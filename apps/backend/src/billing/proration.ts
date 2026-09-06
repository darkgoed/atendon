import type { PoolClient } from "pg";
import { db } from "../db/client.js";

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
export async function applyScheduledDowngrades(limit = 100) {
  const c = await db.connect(); let applied = 0;
  try { await c.query("BEGIN");
    const rows = await c.query(`SELECT s.*,p.billing_period_months FROM tenant_subscriptions s JOIN plans p ON p.id=s.scheduled_plan_id WHERE s.scheduled_plan_id IS NOT NULL AND s.current_period_end <= now() ORDER BY s.current_period_end FOR UPDATE SKIP LOCKED LIMIT $1`, [limit]);
    for (const s of rows.rows) {
      const price = await c.query("SELECT * FROM plan_prices WHERE plan_id=$1 AND billing_cycle=$2 AND active", [s.scheduled_plan_id, s.scheduled_billing_cycle]); const p = price.rows[0]; if (!p) continue;
      await c.query(`UPDATE tenant_subscriptions SET plan_id=$1,billing_cycle=$2,base_price_cents=$3,snapshot_discount_type=$4,snapshot_discount_value=$5,final_price_cents=$6,snapshot_currency=$7,current_period_start=current_period_end,current_period_end=current_period_end+make_interval(months => COALESCE($8::int,1)),scheduled_plan_id=NULL,scheduled_billing_cycle=NULL,scheduled_coupon_id=NULL,scheduled_at=NULL,updated_at=now() WHERE id=$9`, [s.scheduled_plan_id,s.scheduled_billing_cycle,p.base_price_cents,p.discount_type,p.discount_value,p.final_price_cents,p.currency,p.billing_period_months,s.id]);
      await c.query("INSERT INTO subscription_events(tenant_id,subscription_id,event_type,from_plan_id,to_plan_id,metadata) VALUES($1,$2,'SCHEDULED_DOWNGRADE_APPLIED',$3,$4,$5)", [s.tenant_id,s.id,s.plan_id,s.scheduled_plan_id,{ applied_at: new Date().toISOString() }]); applied++;
    }
    await c.query("COMMIT"); return applied;
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}
