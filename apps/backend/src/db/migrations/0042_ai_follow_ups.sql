ALTER TABLE tenant_ai_settings
  ADD COLUMN IF NOT EXISTS ai_follow_up_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_follow_up_max_count SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS ai_follow_up_interval_minutes INTEGER NOT NULL DEFAULT 1440;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_ai_settings_follow_up_max_count_check'
  ) THEN
    ALTER TABLE tenant_ai_settings
      ADD CONSTRAINT tenant_ai_settings_follow_up_max_count_check
      CHECK (ai_follow_up_max_count BETWEEN 1 AND 10);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_ai_settings_follow_up_interval_check'
  ) THEN
    ALTER TABLE tenant_ai_settings
      ADD CONSTRAINT tenant_ai_settings_follow_up_interval_check
      CHECK (ai_follow_up_interval_minutes BETWEEN 1 AND 43200);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ai_follow_up_schedules (
  conversation_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  last_agent_message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  follow_up_count SMALLINT NOT NULL DEFAULT 0 CHECK (follow_up_count BETWEEN 0 AND 10),
  sequence_version INTEGER NOT NULL DEFAULT 1 CHECK (sequence_version > 0),
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'processing', 'cancelled', 'completed', 'failed')),
  next_run_at TIMESTAMPTZ,
  processing_started_at TIMESTAMPTZ,
  failure_count SMALLINT NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  last_error TEXT,
  cancellation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, tenant_id)
    REFERENCES conversations(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_follow_up_schedules_due
  ON ai_follow_up_schedules(next_run_at)
  WHERE status = 'scheduled';

CREATE INDEX IF NOT EXISTS idx_ai_follow_up_schedules_stale
  ON ai_follow_up_schedules(processing_started_at)
  WHERE status = 'processing';
