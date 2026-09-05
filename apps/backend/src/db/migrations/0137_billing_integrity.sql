-- Enforce tenant-scoped billing references and counter invariants.
-- Fail explicitly before installing constraints; never repair or delete cross-tenant data.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ai_usage_ledger l JOIN usage_periods p ON p.id = l.usage_period_id WHERE l.tenant_id <> p.tenant_id) THEN
    RAISE EXCEPTION 'billing integrity: ai_usage_ledger contains cross-tenant usage_period_id';
  END IF;
  IF EXISTS (SELECT 1 FROM ai_usage_ledger l JOIN tenant_subscriptions s ON s.id = l.subscription_id WHERE l.tenant_id <> s.tenant_id) THEN
    RAISE EXCEPTION 'billing integrity: ai_usage_ledger contains cross-tenant subscription_id';
  END IF;
  IF EXISTS (SELECT 1 FROM rollover_ledger r JOIN usage_periods p ON p.id = r.usage_period_id WHERE r.tenant_id <> p.tenant_id) THEN
    RAISE EXCEPTION 'billing integrity: rollover_ledger contains cross-tenant target period';
  END IF;
  IF EXISTS (SELECT 1 FROM rollover_ledger r JOIN usage_periods p ON p.id = r.source_period_id WHERE r.source_period_id IS NOT NULL AND r.tenant_id <> p.tenant_id) THEN
    RAISE EXCEPTION 'billing integrity: rollover_ledger contains cross-tenant source period';
  END IF;
  IF EXISTS (SELECT 1 FROM usage_grants g JOIN usage_periods p ON p.id = g.usage_period_id WHERE g.usage_period_id IS NOT NULL AND g.tenant_id <> p.tenant_id) THEN
    RAISE EXCEPTION 'billing integrity: usage_grants contains cross-tenant period';
  END IF;
  IF EXISTS (SELECT 1 FROM usage_alerts a JOIN usage_periods p ON p.id = a.usage_period_id WHERE a.tenant_id <> p.tenant_id) THEN
    RAISE EXCEPTION 'billing integrity: usage_alerts contains cross-tenant period';
  END IF;
END $$;

ALTER TABLE ai_usage_ledger ADD COLUMN logical_turn_id UUID;
CREATE INDEX idx_ai_usage_ledger_tenant_logical_turn
  ON ai_usage_ledger (tenant_id, logical_turn_id)
  WHERE logical_turn_id IS NOT NULL;

ALTER TABLE usage_periods
  ADD CONSTRAINT uq_usage_periods_id_tenant UNIQUE (id, tenant_id);
ALTER TABLE tenant_subscriptions
  ADD CONSTRAINT uq_tenant_subscriptions_id_tenant UNIQUE (id, tenant_id);

