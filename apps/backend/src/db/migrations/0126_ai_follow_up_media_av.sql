ALTER TABLE ai_follow_up_media_assets
  DROP CONSTRAINT IF EXISTS ai_follow_up_media_assets_mime_type_check;

ALTER TABLE ai_follow_up_media_assets
  ADD CONSTRAINT ai_follow_up_media_assets_mime_type_check
  CHECK (mime_type IN (
    'image/jpeg', 'image/png', 'image/webp',
    'audio/ogg', 'audio/mpeg', 'video/mp4'
  ));