ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_handoff_reason_check;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_handoff_reason_check
  CHECK (handoff_reason IS NULL OR handoff_reason IN ('ai_decided', 'contact_requested', 'manually_paused'));
