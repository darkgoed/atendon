-- Normalized AI credits: usage is measured in cost-normalized tokens
-- ("creditos normalizados") instead of flat per-interaction units. A credit is
-- one token at the reference input price (ai_pricing_rules.config
-- credit_reference_input_price_per_million_micros, default $0.60/M — anchor of
-- the extra 50M-token package at R$157). Additive only: existing rows keep
-- usage_unit='INTERACTION', so historical periods and already-consumed values
-- are preserved with explicit unit identification; no retro-conversion.
ALTER TABLE usage_periods ADD COLUMN IF NOT EXISTS usage_unit TEXT NOT NULL DEFAULT 'INTERACTION' CHECK (usage_unit IN ('INTERACTION', 'CREDIT'));
ALTER TABLE usage_periods ADD COLUMN IF NOT EXISTS reserved_credits BIGINT NOT NULL DEFAULT 0;
ALTER TABLE ai_usage_ledger ADD COLUMN IF NOT EXISTS usage_unit TEXT NOT NULL DEFAULT 'INTERACTION' CHECK (usage_unit IN ('INTERACTION', 'CREDIT'));
ALTER TABLE ai_usage_ledger ADD COLUMN IF NOT EXISTS reserved_credits BIGINT NOT NULL DEFAULT 0;
ALTER TABLE ai_usage_ledger ADD COLUMN IF NOT EXISTS normalized_credits BIGINT NOT NULL DEFAULT 0;
ALTER TABLE rollover_ledger ADD COLUMN IF NOT EXISTS usage_unit TEXT NOT NULL DEFAULT 'INTERACTION' CHECK (usage_unit IN ('INTERACTION', 'CREDIT'));
ALTER TABLE usage_grants ADD COLUMN IF NOT EXISTS usage_unit TEXT NOT NULL DEFAULT 'INTERACTION' CHECK (usage_unit IN ('INTERACTION', 'CREDIT'));

-- Credit packages (purchased token packs, handled by a separate module) extend
-- the grant kinds; existing BONUS rows are untouched.
ALTER TABLE usage_grants DROP CONSTRAINT IF EXISTS usage_grants_kind_check;
ALTER TABLE usage_grants ADD CONSTRAINT usage_grants_kind_check CHECK (kind IN ('BONUS', 'CREDIT_PACKAGE'));

INSERT INTO limit_catalog(limit_key, label, unit, period, is_enforced)
VALUES ('MAX_AI_CREDITS', 'Maximum normalized AI credits', 'tokens', 'billing_period', true)
ON CONFLICT (limit_key) DO NOTHING;

-- BASIC gets AI enabled: with cost-normalized credits the usage is billable by
-- consumption, not by a flat interaction franchise.
UPDATE plans SET ai_enabled = true WHERE code = 'BASIC' AND ai_enabled = false;

-- Normalized credit limits per plan (1M BASIC; stepped for higher plans).
-- Existing MAX_AI_INTERACTIONS limits and tenant_entitlement_overrides are left
-- untouched; the open period keeps its INTERACTION snapshot and consumed values
-- (ensureOpenPeriod only stamps CREDIT unit on periods created from now on).
INSERT INTO plan_limits(plan_id, limit_key, limit_value)
SELECT p.id, 'MAX_AI_CREDITS', v.credits
  FROM plans p
  JOIN (VALUES ('BASIC', 1000000::bigint), ('MEDIUM', 3000000::bigint), ('PRO', 6000000::bigint)) v(code, credits)
    ON v.code = p.code
ON CONFLICT (plan_id, limit_key) DO NOTHING;
