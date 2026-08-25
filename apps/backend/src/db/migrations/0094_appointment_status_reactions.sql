ALTER TABLE scheduling_appointment_notifications
  ADD COLUMN IF NOT EXISTS reaction_emoji TEXT,
  ADD COLUMN IF NOT EXISTS reaction_status TEXT,
  ADD COLUMN IF NOT EXISTS reaction_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reaction_last_error TEXT,
  ADD COLUMN IF NOT EXISTS reacted_at TIMESTAMPTZ;

ALTER TABLE scheduling_appointment_notifications
  DROP CONSTRAINT IF EXISTS scheduling_appointment_notifications_reaction_emoji_check;
ALTER TABLE scheduling_appointment_notifications
  ADD CONSTRAINT scheduling_appointment_notifications_reaction_emoji_check
  CHECK (reaction_emoji IS NULL OR reaction_emoji IN ('✅','❌','⚠️'));

ALTER TABLE scheduling_appointment_notifications
  DROP CONSTRAINT IF EXISTS scheduling_appointment_notifications_reaction_status_check;
ALTER TABLE scheduling_appointment_notifications
  ADD CONSTRAINT scheduling_appointment_notifications_reaction_status_check
  CHECK (reaction_status IS NULL OR reaction_status IN ('pending','sent','failed'));

ALTER TABLE scheduling_appointment_notifications
  DROP CONSTRAINT IF EXISTS scheduling_appointment_notifications_reaction_attempts_check;
ALTER TABLE scheduling_appointment_notifications
  ADD CONSTRAINT scheduling_appointment_notifications_reaction_attempts_check
  CHECK (reaction_attempts >= 0);

CREATE INDEX IF NOT EXISTS idx_scheduling_appointment_notifications_reaction_pending
  ON scheduling_appointment_notifications(created_at,id)
  WHERE reaction_status='pending';
