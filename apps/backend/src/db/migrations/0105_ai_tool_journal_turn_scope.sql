ALTER TABLE ai_tool_call_journal
  ADD COLUMN IF NOT EXISTS ai_turn_id UUID;

UPDATE ai_tool_call_journal
SET ai_turn_id = gen_random_uuid()
WHERE ai_turn_id IS NULL;

ALTER TABLE ai_tool_call_journal
  ALTER COLUMN ai_turn_id SET NOT NULL;

ALTER TABLE ai_tool_call_journal
  DROP CONSTRAINT IF EXISTS ai_tool_call_journal_tenant_id_inbound_external_id_call_ordinal_key;

ALTER TABLE ai_tool_call_journal
  DROP CONSTRAINT IF EXISTS ai_tool_call_journal_turn_ordinal_unique;

ALTER TABLE ai_tool_call_journal
  ADD CONSTRAINT ai_tool_call_journal_turn_ordinal_unique
  UNIQUE (tenant_id, inbound_external_id, ai_turn_id, call_ordinal);
