ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sent_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_sent_by_user ON messages(sent_by_user_id) WHERE sent_by_user_id IS NOT NULL;
