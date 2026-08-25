ALTER TABLE usage_logs
  ADD COLUMN IF NOT EXISTS provider_request_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_provider_request
  ON usage_logs(provider_request_id)
  WHERE provider_request_id IS NOT NULL;
