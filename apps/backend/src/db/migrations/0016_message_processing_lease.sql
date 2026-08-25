ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_messages_processing_lease
  ON messages(processing_started_at)
  WHERE sender = 'contact' AND processed_at IS NULL;
