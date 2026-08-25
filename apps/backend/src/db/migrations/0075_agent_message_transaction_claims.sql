DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_id_conversation_unique'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_id_conversation_unique UNIQUE (id, conversation_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_tool_journal_id_tenant_conversation_unique'
  ) THEN
    ALTER TABLE ai_tool_call_journal
      ADD CONSTRAINT ai_tool_journal_id_tenant_conversation_unique
      UNIQUE (id, tenant_id, conversation_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS agent_message_transaction_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  message_id UUID NOT NULL,
  journal_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'schedule_meeting', 'schedule_visit',
    'reschedule_meeting', 'reschedule_visit',
    'cancel_meeting', 'cancel_visit',
    'qualify_lead'
  )),
  claim_type TEXT NOT NULL CHECK (claim_type IN (
    'transaction_status',
    'start_at', 'end_at', 'duration_minutes', 'timezone',
    'unit_id', 'unit_name', 'appointment_status',
    'meeting_provisioning_status', 'meeting_url',
    'qualification_registered'
  )),
  normalized_value TEXT NOT NULL CHECK (
    char_length(normalized_value) BETWEEN 1 AND 4096
  ),
  value_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_message_claim_conversation_tenant_fkey
    FOREIGN KEY (conversation_id, tenant_id)
    REFERENCES conversations(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT agent_message_claim_message_conversation_fkey
    FOREIGN KEY (message_id, conversation_id)
    REFERENCES messages(id, conversation_id) ON DELETE CASCADE,
  CONSTRAINT agent_message_claim_journal_tenant_conversation_fkey
    FOREIGN KEY (journal_id, tenant_id, conversation_id)
    REFERENCES ai_tool_call_journal(id, tenant_id, conversation_id) ON DELETE CASCADE,
  CONSTRAINT agent_message_claim_unique
    UNIQUE (message_id, journal_id, claim_type)
);

CREATE INDEX IF NOT EXISTS idx_agent_message_transaction_claims_conversation
  ON agent_message_transaction_claims(tenant_id, conversation_id, message_id);

CREATE INDEX IF NOT EXISTS idx_agent_message_transaction_claims_journal
  ON agent_message_transaction_claims(tenant_id, journal_id);

CREATE OR REPLACE FUNCTION reject_agent_message_transaction_claim_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'agent message transaction claims are immutable'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS agent_message_transaction_claims_immutable
  ON agent_message_transaction_claims;

CREATE TRIGGER agent_message_transaction_claims_immutable
BEFORE UPDATE ON agent_message_transaction_claims
FOR EACH ROW
EXECUTE FUNCTION reject_agent_message_transaction_claim_update();
