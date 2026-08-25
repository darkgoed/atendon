DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='lead_qualifications_id_tenant_unique'
  ) THEN
    ALTER TABLE lead_qualifications
      ADD CONSTRAINT lead_qualifications_id_tenant_unique UNIQUE(id,tenant_id);
  END IF;
END $$;

ALTER TABLE handoff_notifications
  DROP CONSTRAINT IF EXISTS handoff_notifications_conversation_id_fkey;
ALTER TABLE handoff_notifications
  DROP CONSTRAINT IF EXISTS handoff_notifications_session_id_fkey;
ALTER TABLE handoff_notifications
  ADD CONSTRAINT handoff_notifications_conversation_tenant_fkey
  FOREIGN KEY(conversation_id,tenant_id)
  REFERENCES conversations(id,tenant_id) ON DELETE CASCADE;
ALTER TABLE handoff_notifications
  ADD CONSTRAINT handoff_notifications_session_tenant_fkey
  FOREIGN KEY(session_id,tenant_id)
  REFERENCES whatsapp_sessions(id,tenant_id) ON DELETE CASCADE;

ALTER TABLE qualification_message_outbox
  DROP CONSTRAINT IF EXISTS qualification_message_outbox_qualification_id_fkey;
ALTER TABLE qualification_message_outbox
  DROP CONSTRAINT IF EXISTS qualification_message_outbox_session_id_fkey;
ALTER TABLE qualification_message_outbox
  ADD CONSTRAINT qualification_message_outbox_qualification_tenant_fkey
  FOREIGN KEY(qualification_id,tenant_id)
  REFERENCES lead_qualifications(id,tenant_id) ON DELETE CASCADE;
ALTER TABLE qualification_message_outbox
  ADD CONSTRAINT qualification_message_outbox_session_tenant_fkey
  FOREIGN KEY(session_id,tenant_id)
  REFERENCES whatsapp_sessions(id,tenant_id) ON DELETE CASCADE;
