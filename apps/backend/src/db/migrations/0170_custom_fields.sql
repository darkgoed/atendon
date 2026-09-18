-- Campos personalizados de contato (specs/active/v6-evolucao-estrutural-atendon.md,
-- R7 e contrato de API "Campos personalizados"). Aditiva e idempotente.
-- Valores de lead ficam em JSONB tipado pelo serviço conforme o type do campo.
-- ROLLBACK (manual, não executar automaticamente):
-- DROP TABLE IF EXISTS lead_custom_values;
-- DROP TABLE IF EXISTS custom_field_defs;
-- DELETE FROM permissions WHERE key='fields.manage';

CREATE TABLE IF NOT EXISTS custom_field_defs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- v1 expõe apenas 'lead' pela API; a coluna fica aberta para entidades futuras.
  entity TEXT NOT NULL DEFAULT 'lead',
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL
    CHECK (type IN ('text','number','currency','date','select','multiselect','boolean')),
  options JSONB,
  required BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT custom_field_defs_tenant_entity_key_unique UNIQUE (tenant_id, entity, key)
);

CREATE TABLE IF NOT EXISTS lead_custom_values (
  field_id UUID NOT NULL REFERENCES custom_field_defs(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES scheduling_leads(id) ON DELETE CASCADE,
  value JSONB,
  PRIMARY KEY (field_id, lead_id)
);

-- Leitura dos valores junto ao perfil do lead (1 query para todos os campos).
CREATE INDEX IF NOT EXISTS idx_lead_custom_values_lead
  ON lead_custom_values(lead_id);

-- fields.manage: dono/admin/gestão administram o catálogo de campos.
INSERT INTO permissions(key,module,action,description) VALUES
 ('fields.manage','fields','manage','Administrar o catalogo de campos personalizados de contatos')
ON CONFLICT(key) DO UPDATE SET module=EXCLUDED.module,action=EXCLUDED.action,description=EXCLUDED.description;

INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT r.id,'fields.manage'
FROM workspace_roles r
WHERE r.name IN ('OWNER','ADMIN','SUPERVISOR')
ON CONFLICT DO NOTHING;
