-- Add AI usage metering, rollover, credits, pricing, plan prices, and OAuth state.
CREATE TABLE usage_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES tenant_subscriptions(id),
  sequence INT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  included_limit BIGINT,
  included_usage BIGINT NOT NULL DEFAULT 0,
  rollover_granted BIGINT NOT NULL DEFAULT 0,
  rollover_usage BIGINT NOT NULL DEFAULT 0,
  bonus_granted BIGINT NOT NULL DEFAULT 0,
  bonus_usage BIGINT NOT NULL DEFAULT 0,
  overage_usage BIGINT NOT NULL DEFAULT 0,
  overage_amount_brl_cents BIGINT NOT NULL DEFAULT 0,
  reserved_cents BIGINT NOT NULL DEFAULT 0,
  provider_cost_usd_micros BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'INVOICED')),
  closed_at TIMESTAMPTZ,
  invoiced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, start_at)
);
CREATE UNIQUE INDEX uq_usage_periods_open_tenant ON usage_periods(tenant_id) WHERE status = 'OPEN';
CREATE INDEX idx_usage_periods_tenant_start ON usage_periods(tenant_id, start_at DESC);

CREATE TABLE ai_usage_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id UUID,
  usage_period_id UUID NOT NULL REFERENCES usage_periods(id) ON DELETE CASCADE,
  interaction_key TEXT NOT NULL,
  purpose TEXT NOT NULL,
  consumption_type TEXT NOT NULL CHECK (consumption_type IN ('INCLUDED', 'ROLLOVER', 'BONUS', 'OVERAGE')),
  model TEXT,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cached_tokens BIGINT NOT NULL DEFAULT 0,
  input_price_per_million_micros BIGINT,
  output_price_per_million_micros BIGINT,
  provider_cost_usd_micros BIGINT NOT NULL DEFAULT 0,
  provider_cost_brl_cents BIGINT NOT NULL DEFAULT 0,
  billable_amount_brl_cents BIGINT NOT NULL DEFAULT 0,
  pricing_strategy TEXT NOT NULL,
  pricing_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  usd_brl_rate_micros BIGINT,
  reconciled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reconciled_at TIMESTAMPTZ,
  UNIQUE (tenant_id, interaction_key)
);
CREATE INDEX idx_ai_usage_ledger_period_type ON ai_usage_ledger(usage_period_id, consumption_type);
CREATE INDEX idx_ai_usage_ledger_unreconciled ON ai_usage_ledger(usage_period_id) WHERE reconciled = false;

CREATE TABLE rollover_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usage_period_id UUID NOT NULL REFERENCES usage_periods(id) ON DELETE CASCADE,
  source_period_id UUID REFERENCES usage_periods(id),
  unused_included_usage BIGINT NOT NULL DEFAULT 0,
  rollover_rate_bps INT NOT NULL,
  generated_amount BIGINT NOT NULL DEFAULT 0,
  consumed_amount BIGINT NOT NULL DEFAULT 0,
  expired_amount BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  UNIQUE (usage_period_id, source_period_id)
);

CREATE TABLE usage_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usage_period_id UUID REFERENCES usage_periods(id),
  kind TEXT NOT NULL DEFAULT 'BONUS' CHECK (kind IN ('BONUS')),
  amount BIGINT NOT NULL CHECK (amount > 0),
  consumed_amount BIGINT NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  granted_by_user_id UUID REFERENCES users(id),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE usage_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usage_period_id UUID NOT NULL REFERENCES usage_periods(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL CHECK (alert_type IN ('QUOTA', 'CREDIT')),
  threshold_bps INT NOT NULL,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, usage_period_id, alert_type, threshold_bps)
);

CREATE TABLE tenant_usage_credit_settings (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  limit_type TEXT NOT NULL DEFAULT 'FIXED' CHECK (limit_type IN ('FIXED', 'UNLIMITED')),
  monthly_spending_limit_cents BIGINT,
  confirmed_unlimited_at TIMESTAMPTZ,
  updated_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE billing_settings (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  default_rollover_rate_bps INT NOT NULL DEFAULT 5000,
  default_rollover_max_percentage_bps INT NOT NULL DEFAULT 5000,
  default_rollover_expiration_periods INT NOT NULL DEFAULT 1,
  usd_brl_rate_micros BIGINT NOT NULL DEFAULT 5500000,
  credit_min_cents BIGINT NOT NULL DEFAULT 1000,
  credit_max_cents BIGINT NOT NULL DEFAULT 100000,
  credit_suggested_cents BIGINT[] NOT NULL DEFAULT ARRAY[2000, 5000, 10000, 20000]::BIGINT[],
  allow_custom_credit BOOLEAN NOT NULL DEFAULT true,
  allow_unlimited_credit BOOLEAN NOT NULL DEFAULT true,
  quota_alert_thresholds_bps INT[] NOT NULL DEFAULT ARRAY[8000, 9000, 10000],
  credit_alert_thresholds_bps INT[] NOT NULL DEFAULT ARRAY[5000, 8000, 10000],
  min_overage_estimate_cents BIGINT NOT NULL DEFAULT 1,
  reservation_ttl_minutes INT NOT NULL DEFAULT 15,
  webhook_tolerance_seconds INT NOT NULL DEFAULT 300,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO billing_settings DEFAULT VALUES;

CREATE TABLE ai_pricing_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version INT NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy IN ('COST_PLUS_MARKUP', 'FIXED_PER_INTERACTION', 'CUSTOM')),
  markup_bps INT,
  fixed_price_per_interaction_cents BIGINT,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT false,
  created_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (version)
);
CREATE UNIQUE INDEX uq_ai_pricing_rules_active ON ai_pricing_rules((active)) WHERE active;
INSERT INTO ai_pricing_rules(version, strategy, markup_bps, active) VALUES (1, 'COST_PLUS_MARKUP', 20000, true);

