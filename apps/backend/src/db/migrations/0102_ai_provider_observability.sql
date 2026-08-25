ALTER TABLE usage_logs
  ADD COLUMN IF NOT EXISTS message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS request_id UUID,
  ADD COLUMN IF NOT EXISTS processing_attempt INT CHECK (processing_attempt IS NULL OR processing_attempt > 0),
  ADD COLUMN IF NOT EXISTS provider_request_index INT CHECK (provider_request_index IS NULL OR provider_request_index > 0),
  ADD COLUMN IF NOT EXISTS call_reason TEXT,
  ADD COLUMN IF NOT EXISTS duration_ms INT CHECK (duration_ms IS NULL OR duration_ms >= 0),
  ADD COLUMN IF NOT EXISTS tools_used TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS reasoning_tokens INT NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
  ADD COLUMN IF NOT EXISTS cached_input_tokens INT NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  ADD COLUMN IF NOT EXISTS cache_write_input_tokens INT NOT NULL DEFAULT 0 CHECK (cache_write_input_tokens >= 0),
  ADD COLUMN IF NOT EXISTS system_prompt_characters INT CHECK (system_prompt_characters IS NULL OR system_prompt_characters >= 0),
  ADD COLUMN IF NOT EXISTS history_message_count INT CHECK (history_message_count IS NULL OR history_message_count >= 0),
  ADD COLUMN IF NOT EXISTS history_characters INT CHECK (history_characters IS NULL OR history_characters >= 0),
  ADD COLUMN IF NOT EXISTS request_message_characters INT CHECK (request_message_characters IS NULL OR request_message_characters >= 0),
  ADD COLUMN IF NOT EXISTS tool_schema_characters INT CHECK (tool_schema_characters IS NULL OR tool_schema_characters >= 0),
  ADD COLUMN IF NOT EXISTS tool_result_characters INT CHECK (tool_result_characters IS NULL OR tool_result_characters >= 0);

CREATE INDEX IF NOT EXISTS idx_usage_message_date
  ON usage_logs(message_id, created_at DESC)
  WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_usage_request
  ON usage_logs(request_id, provider_request_index)
  WHERE request_id IS NOT NULL;
