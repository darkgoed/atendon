CREATE TABLE IF NOT EXISTS scheduling_meeting_contact_delivery_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  appointment_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  session_id UUID NOT NULL,
  contact_phone TEXT NOT NULL CHECK (char_length(contact_phone) BETWEEN 8 AND 64),
  contact_jid TEXT,
  meet_url TEXT NOT NULL CHECK (meet_url ~ '^https://meet\.google\.com/'),
  message_text TEXT NOT NULL CHECK (char_length(message_text) BETWEEN 1 AND 2000),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'suppressed', 'failed', 'uncertain')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processing_started_at TIMESTAMPTZ,
  attempted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  external_message_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT scheduling_meeting_contact_delivery_appointment_tenant_fkey
    FOREIGN KEY (appointment_id, tenant_id)
    REFERENCES scheduling_appointments(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT scheduling_meeting_contact_delivery_conversation_tenant_fkey
    FOREIGN KEY (conversation_id, tenant_id)
    REFERENCES conversations(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT scheduling_meeting_contact_delivery_session_tenant_fkey
    FOREIGN KEY (session_id, tenant_id)
    REFERENCES whatsapp_sessions(id, tenant_id),
  CONSTRAINT scheduling_meeting_contact_delivery_appointment_unique
    UNIQUE (tenant_id, appointment_id)
);

CREATE INDEX IF NOT EXISTS idx_scheduling_meeting_contact_delivery_due
  ON scheduling_meeting_contact_delivery_outbox(status, available_at, created_at, id)
  WHERE status IN ('pending', 'processing');
