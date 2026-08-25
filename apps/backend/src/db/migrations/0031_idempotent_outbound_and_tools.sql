DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_id_tenant_unique'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_id_tenant_unique UNIQUE (id, tenant_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS outbound_message_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  request_hash CHAR(64) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  external_message_id TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_outbound_message_requests_pending
  ON outbound_message_requests(created_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS ai_tool_call_journal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  inbound_external_id TEXT NOT NULL,
  call_ordinal INTEGER NOT NULL CHECK (call_ordinal >= 0),
  provider_call_id TEXT,
  tool_name TEXT NOT NULL,
  arguments_hash CHAR(64) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  result_text TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (tenant_id, inbound_external_id, call_ordinal),
  FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_tool_call_journal_pending
  ON ai_tool_call_journal(created_at) WHERE status = 'pending';
