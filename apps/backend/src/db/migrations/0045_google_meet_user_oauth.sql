ALTER TABLE scheduling_google_meet_settings
  ADD COLUMN IF NOT EXISTS oauth_email TEXT,
  ADD COLUMN IF NOT EXISTS oauth_refresh_token_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS oauth_connected_at TIMESTAMPTZ;

-- Service-account credentials cannot be converted to user OAuth credentials.
-- Keep the legacy columns temporarily for rollback compatibility, but require
-- an explicit user connection before automation can run again.
UPDATE scheduling_google_meet_settings
SET enabled=false, updated_at=now()
WHERE enabled=true AND oauth_refresh_token_encrypted IS NULL;

ALTER TABLE scheduling_google_meet_settings
  DROP CONSTRAINT IF EXISTS scheduling_google_meet_credentials_pair_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scheduling_google_meet_oauth_pair_check'
  ) THEN
    ALTER TABLE scheduling_google_meet_settings
      ADD CONSTRAINT scheduling_google_meet_oauth_pair_check
      CHECK (
        (oauth_email IS NULL AND oauth_refresh_token_encrypted IS NULL AND oauth_connected_at IS NULL)
        OR
        (oauth_email IS NOT NULL AND oauth_refresh_token_encrypted IS NOT NULL AND oauth_connected_at IS NOT NULL)
      );
  END IF;
END $$;
