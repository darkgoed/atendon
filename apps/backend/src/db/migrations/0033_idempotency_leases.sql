ALTER TABLE outbound_message_requests
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE ai_tool_call_journal
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ NOT NULL DEFAULT now();
