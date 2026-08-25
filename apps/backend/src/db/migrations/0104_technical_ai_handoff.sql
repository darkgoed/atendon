ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS handoff_error_code TEXT;

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_handoff_reason_check;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_handoff_reason_check
  CHECK (
    handoff_reason IS NULL
    OR handoff_reason IN ('ai_decided', 'contact_requested', 'manually_paused', 'technical_failure')
  );

COMMENT ON COLUMN conversations.handoff_error_code IS
  'Internal AI failure code for technical handoffs; never exposed through conversation APIs';

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_logs_technical_recovery_once
  ON audit_logs(workspace_id, action, resource_id)
  WHERE action = 'conversation.technical_recovery_queued';
