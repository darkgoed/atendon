-- Separate commercial, tenant-configurable capabilities from internal rollout
-- flags.  Catalog keys are extensible, but remain machine-safe and versioned.
ALTER TABLE feature_flag_definitions
  DROP CONSTRAINT IF EXISTS feature_flag_definitions_flag_key_check;

ALTER TABLE feature_flag_definitions
  ADD CONSTRAINT feature_flag_definitions_flag_key_check
  CHECK (
    char_length(flag_key) BETWEEN 4 AND 120
    AND flag_key ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*_v[1-9][0-9]*$'
  ),
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'rollout'
    CHECK (kind IN ('rollout','capability')),
  ADD COLUMN display_name TEXT,
  ADD COLUMN tenant_configurable BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN availability_mode TEXT NOT NULL DEFAULT 'all_tenants'
    CHECK (availability_mode IN ('all_tenants','supported_tenants')),
  ADD COLUMN ui_order INT CHECK (ui_order IS NULL OR ui_order BETWEEN 0 AND 100000);

UPDATE feature_flag_definitions
SET display_name=initcap(replace(regexp_replace(flag_key,'_v[0-9]+$',''),'_',' '))
WHERE display_name IS NULL;

ALTER TABLE feature_flag_definitions
  ALTER COLUMN display_name SET NOT NULL;

INSERT INTO feature_flag_definitions(
  flag_key,description,default_enabled,global_enabled,kill_switch_enabled,
  kind,display_name,tenant_configurable,availability_mode,ui_order
) VALUES
  ('dashboard_v1','Visão geral, catálogo, layout e widgets do workspace',false,null,false,'capability','Visão geral',true,'all_tenants',10),
  ('leads_v1','Leads, qualificação, status e ferramentas relacionadas',false,null,false,'capability','Leads',true,'all_tenants',20),
  ('pipeline_v1','Pipeline, estágios, transições e operações em massa',false,null,false,'capability','Pipeline',true,'all_tenants',30),
  ('appointments_v1','Agenda, disponibilidade, appointments, Meet e notificações',false,null,false,'capability','Agenda',true,'all_tenants',40),
  ('workspace_admin_v1','Administração humana do workspace e suas configurações',false,null,false,'capability','Administração',true,'all_tenants',70)
ON CONFLICT(flag_key) DO UPDATE SET
  description=EXCLUDED.description,
  kind=EXCLUDED.kind,
  display_name=EXCLUDED.display_name,
  tenant_configurable=EXCLUDED.tenant_configurable,
  availability_mode=EXCLUDED.availability_mode,
  ui_order=EXCLUDED.ui_order,
  updated_at=now();

UPDATE feature_flag_definitions
SET kind='capability',
    display_name='Pós-venda',
    tenant_configurable=true,
    availability_mode='all_tenants',
    ui_order=50,
    updated_at=now()
WHERE flag_key='post_sales_v1';

UPDATE feature_flag_definitions
SET kind='capability',
    display_name='Tripz IA',
    tenant_configurable=true,
    availability_mode='supported_tenants',
    ui_order=60,
    updated_at=now()
WHERE flag_key='tripz_ai_v1';

CREATE TABLE capability_dependencies (
  capability_key TEXT NOT NULL
    REFERENCES feature_flag_definitions(flag_key) ON DELETE CASCADE,
  required_capability_key TEXT NOT NULL
    REFERENCES feature_flag_definitions(flag_key) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(capability_key,required_capability_key),
  CHECK (capability_key <> required_capability_key)
);

INSERT INTO capability_dependencies(capability_key,required_capability_key)
VALUES
  ('pipeline_v1','leads_v1'),
  ('appointments_v1','leads_v1')
ON CONFLICT DO NOTHING;

CREATE INDEX idx_capability_dependencies_required
  ON capability_dependencies(required_capability_key,capability_key);

CREATE TABLE tenant_capability_support (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  capability_key TEXT NOT NULL
    REFERENCES feature_flag_definitions(flag_key) ON DELETE CASCADE,
  provisioned_by TEXT NOT NULL DEFAULT 'system'
    CHECK (char_length(provisioned_by) BETWEEN 1 AND 120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,capability_key)
);

CREATE INDEX idx_tenant_capability_support_capability
  ON tenant_capability_support(capability_key,tenant_id);

-- Existing technical evidence identifies provisioned Tripz workspaces without
-- encoding a company name or slug in the capability model.
INSERT INTO tenant_capability_support(tenant_id,capability_key,provisioned_by)
SELECT DISTINCT tenant_id,'tripz_ai_v1','migration_0118'
FROM tenant_feature_flag_overrides
WHERE flag_key='tripz_ai_v1'
ON CONFLICT(tenant_id,capability_key) DO NOTHING;

-- Existing tenants retain the generally available top-level modules.
INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
SELECT tenant.id,capability.flag_key,true
FROM tenants tenant
CROSS JOIN (VALUES
  ('dashboard_v1'),
  ('leads_v1'),
  ('pipeline_v1'),
  ('workspace_admin_v1')
) capability(flag_key)
ON CONFLICT(tenant_id,flag_key) DO NOTHING;

-- Agenda is enabled only where the tenant already owns appointment history.
INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
SELECT tenant.id,'appointments_v1',
       EXISTS (
         SELECT 1 FROM scheduling_appointments appointment
         WHERE appointment.tenant_id=tenant.id
       )
FROM tenants tenant
ON CONFLICT(tenant_id,flag_key) DO NOTHING;

ALTER TABLE audit_logs
  ADD COLUMN operation_group UUID;

CREATE INDEX idx_audit_logs_operation_group
  ON audit_logs(operation_group,created_at,id)
  WHERE operation_group IS NOT NULL;
