-- Tripz IA is a tenant-specific vertical. Migration 0114 registered the
-- catalog globally, but its initial role grants must exist only in Tripz.
DELETE FROM workspace_role_permissions grant_row
USING workspace_roles role, tenants tenant
WHERE grant_row.role_id=role.id
  AND tenant.id=role.workspace_id
  AND grant_row.permission_key IN ('tripz_ai.use','tripz_ai.manage')
  AND tenant.slug <> 'tripzturismo-a44ab4';

DELETE FROM tenant_feature_flag_overrides override_row
USING tenants tenant
WHERE override_row.tenant_id=tenant.id
  AND override_row.flag_key='tripz_ai_v1'
  AND tenant.slug <> 'tripzturismo-a44ab4';
