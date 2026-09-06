-- Generic onboarding: plan-driven capabilities; additive and idempotent.
CREATE TABLE IF NOT EXISTS plan_capability_flags (
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  flag_key TEXT NOT NULL REFERENCES feature_flag_definitions(flag_key) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (plan_id, flag_key)
);
INSERT INTO plan_capability_flags(plan_id,flag_key,enabled)
SELECT p.id,v.flag_key,v.enabled
FROM plans p
JOIN (VALUES
 ('BASIC','dashboard_v1',true),('BASIC','leads_v1',true),('BASIC','pipeline_v1',true),
 ('MEDIUM','dashboard_v1',true),('MEDIUM','leads_v1',true),('MEDIUM','pipeline_v1',true),('MEDIUM','appointments_v1',true),
 ('PRO','dashboard_v1',true),('PRO','leads_v1',true),('PRO','pipeline_v1',true),('PRO','appointments_v1',true),('PRO','post_sales_v1',true),('PRO','workspace_admin_v1',true)
) v(code,flag_key,enabled) ON v.code=p.code
ON CONFLICT (plan_id,flag_key) DO NOTHING;
