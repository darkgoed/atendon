ALTER TABLE ai_follow_up_media_assets
  ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
