ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS contact_presence TEXT,
  ADD COLUMN IF NOT EXISTS contact_presence_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS contact_last_seen_at TIMESTAMPTZ;

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_contact_presence_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_contact_presence_check
  CHECK (contact_presence IS NULL OR contact_presence IN ('available', 'unavailable', 'composing', 'recording', 'paused'));

UPDATE conversations
SET contact_last_seen_at = last_message_at
WHERE contact_last_seen_at IS NULL;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS media_mime_type TEXT,
  ADD COLUMN IF NOT EXISTS media_file_name TEXT,
  ADD COLUMN IF NOT EXISTS media_size_bytes INTEGER;

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_media_size_bytes_check;
ALTER TABLE messages
  ADD CONSTRAINT messages_media_size_bytes_check
  CHECK (media_size_bytes IS NULL OR media_size_bytes >= 0);

CREATE INDEX IF NOT EXISTS idx_conversations_presence
  ON conversations(tenant_id, contact_presence_updated_at DESC)
  WHERE contact_presence IS NOT NULL;
