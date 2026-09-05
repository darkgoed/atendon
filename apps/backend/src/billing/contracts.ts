import type { PoolClient } from "pg";
import { db } from "../db/client.js";

export type BillingCycle = "MONTHLY" | "QUARTERLY" | "YEARLY";
export type DiscountType = "PERCENT" | "FIXED";
export type PlanPriceInput = {
  planId: string;
  billingCycle: BillingCycle;
  basePriceCents: number;
  discountType?: DiscountType | null;
  discountValue?: number | null;
  currency: string;
};

function price(input: PlanPriceInput) {
  if (!Number.isInteger(input.basePriceCents) || input.basePriceCents < 0) throw new Error("basePriceCents inválido");
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error("currency deve ter 3 caracteres");
  const value = input.discountValue ?? 0;
  if (!Number.isInteger(value) || value < 0) throw new Error("discountValue inválido");
  if (input.discountType !== null && input.discountType !== undefined && input.discountType !== "PERCENT" && input.discountType !== "FIXED") throw new Error("discountType inválido");
  if (input.discountType === "PERCENT" && value > 10000) throw new Error("percentual inválido");
  if (input.discountType === "FIXED" && value > input.basePriceCents) throw new Error("desconto excede preço");
  const finalPriceCents = input.basePriceCents - (input.discountType === "PERCENT" ? Math.floor(input.basePriceCents * value / 10000) : input.discountType === "FIXED" ? value : 0);
  if (finalPriceCents < 0) throw new Error("preço final negativo");
  return { ...input, discountValue: input.discountType ? value : null, finalPriceCents };
}

export async function listPlanPrices(planId: string) {
  return (await db.query("SELECT * FROM plan_prices WHERE plan_id=$1 ORDER BY billing_cycle, created_at DESC", [planId])).rows;
}

export async function upsertPlanPrice(client: PoolClient, input: PlanPriceInput, actor: string) {
  const p = price(input);
  await client.query("UPDATE plan_prices SET active=false, updated_at=now() WHERE plan_id=$1 AND billing_cycle=$2 AND active", [p.planId, p.billingCycle]);
  const result = await client.query(
    `INSERT INTO plan_prices(plan_id,billing_cycle,base_price_cents,discount_type,discount_value,final_price_cents,currency,active)
     VALUES($1,$2,$3,$4,$5,$6,$7,true) RETURNING *`,
    [p.planId, p.billingCycle, p.basePriceCents, p.discountType ?? null, p.discountValue, p.finalPriceCents, p.currency]
  );
  return { ...result.rows[0], actor };
}

export async function contractPlanForTenant(tenantId: string, planId: string, billingCycle: BillingCycle, actorUserId: string) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const sub = await client.query("SELECT * FROM tenant_subscriptions WHERE tenant_id=$1 FOR UPDATE", [tenantId]);
    if (!sub.rows[0]) throw Object.assign(new Error("Assinatura não encontrada"), { statusCode: 404 });
    const active = await client.query("SELECT * FROM plan_prices WHERE plan_id=$1 AND billing_cycle=$2 AND active FOR UPDATE", [planId, billingCycle]);
    const live = active.rows[0];
    if (!live) throw Object.assign(new Error("Preço ativo não encontrado"), { statusCode: 404 });

    const months = billingCycle === "MONTHLY" ? 1 : billingCycle === "QUARTERLY" ? 3 : 12;
    const updated = await client.query(
      `UPDATE tenant_subscriptions SET plan_id=$1,billing_cycle=$2,base_price_cents=$3,snapshot_discount_type=$4,snapshot_discount_value=$5,final_price_cents=$6,snapshot_currency=$7,contracted_at=now(),current_period_start=now(),current_period_end=now()+make_interval(months => $8),status='ACTIVE',updated_at=now() WHERE id=$9 RETURNING *`,
      [planId, billingCycle, live.base_price_cents, live.discount_type, live.discount_value, live.final_price_cents, live.currency, months, sub.rows[0].id]
    );
    const subscription = updated.rows[0];
    await client.query(
      `INSERT INTO usage_periods(tenant_id,subscription_id,sequence,start_at,end_at,included_limit,status)
       SELECT $1,$2,COALESCE(max(sequence),0)+1,now(),now()+interval '1 month',NULL,'OPEN' FROM usage_periods WHERE tenant_id=$1 AND status='OPEN' HAVING count(*)=0`,
      [tenantId, subscription.id]
    );
    const metadata = { snapshot: { plan_id: planId, billing_cycle: billingCycle, base_price_cents: live.base_price_cents, discount_type: live.discount_type, discount_value: live.discount_value, final_price_cents: live.final_price_cents, currency: live.currency }, actor_user_id: actorUserId };
    await client.query("INSERT INTO subscription_events(tenant_id,subscription_id,event_type,from_plan_id,to_plan_id,from_status,to_status,actor_user_id,metadata) VALUES($1,$2,'PLAN_CONTRACTED',$3,$4,$5,'ACTIVE',$6,$7)", [tenantId, subscription.id, sub.rows[0].plan_id, planId, sub.rows[0].status, actorUserId || null, metadata]);
    await client.query("COMMIT");
    return subscription;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
