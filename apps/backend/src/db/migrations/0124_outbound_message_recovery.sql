ALTER TABLE outbound_message_requests
  ADD COLUMN IF NOT EXISTS recovery_payload JSONB,
  ADD COLUMN IF NOT EXISTS recovery_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recovered_at TIMESTAMPTZ;

ALTER TABLE outbound_message_requests
  DROP CONSTRAINT IF EXISTS outbound_message_requests_status_check;
ALTER TABLE outbound_message_requests
  ADD CONSTRAINT outbound_message_requests_status_check
  CHECK (status IN ('pending','sent','failed','ambiguous'));

ALTER TABLE outbound_message_requests
  DROP CONSTRAINT IF EXISTS outbound_message_requests_recovery_attempts_check;
ALTER TABLE outbound_message_requests
  ADD CONSTRAINT outbound_message_requests_recovery_attempts_check
  CHECK (recovery_attempts >= 0);

ALTER TABLE outbound_message_requests
  DROP CONSTRAINT IF EXISTS outbound_message_requests_recovery_payload_check;
ALTER TABLE outbound_message_requests
  ADD CONSTRAINT outbound_message_requests_recovery_payload_check
  CHECK (
    recovery_payload IS NULL OR (
      jsonb_typeof(recovery_payload)='object'
      AND jsonb_typeof(recovery_payload->'sendText')='string'
      AND jsonb_typeof(recovery_payload->'displayText')='string'
      AND jsonb_typeof(recovery_payload->'sentByUserId')='string'
      AND length(recovery_payload->>'sendText') BETWEEN 1 AND 100000
      AND length(recovery_payload->>'displayText') BETWEEN 1 AND 100000
      AND length(recovery_payload->>'sentByUserId') BETWEEN 1 AND 100
    )
  );

CREATE INDEX IF NOT EXISTS idx_outbound_message_requests_recoverable
  ON outbound_message_requests(tenant_id,created_at,id)
  WHERE status='failed' AND recovery_payload IS NOT NULL;
