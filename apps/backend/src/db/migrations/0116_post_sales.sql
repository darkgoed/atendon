ALTER TABLE feature_flag_definitions
  DROP CONSTRAINT IF EXISTS feature_flag_definitions_flag_key_check;
ALTER TABLE feature_flag_definitions
  ADD CONSTRAINT feature_flag_definitions_flag_key_check CHECK (flag_key IN (
    'ai_turn_visibility_v1',
    'conversations_delta_v2',
    'alerts_delivery_v2',
    'evaluation_event_enqueue_v2',
    'scheduling_meet_outbox_v2',
    'ai_deterministic_confirmations_v2',
    'evaluator_payload_redaction_v2',
    'state_tool_gating_v2',
    'compact_prompt_v2',
    'case_organization_v1',
    'dashboard_widgets_v1',
    'web_push_v1',
    'tripz_ai_v1',
    'post_sales_v1'
  ));

INSERT INTO feature_flag_definitions(flag_key,description)
VALUES('post_sales_v1','Carteira independente de pós-venda com checklist por empresa')
ON CONFLICT(flag_key) DO UPDATE SET
  description=EXCLUDED.description,
  updated_at=now();

INSERT INTO permissions(key,module,action,description)
VALUES
  ('post_sales.use','post_sales','use','Visualizar e operar a carteira de pós-venda'),
  ('post_sales.manage','post_sales','manage','Configurar o checklist de pós-venda')
ON CONFLICT(key) DO UPDATE SET
  module=EXCLUDED.module,
  action=EXCLUDED.action,
  description=EXCLUDED.description;

INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT role.id,permission.key
FROM workspace_roles role
JOIN permissions permission ON permission.key=ANY(ARRAY['post_sales.use','post_sales.manage']::text[])
WHERE role.name IN ('OWNER','ADMIN')
ON CONFLICT DO NOTHING;

INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT role.id,'post_sales.use'
FROM workspace_roles role
WHERE role.name IN ('SUPERVISOR','OPERADOR')
ON CONFLICT DO NOTHING;

CREATE TABLE post_sale_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  phone_e164 TEXT NOT NULL CHECK (phone_e164 ~ '^[1-9][0-9]{7,14}$'),
  email TEXT CHECK (email IS NULL OR char_length(email) BETWEEN 3 AND 320),
  notes TEXT CHECK (notes IS NULL OR char_length(notes) <= 10000),
  responsible_member_id UUID,
  next_action TEXT CHECK (next_action IS NULL OR char_length(next_action) BETWEEN 1 AND 500),
  next_action_at TIMESTAMPTZ,
  origin TEXT NOT NULL CHECK (origin IN ('manual','closed_sale')),
  lead_id UUID,
  archived_at TIMESTAMPTZ,
  version INT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT post_sale_clients_id_tenant_unique UNIQUE(id,tenant_id),
  CONSTRAINT post_sale_clients_responsible_tenant_fkey
    FOREIGN KEY(responsible_member_id,tenant_id)
    REFERENCES workspace_members(id,workspace_id)
    ON DELETE SET NULL (responsible_member_id),
  CONSTRAINT post_sale_clients_lead_tenant_fkey
    FOREIGN KEY(lead_id,tenant_id)
    REFERENCES scheduling_leads(id,tenant_id)
    ON DELETE SET NULL (lead_id),
  CONSTRAINT post_sale_clients_next_action_pair_check CHECK (
    (next_action IS NULL AND next_action_at IS NULL)
    OR (next_action IS NOT NULL AND next_action_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_post_sale_clients_tenant_phone
  ON post_sale_clients(tenant_id,phone_e164);
CREATE UNIQUE INDEX uq_post_sale_clients_tenant_lead
  ON post_sale_clients(tenant_id,lead_id)
  WHERE lead_id IS NOT NULL;
CREATE INDEX idx_post_sale_clients_active_updated
  ON post_sale_clients(tenant_id,updated_at DESC,id DESC)
  WHERE archived_at IS NULL;
CREATE INDEX idx_post_sale_clients_responsible
  ON post_sale_clients(tenant_id,responsible_member_id,updated_at DESC,id DESC)
  WHERE archived_at IS NULL;
CREATE INDEX idx_post_sale_clients_next_action
  ON post_sale_clients(tenant_id,next_action_at,id)
  WHERE archived_at IS NULL AND next_action_at IS NOT NULL;

CREATE TABLE post_sale_checklist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  description TEXT NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 500),
  position INT NOT NULL CHECK (position BETWEEN 0 AND 10000),
  is_active BOOLEAN NOT NULL DEFAULT true,
  archived_at TIMESTAMPTZ,
  version INT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT post_sale_checklist_items_id_tenant_unique UNIQUE(id,tenant_id),
  CONSTRAINT post_sale_checklist_items_archive_state_check CHECK (
    archived_at IS NULL OR is_active=false
  )
);

CREATE INDEX idx_post_sale_checklist_items_order
  ON post_sale_checklist_items(tenant_id,archived_at,position,id);

CREATE TABLE post_sale_client_checklist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id UUID NOT NULL,
  item_id UUID NOT NULL,
  result TEXT NOT NULL DEFAULT 'pendente' CHECK (result IN (
    'pendente','oferecido','aceito','recusado','nao_se_aplica'
  )),
  note TEXT CHECK (note IS NULL OR char_length(note) <= 5000),
  updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INT NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT post_sale_client_checklist_client_fkey
    FOREIGN KEY(client_id,tenant_id)
    REFERENCES post_sale_clients(id,tenant_id)
    ON DELETE RESTRICT,
  CONSTRAINT post_sale_client_checklist_item_fkey
    FOREIGN KEY(item_id,tenant_id)
    REFERENCES post_sale_checklist_items(id,tenant_id)
    ON DELETE RESTRICT,
  CONSTRAINT post_sale_client_checklist_client_item_unique
    UNIQUE(tenant_id,client_id,item_id)
);

CREATE INDEX idx_post_sale_client_checklist_client
  ON post_sale_client_checklist(tenant_id,client_id,item_id);
CREATE INDEX idx_post_sale_client_checklist_item
  ON post_sale_client_checklist(tenant_id,item_id,client_id);
