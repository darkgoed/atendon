ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS media_is_sticker BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_messages_conversation_stickers
  ON messages(conversation_id, created_at)
  WHERE media_is_sticker;
