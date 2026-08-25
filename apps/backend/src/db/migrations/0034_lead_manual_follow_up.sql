ALTER TABLE scheduling_leads
  ADD COLUMN IF NOT EXISTS assigned_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS next_action TEXT,
  ADD COLUMN IF NOT EXISTS next_action_at TIMESTAMPTZ;

ALTER TABLE scheduling_leads
  DROP CONSTRAINT IF EXISTS scheduling_leads_next_action_pair;

ALTER TABLE scheduling_leads
  ADD CONSTRAINT scheduling_leads_next_action_pair CHECK (
    (next_action IS NULL AND next_action_at IS NULL)
    OR (btrim(next_action) <> '' AND char_length(next_action) <= 500 AND next_action_at IS NOT NULL)
  );

CREATE TABLE IF NOT EXISTS scheduling_lead_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL,
  author_user_id UUID NOT NULL REFERENCES users(id),
  content TEXT NOT NULL CHECK (btrim(content) <> '' AND char_length(content) <= 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT scheduling_lead_notes_lead_tenant_fkey
    FOREIGN KEY(lead_id,tenant_id) REFERENCES scheduling_leads(id,tenant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_scheduling_leads_follow_up
  ON scheduling_leads(tenant_id,assigned_member_id,next_action_at);

CREATE INDEX IF NOT EXISTS idx_scheduling_lead_notes_timeline
  ON scheduling_lead_notes(tenant_id,lead_id,created_at DESC);

INSERT INTO permissions(key,module,action,description) VALUES
  ('leads.follow_up.read','leads','follow_up_read','Visualizar acompanhamento interno de leads'),
  ('leads.follow_up.manage','leads','follow_up_manage','Gerenciar acompanhamento interno de leads')
ON CONFLICT(key) DO UPDATE SET
  module=EXCLUDED.module,
  action=EXCLUDED.action,
  description=EXCLUDED.description;

INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT r.id,p.key
FROM workspace_roles r
JOIN permissions p ON p.key IN ('leads.follow_up.read','leads.follow_up.manage')
WHERE r.name IN ('OWNER','ADMIN','OPERADOR')
ON CONFLICT DO NOTHING;
