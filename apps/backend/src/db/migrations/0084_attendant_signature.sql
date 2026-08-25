CREATE TABLE IF NOT EXISTS attendant_signature_settings (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  format TEXT NOT NULL DEFAULT 'name_colon'
    CHECK (format IN ('name_colon','bold_name_colon','role_name_colon','separate_line')),
  name_style TEXT NOT NULL DEFAULT 'full' CHECK (name_style IN ('full','first_name')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS signature_enabled BOOLEAN;

INSERT INTO permissions(key,module,action,description) VALUES
  ('signature.read','signature','read','Visualizar configuracao de assinatura do atendente'),
  ('signature.manage','signature','manage','Gerenciar configuracao de assinatura do atendente')
ON CONFLICT(key) DO UPDATE SET
  module=EXCLUDED.module,
  action=EXCLUDED.action,
  description=EXCLUDED.description;

INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT r.id,p.key
FROM workspace_roles r
JOIN permissions p ON p.key IN ('signature.read','signature.manage')
WHERE r.name IN ('OWNER','ADMIN')
ON CONFLICT DO NOTHING;

INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT r.id,p.key
FROM workspace_roles r
JOIN permissions p ON p.key = 'signature.read'
WHERE r.name = 'OPERADOR'
ON CONFLICT DO NOTHING;
