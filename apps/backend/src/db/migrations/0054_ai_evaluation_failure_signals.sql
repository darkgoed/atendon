CREATE TABLE ai_evaluation_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  agent_config_version_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ai_error')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conversation_id,agent_config_version_id,kind),
  FOREIGN KEY (conversation_id,tenant_id)
    REFERENCES conversations(id,tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (agent_config_version_id,tenant_id)
    REFERENCES agent_config_versions(id,tenant_id)
);

CREATE INDEX idx_ai_evaluation_signals_tenant_created
  ON ai_evaluation_signals(tenant_id,created_at DESC);
