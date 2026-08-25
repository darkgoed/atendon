ALTER TABLE tenant_api_keys
  ADD COLUMN IF NOT EXISTS scopes TEXT[] NOT NULL DEFAULT ARRAY[
    'scheduling.categories.read',
    'scheduling.partners.read',
    'scheduling.availability.read',
    'scheduling.leads.upsert',
    'scheduling.leads.partner_proposal',
    'scheduling.leads.status',
    'scheduling.leads.transfer',
    'scheduling.appointments.create',
    'scheduling.appointments.reschedule',
    'scheduling.appointments.cancel'
  ]::TEXT[],
  ADD COLUMN IF NOT EXISTS key_prefix TEXT,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rotated_from_id UUID REFERENCES tenant_api_keys(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE tenant_api_keys
  DROP CONSTRAINT IF EXISTS tenant_api_keys_scopes_valid;

ALTER TABLE tenant_api_keys
  ADD CONSTRAINT tenant_api_keys_scopes_valid CHECK (
    cardinality(scopes) > 0
    AND scopes <@ ARRAY[
      'scheduling.categories.read',
      'scheduling.partners.read',
      'scheduling.availability.read',
      'scheduling.leads.upsert',
      'scheduling.leads.partner_proposal',
      'scheduling.leads.status',
      'scheduling.leads.transfer',
      'scheduling.appointments.create',
      'scheduling.appointments.reschedule',
      'scheduling.appointments.cancel'
    ]::TEXT[]
  );

CREATE INDEX IF NOT EXISTS idx_tenant_api_keys_tenant_created
  ON tenant_api_keys(tenant_id,created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tenant_api_keys_authentication
  ON tenant_api_keys(key_hash)
  WHERE active AND revoked_at IS NULL;

INSERT INTO permissions(key,module,action,description) VALUES
  ('api_keys.read','api_keys','read','Visualizar chaves de API'),
  ('api_keys.manage','api_keys','manage','Criar, rotacionar e revogar chaves de API')
ON CONFLICT(key) DO UPDATE SET
  module=EXCLUDED.module,
  action=EXCLUDED.action,
  description=EXCLUDED.description;

INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT r.id,p.key
FROM workspace_roles r
JOIN permissions p ON p.key IN ('api_keys.read','api_keys.manage')
WHERE r.name IN ('OWNER','ADMIN')
ON CONFLICT DO NOTHING;
