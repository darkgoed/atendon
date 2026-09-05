-- R15: billing provider environments and safe connection lifecycle.
ALTER TABLE billing_providers DROP CONSTRAINT IF EXISTS billing_providers_code_key;
ALTER TABLE billing_providers ADD CONSTRAINT uq_billing_providers_code_environment UNIQUE (code, environment);
ALTER TABLE billing_providers
  ADD COLUMN status TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
  ADD COLUMN commercial_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN account_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN connected_at TIMESTAMPTZ,
  ADD COLUMN last_validated_at TIMESTAMPTZ,
  ADD COLUMN last_error_code TEXT,
  ADD COLUMN last_error_at TIMESTAMPTZ,
  ADD COLUMN token_expires_at TIMESTAMPTZ;
UPDATE billing_providers SET status = CASE
  WHEN credentials_encrypted IS NOT NULL THEN 'CONNECTED' ELSE 'NOT_CONFIGURED' END;
ALTER TABLE billing_providers ADD CONSTRAINT ck_billing_providers_status
  CHECK (status IN ('NOT_CONFIGURED','CONNECTED','TOKEN_EXPIRING','AUTH_ERROR','DISCONNECTED','DISABLED'));
CREATE INDEX idx_billing_providers_enabled_environment ON billing_providers(enabled, environment);
CREATE INDEX idx_billing_providers_status ON billing_providers(status);
CREATE INDEX idx_billing_providers_token_expires_at ON billing_providers(token_expires_at) WHERE token_expires_at IS NOT NULL;
