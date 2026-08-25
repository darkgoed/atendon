ALTER TABLE scheduling_google_meet_settings
  ADD COLUMN IF NOT EXISTS service_account_email TEXT,
  ADD COLUMN IF NOT EXISTS service_account_private_key_encrypted TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scheduling_google_meet_credentials_pair_check'
  ) THEN
    ALTER TABLE scheduling_google_meet_settings
      ADD CONSTRAINT scheduling_google_meet_credentials_pair_check
      CHECK (
        (service_account_email IS NULL AND service_account_private_key_encrypted IS NULL)
        OR
        (service_account_email IS NOT NULL AND service_account_private_key_encrypted IS NOT NULL)
      );
  END IF;
END $$;
