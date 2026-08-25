CREATE TABLE IF NOT EXISTS scheduling_notification_settings (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  session_id UUID REFERENCES whatsapp_sessions(id) ON DELETE SET NULL,
  group_jid TEXT,
  group_name TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scheduling_appointment_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  appointment_id UUID NOT NULL REFERENCES scheduling_appointments(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES whatsapp_sessions(id),
  group_jid TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  external_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  UNIQUE (tenant_id, appointment_id)
);

CREATE INDEX IF NOT EXISTS idx_scheduling_appointment_notifications_pending
  ON scheduling_appointment_notifications(created_at) WHERE status='pending';

INSERT INTO permissions(key,module,action,description) VALUES
  ('scheduling_notifications.read','scheduling_notifications','read','Visualizar notificacao de agendamento no grupo de WhatsApp'),
  ('scheduling_notifications.manage','scheduling_notifications','manage','Gerenciar notificacao de agendamento no grupo de WhatsApp')
ON CONFLICT(key) DO UPDATE SET
  module=EXCLUDED.module,
  action=EXCLUDED.action,
  description=EXCLUDED.description;

INSERT INTO workspace_role_permissions(role_id,permission_key)
SELECT r.id,p.key
FROM workspace_roles r
JOIN permissions p ON p.key IN ('scheduling_notifications.read','scheduling_notifications.manage')
WHERE r.name IN ('OWNER','ADMIN')
ON CONFLICT DO NOTHING;
