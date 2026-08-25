ALTER TABLE messages ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_messages_pending_inbound
  ON messages(external_message_id) WHERE sender = 'contact' AND processed_at IS NULL;
