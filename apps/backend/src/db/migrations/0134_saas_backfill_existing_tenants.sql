-- Preserve access for every tenant that predates commercial billing.
INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end)
SELECT t.id,p.id,'ACTIVE',now(),now() + interval '1 month'
FROM (SELECT id FROM tenants FOR UPDATE) t
CROSS JOIN (SELECT id FROM plans WHERE code='LEGACY_UNLIMITED') p
ON CONFLICT (tenant_id) DO NOTHING;
