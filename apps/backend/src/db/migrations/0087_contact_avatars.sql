ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS contact_avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS contact_avatar_updated_at TIMESTAMPTZ;

