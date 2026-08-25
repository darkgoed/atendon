ALTER TABLE conversations
  ADD COLUMN ai_commercial_override_at TIMESTAMPTZ;

COMMENT ON COLUMN conversations.ai_commercial_override_at IS
  'Última retomada manual da IA; prevalece sobre estados comerciais anteriores, mas não sobre mudanças comerciais posteriores.';

INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
SELECT tenant.id,'ai_turn_visibility_v1',true
FROM tenants tenant
WHERE tenant.slug='tripzturismo-a44ab4'
  AND tenant.status='active'
ON CONFLICT(tenant_id,flag_key) DO UPDATE SET
  enabled=true,
  updated_at=now();
