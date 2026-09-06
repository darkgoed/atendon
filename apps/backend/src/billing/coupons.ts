import type { PoolClient } from "pg";

export type CouponInput = { code: string; tenantId: string; subscriptionId?: string; planId: string; priceCents: number };
export async function redeemCoupon(client: PoolClient, input: CouponInput) {
  const r = await client.query("SELECT * FROM promotional_coupons WHERE code=$1 AND active FOR UPDATE", [input.code.trim().toUpperCase()]);
  const coupon = r.rows[0];
  if (!coupon) throw Object.assign(new Error("Cupom inválido"), { statusCode: 400, code: "COUPON_INVALID" });
  const now = Date.now();
  if (new Date(coupon.starts_at).getTime() > now || (coupon.expires_at && new Date(coupon.expires_at).getTime() <= now)) throw Object.assign(new Error("Cupom expirado ou ainda não vigente"), { statusCode: 400, code: "COUPON_EXPIRED" });
  if (coupon.max_redemptions != null && Number(coupon.redemption_count) >= Number(coupon.max_redemptions)) throw Object.assign(new Error("Cupom esgotado"), { statusCode: 409, code: "COUPON_EXHAUSTED" });
  const eligible = coupon.eligibility ?? {};
  if (Array.isArray(eligible.plan_ids) && !eligible.plan_ids.includes(input.planId)) throw Object.assign(new Error("Cupom não elegível para este plano"), { statusCode: 400, code: "COUPON_NOT_ELIGIBLE" });
  const duplicate = await client.query("SELECT * FROM coupon_redemptions WHERE coupon_id=$1 AND tenant_id=$2", [coupon.id, input.tenantId]);
  if (duplicate.rows[0]) return duplicate.rows[0];
  const discount = coupon.discount_type === "PERCENT" ? Math.floor(input.priceCents * Number(coupon.discount_value) / 10000) : Math.min(input.priceCents, Number(coupon.discount_value));
  const inserted = await client.query("INSERT INTO coupon_redemptions(coupon_id,tenant_id,subscription_id,discount_cents,metadata) VALUES($1,$2,$3,$4,$5) ON CONFLICT(coupon_id,tenant_id) DO NOTHING RETURNING *", [coupon.id, input.tenantId, input.subscriptionId ?? null, discount, { plan_id: input.planId }]);
  if (inserted.rows[0]) await client.query("UPDATE promotional_coupons SET redemption_count=redemption_count+1,updated_at=now() WHERE id=$1", [coupon.id]);
  return inserted.rows[0] ?? duplicate.rows[0];
}
