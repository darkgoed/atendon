CREATE TABLE IF NOT EXISTS promotional_coupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), code TEXT NOT NULL UNIQUE, discount_type TEXT NOT NULL CHECK (discount_type IN ('PERCENT','FIXED')),
  discount_value BIGINT NOT NULL CHECK (discount_value >= 0), starts_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ,
  max_redemptions BIGINT, redemption_count BIGINT NOT NULL DEFAULT 0, eligibility JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), coupon_id UUID NOT NULL REFERENCES promotional_coupons(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, subscription_id UUID REFERENCES tenant_subscriptions(id) ON DELETE SET NULL,
  discount_cents BIGINT NOT NULL CHECK (discount_cents >= 0), redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now(), metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(coupon_id, tenant_id)
);
ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS scheduled_plan_id UUID REFERENCES plans(id);
ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS scheduled_billing_cycle TEXT CHECK (scheduled_billing_cycle IN ('MONTHLY','QUARTERLY','YEARLY'));
ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS scheduled_coupon_id UUID REFERENCES promotional_coupons(id);
ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_tenant ON coupon_redemptions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_scheduled ON tenant_subscriptions(current_period_end) WHERE scheduled_plan_id IS NOT NULL;
