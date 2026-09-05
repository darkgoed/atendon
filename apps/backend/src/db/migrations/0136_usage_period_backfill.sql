-- Backfill the first consumption period for subscriptions created before usage_periods.
-- LEAST preserves a genuinely shortened current subscription period while keeping
-- normal plans on calendar-month periods; subsequent periods are always + 1 month.
INSERT INTO usage_periods (
  tenant_id, subscription_id, sequence, start_at, end_at, included_limit, included_usage, status
)
SELECT
  s.tenant_id,
  s.id,
  1,
  s.current_period_start,
  LEAST(s.current_period_start + interval '1 month', s.current_period_end),
  CASE WHEN o.tenant_id IS NOT NULL THEN o.int_value ELSE pl.limit_value END,
  COALESCE(uc.used, 0),
  'OPEN'
FROM tenant_subscriptions s
LEFT JOIN plan_limits pl
  ON pl.plan_id = s.plan_id AND pl.limit_key = 'MAX_AI_INTERACTIONS'
LEFT JOIN tenant_entitlement_overrides o
  ON o.tenant_id = s.tenant_id
 AND o.kind = 'limit'
 AND o.entitlement_key = 'MAX_AI_INTERACTIONS'
 AND (o.expires_at IS NULL OR o.expires_at > now())
LEFT JOIN usage_counters uc
  ON uc.tenant_id = s.tenant_id
 AND uc.metric_key = 'MAX_AI_INTERACTIONS'
 AND uc.period_start = s.current_period_start
WHERE NOT EXISTS (
  SELECT 1 FROM usage_periods p WHERE p.tenant_id = s.tenant_id
)
ON CONFLICT (tenant_id, start_at) DO NOTHING;
