ALTER TABLE scheduling_appointment_notifications
  ADD COLUMN IF NOT EXISTS message_revision INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS edited_revision INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS edit_status TEXT,
  ADD COLUMN IF NOT EXISTS edit_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS edit_last_error TEXT,
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

ALTER TABLE scheduling_appointment_notifications
  DROP CONSTRAINT IF EXISTS scheduling_appointment_notifications_message_revision_check;
ALTER TABLE scheduling_appointment_notifications
  ADD CONSTRAINT scheduling_appointment_notifications_message_revision_check
  CHECK (message_revision >= 0 AND edited_revision >= 0 AND edited_revision <= message_revision);

ALTER TABLE scheduling_appointment_notifications
  DROP CONSTRAINT IF EXISTS scheduling_appointment_notifications_edit_status_check;
ALTER TABLE scheduling_appointment_notifications
  ADD CONSTRAINT scheduling_appointment_notifications_edit_status_check
  CHECK (edit_status IS NULL OR edit_status IN ('pending','sent','failed'));

ALTER TABLE scheduling_appointment_notifications
  DROP CONSTRAINT IF EXISTS scheduling_appointment_notifications_edit_attempts_check;
ALTER TABLE scheduling_appointment_notifications
  ADD CONSTRAINT scheduling_appointment_notifications_edit_attempts_check
  CHECK (edit_attempts >= 0);

CREATE INDEX IF NOT EXISTS idx_scheduling_appointment_notifications_edit_pending
  ON scheduling_appointment_notifications(created_at, id)
  WHERE status='sent' AND edit_status='pending' AND external_message_id IS NOT NULL;