ALTER TABLE ai_usage_ledger
  ADD CONSTRAINT fk_ai_usage_ledger_subscription
    FOREIGN KEY (subscription_id) REFERENCES tenant_subscriptions(id) NOT VALID,
  ADD CONSTRAINT fk_ai_usage_ledger_subscription_tenant
    FOREIGN KEY (subscription_id, tenant_id) REFERENCES tenant_subscriptions(id, tenant_id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT fk_ai_usage_ledger_usage_period_tenant
    FOREIGN KEY (usage_period_id, tenant_id) REFERENCES usage_periods(id, tenant_id) ON DELETE CASCADE NOT VALID;

ALTER TABLE rollover_ledger
  ADD CONSTRAINT fk_rollover_ledger_usage_period_tenant
    FOREIGN KEY (usage_period_id, tenant_id) REFERENCES usage_periods(id, tenant_id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT fk_rollover_ledger_source_period_tenant
    FOREIGN KEY (source_period_id, tenant_id) REFERENCES usage_periods(id, tenant_id) ON DELETE CASCADE NOT VALID;
ALTER TABLE usage_grants
  ADD CONSTRAINT fk_usage_grants_usage_period_tenant
    FOREIGN KEY (usage_period_id, tenant_id) REFERENCES usage_periods(id, tenant_id) ON DELETE CASCADE NOT VALID;
ALTER TABLE usage_alerts
  ADD CONSTRAINT fk_usage_alerts_usage_period_tenant
    FOREIGN KEY (usage_period_id, tenant_id) REFERENCES usage_periods(id, tenant_id) ON DELETE CASCADE NOT VALID;

ALTER TABLE usage_periods
  ADD CONSTRAINT ck_usage_periods_nonnegative CHECK (
    included_limit IS NULL OR included_limit >= 0
  ) NOT VALID,
  ADD CONSTRAINT ck_usage_periods_counters_nonnegative CHECK (
    included_usage >= 0 AND rollover_granted >= 0 AND rollover_usage >= 0 AND
    bonus_granted >= 0 AND bonus_usage >= 0 AND overage_usage >= 0 AND
    overage_amount_brl_cents >= 0 AND reserved_cents >= 0 AND provider_cost_usd_micros >= 0
  ) NOT VALID,
  ADD CONSTRAINT ck_usage_periods_rollover_usage_bound CHECK (rollover_usage <= rollover_granted) NOT VALID,
  ADD CONSTRAINT ck_usage_periods_bonus_usage_bound CHECK (bonus_usage <= bonus_granted) NOT VALID;
ALTER TABLE ai_usage_ledger
  ADD CONSTRAINT ck_ai_usage_ledger_nonnegative CHECK (
    input_tokens >= 0 AND output_tokens >= 0 AND cached_tokens >= 0 AND
    provider_cost_usd_micros >= 0 AND provider_cost_brl_cents >= 0 AND
    billable_amount_brl_cents >= 0 AND
    (input_price_per_million_micros IS NULL OR input_price_per_million_micros >= 0) AND
    (output_price_per_million_micros IS NULL OR output_price_per_million_micros >= 0) AND
    (usd_brl_rate_micros IS NULL OR usd_brl_rate_micros >= 0)
  ) NOT VALID;
ALTER TABLE rollover_ledger
  ADD CONSTRAINT ck_rollover_ledger_nonnegative CHECK (
    unused_included_usage >= 0 AND generated_amount >= 0 AND consumed_amount >= 0 AND expired_amount >= 0 AND
    consumed_amount + expired_amount <= generated_amount
  ) NOT VALID;
ALTER TABLE usage_grants
  ADD CONSTRAINT ck_usage_grants_nonnegative CHECK (amount > 0 AND consumed_amount >= 0 AND consumed_amount <= amount) NOT VALID;
ALTER TABLE tenant_usage_credit_settings
  ADD CONSTRAINT ck_credit_settings_valid CHECK (
    (limit_type = 'FIXED' AND monthly_spending_limit_cents IS NOT NULL AND monthly_spending_limit_cents > 0 AND confirmed_unlimited_at IS NULL)
    OR (limit_type = 'UNLIMITED' AND confirmed_unlimited_at IS NOT NULL AND monthly_spending_limit_cents IS NULL)
  ) NOT VALID;

ALTER TABLE ai_usage_ledger VALIDATE CONSTRAINT fk_ai_usage_ledger_subscription;
ALTER TABLE ai_usage_ledger VALIDATE CONSTRAINT fk_ai_usage_ledger_subscription_tenant;
ALTER TABLE ai_usage_ledger VALIDATE CONSTRAINT fk_ai_usage_ledger_usage_period_tenant;
ALTER TABLE rollover_ledger VALIDATE CONSTRAINT fk_rollover_ledger_usage_period_tenant;
ALTER TABLE rollover_ledger VALIDATE CONSTRAINT fk_rollover_ledger_source_period_tenant;
ALTER TABLE usage_grants VALIDATE CONSTRAINT fk_usage_grants_usage_period_tenant;
ALTER TABLE usage_alerts VALIDATE CONSTRAINT fk_usage_alerts_usage_period_tenant;
ALTER TABLE usage_periods VALIDATE CONSTRAINT ck_usage_periods_nonnegative;
ALTER TABLE usage_periods VALIDATE CONSTRAINT ck_usage_periods_counters_nonnegative;
ALTER TABLE usage_periods VALIDATE CONSTRAINT ck_usage_periods_rollover_usage_bound;
ALTER TABLE usage_periods VALIDATE CONSTRAINT ck_usage_periods_bonus_usage_bound;
ALTER TABLE ai_usage_ledger VALIDATE CONSTRAINT ck_ai_usage_ledger_nonnegative;
ALTER TABLE rollover_ledger VALIDATE CONSTRAINT ck_rollover_ledger_nonnegative;
ALTER TABLE usage_grants VALIDATE CONSTRAINT ck_usage_grants_nonnegative;
ALTER TABLE tenant_usage_credit_settings VALIDATE CONSTRAINT ck_credit_settings_valid;