CREATE TABLE ai_model_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model TEXT NOT NULL,
  input_price_per_million_micros BIGINT NOT NULL,
  output_price_per_million_micros BIGINT NOT NULL,
  cached_input_price_per_million_micros BIGINT,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_model_prices_model_effective ON ai_model_prices(model, effective_from DESC);

CREATE TABLE plan_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  billing_cycle TEXT NOT NULL CHECK (billing_cycle IN ('MONTHLY', 'QUARTERLY', 'YEARLY')),
  base_price_cents BIGINT NOT NULL,
  discount_type TEXT,
  discount_value BIGINT,
  final_price_cents BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'BRL',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_plan_prices_active ON plan_prices(plan_id, billing_cycle) WHERE active;

INSERT INTO plan_prices(plan_id, billing_cycle, base_price_cents, final_price_cents)
SELECT id, 'MONTHLY', v.base, v.base FROM plans JOIN (VALUES ('BASIC',49700),('MEDIUM',89700),('PRO',109700)) v(code,base) USING (code);
INSERT INTO plan_prices(plan_id, billing_cycle, base_price_cents, discount_type, discount_value, final_price_cents)
SELECT id, 'QUARTERLY', v.base * 3, 'PERCENT', 1000, v.final FROM plans JOIN (VALUES ('BASIC',49700,134190),('MEDIUM',89700,242190),('PRO',109700,296190)) v(code,base,final) USING (code);
INSERT INTO plan_prices(plan_id, billing_cycle, base_price_cents, discount_type, discount_value, final_price_cents)
SELECT id, 'YEARLY', v.base * 12, 'PERCENT', 2000, v.final FROM plans JOIN (VALUES ('BASIC',49700,477120),('MEDIUM',89700,861120),('PRO',109700,1053120)) v(code,base,final) USING (code);

CREATE TABLE invoice_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('PLAN', 'DISCOUNT', 'AI_OVERAGE', 'ADDON', 'CREDIT')),
  description TEXT NOT NULL,
  quantity BIGINT NOT NULL DEFAULT 1,
  unit_amount_cents BIGINT NOT NULL,
  amount_cents BIGINT NOT NULL,
  usage_period_id UUID REFERENCES usage_periods(id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, kind, usage_period_id)
);

ALTER TABLE plans ADD COLUMN rollover_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE plans ADD COLUMN rollover_rate_bps INT;
ALTER TABLE plans ADD COLUMN rollover_max_percentage_bps INT;
ALTER TABLE plans ADD COLUMN rollover_expiration_periods INT;
ALTER TABLE plans ADD COLUMN ai_enabled BOOLEAN NOT NULL DEFAULT true;
UPDATE plans SET rollover_enabled = true, rollover_rate_bps = 5000, rollover_max_percentage_bps = 5000, rollover_expiration_periods = 1 WHERE code IN ('MEDIUM', 'PRO');
UPDATE plans SET ai_enabled = false WHERE code = 'BASIC';

ALTER TABLE tenant_subscriptions ADD COLUMN billing_cycle TEXT NOT NULL DEFAULT 'MONTHLY' CHECK (billing_cycle IN ('MONTHLY', 'QUARTERLY', 'YEARLY'));
ALTER TABLE tenant_subscriptions ADD COLUMN base_price_cents BIGINT;
ALTER TABLE tenant_subscriptions ADD COLUMN snapshot_discount_type TEXT;
ALTER TABLE tenant_subscriptions ADD COLUMN snapshot_discount_value BIGINT;
ALTER TABLE tenant_subscriptions ADD COLUMN final_price_cents BIGINT;
ALTER TABLE tenant_subscriptions ADD COLUMN snapshot_currency TEXT NOT NULL DEFAULT 'BRL';
ALTER TABLE tenant_subscriptions ADD COLUMN contracted_at TIMESTAMPTZ;

CREATE TABLE oauth_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state TEXT NOT NULL UNIQUE,
  provider_code TEXT NOT NULL,
  environment TEXT NOT NULL,
  code_verifier TEXT,
  created_by_user_id UUID REFERENCES users(id),
  consumed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
