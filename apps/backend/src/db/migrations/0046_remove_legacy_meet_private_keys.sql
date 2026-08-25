UPDATE scheduling_google_meet_settings
SET service_account_email=NULL,
    service_account_private_key_encrypted=NULL,
    updated_at=now()
WHERE oauth_refresh_token_encrypted IS NULL
  AND (service_account_email IS NOT NULL OR service_account_private_key_encrypted IS NOT NULL);
