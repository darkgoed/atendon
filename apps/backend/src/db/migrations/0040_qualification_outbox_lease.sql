ALTER TABLE qualification_message_outbox
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_qualification_outbox_input_step
  ON qualification_message_outbox(qualification_id,step_id,inbound_external_id);

CREATE INDEX IF NOT EXISTS idx_qualification_outbox_available
  ON qualification_message_outbox(next_attempt_at,created_at)
  WHERE status='pending';
